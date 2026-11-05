// 小红书社区地点库导入：import/xhs-places*.json → canonical_places + research_evidence
// 数据由 xhs-travel-pipeline 生成：python scripts/export_to_tripweaver.py
//
// 用法：
//   tsx apps/server/scripts/seed-xhs-places.ts                     # 扫 import/，每城取最新的一份导出
//   tsx apps/server/scripts/seed-xhs-places.ts <path.json> [...]   # 只导指定文件（上游一键脚本走这条）
//   tsx apps/server/scripts/seed-xhs-places.ts --purge             # 先清 source='xhs' 的地点与语料再导
//
// 为什么默认按目录扫而不是写死文件名（09-27）：import/ 里同一城市累积了多份导出，命名还不统一
// （xhs-places.json / xhs-places-beijing.json / xhs-places-北京.json 分别是三个日期的北京）。
// 写死默认值会在上游重跑后静默导入过期版本 —— 实测踩到过，故宫的社区分数因此停在 17.33（应 137.64）。
//
// 幂等性：
//   地点按主键 UPSERT（id 与金集同算法 sha256(city+name)[:32]，重复执行结果一致）
//   语料先按 place_id 删除旧 xhs_* 记录再插入（避免重复累积）
//   每份导出写一行 data_import 记录（content_hash 标识「库里是哪一版」，供 check-data-freshness.ts 对比）
//
// 性能：逐条 INSERT 在远程库（Neon）上是 5000+ 次往返，耗时数十分钟。
//   这里改为按批 UNNEST 批量写入（每批 200 个地点），往返数降到十几条。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { captureIdentityImport, recordIdentityImport } from '../src/services/placeIdentityAudit';
import { env } from '../src/env';
import { prepareImportedPlaces, reconcileImportedPlaces } from '../src/services/placeImportIdentity';
import { acceptRelationSource } from '../src/services/placeRelationSnapshot';
import { evidenceStrength } from '../src/services/evidenceStrength';
import { IMPORT_DIR, latestExports, readExport, scanExports, type ExportFile } from './lib/exportFiles';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = 'xhs';
/** data_import.source：区分地点库与关联对两种导出 */
const IMPORT_SOURCE = 'xhs_places';

interface EvidenceItem {
  kind: string;
  content: string;
  sourceUrl?: string;
  /** 上游可选覆盖；缺省由 evidenceStrength 按 kind 与是否有来源决定 */
  strength?: string;
}

interface XhsPlaceInput {
  id: string;
  name: string;
  category: string;
  lng: number;
  lat: number;
  source?: string;
  verified?: boolean;
  payload?: Record<string, unknown>;
  evidence?: EvidenceItem[];
}

interface XhsPlacesFile {
  relationIdentity?: unknown;
  city: string;
  generatedAt: string;
  count: number;
  places: XhsPlaceInput[];
}

/** 每批地点数（每批 = 1 次地点 upsert + 1 次语料清理 + N 次语料插入） */
const BATCH_SIZE = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 语料确定性主键：同一条内容重复导入不产生新行 */
function evidenceId(placeId: string, item: EvidenceItem): string {
  return createHash('sha256').update(`${placeId}|${item.kind}|${item.content}`).digest('hex').slice(0, 32);
}

/**
 * 解析本次要导入的导出文件。
 * 显式路径优先（上游 export_and_embed.ps1 传 `xhs-places-<城市>.json`）；
 * 不带参数时扫 import/ 并按 city 取最新的一份 —— 旧的同城文件留在磁盘上做历史，不参与导入。
 */
function resolveTargets(): ExportFile[] {
  const explicit = process.argv.slice(2).filter((arg) => arg.endsWith('.json'));
  if (explicit.length) {
    return explicit.map((arg) => {
      const abs = path.resolve(arg);
      if (!fs.existsSync(abs)) {
        console.error(`[xhs-seed] 输入文件不存在：${abs}`);
        process.exit(1);
      }
      const found = readExport(abs);
      if (!found || found.source !== IMPORT_SOURCE) {
        console.error(`[xhs-seed] 不是可识别的地点库导出：${abs}\n  文件名需匹配 xhs-places*.json`);
        process.exit(1);
      }
      return found;
    });
  }
  const targets = latestExports(scanExports(IMPORT_DIR).filter((item) => item.source === IMPORT_SOURCE));
  if (!targets.length) {
    console.error(
      `[xhs-seed] ${IMPORT_DIR} 下没有可导入的 xhs-places*.json\n  先在上游运行：python scripts/export_to_tripweaver.py`,
    );
    process.exit(1);
  }
  return targets;
}

/**
 * 导入单份导出（地点 upsert + 语料重建 + data_import 记录）。调用方负责事务边界。
 */
