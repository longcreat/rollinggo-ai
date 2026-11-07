// 实时直播层（替代旧 jobManager）：只保存投影、订阅与取消信号，任务真相在 generations 行。
// 进程重启后实时层会由 durable task 重新建立；终态行仍可由持久层读到。
import {
  emptySnapshot,
  emptyTripProjectionState,
  type GenerationCancelReason,
  type GenerationEvent,
  type GenerationJobStatus,
  type TripProjectionSnapshot,
} from '@tripweaver/shared';
import { createGenerationProjection, type GenerationProjection } from './projectionAdapter';
import type { GenerationTaskRef } from './provenance';
import type { GenerationTaskView } from './taskStore';

const FINISHED_TTL_MS = 30 * 60 * 1000;
const TERMINAL_EVENTS = new Set(['job_done', 'job_error', 'job_cancelled']);

export interface LiveRun {
  readonly jobId: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly ref: GenerationTaskRef;
  readonly provenance: GenerationTaskRef['provenance'];
  readonly abort: AbortController;
  /** 用户取消 / 超时；orchestrator 据此区分终态文案。 */
  cancelReason: GenerationCancelReason;
  readonly projection: GenerationProjection;
  readonly status: GenerationJobStatus;
  readonly tripId: string | null;
}

interface MutableLiveRun extends LiveRun {
  status: GenerationJobStatus;
  tripId: string | null;
}

type ProjectionResumeResult = ReturnType<GenerationProjection['channel']['resume']>;
type FrameListener = (frame: ReturnType<GenerationProjection['channel']['publish']>) => void;
type EventListener = (event: GenerationEvent) => void;

const runs = new Map<string, MutableLiveRun>();
const frameListeners = new Map<string, Set<FrameListener>>();
const eventListeners = new Map<string, Set<EventListener>>();

function terminal(event: GenerationEvent): boolean {
  return TERMINAL_EVENTS.has(event.type);
}

/** 开始一次直播；同一 jobId 重跑（resume）时替换旧实例，旧流水线先收到取消。 */
export function createLiveRun(ref: GenerationTaskRef): LiveRun {
  const previous = runs.get(ref.jobId);
  if (previous) {
    previous.abort.abort();
    frameListeners.delete(ref.jobId);
    eventListeners.delete(ref.jobId);
  }
  const run: MutableLiveRun = {
    jobId: ref.jobId,
    userId: ref.userId,
    createdAt: ref.createdAt,
    provenance: ref.provenance,
    ref,
    abort: new AbortController(),
    cancelReason: 'user',
    projection: createGenerationProjection(ref.jobId),
    status: 'running',
    tripId: null,
  };
  runs.set(ref.jobId, run);
  return run;
}

export function getLiveRun(jobId: string, userId?: string): LiveRun | null {
  const run = runs.get(jobId);
  if (!run) return null;
  if (userId !== undefined && run.userId !== userId) return null;
  return run;
}

/** 当前用户仍在直播的任务（同一用户同一时刻最多一份，与持久层运行闸门同口径）。 */
export function getActiveLiveRunForUser(userId: string): LiveRun | null {
  for (const run of runs.values()) {
    if (run.userId === userId && run.status === 'running') return run;
  }
  return null;
}

/** 落事件 + 广播投影帧；坏监听器不能拖垮流水线。终态之后一律忽略，保证终态唯一。 */
export function emitLive(run: LiveRun, event: GenerationEvent): void {
  const mutable = run as MutableLiveRun;
  if (mutable.status !== 'running') return;
  const stamped: GenerationEvent = { ...event, at: event.at ?? Date.now() };
  let frames: ReturnType<GenerationProjection['channel']['publish']>[] = [];
  try {
    frames = run.projection.consume(stamped);
  } catch {
    frames = [];
  }
  const ended = terminal(stamped);
  // 先更新状态再广播：终态监听器读 run.status 时必须已看到终态。
  if (ended) {
    mutable.status = stamped.type === 'job_done' ? 'done' : stamped.type === 'job_error' ? 'error' : 'cancelled';
    mutable.tripId = stamped.type === 'job_done' ? stamped.tripId : null;
  }
  for (const listener of frameListeners.get(run.jobId) ?? []) {
    for (const frame of frames) {
      try { listener(frame); } catch { frameListeners.get(run.jobId)?.delete(listener); }
    }
  }
  for (const listener of eventListeners.get(run.jobId) ?? []) {
    try { listener(stamped); } catch { eventListeners.get(run.jobId)?.delete(listener); }
  }
  if (ended) {
    const timer = setTimeout(() => {
      if (runs.get(run.jobId) === run) runs.delete(run.jobId);
      frameListeners.delete(run.jobId);
      eventListeners.delete(run.jobId);
    }, FINISHED_TTL_MS);
    timer.unref?.();
  }
}

export function subscribeLiveProjection(
  run: LiveRun,
  fromSeq: number,
  listener: FrameListener,
): { initial: ProjectionResumeResult; unsubscribe: () => void } {
  const initial = run.projection.channel.resume(fromSeq);
  let set = frameListeners.get(run.jobId);
  if (!set) { set = new Set(); frameListeners.set(run.jobId, set); }
  set.add(listener);
  return { initial, unsubscribe: () => set?.delete(listener) };
}

/** 评测用实时观测：不缓冲、不重放。 */
export function observeLiveRun(run: LiveRun, listener: EventListener): () => void {
  let set = eventListeners.get(run.jobId);
  if (!set) { set = new Set(); eventListeners.set(run.jobId, set); }
  set.add(listener);
  return () => set?.delete(listener);
}

/** 用户取消：只发信号，终态与任务行由 orchestrator / durable 任务落。 */
export function cancelLiveRun(jobId: string, userId?: string, reason: GenerationCancelReason = 'user'): boolean {
  const run = getLiveRun(jobId, userId);
  if (!run || run.status !== 'running') return false;
  (run as MutableLiveRun).cancelReason = reason;
  run.abort.abort();
  return true;
}

export function isLiveTerminal(status: GenerationJobStatus): boolean {
  return status !== 'running';
}

/** 终态但实时层已过期（重启/超过 TTL）：用持久任务行合成最小投影，供页面完成交接。 */
export function projectionFromTask(task: GenerationTaskView): TripProjectionSnapshot {
  const state = emptyTripProjectionState();
  state.control = {
    phase: task.status === 'done' ? 'commit' : 'idle',
    status: task.status,
    jobId: task.jobId,
    ...(task.tripId ? { tripId: task.tripId } : {}),
    ...(task.error ? { message: task.error } : {}),
  };
  if (task.destination) {
    state.trip = {
      id: task.tripId ?? task.jobId,
      title: `${task.destination} · ${task.status === 'done' ? '已生成' : '生成中断'}`,
      destination: task.destination,
      startDate: '',
      ...(task.days !== undefined ? { days: task.days } : {}),
      updatedAt: task.finishedAt ?? task.createdAt,
    };
  }
  return emptySnapshot(state);
}

/** 测试用：清空实时层。 */
export function resetLiveRuns(): void {
  for (const run of runs.values()) run.abort.abort();
  runs.clear();
  frameListeners.clear();
  eventListeners.clear();
}
