// 把宿主机 data/ 下的媒体字节与图源索引整体搬到 S3 兼容桶（Cloudflare R2 / MinIO / S3）。
//
// 默认只预演（不写入）；--apply 才真正上传。幂等靠「桶里已存在且大小一致就跳过」：
// 本地跑一遍、线上再跑一遍，各自只补自己新产生的文件，不会互相覆盖。
// 需要 MEDIA_STORE=s3 与四项 MEDIA_S3_* 凭据；不读数据库，可离线执行。
//
//   node --import tsx apps/server/scripts/migrate-media-to-s3.mts            # 预演
//   node --import tsx apps/server/scripts/migrate-media-to-s3.mts --apply    # 上传
import { config as loadEnv } from 'dotenv';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createS3MediaStore, mediaCacheControl, mediaContentType, readMediaStoreConfig, type MediaObject, type MediaStore,
} from '../src/lib/mediaStore';

// 不依赖 cwd：先读仓库根 .env（compose 部署），再读 apps/server/.env（本地开发，优先级更高）。
loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true, quiet: true });

/** 与 data/ 下的目录一一对应：media 是图片字节，photo-store 是检索/审核索引 */
const ROOTS = ['media', 'photo-store'] as const;
const CONCURRENCY = 16;
const DEFAULT_ROOT = fileURLToPath(new URL('../../../data/', import.meta.url));

type LocalObject = { key: string; size: number };

async function walk(directory: string, keyPrefix: string, found: LocalObject[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    // 写入中途的临时文件（local 实现用 `<file>.<uuid>.tmp`）不属于对象集合
    if (entry.isFile() && entry.name.endsWith('.tmp')) continue;
    if (entry.isDirectory()) await walk(target, `${keyPrefix}${entry.name}/`, found);
    else if (entry.isFile()) found.push({ key: `${keyPrefix}${entry.name}`, size: (await stat(target)).size });
  }
}

/** 索引是内部 JSON，不通过 /media 暴露；给短缓存避免桶上留下永久副本。 */
function uploadOptions(key: string): { contentType: string; cacheControl: string } {
  return key.startsWith('photo-store/')
    ? { contentType: 'application/json', cacheControl: 'public, max-age=86400' }
    : { contentType: mediaContentType(key), cacheControl: mediaCacheControl(key) };
}

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const { values } = parseArgs({ options: {
  apply: { type: 'boolean' }, root: { type: 'string' }, only: { type: 'string' }, report: { type: 'boolean' },
} });

const config = readMediaStoreConfig(process.env);
if (config.mode !== 's3') {
  console.error('[migrate-media] 需要 MEDIA_STORE=s3 与 MEDIA_S3_ENDPOINT / MEDIA_S3_BUCKET / MEDIA_S3_ACCESS_KEY_ID / MEDIA_S3_SECRET_ACCESS_KEY');
  process.exit(1);
}
const roots = values.only ? ROOTS.filter(root => root === values.only) : [...ROOTS];
if (!roots.length) {
  console.error(`[migrate-media] --only 只接受 ${ROOTS.join(' | ')}`);
  process.exit(1);
}

const dataRoot = path.resolve(values.root ?? DEFAULT_ROOT);
if (path.basename(dataRoot) !== 'data') {
  console.error(`[migrate-media] 只接受以 data 结尾的目录（--root 或仓库默认 data/），收到：${dataRoot}`);
  process.exit(1);
}

const store: MediaStore = createS3MediaStore(config.s3);
const uploaded: string[] = [], skipped: string[] = [], failed: { key: string; error: string }[] = [];
const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
/** 只用于「占免费额度多少」这句提示；R2 的额度会变，具体以官方页面为准。 */
const FREE_TIER_BYTES = 10 * 1024 ** 3;

