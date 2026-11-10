import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '@rollinggo-trip/core/db/client';
import { WebSearchSource } from '@rollinggo-trip/integrations/websearch/searchSource';
import { AmapPoiSource } from '@rollinggo-trip/integrations/amap/poiSource';
import { amapQuotaGate } from '@rollinggo-trip/integrations/amap/request';
import { amapDay } from '@rollinggo-trip/core/amapServices';

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
    if (calls > 1) return Response.json({ results: [{ title: '真实结果', url: 'https://example.com/source', content: '资料' }] });
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

test('WebSearchSource (Tavily) 规范请求构造与透传', async () => {
  const original = globalThis.fetch;
  const source = new WebSearchSource('https://api.tavily.com', 'test-key');
  let capturedUrl = '';
  let capturedHeaders: any = null;
  let capturedBody: any = null;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(init!.body as string);
    return Response.json({
      answer: '杭州今日阳光明媚',
      results: [{ title: '今日杭州新闻', url: 'https://example.com/hz', content: '要闻速递', published_date: '2026-11-09' }],
    });
  };
  try {
    const hits = await source.search('搜索今天杭州的新闻', undefined, { topic: 'news' });
    assert.equal(capturedUrl, 'https://api.tavily.com/search');
    assert.equal(capturedHeaders?.authorization, 'Bearer test-key');
    assert.equal(capturedBody?.query, '搜索今天杭州的新闻');
    assert.equal(capturedBody?.topic, 'news');
    assert.equal(capturedBody?.include_answer, true);

    // 验证 answer 会作为首条摘要前置返回
    assert.equal(hits[0]?.title, 'Tavily 智能事实综述');
    assert.equal(hits[0]?.summary, '杭州今日阳光明媚');
    assert.equal(hits[1]?.title, '今日杭州新闻');
  } finally { globalThis.fetch = original; }
});

test('WebSearchSource (Tavily) extract 网页正文提取与缓存', async () => {
  const original = globalThis.fetch;
  const source = new WebSearchSource('https://api.tavily.com', 'test-key');
  let capturedUrl = '';
  let capturedBody: any = null;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    capturedUrl = String(url);
    capturedBody = JSON.parse(init!.body as string);
    return Response.json({
      results: [{
        title: '冷空气降温通报',
        url: 'https://example.com/hz-weather-news',
        raw_content: '# 杭州气温骤降\n\n今日平原地区降温明显...',
      }],
    });
  };
  try {
    const page = await source.extract('https://example.com/hz-weather-news');
    assert.equal(capturedUrl, 'https://api.tavily.com/extract');
    assert.equal(capturedBody?.urls?.[0], 'https://example.com/hz-weather-news');
    assert.equal(capturedBody?.format, 'markdown');
    assert.equal(page?.title, '冷空气降温通报');
    assert.ok(page?.content.includes('今日平原地区降温明显'));

    // 第二次调用应命中内存缓存，不重复发网络请求
    const cached = await source.extract('https://example.com/hz-weather-news');
    assert.equal(cached?.title, '冷空气降温通报');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('地点搜索的取消不污染缓存，重试可正常查询', async () => {
  const original = globalThis.fetch;
  // 高德配额闸门走 DB，测试里 stub 成恒放行（真实扣账在 amapQuotaLedger 单测覆盖）
  const originalAcquire = amapQuotaGate.acquire;
  amapQuotaGate.acquire = async () => ({ allowed: true, service: 'place', day: amapDay().day, used: 0, limit: 1, resetAt: 0 });
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
