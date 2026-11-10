import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchPoi } from '@rollinggo-trip/shared';
import { activityPlaceName, createResearchPlaceLookup, rememberResearchLocation, type ResearchLocation } from '@rollinggo-trip/agent/generation/placeLookup';
import type { RetrievedPlace } from '@rollinggo-trip/agent/generation/placeRetrieval';
import { buildResearchTools, type ResearchOutcome } from '@rollinggo-trip/agent/generation/tools/researchTools';
import type { PoiSource, SourcedPoi } from '@rollinggo-trip/integrations/geoContracts';

const point: ResearchLocation = { lat: 39.9, lng: 116.4, adcode: '110101' };
const candidate: ResearchPoi = { id: 'museum', name: '真实博物馆', category: 'attraction', intro: '', reservation: 'unknown', sourceLinks: [] };

const nullSource = (): PoiSource => ({
  kind: 'null', searchPois: async () => [],
  selfCheck: async () => ({ configured: false, checked: false, ok: true, message: '' }),
});

const nullSearch = { kind: 'null' as const, search: async () => [], selfCheck: async () => ({ configured: false, checked: false, ok: true, message: '' }) };

/** 高德实时查询替身：记录调用并按需返回图片 */
function amapOf(urls: string[] = [], onCall?: () => void) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async photosFor() { calls++; onCall?.(); return urls; },
  };
}

function searchPoi(name: string, photoUrls: string[] = []): SourcedPoi {
  return { name, type: '风景名胜', address: '', rating: '', cost: '', opentime: '', photoUrls, location: point, adcode: point.adcode };
}

function amapSource(pois: SourcedPoi[]): PoiSource {
  return { kind: 'amap', searchPois: async () => pois, selfCheck: async () => ({ configured: true, checked: true, ok: true, message: '' }) };
}

test('定位名兼容旧餐次文案，并优先使用显式片区', () => {
  assert.equal(activityPlaceName({ name: '午餐｜春熙路 · 川菜' }), '春熙路');
  assert.equal(activityPlaceName({ name: ' 晚饭 | 南京东路 • 本帮菜 ' }), '南京东路');
  assert.equal(activityPlaceName({ name: '午餐｜景区周边 · 当地菜', placeName: ' 人民广场 ' }), '人民广场');
  assert.equal(activityPlaceName({ name: '国家博物馆（含午餐安排）' }), '国家博物馆（含午餐安排）');
  assert.equal(activityPlaceName({ name: 'Café · Museum' }), 'Café · Museum', '非餐次地点不得按标点截断');
});

test('候选 ID 和唯一地名复用同一个真实位置，未知引用保留正常查询路径', () => {
  const lookup = createResearchPlaceLookup([candidate], new Map([[candidate.name, point]]));
  assert.deepEqual(lookup({ name: '上午参观', poiId: candidate.id }), { name: candidate.name, point });
  assert.deepEqual(lookup({ name: ` ${candidate.name} ` }), { name: candidate.name, point });
  assert.deepEqual(lookup({ name: '新的公园', poiId: 'unknown' }), { name: '新的公园' });
  assert.deepEqual(lookup({ name: '午餐', poiId: candidate.id, placeName: '另一片区' }), { name: '另一片区' });
});

test('同名不同坐标不复用，后续重复结果不能覆盖已知歧义', () => {
  const locations = new Map<string, ResearchLocation>();
  const ambiguous = new Set<string>();
  rememberResearchLocation(locations, ambiguous, '同名公园', point);
  rememberResearchLocation(locations, ambiguous, '同名公园', { ...point, lng: 117 });
  rememberResearchLocation(locations, ambiguous, '同名公园', point);
  assert.equal(locations.has('同名公园'), false);
  assert.equal(ambiguous.has('同名公园'), true);
});

