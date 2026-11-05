import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GenerateForm, ResearchPoi } from '@tripweaver/shared';
import { DraftTrip, type DraftActivityInput } from '../generation/draft';
import { rememberResearchLocation, type ResearchLocation } from '../generation/placeLookup';

// geoPipeline loads settings/quota storage. Isolate env BEFORE importing that boundary;
// every provider request below is intercepted, including the Nominatim fallback.
const ownedDir = mkdtempSync(join(tmpdir(), 'tripweaver-geo-p0-'));
const testEnv = {
  DOTENV_CONFIG_PATH: join(ownedDir, 'absent.env'),
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/tripweaver_test',
  MASTER_KEY: 'a'.repeat(64),
  AMAP_KEY: 'geo-p0-mock-key',
  AMAP_DAILY_BUDGET: '10000',
  SITE_LLM_BASE_URL: '', SITE_LLM_API_KEY: '', SITE_LLM_MODEL: '',
  SEARCH_API_KEY: '', SEARCH_API_BASE_URL: '',
  REGISTRATION_MODE: 'open', INVITE_CODE: '',
  GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', APP_BASE_URL: '',
};
const savedEnv = new Map(Object.keys(testEnv).map((key) => [key, process.env[key]]));
Object.assign(process.env, testEnv);

const originalFetch = globalThis.fetch;
let unexpectedRequests: string[] = [];
globalThis.fetch = async () => { throw new Error('Test provider mock must be installed'); };
const { createGeoSession } = await import('../generation/geoPipeline');
const { pool } = await import('../db/client');

test.afterEach(() => {
  assert.deepEqual(unexpectedRequests, [], '所有外呼必须经过已知的模拟适配器');
  unexpectedRequests = [];
});
test.after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
  rmdirSync(ownedDir);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function mockProviders(points: ReadonlyMap<string, ResearchLocation>, onRequest?: (url: URL) => void): URL[] {
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    onRequest?.(url);
    if (url.hostname === 'restapi.amap.com') {
      if (url.pathname === '/v5/place/text') {
        const name = url.searchParams.get('keywords') ?? '';
        const point = points.get(name);
        return Response.json({ status: '1', pois: point ? [{ name, location: `${point.lng},${point.lat}`, adcode: point.adcode }] : [] });
      }
      if (url.pathname === '/v3/geocode/geo') {
        // 定位链主路径 09-26 起是 v3（地理编码属「基础LBS服务」，个人 150,000/月；v5 搜索仅 5,000/月）。
        // 与 v5 同源：v3 的 address 是「城市+地点名」拼接，用后缀匹配查表
        const address = url.searchParams.get('address') ?? '';
        const key = [...points.keys()].find((k) => address === k || address.endsWith(k));
        const point = key ? points.get(key) : undefined;
        return Response.json({
          status: '1',
          geocodes: point ? [{ location: `${point.lng},${point.lat}`, adcode: point.adcode }] : [],
        });
      }
      if (url.pathname.startsWith('/v5/direction/')) {
        return Response.json({ status: '1', route: { transits: [{ distance: '5000', cost: { duration: '1200' } }] } });
      }
    }
    if (url.hostname === 'nominatim.openstreetmap.org' && url.pathname === '/search') return Response.json([]);
    unexpectedRequests.push(`${url.origin}${url.pathname}`);
    throw new Error('Unexpected provider request');
  };
  return requests;
}

function makeDraft(destination: string, activities: DraftActivityInput[]): DraftTrip {
  const form: GenerateForm = {
    destination, days: 1, startDate: '', budgetLevel: '舒适', totalBudget: 0,
    preferences: [], partySize: 2, extraNotes: '',
  };
  const draft = new DraftTrip(form);
  draft.setSkeleton('P0 测试行程', ['城市漫步']);
  for (const activity of activities) draft.addActivity(1, activity);
  return draft;
}

function candidate(id: string, name: string): ResearchPoi {
  return { id, name, category: 'attraction', intro: '', reservation: 'unknown', sourceLinks: [] };
}

