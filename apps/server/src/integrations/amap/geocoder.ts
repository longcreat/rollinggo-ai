// 高德地理编码适配层（v0.5 地理数据层）：POI text 定位 + v3 geocode + Nominatim 兜底解析链
// 纪律沿用四道闸中的前两道：与路径规划共用串行队列（350ms）+ 24h TTL 缓存；
// 任务级上限与日额度闸门由调用方（generation/geoPipeline）通过 tryAcquire 回调把关。
// 任何故障不抛错到上层 —— 各级回 null，链路整体失败由上层标注 estimated 降级。
import { createSerialQueue } from '../../lib/serialQueue';
import { TtlCache } from '../../lib/ttlCache';
import type { GeocodedPlace, GeocodedPoint, GeoPoint } from '../geoContracts';
import { geocodeFallbackGcj02 } from '../geocode';
import { amapRequest } from './request';

/** 解析高德「lng,lat」坐标串（GCJ-02）；非法输入回 null */
export function parseAmapLocation(raw: unknown): GeoPoint | null {
  const parts = (typeof raw === 'string' ? raw : '').split(',');
  if (parts.length !== 2) return null;
  const lng = Number.parseFloat(parts[0]!);
  const lat = Number.parseFloat(parts[1]!);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? { lat, lng } : null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 高德全 API 共用串行队列（个人认证约 3 QPS）：geocode 与 route 共队列限速 */
export const amapQueue = createSerialQueue(350);

const poiLocateCache = new TtlCache<GeocodedPoint | null>(CACHE_TTL_MS, 300);
const geocodeCache = new TtlCache<GeocodedPoint | null>(CACHE_TTL_MS, 300);

/** 高德 POI text 单点定位（名称 + 目的地消歧）→ GCJ-02 坐标 + adcode；失败回 null */
export async function amapPoiLocate(apiKey: string, name: string, city: string): Promise<GeocodedPoint | null> {
  const cacheKey = `${city}:${name}`.trim().toLowerCase();
  const cached = poiLocateCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const point = await amapQueue(async () => {
    try {
      const params = new URLSearchParams({ key: apiKey, keywords: name.slice(0, 80), page_size: '1' });
      if (city) {
        params.set('region', city.slice(0, 40));
        params.set('city_limit', 'true');
      }
      const body = await amapRequest('place', params);
      const first = Array.isArray(body.pois) ? (body.pois[0] as Record<string, unknown> | undefined) : undefined;
      const location = first ? parseAmapLocation(first.location) : null;
      return location ? { ...location, adcode: typeof first!.adcode === 'string' ? first!.adcode : '' } : null;
    } catch {
      return null;
    }
  });
  if (point) poiLocateCache.set(cacheKey, point);
  return point;
}

/** 高德 v3 地理编码（结构化地址）→ GCJ-02 坐标 + adcode；失败回 null */
export async function amapGeocode(apiKey: string, name: string, city: string): Promise<GeocodedPoint | null> {
  const cacheKey = `${city}:${name}`.trim().toLowerCase();
  const cached = geocodeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const point = await amapQueue(async () => {
    try {
      const params = new URLSearchParams({ key: apiKey, address: `${city}${name}`.slice(0, 80) });
      if (city) params.set('city', city.slice(0, 40));
      const body = await amapRequest('geocode', params);
      const first = Array.isArray(body.geocodes) ? (body.geocodes[0] as Record<string, unknown> | undefined) : undefined;
      const location = first ? parseAmapLocation(first.location) : null;
      return location ? { ...location, adcode: typeof first!.adcode === 'string' ? first!.adcode : '' } : null;
    } catch {
      return null;
    }
  });
  if (point) geocodeCache.set(cacheKey, point);
  return point;
}

/**
 * 活动坐标解析链：高德 POI text → 高德 v3 geocode → Nominatim + wgs84ToGcj02 → null。
 * @param tryAcquire 每次高德调用尝试前询问（任务上限/日额度记账），拒绝则跳过该级
 */
export async function geocodeActivity(
  apiKey: string | null,
  name: string,
  city: string,
  tryAcquire: () => boolean = () => true,
): Promise<GeocodedPlace | null> {
  // 顺序在 09-26 调过：两级分属**不同的配额组**（高德基础服务按组独立计数）——
  //   · `v3/geocode/geo`（地理编码）属「基础LBS服务」，个人认证 **150,000/月**
  //   · `v5/place/text`（关键字搜索）属「基础搜索服务」，个人认证**仅 5,000/月**
  // 原顺序（v5 优先）会让地理编码先打满稀缺的搜索配额（实测 `10044
  // USER_DAILY_QUERY_OVER_LIMIT`），之后全程走 v3 —— 等于白白浪费每个月的前 5,000 次。
  // v3 实测对 8 个景点全部命中，与天地图 geocoder 的坐标差中位 422 米，排程足够。
  if (apiKey && tryAcquire()) {
    const geo = await amapGeocode(apiKey, name, city);
    if (geo) return { ...geo, origin: 'amap-geocode' };
  }
  // v5 POI 定位兜底：只在 v3 解析不到时才消耗那份 5,000/月的搜索配额
  // （对「网红店名」这类非标准地址仍有效）
  if (apiKey && tryAcquire()) {
    const poi = await amapPoiLocate(apiKey, name, city);
    if (poi) return { ...poi, origin: 'amap-poi' };
  }
  // Nominatim 兜底（WGS-84）→ 统一转 GCJ-02，与全链坐标系一致
  const fallback = await geocodeFallbackGcj02(name, city);
  return fallback ? { ...fallback, origin: 'nominatim' } : null;
}
