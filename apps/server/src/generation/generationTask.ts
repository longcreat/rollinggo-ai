// 生成任务的 durable 骨架（阶段二 #7）。
//
// 任务输入携带重建运行上下文所需的全部**非敏感**数据（jobId / userId / form / provenance）；
// 进程重启后 duable task 被 resume 时，按输入重建内存 Job 并从用户设置重新解析 LLM 配置，
// 然后重跑整条流水线（落库前无副作用，重跑安全）。BYOK 密钥不进入任务输入。
//
// 下一步：把 runGeneration 拆成 research/plan/calibrate/write/gate/commit 多 phase，在每个边界
// checkpoint，崩溃后从上一个阶段续跑（当前是整条流水线一个 phase，重跑代价是重新调研）。
import { defineTask } from '@earendil-works/pi-durable';
import type { GenerateForm } from '@tripweaver/shared';
import { rehydrateJob, failJob, type JobProvenance } from './jobManager';
import { runGeneration, type GenerationRunOptions } from './orchestrator';
import { resolveLlmConfig } from '../services/settingsService';
import type { ResearchCheckpoint } from './checkpoint';

export interface GenerationTaskInput {
  jobId: string;
  userId: string;
  form: GenerateForm;
  provenance: JobProvenance;
}

export interface GenerationTaskState {
  phase: 'run';
  /** 调研完成后的 checkpoint：重启后复用，跳过最耗时的 LLM 调研。 */
  research?: ResearchCheckpoint;
}

export interface GenerationRunResult {
  status: 'done' | 'error' | 'cancelled';
  tripId: string | null;
  message?: string;
}

export interface GenerationTaskResult {
  tripId: string | null;
}

/**
 * 重建运行上下文并跑完整条流水线。
 * `runGeneration` 自己负责终态（completeJob/failJob/cancelJob）与投影事件。
 */
async function runFromInput(input: GenerationTaskInput, options?: GenerationRunOptions): Promise<GenerationRunResult> {
  const job = rehydrateJob(input.jobId, input.userId, input.provenance);
  const cfg = await resolveLlmConfig(input.userId);
  if (!cfg) {
    const message = '当前没有可用的 AI 配置';
    failJob(job, message);
    return { status: 'error', tripId: null, message };
  }
  await runGeneration(job, input.form, cfg, undefined, options);
  const status = job.status === 'running' ? 'error' : job.status;
  return { status, tripId: job.tripId };
}

/** 运行结果 → durable 任务终态（纯函数，便于单测）。 */
export function taskOutcome(result: GenerationRunResult):
  | { status: 'terminal'; outcome: { status: 'completed'; result: { tripId: string | null } } }
  | { status: 'terminal'; outcome: { status: 'aborted' } }
  | { status: 'terminal'; outcome: { status: 'failed'; error: { message: string } } } {
  if (result.status === 'done') return { status: 'terminal', outcome: { status: 'completed', result: { tripId: result.tripId } } };
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
        });
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
  abort: async (_task, runtime, context) => {
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});