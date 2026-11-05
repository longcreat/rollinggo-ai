import fs from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Pool, PoolClient } from 'pg';
import { EVAL_DIR, hash, writeJson } from './artifacts';

// 覆盖当前检索/排程消费字段；不复制原始笔记、作者资料、用户数据或图库资产。
export const KNOWLEDGE_PAYLOAD_KEYS = ['aliases', 'themes', 'recommendScore', 'mentionCount', 'typicalVisitMinutes',
  'xhsPlaceType', 'adcode', 'openHours', 'reservation', 'reservationNote', 'content', 'topReasons',
  'identity', 'components', 'canonicalRedirectTo', 'coordSystem', 'coordSource', 'openTime', 'description', 'cost'] as const;
const Text = Type.String();
const NullableText = Type.Union([Text, Type.Null()]);
const Coordinates = (limit: number) => Type.Union([Type.Number({ minimum: -limit, maximum: limit }), Type.Null()]);
const strict = { additionalProperties: false };
const DataSchema = Type.Object({
  version: Type.Literal(1), cities: Type.Array(Text),
  vectors: Type.Object({ included: Type.Boolean(), configuredModel: NullableText,
    placeDimensions: Type.Union([Type.Integer({ minimum: 1, maximum: 16000 }), Type.Null()]),
    evidenceDimensions: Type.Union([Type.Integer({ minimum: 1, maximum: 16000 }), Type.Null()]),
  }, strict),
  places: Type.Array(Type.Object({ id: Text, city: Text, name: Text, category: Text, lat: Coordinates(90), lng: Coordinates(180),
    source: Text, verified: Type.Boolean(), payload: Type.Union([Type.Record(Text, Type.Unknown()), Type.Null()]),
    createdAt: Text, embedding: NullableText,
  }, strict)),
  evidence: Type.Array(Type.Object({ id: Text, placeId: NullableText, city: Text, kind: Text, strength: Text,
    content: Text, sourceUrl: Text, fetchedAt: Text, embedding: NullableText,
  }, strict)),
  relations: Type.Array(Type.Object({ id: Text, city: Text, fromName: Text, toName: Text, strength: Text,
    noteCount: Type.Integer({ minimum: 0 }), createdAt: Text,
  }, strict)),
}, strict);
export type FrozenData = Static<typeof DataSchema>;
const FileSchema = Type.Object({ format: Type.Literal('tripweaver-knowledge'), version: Type.Literal(1),
  name: Text, exportedAt: Text, sourceId: Text, contentHash: Text, data: DataSchema,
}, strict);
export type FrozenKnowledge = Static<typeof FileSchema>;

