// 媒体与索引对象的统一存取层：字节按 key 存取，本地磁盘是默认实现，S3 兼容实现（R2 / MinIO / S3）
// 由调用方注入（见 TRELLIS 任务 10-12-cdn）。
//
// 边界：本模块只管字节，不管展示 URL。URL 前缀由 MEDIA_BASE_URL 在读取侧拼接，
// 因此库里永远只存相对 key。
//
// 失败语义沿用集成层口径：**对象不存在返回 null/false**，其余错误（网络、鉴权、5xx）抛出，
// 由调用方按「可选资源」降级，不要让存储故障静默变成「这个地点没有图」。
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';

export type MediaObject = {
  key: string;
  size: number;
  /** S3 实现给出单段上传的 ETag（即内容 md5）；本地实现不返回 */
  etag?: string;
};

export type MediaPutOptions = {
  /** 对象存储会用它写 Content-Type；本地实现由扩展名推断，忽略此字段 */
  contentType?: string;
  /** 对象存储会用它写 Cache-Control；本地实现忽略此字段 */
  cacheControl?: string;
};

export interface MediaStore {
  /** 覆盖写入。已存在的 key 由实现自行决定是否跳过 */
  put(key: string, bytes: Buffer, options?: MediaPutOptions): Promise<void>;
  /** 不存在或不是文件时返回 null */
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** 列出 `prefix` 下所有对象（不含 prefix 本身）；不存在返回空数组。key 相对存储根，与 put 一致 */
  list(prefix: string): Promise<MediaObject[]>;
}

const MEDIA_STORE_MODES = ['local', 's3'] as const;
export type MediaStoreMode = (typeof MEDIA_STORE_MODES)[number];
export type S3MediaStoreEnv = {
  /** bucket 的 S3 端点，不含 bucket 名（R2：https://<account_id>.r2.cloudflarestorage.com） */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
};
export type MediaStoreConfig = { mode: MediaStoreMode; s3: S3MediaStoreEnv };

/**
 * 从环境变量解析存储后端配置。默认本地磁盘；`MEDIA_STORE=s3` 时 `data/` 整体搬进 S3 兼容桶
 * （R2 / MinIO / S3 均可），桶内 key 与 `data/` 下的相对路径一致（`media/…` 与 `photo-store/…`）。
 * 不依赖 env.ts，因此迁移脚本可以单独使用，不需要数据库凭据。
 */
export function readMediaStoreConfig(source: Record<string, string | undefined>): MediaStoreConfig {
  const read = (name: string, fallback = ''): string => {
    const value = source[name];
    return value === undefined || value === '' ? fallback : value.trim();
  };
  const rawMode = read('MEDIA_STORE', 'local');
  if (!MEDIA_STORE_MODES.includes(rawMode as MediaStoreMode)) {
    throw new Error(`[env] MEDIA_STORE 取值不正确："${rawMode}"，可选 local | s3`);
  }
  const s3 = {
    endpoint: read('MEDIA_S3_ENDPOINT').replace(/\/+$/, ''),
    bucket: read('MEDIA_S3_BUCKET'),
    accessKeyId: read('MEDIA_S3_ACCESS_KEY_ID'),
    secretAccessKey: read('MEDIA_S3_SECRET_ACCESS_KEY'),
    region: read('MEDIA_S3_REGION', 'auto'),
  };
  if (rawMode === 's3' && !(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey)) {
    throw new Error('[env] MEDIA_STORE=s3 需要 MEDIA_S3_ENDPOINT / MEDIA_S3_BUCKET / MEDIA_S3_ACCESS_KEY_ID / MEDIA_S3_SECRET_ACCESS_KEY 四项同时配置');
  }
  return { mode: rawMode as MediaStoreMode, s3 };
}

const KEY_PATTERN = /^[\p{L}\p{N}_./-]+$/u;

