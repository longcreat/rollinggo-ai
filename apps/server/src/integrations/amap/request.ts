import type { FastifyBaseLogger } from 'fastify';
import type { ServiceQuotaDecision } from '../../lib/amapQuotaLedger';
import { AMAP_PATHS, amapDay, type AmapService } from './services';

// Lazy production binding keeps adapters importable without starting a DB connection.
export const amapQuotaGate = {
  async acquire(service: AmapService): Promise<ServiceQuotaDecision> {
    const { amapQuotaLedger } = await import('../../services/amapQuotaService');
    return amapQuotaLedger.acquire(service);
  },
};
let logger: Pick<FastifyBaseLogger, 'info' | 'warn'> | undefined;
export function setAmapLogger(value: Pick<FastifyBaseLogger, 'info' | 'warn'>) { logger = value; }

function report(level: 'info' | 'warn', data: Record<string, unknown>) {
  if (logger) logger[level]({ provider: 'amap', ...data }, '[amap-call]');
  else if (level === 'warn') console.warn('[amap-call]', JSON.stringify(data));
}

/** No raw URL, upstream body, address, coordinate or credential ever enters diagnostics. */
export async function amapRequest(service: AmapService, params: URLSearchParams, timeout = 10_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const started = Date.now();
  let decision: ServiceQuotaDecision;
  try {
    do { decision = await amapQuotaGate.acquire(service); }
    while (decision.allowed && decision.day !== amapDay().day);
  } catch {
    report('warn', { service, outcome: 'budget_store_error' });
    throw new Error('高德调用计量暂不可用');
  }
  if (!decision.allowed) {
    report('warn', { ...decision, outcome: 'local_budget_exhausted' });
    throw new Error(`高德 ${service} 今日调用预算已用完`);
  }
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(timeout);
    response = await fetch(`https://restapi.amap.com${AMAP_PATHS[service]}?${params}`, { signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal });
  } catch (error) {
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
    const info = typeof body?.info === 'string' && /^[A-Z_]{1,80}$/.test(body.info) ? body.info : 'UPSTREAM_REJECTED';
    report('warn', { service, outcome: 'upstream_rejected', infocode, info, used: decision.used, limit: decision.limit });
    throw new Error(`高德 ${info}`);
  }
  report('info', { service, outcome: 'success', used: decision.used, limit: decision.limit, durationMs: Date.now() - started });
  return body;
}