test('无效坐标不能进入复用索引，相同点可补充缺失的行政区划码', () => {
  const locations = new Map<string, ResearchLocation>();
  const ambiguous = new Set<string>();
  rememberResearchLocation(locations, ambiguous, '甲', { ...point, adcode: '' });
  rememberResearchLocation(locations, ambiguous, '甲', point);
  rememberResearchLocation(locations, ambiguous, '乙', { ...point, lat: Number.NaN });
  rememberResearchLocation(locations, ambiguous, '丙', { ...point, lng: 181 });
  assert.deepEqual(locations.get('甲'), point);
  assert.equal(locations.size, 1);
  const lookup = createResearchPlaceLookup([], new Map([['越界', { ...point, lat: 91 }]]));
  assert.deepEqual(lookup({ name: '越界' }), { name: '越界' });
});

test('调研工具旁路保留 adcode，公开候选不包含原始坐标', async () => {
  const poi: SourcedPoi = { name: candidate.name, type: '博物馆', address: '', rating: '', cost: '', opentime: '', photoUrls: [], location: point, adcode: point.adcode };
  const source = amapSource([poi]);
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const tools = buildResearchTools({
    poiSource: source,
    searchSource: nullSearch,
    destination: '北京',
    searchWebMax: 2,
    outcome,
  });
  const search = tools.find((tool) => tool.name === 'search_pois')!;
  const add = tools.find((tool) => tool.name === 'add_candidate')!;
  await search.execute('search', { category: 'attraction', keyword: '博物馆' });
  await add.execute('add', { name: candidate.name, category: 'attraction', intro: '实地候选' });
  assert.deepEqual(outcome.locations.get(candidate.name), point);
  assert.equal(outcome.pool.length, 1);
  assert.equal('location' in outcome.pool[0]!, false);
  assert.equal('adcode' in outcome.pool[0]!, false);
});

test('add_candidate 自动回填高德营业时间（仅 attraction），模型无需转抄', async () => {
  const withHours: SourcedPoi = {
    name: '周一闭馆馆', type: '博物馆', address: '', rating: '', cost: '',
    opentime: '09:00-17:00；周一闭馆', photoUrls: [], location: point, adcode: point.adcode,
  };
  const foodWithHours: SourcedPoi = {
    name: '营业面馆', type: '餐饮', address: '', rating: '', cost: '',
    opentime: '10:00-22:00', photoUrls: [], location: point, adcode: point.adcode,
  };
  const source = amapSource([withHours, foodWithHours]);
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const tools = buildResearchTools({
    poiSource: source,
    searchSource: nullSearch,
    destination: '北京',
    searchWebMax: 2,
    outcome,
  });
  const search = tools.find((tool) => tool.name === 'search_pois')!;
  const add = tools.find((tool) => tool.name === 'add_candidate')!;
  await search.execute('search', { category: 'attraction', keyword: '博物馆' });

  // attraction 同名命中 → 回填
  await add.execute('add1', { name: '周一闭馆馆', category: 'attraction', intro: '实地候选' });
  assert.equal(outcome.pool[0]!.openTime, '09:00-17:00；周一闭馆');

  // food 同名命中 → 不回填（餐饮营业时段不参与闭馆日检测）
  await add.execute('add2', { name: '营业面馆', category: 'food', intro: '同名餐饮' });
  assert.equal(outcome.pool[1]!.openTime, undefined);

  // 未经过 search_pois 的点 → 无数据可回填
  await add.execute('add3', { name: '纯知识候选', category: 'attraction', intro: '模型知识' });
  assert.equal(outcome.pool[2]!.openTime, undefined);
});

/**
 * 库内身份样本：这几个坐标用例断言「已知实体改用库内正式名」（故宫 → 故宫博物院），
 * 原先靠真实应用库满足。改为显式注入，测试在隔离空库里也能成立。
 */
const identityPlaces: RetrievedPlace[] = [
  { id: 'forbidden-city', city: '北京', name: '故宫博物院', category: '文化', verified: true, source: 'goldset',
    lat: 39.9163, lng: 116.3972, payload: { identity: { entityId: 'forbidden-city' } }, aliases: ['故宫'], evidence: [] },
  { id: 'temple-of-heaven', city: '北京', name: '天坛公园', category: '文化', verified: true, source: 'goldset',
    lat: 39.8822, lng: 116.4066, payload: { identity: { entityId: 'temple-of-heaven' } }, aliases: ['天坛'], evidence: [] },
];

