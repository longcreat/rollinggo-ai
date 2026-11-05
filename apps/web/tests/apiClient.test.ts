import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { api, ApiError, onUnauthorized, resetAuthState, requestStream, shouldRetryQuery } from '../src/api/client';

test('请求合并头、携带 Cookie，JSON 响应解包且不重复包业务 data', async (t) => {
  const fetch = mock.method(globalThis, 'fetch', async (_path, init) => {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers.get('Content-Type'), 'application/json');
    assert.equal(init.headers.get('X-Request-Id'), 'fixture');
    assert.deepEqual(JSON.parse(init.body), { title: '北京' });
    return Response.json({ code: 0, message: '成功', data: { data: [1, 2] } }, { status: 201 });
  });
  t.after(() => fetch.mock.restore());
  assert.deepEqual(await api.post('/api/trips', { title: '北京' }, { headers: { 'X-Request-Id': 'fixture' } }), { data: [1, 2] });
});

test('业务错误保留 HTTP 状态、业务码和数据；200 的非零 code 也拒绝', async (t) => {
  let status = 429;
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ code: 'quota_exhausted', message: '次数已用完', data: { resetAt: 123 } }, { status }));
  t.after(() => fetch.mock.restore());
  const verify = (error: unknown) => error instanceof ApiError && error.status === status && error.code === 'quota_exhausted' && error.message === '次数已用完' && error.data?.resetAt === 123;
  await assert.rejects(api.get('/api/usage'), verify);
  status = 200;
  await assert.rejects(api.get('/api/usage'), verify);
});

test('拒绝旧响应、无 data、畸形 JSON 和 HTML，不把它们转换成成功 null', async (t) => {
  const responses = [Response.json({ id: 'old' }), Response.json({ code: 0, message: 'missing data' }), new Response('{', { headers: { 'content-type': 'application/json' } }), new Response('<html/>')];
  const fetch = mock.method(globalThis, 'fetch', async () => responses.shift()!);
  t.after(() => fetch.mock.restore());
  for (let i = 0; i < 4; i++) await assert.rejects(api.get('/api/trips'), (error: unknown) => error instanceof ApiError && error.code === 'invalid_response');
});

test('204 无实体返回 null', async (t) => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  t.after(() => fetch.mock.restore());
  assert.equal(await api.del('/api/trips/old'), null);
});

test('并发 401 只通知一次，登录失败不触发，登录后可再次失效，旧会话不干扰新会话', async (t) => {
  resetAuthState();
  let notifications = 0;
  const unsubscribe = onUnauthorized(() => { notifications++; });
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('<html>expired</html>', { status: 401 }));
  t.after(() => { fetch.mock.restore(); unsubscribe(); resetAuthState(); });
  await assert.rejects(api.post('/api/auth/login', {}, { auth: 'public' }));
  assert.equal(notifications, 0);
  await Promise.allSettled([api.get('/api/trips'), api.get('/api/settings')]);
  assert.equal(notifications, 1);
  resetAuthState();
  await assert.rejects(api.get('/api/trips'));
  assert.equal(notifications, 2);
  let resolve!: (response: Response) => void;
  fetch.mock.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
  const old = api.get('/api/old');
  resetAuthState();
  resolve(Response.json({ code: 401, message: '旧会话', data: null }, { status: 401 }));
  await assert.rejects(old);
  assert.equal(notifications, 2);
});

test('网络失败、超时和主动取消分别处理，写入不自动重试', async (t) => {
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  t.after(() => fetch.mock.restore());
  await assert.rejects(api.post('/api/trips', {}), (e: unknown) => e instanceof ApiError && e.code === 'network_error');
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async (_path, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(init.signal.reason);
    else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }));
  await assert.rejects(api.get('/api/trips', { timeoutMs: 5 }), (e: unknown) => e instanceof ApiError && e.code === 'timeout');
  const controller = new AbortController();
  const pending = api.get('/api/trips', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof DOMException && e.name === 'AbortError');
  assert.equal(shouldRetryQuery(0, new ApiError(401, 'expired')), false);
  assert.equal(shouldRetryQuery(0, new ApiError(429, 'quota')), false);
  assert.equal(shouldRetryQuery(0, new ApiError(503, 'unavailable')), true);
  assert.equal(shouldRetryQuery(1, new ApiError(503, 'unavailable')), false);
});

test('超时覆盖 JSON body 读取；SSE 建连错误解包，成功后保持原帧', async (t) => {
  const fetch = mock.method(globalThis, 'fetch', async (_path, init) => new Response(new ReadableStream({
    start(controller) { init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true }); },
  }), { headers: { 'content-type': 'application/json' } }));
  t.after(() => fetch.mock.restore());
  await assert.rejects(api.get('/api/slow-body', { timeoutMs: 5 }), (e: unknown) => e instanceof ApiError && e.code === 'timeout');
  fetch.mock.mockImplementation(async () => Response.json({ code: 'no_llm', message: '请配置 AI', data: { hasSiteKey: false } }, { status: 400 }));
  await assert.rejects(requestStream('/api/messages/stream', {}), (e: unknown) => e instanceof ApiError && e.code === 'no_llm' && e.data?.hasSiteKey === false);
  fetch.mock.mockImplementation(async (_path, init) => {
    assert.equal(init.headers.get('Accept'), 'text/event-stream');
    return new Response('data: {"type":"done"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.equal(await (await requestStream('/api/messages/stream', {})).text(), 'data: {"type":"done"}\n\n');
});
