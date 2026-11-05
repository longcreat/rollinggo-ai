import type { QueryResultRow } from 'pg';
import { placeNameKey } from '@tripweaver/shared';
import { identityStrings, placeIdentity, type IdentityPlace } from '../lib/placeIdentity';
import { readImageGallery, safeImageKey } from '../lib/imageGallery';
import { placeEmbeddingText } from '../lib/placeEmbeddingText';
import { filterIdentityImages, validateImagePolicy } from './placeImagePolicy';
import { readWithdrawal, validateWithdrawal } from './placeAvailability';
import { validateRecommendationIdentity } from './placeRecommendationIdentity';
import { validateOperationalIdentity } from './placeOperationalIdentity';

export interface ImportPlace { id: string; name: string; category?: string; verified?: boolean; lat?: number | null; lng?: number | null; payload?: Record<string, unknown> }
interface QueryClient { query<T extends QueryResultRow>(sql: string, params: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> }
type StoredIdentityPlace = IdentityPlace & { source: string; verified: boolean };

// 上游权威字段替换旧值，不能让 goldset 合并顺序保留旧的矛盾政策。
const CONTENT_KEYS = ['content', 'topReasons', 'aliases', 'identity', 'components', 'reservation', 'reservationNote',
  'reservationEvidence', 'reservationConflict', 'openHours', 'hours', 'price', 'address', 'adcode', 'geoStatus', 'xhsPlaceType',
  'imageIdentity', 'mentionSources', 'identityWithdrawal', 'recommendationIdentity', 'operationalIdentity'];
const SCOPED_FACT_KEYS = ['themes', 'typicalVisitMinutes', 'tips', 'mentionCount', 'recommendScore'];

/** revision 约束身份声明；内容更新和导入派生的 nameKeys 不影响身份版本。 */
function identityDeclaration(place: IdentityPlace): string {
  const identity = placeIdentity(place);
  const sorted = (value: unknown) => [...new Set(identityStrings(value))].sort();
  return JSON.stringify([identity.entityId, identity.canonicalName, identity.kind,
    sorted(identity.memberIds), sorted(identity.memberNames), sorted(place.payload?.aliases)]);
}

/** 仅解除旧组合吞并：同批 v2 父项明确以 components 引用独立子项，且双方无同义成员归属。 */
function releasedLegacyComponents(rows: readonly StoredIdentityPlace[], city: string, places: readonly ImportPlace[]): Set<string> {
  const existing = new Map(rows.map(row => [row.id, row]));
  const incoming = new Map(places.map(place => [place.id, place]));
  const released = new Set<string>();
  for (const place of places) {
    const before = existing.get(place.id);
    const target = before?.payload?.canonicalRedirectTo;
    if (!before || before.city !== city || !['xhs', 'goldset'].includes(before.source)
      || typeof target !== 'string' || placeIdentity(before).version === 2) continue;
    const parent = existing.get(target), nextParent = incoming.get(target);
    if (!parent || parent.city !== city || parent.payload?.canonicalRedirectTo
      || !['xhs', 'goldset'].includes(parent.source) || !nextParent) continue;
    const childIdentity = placeIdentity({ ...place, city, payload: place.payload ?? null });
    const parentIdentity = placeIdentity(parent);
    const nextIdentity = placeIdentity({ ...nextParent, city, payload: nextParent.payload ?? null });
    const components = nextParent.payload?.components;
    if (childIdentity.version !== 2 || nextIdentity.version !== 2 || nextIdentity.kind !== 'complex'
      || parentIdentity.kind !== 'complex' || identityStrings(parentIdentity.memberIds).includes(place.id)
      || identityStrings(nextIdentity.memberIds).includes(place.id) || identityStrings(childIdentity.memberIds).includes(target)
      || !Array.isArray(components) || !components.some(component => component && typeof component === 'object'
        && component.canonicalPlaceId === place.id && component.name === place.name)) continue;
    // 不能抢占其他已治理实体的成员，即使旧重定向数据已不一致。
    if (rows.some(row => row.id !== place.id && placeIdentity(row).version === 2
      && identityStrings(placeIdentity(row).memberIds).includes(place.id))) continue;
    released.add(place.id);
  }
  return released;
}

/** 必须在导入事务的第一次写入前调用；历史导出不能复活旧 ID 或降级已治理身份。 */
export async function prepareImportedPlaces<T extends ImportPlace>(client: QueryClient, city: string, places: readonly T[]): Promise<T[]> {
  validateIdentities(places);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`place-identity:${city}`]);
  const { rows } = await client.query<StoredIdentityPlace>(
    'SELECT id, city, name, source, verified, payload FROM canonical_places WHERE city=$1 OR id = ANY($2::text[]) FOR UPDATE', [city, places.map(p => p.id)]);
  const existing = new Map(rows.map(p => [p.id, p]));
  const released = releasedLegacyComponents(rows, city, places);
  const accepted = places.flatMap(place => {
    const previous = existing.get(place.id);
    if (previous && previous.city !== city) throw new Error(`地点 ID 跨城市冲突：${place.id}`);
    if (previous?.payload?.canonicalRedirectTo && !released.has(place.id)) return [];
    const before = previous ? placeIdentity(previous) : {};
    const after = placeIdentity({ ...place, city, payload: place.payload ?? null });
    if (before.version === 2 && after.version !== 2) return [];
    validateWithdrawal({ ...place, city, payload: place.payload ?? null }, previous);
    validateImagePolicy({ ...place, city, payload: place.payload ?? null }, previous);
    validateRecommendationIdentity({ ...place, city, payload: place.payload ?? null }, previous);
    if (before.version === 2 && after.version === 2 && typeof before.revision === 'number'
      && (typeof after.revision !== 'number' || after.revision < before.revision)) {
      throw new Error(`实体身份版本回退：${place.name}`);
    }
    if (previous && before.version === 2 && after.version === 2 && after.revision === before.revision
      && identityDeclaration(previous) !== identityDeclaration({ ...place, city, payload: place.payload ?? null })) {
      throw new Error(`同版本实体身份声明冲突：${place.name}`);
    }
    return [place];
  });
  // 使用过滤后的最终声明；被跳过的旧文件不能冒充仍有效的候选。
  const available = new Map<string, IdentityPlace & { verified?: boolean }>(rows.map(p => [p.id, p]));
  const absorbed = new Set<string>();
  for (const place of accepted) {
    available.set(place.id, { ...place, city, payload: place.payload ?? null });
    for (const id of identityStrings(placeIdentity({ ...place, city, payload: place.payload ?? null }).memberIds)) {
      if (id !== place.id) absorbed.add(id);
    }
  }
  for (const place of accepted) {
    const withdrawal = readWithdrawal({ ...place, city, payload: place.payload ?? null });
    if (withdrawal?.candidateIds.some(id => {
      const candidate = available.get(id);
      return !candidate || candidate.city !== city || candidate.verified === false || absorbed.has(id)
        || candidate.payload?.identityWithdrawal !== undefined || candidate.payload?.canonicalRedirectTo
        || placeIdentity(candidate).version !== 2 || placeIdentity(candidate).entityId !== id;
    })) throw new Error(`撤回候选不是同城有效现行实体：${place.name}`);
  }
  return accepted;
}

