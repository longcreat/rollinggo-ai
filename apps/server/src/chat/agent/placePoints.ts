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
}

function keyOf(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

export function createPlacePointCache(): PlacePointCache {
  const points = new Map<string, GeoPoint>();
  return {
    remember(name, point) {
      const key = keyOf(name);
      if (!key || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
      points.set(key, { lat: point.lat, lng: point.lng });
    },
    find(name) {
      const key = keyOf(name);
      const exact = points.get(key);
      if (exact) return exact;
      for (const [known, point] of points) {
        if (known.length >= 2 && (known.includes(key) || key.includes(known))) return point;
      }
      return null;
    },
  };
}
