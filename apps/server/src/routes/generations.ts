/**
 * 生成任务路由（`/api/generations`）。
 *
 * 任务模型：POST 只做闸门校验 + 建 job + 后台跑，立即 202 返回 jobId；
 * 前端拿 jobId 开 SSE 追进度。配额在**任务结束时**扣（取消/失败不计）。
 *
 * 闸门顺序（改之前想清楚）：会话/行程归属 → LLM 配置 → 并发；
 * 并发只能一个（`getRunningJobId`），否则同一用户的两份草稿会抢同一份 Brief。
 * 生成配额闸门已随「测试环境不限量」（2026-11-07）移除；生产恢复点见 quotaService.hasQuota。
 *
 * SSE 重放：每条事件带递增 id，客户端断线重连时用 `Last-Event-ID`（或 query 参数）回补；
 * 已终止的任务也能回放终态，避免前端卡在「进行中」。
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { GENERATION_TIMEOUT_MINUTES, GenerateFormSchema } from '@tripweaver/shared';
import { requireAuth } from '../auth/guard';
import { resolveLlmConfig } from '../services/settingsService';
import { getConversation } from '../services/conversationService';
import { getTrip } from '../services/tripService';
import { hasSiteLlm } from '../env';
import { createJob, failJob, getJob, getRunningJobId, jobView, subscribeProjection } from '../generation/jobManager';
import type { GenerationTaskInput } from '../generation/generationTask';
import { startGenerationTask } from '../generation/startGeneration';
import { agentStoragePath, ensureAgentStorageDir } from '../generation/agentStorage';
import { getAgentRuntime } from '../chat/agent/runtime';
import { getGenerationResult } from '../services/notificationService';
import {
  beginGenerationTask,
  finalizeGenerationTask,
  getGenerationTask,
  getLatestGenerationTask,
  markGenerationTaskFailed,
  type GenerationTaskView,
} from '../generation/taskStore';

const HEARTBEAT_MS = 25_000;
/** running 行超过单任务上限仍没有终态：视作中断，让任务卡给出重试出口而不是永远转圈。 */
const STALE_TASK_MS = GENERATION_TIMEOUT_MINUTES * 60_000;

/** 持久任务 → 接口视图（与内存 jobView 同形；终态额外带摘要/告警）。 */
function taskView(task: GenerationTaskView) {
  return {
    jobId: task.jobId,
    status: task.status,
    tripId: task.tripId,
    createdAt: task.createdAt,
    ...(task.destination ? { destination: task.destination } : {}),
    ...(task.days !== undefined ? { days: task.days } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.reviewNotes?.length ? { reviewNotes: task.reviewNotes } : {}),
    ...(task.warnings?.length ? { warnings: task.warnings } : {}),
    ...(task.dataSources?.length ? { dataSources: task.dataSources } : {}),
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
    ...(task.error ? { message: task.error } : {}),
  };
}

/** 内存任务缺失时读持久行；running 且已超时的行标记为中断，避免永久 running。 */
async function persistedJob(userId: string, jobId: string) {
  const task = await getGenerationTask(userId, jobId);
  if (!task) return null;
  if (task.status === 'running' && Date.now() - task.createdAt > STALE_TASK_MS) {
    const message = '任务已中断，请重新生成';
    await markGenerationTaskFailed(userId, jobId, message).catch(() => {});
    return taskView({ ...task, status: 'error', error: message, finishedAt: Date.now() });
  }
  return taskView(task);
}

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

/**
 * 懒恢复：内存里没有该任务时（进程重启），打开用户存储并 resume —— durable task 会按输入
 * 重建内存 Job 并重跑流水线，job_start 一到投影即可读。等待有界，找不到仍返回 null。
 */