function validateIdentities(places: readonly ImportPlace[]) {
  const owners = new Map<string, string>();
  return places.flatMap(place => {
    validateWithdrawal({ ...place, city: '', payload: place.payload ?? null });
    validateImagePolicy({ ...place, city: '', payload: place.payload ?? null });
    validateRecommendationIdentity({ ...place, city: '', payload: place.payload ?? null });
    validateOperationalIdentity({ ...place, city: '', payload: place.payload ?? null });
    if (place.payload?.identity === undefined) return [];
    const value = placeIdentity({ ...place, city: '', payload: place.payload ?? null });
    if (typeof value.version !== 'number' || ![1, 2].includes(value.version) || value.canonicalName !== place.name
      || !Array.isArray(value.memberNames) || !value.memberNames.includes(place.name)
      || value.memberNames.length > 1000 || value.memberNames.some(n => typeof n !== 'string' || !n.trim() || n.length > 128)) {
      throw new Error(`地点归一元数据无效：${place.name}`);
    }
    const version2 = value.version === 2;
    if (version2 && (value.entityId !== place.id || !Array.isArray(value.memberIds)
      || !value.memberIds.includes(place.id) || value.memberIds.length > 1000
      || value.memberIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)
      || !Number.isInteger(value.revision) || Number(value.revision) < 1
      || !['same_entity', 'complex'].includes(String(value.kind)))) throw new Error(`地点稳定身份无效：${place.name}`);
    const names = identityStrings(value.memberNames);
    const ids = version2 ? identityStrings(value.memberIds) : [place.id];
    for (const member of version2 ? ids.map(id => `id:${id}`) : names.map(name => `name:${placeNameKey(name)}`)) {
      if (owners.has(member) && owners.get(member) !== place.id) throw new Error(`地点归属冲突：${member}`);
      owners.set(member, place.id);
    }
    const withheld = place.payload?.identityWithdrawal !== undefined;
    const clearKeys = place.payload?.mentionSources !== undefined || withheld ? [...CONTENT_KEYS, ...SCOPED_FACT_KEYS]
      : place.payload?.recommendationIdentity !== undefined ? [...CONTENT_KEYS, 'mentionCount', 'recommendScore'] : CONTENT_KEYS;
    const payload = Object.fromEntries(clearKeys.filter(key => place.payload?.[key] !== undefined).map(key => [key, place.payload![key]]));
    payload.identity = { ...value, nameKeys: [...new Set([...names, ...identityStrings(place.payload?.aliases)].map(placeNameKey))] };
    return [{ id: place.id, name: place.name, names, ids, version2, withheld, category: place.category, clearKeys,
      hasCoordinates: Object.hasOwn(place, 'lat') && Object.hasOwn(place, 'lng'),
      lat: place.lat, lng: place.lng, payload }];
  });
}

