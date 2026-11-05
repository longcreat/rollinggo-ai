/**
 * 生成任务路由（`/api/generations`）。
 *
 * 任务模型：POST 只做闸门校验 + 建 job + 后台跑，立即 202 返回 jobId；
 * 前端拿 jobId 开 SSE 追进度。配额在**任务结束时**扣（取消/失败不计）。
 *
 * 闸门顺序（改之前想清楚）：会话/行程归属 → LLM 配置 → 配额 → 并发；
 * 并发只能一个（`getRunningJobId`），否则同一用户的两份草稿会抢同一份 Brief。
 *
 * SSE 重放：每条事件带递增 id，客户端断线重连时用 `Last-Event-ID`（或 query 参数）回补；
 * 已终止的任务也能回放终态，避免前端卡在「进行中」。
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { GenerateFormSchema, type GenerationEvent } from '@tripweaver/shared';
import { requireAuth } from '../auth/guard';
import { resolveLlmConfig } from '../services/settingsService';
import { getConversation } from '../services/conversationService';
import { hasQuota, usageView } from '../services/quotaService';
import { getTrip } from '../services/tripService';
import { hasSiteLlm } from '../env';
import { createJob, getJob, getRunningJobId, jobView, subscribe, type StoredEvent } from '../generation/jobManager';
import { runGeneration } from '../generation/orchestrator';
import { getGenerationResult } from '../services/notificationService';

const HEARTBEAT_MS = 25_000;

// 生成入参 = 既有表单 + 对话来源标注。标注字段全部可选：表单入口不传，行为与以前一致。
// kind 用显式字面量 Union（不用 map 构造）：map 会让 TS 把联合坍缩成单个字面量。
const GenerateBodySchema = Type.Intersect([
  GenerateFormSchema,
  Type.Object({
    conversationId: Type.Optional(Type.String({ maxLength: 64 })),
    kind: Type.Optional(Type.Union([Type.Literal('generation'), Type.Literal('revision')])),
    targetTripId: Type.Optional(Type.String({ maxLength: 64 })),   // kind=revision 时的修订目标
  }),
]);

function isTerminalEvent(event: GenerationEvent): boolean {
  return event.type === 'job_done' || event.type === 'job_error' || event.type === 'job_cancelled';
}

export const generationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.post('/', { schema: { body: GenerateBodySchema } }, async (request, reply) => {
    const userId = request.user!.id;

    // 会话归属校验：不校验就能把生成挂到别人的会话上（userId 谓词是唯一防线）
    const conversationId = request.body.conversationId;
    if (conversationId && !(await getConversation(userId, conversationId))) {
      return reply.code(404).send({ error: '会话不存在' });
    }

    // 修订（PR5）：目标行程必须属于当前用户 —— 不校验就能基于别人的行程重跑
    const kind = request.body.kind ?? 'generation';
    const targetTripId = request.body.targetTripId;
    if (kind === 'revision') {
      if (!targetTripId) {
        return reply.code(400).send({ error: '修订需要指定目标行程', code: 'revision_target_missing' });
      }
      if (!(await getTrip(userId, targetTripId))) {
        return reply.code(404).send({ error: '行程不存在' });
      }
    }

    const cfg = await resolveLlmConfig(userId);
    if (!cfg) {
      // PRD F1 异常文案分流：前端按 hasSiteKey 展示「联系站长」或「去高级设置填 Key」
      return reply.code(400).send({ error: '当前没有可用的 AI 配置', code: 'no_llm', hasSiteKey: hasSiteLlm() });
    }
    if (!(await hasQuota(userId))) {
      const usage = await usageView(userId);
      return reply.code(429).send({ error: '今日生成次数已用完', code: 'quota_exhausted', resetAt: usage.resetAt });
    }
    const runningId = getRunningJobId(userId);
    if (runningId) {
      return reply.code(409).send({ error: '已有生成任务进行中', code: 'job_running', jobId: runningId });
    }

    const job = createJob(userId, {
      ...(conversationId ? { conversationId } : {}),
      kind,
      ...(kind === 'revision' && targetTripId ? { targetTripId } : {}),
    });
    runGeneration(job, request.body, cfg, app.log).catch((err) => app.log.error(err, 'runGeneration 未捕获异常'));
    return reply.code(202).send({ jobId: job.id });
  });

  // 快照：刷新恢复时先查状态，再决定是否重连 SSE
  app.get('/current', async (request) => {
    const id = getRunningJobId(request.user!.id);
    const job = id ? getJob(id, request.user!.id) : null;
    return job ? jobView(job) : null;
  });

  app.get('/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = getJob(jobId, request.user!.id);
    if (!job) {
      const result = await getGenerationResult(request.user!.id, jobId);
      return result ?? reply.code(404).send({ error: '任务不存在或已过期' });
    }
    return jobView(job);
  });

  // SSE 进度流：先 hijack 再写头，否则 Fastify 会尝试序列化并加上信封
  app.get('/:jobId/events', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = getJob(jobId, request.user!.id);
    if (!job) return reply.code(404).send({ error: '任务不存在或已过期' });

    const lastHeader = request.headers['last-event-id'];
    const lastQuery = (request.query as { lastEventId?: string }).lastEventId;
    const afterId = Number.parseInt((Array.isArray(lastHeader) ? lastHeader[0] : lastHeader) ?? lastQuery ?? '0', 10) || 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',           // nginx 类反代禁缓冲；Caddy 用 flush_interval -1
    });
    res.write(': connected\n\n');

    let closed = false;
    let unsubscribe = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    };

    const send = (stored: StoredEvent) => {
      if (closed) return;
      try {
        res.write(`id: ${stored.id}\ndata: ${JSON.stringify(stored.event)}\n\n`);
      } catch {
        finish();                            // 连接已死：立即退订，绝不影响生成流水线
        return;
      }
      if (isTerminalEvent(stored.event)) finish();   // 终态事件送达后干净收尾
    };

    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(': hb\n\n');
      } catch {
        finish();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    res.on('close', finish);
    unsubscribe = subscribe(job, afterId, send);
    // 同步重放可能已经结束；包括客户端持有终态 ID、没有新事件可回放的情况。
    if (closed) unsubscribe();
    else if (job.status !== 'running') finish();
  });

  app.post('/:jobId/cancel', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = getJob(jobId, request.user!.id);
    if (!job) return reply.code(404).send({ error: '任务不存在或已过期' });
    if (job.status !== 'running') return { ok: false, status: job.status };
    job.cancelReason = 'user';             // 用户主动取消：事件携带 reason，前端区分展示
    job.abort.abort();                     // orchestrator 捕获后落 cancelled（不计配额）
    return reply.code(202).send({ ok: true });
  });
};
