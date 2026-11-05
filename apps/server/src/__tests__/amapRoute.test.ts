// 单测：高德路径规划适配层（mock fetch）——三模式解析 / 折线抽稀与超长丢弃 / 缓存命中 / transit 缺 adcode 降级
// + 任务级连续失败熔断（createRouteBreaker）：达阈值不再发请求不扣额度 / 成功清零计数 / 未发起的请求不计失败
import { test } from 'node:test';
import './helpers/amapQuotaMock';
import assert from 'node:assert/strict';
import { ROUTE_BREAKER_THRESHOLD } from '../integrations/routeBreaker';
import { downsamplePolyline } from '../lib/polyline';
import { createAmapRouteBreaker, routeEstimate } from '../integrations/amap/route';

const originalFetch = globalThis.fetch;

function mockFetchOnce(body: unknown): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('transit joins walking and first bus alternative in travel order', async () => {
  mockFetchOnce({ status: '1', route: { transits: [{ distance: '5000', cost: { duration: '1800' }, segments: [
    { walking: { steps: [{ polyline: '117,39;117.1,39.1' }] }, bus: { buslines: [{ polyline: '117.1,39.1;117.2,39.2' }, { polyline: '1,2;3,4' }] } },
  ] }] } });
  const r = await routeEstimate('k', { lat: 39, lng: 117 }, { lat: 39.2, lng: 117.2 }, 'transit', { city1: '110000', city2: '110000' });
  assert.equal(r?.polyline, '117,39;117.1,39.1;117.1,39.1;117.2,39.2');
});

test('route without duration is unavailable, not a fabricated one-minute option', async () => {
  mockFetchOnce({ status: '1', route: { paths: [{ distance: '9000' }] } });
  assert.equal(await routeEstimate('k', { lat: 39, lng: 118 }, { lat: 39.2, lng: 118.2 }, 'cycle'), null);
});

test('routeEstimate：walking 解析时长/距离/折线', async () => {
  const { calls } = mockFetchOnce({
    status: '1',
    route: {
      paths: [
        {
          distance: '1200',
          cost: { duration: '900' },
          steps: [{ polyline: '116.1,39.1;116.2,39.2' }, { polyline: '116.3,39.3' }],
        },
      ],
    },
  });
  const r = await routeEstimate('k', { lat: 39.1, lng: 116.1 }, { lat: 39.3, lng: 116.3 }, 'walk');
  assert.ok(r);
  assert.equal(r.durationMin, 15);
  assert.equal(r.distanceM, 1200);
  assert.equal(r.polyline, '116.1,39.1;116.2,39.2;116.3,39.3');
  assert.ok(calls[0]!.includes('/v5/direction/walking'));
});

test('routeEstimate：transit 解析（transits[0]），无折线', async () => {
  const { calls } = mockFetchOnce({
    status: '1',
    route: { transits: [{ distance: '5000', cost: { duration: '1800' } }] },
  });
  const r = await routeEstimate('k', { lat: 39.5, lng: 116.5 }, { lat: 39.6, lng: 116.6 }, 'transit', {
    city1: '110000',
    city2: '110000',
  });
  assert.ok(r);
  assert.equal(r.durationMin, 30);
  assert.equal(r.distanceM, 5000);
  assert.equal(r.polyline, undefined);
  assert.ok(calls[0]!.includes('transit%2Fintegrated') || calls[0]!.includes('transit/integrated'));
  assert.ok(calls[0]!.includes('city1=110000'));
});

test('routeEstimate：transit 缺 adcode 直接回 null，不发请求', async () => {
  const { calls } = mockFetchOnce({ status: '1' });
  const r = await routeEstimate('k', { lat: 31.1, lng: 121.1 }, { lat: 31.2, lng: 121.2 }, 'transit');
  assert.equal(r, null);
  assert.equal(calls.length, 0);
});