const quiet = () => {};
/**
 * 定位链的查询序列：主路径 09-26 起是 v3/geocode/geo（address = 「城市+地点名」），
 * v5/place/text 仅在 v3 无结果时兜底。断言只关心「问了哪些地点」，故把 v3 的
 * 城市前缀剥掉，与 v5 的 keywords 归一到同一形态（城市级定位的纯城市名保持不变）。
 */
const textQueries = (requests: URL[]) =>
  requests
    .filter((url) => url.pathname === '/v3/geocode/geo' || url.pathname === '/v5/place/text')
    .map((url) =>
      url.pathname === '/v5/place/text'
        ? (url.searchParams.get('keywords') ?? '')
        : (url.searchParams.get('address') ?? ''),
    )
    .map((raw) => {
      const stripped = /^P0[^市]*市(.+)$/.exec(raw);
      return stripped ? stripped[1]! : raw;
    });
const routes = (requests: URL[]) => requests.filter((url) => url.pathname.startsWith('/v5/direction/'));

test('复用调研坐标后定位外呼从 4 次降到 1 次，坐标一致且 adcode 进入真实路线适配器', async (t) => {
  const center = { lat: 30.66, lng: 104.06, adcode: '510100' };
  const locations = new Map<string, ResearchLocation>([
    ['城市博物馆', { lat: 30.66, lng: 104.04, adcode: '510105' }],
    ['春熙路', { lat: 30.655, lng: 104.084, adcode: '510104' }],
    ['文殊院片区', { lat: 30.69, lng: 104.02, adcode: '510106' }],
  ]);
  const requests = mockProviders(new Map([...locations, ['P0基线市', center], ['P0复用市', center]]));
  const activities: DraftActivityInput[] = [
    { name: '城市博物馆', poiId: 'museum', startTime: '09:00', endTime: '11:00' },
    { name: '午餐｜春熙路 · 川菜', startTime: '12:00', endTime: '13:00', category: '美食' },
    { name: '晚餐｜文殊院片区 · 川菜', placeName: '文殊院片区', startTime: '18:00', endTime: '19:00', category: '美食' },
  ];
  const baseline = makeDraft('P0基线市', activities);
  const baselineGeo = createGeoSession('mock-user', 'P0基线市');
  await baselineGeo.init();
  await baselineGeo.geocodeAll(baseline, quiet);
  assert.deepEqual(textQueries(requests), ['P0基线市', '城市博物馆', '春熙路', '文殊院片区']);
  assert.equal(baselineGeo.stats.calls, 4);

  const optimized = makeDraft('P0复用市', activities);
  const optimizedGeo = createGeoSession('mock-user', 'P0复用市');
  await optimizedGeo.init();
  optimizedGeo.useResearchPlaces([candidate('museum', '城市博物馆')], locations);
  const start = requests.length;
  await optimizedGeo.geocodeAll(optimized, quiet);
  assert.deepEqual(textQueries(requests.slice(start)), ['P0复用市']);
  assert.equal(optimizedGeo.stats.calls, 1, '复用结果不重复扣 geocode 尝试额度');
  const comparable = (draft: DraftTrip) => draft.toTrip().days[0]!.activities.map(({ id: _id, ...activity }) => activity);
  assert.deepEqual(comparable(optimized), comparable(baseline));
  assert.deepEqual(optimized.validate(), [], '原有餐次完整性门槛仍通过');

  await optimizedGeo.computeLegs(optimized, quiet);
  assert.deepEqual(routes(requests).map((url) => [url.searchParams.get('city1'), url.searchParams.get('city2')]), [
    ['510105', '510104'], ['510104', '510106'],
  ]);
  assert.equal(optimizedGeo.stats.calls, 3, '城市定位 1 次 + 路线 2 次，调研成本另计');
  assert.ok(optimized.mutableDays()[0]!.legs?.every((leg) => leg.source === 'amap'));
  t.diagnostic('mock geocode HTTP requests: unseeded=4, research-reuse=1; excludes research and route calls');
});

