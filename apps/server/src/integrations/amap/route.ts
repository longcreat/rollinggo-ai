// 高德路径规划适配层（v0.5）：步行/驾车/公交三模式时长距离估算 + 折线抽稀
// 与 geocoder 共用串行队列（350ms）+ 5min TTL 缓存（坐标+mode+城市，仅缓存成功结果）；
// 任务级上限 ROUTE_MAX_PER_TASK 与日额度由 generation/geoPipeline 把关并计入 amap_calls。
// 任何故障回 null —— 上层降级 legEstimator 启发式，生成流程永不因此失败。
// 09-25：对外形状改由 integrations/geoContracts.ts 定义（供天地图同形实现），
// 任务级熔断器抽到 integrations/routeBreaker.ts（provider 中立），本文只保留高德特有的绑定与前置拦截。
import type { LegMode } from '@tripweaver/shared';
import { TtlCache } from '../../lib/ttlCache';
import { downsamplePolyline } from '../../lib/polyline';
import { createRouteBreaker } from '../routeBreaker';
import type { GeoPoint, RouteBreaker, RouteEstimate, RouteOpts } from '../geoContracts';
import { amapQueue } from './geocoder';
import { amapRequest } from './request';

export const ROUTE_MAX_PER_TASK = 30;   // 单次生成 ≤30 次路径规划，超出走启发式

const cache = new TtlCache<RouteEstimate>(5 * 60 * 1000, 300);

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

/** 从 v5 步行/驾车 paths[0] 或公交 transits[0] 中提取时长（秒）/距离（米）/折线点 */
function parseRoute(mode: LegMode, body: Record<string, unknown>): RouteEstimate | null {
  const route = (body.route ?? {}) as Record<string, unknown>;
  const listKey = mode === 'transit' ? 'transits' : 'paths';
  const first = Array.isArray(route[listKey]) ? ((route[listKey] as unknown[])[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) return null;
  const cost = (first.cost ?? {}) as Record<string, unknown>;
  const durationSec = num(cost.duration) || num(first.duration);
  const distanceM = num(first.distance);
  if (durationSec <= 0 || distanceM < 0) return null;
  // 步行/骑行/驾车读取 steps；公交按行进顺序拼接步行与公交/地铁段。
  let polyline: string | undefined;
  if (mode !== 'transit' && Array.isArray(first.steps)) {
    const points = (first.steps as Record<string, unknown>[])
      .map((s) => (typeof s.polyline === 'string' ? s.polyline : ''))
      .join(';')
      .split(';');
    polyline = downsamplePolyline(points);
  }
  if (mode === 'transit' && Array.isArray(first.segments)) {
    // Segment order is walking approach, then the first bus/subway alternative.
    const parts: string[] = [];
    for (const value of first.segments) {
      if (!value || typeof value !== 'object') continue;
      const segment = value as Record<string, unknown>;
      const walking = segment.walking as { steps?: { polyline?: unknown }[] } | undefined;
      if (Array.isArray(walking?.steps)) for (const step of walking.steps) {
        if (typeof step?.polyline === 'string') parts.push(step.polyline);
      }
      const bus = segment.bus as { buslines?: { polyline?: unknown }[] } | undefined;
      const line = Array.isArray(bus?.buslines) ? bus.buslines[0] : undefined;
      if (typeof line?.polyline === 'string') parts.push(line.polyline);
    }
    polyline = downsamplePolyline(parts.join(';').split(';'));
  }
  return {
    durationMin: Math.max(1, Math.round(durationSec / 60)),
    distanceM: Math.round(distanceM),
    ...(polyline ? { polyline } : {}),
  };
}

/** 两点间路径规划；transit 缺 adcode 时直接回 null（上层走启发式降级） */
export async function routeEstimate(
  apiKey: string,
  origin: GeoPoint,
  dest: GeoPoint,
  mode: LegMode,
  opts: RouteOpts = {},
): Promise<RouteEstimate | null> {
  if (mode === 'transit' && (!opts.city1 || !opts.city2)) return null;
  const fmt = (p: GeoPoint) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`;   // 高德要求「lng,lat」，取整 5 位兼作缓存键
  const cacheKey = `${mode}:${fmt(origin)}:${fmt(dest)}:${opts.city1 ?? ''}:${opts.city2 ?? ''}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const estimate = await amapQueue(async () => {
    try {
      const params = new URLSearchParams({
        key: apiKey,
        origin: fmt(origin),
        destination: fmt(dest),
        show_fields: 'polyline,cost',
      });
      // Official v5 default: the same recommendation strategy as the Amap app.
      if (mode === 'drive') params.set('strategy', '32');
      if (mode === 'transit') {
        params.set('strategy', '0');
        params.set('city1', opts.city1!);
        params.set('city2', opts.city2!);
      }
      const body = await amapRequest(mode, params);
      return parseRoute(mode, body);
    } catch {
      return null;
    }
  });
  // 只缓存成功结果：失败（网络/超时/限流/无方案）不做 24h 负缓存，
  // 避免一次瞬时故障把该点对钉死在启发式（重试成本已由任务级上限与日额度闸门约束）
  if (estimate) cache.set(cacheKey, estimate);
  return estimate;
}

// ---------- 任务级连续失败熔断（circuit breaker，07-18；09-25 抽出为 provider 中立核心） ----------
// 阈值、语义与 warn 契约见 integrations/routeBreaker.ts；这里只绑定高德适配器与它特有的前置拦截。

/** 高德特有前置拦截：transit 缺 adcode 时 routeEstimate 不会发真实请求，
 * 应在扣额度之前拦截 —— 不扣额度、也不计连续失败 */
function amapMissingAdcode(_origin: GeoPoint, _dest: GeoPoint, mode: LegMode, opts: RouteOpts): boolean {
  return mode === 'transit' && (!opts.city1 || !opts.city2);
}

/** 每个生成任务（geoSession）各建一个实例：熔断状态与该任务同生命周期；apiKey 绑定在适配器内 */
export function createAmapRouteBreaker(apiKey: string): RouteBreaker {
  return createRouteBreaker({
    estimate: (origin, dest, mode, opts) => routeEstimate(apiKey, origin, dest, mode, opts),
    skip: amapMissingAdcode,
    label: '[amap-route]',
  });
}