test('routeEstimate：driving 超长折线丢弃，仅留时长距离', async () => {
  // 构造 500 个长坐标点：抽稀后仍 >4000 字符 → polyline 丢弃
  const points = Array.from({ length: 500 }, (_, i) => `116.${String(i).padStart(9, '0')},39.${String(i).padStart(9, '0')}`);
  mockFetchOnce({
    status: '1',
    route: { paths: [{ distance: '30000', cost: { duration: '3600' }, steps: [{ polyline: points.join(';') }] }] },
  });
  const r = await routeEstimate('k', { lat: 39.9, lng: 116.9 }, { lat: 40.0, lng: 117.0 }, 'drive');
  assert.ok(r);
  assert.equal(r.durationMin, 60);
  assert.equal(r.distanceM, 30000);
  assert.equal(r.polyline, undefined);
});

test('routeEstimate：有效期内缓存命中，第二次不发请求', async () => {
  const { calls } = mockFetchOnce({
    status: '1',
    route: { paths: [{ distance: '800', cost: { duration: '600' }, steps: [] }] },
  });
  const origin = { lat: 22.1, lng: 113.1 };
  const dest = { lat: 22.2, lng: 113.2 };
  const first = await routeEstimate('k', origin, dest, 'walk');
  const second = await routeEstimate('k', origin, dest, 'walk');
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
});

test('routeEstimate：高德 status!=1 回 null（不抛错）', async () => {
  mockFetchOnce({ status: '0', info: 'INVALID_USER_KEY' });
  const r = await routeEstimate('k', { lat: 23.1, lng: 114.1 }, { lat: 23.2, lng: 114.2 }, 'walk');
  assert.equal(r, null);
});

