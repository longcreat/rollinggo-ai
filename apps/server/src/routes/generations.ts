/**
 * 生成任务路由（`/api/generations`）。
 *
 * 任务模型：POST 只做闸门校验 + 建任务行 + 后台跑，立即 202 返回 jobId；
 * 前端拿 jobId 开 SSE 追进度。配额在**任务结束时**扣（取消/失败不计）。
 *
 * 闸门顺序（改之前想清楚）：会话/行程归属 → LLM 配置 → 并发；
 * 并发只能一个（持久层 running 行），否则同一用户的两份草稿会抢同一份 Brief。
 * 生成配额闸门已随「测试环境不限量」（2026-11-07）移除；生产恢复点见 quotaService.hasQuota。
 *
 * 直播层只存在于进程内，任务真相在 `generations` 行：重启后按 durable task 重新 resume；
 * 终态行过期后仍能合成快照，避免前端卡在「进行中」。
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, TaskId } from '@earendil-works/pi-durable';
import {
  GENERATION_TIMEOUT_MINUTES,
  GenerateFormSchema,
  getPlannerStageDisplay,
  PLANNER_STAGE_KEYS,
  type PlannerStageKey,
  uid,
} from '@tripweaver/shared';
import { requireAuth } from '../auth/guard';
import { resolveLlmConfig } from '../services/settingsService';
import { getConversation } from '../services/conversationService';
import { getTrip } from '../services/tripService';
import { hasSiteLlm } from '../env';
import {
  cancelLiveRun,
  createLiveRun,
  emitLive,
  getLiveRun,
  projectionFromTask,
  subscribeLiveProjection,
  type LiveRun,
} from '../generation/liveRun';
import type { GenerationTaskInput } from '../generation/generationTask';
import { startGenerationTask } from '../generation/startGeneration';
import { agentStoragePath, ensureAgentStorageDir } from '../generation/agentStorage';
import { getAgentRuntime } from '../chat/agent/runtime';
import { getGenerationResult } from '../services/notificationService';
import {
  beginGenerationTask,
  finalizeGenerationTask,
  findActiveRunningTask,
  getGenerationTask,
  markGenerationTaskFailed,
  type GenerationTaskView,
} from '../generation/taskStore';
import type { GenerationAgentKey, GenerationTaskRef } from '../generation/provenance';
import { normalizeAgentTranscript } from '../generation/agentTranscript';

const AGENT_STAGES: Record<PlannerStageKey, readonly string[]> = {
  exploration: ['exploration', 'research'],
  profiling: ['profiling'],
  climate: ['climate'],
  routing: ['routing', 'plan'],
  inspection: ['inspection', 'review', 'writer', 'advice'],
};

/** 读取一个阶段的工具步骤；只读 durable conversation。 */
async function readAgentSteps(
  runtime: Awaited<ReturnType<typeof getAgentRuntime>>,
  task: GenerationTaskView,
  stage: PlannerStageKey,
) {
  const steps = [];
  const keys = AGENT_STAGES[stage] ?? [];
  for (const key of keys) {
    const conversationId = task.agentConversations?.[key as unknown as GenerationAgentKey];
    if (!conversationId) continue;
    const conversation = await runtime.harness.conversation(
      conversationId as unknown as ConversationId,
      BACKGROUND_CONTEXT,
    );
    const page = await conversation?.entries({ order: 'ascending' }, 400, undefined, BACKGROUND_CONTEXT);
    steps.push(...normalizeAgentTranscript(page?.items ?? [], task.status !== 'running'));
  }
  return steps;
}

const HEARTBEAT_MS = 25_000;
/** running 行超过单任务上限仍没有终态：视作中断，让任务卡给出重试出口而不是永远转圈。 */
const STALE_TASK_MS = GENERATION_TIMEOUT_MINUTES * 60_000;

/** 持久任务 → 接口视图（运行态与终态同形；终态额外带摘要/告警）。 */
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

/** 持久行是任务真相；running 且已超时的行标记为中断，避免永久 running。 */
async function persistedTask(userId: string, jobId: string): Promise<GenerationTaskView | null> {
  const task = await getGenerationTask(userId, jobId);
  if (!task) return null;
  if (task.status === 'running' && Date.now() - task.createdAt > STALE_TASK_MS) {
    const message = '任务已中断，请重新生成';
    await markGenerationTaskFailed(userId, jobId, message).catch(() => {});
    return { ...task, status: 'error', error: message, finishedAt: Date.now() };
  }
  return task;
}

