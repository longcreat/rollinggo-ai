// 片区检索：多边形 / 周边两种走法共用 place 配额，返回形状与文本检索一致。
import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { amapQuotaGate } from '../integrations/amap/request';
import { circlePolygon, closeRing, searchAreaPois } from '../integrations/amap/placeArea';
import { amapDay } from '../integrations/amap/services';

afterEach(() => { mock.restoreAll(); });

const allowed = () => ({ ...amapDay(), service: 'place' as const, allowed: true, used: 1, limit: 161 });

function poi(name: string, location: string) {
  return { name, type: '风景名胜;风景名胜;公园', location, business: { opentime_week: '周一至周日 08:00-18:00' } };
}

test('circlePolygon：生成闭合正多边形，各点距圆心约等于半径', () => {
  const ring = circlePolygon({ lat: 30.2437, lng: 120.1479 }, 1000, 12).split('|');
  assert.equal(ring.length, 12);
  for (const point of ring) {
    const [lng, lat] = point.split(',').map(Number) as [number, number];
    const dy = (lat - 30.2437) * 111_320;
    const dx = (lng - 120.1479) * 111_320 * Math.cos((30.2437 * Math.PI) / 180);
    assert.ok(Math.abs(Math.hypot(dx, dy) - 1000) < 3, `点到圆心距离应约 1000m：${Math.hypot(dx, dy)}`);
  }
});

test('closeRing：开放折线自动补首点，少于 3 点拒绝', () => {
  assert.equal(closeRing('120.1,30.1|120.2,30.1|120.2,30.2'), '120.1,30.1|120.2,30.1|120.2,30.2|120.1,30.1');
  assert.equal(closeRing('120.1,30.1|120.2,30.1|120.1,30.1'), '120.1,30.1|120.2,30.1|120.1,30.1');
  assert.throws(() => closeRing('120.1,30.1|120.2,30.1'), /至少需要 3 个点/);
});

test('多边形检索走 /v5/place/polygon，参数为闭合环', async () => {
  mock.method(amapQuotaGate, 'acquire', async () => allowed());
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ status: '1', pois: [poi('断桥残雪', '120.1510,30.2580')] }));
  });

  const pois = await searchAreaPois('test-key', {
    city: '杭州', polygon: '120.14,30.24|120.15,30.24|120.15,30.25', keywords: '景点', pageSize: 30,
  });
  assert.equal(pois.length, 1);
  assert.equal(pois[0]!.name, '断桥残雪');
  assert.equal(pois[0]!.opentime, '周一至周日 08:00-18:00');

  const url = new URL(urls[0]!);
  assert.equal(url.pathname, '/v5/place/polygon');
  assert.equal(url.searchParams.get('polygon'), '120.14,30.24|120.15,30.24|120.15,30.25|120.14,30.24');
  assert.equal(url.searchParams.get('page_size'), '25', '页大小封顶 25');
  assert.equal(url.searchParams.get('show_fields'), 'business,photos');
});

test('周边检索走 /v5/place/around，radius 有上下限', async () => {
  mock.method(amapQuotaGate, 'acquire', async () => allowed());
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ status: '1', pois: [] }));
  });

  await searchAreaPois('test-key', { city: '杭州', center: { lat: 30.2437, lng: 120.1479 }, radiusM: 5_000 });
  await searchAreaPois('test-key', { city: '杭州', center: { lat: 30.2437, lng: 120.1479 }, radiusM: 999_999 });

  const first = new URL(urls[0]!);
  assert.equal(first.pathname, '/v5/place/around');
  assert.equal(first.searchParams.get('location'), '120.1479,30.2437');
  assert.equal(first.searchParams.get('radius'), '5000');
  const second = new URL(urls[1]!);
  assert.equal(second.searchParams.get('radius'), '50000', '半径封顶 50km');
});

test('同名同坐标去重；缺坐标的点保留', async () => {
  mock.method(amapQuotaGate, 'acquire', async () => allowed());
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    status: '1',
    pois: [
      poi('苏堤春晓', '120.1360,30.2380'),
      poi('苏堤春晓', '120.1360,30.2380'),
      poi('花港观鱼', '120.1390,30.2300'),
      { name: '无名点' },
    ],
  })));

  const pois = await searchAreaPois('test-key', { city: '杭州', polygon: '120.13,30.23|120.15,30.23|120.15,30.25' });
  assert.deepEqual(pois.map((item) => item.name), ['苏堤春晓', '花港观鱼', '无名点']);
});

test('同一查询命中缓存，不重复发请求', async () => {
  mock.method(amapQuotaGate, 'acquire', async () => allowed());
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response(JSON.stringify({ status: '1', pois: [] }));
  });

  const query = { city: '杭州', center: { lat: 30.2, lng: 120.1 }, radiusM: 1200 };
  await searchAreaPois('test-key', query);
  await searchAreaPois('test-key', query);
  assert.equal(calls, 1);
});
