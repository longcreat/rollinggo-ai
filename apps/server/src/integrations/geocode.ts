// Nominatim 地理编码：全局串行 + ≥1.1s 间隔 + 24h 缓存（Nominatim 使用政策要求 1 req/s）
// 失败/无结果一律回 null —— 编排 Agent 据此走 estimated 降级（R3）
//
// 快速失败（09-20 实测）：网络不可达时每次请求要硬等满超时，而 geocodeActivity 每个地点要调两次
// （「城市 名称」+「名称」），14 个活动 ≈166s 全花在等超时上（实测单地点 22.3s，且全部返回 null）。
// 因此：① 超时 10s → 2.5s；② 加进程级熔断，连续失败达阈值后不再发请求。
// 熔断取进程级而非任务级：Nominatim 是全局外部服务，不可达与单次生成无关（对照 amap route 的任务级熔断）。
import { wgs84ToGcj02 } from '@tripweaver/shared';
import { createSerialQueue } from '../lib/serialQueue';
import { TtlCache } from '../lib/ttlCache';
import type { GeocodedPoint } from './geoContracts';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'tripweaver/0.1 (open-source trip planner; https://github.com/tripweaver)';

/** 单次请求超时：不可达时应尽快失败，而不是让每个地点吃掉两次 10s */
const NOMINATIM_TIMEOUT_MS = 2_500;
/** 连续失败阈值：3 次足以区分「服务真的不可达」与「偶发一次抖动」 */
const BREAKER_FAIL_THRESHOLD = 3;
/** 熔断冷却：到期后清零计数、重新给服务机会（半开） */
const BREAKER_COOLDOWN_MS = 60_000;

const queue = createSerialQueue(1100);
const cache = new TtlCache<{ lat: number; lng: number } | null>(24 * 60 * 60 * 1000, 500);

export interface GeoPoint {
  lat: number;
  lng: number;
}

let failStreak = 0;
let openUntil = 0;

/** 熔断闸门：打开期间直接跳过（不发请求、不写缓存）。冷却到期后清零计数进入半开。 */
function breakerSkip(): boolean {
  if (openUntil === 0) return false;
  if (Date.now() < openUntil) return true;
  openUntil = 0;
  failStreak = 0;
  return false;
}

/** 只有「失败」（超时/网络错/HTTP 非 2xx）才计入熔断；「服务可达但无结果」视为健康 */
function recordOutcome(failed: boolean): void {
  if (!failed) {
    failStreak = 0;
    openUntil = 0;
    return;
  }
  failStreak += 1;
  if (failStreak >= BREAKER_FAIL_THRESHOLD && openUntil === 0) {
    openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    // 无 Fastify logger 可达：单行 warn 供运维定位「整任务无坐标」根因，无敏感信息
    console.warn(
      `[nominatim] 连续失败 ${failStreak} 次（超时/网络错/HTTP 非 2xx），本进程熔断 ${BREAKER_COOLDOWN_MS / 1000}s：后续地理编码直接降级，不再发请求`,
    );
  }
}

async function requestNominatim(query: string): Promise<{ failed: boolean; point: GeoPoint | null }> {
  try {
    const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh,en' },
      signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
    });
    if (!res.ok) return { failed: true, point: null };
    const rows = (await res.json()) as { lat?: string; lon?: string }[];
    const first = rows[0];
    if (!first?.lat || !first?.lon) return { failed: false, point: null };
    const lat = Number.parseFloat(first.lat);
    const lng = Number.parseFloat(first.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { failed: false, point: null };
    return { failed: false, point: { lat, lng } };
  } catch {
    return { failed: true, point: null };
  }
}

/** 地名 → 坐标；query 建议为「目的地 地点名」拼接以消歧 */
export async function geocode(query: string): Promise<GeoPoint | null> {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (breakerSkip()) return null;

  const { failed, point } = await queue(() => requestNominatim(query));
  recordOutcome(failed);
  // 失败不写缓存：服务恢复后立刻有机会拿到真实坐标，不必等 24h 负缓存过期
  if (!failed) cache.set(key, point);
  return point;
}

/**
 * 坐标解析链的公共兜底级（各服务商适配器链路的最后一级）：
 * Nominatim 查询（WGS-84）→ 转 GCJ-02，与全库坐标系一致；先试「城市 名称」再单独试「名称」。
 * origin 由调用方标注 —— 各链路的上一级不同，这里不知道自己是第几级。
 */
export async function geocodeFallbackGcj02(name: string, city: string): Promise<GeocodedPoint | null> {
  const wgs = (await geocode(`${city} ${name}`)) ?? (await geocode(name));
  if (!wgs) return null;
  return { ...wgs84ToGcj02(wgs.lat, wgs.lng), adcode: '' };
}