async function persistedJob(userId: string, jobId: string) {
  const task = await persistedTask(userId, jobId);
  return task ? taskView(task) : null;
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
 * 懒恢复：实时层没有该任务时（进程重启），打开用户存储并 resume —— durable task 会按输入
 * 重建直播层并重跑流水线，job_start 一到投影即可读。等待有界，找不到仍返回 null。
 */
async function resolveLiveRun(jobId: string, userId: string): Promise<LiveRun | null> {
  const existing = getLiveRun(jobId, userId);
  if (existing) return existing;
  const task = await getGenerationTask(userId, jobId);
  if (!task || task.status !== 'running' || Date.now() - task.createdAt > STALE_TASK_MS) return null;
  try {
    await ensureAgentStorageDir();
    const runtime = await getAgentRuntime(agentStoragePath(userId));
    runtime.harness.resume();
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = getLiveRun(jobId, userId);
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return getLiveRun(jobId, userId);
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
    const running = await findActiveRunningTask(userId, STALE_TASK_MS);
    if (running) {
      return reply.code(409).send({ error: '已有生成任务进行中', code: 'job_running', jobId: running.jobId });
    }

    const ref: GenerationTaskRef = {
      jobId: uid(),
      userId,
      createdAt: Date.now(),
      provenance: {
        ...(conversationId ? { conversationId } : {}),
        kind,
        ...(kind === 'revision' && targetTripId ? { targetTripId } : {}),
      },
    };
    // 任务输入携带重建上下文所需的非敏感数据：进程重启后 resume 也能重建直播层并续跑。
    const taskInput: GenerationTaskInput = {
      jobId: ref.jobId,
      userId,
      form: request.body,
      provenance: ref.provenance,
      createdAt: ref.createdAt,
    };
    await beginGenerationTask(ref, request.body);
    // 先建实时层，POST 返回后立刻订阅也能拿到初始快照。
    const run = createLiveRun(ref);
    try {
      await startGenerationTask(taskInput);
    } catch (error) {
      // durable 是唯一执行路径：任务创建失败即失败该任务，不回退旧 runner。
      app.log.error(error, 'generation task 创建失败');
      const message = '生成运行时不可用，请稍后重试';
      emitLive(run, { type: 'job_error', message });
      await finalizeGenerationTask(ref, 'error', null, {
        destination: request.body.destination,
        days: request.body.days,
        error: message,
      }).catch(() => {});
    }
    return reply.code(202).send({ jobId: ref.jobId });
  });

  // 快照：刷新恢复时先查状态，再决定是否重连 SSE
  app.get('/current', async (request) => {
    const userId = request.user!.id;
    // 持久行是「当前任务」的唯一依据：进程重启后也不依赖内存。
    const current = await findActiveRunningTask(userId, STALE_TASK_MS);
    return current ? taskView(current) : null;
  });

  app.get('/:jobId', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const userId = request.user!.id;
    const persisted = await persistedJob(userId, jobId);
    if (persisted) return persisted;
    const result = await getGenerationResult(userId, jobId);
    return result ?? reply.code(404).send({ error: '任务不存在或已过期' });
  });

  /**
   * 子 Agent 页面：返回该阶段 durable 会话的工具流程。
   * 只读、懒加载；review 聚合 writer + advice 两个子 Agent。
   */
  app.get('/:jobId/agents/:stage', async (request, reply) => {
    const { jobId, stage } = request.params as { jobId: string; stage: string };
    const userId = request.user!.id;
    if (!PLANNER_STAGE_KEYS.includes(stage as PlannerStageKey)) {
      return reply.code(404).send({ error: '子 Agent 不存在' });
    }
    const task = await getGenerationTask(userId, jobId);
    if (!task) return reply.code(404).send({ error: '任务不存在或已过期' });
    try {
      await ensureAgentStorageDir();
      const runtime = await getAgentRuntime(agentStoragePath(userId));
      const steps = await readAgentSteps(runtime, task, stage as PlannerStageKey);
      return { stage, steps, running: task.status === 'running' };
    } catch (error) {
      request.log.error(error, 'generation agent transcript read failed');
      return reply.code(503).send({ error: '子 Agent 记录暂时不可用' });
    }
  });

  /**
   * 主 Agent 对话里的子 Agent 节点列表：严格按照五阶规划流水线展示。
   * 状态/耗时用于时间线展示，详情仍由 /agents/:stage 懒加载。
   */
  app.get('/:jobId/agents', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const userId = request.user!.id;
    const task = await getGenerationTask(userId, jobId);
    if (!task) return reply.code(404).send({ error: '任务不存在或已过期' });
    const stages = PLANNER_STAGE_KEYS;
    const currentStage: PlannerStageKey = task.status !== 'running'
      ? 'inspection'
      : (task.agentConversations?.['inspection'] || task.agentConversations?.['writer'] || task.agentConversations?.['advice'])
        ? 'inspection'
        : (task.agentConversations?.['routing'] || task.agentConversations?.['plan'])
          ? 'routing'
          : task.agentConversations?.['climate']
            ? 'climate'
            : task.agentConversations?.['profiling']
              ? 'profiling'
              : 'exploration';
    try {
      await ensureAgentStorageDir();
      const runtime = await getAgentRuntime(agentStoragePath(userId));
      const agents = [];
      for (const stage of stages) {
        const hasConv = (AGENT_STAGES[stage] ?? []).some((key) => task.agentConversations?.[key as unknown as GenerationAgentKey]);
        const steps = hasConv ? await readAgentSteps(runtime, task, stage) : [];
        const done = steps.filter((step) => step.status === 'done').length;
        const stageIndex = stages.indexOf(stage);
        const currentIndex = stages.indexOf(currentStage);
        const stageStatus = task.status === 'done'
          ? 'done'
          : task.status === 'cancelled' || task.status === 'error'
            ? (stageIndex <= currentIndex ? 'error' : 'pending')
            : stageIndex < currentIndex
              ? 'done'
              : stageIndex === currentIndex
                ? 'running'
                : 'pending';
        const meta = getPlannerStageDisplay(stage);
        agents.push({
          stage,
          label: meta.clientTitle,
          subtitle: meta.clientSubtitle,
          highlight: meta.runningHighlight,
          status: stageStatus,
          total: steps.length,
          completed: done,
          durationMs: steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0),
        });
      }
      return { agents };
    } catch (error) {
      request.log.error(error, 'generation agent list read failed');
      return reply.code(503).send({ error: '子 Agent 记录暂时不可用' });
    }
  });

  /**
   * 统一投影：一次拿到「真相」（快照或补发的增量帧）。
   * 客户端三条铁律的入口 —— 断档时携 fromSeq 重订阅，由服务端裁决补增量还是重发快照。
   */
  app.get('/:jobId/projection', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const userId = request.user!.id;
    const fromSeq = Number.parseInt((request.query as { fromSeq?: string }).fromSeq ?? '0', 10) || 0;
    const run = await resolveLiveRun(jobId, userId);
    if (run) {
      const resumed = run.projection.channel.resume(fromSeq);
      return resumed.kind === 'snapshot'
        ? { kind: 'snapshot' as const, snapshot: resumed.snapshot }
        : { kind: 'delta' as const, frames: resumed.frames };
    }
    // 实时层已过期（重启后已结束 / 超过 TTL）：用持久任务行合成终态快照。
    const task = await persistedTask(userId, jobId);
    if (!task) return reply.code(404).send({ error: '任务不存在或已过期' });
    // running 但没有实时层：durable 恢复还没就绪，让客户端退避重试，而不是反复收到「假终态」。
    if (task.status === 'running') return reply.code(503).send({ error: '任务正在恢复，请稍后重试' });
    return { kind: 'snapshot' as const, snapshot: projectionFromTask(task) };
  });

  // 投影 SSE：先发 initial（快照或补帧），再推实时帧；实时层缺失时发终态快照即结束。
  app.get('/:jobId/projection/events', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const userId = request.user!.id;
    const fromSeq = Number.parseInt((request.query as { fromSeq?: string }).fromSeq ?? '0', 10) || 0;
    const run = await resolveLiveRun(jobId, userId);
    const task = run ? null : await persistedTask(userId, jobId);
    if (!run && !task) return reply.code(404).send({ error: '任务不存在或已过期' });
    // running 但没有实时层：SSE 快速重连会放大恢复延迟，交给客户端退避。
    if (!run && task?.status === 'running') return reply.code(503).send({ error: '任务正在恢复，请稍后重试' });

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
    if (!run) {
      write({ kind: 'snapshot', snapshot: projectionFromTask(task!) });
      finish();
      return;
    }
    const { initial, unsubscribe: off } = subscribeLiveProjection(run, fromSeq, (frame) => write({ kind: 'delta', frame }));
    unsubscribe = off;
    if (initial.kind === 'snapshot') write({ kind: 'snapshot', snapshot: initial.snapshot });
    else for (const frame of initial.frames) write({ kind: 'delta', frame });
    if (run.status !== 'running') finish();
  });

  app.post('/:jobId/cancel', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const userId = request.user!.id;
    // 重启后实时层不存在：resolveLiveRun 会 resume 成可取消的直播任务。
    const run = await resolveLiveRun(jobId, userId);
    if (run) {
      const cancelled = cancelLiveRun(jobId, userId);   // orchestrator 捕获后落 cancelled（不计配额）
      return cancelled ? reply.code(202).send({ ok: true }) : { ok: false, status: run.status };
    }
    const task = await persistedTask(userId, jobId);
    if (!task) return reply.code(404).send({ error: '任务不存在或已过期' });
    if (task.status !== 'running') return { ok: false, status: task.status };
    if (!task.durableTaskId) {
      const message = '任务已中断，请重新生成';
      await markGenerationTaskFailed(userId, jobId, message).catch(() => {});
      return { ok: false, status: 'error', message };
    }
    try {
      await ensureAgentStorageDir();
      const runtime = await getAgentRuntime(agentStoragePath(userId));
      await runtime.harness.abortTask(task.durableTaskId as unknown as TaskId, BACKGROUND_CONTEXT);
      return reply.code(202).send({ ok: true });
    } catch (error) {
      request.log.error(error, 'generation abort failed');
      return reply.code(503).send({ error: '取消失败，请稍后重试' });
    }
  });
};