export function validateFrozen(value: unknown): FrozenKnowledge {
  if (!Value.Check(FileSchema, value)) {
    const first = Value.Errors(FileSchema, value).First();
    throw new Error(`知识库副本格式错误：${first?.path ?? '/'} ${first?.message ?? ''}`);
  }
  const data = value.data;
  if (!data.cities.length || new Set(data.cities).size !== data.cities.length || !data.places.length) throw new Error('知识库副本没有地点或城市集合不合法');
  const ids = new Set(data.places.map((p) => p.id));
  for (const rows of [data.places, data.evidence, data.relations]) {
    if (new Set(rows.map((r) => r.id)).size !== rows.length || rows.some((r) => !r.id)) throw new Error('知识库副本存在重复/空 ID');
  }
  const cities = new Set(data.cities);
  if (data.places.some((p) => !cities.has(p.city)) || data.relations.some((r) => !cities.has(r.city)) ||
    data.evidence.some((e) => e.placeId !== null ? !ids.has(e.placeId) : !cities.has(e.city))) throw new Error('副本城市或证据关联不完整');
  if (data.cities.some((city) => !data.places.some((p) => p.city === city))) throw new Error('副本包含没有地点的城市');
  if (data.places.some((p) => p.payload && Object.keys(p.payload).some((key) => !(KNOWLEDGE_PAYLOAD_KEYS as readonly string[]).includes(key)))) {
    throw new Error('副本 payload 含不允许导出的字段');
  }
  for (const [rows, dims] of [[data.places, data.vectors.placeDimensions], [data.evidence, data.vectors.evidenceDimensions]] as const) {
    for (const row of rows) {
      if (row.embedding === null) continue;
      if (!data.vectors.included || dims === null) throw new Error('副本向量声明与内容不一致');
      const vector: unknown = JSON.parse(row.embedding);
      if (!Array.isArray(vector) || vector.length !== dims || vector.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new Error('副本包含无效向量或维度不一致');
    }
  }
  for (const timestamp of [value.exportedAt, ...data.places.map((p) => p.createdAt), ...data.evidence.map((e) => e.fetchedAt), ...data.relations.map((r) => r.createdAt)]) {
    if (!Number.isFinite(Date.parse(timestamp))) throw new Error('副本包含无效时间戳');
  }
  if (hash(data) !== value.contentHash) throw new Error('知识库副本内容 hash 不匹配，文件可能损坏或被修改');
  return value;
}

export function summarizeFrozen(snapshot: FrozenKnowledge) {
  const d = snapshot.data;
  const countBy = (values: string[]) => values.reduce<Record<string, number>>((out, key) => { out[key] = (out[key] ?? 0) + 1; return out; }, {});
  return {
    format: snapshot.format, version: snapshot.version, name: snapshot.name, exportedAt: snapshot.exportedAt,
    sourceId: snapshot.sourceId, contentHash: snapshot.contentHash, vectors: d.vectors,
    counts: { places: d.places.length, evidence: d.evidence.length, relations: d.relations.length,
      placeVectors: d.places.filter((p) => p.embedding !== null).length, evidenceVectors: d.evidence.filter((e) => e.embedding !== null).length },
    coverage: d.cities.map((city) => { const places = d.places.filter((p) => p.city === city); const ids = new Set(places.map((p) => p.id)); return {
      city, places: places.length, verified: places.filter((p) => p.verified).length,
      categories: countBy(places.map((p) => p.category)), sources: countBy(places.map((p) => p.source)),
      evidence: d.evidence.filter((e) => e.placeId === null ? e.city === city : ids.has(e.placeId)).length,
      relations: d.relations.filter((r) => r.city === city).length,
    }; }),
  };
}
export function saveFrozen(snapshot: FrozenKnowledge, root = path.join(EVAL_DIR, 'knowledge-snapshots')): string {
  validateFrozen(snapshot);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(snapshot.name)) throw new Error('副本名称仅支持 1–64 位小写字母、数字和短横线');
  // 压缩成功后才创建最终目录；同名版本绝不覆盖。
  const compressed = gzipSync(JSON.stringify(snapshot));
  fs.mkdirSync(root, { recursive: true });
  const directory = path.join(root, snapshot.name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'knowledge.json.gz'), compressed, { flag: 'wx' });
  writeJson(path.join(directory, 'manifest.json'), summarizeFrozen(snapshot));
  return directory;
}
export function readFrozen(directory: string): FrozenKnowledge {
  const file = path.join(directory, 'knowledge.json.gz');
  if (fs.statSync(file).size > 256 * 1024 * 1024) throw new Error('知识库副本压缩文件超过 256MiB');
  return validateFrozen(JSON.parse(gunzipSync(fs.readFileSync(file), { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8')));
}

export async function vectorColumns(client: Pick<PoolClient, 'query'>): Promise<{ places: number | null; evidence: number | null }> {
  const result = await client.query<{ table: string; type: string }>(`SELECT c.relname AS "table", format_type(a.atttypid,a.atttypmod) AS type
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('canonical_places','research_evidence')
      AND a.attname='embedding' AND NOT a.attisdropped`);
  const dims = (table: string) => { const row = result.rows.find((r) => r.table === table); const match = row?.type.match(/^vector\((\d+)\)$/); return match ? Number(match[1]) : null; };
  return { places: dims('canonical_places'), evidence: dims('research_evidence') };
}

export async function seedFrozen(pool: Pool, snapshot: FrozenKnowledge, skipVectors: boolean): Promise<void> {
  const client = await pool.connect();
  const d = snapshot.data;
  try {
    await client.query('BEGIN');
    const connection = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (!/^tripweaver_eval_[a-f0-9]{24}$/.test(connection.rows[0]?.name ?? '')) throw new Error('冻结副本只能导入本次评估专用数据库');
    const existing = await client.query<{ populated: boolean }>(`SELECT EXISTS(SELECT 1 FROM canonical_places)
      OR EXISTS(SELECT 1 FROM research_evidence) OR EXISTS(SELECT 1 FROM place_relation) AS populated`);
    if (existing.rows[0]?.populated) throw new Error('目标评估知识表非空，拒绝混入旧数据');
    const columns = await vectorColumns(client);
    const placeVectors = !skipVectors && d.places.some((p) => p.embedding !== null);
    const evidenceVectors = !skipVectors && d.evidence.some((e) => e.embedding !== null);
    if ((placeVectors && columns.places !== d.vectors.placeDimensions) || (evidenceVectors && columns.evidence !== d.vectors.evidenceDimensions)) {
      throw new Error('测试库缺少同维度 pgvector；安装扩展后重试，或显式 --skip-vectors（会记录为降级条件）');
    }
    // 使用有界批次和参数化 JSON recordset，保持 ID/引用/类型；整个导入事务原子完成。
    const insert = async (sql: string, rows: unknown[]) => {
      for (let i = 0; i < rows.length; i += 100) await client.query(sql, [JSON.stringify(rows.slice(i, i + 100))]);
    };
    await insert(`INSERT INTO canonical_places (id,city,name,category,lat,lng,source,verified,payload,created_at${placeVectors ? ',embedding' : ''})
      SELECT id,city,name,category,lat,lng,source,verified,payload,"createdAt"::timestamptz${placeVectors ? ',embedding::vector' : ''}
      FROM jsonb_to_recordset($1::jsonb) AS r(id text,city text,name text,category text,lat float8,lng float8,source text,
        verified boolean,payload jsonb,"createdAt" text,embedding text)`, d.places.map((p) => skipVectors ? { ...p, embedding: null } : p));
    await insert(`INSERT INTO research_evidence (id,place_id,city,kind,strength,content,source_url,fetched_at${evidenceVectors ? ',embedding' : ''})
      SELECT id,"placeId",city,kind,strength,content,"sourceUrl","fetchedAt"::timestamptz${evidenceVectors ? ',embedding::vector' : ''}
      FROM jsonb_to_recordset($1::jsonb) AS r(id text,"placeId" text,city text,kind text,strength text,content text,
        "sourceUrl" text,"fetchedAt" text,embedding text)`, d.evidence.map((e) => skipVectors ? { ...e, embedding: null } : e));
    await insert(`INSERT INTO place_relation (id,city,from_name,to_name,strength,note_count,created_at)
      SELECT id,city,"fromName","toName",strength,"noteCount","createdAt"::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS r(id text,city text,"fromName" text,"toName" text,strength text,"noteCount" integer,"createdAt" text)`, d.relations);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
