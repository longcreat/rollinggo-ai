// 本回合的「可信点位缓存」：把已经服务端核验过的坐标按名称记下来，供写工具复用。
//
// 为什么需要：模型自己给的 lat/lng 不可信（会编），但这两类坐标是可信的——
//   ① search_places 返回的高德 POI 坐标；
//   ② 子代理 submit_places 提交、经 schema 校验的地点坐标。
// 写工具只从这份缓存取点，取不到才走模糊解析（可能命中同城同名点，见 rename 闸门）。
import type { GeoPoint } from '../../integrations/geoContracts';

export interface PlacePointCache {
  remember(name: string, point: { lat: number; lng: number }): void;
  /** 精确匹配优先，其次做包含匹配（「人民公园」↔「人民公园东门」） */
  find(name: string): { lat: number; lng: number } | null;
  /** 记下同一地点的官方图片（高德 POI），供提交时补 overview 封面 */
  rememberPhotos(name: string, urls: readonly string[]): void;
  findPhotos(name: string): string[];
}

function keyOf(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

/**
 * 包含匹配护栏（对齐 web tripDerive.containsMatch）：短侧 ≥2 字且长度不低于长侧一半才算命中。
 * 否则「西湖」会命中「西湖醋鱼餐厅」、把餐厅坐标安到景点头上 —— 宁可落「位置待核实」，不指错地方。
 */
function containsMatch(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && short.length * 2 >= long.length && long.includes(short);
}

export function createPlacePointCache(): PlacePointCache {
  const points = new Map<string, GeoPoint>();
  const photos = new Map<string, string[]>();
  return {
    remember(name, point) {
      const key = keyOf(name);
      if (!key || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
      points.set(key, { lat: point.lat, lng: point.lng });
    },
    rememberPhotos(name, urls) {
      const key = keyOf(name);
      const usable = urls.filter((url) => /^https:\/\//.test(url)).slice(0, 3);
      if (!key || !usable.length) return;
      photos.set(key, usable);
    },
    findPhotos(name) {
      const key = keyOf(name);
      const exact = photos.get(key);
      if (exact?.length) return exact;
      for (const [known, urls] of photos) {
        if (containsMatch(known, key)) return urls;
      }
      return [];
    },
    find(name) {
      const key = keyOf(name);
      const exact = points.get(key);
      if (exact) return exact;
      for (const [known, point] of points) {
        if (containsMatch(known, key)) return point;
      }
      return null;
    },
  };
}
