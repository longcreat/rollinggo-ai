import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { ROOT, hash } from './artifacts';
import { KNOWLEDGE_PAYLOAD_KEYS, validateFrozen, vectorColumns, type FrozenKnowledge, type FrozenData } from './frozenKnowledge';

export function sourceConfiguration(): { url: string; configuredModel: string | null } {
  const values: Record<string, string | undefined> = {};
  for (const file of [path.join(ROOT, '.env'), path.join(ROOT, 'apps/server/.env')]) {
    if (fs.existsSync(file)) Object.assign(values, parse(fs.readFileSync(file)));
  }
  Object.assign(values, process.env);
  const url = values.EVAL_SOURCE_DATABASE_URL || values.DATABASE_URL;
  if (!url) throw new Error('需要 EVAL_SOURCE_DATABASE_URL 或现有应用 DATABASE_URL（仅用于只读导出）');
  return { url, configuredModel: values.EMBEDDING_MODEL ?? 'cf/bge-m3' };
}

/** 单个只读一致性事务；不导入 app db/client，不迁移，不读取用户表。 */
export async function exportKnowledge(options: { url: string; name: string; cities?: string[]; includeVectors: boolean; configuredModel: string | null }): Promise<FrozenKnowledge> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.name)) throw new Error('副本名称仅支持 1–64 位小写字母、数字和短横线');
  const sourceUrl = new URL(options.url);
  if (!['postgres:', 'postgresql:'].includes(sourceUrl.protocol)) throw new Error('知识库源必须是 PostgreSQL');
  const client = new Client({ connectionString: options.url, options: '-c default_transaction_read_only=on',
    connectionTimeoutMillis: 8000, statement_timeout: 60000, application_name: 'tripweaver-eval-knowledge-export' });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const readOnly = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
    if (readOnly.rows[0]?.transaction_read_only !== 'on') throw new Error('知识库源连接未处于只读事务');
    const columns = await vectorColumns(client);
    const allCities = (await client.query<{ city: string }>('SELECT DISTINCT city FROM public.canonical_places ORDER BY city')).rows.map((r) => r.city);
    const cities = options.cities ? [...new Set(options.cities)].sort() : allCities.sort();
    if (!cities.length || cities.some((city) => !allCities.includes(city))) throw new Error('城市筛选包含源知识库中不存在的城市');
    const placeVector = options.includeVectors && columns.places !== null;
    const evidenceVector = options.includeVectors && columns.evidence !== null;
    const places = (await client.query<FrozenData['places'][number]>(`SELECT id,city,name,category,lat,lng,source,verified,
      (SELECT jsonb_object_agg(key,value) FROM jsonb_each(CASE WHEN jsonb_typeof(payload)='object' THEN payload ELSE '{}'::jsonb END)
        WHERE key=ANY($2::text[])) AS payload, created_at::text AS "createdAt", ${placeVector ? 'embedding::text' : 'NULL::text'} AS embedding
      FROM public.canonical_places WHERE city=ANY($1::text[]) ORDER BY id COLLATE "C"`, [cities, [...KNOWLEDGE_PAYLOAD_KEYS]])).rows;
    const evidence = (await client.query<FrozenData['evidence'][number]>(`SELECT e.id,e.place_id AS "placeId",e.city,e.kind,e.strength,
      e.content,e.source_url AS "sourceUrl",e.fetched_at::text AS "fetchedAt", ${evidenceVector ? 'e.embedding::text' : 'NULL::text'} AS embedding
      FROM public.research_evidence e WHERE (e.place_id IS NULL AND e.city=ANY($1::text[]))
        OR EXISTS (SELECT 1 FROM public.canonical_places p WHERE p.id=e.place_id AND p.city=ANY($1::text[]))
      ORDER BY e.id COLLATE "C"`, [cities])).rows;
    const relations = (await client.query<FrozenData['relations'][number]>(`SELECT id,city,from_name AS "fromName",to_name AS "toName",strength,
      note_count AS "noteCount",created_at::text AS "createdAt" FROM public.place_relation WHERE city=ANY($1::text[]) ORDER BY id COLLATE "C"`, [cities])).rows;
    await client.query('COMMIT');
    for (const p of places) p.createdAt = new Date(p.createdAt).toISOString();
    for (const e of evidence) e.fetchedAt = new Date(e.fetchedAt).toISOString();
    for (const r of relations) r.createdAt = new Date(r.createdAt).toISOString();
    const data: FrozenData = { version: 1, cities, places, evidence, relations,
      vectors: { included: options.includeVectors, configuredModel: options.configuredModel,
        placeDimensions: placeVector ? columns.places : null, evidenceDimensions: evidenceVector ? columns.evidence : null } };
    return validateFrozen({ format: 'tripweaver-knowledge', version: 1, name: options.name, exportedAt: new Date().toISOString(),
      sourceId: hash({ host: sourceUrl.hostname, port: sourceUrl.port || '5432', database: sourceUrl.pathname }), contentHash: hash(data), data });
  } finally { await client.end(); }
}
