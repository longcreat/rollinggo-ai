// 数据新鲜度检查（09-27）：对比 import/ 里每城最新导出 与 库内 data_import 记录。
//
// 上游是离线批处理，重跑挖掘后不会通知消费端 —— 这个脚本回答「现在该不该重导」。
// 只读，不进生成热路径（终端用户不该看到运维告警）。
//
// 用法：
//   tsx apps/server/scripts/check-data-freshness.ts
// 退出码：存在待导入项 → 1；全部一致 → 0（可直接进 CI / 一键脚本）。
import pg from 'pg';
import { env } from '../src/env';
import { IMPORT_DIR, latestExports, scanExports, type ExportSource } from './lib/exportFiles';

interface ImportRow {
  source: string;
  city: string;
  content_hash: string;
  file_path: string;
  row_count: number;
  imported_at: Date;
}

const SEP = '\u0000';

async function main(): Promise<void> {
  const exports = latestExports(scanExports(IMPORT_DIR));
  if (!exports.length) {
    console.error(`[freshness] ${IMPORT_DIR} 下没有可识别的导出（xhs-places*.json / xhs-place-relations-*.json）`);
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: env.databaseUrl });
  const { runMigrations } = await import('../src/db/migrate');
  await runMigrations(pool);
  const { rows } = await pool.query<ImportRow>(
    `SELECT source, city, content_hash, file_path, row_count, imported_at FROM data_import`,
  );
  await pool.end();

  const importedByKey = new Map(rows.map((row) => [`${row.source}${SEP}${row.city}`, row]));
  const exportByKey = new Map(exports.map((item) => [`${item.source}${SEP}${item.city}`, item]));
  const keys = [...new Set([...exportByKey.keys(), ...importedByKey.keys()])].sort();

  console.log(`=== 数据新鲜度（磁盘 ${IMPORT_DIR}）===`);
  let pending = 0;
  for (const key of keys) {
    const [source, city] = key.split(SEP) as [ExportSource, string];
    const disk = exportByKey.get(key);
    const db = importedByKey.get(key);

    let status: string;
    if (disk && db && disk.contentHash === db.content_hash) {
      status = '一致';
    } else if (disk && db) {
      status = '有待导入的新版本';
      pending += 1;
    } else if (disk) {
      status = '从未导入';
      pending += 1;
    } else {
      // 库里有记录、磁盘上找不到对应导出：文件被清掉或改了名，不阻断
      status = '库内有记录但磁盘无文件';
    }

    const diskSide = disk ? `${disk.generatedAt} / ${disk.rowCount} 行 / ${disk.contentHash.slice(0, 8)}` : '—';
    const dbSide = db
      ? `${db.imported_at.toISOString().slice(0, 10)} / ${db.row_count} 行 / ${db.content_hash.slice(0, 8)}`
      : '—';
    console.log(`  ${source}｜${city}｜磁盘 ${diskSide}｜库 ${dbSide}｜${status}`);
  }

  if (pending) {
    console.log(
      `\n[freshness] ${pending} 项待导入。\n` +
        '  cd apps/server && npx tsx scripts/seed-xhs-places.ts && npx tsx scripts/seed-xhs-relations.ts',
    );
    process.exitCode = 1;
  } else {
    console.log('\n[freshness] 全部与磁盘最新导出一致。');
  }
}

main().catch((err) => {
  console.error('[freshness] 失败：', err);
  process.exit(1);
});
