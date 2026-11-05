// 单测：geocodeActivity 解析链降级顺序（mock fetch）——高德 POI text → v3 geocode → Nominatim+转换 → null
import { test } from 'node:test';
import './helpers/amapQuotaMock';
import assert from 'node:assert/strict';
import { geocodeActivity, parseAmapLocation } from '../integrations/amap/geocoder';

const originalFetch = globalThis.fetch;

/** 按 URL 分发的 mock fetch；记录命中端点顺序 */
function mockFetch(handlers: { match: string; body: unknown }[]): { hits: string[] } {
  const hits: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const handler = handlers.find((h) => url.includes(h.match));
    if (!handler) throw new Error(`未预期的请求：${url}`);
    hits.push(handler.match);
    return new Response(JSON.stringify(handler.body), { status: 200 });
  }) as typeof fetch;
  return { hits };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

const POI_OK = { status: '1', pois: [{ name: 'x', location: '116.4074,39.9042', adcode: '110101' }] };
const POI_EMPTY = { status: '1', pois: [] };
const GEOCODE_OK = { status: '1', geocodes: [{ location: '120.1552,30.2741', adcode: '330106' }] };
const GEOCODE_EMPTY = { status: '1', geocodes: [] };
const NOMINATIM_OK = [{ lat: '31.1774276', lon: '121.5272106' }];

test('解析链：v3 geocode 优先命中即止，不消耗 v5 的 5,000/月搜索配额', async () => {
  // v3（基础LBS服务，个人 150,000/月）优先于 v5（基础搜索服务，个人仅 5,000/月）
  const { hits } = mockFetch([{ match: 'v3/geocode/geo', body: GEOCODE_OK }]);
  const place = await geocodeActivity('k', '西湖A', '杭州');
  assert.ok(place);
  assert.equal(place.origin, 'amap-geocode');
  assert.equal(place.lat, 30.2741);
  assert.equal(place.lng, 120.1552);
  assert.equal(place.adcode, '330106');
  assert.deepEqual(hits, ['v3/geocode/geo'], 'v5 不该被调用（省下稀缺的搜索配额）');
});

test('解析链：v3 无结果 → v5 POI 定位兜底，标注 amap-poi', async () => {
  const { hits } = mockFetch([
    { match: 'v3/geocode/geo', body: GEOCODE_EMPTY },
    { match: 'v5/place/text', body: POI_OK },
  ]);
  const place = await geocodeActivity('k', '天安门B', '北京');
  assert.ok(place);
  assert.equal(place.origin, 'amap-poi');
  assert.equal(place.adcode, '110101');
  assert.deepEqual(hits, ['v3/geocode/geo', 'v5/place/text']);
});

test('解析链：高德两级皆失败 → Nominatim + wgs84ToGcj02 转换，标注 nominatim', async () => {
  const { hits } = mockFetch([
    { match: 'v5/place/text', body: POI_EMPTY },
    { match: 'v3/geocode/geo', body: GEOCODE_EMPTY },
    { match: 'nominatim', body: NOMINATIM_OK },
  ]);
  const place = await geocodeActivity('k', '外滩C', '上海');
  assert.ok(place);
  assert.equal(place.origin, 'nominatim');
  assert.equal(place.adcode, '');
  // 已转换为 GCJ-02：与原始 WGS-84 值不同，且偏差在 1e-4 内贴合已知向量
  assert.ok(Math.abs(place.lat - 31.17530398364597) < 1e-4);
  assert.ok(Math.abs(place.lng - 121.53154299111314) < 1e-4);
  assert.equal(hits[0], 'v3/geocode/geo');
  assert.equal(hits[1], 'v5/place/text');
  assert.ok(hits.slice(2).every((h) => h === 'nominatim'));
});

test('解析链：无 Key 时跳过高德直接 Nominatim', async () => {
  const { hits } = mockFetch([{ match: 'nominatim', body: NOMINATIM_OK }]);
  const place = await geocodeActivity(null, '豫园D', '上海');
  assert.ok(place);
  assert.equal(place.origin, 'nominatim');
  assert.ok(hits.every((h) => h === 'nominatim'));
});

test('解析链：tryAcquire 拒绝（任务上限/日额度）时跳过高德', async () => {
  const { hits } = mockFetch([{ match: 'nominatim', body: NOMINATIM_OK }]);
  const place = await geocodeActivity('k', '南京路E', '上海', () => false);
  assert.ok(place);
  assert.equal(place.origin, 'nominatim');
  assert.ok(hits.every((h) => h === 'nominatim'));
});

test('解析链：全链失败回 null（不抛错）', async () => {
  mockFetch([
    { match: 'v5/place/text', body: POI_EMPTY },
    { match: 'v3/geocode/geo', body: GEOCODE_EMPTY },
    { match: 'nominatim', body: [] },
  ]);
  const place = await geocodeActivity('k', '不存在的地方F', '乌有市');
  assert.equal(place, null);
});

test('parseAmapLocation：合法/非法坐标串', () => {
  assert.deepEqual(parseAmapLocation('116.4074,39.9042'), { lat: 39.9042, lng: 116.4074 });
  assert.equal(parseAmapLocation(''), null);
  assert.equal(parseAmapLocation('abc'), null);
  assert.equal(parseAmapLocation('0,0'), null);
  assert.equal(parseAmapLocation(undefined), null);
});