/** 归一化并校验 key：剥前导斜杠、拒绝空段与 `.` / `..`。非法返回 null，调用方必须中止而不是猜测路径。 */
export function normalizeMediaKey(key: string): string | null {
  const clean = key.trim().replace(/^\/+/, '');
  if (!clean || !KEY_PATTERN.test(clean)) return null;
  if (clean.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return clean;
}

/**
 * 内容寻址的文件名（`<sha256>.webp` 或 `xhs/photography/<placeId>/<hash>.webp`）内容永不变化，
 * 可以长缓存；`xhs/<城市>/<placeId>/NN.webp` 这类索引式命名会被上游重导覆盖，只能短缓存。
 */
export function mediaCacheControl(key: string): string {
  const file = key.slice(key.lastIndexOf('/') + 1);
  return /^[a-f0-9]{32,}\.(?:png|jpe?g|webp|gif)$/.test(file)
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=86400';
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', json: 'application/json',
};

/** 按扩展名给出响应 Content-Type；未知或不带扩展名时回 octet-stream。 */
export function mediaContentType(key: string): string {
  const file = key.slice(key.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  return (dot > 0 ? CONTENT_TYPES[file.slice(dot + 1).toLowerCase()] : undefined) ?? 'application/octet-stream';
}

/**
 * 本地磁盘实现。写入走「临时文件 + rename」保持原子性；Windows 下 rename 不能覆盖已存在文件，
 * 因此遇到 EEXIST/EPERM 时先删目标再重命名 —— 上游重导会复用 `xhs/…/00.webp` 这类非内容寻址 key。
 * key 直接映射为磁盘路径（中文目录保持原样，与既有 data/media 布局一致）。
 */
export function createLocalMediaStore(root: string): MediaStore {
  const resolve = (key: string): string | null => {
    const clean = normalizeMediaKey(key);
    return clean ? path.join(root, ...clean.split('/')) : null;
  };

  return {
    async put(key, bytes) {
      const file = resolve(key);
      if (!file) throw new Error(`媒体 key 非法：${key}`);
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        // 并发写同一 key（上游重导会复用 `xhs/…/00.webp` 这类 key）在 Windows 上不是原子的：
        // 目标恰好被另一个写入者的 rename/unlink 持有时会得到瞬时 EPERM，退避重试即可；
        // EEXIST 才是「目标存在且没被替换」的信号，此时先删再 rename。
        // 无论哪次成功，最终内容总是某一次完整写入（last-writer-wins），不会出现半个文件。
        for (let attempt = 0; ; attempt += 1) {
          try {
            await rename(temporary, file);
            break;
          } catch (error) {
            const code = errnoCode(error);
            if (attempt >= 8 || (code !== 'EEXIST' && code !== 'EPERM')) throw error;
            if (code === 'EEXIST') await unlink(file).catch(() => {});
            await new Promise(resolve => setTimeout(resolve, 3 * (attempt + 1)));
          }
        }
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },

    async get(key) {
      const file = resolve(key);
      if (!file) return null;
      try {
        return await readFile(file);
      } catch {
        return null;
      }
    },

    async delete(key) {
      const file = resolve(key);
      if (!file) return;
      await unlink(file).catch(() => {});
    },

    async exists(key) {
      const file = resolve(key);
      if (!file) return false;
      try {
        const info = await stat(file);
        return info.isFile() && info.size > 0;
      } catch {
        return false;
      }
    },

    async list(prefix) {
      const clean = normalizeMediaKey(prefix);
      if (!clean) throw new Error(`媒体 key 非法：${prefix}`);
      const found: MediaObject[] = [];
      const walk = async (directory: string, keyPrefix: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(target, `${keyPrefix}${entry.name}/`);
          else if (entry.isFile()) found.push({ key: `${keyPrefix}${entry.name}`, size: (await stat(target)).size });
        }
      };
      await walk(path.join(root, ...clean.split('/')), `${clean}/`);
      return found;
    },
  };
}

export type S3MediaStoreConfig = {
  /** bucket 的 S3 端点，不含 bucket 名（R2：https://<account_id>.r2.cloudflarestorage.com） */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 用 `auto`；MinIO / AWS 填真实 region */
  region?: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;
/** 缺 404 常量：R2 与 MinIO 都用它表示对象不存在；403 在只读策略下可能是「无权读」，不当作不存在。 */
const NOT_FOUND = 404;

function decodeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] ?? entity);
}