async function resolveJob(jobId: string, userId: string): Promise<ReturnType<typeof getJob>> {
  const existing = getJob(jobId, userId);
  if (existing) return existing;
  try {
    await ensureAgentStorageDir();
    const runtime = await getAgentRuntime(agentStoragePath(userId));
    runtime.harness.resume();
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const job = getJob(jobId, userId);
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return getJob(jobId, userId);
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
    // 生成额度不限量（测试环境）：原 429 闸门已移除，恢复点见 quotaService.hasQuota 注释。
    const runningId = getRunningJobId(userId);
    if (runningId) {
      return reply.code(409).send({ error: '已有生成任务进行中', code: 'job_running', jobId: runningId });
    }

    const job = createJob(userId, {
      ...(conversationId ? { conversationId } : {}),
      kind,
      ...(kind === 'revision' && targetTripId ? { targetTripId } : {}),
    });
    // 任务输入携带重建上下文所需的非敏感数据：进程重启后 resume 也能重建 Job 并续跑。
    const taskInput: GenerationTaskInput = { jobId: job.id, userId, form: request.body, provenance: job.provenance };
    await beginGenerationTask(job, request.body);
    try {
      await startGenerationTask(taskInput);
    } catch (error) {
      // durable 是唯一执行路径：任务创建失败即失败该任务，不回退旧 runner。
      app.log.error(error, 'generation task 创建失败');
      const message = '生成运行时不可用，请稍后重试';
      failJob(job, message);
      await finalizeGenerationTask(job, 'error', null, { error: message }).catch(() => {});
    }
    return reply.code(202).send({ jobId: job.id });
  });

  // 快照：刷新恢复时先查状态，再决定是否重连 SSE
  app.get('/current', async (request) => {
    const userId = request.user!.id;
    const id = getRunningJobId(userId);
    const job = id ? getJob(id, userId) : null;
    if (job) return jobView(job);
    // 进程重启后内存任务为空：持久行里仍在跑且未超时的任务就是当前任务。
    const latest = await getLatestGenerationTask(userId);
    if (latest && latest.status === 'running' && Date.now() - latest.createdAt <= STALE_TASK_MS) return taskView(latest);
    return null;
  });

  app.get('/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const userId = request.user!.id;
    const job = await resolveJob(jobId, userId);
    if (job) return jobView(job);
    const persisted = await persistedJob(userId, jobId);
    if (persisted) return persisted;
    const result = await getGenerationResult(userId, jobId);
    return result ?? reply.code(404).send({ error: '任务不存在或已过期' });
  });

  /**
   * 统一投影：一次拿到「真相」（快照或补发的增量帧）。
   * 客户端三条铁律的入口 —— 断档时携 fromSeq 重订阅，由服务端裁决补增量还是重发快照。
   */
  app.get('/:jobId/projection', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await resolveJob(jobId, request.user!.id);
    if (!job) return reply.code(404).send({ error: '任务不存在或已过期' });
    const fromSeq = Number.parseInt((request.query as { fromSeq?: string }).fromSeq ?? '0', 10) || 0;
    const resumed = job.projection.channel.resume(fromSeq);
    return resumed.kind === 'snapshot'
      ? { kind: 'snapshot' as const, snapshot: resumed.snapshot }
      : { kind: 'delta' as const, frames: resumed.frames };
  });

  // 投影 SSE：先发 initial（快照或补帧），再推实时帧。
  app.get('/:jobId/projection/events', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await resolveJob(jobId, request.user!.id);
    if (!job) return reply.code(404).send({ error: '任务不存在或已过期' });

    const fromSeq = Number.parseInt((request.query as { fromSeq?: string }).fromSeq ?? '0', 10) || 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
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
    const write = (payload: unknown) => {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        finish();
      }
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
    const { initial, unsubscribe: off } = subscribeProjection(job, fromSeq, (frame) => write({ kind: 'delta', frame }));
    unsubscribe = off;
    if (initial.kind === 'snapshot') write({ kind: 'snapshot', snapshot: initial.snapshot });
    else for (const frame of initial.frames) write({ kind: 'delta', frame });
    if (job.status !== 'running') finish();
  });

  app.post('/:jobId/cancel', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    // 重启后任务在内存里不存在；resolveJob 会 resume 成可取消的内存任务。
    const job = await resolveJob(jobId, request.user!.id);
    if (!job) return reply.code(404).send({ error: '任务不存在或已过期' });
    if (job.status !== 'running') return { ok: false, status: job.status };
    job.cancelReason = 'user';             // 用户主动取消：事件携带 reason，前端区分展示
    job.abort.abort();                     // orchestrator 捕获后落 cancelled（不计配额）
    return reply.code(202).send({ ok: true });
  });
};