async function importFile(
  client: pg.PoolClient,
  target: ExportFile,
  now: string,
): Promise<{ upserted: number; evidenceInserted: number; evidencePlanned: number }> {
  const file = JSON.parse(fs.readFileSync(target.filePath, 'utf8')) as XhsPlacesFile;
  const identityBefore = file.relationIdentity !== undefined || file.places?.some(p =>
    (p.payload?.identity as Record<string, unknown> | undefined)?.version === 2)
    ? await captureIdentityImport(client, target.city) : undefined;
  await acceptRelationSource(client, target.city, file.relationIdentity, (file.places ?? []).map(p => ({
    id: p.id, name: p.name, city: target.city, payload: p.payload ?? null, verified: p.verified,
  })));
  const places = await prepareImportedPlaces(client, target.city, (file.places ?? []).filter((p) => p.id && p.name));
  if (!places.length && file.places?.length && file.relationIdentity === undefined) return { upserted: 0, evidenceInserted: 0, evidencePlanned: 0 };
  console.log(
    `[xhs-seed] 导入 ${path.basename(target.filePath)}｜城市 ${target.city}｜${places.length} 个地点｜生成于 ${target.generatedAt}`,
  );

  let upserted = 0;
  let evidenceInserted = 0;
  let evidencePlanned = 0;
  let processed = 0;

  for (const batch of chunk(places, BATCH_SIZE)) {
    // 地点 UPSERT：重复执行结果一致。
    //
    // 金集优先（09-22 修正）：现行为金集时**保留它的身份字段**（name/category/坐标/source/verified），
    // 但把社区侧 payload 合并进来。原来是 `WHERE source = EXCLUDED.source` 直接跳过整行 ——
    // 后果是金集行的 payload 永远停在 {caseId, activity}，拿不到 recommendScore/mentionCount，
    // 而那些行恰好就是故宫/天坛/北海这类地标：编排里 score=0 → 排到链尾、段最后、
    // 容量紧张时被优先丢弃，排序被彻底反转。
    //
    // 合并顺序 `EXCLUDED.payload || 现行 payload` 让金集的键胜出（金集优先）；
    // 金集已有分数且不低于本次导入时保留金集的（同一地点两份分数取高者）。
    //
    // **末尾 CASE 的 ELSE 必须显式写回新值**（09-27 修）：`EXCLUDED.payload || 现行 payload`
    // 里 jsonb 的 `||` 是右侧胜出，所以 recommendScore / mentionCount 已被现行值覆盖：
    // 旧写法 ELSE '{}' 以为「新值会自动胜出」，实际上这两个字段永远停在首次导入的那一版。
    // 实测后果：故宫博物院 金集行的分数卡在 17.33（上游已是 137.64），排程把它挤到第 11 位而落选。
    // 注意：这个 bug 只影响 source='goldset' 的行（社区行走上面的分支，没有这层覆盖）。
    const res = await client.query(
      `INSERT INTO canonical_places (id, city, name, category, lng, lat, source, verified, payload, created_at)
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::float8[], $6::float8[],
         $7::text[], $8::boolean[], $9::jsonb[], $10::timestamptz[]
       )
       ON CONFLICT (id) DO UPDATE SET
         city = canonical_places.city,
         name = canonical_places.name,
         category = canonical_places.category,
         lng = canonical_places.lng,
         lat = canonical_places.lat,
         source = canonical_places.source,
         verified = canonical_places.verified,
         payload = CASE
           WHEN canonical_places.source = EXCLUDED.source THEN
             EXCLUDED.payload
             -- 图片由独立导入/回写维护，重导地点不能把已知封面清掉。
             || jsonb_strip_nulls(jsonb_build_object(
                  'coverImage', canonical_places.payload->'coverImage',
                  'imageGallery', canonical_places.payload->'imageGallery',
                  'amapPhoto', canonical_places.payload->'amapPhoto'))
             || jsonb_strip_nulls(jsonb_build_object('embeddedText', canonical_places.payload->'embeddedText'))
             -- 同为金集：两份都可能有分数，取高者（不因重导回退旧值）
             || CASE
                  WHEN coalesce((canonical_places.payload->>'recommendScore')::float8, 0)
                     >= coalesce((EXCLUDED.payload->>'recommendScore')::float8, 0)
                  THEN jsonb_build_object(
                         'recommendScore', canonical_places.payload->'recommendScore',
                         'mentionCount', canonical_places.payload->'mentionCount')
                  ELSE '{}'::jsonb
                END
           ELSE
             -- prepareImportedPlaces 已验证旧组合子项可以独立导入；金集也须解除旧重定向。
             EXCLUDED.payload || (coalesce(canonical_places.payload, '{}'::jsonb) - 'canonicalRedirectTo')
             || CASE
                  WHEN coalesce((canonical_places.payload->>'recommendScore')::float8, 0)
                     >= coalesce((EXCLUDED.payload->>'recommendScore')::float8, 0)
                  THEN jsonb_build_object(
                         'recommendScore', canonical_places.payload->'recommendScore',
                         'mentionCount', canonical_places.payload->'mentionCount')
                  -- 本次导入更高：显式胜出，不能依赖上面的 jsonb 合并顺序（右侧覆盖会让现行值赢）
                  ELSE jsonb_build_object(
                         'recommendScore', EXCLUDED.payload->'recommendScore',
                         'mentionCount', EXCLUDED.payload->'mentionCount')
                END
         END
       WHERE canonical_places.source = EXCLUDED.source
          OR canonical_places.source = 'goldset'`,
      [
        batch.map((p) => p.id),
        batch.map(() => target.city),
        batch.map((p) => p.name),
        batch.map((p) => p.category ?? ''),
        batch.map((p) => p.lng),
        batch.map((p) => p.lat),
        batch.map(() => SOURCE),
        batch.map((p) => p.verified ?? true),
        batch.map((p) => JSON.stringify(p.payload ?? {})),
        batch.map(() => now),
      ],
    );
    upserted += res.rowCount ?? 0;

    // 先清该批地点的旧语料（重建式，避免累积）
    await client.query(`DELETE FROM research_evidence WHERE place_id = ANY($1::text[]) AND kind LIKE 'xhs\\_%'`, [
      batch.map((p) => p.id),
    ]);

    const evRows: string[][] = [];
    for (const place of batch) {
      if (place.payload?.identityWithdrawal !== undefined) continue;
      for (const item of place.evidence ?? []) {
        if (!item.content) continue;
        evRows.push([
          evidenceId(place.id, item),
          place.id,
          target.city,
          item.kind,
          evidenceStrength(item),
          item.content,
          item.sourceUrl ?? '',
          now,
        ]);
      }
    }
    evidencePlanned += evRows.length;
    for (const evBatch of chunk(evRows, BATCH_SIZE * 8)) {
      const evRes = await client.query(
        `INSERT INTO research_evidence (id, place_id, city, kind, strength, content, source_url, fetched_at)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::timestamptz[])
         ON CONFLICT (id) DO NOTHING`,
        [0, 1, 2, 3, 4, 5, 6, 7].map((i) => evBatch.map((r) => r[i])),
      );
      evidenceInserted += evRes.rowCount ?? 0;
    }

    processed += batch.length;
    console.log(`[xhs-seed]   ${target.city} 进度 ${processed}/${places.length}`);
  }

  const redirected = await reconcileImportedPlaces(client, target.city, places);
  console.log(`[xhs-seed]   归一旧记录重定向 ${redirected} 条（保留原始数据）`);

  // 导入记录：与业务写入同事务，保证「记录说导了哪一版」和「库里真的是那一版」一致
  await client.query(
    `INSERT INTO data_import (source, city, content_hash, file_path, row_count, imported_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (source, city) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       file_path = EXCLUDED.file_path,
       row_count = EXCLUDED.row_count,
       imported_at = EXCLUDED.imported_at`,
    [IMPORT_SOURCE, target.city, target.contentHash, path.basename(target.filePath), places.length, now],
  );

  if (identityBefore) {
    const auditId = await recordIdentityImport(client, target.city, target.contentHash, identityBefore);
    console.log(`[xhs-seed]   实体导入审计 ${auditId}（保留原行、图片、语料及向量快照）`);
  }
  return { upserted, evidenceInserted, evidencePlanned };
}