/**
 * ListObjectsV2 响应按固定形状取值。我们的 key 只允许字母/数字/`_./-` 与中文，
 * 不含 XML 元字符，因此不需要通用 XML 解析器。
 */
function parseListPage(xml: string): { keys: MediaObject[]; next?: string } {
  const entries = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
  const keys = entries.map(match => ({
    key: decodeXml(match[1]!.match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? ''),
    size: Number(match[1]!.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
    // 单段上传的 ETag 就是内容 md5（带引号）；多段上传不是，所以只当提示用
    etag: match[1]!.match(/<ETag>"?([0-9a-f]{32})"?<\/ETag>/)?.[1],
  })).filter(row => row.key);
  if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return { keys };
  const next = decodeXml(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? '');
  if (!next) throw new Error('媒体对象列表分页缺少 continuation token');
  return { keys, next };
}

/**
 * S3 兼容对象存储实现（aws4fetch 签名 + 全局 fetch）。key 里的非 ASCII 字符交给 URL 规范化处理：
 * aws4fetch 对 S3 会先 `decodeURIComponent(pathname)` 再单次编码，因此中文 key 不会被二次编码。
 */
export function createS3MediaStore(config: S3MediaStoreConfig): MediaStore {
  const base = `${config.endpoint.replace(/\/+$/, '')}/${config.bucket}`;
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region || 'auto',
    retries: 2,
  });

  const request = (key: string, method: string, init: RequestInit = {}): Promise<Response> => {
    const clean = normalizeMediaKey(key);
    if (!clean) throw new Error(`媒体 key 非法：${key}`);
    return client.fetch(`${base}/${clean}`, {
      ...init,
      method,
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  };

  const drain = async (response: Response): Promise<void> => { await response.body?.cancel(); };

  return {
    async put(key, bytes, options = {}) {
      // Content-Length 交给 aws4fetch 自行管理：它在 UNSIGNABLE_HEADERS 里，且签名前会把 body
      // 换成 `input.clone().arrayBuffer()` 再重建 Request，手写的长度头会与之不一致，
      // 线上表现为 PUT 全部抛 UND_ERR_INVALID_ARG「invalid content-length header」。
      const headers: Record<string, string> = {};
      if (options.contentType) headers['Content-Type'] = options.contentType;
      if (options.cacheControl) headers['Cache-Control'] = options.cacheControl;
      const response = await request(key, 'PUT', { body: new Uint8Array(bytes), headers });
      if (response.ok) { await drain(response); return; }
      const status = response.status;
      await drain(response);
      throw new Error(`媒体对象写入失败：HTTP ${status}`);
    },

    async get(key) {
      const response = await request(key, 'GET');
      if (response.status === NOT_FOUND) { await drain(response); return null; }
      if (!response.ok) {
        const status = response.status;
        await drain(response);
        throw new Error(`媒体对象读取失败：HTTP ${status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async delete(key) {
      const response = await request(key, 'DELETE');
      if (response.ok || response.status === NOT_FOUND) { await drain(response); return; }
      const status = response.status;
      await drain(response);
      throw new Error(`媒体对象删除失败：HTTP ${status}`);
    },

    async exists(key) {
      const response = await request(key, 'HEAD');
      await drain(response);
      if (response.status === NOT_FOUND) return false;
      if (!response.ok) throw new Error(`媒体对象探测失败：HTTP ${response.status}`);
      return true;
    },

    async list(prefix) {
      const clean = normalizeMediaKey(prefix);
      if (!clean) throw new Error(`媒体 key 非法：${prefix}`);
      const found: MediaObject[] = [];
      let token: string | undefined;
      for (;;) {
        const query = new URLSearchParams({ 'list-type': '2', prefix: `${clean}/` });
        if (token) query.set('continuation-token', token);
        const response = await client.fetch(`${base}/?${query.toString()}`, {
          method: 'GET', signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!response.ok) {
          const status = response.status;
          await drain(response);
          throw new Error(`媒体对象列表失败：HTTP ${status}`);
        }
        const page = parseListPage(await response.text());
        found.push(...page.keys);
        if (!page.next) return found;
        token = page.next;
      }
    },
  };
}