test('缺失候选、同名歧义和非法坐标走原定位链，不采用错误研究数据', async () => {
  const city = 'P0回退市';
  const point = { lat: 39.9, lng: 116.4, adcode: '110101' };
  const locations = new Map<string, ResearchLocation>([['非法地点', { ...point, lat: 91 }]]);
  const ambiguous = new Set<string>();
  rememberResearchLocation(locations, ambiguous, '同名公园', point);
  rememberResearchLocation(locations, ambiguous, '同名公园', { ...point, lng: 117 });
  const requests = mockProviders(new Map([city, '非法地点', '同名公园', '新增公园'].map((name) => [name, point])));
  const draft = makeDraft(city, [
    { name: '非法地点', poiId: 'invalid' }, { name: '同名公园' }, { name: '新增公园', poiId: 'missing' },
  ]);
  const geo = createGeoSession('mock-user', city);
  await geo.init();
  geo.useResearchPlaces([candidate('invalid', '非法地点')], locations);
  await geo.geocodeAll(draft, quiet);
  assert.deepEqual(textQueries(requests), [city, '非法地点', '同名公园', '新增公园']);
  assert.equal(geo.stats.calls, 4);
  assert.ok(draft.mutableDays()[0]!.activities.every((activity) => activity.lat === point.lat && activity.coordSource === 'geocoded'));
});

test('异地调研坐标被拒后尝试正常定位，仍为异地的结果不得落入行程', async (t) => {
  const city = 'P0地理校验市';
  const local = { lat: 39.91, lng: 116.41, adcode: '110101' };
  const foreign = { lat: 31.23, lng: 121.47, adcode: '310101' };
  const requests = mockProviders(new Map([[city, local], ['可纠正匹配', local], ['仍然错配', foreign]]));
  const warns = t.mock.method(console, 'warn', () => {});
  const draft = makeDraft(city, [{ name: '可纠正匹配' }, { name: '仍然错配' }]);
  const geo = createGeoSession('mock-user', city);
  await geo.init();
  geo.useResearchPlaces([], new Map([['可纠正匹配', foreign], ['仍然错配', foreign]]));
  await geo.geocodeAll(draft, quiet);
  assert.deepEqual(textQueries(requests), [city, '可纠正匹配', '仍然错配']);
  const [recovered, rejected] = draft.toTrip().days[0]!.activities;
  assert.deepEqual([recovered!.lat, recovered!.lng, recovered!.coordSource], [local.lat, local.lng, 'geocoded']);
  assert.deepEqual([rejected!.lat, rejected!.lng, rejected!.coordSource], [0, 0, 'estimated']);
  assert.ok(warns.mock.callCount() >= 2, '复用结果和正常定位结果均受地理校验');
});

test('局部编辑仅重查失效地点，时间编辑保留坐标和路线 memo，换地点不沿用旧 adcode', async () => {
  const city = 'P0修订市';
  const original = { lat: 39.91, lng: 116.41, adcode: '110101' };
  const peer = { lat: 39.95, lng: 116.5, adcode: '110102' };
  const replacement = { lat: 39.88, lng: 116.57, adcode: '110105' };
  const requests = mockProviders(new Map([[city, original], ['新公园', replacement]]));
  const draft = makeDraft(city, [{ name: '旧公园', poiId: 'old' }, { name: '另一地点' }]);
  const geo = createGeoSession('mock-user', city);
  await geo.init();
  geo.useResearchPlaces([candidate('old', '旧公园')], new Map([['旧公园', original], ['另一地点', peer]]));
  await geo.geocodeAll(draft, quiet);
  await geo.computeLegs(draft, quiet);
  const activityId = draft.mutableDays()[0]!.activities[0]!.id;
  const previousCalls = geo.stats.calls;
  const previousRequests = requests.length;
  draft.updateActivity(1, 1, { startTime: '09:30', description: '延后半小时' });
  await geo.geocodeAll(draft, quiet, undefined, true);
  await geo.computeLegs(draft, quiet);
  assert.equal(requests.length, previousRequests);
  assert.equal(geo.stats.calls, previousCalls, '未变化的已解析地点和路线不重复扣额度');

  draft.updateActivity(1, 1, { name: '新公园' });
  assert.equal(draft.mutableDays()[0]!.legs?.length, 0, '旧地点路线已失效');
  await geo.geocodeAll(draft, quiet, undefined, true);
  await geo.computeLegs(draft, quiet);
  assert.deepEqual(textQueries(requests), [city, '新公园']);
  const updated = draft.mutableDays()[0]!.activities[0]!;
  assert.equal(updated.id, activityId);
  assert.deepEqual([updated.lat, updated.lng, updated.coordSource], [replacement.lat, replacement.lng, 'geocoded']);
  const finalRoute = routes(requests).at(-1)!;
  assert.equal(finalRoute.searchParams.get('city1'), replacement.adcode);
  assert.equal(finalRoute.searchParams.get('city2'), peer.adcode);

  const beforeCoordinateEdit = geo.stats.calls;
  draft.updateActivity(1, 1, { lat: replacement.lat + 0.1 });
  await geo.geocodeAll(draft, quiet, undefined, true);
  assert.equal(geo.stats.calls, beforeCoordinateEdit + 1, '地名未变但坐标失效也需重新解析（可命中原缓存）');
  assert.equal(draft.mutableDays()[0]!.activities[0]!.lat, replacement.lat, '不把模型新填的坐标直接标为已验证');
});

