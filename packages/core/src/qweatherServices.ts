import type { QuotaDay } from './lib/amapQuotaLedger';

/** 和风与高德共用 amap_service_usage 这张通用 (day, service, calls) 计数器，靠 service 取值隔离。 */
export const QWEATHER_SERVICE = 'qweather';

/** 和风按中国 UTC+8 自然日重置，与高德账本同一口径。 */
export function qweatherDay(now = Date.now()): QuotaDay {
  const start = Math.floor((now + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  return { day: String(start), start, resetAt: start + 86400_000 };
}
