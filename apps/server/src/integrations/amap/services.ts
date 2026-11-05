export const AMAP_SERVICES = ['geocode', 'place', 'walk', 'cycle', 'drive', 'transit'] as const;
export type AmapService = typeof AMAP_SERVICES[number];

export const AMAP_PATHS: Record<AmapService, string> = {
  geocode: '/v3/geocode/geo',
  place: '/v5/place/text',
  walk: '/v5/direction/walking',
  cycle: '/v5/direction/bicycling',
  drive: '/v5/direction/driving',
  transit: '/v5/direction/transit/integrated',
};

export function amapDay(now = Date.now()) {
  const start = Math.floor((now + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  return { day: String(start), start, resetAt: start + 86400_000 };
}

/** Official personal plan: LBS services SHARE 150k/month; POI search has 5k/month.
 * https://lbs.amap.com/upgrade (verified 2026-09-29). Divide by 31 conservatively.
 */
export function readAmapServiceBudgets(source: Record<string, string | undefined>): Record<AmapService, number> {
  function integer(key: string, fallback: number): number {
    const raw = source[key];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 2147483647) throw new Error(`${key} 必须为 0 到 2147483647 的整数`);
    return Number(raw);
  }
  const lbsDaily = Math.floor(integer('AMAP_LBS_MONTHLY_BUDGET', 150_000) / 31);
  const searchDaily = Math.floor(integer('AMAP_SEARCH_MONTHLY_BUDGET', 5_000) / 31);
  const legacy = integer('AMAP_DAILY_BUDGET', 2147483647);
  const budgets = Object.fromEntries(AMAP_SERVICES.map(service => {
    const key = `AMAP_${service.toUpperCase()}_DAILY_BUDGET`;
    return [service, integer(key, Math.min(legacy, service === 'place' ? searchDaily : Math.floor(lbsDaily / 5)))];
  })) as Record<AmapService, number>;
  if (AMAP_SERVICES.filter(service => service !== 'place').reduce((sum, service) => sum + budgets[service], 0) > lbsDaily) {
    throw new Error('高德五项 LBS 日预算之和不能超过 AMAP_LBS_MONTHLY_BUDGET / 31');
  }
  if (budgets.place > searchDaily) throw new Error('AMAP_PLACE_DAILY_BUDGET 不能超过 AMAP_SEARCH_MONTHLY_BUDGET / 31');
  return budgets;
}
