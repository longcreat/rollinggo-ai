// 把一个景区/片区展开成可编排的细分点位（高德周边检索 → 校验 → 入库）。
//
// 用法（必须经 doppler 注入 AMAP_KEY / DATABASE_URL）：
//   doppler run -- node --import tsx apps/server/scripts/import-geofences.ts --city 杭州 --area 西湖 --radius 4000
//   ... --pages 4 --keywords 景点 --dry-run
//
// 只写 source='amap-area' 的行；已有金集/社区行不会被覆盖。
// 入库后记得跑 embed-backfill（同 seed-xhs-places 的约定）。
import { pool } from '../src/db/client';
import { env } from '../src/env';
import { searchAreaPois } from '../src/integrations/amap/placeArea';
import { buildSubPoiRows, type SubPoiRow } from '../src/services/geofenceImport';
import type { SourcedPoi } from '../src/integrations/geoContracts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const city = arg('city');
const area = arg('area');
const radiusM = Number(arg('radius') ?? 4000);
const pages = Math.max(1, Math.min(8, Number(arg('pages') ?? 3)));
const keywords = arg('keywords');
const dryRun = process.argv.includes('--dry-run');
if (!city || !area) {
  console.error('缺少参数：--city <城市> --area <片区名> [--radius 4000] [--pages 3] [--keywords 景点] [--dry-run]');
  process.exit(2);
}
if (!env.amapKey) {
  console.error('AMAP_KEY 未配置（用 doppler run 启动）');
  process.exit(2);
}
if (!Number.isFinite(radiusM) || radiusM < 200 || radiusM > 20_000) {
  console.error('--radius 需在 200–20000 米之间');
  process.exit(2);
}

const parentResult = await pool.query<{ id: string; name: string; lat: number | null; lng: number | null }>(
  `select id, name, coalesce(center_lat, lat) as lat, coalesce(center_lng, lng) as lng
   from canonical_places where city = $1 and name = $2
   order by verified desc, created_at asc limit 1`, [city, area]);
const parent = parentResult.rows[0];
if (!parent || parent.lat == null || parent.lng == null) {
  console.error(`找不到片区「${city}/${area}」或该行没有坐标；先把父点导入 canonical_places。`);
  process.exit(1);
}
console.log(`片区：${parent.name}（${parent.lat.toFixed(5)}, ${parent.lng.toFixed(5)}）半径 ${radiusM}m，最多 ${pages} 页`);

const existingResult = await pool.query<{ name: string; dedupe_key: string | null }>(
  'select name, dedupe_key from canonical_places where city = $1', [city]);
const existingNames = new Set(existingResult.rows.map((row) => row.name));
const existingCoordKeys = new Set(existingResult.rows.map((row) => row.dedupe_key).filter((key): key is string => Boolean(key)));

const collected: SourcedPoi[] = [];
for (let pageNum = 1; pageNum <= pages; pageNum += 1) {
  const pois = await searchAreaPois(env.amapKey, {
    city, center: { lat: parent.lat, lng: parent.lng }, radiusM, keywords, pageSize: 25, pageNum,
  }, AbortSignal.timeout(30_000));
  console.log(`  第 ${pageNum} 页：${pois.length} 条`);
  collected.push(...pois);
  if (pois.length < 25) break;
}

const { rows, report } = buildSubPoiRows({
  city, parentId: parent.id, parentCenter: { lat: parent.lat, lng: parent.lng },
  pois: collected, existingNames, existingCoordKeys,
});
console.log(`候选 ${collected.length} → 入库 ${rows.length}`);
console.log('拒绝原因：', Object.entries(report.rejected).filter(([, count]) => count > 0).map(([reason, count]) => `${reason}×${count}`).join('，') || '无');
if (report.samples.length) console.log('样例：', report.samples.map((item) => `${item.name}(${item.reason})`).join('，'));

if (dryRun) {
  console.log('dry-run：不写库。');
  await pool.end();
  process.exit(0);
}

const BATCH = 100;
for (let index = 0; index < rows.length; index += BATCH) await upsert(rows.slice(index, index + BATCH));
// 父点标记为面状围栏：半径与中心回填，检索时可按片区展开。
await pool.query(
  `update canonical_places
   set geom_kind = 'area', area_radius_m = $1, center_lat = $2, center_lng = $3,
       area_polygon = $4::jsonb
   where id = $5`,
  [Math.round(radiusM), parent.lat, parent.lng, JSON.stringify({ kind: 'circle', radiusM: Math.round(radiusM) }), parent.id],
);
console.log('完成。下一步：doppler run -- node --import tsx apps/server/scripts/embed-backfill.ts --tables places --city ' + city);
await pool.end();

async function upsert(batch: SubPoiRow[]) {
  const now = new Date();
  await pool.query(
    `insert into canonical_places (id, city, name, category, lng, lat, source, verified, payload, parent_id, geom_kind, dedupe_key, created_at)
     select * from unnest(
       $1::text[], $2::text[], $3::text[], $4::text[], $5::float8[], $6::float8[],
       $7::text[], $8::boolean[], $9::jsonb[], $10::text[], $11::text[], $12::text[], $13::timestamptz[]
     )
     on conflict (id) do update set
       payload = canonical_places.payload || excluded.payload,
       parent_id = excluded.parent_id,
       dedupe_key = excluded.dedupe_key
     where canonical_places.source = excluded.source`,
    [
      batch.map((row) => row.id),
      batch.map(() => city),
      batch.map((row) => row.name),
      batch.map((row) => row.category),
      batch.map((row) => row.lng),
      batch.map((row) => row.lat),
      batch.map((row) => row.source),
      batch.map((row) => row.verified),
      batch.map((row) => JSON.stringify(row.payload)),
      batch.map((row) => row.parentId),
      batch.map((row) => row.geomKind),
      batch.map((row) => row.dedupeKey),
      batch.map(() => now),
    ],
  );
}
