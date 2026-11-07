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

export interface ServiceQuotaLedgerOptions {
  /** false = 只计量不拦截：计数照写、恒放行，剩余额度视为无限。默认 true（和风等沿用）。 */
  enforce?: boolean;
}

/** Atomic, durable admission; every admitted outbound attempt is charged, even on failure.
 * 高德与和风共用这张 (day, service, calls) 表，靠 service 取值天然隔离，互不挤占额度。 */
export function createServiceQuotaLedger(
  pool: Pick<Pool, 'query'>,
  services: readonly string[],
  limits: Record<string, number>,
  day: (now?: number) => QuotaDay,
  now = Date.now,
  options: ServiceQuotaLedgerOptions = {},
) {
  const enforce = options.enforce !== false;
  return {
    async acquire(service: string): Promise<ServiceQuotaDecision> {
      const { day: key, resetAt } = day(now());
      const limit = limits[service] ?? 0;
      if (!enforce) {
        // 只计量：不设上限，调用永远放行，used 持续增长供日志/用量页观测。
        const charged = await pool.query<{ calls: number }>(`
          INSERT INTO amap_service_usage (day, service, calls)
          VALUES ($1, $2, 1)
          ON CONFLICT (day, service) DO UPDATE SET calls = amap_service_usage.calls + 1
          RETURNING calls`, [key, service]);
        return { allowed: true, service, day: key, used: charged.rows[0]?.calls ?? 1, limit, resetAt };
      }
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
      if (!enforce) return Number.POSITIVE_INFINITY;
      const result = await pool.query<{ service: string; calls: number }>('SELECT service, calls FROM amap_service_usage WHERE day = $1', [day(now()).day]);
      const used = new Map(result.rows.map(row => [row.service, row.calls]));
      return services.reduce((sum, service) => sum + Math.max(0, (limits[service] ?? 0) - (used.get(service) ?? 0)), 0);
    },
    /** 单个服务的当日剩余额度：POI 闸门只看 place，不能用全服务之和 */
    async remainingOf(service: string): Promise<number> {
      if (!enforce) return Number.POSITIVE_INFINITY;
      const { day: key } = day(now());
      const result = await pool.query<{ calls: number }>('SELECT calls FROM amap_service_usage WHERE day = $1 AND service = $2', [key, service]);
      return Math.max(0, (limits[service] ?? 0) - (result.rows[0]?.calls ?? 0));
    },
  };
}

export function createAmapQuotaLedger(
  pool: Pick<Pool, 'query'>,
  limits: Record<AmapService, number>,
  now = Date.now,
  options: ServiceQuotaLedgerOptions = {},
) {
  return createServiceQuotaLedger(pool, AMAP_SERVICES, limits, amapDay, now, options);
}
