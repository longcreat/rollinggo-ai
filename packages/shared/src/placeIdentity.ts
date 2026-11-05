/** 名称仅用于解析；保留括号、分店名和机构后缀，不能把文本相似当成实体相等。 */
export function placeNameKey(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/gu, '').toLocaleLowerCase('en-US');
}

export interface PlaceIdentityReference {
  name: string;
  canonicalPlaceId?: string;
}

/** 已绑定的不同实体不得因同名合并；旧数据缺 ID 时只做精确名称兼容。 */
export function samePlaceReference(a: PlaceIdentityReference, b: PlaceIdentityReference): boolean {
  if (a.canonicalPlaceId && b.canonicalPlaceId) return a.canonicalPlaceId === b.canonicalPlaceId;
  return Boolean(placeNameKey(a.name)) && placeNameKey(a.name) === placeNameKey(b.name);
}

/** 调用者已限定同一城市；实例 ID 不参与地点去重。 */
export function uniquePlaceReferences<T extends PlaceIdentityReference>(places: readonly T[]): T[] {
  const result: T[] = [];
  for (const place of places) {
    const matches = result.filter((other) => samePlaceReference(place, other));
    if (!matches.length) result.push(place);
    else if (matches.length === 1 && place.canonicalPlaceId && !matches[0]!.canonicalPlaceId) {
      result[result.indexOf(matches[0]!)] = place;
    }
  }
  return result;
}
