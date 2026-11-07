// 生成任务管理：内存任务表 + 统一投影 + 取消。
// 单实例边界：重启即丢内存任务；durable task（generationTask）负责按输入重建。
import {
  uid,
  type DataSourceKind,
  type GenerationCancelReason,
  type GenerationEvent,
  type GenerationJobStatus,
  type GenerationJobView,
  type GenerationKind,
  type TripProjectionFrame,
  type TripProjectionRow,
  type TripProjectionState,
} from '@tripweaver/shared';
import { createGenerationProjection, type GenerationProjection } from './projectionAdapter';
import type { ProjectionResume } from './projectionChannel';

const FINISHED_TTL_MS = 30 * 60 * 1000; // 终态任务保留 30 分钟供刷新恢复

type ProjectionListener = (frame: TripProjectionFrame) => void;
/** 仅实时的原始事件观测（评测诊断用）：不缓冲、不重放。 */
type EventListener = (event: GenerationEvent) => void;

/** 生成来源：区分「表单/对话新建」与「基于已有行程的修订」；对话入口时代三列均缺省 */
export interface JobProvenance {
  conversationId?: string;
  kind: GenerationKind;
  targetTripId?: string;
}

export interface Job {
  id: string;
  userId: string;
  status: GenerationJobStatus;
  tripId: string | null;
  destination?: string;
  days?: number;
  createdAt: number;
  provenance: JobProvenance;
  abort: AbortController;
  /** 取消来源：路由层用户取消置 'user'；orchestrator 超时置 'timeout'。默认 'user' */
  cancelReason: GenerationCancelReason;
  /** 统一投影：事件的唯一消费者，真相在这里，不再保留事件环形缓冲。 */
  projection: GenerationProjection;
  projectionListeners: Set<ProjectionListener>;
  /** 实时事件观测者（评测）；事件本身不保留。 */
  eventListeners: Set<EventListener>;
}

const jobs = new Map<string, Job>();
const runningByUser = new Map<string, string>();

export function getRunningJobId(userId: string): string | null {
  return runningByUser.get(userId) ?? null;
}

export function createJob(userId: string, provenance: JobProvenance = { kind: 'generation' }): Job {
  return registerJob(uid(), userId, provenance);
}

/**
 * 进程重启后按原 id 重建内存任务（durable task 续跑时用）：
 * 已有同名任务直接复用；否则新建一份空白任务，随后由 runGeneration 重新 emit job_start。
 */
export function rehydrateJob(id: string, userId: string, provenance: JobProvenance = { kind: 'generation' }): Job {
  return jobs.get(id) ?? registerJob(id, userId, provenance);
}

function registerJob(id: string, userId: string, provenance: JobProvenance): Job {
  const job: Job = {
    id,
    userId,
    status: 'running',
    tripId: null,
    createdAt: Date.now(),
    provenance,
    abort: new AbortController(),
    cancelReason: 'user',
    projection: createGenerationProjection(id),
    projectionListeners: new Set(),
    eventListeners: new Set(),
  };
  jobs.set(job.id, job);
  runningByUser.set(userId, job.id);
  return job;
}

export function getJob(jobId: string, userId: string): Job | null {
  const job = jobs.get(jobId);
  return job && job.userId === userId ? job : null;
}

export function jobView(job: Job): GenerationJobView {
  return { jobId: job.id, status: job.status, tripId: job.tripId, createdAt: job.createdAt, destination: job.destination, days: job.days };
}

export function emit(job: Job, event: GenerationEvent): void {
  if (event.type === 'job_start') { job.destination = event.destination; job.days = event.days; }
  if (job.status !== 'running' && event.type !== 'job_done' && event.type !== 'job_error' && event.type !== 'job_cancelled') return;
  const stamped: GenerationEvent = { ...event, at: event.at ?? Date.now() };
  // 投影是唯一消费者；投影失败绝不能拖垮生成流水线。
  let frames: TripProjectionFrame[] = [];
  try {
    frames = job.projection.consume(stamped);
  } catch {
    frames = [];
  }
  for (const listener of job.projectionListeners) {
    for (const frame of frames) {
      try {
        listener(frame);
      } catch {
        job.projectionListeners.delete(listener);
        break;
      }
    }
  }
  for (const listener of job.eventListeners) {
    try {
      listener(stamped);
    } catch {
      job.eventListeners.delete(listener);
    }
  }
}

/** 订阅实时事件（评测诊断用，无重放）。 */
export function observe(job: Job, listener: EventListener): () => void {
  job.eventListeners.add(listener);
  return () => job.eventListeners.delete(listener);
}

function finish(job: Job, status: GenerationJobStatus): void {
  job.status = status;
  if (runningByUser.get(job.userId) === job.id) runningByUser.delete(job.userId);
  setTimeout(() => jobs.delete(job.id), FINISHED_TTL_MS).unref?.();
}

export function completeJob(job: Job, tripId: string, dataSources: DataSourceKind[], reviewNotes: string[]): void {
  if (job.status !== 'running') return;
  const finishedAt = Date.now();
  job.tripId = tripId;
  finish(job, 'done');
  // usedXhs 为旧前端兼容字段（小红书已移除，恒 false）
  emit(job, { type: 'job_done', tripId, usedXhs: false, dataSources, reviewNotes, at: finishedAt, durationMs: finishedAt - job.createdAt });
}

export function failJob(job: Job, message: string): void {
  if (job.status !== 'running') return;
  const finishedAt = Date.now();
  finish(job, 'error');
  emit(job, { type: 'job_error', message, at: finishedAt, durationMs: finishedAt - job.createdAt });
}

export function cancelJob(job: Job, reason: GenerationCancelReason = job.cancelReason): void {
  if (job.status !== 'running') return;
  const finishedAt = Date.now();
  finish(job, 'cancelled');
  emit(job, { type: 'job_cancelled', reason, at: finishedAt, durationMs: finishedAt - job.createdAt });
}

/** 重放 afterId 之后的事件，再挂实时监听；返回退订函数 */
/**
 * 投影订阅：先按客户端水位裁决补增量或重发快照，再挂实时帧监听。
 * resume 与 add 之间没有 await，单线程下不会漏帧。
 */
export function subscribeProjection(
  job: Job,
  fromSeq: number,
  listener: ProjectionListener,
): { initial: ProjectionResume<TripProjectionRow, TripProjectionState>; unsubscribe: () => void } {
  const initial = job.projection.channel.resume(fromSeq);
  if (!isTerminal(job.status)) job.projectionListeners.add(listener);
  return { initial, unsubscribe: () => job.projectionListeners.delete(listener) };
}

export function isTerminal(status: GenerationJobStatus): boolean {
  return status !== 'running';
}
