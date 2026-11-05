// POI 关联对加载（09-27）：上游 xhs-pipeline 规则挖掘的「常在同天」无向地点对。
//
// 语义边界（上游 47292c6 明确）：关联对**不表达先后** —— 「先去 A 再去 B」的顺序由消费端按坐标决定。
// 因此这里只服务「同天聚类」：排程成链时给命中的两点距离打折，让它们自然相邻，
// 切段时更可能落进同一段（＝同一天）。绝不产出先后硬约束（那是 routeOrderSeeds 的事）。
//
// 降级纪律（同 placeFacts）：查询失败返回空 Map —— 关联对是增强信息，缺了排程照常跑。
import { pool } from '../../db/client';
import { placeNameKey } from '@tripweaver/shared';
import { loadPlaceIdentityIndex } from '../../services/placeIdentityService';
import { isScopedPlace } from '../../lib/placeIdentity';
import type { IdentityPlace } from '../../lib/placeIdentity';
import { currentBoundRelations, validateBoundRelations, validateRelationManifest } from '../../services/placeRelationIdentity';
import { relatedPairKey } from './schedule';

/** 实体键（id:...）→ 关联实体键列表；无向，两侧都登记。旧测试可使用精确名称键。 */
export type PlaceRelations = ReadonlyMap<string, readonly string[]>;

/**
 * 全城关联对两端通过完整身份目录解析；已确认别名指向同一 ID，歧义端点不参与。
 * city 必传：跨城关联对无意义（同 placeFacts 的 city 语义）。
 */
export async function loadPlaceRelations(city: string): Promise<PlaceRelations> {
  if (!city.trim()) return new Map();
  try {
    // 声明、完整图及目录在同一SQL快照读取，避免先读旧图再读新来源。
    const snapshot = await pool.query<{ manifest: unknown; relations: unknown; directory: IdentityPlace[] }>(
      `SELECT s.manifest,s.relations,COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',p.id,'city',p.city,'name',p.name,'payload',p.payload)) FROM canonical_places p
        WHERE p.city=s.city AND p.verified=TRUE AND p.id IN (SELECT jsonb_array_elements_text(s.available_ids))), '[]'::jsonb) directory
       FROM place_relation_snapshots s WHERE s.city=$1`, [city]);
    if (snapshot.rows[0]) {
      const row = snapshot.rows[0];
      const map = new Map<string, string[]>();
      if (row.relations === null) return map;
      const manifest = validateRelationManifest(row.manifest, city);
      for (const relation of currentBoundRelations(manifest, validateBoundRelations(row.relations, manifest), row.directory)) {
        const a = `id:${relation.fromEntityId}`, b = `id:${relation.toEntityId}`;
        map.set(a, [...(map.get(a) ?? []), b]);
        map.set(b, [...(map.get(b) ?? []), a]);
      }
      return map;
    }
    const { rows } = await pool.query<{ from_name: string; to_name: string }>(
      `SELECT from_name, to_name FROM place_relation WHERE city = $1`,
      [city],
    );
    const map = new Map<string, string[]>();
    const catalog = await loadPlaceIdentityIndex(city);
    const link = (from: string, to: string): void => {
      const list = map.get(from) ?? [];
      if (!list.includes(to)) list.push(to);
      map.set(from, list);
    };
    for (const row of rows) {
      const fromPlace = catalog.resolve(city, row.from_name);
      const toPlace = catalog.resolve(city, row.to_name);
      if (fromPlace.status !== 'resolved' || toPlace.status !== 'resolved') continue;
      if (isScopedPlace(fromPlace.place) || isScopedPlace(toPlace.place)) continue;
      const from = `id:${fromPlace.canonicalPlaceId}`;
      const to = `id:${toPlace.canonicalPlaceId}`;
      if (!from || !to || from === to) continue;
      link(from, to);
      link(to, from);
    }
    return map;
  } catch (err) {
    console.warn(
      `[placeRelations] 关联对加载失败，排程按无关联降级：${err instanceof Error ? err.message : String(err)}`,
    );
    return new Map();
  }
}

/**
 * 关联对 → 候选池实际名 pair key（供排程直接查）。
 * 两端都以实体 ID 命中候选池时生效；历史无 ID 数据仅支持精确名称键。
 * 同实体的不同活动实例按列表保留，关联不意味着实体相同。
 * 命中名一律用候选池的**原值**（不 trim）—— 排程里比对的也是 `poi.name`，两处必须逐字一致。
 * 候选池没命中任何一对时返回空集合，排程行为与接入前一致。
 */
export function resolveRelatedPairs(
  relations: PlaceRelations,
  candidateNames: readonly (string | { name: string; canonicalPlaceId?: string })[],
): Set<string> {
  const pairs = new Set<string>();
  if (!relations.size) return pairs;
  const namesByKey = new Map<string, string[]>();
  for (const candidate of candidateNames) {
    const name = typeof candidate === 'string' ? candidate : candidate.name;
    const key = typeof candidate !== 'string' && candidate.canonicalPlaceId
      ? `id:${candidate.canonicalPlaceId}` : placeNameKey(name);
    if (!key) continue;
    const list = namesByKey.get(key) ?? [];
    if (!list.includes(name)) list.push(name);
    namesByKey.set(key, list);
  }
  for (const [key, neighbors] of relations) {
    const froms = namesByKey.get(key);
    if (!froms) continue;
    for (const neighbor of neighbors) {
      const tos = namesByKey.get(neighbor);
      if (!tos) continue;
      for (const from of froms) {
        for (const to of tos) {
          if (to !== from) pairs.add(relatedPairKey(from, to));
        }
      }
    }
  }
  return pairs;
}
