// POI 关联对导入：import/xhs-place-relations-*.json → place_relation
// 数据由 xhs-travel-pipeline 生成：python scripts/mine_place_relations.py --city <城市> --export
//
// 用法：
//   tsx apps/server/scripts/seed-xhs-relations.ts                   # 扫 import/，每城取最新的一份
//   tsx apps/server/scripts/seed-xhs-relations.ts <path.json> ...   # 只导指定文件
//
// 幂等：按 (city, from_name, to_name) UPSERT，重复执行结果一致；
// 每份导出写一行 data_import 记录，供 check-data-freshness.ts 对比「磁盘最新版 vs 已导入版」。
// 过滤：只收 strength='direct'（≥2 篇笔记支持）—— weak 是单篇支持，可能只是排版里排了一个箭头。
// 上游契约（无向关联对）：同一对只有一行，不表达先后；顺序由消费端按坐标决定。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../src/env';
import { createPlaceIdentityIndex, isScopedPlace, type IdentityPlace } from '../src/lib/placeIdentity';
import { captureIdentityImport, recordIdentityImport } from '../src/services/placeIdentityAudit';
import { importRelationSnapshot } from '../src/services/placeRelationSnapshot';
import { IMPORT_DIR, latestExports, readExport, scanExports, type ExportFile } from './lib/exportFiles';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 只收强证据（上游：≥2 篇笔记支持） */
const STRENGTH = 'direct';
const IMPORT_SOURCE = 'xhs_relations';

interface RelationItem {
  from: string;
  to: string;
  strength?: string;
  noteCount?: number;
}

interface RelationsFile {
  city: string;
  relationIdentity?: unknown;
  relations?: RelationItem[];
}

/** 与 schema 注释同算法：sha256(city|from|to)[:32]，from/to 已按字典序规范化 */
function relationId(city: string, from: string, to: string): string {
  return createHash('sha256').update(`${city}|${from}|${to}`).digest('hex').slice(0, 32);
}

/** 解析本次要导入的导出文件：显式路径优先，否则扫 import/ 按 city 取最新 */
function resolveTargets(): ExportFile[] {
  const explicit = process.argv.slice(2).filter((arg) => arg.endsWith('.json'));
  if (explicit.length) {
    return explicit.map((arg) => {
      const abs = path.resolve(arg);
      if (!fs.existsSync(abs)) {
        console.error(`[xhs-relations] 输入文件不存在：${abs}`);
        process.exit(1);
      }
      const found = readExport(abs);
      if (!found || found.source !== IMPORT_SOURCE) {
        console.error(`[xhs-relations] 不是可识别的关联对导出：${abs}\n  文件名需匹配 xhs-place-relations-*.json`);
        process.exit(1);
      }
      return found;
    });
  }
  const targets = latestExports(scanExports(IMPORT_DIR).filter((item) => item.source === IMPORT_SOURCE));
  if (!targets.length) {
    console.error(
      `[xhs-relations] ${IMPORT_DIR} 下没有可导入的 xhs-place-relations-*.json\n` +
        '  先在上游运行：python scripts/mine_place_relations.py --city <城市> --export',
    );
    process.exit(1);
  }
  return targets;
}