test('routeEstimate：失败不做负缓存，同点对下次重试真实请求', async () => {
  const origin = { lat: 24.1, lng: 115.1 };
  const dest = { lat: 24.2, lng: 115.2 };
  mockFetchOnce({ status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' });
  assert.equal(await routeEstimate('k', origin, dest, 'walk'), null);
  // 换成功响应：若 null 被缓存，这里将拿到 null 且不发请求
  const { calls } = mockFetchOnce({
    status: '1',
    route: { paths: [{ distance: '900', cost: { duration: '600' }, steps: [] }] },
  });
  const retry = await routeEstimate('k', origin, dest, 'walk');
  assert.ok(retry, '瞬时失败恢复后应能拿到真实路由');
  assert.equal(retry.durationMin, 10);
  assert.equal(calls.length, 1, '重试应发起真实请求（证明失败未被缓存）');
});

test('downsamplePolyline：短折线原样保留，空输入回 undefined', () => {
  assert.equal(downsamplePolyline(['116.1,39.1', '116.2,39.2']), '116.1,39.1;116.2,39.2');
  assert.equal(downsamplePolyline([]), undefined);
  assert.equal(downsamplePolyline(['']), undefined);
});

test('downsamplePolyline：长折线抽稀后 ≤4000 字符且保留首尾点', () => {
  const points = Array.from({ length: 2000 }, (_, i) => `116.${i},39.${i}`);
  const out = downsamplePolyline(points);
  assert.ok(out);
  assert.ok(out.length <= 4000);
  assert.ok(out.startsWith('116.0,39.0'));
  assert.ok(out.endsWith('116.1999,39.1999'));
});

// ---------- 任务级连续失败熔断 createAmapRouteBreaker ----------
// 坐标空间用 25.x/26.x/27.x 段，避开其它用例的模块级 24h 成功缓存

test('createAmapRouteBreaker：连续失败达阈值熔断——不再发请求、不扣额度、warn 恰一条', async () => {
  const { calls } = mockFetchOnce({ status: '0', info: 'CUQPS_HAS_EXCEEDED_THE_LIMIT' });
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg?: unknown) => {
    warns.push(String(msg));
  };
  try {
    const breaker = createAmapRouteBreaker('k');
    let acquired = 0;
    const tryAcquire = () => {
      acquired += 1;
      return true;
    };
    // 每次换点对：证明计数按「连续失败次数」而非按点对（负缓存已拆，同点对本也会重试）
    for (let i = 0; i < ROUTE_BREAKER_THRESHOLD; i++) {
      const r = await breaker.estimate(
        { lat: 25.1 + i * 0.01, lng: 100.1 },
        { lat: 25.2 + i * 0.01, lng: 100.2 },
        'walk',
        {},
        tryAcquire,
      );
      assert.equal(r, null);
    }
    assert.equal(breaker.isOpen(), true, '连续失败达阈值应熔断');
    assert.equal(calls.length, ROUTE_BREAKER_THRESHOLD, '阈值之前每次都发起真实请求');
    assert.equal(acquired, ROUTE_BREAKER_THRESHOLD, '真实请求逐次扣额度');
    // 熔断后：直接回 null（上层走启发式），不发请求也不扣额度
    const after = await breaker.estimate({ lat: 25.8, lng: 100.8 }, { lat: 25.9, lng: 100.9 }, 'walk', {}, tryAcquire);
    assert.equal(after, null, '熔断后回 null，调用方降级启发式');
    assert.equal(calls.length, ROUTE_BREAKER_THRESHOLD, '熔断后不再发起真实请求');
    assert.equal(acquired, ROUTE_BREAKER_THRESHOLD, '熔断跳过的请求不消耗 route 额度');
    assert.equal(warns.filter((w) => w.includes('熔断')).length, 1, '跳变时刻记且仅记一条 warn');
  } finally {
    console.warn = originalWarn;
  }
});

test('createAmapRouteBreaker：中途一次成功清零连续失败计数', async () => {
  const breaker = createAmapRouteBreaker('k');
  mockFetchOnce({ status: '0', info: 'TIMEOUT' });
  for (let i = 0; i < ROUTE_BREAKER_THRESHOLD - 1; i++) {
    await breaker.estimate({ lat: 26.1 + i * 0.01, lng: 101.1 }, { lat: 26.2 + i * 0.01, lng: 101.2 }, 'walk', {}, () => true);
  }
  assert.equal(breaker.failStreak(), ROUTE_BREAKER_THRESHOLD - 1);
  assert.equal(breaker.isOpen(), false, '差一次未达阈值');
  // 一次成功：清零计数，熔断不开启
  mockFetchOnce({ status: '1', route: { paths: [{ distance: '1000', cost: { duration: '600' }, steps: [] }] } });
  const ok = await breaker.estimate({ lat: 26.5, lng: 101.5 }, { lat: 26.6, lng: 101.6 }, 'walk', {}, () => true);
  assert.ok(ok, '成功结果原样透传');
  assert.equal(breaker.failStreak(), 0, '成功清零连续失败计数');
  // 清零后再失败：从 1 重新计，不熔断
  const { calls } = mockFetchOnce({ status: '0', info: 'TIMEOUT' });
  await breaker.estimate({ lat: 26.7, lng: 101.7 }, { lat: 26.8, lng: 101.8 }, 'walk', {}, () => true);
  assert.equal(calls.length, 1, '清零后仍正常发起真实请求');
  assert.equal(breaker.failStreak(), 1);
  assert.equal(breaker.isOpen(), false);
});

test('createAmapRouteBreaker：额度拒绝与 transit 缺 adcode 不发请求、不计失败', async () => {
  const { calls } = mockFetchOnce({ status: '0', info: 'TIMEOUT' });
  const breaker = createAmapRouteBreaker('k');
  // 任务级上限拒绝：未发请求 → 不计连续失败
  assert.equal(await breaker.estimate({ lat: 27.1, lng: 102.1 }, { lat: 27.2, lng: 102.2 }, 'walk', {}, () => false), null);
  // transit 缺 adcode：在扣额度之前拦截 → 不扣额度、不计失败
  let acquired = 0;
  const r = await breaker.estimate({ lat: 27.3, lng: 102.3 }, { lat: 27.4, lng: 102.4 }, 'transit', {}, () => {
    acquired += 1;
    return true;
  });
  assert.equal(r, null);
  assert.equal(calls.length, 0, '两种拦截均不发真实请求');
  assert.equal(acquired, 0, '缺 adcode 在扣额度前拦截');
  assert.equal(breaker.failStreak(), 0, '未发起的请求不计连续失败');
  assert.equal(breaker.isOpen(), false);
});