test('库内坐标权威覆盖同名搜索结果，key 不被歧义检测删除（层2 坐标旁路）', async () => {
  // 搜索结果带回的是另一处坐标（同名的地图误配或粗定位）；库内坐标才是权威值。
  const searched: SourcedPoi = {
    name: '故宫博物院', type: '博物馆', address: '', rating: '', cost: '', opentime: '', photoUrls: [],
    location: { lat: 39.9, lng: 116.4 }, adcode: '110101',
  };
  const source = amapSource([searched]);
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const tools = buildResearchTools({
    poiSource: source,
    searchSource: nullSearch,
    destination: '北京',
    searchWebMax: 2,
    outcome,
    verifiedPlaces: identityPlaces,
  });
  const search = tools.find((tool) => tool.name === 'search_pois')!;
  const add = tools.find((tool) => tool.name === 'add_candidate')!;
  await search.execute('search', { category: 'attraction', keyword: '故宫' });
  assert.deepEqual(outcome.locations.get('故宫博物院'), { lat: 39.9, lng: 116.4, adcode: '110101' });

  // placeId 直接指向库内实体，解析结果是 known，坐标分支走库内权威覆盖。
  await add.execute('add', { name: '故宫博物院', category: 'attraction', intro: '中轴线', placeId: 'forbidden-city' });
  // 走 rememberResearchLocation 会把「坐标不一致」判成同名歧义并 delete 整个 key，
  // 连搜索结果坐标一起丢，层2 距离预计算随之失效。这里锁定覆盖语义。
  assert.deepEqual(outcome.locations.get('故宫博物院'), { lat: 39.9163, lng: 116.3972, adcode: '' },
    '库内坐标必须覆盖同名搜索结果坐标，而不是删除该 key');
  assert.equal(outcome.pool.length, 1);
  assert.equal(outcome.pool[0]!.name, '故宫博物院');
});

test('库内坐标无效（0,0）时保留搜索结果坐标，不用脏值覆盖层2 旁路', async () => {
  const searched: SourcedPoi = {
    name: '坐标异常馆', type: '博物馆', address: '', rating: '', cost: '', opentime: '', photoUrls: [],
    location: { lat: 39.9, lng: 116.4 }, adcode: '110101',
  };
  const source = amapSource([searched]);
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const places: RetrievedPlace[] = [{ id: 'broken-geo', city: '北京', name: '坐标异常馆', category: '文化', verified: true, source: 'goldset',
    lat: 0, lng: 0, payload: { identity: { entityId: 'broken-geo' } }, aliases: [], evidence: [] }];
  const tools = buildResearchTools({
    poiSource: source,
    searchSource: nullSearch,
    destination: '北京',
    searchWebMax: 2,
    outcome,
    verifiedPlaces: places,
  });
  await tools.find((tool) => tool.name === 'search_pois')!.execute('search', { category: 'attraction', keyword: '坐标' });
  await tools.find((tool) => tool.name === 'add_candidate')!.execute('add', { name: '坐标异常馆', category: 'attraction', intro: 'x', placeId: 'broken-geo' });
  assert.deepEqual(outcome.locations.get('坐标异常馆'), { lat: 39.9, lng: 116.4, adcode: '110101' },
    '库内 0,0 不是有效坐标，不能覆盖搜索结果');
});

