// 景点封面图导入：import/xhs-place-images-*.json → canonical_places.payload.coverImage
// 数据由 xhs-travel-pipeline 生成：python scripts/export_place_images.py
//
// 用法：
//   tsx apps/server/scripts/seed-xhs-place-images.ts                     # 扫 import/，每城取最新的一份
//   tsx apps/server/scripts/seed-xhs-place-images.ts <path.json> [...]    # 只导指定文件
//
// 依赖顺序：必须在 seed-xhs-places.ts 之后跑 —— 地点行还不存在时没有地方写 key。
//
// 图片文件本身不进库：导出的 webp 落在仓库 data/media/（已 gitignore），由 server 的 /media
// 静态路由托管，前缀可被 MEDIA_BASE_URL 覆盖（换对象存储只改环境变量）。这里只写相对 key。
//
// 幂等：payload 用 jsonb `||` 只覆盖 coverImage 一个键，不碰 recommendScore / mentionCount
// 等同批导出的键；重复执行结果一致。
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { env } from '../src/env';
import { IMPORT_DIR, latestExports, readExport, scanExports, type ExportFile } from './lib/exportFiles';
import { imageGroups } from '../src/lib/imageGallery';
import { resolveImageIdentities } from '../src/services/placeImageIdentity';
import type { IdentityPlace } from '../src/lib/placeIdentity';

const IMPORT_SOURCE = 'xhs_place_images';
const BATCH_SIZE = 200;
const LOG = '[xhs-cover]';

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 解析本次要导入的导出文件。
 * 显式路径优先（上游 export_and_embed.ps1 传 `xhs-place-images-<城市>.json`）；
 * 不带参数时扫 import/ 并按 city 取最新的一份。
 */
function resolveTargets(): ExportFile[] {
  const explicit = process.argv.slice(2).filter((arg) => arg.endsWith('.json'));
  if (explicit.length) {
    return explicit.map((arg) => {
      const abs = path.resolve(arg);
      if (!fs.existsSync(abs)) {
        console.error(`${LOG} 输入文件不存在：${abs}`);
        process.exit(1);
      }
      const found = readExport(abs);
      if (!found || found.source !== IMPORT_SOURCE) {
        console.error(`${LOG} 不是可识别的封面导出：${abs}\n  文件名需匹配 xhs-place-images*.json`);
        process.exit(1);
      }
      return found;
    });
  }
  const targets = latestExports(scanExports(IMPORT_DIR).filter((item) => item.source === IMPORT_SOURCE));
  if (!targets.length) {
    console.error(
      `${LOG} ${IMPORT_DIR} 下没有可导入的 xhs-place-images*.json\n  先在上游运行：python scripts/export_place_images.py`,
    );
    process.exit(1);
  }
  return targets;
}

/** 导入单份导出（写 coverImage + 记录 data_import）。调用方负责事务边界。 */
async function importFile(
  client: pg.PoolClient,
  target: ExportFile,
  now: string,
): Promise<{ updated: number; missing: number }> {
  const file: unknown = JSON.parse(fs.readFileSync(target.filePath, 'utf8'));
  if (!file || typeof file !== 'object' || !('images' in file) || !('city' in file) || file.city !== target.city) {
    throw new Error('图片清单城市或 images 字段无效');
  }
  // 上游按质量排序，同一地点保留第一张封面；多图导出不能让次选覆盖首选。
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`place-identity:${target.city}`]);
  const { rows } = await client.query<IdentityPlace>('SELECT id,city,name,payload FROM canonical_places WHERE city=$1', [target.city]);
  // 先校验逐图归属再取三张，旧图不能占掉已确认图片的名额。
  const groups = imageGroups(file.images, Number.MAX_SAFE_INTEGER);
  let unresolved = 0;
  const entries = [...resolveImageIdentities(target.city, groups, rows, () => { unresolved++; })]
    .map(([placeId, photos]) => ({ placeId, key: photos[0]!.key, photos }));
  console.log(
    `${LOG} 导入 ${path.basename(target.filePath)}｜城市 ${target.city}｜${entries.length} 张封面｜生成于 ${target.generatedAt}`,
  );

  let updated = 0;
  for (const batch of chunk(entries, BATCH_SIZE)) {
    const res = await client.query(
      `UPDATE canonical_places AS c
       SET payload = coalesce(c.payload, '{}'::jsonb) || jsonb_build_object('coverImage', u.key, 'imageGallery', u.gallery::jsonb)
       FROM UNNEST($1::text[], $2::text[], $3::text[]) AS u(id, key, gallery)
       WHERE c.id = u.id AND c.city = $4`,
      [batch.map((e) => e.placeId), batch.map((e) => e.key), batch.map((e) => JSON.stringify(e.photos)), target.city],
    );
    updated += res.rowCount ?? 0;
  }

  const missing = unresolved + entries.length - updated;
  if (missing > 0) {
    console.warn(`${LOG} ${target.city} 有 ${missing} 个图片地点无法绑定现行主体（未写 key）—— 检查地点导入、身份歧义或组成地点边界`);
  }

  await client.query(
    `INSERT INTO data_import (source, city, content_hash, file_path, row_count, imported_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source, city) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       file_path = EXCLUDED.file_path,
       row_count = EXCLUDED.row_count,
       imported_at = EXCLUDED.imported_at`,
    [IMPORT_SOURCE, target.city, target.contentHash, path.basename(target.filePath), entries.length, now],
  );

  return { updated, missing };
}

async function main(): Promise<void> {
  const targets = resolveTargets();
  console.log(`${LOG} 待导入 ${targets.length} 份导出：${targets.map((t) => `${t.city}(${t.generatedAt})`).join('、')}`);

  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  const { runMigrations } = await import('../src/db/migrate');
  await runMigrations(pool);
  const client = await pool.connect();

  const now = new Date().toISOString();
  let updated = 0;
  let missing = 0;
  try {
    await client.query('BEGIN');
    for (const target of targets) {
      const result = await importFile(client, target, now);
      updated += result.updated;
      missing += result.missing;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const covered = await pool.query(
    `SELECT count(*)::int AS n FROM canonical_places WHERE payload ? 'coverImage'`,
  );
  console.log(`${LOG} 完成：写入 ${updated} 个地点${missing ? `｜跳过 ${missing} 个未绑定主体` : ''}`);
  console.log(`  canonical_places 含 coverImage 的行数：${covered.rows[0]?.n ?? 0}`);
  console.log(`  图片目录：${path.resolve(IMPORT_DIR, '../data/media')}`);
  await pool.end();
}

main().catch((err) => {
  console.error(`${LOG} 失败：`, err);
  process.exit(1);
});
