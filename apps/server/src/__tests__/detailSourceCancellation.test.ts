import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/client';
import { WebSearchSource } from '../integrations/websearch/searchSource';
import { AmapPoiSource } from '../integrations/amap/poiSource';
import { amapQuotaGate } from '../integrations/amap/request';

after(() => pool.end());

test('网页查询取消传到 HTTP，不把取消结果写入跨轮缓存', async () => {
  const original = globalThis.fetch;
  const source = new WebSearchSource('https://example.com', 'test');
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls > 1) return Response.json({ data: { webPages: { value: [{ name: '真实结果', url: 'https://example.com/source', summary: '资料' }] } } });
    started();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  };
  try {
    const request = source.search('取消后重试', controller.signal);
    await ready; controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    assert.equal((await source.search('取消后重试')).length, 1);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test('地点搜索的取消不污染缓存，重试可正常查询', async () => {
  const original = globalThis.fetch;
  // 高德配额闸门走 DB，测试里 stub 成恒放行（真实扣账在 amapQuotaLedger 单测覆盖）
  const originalAcquire = amapQuotaGate.acquire;
  amapQuotaGate.acquire = async () => ({ allowed: true, service: 'place', day: '0', used: 0, limit: 1, resetAt: 0 });
  const source = new AmapPoiSource('test');
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    if (calls === 1) {
      started();
      return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
    }
    return Response.json({ status: '1', pois: [{ name: '测试公园', type: '风景名胜;公园', address: '测试地址', location: '116.4,39.9' }] });
  };
  try {
    const request = source.searchPois('attraction', '公园', '北京', controller.signal);
    await ready; controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
    const retry = await source.searchPois('attraction', '公园', '北京');
    assert.equal(retry.length, 1);
    assert.equal(retry[0]?.name, '测试公园');
    assert.equal(calls, 2, '取消后重试只再发一次请求');
  } finally {
    globalThis.fetch = original;
    amapQuotaGate.acquire = originalAcquire;
  }
});
