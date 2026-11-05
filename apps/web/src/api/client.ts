import { isApiResponse, type ApiCode } from '@tripweaver/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> | null = null,
    public code: ApiCode = status,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  timeoutMs?: number;
  /** 登录/注册失败留在表单内处理。 */
  auth?: 'required' | 'public';
}

const unauthorizedListeners = new Set<() => void>();
let authExpired = false;
let authEpoch = 0;

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}

/** 登录成功后解除去重；忽略上一个会话尚未结束的请求所返回的 401。 */
export function resetAuthState(): void { authExpired = false; authEpoch++; }

export function shouldRetryQuery(count: number, error: unknown): boolean {
  return count < 1 && error instanceof ApiError &&
    (error.code === 'network_error' || error.code === 'timeout' || error.status >= 500);
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  if (!response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new ApiError(response.status, response.ok ? '服务器响应格式不正确' : `请求失败（${response.status}）`, null, 'invalid_response');
  }
  const body: unknown = await response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) throw new ApiError(response.status, '服务器响应格式不正确', null, 'invalid_response');
    throw error;
  });
  if (!isApiResponse(body)) throw new ApiError(response.status, '服务器响应格式不正确', null, 'invalid_response');
  if (!response.ok || body.code !== 0) {
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data as Record<string, unknown> : null;
    throw new ApiError(response.status, body.message || '请求失败', data, body.code || response.status);
  }
  return body.data;
}

async function request<T>(path: string, init: RequestInit, options: RequestOptions, consume: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const epoch = authEpoch;
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), options.timeoutMs ?? 30_000);
  const headers = new Headers(options.headers);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  try {
    const response = await fetch(path, { ...init, credentials: 'same-origin', headers, signal });
    // 先处理状态，401 即使被网关替换成 HTML 也应触发会话失效。
    if (response.status === 401 && options.auth !== 'public' && epoch === authEpoch && !authExpired) {
      authExpired = true;
      unauthorizedListeners.forEach((listener) => listener());
    }
    return await consume(response);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (controller.signal.aborted) throw new ApiError(0, '请求超时，请稍后重试', null, 'timeout');
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, '网络连接失败，请检查网络后重试', null, 'network_error');
  } finally { clearTimeout(timer); }
}

function json<T>(path: string, init: RequestInit = {}, options: RequestOptions = {}): Promise<T> {
  // 外层已做运行时校验；T 对应各端点业务契约，复杂业务仍在调用方验证 schema。
  return request(path, init, options, readResponse) as Promise<T>;
}

/** 与普通请求共用建连拦截，流建立后释放建连计时器，取消信号继续有效。 */
export function requestStream(path: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'text/event-stream');
  return request(path, { method: 'POST', body: JSON.stringify(body) }, { ...options, headers }, async (response) => {
    if (!response.ok) await readResponse(response);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new ApiError(response.status, '未收到有效的回答流', null, 'invalid_response');
    }
    return response;
  });
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => json<T>(path, {}, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    json<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, options),
  put: <T>(path: string, body: unknown, options?: RequestOptions) => json<T>(path, { method: 'PUT', body: JSON.stringify(body) }, options),
  patch: <T>(path: string, body: unknown, options?: RequestOptions) => json<T>(path, { method: 'PATCH', body: JSON.stringify(body) }, options),
  del: <T>(path: string, options?: RequestOptions) => json<T>(path, { method: 'DELETE' }, options),
};
