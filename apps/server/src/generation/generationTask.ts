// 生成任务的 durable 骨架（阶段二 #7）。
//
// 任务输入携带重建运行上下文所需的全部**非敏感**数据（jobId / userId / form / provenance）；
// 进程重启后 duable task 被 resume 时，按输入重建实时直播层并从用户设置重新解析 LLM 配置，
// 然后重跑整条流水线（落库前无副作用，重跑安全）。BYOK 密钥不进入任务输入。
//
// 下一步：把 runGeneration 拆成 research/plan/calibrate/write/gate/commit 多 phase，在每个边界
// checkpoint，崩溃后从上一个阶段续跑（当前是整条流水线一个 phase，重跑代价是重新调研）。
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import type { DataSourceKind, GenerateForm, GenerationWarning } from '@tripweaver/shared';
import { createLiveRun, emitLive, getLiveRun, type LiveRun } from './liveRun';
import { runGeneration, type GenerationRunOptions } from './orchestrator';
import { finalizeGenerationTask, setGenerationAgentConversation } from './taskStore';
import { resolveLlmConfig } from '../services/settingsService';
import type { ResearchCheckpoint } from './checkpoint';
import type { GenerationProvenance, GenerationTaskRef } from './provenance';

export interface GenerationTaskInput {
  jobId: string;
  userId: string;
  form: GenerateForm;
  provenance: GenerationProvenance;
  /** 与 beginGenerationTask 同一时间基准；缺省时取当前时间（历史任务输入兼容）。 */
  createdAt?: number;
}

function refOf(input: GenerationTaskInput): GenerationTaskRef {
  return {
    jobId: input.jobId,
    userId: input.userId,
    createdAt: input.createdAt ?? Date.now(),
    provenance: input.provenance,
  };
}

function runOf(input: GenerationTaskInput): LiveRun {
  return getLiveRun(input.jobId, input.userId) ?? createLiveRun(refOf(input));
}

export interface GenerationTaskState {
  phase: 'run';
  /** 调研完成后的 checkpoint：重启后复用，跳过最耗时的 LLM 调研。 */
  research?: ResearchCheckpoint;
}

export interface GenerationRunResult {
  status: 'done' | 'error' | 'cancelled';
  tripId: string | null;
  /** 任务结果的持久摘要：重启后主 Agent / 任务卡仍能解释「做了什么、有什么要注意」。 */
  summary?: string;
  reviewNotes?: string[];
  dataSources?: DataSourceKind[];
  warnings?: GenerationWarning[];
  message?: string;
}

export interface GenerationTaskResult {
  tripId: string | null;
  summary?: string;
  reviewNotes: string[];
  dataSources: DataSourceKind[];
  warnings: GenerationWarning[];
}

/** 启动前失败：直播层与持久任务行都落同一个终态，任务卡与页面不必猜。 */
async function failBeforeRun(input: GenerationTaskInput, message: string): Promise<GenerationRunResult> {
  const ref = refOf(input);
  const run = runOf(input);
  emitLive(run, { type: 'job_error', message });
  await finalizeGenerationTask(ref, 'error', null, {
    destination: input.form.destination,
    days: input.form.days,
    error: message,
  }).catch(() => {});
  return { status: 'error', tripId: null, message };
}

/**
 * 重建运行上下文并跑完整条流水线。
 * `runGeneration` 自己负责终态（投影事件 + 任务行）与取消传播。
 */
async function runFromInput(
  input: GenerationTaskInput,
  options?: Omit<GenerationRunOptions, 'agent'>,
  taskId?: TaskId,
): Promise<GenerationRunResult> {
  const run = runOf(input);
  const cfg = await resolveLlmConfig(input.userId);
  if (!cfg) return failBeforeRun(input, '当前没有可用的 AI 配置');
  // durable 宿主是唯一路径：创建失败即失败任务，不回退旧 runner。
  let agent: GenerationRunOptions['agent'];
  try {
    const [{ getAgentRuntime }, { buildAgentModels }, { agentStoragePath }, { BACKGROUND_CONTEXT }] = await Promise.all([
      import('../chat/agent/runtime'),
      import('../chat/agent/models'),
      import('./agentStorage'),
      import('@earendil-works/chord/context'),
    ]);
    const runtime = await getAgentRuntime(agentStoragePath(input.userId));
    runtime.holder.current = await buildAgentModels(cfg);
    agent = {
      harness: runtime.harness,
      registry: runtime.registry,
      context: BACKGROUND_CONTEXT,
      ...(taskId ? { taskId } : {}),
    };
  } catch {
    return failBeforeRun(input, '生成运行时不可用，请稍后重试');
  }
  const summary = await runGeneration(run, input.form, cfg, undefined, { ...options, agent });
  const status = summary.status === 'running' ? 'error' : summary.status;
  return {
    status,
    tripId: summary.tripId,
    ...(summary.summary ? { summary: summary.summary } : {}),
    reviewNotes: summary.reviewNotes,
    dataSources: summary.dataSources,
    warnings: summary.warnings,
  };
}

/** 运行结果 → durable 任务终态（纯函数，便于单测）。 */
export function taskOutcome(result: GenerationRunResult):
  | { status: 'terminal'; outcome: { status: 'completed'; result: GenerationTaskResult } }
  | { status: 'terminal'; outcome: { status: 'aborted' } }
  | { status: 'terminal'; outcome: { status: 'failed'; error: { message: string } } } {
  if (result.status === 'done') {
    return {
      status: 'terminal',
      outcome: {
        status: 'completed',
        result: {
          tripId: result.tripId,
          ...(result.summary ? { summary: result.summary } : {}),
          reviewNotes: result.reviewNotes ?? [],
          dataSources: result.dataSources ?? [],
          warnings: result.warnings ?? [],
        },
      },
    };
  }
  if (result.status === 'cancelled') return { status: 'terminal', outcome: { status: 'aborted' } };
  return { status: 'terminal', outcome: { status: 'failed', error: { message: result.message ?? '生成失败' } } };
}

export const GenerationTask = defineTask<GenerationTaskInput, GenerationTaskState, GenerationTaskResult>({
  name: 'tripweaver.generation',
  version: 1,
  initial: () => ({ phase: 'run' }),
  phases: {
    run: async (task, runtime, context) => {
      try {
        const result = await runFromInput(task.input, {
          ...(task.state.checkpoint.research ? { resume: task.state.checkpoint.research } : {}),
          onCheckpoint: async (research) => {
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'run', research } }), context);
          },
          // 映射落在 generations 行（terminal state 不含 checkpoint），终态后子页面仍可读取。
          onAgentConversation: async (key, conversationId) => {
            await setGenerationAgentConversation(task.input.userId, task.input.jobId, key, conversationId);
          },
        }, task.id);
        await runtime.commit(() => taskOutcome(result), context);
      } catch (error) {
        await runtime.commit(
          () => ({
            status: 'terminal',
            outcome: { status: 'failed', error: { message: error instanceof Error ? error.message : String(error) } },
          }),
          context,
        );
      }
    },
  },
  abort: async (task, runtime, context) => {
    // 用户从任务卡的取消、或宿主关闭：先让正在跑的流水线看到取消，再落任务行终态。
    // 与 orchestrator 的取消收口幂等：谁先写 cancelled 都一样。
    const input = task.input;
    const run = runOf(input);
    run.cancelReason = 'user';
    run.abort.abort();
    emitLive(run, { type: 'job_cancelled', reason: 'user' });
    await finalizeGenerationTask(refOf(input), 'cancelled', null, {
      destination: input.form.destination,
      days: input.form.days,
    }).catch(() => {});
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});