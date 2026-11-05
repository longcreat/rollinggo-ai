// 生成任务管理：内存任务表 + 512 条事件环形缓冲 + Last-Event-ID 重放 + 取消
// 单实例边界（架构 §7）：重启即丢任务 —— 路由层在启动时不做恢复，进行中任务由前端超时兜底
import {
  uid,
  type DataSourceKind,
  type GenerationCancelReason,
  type GenerationEvent,
  type GenerationJobStatus,
  type GenerationJobView,
  type GenerationKind,
} from '@tripweaver/shared';

const RING_SIZE = 512;
const FINISHED_TTL_MS = 30 * 60 * 1000; // 终态任务保留 30 分钟供刷新恢复

export interface StoredEvent {
  id: number;
  event: GenerationEvent;
}

type Listener = (e: StoredEvent) => void;

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
  events: StoredEvent[];
  nextEventId: number;
  listeners: Set<Listener>;
}

const jobs = new Map<string, Job>();
const runningByUser = new Map<string, string>();

export function getRunningJobId(userId: string): string | null {
  return runningByUser.get(userId) ?? null;
}

export function createJob(userId: string, provenance: JobProvenance = { kind: 'generation' }): Job {
  const job: Job = {
    id: uid(),
    userId,
    status: 'running',
    tripId: null,
    createdAt: Date.now(),
    provenance,
    abort: new AbortController(),
    cancelReason: 'user',
    events: [],
    nextEventId: 1,
    listeners: new Set(),
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
  const stored: StoredEvent = { id: job.nextEventId++, event: { ...event, at: event.at ?? Date.now() } };
  job.events.push(stored);
  if (job.events.length > RING_SIZE) job.events.splice(0, job.events.length - RING_SIZE);
  for (const listener of job.listeners) {
    try {
      listener(stored);
    } catch {
      job.listeners.delete(listener);   // 坏监听器（如已断开的 SSE）绝不能拖垮流水线
    }
  }
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
export function subscribe(job: Job, afterId: number, listener: Listener): () => void {
  for (const stored of job.events) {
    if (stored.id > afterId) listener(stored);
  }
  if (!isTerminal(job.status)) job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

export function isTerminal(status: GenerationJobStatus): boolean {
  return status !== 'running';
}