test('图片只走高德：search_pois 旁路多图直接入池，不再调用任何外部图源', async () => {
  const photos = [
    'https://store.is.autonavi.com/showpic/a',
    'https://store.is.autonavi.com/showpic/b',
    'https://store.is.autonavi.com/showpic/c',
    'https://store.is.autonavi.com/showpic/duplicate',
  ];
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const amap = amapOf([], () => assert.fail('search_pois 已带回图片，不应再查高德'));
  const tools = buildResearchTools({
    poiSource: amapSource([searchPoi('西湖', photos)]),
    searchSource: nullSearch,
    destination: '杭州', searchWebMax: 0, outcome,
    amapPhotos: amap,
    storedAmapPhoto: async () => assert.fail('旁路命中不应读库'),
  });
  await tools.find(t => t.name === 'search_pois')!.execute('s', { category: 'attraction', keyword: '西湖' });
  await tools.find(t => t.name === 'add_candidate')!.execute('a', { name: '西湖', category: 'attraction', intro: '' });

  assert.equal(outcome.pool[0]?.coverUrl, photos[0]);
  assert.deepEqual(outcome.pool[0]?.photos, photos.slice(0, 3).map(url => ({ url })));
  assert.equal(outcome.pool[0]?.coverAttribution, undefined, '高德图不带署名');
});

test('图片只走高德：非景点不补图，缺图留空由前端占位', async () => {
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const amap = amapOf(['https://store.is.autonavi.com/showpic/a'], () => assert.fail('非景点不应查高德'));
  const tools = buildResearchTools({
    poiSource: nullSource(), searchSource: nullSearch,
    destination: '北京', searchWebMax: 0, outcome,
    amapPhotos: amap,
  });
  await tools.find(t => t.name === 'add_candidate')!.execute('a', { name: '封面测试用餐点', category: 'food', intro: '' });
  await tools.find(t => t.name === 'add_candidate')!.execute('b', { name: '某个无图景点', category: 'attraction', intro: '' });
  assert.equal(outcome.pool[0]?.coverUrl, undefined);
});

test('图片只走高德：库内已回写图优先，命中即不再打实时查询也不重写', async () => {
  const cached = 'https://store.is.autonavi.com/showpic/cached';
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const saved: string[] = [];
  const tools = buildResearchTools({
    poiSource: nullSource(), searchSource: nullSearch,
    destination: '北京', searchWebMax: 0, outcome,
    storedAmapPhoto: async name => name === '故宫博物院' ? cached : null,
    amapPhotos: amapOf([], () => assert.fail('库内已有图不应再查高德')),
    saveAmapPhoto: (name, url) => saved.push(`${name}|${url}`),
    verifiedPlaces: identityPlaces,
  });
  await tools.find(t => t.name === 'add_candidate')!.execute('a', { name: '故宫', category: 'attraction', intro: '', placeId: 'forbidden-city' });
  assert.equal(outcome.pool[0]!.name, '故宫博物院');
  assert.equal(outcome.pool[0]?.coverUrl, cached);
  assert.deepEqual(saved, [], '复用已有值不需要回写');
});

test('图片只走高德：实时命中多图后回写库内，失败留空不抛错', async () => {
  const live = ['https://store.is.autonavi.com/showpic/fresh-1', 'https://store.is.autonavi.com/showpic/fresh-2'];
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const saved: string[] = [];
  const tools = buildResearchTools({
    poiSource: nullSource(), searchSource: nullSearch,
    destination: '北京', searchWebMax: 0, outcome,
    storedAmapPhoto: async () => null,
    amapPhotos: amapOf(live),
    saveAmapPhoto: (name, url) => saved.push(`${name}|${url}`),
  });
  await tools.find(t => t.name === 'add_candidate')!.execute('a', { name: '某新景点', category: 'attraction', intro: '' });
  assert.equal(outcome.pool[0]?.coverUrl, live[0]);
  assert.deepEqual(outcome.pool[0]?.photos, live.map(url => ({ url })));
  assert.deepEqual(saved, [`某新景点|${live[0]}`], '命中后回写 payload.amapPhoto，同一地点终身只花一次配额');

  const failing: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const failingTools = buildResearchTools({
    poiSource: nullSource(), searchSource: nullSearch,
    destination: '北京', searchWebMax: 0, outcome: failing,
    amapPhotos: { calls: 0, photosFor: async () => { throw new Error('unavailable'); } },
  });
  await failingTools.find(t => t.name === 'add_candidate')!.execute('b', { name: '某新景点', category: 'attraction', intro: '' });
  assert.equal(failing.pool[0]?.coverUrl, undefined, '图片查询失败不影响候选入池，前端回落类目占位');
});