/** 在地点导入的同一事务中执行。旧记录只重定向，保留来源、照片和历史引用。 */
export async function reconcileImportedPlaces(client: QueryClient, city: string, places: readonly ImportPlace[]): Promise<number> {
  const records = validateIdentities(places);
  if (!records.length) return 0;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`place-identity:${city}`]);
  const { rows } = await client.query<StoredIdentityPlace>(
    'SELECT id,city,name,source,verified,payload FROM canonical_places WHERE city=$1 OR id=ANY($2::text[]) FOR UPDATE',
    [city, records.flatMap(record => record.ids)]);
  const byId = new Map(rows.map(row => [row.id, row]));
  const released = releasedLegacyComponents(rows, city, places);
  const redirects = new Map<string, string>();
  for (const row of rows) if (typeof row.payload?.canonicalRedirectTo === 'string' && !released.has(row.id)) redirects.set(row.id, row.payload.canonicalRedirectTo);
  for (const record of records) {
    const root = byId.get(record.id);
    if (!root || root.city !== city || !['xhs', 'goldset'].includes(root.source) || redirects.has(root.id)) {
      throw new Error(`主实体不存在、来源冲突或已经重定向：${record.name}`);
    }
    const members = record.version2 ? record.ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
      : rows.filter(row => row.city === city && record.names.includes(row.name) && ['xhs', 'goldset'].includes(row.source));
    if (record.payload.imageIdentity !== undefined) record.payload.amapPhoto = null;
    // 只复用同义成员的图片；组成地点的图片和事实保持自己的归属。
    if ((record.payload.identity as Record<string, unknown>).kind === 'same_entity') {
      const photoRows = [root, ...members.filter(row => row.id !== root.id)];
      const available = [...new Map(photoRows.flatMap(row => {
        const images = readImageGallery(row.payload?.imageGallery);
        const key = row.payload?.coverImage;
        return images.length ? images : typeof key === 'string' && safeImageKey(key) ? [{ key }] : [];
      }).map(photo => [photo.key, photo])).values()];
      const gallery = filterIdentityImages({ ...root, payload: record.payload }, available).slice(0, 3);
      const cover = photoRows.map(row => row.payload?.coverImage).find(value => typeof value === 'string' && value.trim());
      if (gallery.length) record.payload.imageGallery = gallery;
      if (record.payload.imageIdentity !== undefined) {
        record.payload.imageGallery = gallery;
        record.payload.coverImage = gallery[0]?.key ?? null;
      } else if (cover || gallery.length) record.payload.coverImage = gallery[0]?.key ?? cover;
    } else if (record.payload.imageIdentity !== undefined) {
      const gallery = filterIdentityImages({ ...root, payload: record.payload }, readImageGallery(root.payload?.imageGallery));
      record.payload.imageGallery = gallery;
      record.payload.coverImage = gallery[0]?.key ?? null;
    }
    for (const row of members) {
      if (row.city !== city || !['xhs', 'goldset'].includes(row.source)) throw new Error(`地点成员范围冲突：${row.id}`);
      if (row.id === record.id) continue;
      if (records.some(other => other.id === row.id)) throw new Error(`主实体归属冲突：${row.name}`);
      const previous = redirects.get(row.id);
      if (previous && previous !== record.id && !record.ids.includes(previous)) throw new Error(`旧实体已有不同归属：${row.name}`);
      redirects.set(row.id, record.id);
    }
  }
  // 检查所有受影响的旧链，随后压成一步，防止改名或连续归并产生环及悬空引用。
  for (const [id, target] of redirects) {
    const seen = new Set([id]);
    let root = target;
    while (redirects.has(root)) {
      if (seen.has(root)) throw new Error(`实体重定向成环：${id}`);
      seen.add(root); root = redirects.get(root)!;
    }
    if (!byId.has(root) || byId.get(root)!.city !== byId.get(id)!.city) throw new Error(`实体重定向目标无效：${id}`);
    redirects.set(id, root);
  }
  const encoded = JSON.stringify(records.map(record => ({ ...record, embeddingText: placeEmbeddingText({ ...record, city }) })));
  const columns = await client.query<{ available: boolean }>(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='canonical_places' AND column_name='embedding') available`, []);
  if (columns.rows[0]?.available) {
    await client.query(`UPDATE canonical_places p SET embedding=NULL, payload=COALESCE(p.payload,'{}'::jsonb)-'embeddedText'
      FROM jsonb_to_recordset($2::jsonb) v(id text, version2 boolean, withheld boolean, "embeddingText" text)
      WHERE p.id=v.id AND p.city=$1 AND v.version2 AND (v.withheld OR p.payload->>'embeddedText' IS DISTINCT FROM v."embeddingText")`, [city, encoded]);
  }
  await client.query(`UPDATE canonical_places p SET payload =
    (COALESCE(p.payload, '{}'::jsonb) - v."clearKeys" - 'canonicalRedirectTo') || v.payload,
    name=CASE WHEN v.version2 THEN v.name ELSE p.name END,
    verified=CASE WHEN v.withheld THEN FALSE WHEN v.version2 THEN TRUE ELSE p.verified END,
    category=CASE WHEN v.version2 THEN coalesce(v.category,p.category) ELSE p.category END,
    lat=CASE WHEN v.version2 AND v."hasCoordinates" THEN v.lat ELSE p.lat END,
    lng=CASE WHEN v.version2 AND v."hasCoordinates" THEN v.lng ELSE p.lng END
    FROM jsonb_to_recordset($2::jsonb) AS v(id text, name text, version2 boolean, withheld boolean, category text, lat float8, lng float8,
      "hasCoordinates" boolean, "clearKeys" text[], payload jsonb)
    WHERE p.id=v.id AND p.city=$1 AND p.source IN ('xhs','goldset')`, [city, encoded]);
  const result = await client.query(`UPDATE canonical_places p SET payload =
    COALESCE(p.payload, '{}'::jsonb) || jsonb_build_object('canonicalRedirectTo', v.target)
    FROM jsonb_to_recordset($2::jsonb) AS v(id text, target text)
    WHERE p.city=$1 AND p.id=v.id AND p.payload->>'canonicalRedirectTo' IS DISTINCT FROM v.target`,
    [city, JSON.stringify([...redirects].map(([id, target]) => ({ id, target })))]);
  return (result.rowCount ?? 0) + released.size;
}
