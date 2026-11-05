// 只读图片链路审计：不导入 db/client（避免启动迁移），不请求外部 API。
// node --import tsx apps/server/scripts/audit-xhs-images.ts --city 杭州 --trip-id <id> --out <report.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import pg from 'pg';
import { normalizePlaceKey } from '../src/lib/placeKey';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { values } = parseArgs({ options: {
  city: { type: 'string', default: '杭州' }, 'trip-id': { type: 'string' },
  'pipeline-root': { type: 'string', default: path.resolve(root, '../xhs-travel-pipeline') },
  out: { type: 'string' },
} });
const city = values.city;
const pipelineRoot = path.resolve(values['pipeline-root']);
const upstreamEnv = parse(fs.readFileSync(path.join(pipelineRoot, '.env')));
const serverEnv = parse(fs.readFileSync(path.join(root, 'apps/server/.env')));
if (!upstreamEnv.DATABASE_URL || !serverEnv.DATABASE_URL) throw new Error('两个项目均需配置 DATABASE_URL');
const upstream = new pg.Client({ connectionString: upstreamEnv.DATABASE_URL.replace('postgresql+asyncpg:', 'postgresql:') });
const downstream = new pg.Client({ connectionString: serverEnv.DATABASE_URL });
const query = async (client: pg.Client, sql: string, params: unknown[] = [city]) => (await client.query(sql, params)).rows;

