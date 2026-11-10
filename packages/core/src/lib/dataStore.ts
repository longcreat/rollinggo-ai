// 进程级数据存储实例与媒体 key 约定。
//
// 存储根 = 仓库 `data/` 目录：媒体字节在 `media/` 下，图源索引在 `photo-store/` 下。
// 因此桶内布局与宿主机磁盘一一对应，迁移就是 `aws s3 sync data/ s3://<bucket>/`。
//
// 本模块读 env，单测要注入假存储时直接用 lib/mediaStore 的实现，不要 import 这里 —— 否则
// 单测会被 env 校验（MASTER_KEY 等）拦住。
import { fileURLToPath } from 'node:url';
import { env } from '../env';
import { createLocalMediaStore, createS3MediaStore, normalizeMediaKey, type MediaStore } from './mediaStore';

/** 容器里 WORKDIR=/app、src 在 /app/apps/server/src，因此与 compose 的 ./data:/app/data 对齐 */
export const dataRoot = fileURLToPath(new URL('../../../../data/', import.meta.url));

export const dataStore: MediaStore = env.mediaStore.mode === 's3'
  ? createS3MediaStore(env.mediaStore.s3)
  : createLocalMediaStore(dataRoot);

const MEDIA_PREFIX = 'media/';

/**
 * 进程级缓存（外呼 TTL、检索结果表）是跨任务共享的，与存储实现无关；
 * 注入不同存储的单测必须落在不同缓存 key 上，因此按实例给一个稳定编号。
 */
const storeScopes = new WeakMap<MediaStore, number>();
let nextStoreScope = 0;
export function storeScope(store?: MediaStore): string {
  if (!store) return '';
  let id = storeScopes.get(store);
  if (id === undefined) { id = ++nextStoreScope; storeScopes.set(store, id); }
  return `#${id}`;
}

/**
 * 把库里存的媒体值归一成对象 key：`xhs/…`、`/media/xhs/…` 与 CDN 完整 URL 都变成 `media/xhs/…`。
 * 非法输入返回 null —— 调用方必须跳过，不能猜路径。
 */
export function mediaObjectKey(value: string): string | null {
  const base = env.mediaBaseUrl;
  let rest = value.trim();
  if (base && rest.startsWith(`${base}/`)) rest = rest.slice(base.length + 1);
  rest = rest.replace(/^\/+/, '');
  if (rest.startsWith(MEDIA_PREFIX)) rest = rest.slice(MEDIA_PREFIX.length);
  const clean = normalizeMediaKey(rest);
  return clean ? MEDIA_PREFIX + clean : null;
}
