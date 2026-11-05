import type { Pool } from 'pg';
import { AMAP_SERVICES, amapDay, type AmapService } from '../integrations/amap/services';

export interface ServiceQuotaDecision {
  allowed: boolean;
  service: string;
  day: string;
  used: number;
  limit: number;
  resetAt: number;
}

export interface QuotaDay {
  day: string;
  start: number;
  resetAt: number;
}

/** Atomic, durable admission; every admitted outbound attempt is charged, even on failure.
 * 高德与和风共用这张 (day, service, calls) 表，靠 service 取值天然隔离，互不挤占额度。 */
export function createServiceQuotaLedger(
  pool: Pick<Pool, 'query'>,
  services: readonly string[],
  limits: Record<string, number>,
  day: (now?: number) => QuotaDay,
  now = Date.now,
) {
  return {
    async acquire(service: string): Promise<ServiceQuotaDecision> {
      const { day: key, resetAt } = day(now());
      const limit = limits[service] ?? 0;
      const result = await pool.query<{ calls: number }>(`
        INSERT INTO amap_service_usage (day, service, calls)
        SELECT $1, $2, 1 WHERE $3::integer > 0
        ON CONFLICT (day, service) DO UPDATE SET calls = amap_service_usage.calls + 1
        WHERE amap_service_usage.calls < $3
        RETURNING calls`, [key, service, limit]);
      const row = result.rows[0];
      const used = row?.calls ?? (await pool.query<{ calls: number }>('SELECT calls FROM amap_service_usage WHERE day = $1 AND service = $2', [key, service])).rows[0]?.calls ?? 0;
      return { allowed: Boolean(row), service, day: key, used, limit, resetAt };
    },
    async remaining(): Promise<number> {
      const result = await pool.query<{ service: string; calls: number }>('SELECT service, calls FROM amap_service_usage WHERE day = $1', [day(now()).day]);
      const used = new Map(result.rows.map(row => [row.service, row.calls]));
      return services.reduce((sum, service) => sum + Math.max(0, (limits[service] ?? 0) - (used.get(service) ?? 0)), 0);
    },
    /** 单个服务的当日剩余额度：POI 闸门只看 place，不能用全服务之和 */
    async remainingOf(service: string): Promise<number> {
      const { day: key } = day(now());
      const result = await pool.query<{ calls: number }>('SELECT calls FROM amap_service_usage WHERE day = $1 AND service = $2', [key, service]);
      return Math.max(0, (limits[service] ?? 0) - (result.rows[0]?.calls ?? 0));
    },
  };
}

export function createAmapQuotaLedger(pool: Pick<Pool, 'query'>, limits: Record<AmapService, number>, now = Date.now) {
  return createServiceQuotaLedger(pool, AMAP_SERVICES, limits, amapDay, now);
}
