import { createHash } from 'node:crypto';
import type { GenerationNotification, Trip, TripShareImageGeneratedResponse, TripShareImageResponse } from '@tripweaver/shared';
import { env } from '../env';
import { generateShareImage, imageError, type GeneratedShareImage } from '../integrations/imageGeneration';
import { applyShareBrand } from '../lib/sharePosterBrand';
import { buildTripSharePrompt, type TripShareStyle } from '../lib/tripSharePrompt';
import type { SharePosterStore } from './sharePosterStore';

export type ShareImageGenerator = (prompt: string) => Promise<GeneratedShareImage>;

const defaultGenerator: ShareImageGenerator = prompt => generateShareImage(env.imageProviders, prompt);
const promptHash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * 成品持久化在 store（磁盘 + 数据库），进程内只保留「合并同一张图的进行中请求」与并发闸门。
 * store 由调用方注入：路由传数据库实现，单测传内存实现，因此本模块不依赖 db 客户端。
 */
export function createTripShareImageService(store: SharePosterStore, generate: ShareImageGenerator = defaultGenerator,
  notify: (userId: string, trip: Trip, style: TripShareStyle) => Promise<GenerationNotification | undefined> = async () => undefined) {
  const pending = new Map<string, Promise<TripShareImageGeneratedResponse>>();
  const activeUsers = new Set<string>();

  /** 已落盘且与当前行程内容一致的成品；prompt 变了说明行程已改，旧图不回显 */
  const find = async (userId: string, trip: Trip, style: TripShareStyle = 'journal'): Promise<TripShareImageResponse | null> => {
    const saved = await store.find(userId, trip.id, style);
    return saved && saved.promptHash === promptHash(buildTripSharePrompt(trip, style)) ? saved.image : null;
  };

  const produce = async (userId: string, trip: Trip, style: TripShareStyle = 'journal', regenerate = false): Promise<TripShareImageGeneratedResponse> => {
    const prompt = buildTripSharePrompt(trip, style);
    const key = `${userId}:${trip.id}:${style}:${promptHash(prompt)}`;
    const existing = pending.get(key);
    if (existing) return existing;
    if (!regenerate) {
      const done = await find(userId, trip, style);
      if (done) return done;
      // 查库是异步的，同内容请求可能已在这段时间里开始生成，回收到同一个 promise
      const raced = pending.get(key);
      if (raced) return raced;
    }
    if (activeUsers.has(userId) || pending.size >= 2) throw imageError('正在生成分享图，请稍后再试', 429);
    activeUsers.add(userId);
    const job = Promise.resolve().then(() => generate(prompt))
      // 落盘前补品牌带：下载、通知、GET /share-image 三个出口拿到的都是带品牌版本
      .then(async image => (env.shareBrandEnabled ? { ...image, bytes: (await applyShareBrand(image.bytes, style)).bytes } : image))
      .then(image => store.save({ userId, tripId: trip.id, style, promptHash: promptHash(prompt), bytes: image.bytes, mimeType: image.mimeType }))
      // 放在合并中的任务内：重复 POST 共享一条通知，读取已有成品不发通知。
      .then(async saved => ({ ...saved.image, notification: await notify(userId, trip, style) }))
      // 失败时库里仍保留上一张成品，前端可继续下载
      .finally(() => { pending.delete(key); activeUsers.delete(userId); });
    pending.set(key, job);
    return job;
  };

  return { find, generate: produce };
}
