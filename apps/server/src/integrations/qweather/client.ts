import type { FastifyBaseLogger } from 'fastify';
import type { QuotaDay, ServiceQuotaDecision } from '../../lib/amapQuotaLedger';
import { qweatherAuthHeader, type QWeatherAuth } from './auth';

/** 和风与高德共用 amap_service_usage 这张通用 (day, service, calls) 计数器，靠 service 取值隔离。 */
export const QWEATHER_SERVICE = 'qweather';

/** 和风按中国 UTC+8 自然日重置，与高德账本同一口径。 */
export function qweatherDay(now = Date.now()): QuotaDay {
  const start = Math.floor((now + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  return { day: String(start), start, resetAt: start + 86400_000 };
}

// Lazy production binding keeps adapters importable without starting a DB connection.
export const qweatherQuotaGate = {
  async acquire(): Promise<ServiceQuotaDecision> {
    const { qweatherQuotaLedger } = await import('../../services/qweatherQuotaService');
    return qweatherQuotaLedger.acquire(QWEATHER_SERVICE);
  },
};

let logger: Pick<FastifyBaseLogger, 'info' | 'warn'> | undefined;
export function setQWeatherLogger(value: Pick<FastifyBaseLogger, 'info' | 'warn'>) { logger = value; }

function report(level: 'info' | 'warn', data: Record<string, unknown>) {
  if (logger) logger[level]({ provider: 'qweather', ...data }, '[qweather-call]');
  else if (level === 'warn') console.warn('[qweather-call]', JSON.stringify(data));
}

/** API Host 是控制台分配的专属域名；只允许主机名形态，防止被拼出非预期 URL。 */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** 固定 https://<api-host><path>。凭据走请求头（X-QW-Api-Key 或 Authorization），不进 URL；
 * 路径、查询串与上游响应体一律不入诊断；认证方式入诊断，便于区分 401 是配错还是过期。 */
export async function qweatherRequest(host: string, path: string, params: URLSearchParams, auth: QWeatherAuth, timeout = 5_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  if (!HOST_PATTERN.test(host)) throw new Error('和风 API Host 格式不正确');
  const started = Date.now();
  const mode = auth.mode;
  let headers: Record<string, string>;
  try { headers = qweatherAuthHeader(auth); }
  catch {
    // 报错只说该说清什么、不说密钥内容：这是配置问题里最常见的一个。
    const reason = auth.mode === 'jwt' && !auth.privateKey.includes('-----BEGIN')
      ? '私钥缺少 -----BEGIN PRIVATE KEY----- 开头'
      : '私钥无法解析，请确认是 Ed25519 私钥（openssl genpkey -algorithm ED25519）';
    report('warn', { path, mode, outcome: 'auth_error' });
    throw new Error(`和风凭据不可用：${reason}`);
  }
  let decision: ServiceQuotaDecision;
  try {
    do { decision = await qweatherQuotaGate.acquire(); }
    while (decision.allowed && decision.day !== qweatherDay().day);
  } catch {
    report('warn', { path, mode, outcome: 'budget_store_error' });
    throw new Error('和风调用计量暂不可用');
  }
  if (!decision.allowed) {
    report('warn', { path, mode, outcome: 'local_budget_exhausted', used: decision.used, limit: decision.limit });
    throw new Error('和风天气今日调用预算已用完');
  }
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(timeout);
    response = await fetch(`https://${host}${path}?${params}`, {
      headers,
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
  } catch (error) {
    report('warn', { path, mode, outcome: error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network_error', used: decision.used, limit: decision.limit, durationMs: Date.now() - started });
    throw new Error('和风请求失败');
  }
  if (!response.ok) {
    report('warn', { path, mode, outcome: 'http_error', httpStatus: response.status, used: decision.used, limit: decision.limit });
    throw new Error(`和风 HTTP ${response.status}`);
  }
  let body: Record<string, unknown>;
  try { body = await response.json() as Record<string, unknown>; }
  catch { report('warn', { path, mode, outcome: 'invalid_json' }); throw new Error('和风响应格式异常'); }
  if (!body || typeof body !== 'object' || body.code !== '200') {
    const code = typeof body?.code === 'string' && /^\d{1,4}$/.test(body.code) ? body.code : 'UNKNOWN';
    report('warn', { path, mode, outcome: 'upstream_rejected', code, used: decision.used, limit: decision.limit });
    throw new Error(`和风 ${code}`);
  }
  report('info', { path, mode, outcome: 'success', used: decision.used, limit: decision.limit, durationMs: Date.now() - started });
  return body;
}
