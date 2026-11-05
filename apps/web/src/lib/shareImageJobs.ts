import { SHARE_POSTER_URL_PATTERN, TripShareImageGeneratedResponseSchema, type GenerationNotification, type Trip, type TripShareImageResponse, type TripShareImageStyle } from '@tripweaver/shared';
import { Value } from '@sinclair/typebox/value';
import { api } from '../api/client';
import { downloadShareImage, isWeChat } from './export';

/** 生图任务挂在模块级：离开详情页再回来仍能看到进行中的生成，卸载组件不会中断请求。 */
export type ShareImageJob = {
  /** 本次请求的目标风格 */
  style: TripShareImageStyle;
  signature: string;
  status: 'running' | 'done' | 'error';
  /** 最近一次成功的成品：重新生成或失败期间保留，不丢已有可下载的图 */
  result?: { image: TripShareImageResponse; style: TripShareImageStyle; signature: string };
  error?: string;
};

/** 行程内容签名：内容变了就不能复用旧成品（服务端用 prompt hash 做同样的判断） */
export function shareImageSignature(trip: Trip): string {
  return JSON.stringify([trip.id, trip.title, trip.destination, trip.days.map(day => day.activities.map(activity => [activity.category, activity.name]))]);
}

const jobs = new Map<string, ShareImageJob>();
const listeners = new Set<() => void>();
export type ShareImageCompletion = { userId: string; notification: GenerationNotification; downloadStarted: boolean };
const completionListeners = new Set<(event: ShareImageCompletion) => void>();
let currentUserId = '';
const loading = new Map<string, Promise<void>>();
const POSTER_URL = new RegExp(SHARE_POSTER_URL_PATTERN);

/** 账号生命周期独立于详情页：切页保留任务，退出后忽略迟到响应。 */
export function setShareImageUser(userId: string): void {
  if (currentUserId === userId) return;
  currentUserId = userId;
  jobs.clear();
  loading.clear();
  emit();
}

export function subscribeShareImageCompletion(listener: (event: ShareImageCompletion) => void): () => void {
  completionListeners.add(listener);
  return () => { completionListeners.delete(listener); };
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** 成品是站内静态文件；拒绝非预期响应，避免把错误页当图片展示 */
function isShareImage(value: unknown): value is TripShareImageResponse {
  if (!value || typeof value !== 'object') return false;
  const image = value as TripShareImageResponse;
  return ['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) && POSTER_URL.test(image.url ?? '');
}

export function subscribeShareImageJobs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getShareImageJob(tripId: string): ShareImageJob | undefined {
  return jobs.get(tripId);
}

export function clearShareImageError(tripId: string): void {
  if (jobs.get(tripId)?.status !== 'error') return;
  jobs.delete(tripId);
  emit();
}

/**
 * 打开弹窗或切换风格时拉取服务端已落盘的成品：刷新页面后无需重新生成即可回显。
 * 404（尚无成品）与网络失败都按「没有成品」处理，不打扰用户，仍由显式「开始生成」兜底。
 */
export function loadShareImage(trip: Trip, style: TripShareImageStyle): Promise<void> {
  if (jobs.get(trip.id)?.status === 'running' || jobs.get(trip.id)?.result?.style === style) return Promise.resolve();
  const key = `${trip.id}:${style}`;
  const inflight = loading.get(key);
  if (inflight) return inflight;
  const owner = currentUserId;
  const task = Promise.resolve().then(async () => {
    try {
      const image = await api.get<TripShareImageResponse>(`/api/trips/${encodeURIComponent(trip.id)}/share-image?style=${style}`);
      // 请求期间用户点了生成，进行中的结果优先
      if (owner !== currentUserId || loading.get(key) !== task || !isShareImage(image) || jobs.get(trip.id)?.status === 'running') return;
      const signature = shareImageSignature(trip);
      jobs.set(trip.id, { status: 'done', style, signature, result: { image, style, signature } });
      emit();
    } catch { /* 尚无成品或请求失败：保持风格选择页 */ }
  }).finally(() => { if (loading.get(key) === task) loading.delete(key); });
  loading.set(key, task);
  return task;
}

export function startShareImageJob(trip: Trip, style: TripShareImageStyle, signature: string, regenerate: boolean): void {
  if (!currentUserId || jobs.get(trip.id)?.status === 'running') return;
  const userId = currentUserId;
  const running: ShareImageJob = { status: 'running', style, signature, result: jobs.get(trip.id)?.result };
  jobs.set(trip.id, running);
  emit();
  void api.post<unknown>(`/api/trips/${encodeURIComponent(trip.id)}/share-image`, { trip, style, regenerate }, { timeoutMs: 240_000 })
    .then(async image => {
      if (currentUserId !== userId || jobs.get(trip.id) !== running) return;
      if (!Value.Check(TripShareImageGeneratedResponseSchema, image)) throw new Error('图片响应异常，请重试');
      jobs.set(trip.id, { status: 'done', style, signature, result: { image, style, signature } });
      emit();
      let downloadStarted = false;
      // 浏览器交付失败不能把已经生成的成品变成失败；通知仍提供手动下载。
      if (!isWeChat()) {
        try { downloadStarted = await downloadShareImage(image, trip.title); } catch { /* 手动下载兜底 */ }
      }
      const notification: GenerationNotification = image.notification ?? {
        id: '', sequence: 0, jobId: '', kind: 'success', tripId: trip.id, shareImageStyle: style,
        title: `${trip.title} · 图片已生成`, message: '旅行海报已生成，可随时下载图片。', createdAt: Date.now(), readAt: null,
      };
      for (const listener of completionListeners) listener({ userId, notification, downloadStarted });
    })
    .catch((reason: unknown) => {
      if (currentUserId !== userId || jobs.get(trip.id) !== running) return;
      jobs.set(trip.id, { status: 'error', style, signature, error: reason instanceof Error ? reason.message : '图片生成失败，请重试', result: jobs.get(trip.id)?.result });
      emit();
    });
}