test('增量解析不重试未变化的失败项，估算坐标不进入地理校验参照池', async (t) => {
  const city = 'P0失败增量市';
  const local = { lat: 39.92, lng: 116.42, adcode: '110101' };
  const foreign = { lat: 31.23, lng: 121.47, adcode: '310101' };
  const requests = mockProviders(new Map([[city, local], ['后加地点', local]]));
  t.mock.method(console, 'warn', () => {});
  const draft = makeDraft(city, [
    { name: '解析失败甲', lat: foreign.lat, lng: foreign.lng },
    { name: '解析失败乙', lat: foreign.lat, lng: foreign.lng },
  ]);
  const geo = createGeoSession('mock-user', city);
  await geo.init();
  await geo.geocodeAll(draft, quiet);
  const before = { calls: geo.stats.calls, requests: requests.length };
  draft.updateActivity(1, 1, { description: '只改说明' });
  await geo.geocodeAll(draft, quiet, undefined, true);
  assert.deepEqual({ calls: geo.stats.calls, requests: requests.length }, before);

  geo.useResearchPlaces([], new Map([['后加地点', foreign]]));
  draft.addActivity(1, { name: '后加地点' });
  await geo.geocodeAll(draft, quiet, undefined, true);
  assert.deepEqual(textQueries(requests.slice(before.requests)), ['后加地点'], '错配研究点必须回退定位；旧失败项不重查');
  assert.equal(geo.stats.calls, before.calls + 1);
  const added = draft.mutableDays()[0]!.activities[2]!;
  assert.deepEqual([added.lat, added.lng, added.coordSource], [local.lat, local.lng, 'geocoded']);
});

test('取消阻止启动更多地点解析，也不采纳在途返回的坐标', async () => {
  const city = 'P0取消市';
  const point = { lat: 39.93, lng: 116.43, adcode: '110101' };
  const names = Array.from({ length: 6 }, (_, i) => `取消地点${i}`);
  const controller = new AbortController();
  const requests = mockProviders(new Map([city, ...names].map((name) => [name, point])), (url) => {
    // 主路径 09-26 起是 v3/geocode/geo（参数是 address「城市+地点名」）；两个端点都要能识别出「首个地点」
    const q = url.searchParams.get('keywords') ?? url.searchParams.get('address') ?? '';
    if (q.endsWith(names[0]!)) controller.abort();
  });
  const draft = makeDraft(city, names.map((name) => ({ name })));
  const geo = createGeoSession('mock-user', city);
  await geo.init();
  await assert.rejects(geo.geocodeAll(draft, quiet, AbortSignal.abort()), /已取消/);
  assert.equal(requests.length, 0);
  await assert.rejects(geo.geocodeAll(draft, quiet, controller.signal), /已取消/);
  const queries = textQueries(requests);
  assert.ok(queries.includes(names[0]!));
  assert.ok(queries.length <= 3, '城市解析 + 最多两个已在途的工作槽');
  assert.ok(names.slice(2).every((name) => !queries.includes(name)));
  assert.ok(draft.mutableDays()[0]!.activities.every((activity) => activity.lat === 0 && activity.coordSource === 'estimated'));
});
