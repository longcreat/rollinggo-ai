// 库内地点事实（09-27 建，11-05 图片链路收敛后只保留高德图与坐标）。
//
// 图片来源已统一为高德 POI：`canonical_places.payload.amapPhoto` 是命中后回写的热链，
// 同一地点只花一次高德搜索配额；本地图库 key 不再作为展示来源，故这里不再提供 cover/photos。
import { placeNameKey } from '@tripweaver/shared';
import { loadCityPlaceFacts } from './scheduling/placeFacts';

/** 一次生成共享全城索引：主名、别名、坐标和高德图都从同一份事实读取。 */
export function createStoredPlaceLookups(city: string, loadFacts = loadCityPlaceFacts) {
  let pending: ReturnType<typeof loadCityPlaceFacts> | null = null;
  const find = async (name: string) => {
    if (!city.trim() || !name.trim()) return null;
    pending ??= loadFacts(city);
    const index = await pending;
    return index.get(placeNameKey(name)) ?? null;
  };
  return {
    async amapPhotoFor(name: string): Promise<string | null> {
      return (await find(name))?.amapPhoto ?? null;
    },
    async pointFor(name: string): Promise<{ lat: number; lng: number } | null> {
      const hit = await find(name);
      return hit?.lat !== undefined && hit.lng !== undefined ? { lat: hit.lat, lng: hit.lng } : null;
    },
  };
}

/**
 * 库内已回写的高德图片（09-27）：命中直接返回，不再打高德稀缺的搜索配额（个人 5,000/月）。
 * 全城行只拉一次，后续候选复用。
 */
export function createStoredAmapPhotoLookup(city: string): (name: string) => Promise<string | null> {
  return createStoredPlaceLookups(city).amapPhotoFor;
}
