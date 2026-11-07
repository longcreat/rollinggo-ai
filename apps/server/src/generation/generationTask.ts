// 生成任务的 durable 骨架（阶段二 #7 第一步）。
//
// 现在整条流水线作为一个 phase 跑；下一步把它按 research/plan/calibrate/write/gate/commit
// 拆成多个 phase，在每个边界 checkpoint，崩溃后从上一个阶段续跑。
// 运行上下文（job / form / cfg / logger）是进程内的闭包，通过 jobId 注册；进程重启后缺失时
// 任务如实失败（不假装成功、不无限重试），由前端重新发起。
import { defineTask } from '@earendil-works/pi-durable';

export interface GenerationTaskInput {
  jobId: string;
}

export interface GenerationTaskState {
  phase: 'run';
}

export interface GenerationRunResult {
  status: 'done' | 'error' | 'cancelled';
  tripId: string | null;
  message?: string;
}

export interface GenerationTaskResult {
  tripId: string | null;
}

type Runner = () => Promise<GenerationRunResult>;

const runners = new Map<string, Runner>();

export function registerGenerationRunner(jobId: string, run: Runner): void {
  runners.set(jobId, run);
}

export function unregisterGenerationRunner(jobId: string): void {
  runners.delete(jobId);
}

export const GenerationTask = defineTask<GenerationTaskInput, GenerationTaskState, GenerationTaskResult>({
  name: 'tripweaver.generation',
  version: 1,
  initial: () => ({ phase: 'run' }),
  phases: {
    run: async (task, runtime, context) => {
      const run = runners.get(task.input.jobId);
      if (!run) {
        // 进程重启后内存里的运行上下文已丢失：不假装成功，也不无限重试。
        await runtime.commit(
          () => ({
            status: 'terminal',
            outcome: { status: 'failed', error: { message: '生成上下文已丢失（进程重启），请重新发起' } },
          }),
          context,
        );
        return;
      }
      try {
        const result = await run();
        await runtime.commit(
          () => ({
            status: 'terminal',
            outcome:
              result.status === 'done'
                ? { status: 'completed', result: { tripId: result.tripId } }
                : result.status === 'cancelled'
                  ? { status: 'aborted' }
                  : { status: 'failed', error: { message: result.message ?? '生成失败' } },
          }),
          context,
        );
      } catch (error) {
        await runtime.commit(
          () => ({
            status: 'terminal',
            outcome: { status: 'failed', error: { message: error instanceof Error ? error.message : String(error) } },
          }),
          context,
        );
      } finally {
        runners.delete(task.input.jobId);
      }
    },
  },
  abort: async (task, runtime, context) => {
    runners.delete(task.input.jobId);
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
  },
});