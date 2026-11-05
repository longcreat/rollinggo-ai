// 分享海报成品的持久层：图片按内容寻址写进对象存储的 `media/share-posters/`，库表只存索引。
// 表主键 (trip_id, style) 即「同一行程同一风格只留最新一张」，被替换的旧文件在写入后删除。
// 存储与数据库都通过 createSharePosterStore 注入，单测用内存实现即可避开副作用。
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { TripShareImageResponse, TripShareImageStyle } from '@tripweaver/shared';
import { db } from '../db/client';
import { tripShareImages } from '../db/schema';
import { env } from '../env';
import { dataStore } from '../lib/dataStore';
import { mediaCacheControl, type MediaStore } from '../lib/mediaStore';
import { createSerialQueue } from '../lib/serialQueue';

type MimeType = TripShareImageResponse['mimeType'];

export type StoredSharePoster = { promptHash: string; image: TripShareImageResponse };
export type SharePosterInput = {
  userId: string;
  tripId: string;
  style: TripShareImageStyle;
  promptHash: string;
  bytes: Buffer;
  mimeType: MimeType;
};

export interface SharePosterStore {
  /** 没有记录、mime_type 异常或磁盘文件已丢失时返回 null，调用方据此重新生成 */
  find(userId: string, tripId: string, style: TripShareImageStyle): Promise<StoredSharePoster | null>;
  /** 覆盖写入：先落盘再 upsert，最后删除被替换的旧文件 */
  save(input: SharePosterInput): Promise<StoredSharePoster>;
}

// 与媒体存储共用同一个存储根：index.ts 把 data/ 以 /media/ 前缀静态托管（dev 与 prod），
// 对象存储模式则由 MEDIA_BASE_URL 指向桶的公开域名。
const POSTER_DIRECTORY = 'media/share-posters';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FILE_NAME = /^[a-f0-9]{64}\.(?:png|jpg|webp)$/;
const EXTENSIONS: Record<MimeType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MIME_TYPES: MimeType[] = ['image/png', 'image/jpeg', 'image/webp'];
const diskQueue = createSerialQueue(0);

// 展示用 URL：前缀由 MEDIA_BASE_URL 决定 —— 默认同源 /media，CDN 模式则是桶的公开域名 + /media。
// 文件名是内容 sha256，所以换前缀不需要重导数据库（库里只存 fileName）。
export const sharePosterUrl = (fileName: string, base = env.mediaBaseUrl): string => `${base}/share-posters/${fileName}`;

function mimeTypeOf(value: string): MimeType | null {
  return MIME_TYPES.includes(value as MimeType) ? value as MimeType : null;
}

const posterKey = (fileName: string): string | null =>
  FILE_NAME.test(fileName) ? `${POSTER_DIRECTORY}/${fileName}` : null;

async function onStore(store: MediaStore, fileName: string): Promise<boolean> {
  const key = posterKey(fileName);
  return key ? store.exists(key) : false;
}

async function writePoster(store: MediaStore, fileName: string, bytes: Buffer, mimeType: MimeType): Promise<void> {
  const key = posterKey(fileName);
  if (!key) throw new Error('海报文件名异常');
  // 内容寻址：同名文件必然同内容，已存在就不重写（省一次对象存储写入）
  if (await store.exists(key)) return;
  await store.put(key, bytes, { contentType: mimeType, cacheControl: mediaCacheControl(key) });
}

async function removePoster(store: MediaStore, fileName: string): Promise<void> {
  const key = posterKey(fileName);
  if (key) await store.delete(key);
}

export function createSharePosterStore(store: MediaStore = dataStore): SharePosterStore {
  return {
    async find(userId, tripId, style) {
      const [row] = await db.select({
        promptHash: tripShareImages.promptHash, fileName: tripShareImages.fileName, mimeType: tripShareImages.mimeType,
      }).from(tripShareImages)
        .where(and(eq(tripShareImages.userId, userId), eq(tripShareImages.tripId, tripId), eq(tripShareImages.style, style)))
        .limit(1);
      const mime = row ? mimeTypeOf(row.mimeType) : null;
      if (!row || !mime || !await onStore(store, row.fileName)) return null;
      return { promptHash: row.promptHash, image: { url: sharePosterUrl(row.fileName), mimeType: mime } };
    },

    async save({ userId, tripId, style, promptHash, bytes, mimeType }) {
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('海报图片大小异常');
      const fileName = `${createHash('sha256').update(bytes).digest('hex')}.${EXTENSIONS[mimeType]}`;
      await diskQueue(() => writePoster(store, fileName, bytes, mimeType));
      const [previous] = await db.select({ fileName: tripShareImages.fileName }).from(tripShareImages)
        .where(and(eq(tripShareImages.userId, userId), eq(tripShareImages.tripId, tripId), eq(tripShareImages.style, style)))
        .limit(1);
      const createdAt = new Date();
      await db.insert(tripShareImages).values({ userId, tripId, style, promptHash, fileName, mimeType, createdAt })
        .onConflictDoUpdate({
          target: [tripShareImages.tripId, tripShareImages.style],
          set: { userId, promptHash, fileName, mimeType, createdAt },
        });
      // 旧图可能仍被浏览器缓存引用，但库里已不再指向它，删掉避免磁盘无限增长
      if (previous && previous.fileName !== fileName) await removePoster(store, previous.fileName);
      return { promptHash, image: { url: sharePosterUrl(fileName), mimeType } };
    },
  };
}

export const sharePosterStore = createSharePosterStore();