async function main(): Promise<void> {
  const purged = process.argv.includes('--purge');
  const targets = resolveTargets();
  console.log(
    `[xhs-seed] 待导入 ${targets.length} 份导出：${targets.map((t) => `${t.city}(${t.generatedAt})`).join('、')}`,
  );

  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  const { runMigrations } = await import('../src/db/migrate');
  await runMigrations(pool);
  const client = await pool.connect();

  const now = new Date().toISOString();
  let upserted = 0;
  let evidenceInserted = 0;
  let evidencePlanned = 0;
  try {
    await client.query('BEGIN');

    if (purged) {
      const governed = await client.query(`SELECT 1 FROM canonical_places
        WHERE source='xhs' AND payload->'identity'->>'version'='2' LIMIT 1`);
      if (governed.rows.length) throw new Error('已有稳定身份，不能通过 --purge 绕过治理；请使用有审计的身份回滚');
      const del = await client.query(`DELETE FROM canonical_places WHERE source = $1`, [SOURCE]);
      console.log(`[xhs-seed] --purge 清除旧地点 ${del.rowCount ?? 0} 条（语料随之由外键逻辑手动清）`);
      await client.query(
        `DELETE FROM research_evidence WHERE place_id NOT IN (SELECT id FROM canonical_places)`,
      );
    }

    for (const target of targets) {
      const result = await importFile(client, target, now);
      upserted += result.upserted;
      evidenceInserted += result.evidenceInserted;
      evidencePlanned += result.evidencePlanned;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const stats = await pool.query(
    `SELECT source, count(*)::int AS n FROM canonical_places GROUP BY source ORDER BY n DESC`,
  );
  const ev = await pool.query(`SELECT count(*)::int AS n FROM research_evidence`);
  console.log(
    `[xhs-seed] 完成：地点 upsert ${upserted} | 语料新增 ${evidenceInserted}（已存在跳过 ${evidencePlanned - evidenceInserted}）`,
  );
  console.log(`  canonical_places 分布: ${stats.rows.map((r) => `${r.source}=${r.n}`).join(' | ')}`);
  console.log(`  research_evidence 总数: ${ev.rows[0]?.n ?? 0}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[xhs-seed] 失败：', err);
  process.exit(1);
});
