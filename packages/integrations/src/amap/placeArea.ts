// 高德「片区检索」：把一个景区/商圈当面状区域，用多边形或半径搜索取回区域内的真实 POI。
//
// 高德 POI 2.0 支持关键字 / 周边 / 多边形 / ID 四种检索；本文件只封装后两种，
// 与 `poiSource.ts` 的文本检索共用 `place` 配额与 350ms 串行队列（不新增配额键）。
// 返回形状与 `searchPois` 一致，调用方不需要区分来源。
//
// 围栏来源不在本文件：高德不提供 POI 级 boundary，多边形由调用方给出
// （策展坐标 / 行政区边界），否则退化为「中心点 + 半径」。
import { amapQueue } from './geocoder';
import { TtlCache } from '@rollinggo-trip/core/lib/ttlCache';
import { mapPoi } from './poiSource';
import { amapRequest } from './request';
import { AMAP_SEARCH_PATHS } from '@rollinggo-trip/core/amapServices';
import type { GeoPoint, SourcedPoi } from '../geoContracts';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PAGE_SIZE = 25;
const MIN_RADIUS_M = 50;
const MAX_RADIUS_M = 50_000;

export interface AreaSearchQuery {
  /** 仅用于缓存键与日志；多边形/周边检索本身不传城市。 */
  city?: string;
  /** 高德多边形参数：`lng,lat|lng,lat|…`，首尾自动闭合。 */
  polygon?: string;
  center?: GeoPoint;
  radiusM?: number;
  keywords?: string;
  pageSize?: number;
  pageNum?: number;
}

/** 用正多边形近似圆形围栏；center/radius 均为 GCJ-02。 */
export function circlePolygon(center: GeoPoint, radiusM: number, sides = 20): string {
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) throw new Error('围栏中心坐标无效');
  if (!Number.isFinite(radiusM) || radiusM <= 0) throw new Error('围栏半径无效');
  const count = Math.max(3, Math.min(60, Math.round(sides)));
  const latRadius = radiusM / 111_320;
  const lngRadius = radiusM / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  const points: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    points.push(`${(center.lng + Math.cos(angle) * lngRadius).toFixed(6)},${(center.lat + Math.sin(angle) * latRadius).toFixed(6)}`);
  }
  return points.join('|');
}

function cacheKey(query: AreaSearchQuery): string {
  const center = query.center ? `${query.center.lng.toFixed(5)},${query.center.lat.toFixed(5)}` : '';
  return JSON.stringify([(query.city ?? '').trim().toLowerCase(), query.polygon ?? '', center, query.radiusM ?? 0, query.keywords?.trim().toLowerCase() ?? '', query.pageSize ?? MAX_PAGE_SIZE, query.pageNum ?? 1]);
}

function dedupe(pois: SourcedPoi[]): SourcedPoi[] {
  const seen = new Set<string>();
  const out: SourcedPoi[] = [];
  for (const poi of pois) {
    const point = poi.location ? `${poi.location.lng.toFixed(4)},${poi.location.lat.toFixed(4)}` : '';
    const key = `${poi.name}|${point}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(poi);
  }
  return out;
}

const areaCache = new TtlCache<SourcedPoi[]>(CACHE_TTL_MS, 300);

/**
 * 按多边形或中心+半径检索真实 POI。
 * 配额/队列与文本检索一致；缓存 24h，命中不发请求也不扣配额。
 */
export async function searchAreaPois(key: string, query: AreaSearchQuery, signal?: AbortSignal): Promise<SourcedPoi[]> {
  const cached = areaCache.get(cacheKey(query));
  if (cached) return cached;
  const pois = await requestAreaPois(key, query, signal);
  areaCache.set(cacheKey(query), pois);
  return pois;
}

async function requestAreaPois(key: string, query: AreaSearchQuery, signal?: AbortSignal): Promise<SourcedPoi[]> {
  signal?.throwIfAborted();
  const params = new URLSearchParams({
    key,
    show_fields: 'business,photos',
    page_size: String(Math.min(Math.max(1, query.pageSize ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE)),
    page_num: String(Math.max(1, query.pageNum ?? 1)),
  });
  if (query.keywords?.trim()) params.set('keywords', query.keywords.trim());
  let path: string;
  if (query.polygon) {
    params.set('polygon', closeRing(query.polygon));
    path = AMAP_SEARCH_PATHS.polygon;
  } else if (query.center) {
    const radius = Math.min(Math.max(query.radiusM ?? 1000, MIN_RADIUS_M), MAX_RADIUS_M);
    params.set('location', `${query.center.lng},${query.center.lat}`);
    params.set('radius', String(Math.round(radius)));
    path = AMAP_SEARCH_PATHS.around;
  } else {
    throw new Error('片区检索需要 polygon 或 center+radius');
  }
  const body = await amapQueue(() => amapRequest('place', params, 10_000, signal, path));
  signal?.throwIfAborted();
  const pois = Array.isArray(body.pois) ? (body.pois as Record<string, unknown>[]) : [];
  return dedupe(pois.map(mapPoi).filter((poi): poi is SourcedPoi => poi !== null));
}

/** 高德要求多边形首尾闭合；调用方给的是开放折线时补最后一个点。 */
export function closeRing(polygon: string): string {
  const points = polygon.split('|').map((point) => point.trim()).filter(Boolean);
  if (points.length < 3) throw new Error('多边形至少需要 3 个点');
  if (points[0] !== points[points.length - 1]) points.push(points[0]!);
  return points.join('|');
}
