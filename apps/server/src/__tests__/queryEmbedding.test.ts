import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueryEmbedder } from '../integrations/queryEmbedding';

const config = { baseUrl: 'https://embedding.test/v1', apiKey: 'site-test-key', model: 'test', dims: 1024 };
const response = () => new Response(JSON.stringify({ data: [{ embedding: Array(1024).fill(0.1) }] }));

test('在线embedding一次请求、无批间等待；同查询缓存成功向量且过期后重新获取', async () => {
  let calls = 0;
  let now = 0;
  const embed = createQueryEmbedder(config, { now: () => now, fetch: async () => { calls++; return response(); } });
  assert.equal((await embed(' 西湖  散步 '))?.length, 1024);
  await embed('西湖 散步');
  assert.equal(calls, 1);
  now = 600_001;
  await embed('西湖 散步');
  assert.equal(calls, 2);
});

test('HTTP失败不重试、不缓存；维度异常不采用', async () => {
  let calls = 0;
  const embed = createQueryEmbedder(config, { fetch: async () => { calls++; return new Response('{}', { status: 503 }); } });
  assert.equal(await embed('景点'), null);
  assert.equal(calls, 1);
  await embed('景点');
  assert.equal(calls, 2);
  const wrong = createQueryEmbedder(config, { fetch: async () => new Response(JSON.stringify({ data: [{ embedding: [1] }] })) });
  assert.equal(await wrong('景点'), null);
});

test('在线超时与调用方取消会中止HTTP，且不重试', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
  };
  // timeout使用unref定时器，keepAlive仅用于让无真实socket的测试等待它触发。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const embed = createQueryEmbedder(config, { fetch: fetcher, timeoutMs: 15 });
    assert.equal(await embed('超时'), null);
    assert.equal(calls, 1);
    const abort = new AbortController();
    const pending = embed('取消', abort.signal);
    abort.abort();
    assert.equal(await pending, null);
    assert.equal(calls, 2);
    assert.equal(await embed('已取消', abort.signal), null);
    assert.equal(calls, 2);
  } finally { clearInterval(keepAlive); }
});
