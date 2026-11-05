import type { PoolClient } from 'pg';
import type { IdentityPlace } from '../lib/placeIdentity';
import { currentBoundRelations, relationDigest, validateBoundRelations, validateRelationManifest, validateRelationPlaces,
  type BoundRelation, type RelationManifest } from './placeRelationIdentity';

async function storedManifest(client: PoolClient, city: string): Promise<RelationManifest | undefined> {
  const result = await client.query<{ manifest: unknown }>('SELECT manifest FROM place_relation_snapshots WHERE city=$1', [city]);
  return result.rows[0] ? validateRelationManifest(result.rows[0].manifest, city) : undefined;
}

/** 调用方包事务并先 captureIdentityImport；也取相同城市锁，独立调用不会绕过并发保护。 */
export async function acceptRelationSource(client: PoolClient, city: string, raw: unknown,
  places: readonly (IdentityPlace & { verified?: boolean })[]): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`place-identity:${city}`]);
  const previous = await storedManifest(client, city);
  if (raw === undefined) {
    if (previous) throw new Error('城市已接纳关系身份快照，旧地点文件不能移除来源声明');
    return;
  }
  const next = validateRelationManifest(raw, city);
  validateRelationPlaces(next, places);
  if (previous && (next.revision < previous.revision || (next.revision === previous.revision && relationDigest(next) !== relationDigest(previous)))) {
    throw new Error('关系来源快照版本回退或同版本内容变化');
  }
  const availableIds = [...new Set(places.filter(p => p.verified !== false && p.payload?.identityWithdrawal === undefined).map(p => p.id))].sort();
  if (previous && next.revision === previous.revision) {
    await client.query('UPDATE place_relation_snapshots SET available_ids=$2 WHERE city=$1', [city, JSON.stringify(availableIds)]);
    return;
  }
  await client.query(`INSERT INTO place_relation_snapshots(city,manifest,relations,available_ids) VALUES($1,$2,NULL,$3)
    ON CONFLICT(city) DO UPDATE SET manifest=EXCLUDED.manifest,relations=NULL,available_ids=EXCLUDED.available_ids`,
  [city, JSON.stringify(next), JSON.stringify(availableIds)]);
  await client.query("DELETE FROM data_import WHERE city=$1 AND source='xhs_relations'", [city]);
}

/** null 返回值只表示从未接纳身份快照；完整空图返回 []，不能退回旧名称导入。 */
export async function importRelationSnapshot(client: PoolClient, city: string, raw: unknown, relations: unknown): Promise<BoundRelation[] | null> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`place-identity:${city}`]);
  const previous = await storedManifest(client, city);
  if (raw === undefined && !previous) return null;
  if (raw === undefined) throw new Error('城市已接纳关系身份快照，旧关系文件不能覆盖');
  const next = validateRelationManifest(raw, city);
  if (!previous || relationDigest(next) !== relationDigest(previous)) throw new Error('关系文件必须匹配已导入地点的当前来源快照');
  const checked = validateBoundRelations(relations, next);
  const directory = await client.query<IdentityPlace>(`SELECT id,city,name,payload FROM canonical_places
    WHERE city=$1 AND verified=TRUE AND id IN (SELECT jsonb_array_elements_text(available_ids)
      FROM place_relation_snapshots WHERE city=$1)`, [city]);
  const usable = currentBoundRelations(next, checked, directory.rows);
  await client.query('UPDATE place_relation_snapshots SET relations=$2 WHERE city=$1', [city, JSON.stringify(checked)]);
  return usable;
}
