// 任务状态视图：实时投影优先（有阶段/步骤），否则读持久任务行（重启后仍可答）。
// 纯函数，便于单测；不改变行程，也不推断未发生的结果。
import type { GenerationJobStatus, GenerationWarning } from '@tripweaver/shared';
import type { GenerationTaskView } from './taskStore';

export interface LiveGenerationStatus {
  jobId: string;
  status: GenerationJobStatus;
  tripId: string | null;
  destination?: string;
  days?: number;
  phase?: string;
  steps?: string[];
}

export interface GenerationStatusView {
  running: boolean;
  jobId?: string;
  status?: GenerationJobStatus;
  tripId?: string | null;
  destination?: string;
  days?: number;
  phase?: string;
  steps?: string[];
  summary?: string;
  reviewNotes?: string[];
  warnings?: GenerationWarning[];
  /** 持久行仍是 running 但已超过单任务上限：提示「可能已中断」，不冒充进行中。 */
  stale?: boolean;
}

export function generationStatusView(input: {
  live?: LiveGenerationStatus | null;
  task?: GenerationTaskView | null;
  now?: number;
  staleAfterMs?: number;
}): GenerationStatusView {
  if (input.live) {
    const live = input.live;
    return {
      running: live.status === 'running',
      jobId: live.jobId,
      status: live.status,
      tripId: live.tripId,
      ...(live.destination ? { destination: live.destination } : {}),
      ...(live.days !== undefined ? { days: live.days } : {}),
      ...(live.phase ? { phase: live.phase } : {}),
      ...(live.steps?.length ? { steps: live.steps } : {}),
    };
  }

  const task = input.task;
  if (!task) return { running: false };
  const stale = task.status === 'running'
    && input.now !== undefined
    && input.staleAfterMs !== undefined
    && input.now - task.createdAt > input.staleAfterMs;
  return {
    running: task.status === 'running' && !stale,
    jobId: task.jobId,
    status: stale ? 'error' : task.status,
    tripId: task.tripId,
    ...(task.destination ? { destination: task.destination } : {}),
    ...(task.days !== undefined ? { days: task.days } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(task.reviewNotes?.length ? { reviewNotes: task.reviewNotes } : {}),
    ...(task.warnings?.length ? { warnings: task.warnings } : {}),
    ...(stale ? { stale: true } : {}),
  };
}