async function main(): Promise<void> {
  const targets = resolveTargets();
  console.log(
    `[xhs-relations] 待导入 ${targets.length} 份导出：${targets.map((t) => `${t.city}(${t.generatedAt})`).join('、')}`,
  );

  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  const { runMigrations } = await import('../src/db/migrate');
  await runMigrations(pool);
  const client = await pool.connect();

  const now = new Date().toISOString();
  let inserted = 0;
  let filtered = 0;
  try {
    await client.query('BEGIN');
    for (const target of targets) {
      const file = JSON.parse(fs.readFileSync(target.filePath, 'utf8')) as RelationsFile;
      if (!Array.isArray(file.relations)) throw new Error(`关联对导出缺少完整 relations 列表：${target.city}`);
      const all = file.relations ?? [];
      const before = await captureIdentityImport(client, target.city);
      const bound = await importRelationSnapshot(client, target.city, file.relationIdentity, all);
      if (bound !== null) {
        await client.query('DELETE FROM place_relation WHERE city=$1', [target.city]);
        await client.query(`INSERT INTO data_import (source,city,content_hash,file_path,row_count,imported_at)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source,city) DO UPDATE SET
          content_hash=EXCLUDED.content_hash,file_path=EXCLUDED.file_path,row_count=EXCLUDED.row_count,imported_at=EXCLUDED.imported_at`,
        [IMPORT_SOURCE, target.city, target.contentHash, path.basename(target.filePath), bound.length, now]);
        const auditId = await recordIdentityImport(client, target.city, target.contentHash, before);
        inserted += bound.length;
        filtered += all.length - bound.length;
        console.log(`[xhs-relations] ${target.city}：完整身份快照 ${all.length} 条，当前可用 ${bound.length} 条，审计 ${auditId}`);
        continue;
      }
      const directory = await client.query<IdentityPlace>(`SELECT id,city,name,payload FROM canonical_places
        WHERE city=$1 AND (verified=TRUE OR payload ? 'identityWithdrawal')`, [target.city]);
      const catalog = createPlaceIdentityIndex(directory.rows);
      const existing = await client.query<{ id: string; from_name: string; to_name: string }>(
        'SELECT id,from_name,to_name FROM place_relation WHERE city=$1', [target.city]);
      const stale = existing.rows.filter(row => catalog.isScopedReference(target.city, row.from_name)
        || catalog.isScopedReference(target.city, row.to_name));
      if (stale.length) await client.query('DELETE FROM place_relation WHERE city=$1 AND id=ANY($2::text[])',
        [target.city, stale.map(row => row.id)]);
      // 只收 direct，且两端都非空、不同名（自环无意义）。两端按字典序规范化后再写：
      // 上游已保证 from < to，但不依赖它 —— 顺序变了也必须幂等。
      const rows = all
        .filter((r) => r.strength === STRENGTH && r.from?.trim() && r.to?.trim() && r.from !== r.to)
        .filter(r => [r.from, r.to].every(name => {
          const resolved = catalog.resolve(target.city, name);
          return resolved.status === 'resolved' && !isScopedPlace(resolved.place);
        }))
        .map((r) => {
          const [from, to] = [r.from.trim(), r.to.trim()].sort();
          return [relationId(target.city, from!, to!), target.city, from!, to!, STRENGTH, r.noteCount ?? 0, now] as const;
        });
      filtered += all.length - rows.length;
      const res = await client.query(
        `INSERT INTO place_relation (id, city, from_name, to_name, strength, note_count, created_at)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::timestamptz[])
         ON CONFLICT (city, from_name, to_name) DO UPDATE SET
           strength = EXCLUDED.strength,
           note_count = EXCLUDED.note_count`,
        [0, 1, 2, 3, 4, 5, 6].map((i) => rows.map((r) => r[i])),
      );
      inserted += res.rowCount ?? 0;
      console.log(
        `[xhs-relations] ${target.city}：写入 ${res.rowCount ?? 0} 条（源 ${all.length} 条，过滤 weak/无效 ${all.length - rows.length} 条）`,
      );

      await client.query(
        `INSERT INTO data_import (source, city, content_hash, file_path, row_count, imported_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source, city) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           file_path = EXCLUDED.file_path,
           row_count = EXCLUDED.row_count,
           imported_at = EXCLUDED.imported_at`,
        [IMPORT_SOURCE, target.city, target.contentHash, path.basename(target.filePath), rows.length, now],
      );
      const auditId = await recordIdentityImport(client, target.city, target.contentHash, before);
      console.log(`[xhs-relations] ${target.city}：清理受控旧关系 ${stale.length} 条，审计 ${auditId}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const stats = await pool.query(
    `SELECT city, count(*)::int AS n FROM place_relation GROUP BY city ORDER BY n DESC`,
  );
  console.log(`[xhs-relations] 完成：写入/更新 ${inserted} 条，过滤 ${filtered} 条`);
  console.log(`  分布: ${stats.rows.map((r) => `${r.city}=${r.n}`).join(' | ') || '（空）'}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[xhs-relations] 失败：', err);
  process.exit(1);
});
