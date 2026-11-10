// 高德 POI 2.0 字段契约：商业信息在 v5 叫 business（biz_ext 是 v3 名称，传了会被忽略）。
// 2026-11 实测：同一把个人 Key 传 show_fields=business 能拿到 rating/cost/opentime_week/tel。
import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { amapQuotaGate } from '@rollinggo-trip/integrations/amap/request';
import { AmapPoiSource, mapPoi } from '@rollinggo-trip/integrations/amap/poiSource';
import { amapDay } from '@rollinggo-trip/core/amapServices';

afterEach(() => { mock.restoreAll(); });

const allowed = () => ({ ...amapDay(), service: 'place' as const, allowed: true, used: 1, limit: 161 });

/** 故宫博物院的真实响应形状（2026-11 抓取，仅保留断言用到的字段）。 */
const FORBIDDEN_CITY_POI = {
  name: '故宫博物院',
  type: '风景名胜;风景名胜;世界遗产',
  address: '景山前街4号',
  location: '116.397029,39.918052',
  adcode: '110101',
  business: {
    keytag: '5A景区',
    rating: '4.9',
    alias: '紫禁城',
    tel: '4009501925',
    rectag: '沧桑紫禁城',
    opentime_week: '旺季4月1日至10月31日 周二至周日 08:30-17:00',
  },
  photos: [{ title: '故宫', url: 'https://store.is.autonavi.com/showpic/abc' }],
};

test('mapPoi：解析 v5 business 的评分/人均/营业时间/电话', () => {
  const poi = mapPoi(FORBIDDEN_CITY_POI);
  assert.ok(poi);
  assert.equal(poi.rating, '4.9');
  assert.equal(poi.opentime, '旺季4月1日至10月31日 周二至周日 08:30-17:00');
  assert.equal(poi.tel, '4009501925');
  assert.equal(poi.cost, '', '景区没有人均消费，空串而不是 undefined');
  assert.equal(poi.type, '世界遗产', 'type 取最细一级');
  assert.deepEqual(poi.location, { lat: 39.918052, lng: 116.397029 });
  assert.deepEqual(poi.photoUrls, ['https://store.is.autonavi.com/showpic/abc']);
});

test('mapPoi：营业时间按周描述 → 今日 → v3 open_time 依次回退', () => {
  const week = mapPoi({ name: 'A', business: { opentime_week: '周一至周日 09:00-18:00', opentime_today: '09:00-12:00' } });
  assert.equal(week?.opentime, '周一至周日 09:00-18:00');
  const today = mapPoi({ name: 'B', business: { opentime_today: '11:00-14:00' } });
  assert.equal(today?.opentime, '11:00-14:00');
  const legacy = mapPoi({ name: 'C', biz_ext: { open_time: '08:00-17:00' } });
  assert.equal(legacy?.opentime, '08:00-17:00', 'v3 形状的历史数据仍可解析');
});

test('mapPoi：图片 http 归一为 https，非安全 URL 不外泄', () => {
  const poi = mapPoi({
    name: '西湖',
    photos: [
      { url: 'http://store.is.autonavi.com/showpic/a' },
      { url: 'https://store.is.autonavi.com/showpic/b' },
      { url: 'ftp://example.com/c.png' },
      { url: 'http://store.is.autonavi.com/showpic/a' },
    ],
  });
  assert.deepEqual(poi?.photoUrls, [
    'https://store.is.autonavi.com/showpic/a',
    'https://store.is.autonavi.com/showpic/b',
  ]);
});

test('mapPoi：无商业信息时字段为空串，不抛错', () => {
  const poi = mapPoi({ name: '某路口', type: '交通设施服务;路口', location: '120.1,30.2' });
  assert.ok(poi);
  assert.deepEqual(
    [poi.rating, poi.cost, poi.opentime, poi.tel],
    ['', '', '', ''],
  );
  assert.deepEqual(poi.photoUrls, []);
});

test('请求携带 show_fields=business,photos，且不再发 biz_ext', async () => {
  mock.method(amapQuotaGate, 'acquire', async () => allowed());
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ status: '1', pois: [FORBIDDEN_CITY_POI] }));
  });

  const pois = await new AmapPoiSource('test-key').searchPois('attraction', '故宫', '北京');
  assert.equal(pois.length, 1);
  assert.equal(pois[0]!.rating, '4.9');

  const query = new URL(urls[0]!).searchParams;
  assert.equal(query.get('show_fields'), 'business,photos');
  assert.equal(query.get('city_limit'), 'true');
});

test('CUQPS 瞬时超限（10021）自动退避重试一次', async () => {
  const gate = mock.method(amapQuotaGate, 'acquire', async () => allowed());
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT', infocode: '10021' }));
    }
    return new Response(JSON.stringify({ status: '1', pois: [] }));
  });

  const pois = await new AmapPoiSource('test-key').searchPois('attraction', '灵隐寺', '杭州');
  assert.deepEqual(pois, []);
  assert.equal(calls, 2, '第二次请求被发出');
  assert.equal(gate.mock.callCount(), 2, '重试也要重新预扣配额，账实一致');
});

test('连续 CUQPS 超限只重试一次，随后正常抛出', async () => {
  mock.method(amapQuotaGate, 'acquire', async () => allowed());
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(JSON.stringify({ status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT', infocode: '10021' }));
  });

  await assert.rejects(new AmapPoiSource('test-key').searchPois('attraction', '宋城', '杭州'), /CUQPS/);
  assert.equal(calls, 2, '不做无限重试');
});
