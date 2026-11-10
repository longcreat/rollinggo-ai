import { isDeepStrictEqual } from 'node:util';
import { uid } from '@tripweaver/shared';
import type { PoolClient } from 'pg';

interface ImportState {
  places: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  imports: Record<string, unknown>[];
  relations?: Record<string, unknown>[];
  relationImports?: Record<string, unknown>[];
  independentPhotos?: Record<string, unknown>[];
  relationSnapshots?: Record<string, unknown>[];
}

function sourceState(state: ImportState): ImportState {
  return { ...state, places: state.places.map(row => {
    const { embedding: _embedding, ...place } = row;
    const { embeddedText: _text, ...payload } = (place.payload ?? {}) as Record<string, unknown>;
    return { ...place, payload };
  }), evidence: state.evidence.map(({ embedding: _embedding, ...row }) => row) };
}

/** 同导入事务保存原行（含向量、图片和来源），不重写历史行程。 */
export async function captureIdentityImport(client: PoolClient, city: string): Promise<ImportState> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`place-identity:${city}`]);
  const places = await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(p) data FROM canonical_places p WHERE city=$1 ORDER BY id', [city]);
  const evidence = await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(e) data FROM research_evidence e WHERE city=$1 ORDER BY id', [city]);
  const imports = await client.query<{ data: Record<string, unknown> }>("SELECT to_jsonb(i) data FROM data_import i WHERE city=$1 AND source='xhs_places' ORDER BY source", [city]);
  const relations = await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(r) data FROM place_relation r WHERE city=$1 ORDER BY id', [city]);
  const relationImports = await client.query<{ data: Record<string, unknown> }>("SELECT to_jsonb(i) data FROM data_import i WHERE city=$1 AND source='xhs_relations' ORDER BY source", [city]);
  const independentPhotos = await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(p) data FROM independent_photo_assignments p WHERE city=$1 ORDER BY image_key', [city]);
  const relationSnapshots = await client.query<{ data: Record<string, unknown> }>('SELECT to_jsonb(s) data FROM place_relation_snapshots s WHERE city=$1', [city]);
  return { places: places.rows.map(r => r.data), evidence: evidence.rows.map(r => r.data), imports: imports.rows.map(r => r.data),
    relations: relations.rows.map(r => r.data), relationImports: relationImports.rows.map(r => r.data),
    independentPhotos: independentPhotos.rows.map(r => r.data), relationSnapshots: relationSnapshots.rows.map(r => r.data) };
}

export async function recordIdentityImport(client: PoolClient, city: string, contentHash: string, before: ImportState): Promise<string> {
  const id = uid();
  const after = await captureIdentityImport(client, city);
  await client.query(`INSERT INTO place_identity_imports(id,city,content_hash,before_state,after_state,created_at)
    VALUES($1,$2,$3,$4,$5,now())`, [id, city, contentHash, JSON.stringify(before), JSON.stringify(after)]);
  return id;
}

/** 必须由调用方包在事务中。现状偏离导入后快照时拒绝，避免覆盖后续照片或地点修订。 */
export async function rollbackIdentityImport(client: PoolClient, id: string, apply = false): Promise<{ city: string; restored: boolean }> {
  const result = await client.query<{ city: string; before_state: ImportState; after_state: ImportState; rolled_back_at: unknown }>(
    'SELECT city,before_state,after_state,rolled_back_at FROM place_identity_imports WHERE id=$1 FOR UPDATE', [id]);
  const entry = result.rows[0];
  if (!entry) throw new Error('地点导入审计记录不存在');
  if (entry.rolled_back_at) return { city: entry.city, restored: true };
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`place-identity:${entry.city}`]);
  if (apply) await client.query('LOCK TABLE canonical_places, research_evidence, data_import, place_relation, place_relation_snapshots IN SHARE ROW EXCLUSIVE MODE');
  const current = await captureIdentityImport(client, entry.city);
  // 旧批次没有关系快照；兼容其原边界，不能据此删除后来增加的关系。
  if (entry.after_state.relations === undefined) delete current.relations;
  if (entry.after_state.relationImports === undefined) delete current.relationImports;
  if (entry.after_state.independentPhotos === undefined) delete current.independentPhotos;
  if (entry.after_state.relationSnapshots === undefined) {
    if (current.relationSnapshots?.length) throw new Error('已有后续关系身份快照，旧审计不能覆盖回滚');
    delete current.relationSnapshots;
  }
  if (!isDeepStrictEqual(sourceState(current), sourceState(entry.after_state))) throw new Error('地点或语料已有后续修改，请先处理后续版本，不能覆盖回滚');
  if (!apply) return { city: entry.city, restored: false };
  await client.query('DELETE FROM research_evidence WHERE city=$1', [entry.city]);
  await client.query('DELETE FROM canonical_places WHERE city=$1', [entry.city]);
  await client.query('INSERT INTO canonical_places SELECT * FROM jsonb_populate_recordset(NULL::canonical_places,$1::jsonb)', [JSON.stringify(entry.before_state.places)]);
  await client.query('INSERT INTO research_evidence SELECT * FROM jsonb_populate_recordset(NULL::research_evidence,$1::jsonb)', [JSON.stringify(entry.before_state.evidence)]);
  await client.query("DELETE FROM data_import WHERE city=$1 AND source='xhs_places'", [entry.city]);
  await client.query('INSERT INTO data_import SELECT * FROM jsonb_populate_recordset(NULL::data_import,$1::jsonb)', [JSON.stringify(entry.before_state.imports)]);
  if (entry.before_state.relations !== undefined) {
    await client.query('DELETE FROM place_relation WHERE city=$1', [entry.city]);
    await client.query('INSERT INTO place_relation SELECT * FROM jsonb_populate_recordset(NULL::place_relation,$1::jsonb)', [JSON.stringify(entry.before_state.relations)]);
  }
  if (entry.before_state.relationImports !== undefined) {
    await client.query("DELETE FROM data_import WHERE city=$1 AND source='xhs_relations'", [entry.city]);
    await client.query('INSERT INTO data_import SELECT * FROM jsonb_populate_recordset(NULL::data_import,$1::jsonb)', [JSON.stringify(entry.before_state.relationImports)]);
  }
  if (entry.before_state.relationSnapshots !== undefined) {
    await client.query('DELETE FROM place_relation_snapshots WHERE city=$1', [entry.city]);
    await client.query('INSERT INTO place_relation_snapshots SELECT * FROM jsonb_populate_recordset(NULL::place_relation_snapshots,$1::jsonb)',
      [JSON.stringify(entry.before_state.relationSnapshots)]);
  }
  await client.query('UPDATE place_identity_imports SET rolled_back_at=now() WHERE id=$1', [id]);
  return { city: entry.city, restored: true };
}