// 体积报告（方案1：先量化增长，不清理）：按 media/xhs 这类二级前缀分组，不读本地文件、不做差异比对。
if (values.report) {
  const rows: { prefix: string; count: number; bytes: number }[] = [];
  for (const root of roots) {
    let objects: MediaObject[];
    try { objects = await store.list(root); }
    catch (error) {
      console.error(`[migrate-media] 列出桶内 ${root} 失败：${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    const groups = new Map<string, { count: number; bytes: number }>();
    for (const object of objects) {
      const prefix = object.key.split('/').slice(0, 2).join('/');
      const row = groups.get(prefix) ?? { count: 0, bytes: 0 };
      row.count += 1;
      row.bytes += object.size;
      groups.set(prefix, row);
    }
    for (const [prefix, row] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes)) rows.push({ prefix, ...row });
  }
  const total = rows.reduce((sum, row) => ({ count: sum.count + row.count, bytes: sum.bytes + row.bytes }), { count: 0, bytes: 0 });
  console.log(`[migrate-media] ${config.s3.bucket} 桶内体积（按前缀）`);
  for (const row of rows) console.log(`  ${row.prefix.padEnd(26)} ${String(row.count).padStart(6)} 个  ${mb(row.bytes).padStart(10)}`);
  console.log(`  ${'合计'.padEnd(25)} ${String(total.count).padStart(6)} 个  ${mb(total.bytes).padStart(10)}  ≈ R2 免费额度的 ${(total.bytes / FREE_TIER_BYTES * 100).toFixed(2)}%`);
} else for (const root of roots) {
  const local: LocalObject[] = [];
  try { await walk(path.join(dataRoot, root), `${root}/`, local); }
  catch { console.error(`[migrate-media] 本地目录不存在，跳过：${path.join(dataRoot, root)}`); continue; }

  // 一次 list 拿到桶内现状，避免逐个 HEAD（已是 8000+ 对象）
  let remote: Map<string, MediaObject>;
  try { remote = new Map((await store.list(root)).map(object => [object.key, object])); }
  catch (error) {
    console.error(`[migrate-media] 列出桶内 ${root} 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const file = (key: string) => path.join(dataRoot, ...key.split('/'));
  // 判据：桶里没有 → 上传；有 ETag（内容 md5）→ 比内容，索引类 JSON 会被就地改写、长度可能不变；
  // 没 ETag 才退化为比字节数（本地实现或分片上传）。
  const differs = async (object: LocalObject): Promise<boolean> => {
    const existing = remote.get(object.key);
    if (!existing) return true;
    if (existing.etag) return existing.etag !== createHash('md5').update(await readFile(file(object.key))).digest('hex');
    return existing.size !== object.size;
  };
  const results = await pool(local, 8, differs);
  const changed: LocalObject[] = [];
  for (const [index, object] of local.entries()) {
    if (results[index]) changed.push(object);
    else skipped.push(object.key);
  }
  const orphans = [...remote.keys()].filter(key => !local.some(object => object.key === key));

  console.log(`[migrate-media] ${root}: 本地 ${local.length}，桶内 ${remote.size}，待上传 ${changed.length}，桶内多出 ${orphans.length}`);
  if (orphans.length) console.log(`[migrate-media] ${root} 桶内多出（不删除，人工确认）：${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ' …' : ''}`);
  if (!values.apply) continue;

  await pool(changed, CONCURRENCY, async object => {
    try {
      await store.put(object.key, await readFile(file(object.key)), uploadOptions(object.key));
      uploaded.push(object.key);
    } catch (error) {
      failed.push({ key: object.key, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (!values.report) console.log(JSON.stringify({
  mode: values.apply ? 'apply' : 'dry-run(加 --apply 才写入)', root: dataRoot,
  endpoint: config.s3.endpoint, bucket: config.s3.bucket,
  已跳过: skipped.length, 已上传: uploaded.length, 失败: failed.length,
  ...(failed.length ? { 失败明细: failed.slice(0, 10) } : {}),
}, null, 2));
// 不用 process.exit()：Windows 上会在 undici keep-alive 连接还挂着时触发 libuv 断言。
process.exitCode = failed.length ? 1 : 0;