try {
  await upstream.connect();
  await downstream.connect();
  await upstream.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await downstream.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const notes = await query(upstream, `SELECT count(*)::int AS total,
    coalesce(sum(jsonb_array_length(coalesce(img_urls, '[]'::jsonb))),0)::int AS image_urls,
    count(*) FILTER(WHERE img_analysis_at IS NOT NULL)::int AS unified_processed,
    count(*) FILTER(WHERE img_analysis IS NOT NULL)::int AS text_analyzed FROM raw_note WHERE city=$1`);
  const mentionDistribution = await query(upstream, `WITH m AS (
    SELECT raw_note_id,count(DISTINCT normalized_name) n FROM place_mention GROUP BY raw_note_id)
    SELECT CASE WHEN m.n=1 THEN 'single' WHEN m.n>1 THEN 'multiple' ELSE 'none' END AS places_per_note,
    count(*)::int AS notes FROM raw_note r LEFT JOIN m ON m.raw_note_id=r.id WHERE r.city=$1 GROUP BY 1`);
  const places = await query(upstream, `SELECT count(*)::int AS total,
    count(*) FILTER(WHERE is_active)::int AS active,
    count(*) FILTER(WHERE geo_status='resolved')::int AS resolved,
    count(*) FILTER(WHERE is_active AND latitude IS NOT NULL AND quality_score>=0
      AND EXISTS(SELECT 1 FROM place_summary s WHERE s.canonical_place_id=c.id))::int AS exportable
    FROM canonical_place c WHERE city=$1`);
  const images = await query(upstream, `SELECT img_type,count(*)::int AS total,
    count(*) FILTER(WHERE canonical_place_id IS NOT NULL)::int AS linked,
    count(DISTINCT canonical_place_id)::int AS places FROM note_image WHERE city=$1 GROUP BY img_type ORDER BY total DESC`);
  const unlinked = await query(upstream, `WITH m AS (
    SELECT raw_note_id,count(DISTINCT normalized_name) n FROM place_mention GROUP BY raw_note_id)
    SELECT CASE WHEN m.n=1 THEN 'single_not_linked' WHEN m.n>1 THEN 'multiple' ELSE 'no_mentions' END AS reason,
    count(*)::int AS images FROM note_image i LEFT JOIN m ON m.raw_note_id=i.raw_note_id
    WHERE i.city=$1 AND i.img_type='scenery' AND i.canonical_place_id IS NULL GROUP BY 1`);
  const topPlaces = await query(upstream, `SELECT c.id,c.name,c.normalized_name,c.place_type,s.recommend_score,
    (SELECT count(*)::int FROM note_image i WHERE i.canonical_place_id=c.id AND i.img_type='scenery') AS linked_images,
    (SELECT count(DISTINCT i.id)::int FROM note_image i JOIN place_mention m ON m.raw_note_id=i.raw_note_id
      WHERE i.city=c.city AND m.normalized_name=c.normalized_name AND i.img_type='scenery'
      AND i.canonical_place_id IS NULL) AS unlinked_images_in_related_notes
    FROM canonical_place c JOIN place_summary s ON s.canonical_place_id=c.id
    WHERE c.city=$1 AND c.is_active AND c.latitude IS NOT NULL ORDER BY s.recommend_score DESC LIMIT 50`);
  const sourceFiles = await query(upstream, 'SELECT file_path FROM note_image WHERE city=$1');
  const dbPlaces = await query(downstream, 'SELECT id,name,source,payload FROM canonical_places WHERE city=$1');
  const imports = await query(downstream, 'SELECT source,row_count,file_path,imported_at FROM data_import WHERE city=$1');
  const manifestPath = path.join(root, `import/xhs-place-images-${city}.json`);
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { images: [] };
  const manifestEntries = ((manifest.images ?? []) as { placeId: string; placeName?: string; key: string }[])
    .map(({ placeId, placeName, key }) => ({ placeId, placeName, key }));
  const fileExists = (key: string) => fs.existsSync(path.join(root, 'data/media', key));
  const byKey = new Map<string, typeof dbPlaces>();
  for (const p of dbPlaces) {
    for (const name of [p.name, ...(Array.isArray(p.payload?.aliases) ? p.payload.aliases : [])]) {
      const key = normalizePlaceKey(name);
      byKey.set(key, [...(byKey.get(key) ?? []), p]);
    }
  }
  const localCover = (name: string) => {
    const hit = byKey.get(normalizePlaceKey(name))?.find(p => typeof p.payload?.coverImage === 'string');
    return hit ? { place: hit.name, key: hit.payload.coverImage, exists: fileExists(hit.payload.coverImage) } : null;
  };
  const tripRows = values['trip-id'] ? await query(downstream,
    'SELECT title,data FROM trips WHERE id=$1 AND destination=$2', [values['trip-id'], city]) : [];
  const overview = tripRows[0]?.data.overview as { name: string; coverUrl?: string }[] | undefined;
  const allCities = await query(upstream, `SELECT city,count(*) FILTER(WHERE img_type='scenery')::int AS scenery,
    count(*) FILTER(WHERE img_type='scenery' AND canonical_place_id IS NOT NULL)::int AS linked,
    count(DISTINCT canonical_place_id) FILTER(WHERE img_type='scenery')::int AS places
    FROM note_image GROUP BY city ORDER BY city`, []);
  const report = {
    generatedAt: new Date().toISOString(), city, readOnly: true, allCities,
    upstream: { notes, mentionDistribution, places, images, unlinked,
      missingSourceFiles: sourceFiles.filter(r => !fs.existsSync(path.join(pipelineRoot, r.file_path))).length,
      topPlaces: topPlaces.map(p => ({ ...p, downstreamCover: localCover(p.name) })) },
    downstream: { places: dbPlaces.length, withCover: dbPlaces.filter(p => p.payload?.coverImage).length,
      manifestEntries: manifestEntries.length, missingMediaFiles: manifestEntries.filter(e => !fileExists(e.key)),
      orphanManifestEntries: manifestEntries.filter(e => !dbPlaces.some(p => p.id === e.placeId)), imports },
    trip: overview ? { id: values['trip-id'], title: tripRows[0].title, candidates: overview.map(p => ({
      name: p.name, savedCover: p.coverUrl ?? null, availableLocalCover: localCover(p.name),
    })) } : null,
    caveat: '相关笔记中的未绑定图不是已确认属于该景点的图；各地点该计数可重叠。',
  };
  const output = JSON.stringify(report, null, 2);
  if (values.out) {
    fs.writeFileSync(path.resolve(values.out), output + '\n');
    console.log(`审计报告已写入 ${path.resolve(values.out)}`);
  } else console.log(output);
} finally {
  await Promise.allSettled([upstream.query('ROLLBACK'), downstream.query('ROLLBACK')]);
  await Promise.allSettled([upstream.end(), downstream.end()]);
}
