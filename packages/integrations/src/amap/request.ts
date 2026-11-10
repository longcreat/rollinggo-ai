import type { FastifyBaseLogger } from 'fastify';
import type { ServiceQuotaDecision } from '@tripweaver/core/lib/amapQuotaLedger';
import { AMAP_PATHS, amapDay, type AmapService } from '@tripweaver/core/amapServices';

// Lazy production binding keeps adapters importable without starting a DB connection.
export const amapQuotaGate = {
  async acquire(service: AmapService): Promise<ServiceQuotaDecision> {
    const { amapQuotaLedger } = await import('@tripweaver/core/amapQuotaService');
    return amapQuotaLedger.acquire(service);
  },
};
let logger: Pick<FastifyBaseLogger, 'info' | 'warn'> | undefined;
export function setAmapLogger(value: Pick<FastifyBaseLogger, 'info' | 'warn'>) { logger = value; }

function report(level: 'info' | 'warn', data: Record<string, unknown>) {
  if (logger) logger[level]({ provider: 'amap', ...data }, '[amap-call]');
  else if (level === 'warn') console.warn('[amap-call]', JSON.stringify(data));
}

/** 个人认证 Key 的每秒并发上限（CUQPS_HAS_EXCEEDED_THE_LIMIT）：瞬时拒绝，退避后可恢复。 */
const CUQPS_INFOCODE = '10021';
const CUQPS_RETRY_DELAY_MS = 800;
/** 只计量模式下，超额提醒按「服务 + 自然日」去重，避免每次外呼一条 warn。 */
const overBudgetWarned = new Set<string>();

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(signal?.reason); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** No raw URL, upstream body, address, coordinate or credential ever enters diagnostics. */
export async function amapRequest(service: AmapService, params: URLSearchParams, timeout = 10_000, signal?: AbortSignal, path?: string): Promise<Record<string, unknown>> {
  // 最多两轮：第二轮只发生在 CUQPS 瞬时超限（10021）时。
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted();
    const started = Date.now();
    let decision: ServiceQuotaDecision;
    try {
      // 账本在午夜前后可能按旧自然日预扣，重取一次即可；不设上限会在时钟/账本异常时死循环并持续打库。
      for (let dayRetry = 0; ; dayRetry += 1) {
        decision = await amapQuotaGate.acquire(service);
        if (!decision.allowed || decision.day === amapDay().day) break;
        if (dayRetry >= 1) throw new Error('高德调用计量日期不一致');
      }
    } catch {
      report('warn', { service, outcome: 'budget_store_error' });
      throw new Error('高德调用计量暂不可用');
    }
    if (!decision.allowed) {
      report('warn', { ...decision, outcome: 'local_budget_exhausted' });
      throw new Error(`高德 ${service} 今日调用预算已用完`);
    }
    // 关闭拦截后仍保留超额可见性：每种服务每天只提醒一次，不刷屏。
    if (decision.used > decision.limit) {
      const key = `${decision.day}:${decision.service}`;
      if (!overBudgetWarned.has(key)) {
        overBudgetWarned.add(key);
        report('warn', { ...decision, outcome: 'over_budget' });
      }
    }
    let response: Response;
    try {
      const timeoutSignal = AbortSignal.timeout(timeout);
      response = await fetch(`https://restapi.amap.com${path ?? AMAP_PATHS[service]}?${params}`, { signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
    } catch (error) {
      // 取消要穿透成 AbortError：调用方靠它区分「用户取消」与「上游失败」，不能伪装成后者。
      signal?.throwIfAborted();
      report('warn', { service, outcome: error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network_error', used: decision.used, limit: decision.limit, durationMs: Date.now() - started });
      throw new Error('高德请求失败');
    }
    if (!response.ok) {
      report('warn', { service, outcome: 'http_error', httpStatus: response.status, used: decision.used, limit: decision.limit });
      throw new Error(`高德 HTTP ${response.status}`);
    }
    let body: Record<string, unknown>;
    try { body = await response.json() as Record<string, unknown>; }
    catch { report('warn', { service, outcome: 'invalid_json' }); throw new Error('高德响应格式异常'); }
    if (!body || typeof body !== 'object' || body.status !== '1') {
      const infocode = typeof body?.infocode === 'string' && /^\d{1,8}$/.test(body.infocode) ? body.infocode : undefined;
      // 瞬时 QPS 超限不是故障：未被上游受理，退避后重试一次即可（重新走一遍配额预扣，账实一致）。
      if (attempt === 0 && infocode === CUQPS_INFOCODE) {
        report('warn', { service, outcome: 'qps_retry', used: decision.used, limit: decision.limit });
        await wait(CUQPS_RETRY_DELAY_MS, signal);
        continue;
      }
      const info = typeof body?.info === 'string' && /^[A-Z_]{1,80}$/.test(body.info) ? body.info : 'UPSTREAM_REJECTED';
      report('warn', { service, outcome: 'upstream_rejected', infocode, info, used: decision.used, limit: decision.limit });
      throw new Error(`高德 ${info}`);
    }
    report('info', { service, outcome: 'success', used: decision.used, limit: decision.limit, durationMs: Date.now() - started });
    return body;
  }
}
