import { placeNameKey } from '@tripweaver/shared';

export interface IdentityPlace {
  id: string;
  city: string;
  name: string;
  payload: Record<string, unknown> | null;
}

export function identityStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())) : [];
}

export function placeIdentity(place: IdentityPlace): Record<string, unknown> {
  const value = place.payload?.identity;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 逐提及/逐图受控实体不能消费按旧名称推导的关系或图片。 */
export function isScopedPlace(place: IdentityPlace): boolean {
  return ['mentionSources', 'imageIdentity', 'identityWithdrawal'].some(key => place.payload?.[key] !== undefined);
}

export function canonicalPlaceId(place: IdentityPlace): string {
  const identity = placeIdentity(place);
  return typeof identity.entityId === 'string' && identity.entityId.trim() ? identity.entityId : place.id;
}

/** 同义词与组成地点分离；组成地点只允许在检索意图中命中，不借用母实体的事实。 */
export function placeNames(place: IdentityPlace, includeComponents = false): string[] {
  const identity = placeIdentity(place);
  return [...new Set([place.name, ...identityStrings(place.payload?.aliases),
    ...(identity.kind !== 'complex' || includeComponents ? identityStrings(identity.memberNames) : [])])];
}

export type PlaceResolution<T> =
  | { status: 'resolved'; place: T; canonicalPlaceId: string }
  | { status: 'ambiguous'; candidates: T[] }
  | { status: 'unresolved'; reason?: 'withdrawn' };

/** 显式身份索引。无字符串包含、距离或去后缀合并；同名多主体返回歧义。 */
export function createPlaceIdentityIndex<T extends IdentityPlace>(places: readonly T[]) {
  const byId = new Map(places.map((place) => [place.id, place]));
  const redirects = new Map<string, string>();
  const owners = new Map<string, Set<string>>();
  for (const place of places) {
    const redirect = place.payload?.canonicalRedirectTo;
    if (typeof redirect === 'string' && redirect) redirects.set(place.id, redirect);
    const id = canonicalPlaceId(place);
    for (const member of [place.id, ...identityStrings(placeIdentity(place).memberIds)]) {
      const key = `${place.city}\0${member}`;
      const ids = owners.get(key) ?? new Set<string>();
      ids.add(id);
      owners.set(key, ids);
    }
  }
  const rootId = (place: T): string | null => {
    let id = canonicalPlaceId(place);
    const seen = new Set<string>();
    while (redirects.has(id)) {
      if (seen.has(id)) return null;
      seen.add(id);
      id = redirects.get(id)!;
    }
    const target = byId.get(id);
    if (target && target.city !== place.city) return null;
    return id;
  };
  const groups = new Map<string, T[]>();
  for (const place of places) {
    const id = rootId(place);
    if (!id || redirects.has(place.id) || place.payload?.identityWithdrawal !== undefined) continue;
    const key = `${place.city}\0${id}`;
    groups.set(key, [...(groups.get(key) ?? []), place]);
  }
  const representative = (members: T[]) => members.find(p => p.id === canonicalPlaceId(p)) ?? members[0]!;
  const withdrawn = places.filter(place => !redirects.has(place.id) && place.payload?.identityWithdrawal !== undefined);
  const withdrawalCandidates = (retired: readonly T[], city: string): T[] => {
    const ids = new Set(retired.flatMap(place => {
      const value = place.payload?.identityWithdrawal;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? identityStrings((value as Record<string, unknown>).candidateIds) : [];
    }));
    return [...groups.values()].filter(members => members[0]?.city === city
      && ids.has(canonicalPlaceId(representative(members)))).map(representative);
  };
  return {
    groups: [...groups.values()],
    isScopedReference(city: string, name: string): boolean {
      const key = placeNameKey(name);
      return places.some(place => place.city === city && placeNames(place).some(n => placeNameKey(n) === key)
        && (isScopedPlace(place) || Boolean(byId.get(rootId(place) ?? '') && isScopedPlace(byId.get(rootId(place) ?? '')!))));
    },
    candidatesForReview(city: string, name: string): T[] {
      const key = placeNameKey(name);
      const stem = (value: string) => value.replace(/(?:风景名胜区|旅游景区|风景区|景区|公园|博物馆|博物院)$/u, '');
      return [...groups.values()].filter(members => members.some(place => place.city === city && placeNames(place).some(alias => {
        const other = placeNameKey(alias);
        return (stem(key).length >= 2 && stem(key) === stem(other))
          || (Math.min(key.length, other.length) >= 3 && (key.includes(other) || other.includes(key)));
      }))).map(representative);
    },
    resolve(city: string, name: string, id?: string, includeComponents = false): PlaceResolution<T> {
      const key = placeNameKey(name);
      let candidates: T[];
      if (id) {
        const direct = byId.get(id);
        const owned = owners.get(`${city}\0${id}`);
        const ids = new Set(owned ?? []);
        if (direct?.city === city) {
          const resolved = rootId(direct);
          if (resolved) ids.add(resolved);
        }
        const roots = new Set([...ids].flatMap(value => {
          const place = byId.get(value);
          const root = place ? rootId(place) : value;
          return root ? [root] : [];
        }));
        const retired = withdrawn.filter(place => place.city === city && roots.has(place.id));
        if (retired.length) {
          const options = withdrawalCandidates(retired, city);
          if (key && ![...retired, ...options].some(place => placeNames(place).some(n => placeNameKey(n) === key))) {
            return { status: 'unresolved' };
          }
          return options.length ? { status: 'ambiguous', candidates: options } : { status: 'unresolved', reason: 'withdrawn' };
        }
        candidates = [...groups].filter(([groupKey]) => [...roots].some(root => groupKey === `${city}\0${root}`))
          .map(([, members]) => representative(members));
        // 显式 ID 仍须匹配名称，防止旧引用随换点继续携带。
        if (key) candidates = candidates.filter(p => placeNames(p, includeComponents).some(n => placeNameKey(n) === key));
      } else {
        candidates = [...groups.values()].filter(members => members.some(p => p.city === city
          && placeNames(p, includeComponents).some(n => placeNameKey(n) === key))).map(representative);
        const retired = withdrawn.filter(place => place.city === city && placeNames(place).some(n => placeNameKey(n) === key));
        if (retired.length) {
          const options = [...new Map([...candidates, ...withdrawalCandidates(retired, city)].map(p => [p.id, p])).values()];
          return options.length ? { status: 'ambiguous', candidates: options } : { status: 'unresolved', reason: 'withdrawn' };
        }
      }
      if (candidates.length === 1) return { status: 'resolved', place: candidates[0]!, canonicalPlaceId: canonicalPlaceId(candidates[0]!) };
      return candidates.length ? { status: 'ambiguous', candidates } : { status: 'unresolved' };
    },
  };
}
