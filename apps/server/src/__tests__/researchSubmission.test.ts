import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { MAX_OVERVIEW_POIS, type ResearchPoi } from '@tripweaver/shared';
import { pool } from '../db/client';
import { buildResearchTools, type ResearchOutcome, type ResearchToolDeps } from '../generation/tools/researchTools';
import type { RetrievedPlace } from '../generation/placeRetrieval';
import { renderRetrievedPlaces } from '../generation/researchContext';
import { getNullPoiSource } from '../integrations/nullPoiSource';
import { getNullSearchSource } from '../integrations/websearch/searchSource';

after(() => pool.end());

test('无澄清候选的撤回名称不能作为自由地点复活，即使搜索位置已有同名坐标', async () => {
  const retired = {id:'retired-coffee',city:'北京',name:'CUIDA',category:'美食',verified:false,source:'xhs',lat:null,lng:null,
    payload:{identity:{version:2,entityId:'retired-coffee',revision:2,memberIds:['retired-coffee'],memberNames:['CUIDA']},
      identityWithdrawal:{version:1,revision:2,reason:'unavailable_source',candidateIds:[]}}};
  const query=mock.method(pool,'query',async()=>({rows:[retired]}));
  let retrievals=0;
  try {
    for(const located of [false,true]) {
      const {add,outcome}=setup([],{foodSearch:true,retrieve:async()=>{retrievals++;return [];}});
      if(located) outcome.locations.set('cuida',{lat:39.9,lng:116.4,adcode:'110000'});
      const result=await add.execute('withdrawal',{name:'cuida',category:'food',intro:'不能沿泛名补充门店'});
      assert.equal(result.details.ok,false); assert.equal(outcome.pool.length,0);
    }
    assert.equal(retrievals,0,'确认撤回后不能走模型/外部补充回退');
  } finally {query.mock.restore();}
});
const place = (id: string, overrides: Partial<RetrievedPlace> = {}): RetrievedPlace => ({
  id, name: `测试公园${id}`, city: '北京', category: '自然', verified: true, source: 'xhs',
  lat: 39.9, lng: 116.4, aliases: [], payload: {}, evidence: [], ...overrides,
});
function setup(places: RetrievedPlace[], extra: Partial<ResearchToolDeps> = {}) {
  const outcome: ResearchOutcome = { pool: [], summary: '', locations: new Map() };
  const published: ResearchPoi[] = [];
  const tools = buildResearchTools({ destination: '北京', verifiedPlaces: places, outcome,
    poiSource: getNullPoiSource(), searchSource: getNullSearchSource(), searchWebMax: 2,
    amapPhotos: { photosFor: async () => [], calls: 0 },
    onCandidate: (poi) => published.push(poi), ...extra });
  return { outcome, published, submit: tools.find((t) => t.name === 'submit_research')!, add: tools.find((t) => t.name === 'add_candidate')! };
}

test('追加调研拒绝原行程实体和无依据地点，模型不能自行添加来源链接', async () => {
  const old = place('old', { name: '已经安排的公园', aliases: ['旧公园'] });
  const fresh = place('fresh');
  const { submit, add, outcome } = setup([old, fresh], {
    groundedOnly: true, acceptPlace: (name, aliases = []) => ![name, ...aliases].includes('旧公园'),
  });
  const invalid = await submit.execute('reject-old', { candidates: [
    { placeId: fresh.id, intro: '新公园介绍' }, { placeId: old.id, intro: '旧公园介绍' },
  ] });
  assert.equal(invalid.details.ok, false);
  assert.equal(outcome.pool.length, 0, '不能部分提交新地点');
  const invented = await add.execute('reject-invention', { name: '未查询的地点', category: 'attraction', intro: '模型虚构', sourceLinks: [{ title: '伪造来源', url: 'https://example.com/invented' }] });
  assert.equal(invented.details.ok, false);
  const accepted = await add.execute('known', { name: fresh.name, placeId: fresh.id, category: 'attraction', intro: '公园介绍', sourceLinks: [{ title: '伪造来源', url: 'https://example.com/invented' }] });
  assert.equal(accepted.details.ok, true);
  assert.equal(outcome.pool[0]!.sourceLinks.length, 0);
});

test('一批提交只需ID与简介，复用事实/照片/官方来源并逐条发布，无重复查库', async () => {
  const places = [place('palace', { name: '故宫博物院', payload: { reservation: 'none', reservationNote: '不能覆盖官方种子' } }),
    place('park', { payload: { openHours: { closedWeekdays: [1] } }, evidence: [
      { kind: 'xhs_reservation', content: '旺季可能需预约', strength: 'risk_only', sourceUrl: 'https://example.com/note' },
    ] }), place('free', { payload: { reservation: 'none', reservationNote: '现场入园' } }),
    place('booking', { payload: { reservation: 'required', reservationNote: '请先预约' } })];
  const amapCover = 'https://store.is.autonavi.com/showpic/test';
  const { submit, outcome, published } = setup(places, { amapPhotos: { photosFor: async () => [amapCover], calls: 0 } });
  const query = mock.method(pool, 'query', () => { throw new Error('已知候选不应查询数据库'); });
  try {
    const result = await submit.execute('batch', { candidates: places.map((p) => ({ placeId: p.id, intro: `${p.name}漫步参观。` })) });
    assert.equal(result.terminate, true);
    assert.equal(outcome.pool.length, 4);
    assert.deepEqual(published, outcome.pool);
    assert.equal(outcome.pool[0]?.reservation, 'required');
    assert.notEqual(outcome.pool[0]?.reservationNote, '不能覆盖官方种子');
    assert.match(outcome.pool[0]!.sourceLinks[0]!.url, /dpm.org.cn/);
    assert.equal(outcome.pool[1]?.reservation, 'unknown', '风险证据不能升级成确定预约政策');
    assert.equal(outcome.pool[1]?.sourceLinks[0]?.url, 'https://example.com/note');
    assert.equal(outcome.pool[1]?.coverUrl, amapCover);
    assert.match(outcome.pool[1]!.openTime!, /周一闭馆/);
    assert.equal(outcome.pool[2]?.reservation, 'none');
    assert.equal(outcome.pool[2]?.reservationNote, '现场入园');
    assert.equal(outcome.pool[3]?.reservation, 'required');
    assert.equal(outcome.pool[3]?.reservationNote, '请先预约');
    assert.equal(outcome.locations.size, 4);
    assert.equal(query.mock.callCount(), 0);
    const rendered = renderRetrievedPlaces(places);
    assert.match(rendered, /仅风险/);
    assert.ok(!rendered.includes('https://'), '来源仍在catalog中，提示无需重复URL');
  } finally { query.mock.restore(); }
});

test('整批验证：错误ID、跨城、未验证、酒店、禁用美食或空简介均不部分写入', async () => {
  const cases = [
    { bad: place('bad', { city: '杭州' }) },
    { bad: place('bad', { verified: false }) },
    { bad: place('bad', { category: '住宿' }) },
    { bad: place('bad', { category: '美食' }) },
    { bad: place('bad'), id: 'missing' },
    { bad: place('bad'), intro: '   ' },
  ];
  for (const sample of cases) {
    let coverCalls = 0;
    const { submit, outcome, published } = setup([place('good'), sample.bad], {
      foodSearch: false,
      amapPhotos: { photosFor: async () => { coverCalls++; return []; }, calls: 0 },
    });
    const result = await submit.execute('bad-batch', { candidates: [
      { placeId: 'good', intro: '公园漫步' }, { placeId: sample.id ?? 'bad', intro: sample.intro ?? '参观' },
    ] });
    assert.equal(result.details.ok, false);
    assert.notEqual(result.terminate, true);
    assert.equal(outcome.pool.length, 0);
    assert.equal(published.length, 0);
    assert.equal(coverCalls, 0);
    assert.equal(outcome.summary, '');
  }
});

test('批次入池与SSE优先复用上游完整介绍，冲突预约与官方种子各自处理', async () => {
  const places = [
    place('temple', { name: '天坛公园', payload: { reservation: 'required', reservationNote: '天坛公园无需预约' } }),
    place('lane', { name: '烟袋斜街', payload: { reservation: 'required', reservationNote: '烟袋斜街无需预约' } }),
    place('jingshan', { name: '景山公园', payload: { reservation: 'required', reservationNote: '景山公园' } }),
    place('palace', { name: '故宫博物院', payload: { reservation: 'required', reservationNote: '无需预约' } }),
  ];
  const { submit, outcome, published } = setup(places);
  for (const p of places) p.payload = { ...p.payload,
    content: { version: 1, intro: `${p.name}可漫步参观，留意建筑与园林景观。出发前以官方预约信息为准。`,
      highlights: [{ sourceUrl: 'https://example.com/place-introduction' }] } };
  await submit.execute('quality', { candidates: places.map((p) => ({ placeId: p.id,
    intro: `${p.name}可漫步参观，门票2元，法物流通处已关闭。` })) });
  assert.equal(outcome.pool.length, 4);
  assert.deepEqual(published, outcome.pool);
  assert.deepEqual(outcome.pool.slice(0, 3).map((p) => p.reservation), ['unknown', 'unknown', 'unknown']);
  assert.match(outcome.pool[0]!.reservationNote!, /冲突/);
  assert.equal(outcome.pool[3]!.reservation, 'required');
  assert.match(outcome.pool[3]!.sourceLinks[0]!.url, /dpm.org.cn/);
  for (const poi of published) {
    assert.equal(poi.intro, `${poi.name}可漫步参观，留意建筑与园林景观。出发前以官方预约信息为准。`);
    assert.ok(poi.sourceLinks.some((s) => s.url === 'https://example.com/place-introduction'));
  }
});

test('重复实体ID与已入池候选幂等去重，空池不得提交', async () => {
  const original = place('original');
  const { submit, add, outcome, published } = setup([original, place('same-name', { name: original.name,
    payload: { identity: { entityId: original.id } } }), place('another')]);
  assert.equal((await submit.execute('empty', {})).details.ok, false);
  await add.execute('legacy', { placeId: original.id, name: original.name, category: 'attraction', intro: '已写入的简介' });
  const params = { candidates: ['original', 'same-name', 'another', 'another'].map((placeId) => ({ placeId, intro: '新简介' })) };
  assert.equal((await submit.execute('batch', params)).terminate, true);
  assert.equal((await submit.execute('retry', params)).terminate, true);
  assert.equal(outcome.pool.length, 2);
  assert.equal(published.length, 2);
  assert.equal(outcome.pool[0]?.intro, '已写入的简介');
  assert.equal((await submit.execute('legacy-submit', { summary: '兼容原有提交' })).terminate, true);
});

test('未确认的相似名先核实，有独立地点搜索坐标才可作为自由地点加入', async () => {
  const lake = place('lake', { name: '测试湖', aliases: [] });
  const query = mock.method(pool, 'query', async () => ({ rows: [lake] }));
  try {
    const { add, outcome } = setup([lake], { retrieve: async () => [],
      storedAmapPhoto: async () => null });
    const name = '测试湖观景台';
    assert.equal((await add.execute('unconfirmed', { name, category: 'attraction', intro: '湖边观景平台' })).details.ok, false);
    assert.equal(outcome.pool.length, 0);
    outcome.locations.set(name, { lat: 39.91, lng: 116.42, adcode: '110000' });
    assert.equal((await add.execute('independent', { name, category: 'attraction', intro: '湖边独立观景平台' })).details.ok, true);
    assert.equal(outcome.pool[0]?.name, name);
    assert.equal(outcome.pool[0]?.canonicalPlaceId, undefined, '不能把独立子地点绑定到母景区');
  } finally { query.mock.restore(); }
});

test('容量按整个池校验，超量不半批写入；允许美食偏好候选', async () => {
  const places = Array.from({ length: MAX_OVERVIEW_POIS + 1 }, (_, i) => place(String(i)));
  const { submit, outcome } = setup(places);
  outcome.pool.push({ id: 'existing', name: '已存在', category: 'attraction', intro: '说明', reservation: 'unknown', sourceLinks: [] });
  const result = await submit.execute('overflow', { candidates: places.slice(0, MAX_OVERVIEW_POIS).map((p) => ({ placeId: p.id, intro: '参观' })) });
  assert.equal(result.details.ok, false);
  assert.equal(outcome.pool.length, 1);
  const food = setup([place('food', { category: '美食' })], { foodSearch: true });
  assert.equal((await food.submit.execute('food', { candidates: [{ placeId: 'food', intro: '当地菜系' }] })).terminate, true);
  assert.equal(food.outcome.pool[0]?.category, 'food');
});

test('批次取消：等待照片期间不发布候选；条目之间取消不继续执行或提交摘要', async () => {
  const controller = new AbortController();
  const first = setup([place('one')], { signal: controller.signal,
    amapPhotos: { photosFor: async () => { controller.abort(); return []; }, calls: 0 } });
  await assert.rejects(first.submit.execute('abort-cover', { candidates: [{ placeId: 'one', intro: '参观' }] }), { name: 'AbortError' });
  assert.equal(first.outcome.pool.length, 0);
  const between = new AbortController();
  let calls = 0;
  const second = setup([place('one'), place('two')], { signal: between.signal,
    amapPhotos: { photosFor: async () => { calls++; return []; }, calls: 0 }, onCandidate: () => between.abort() });
  await assert.rejects(second.submit.execute('abort-between', { candidates: ['one', 'two'].map((placeId) => ({ placeId, intro: '参观' })) }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(second.outcome.pool.length, 1);
  assert.equal(second.outcome.summary, '');
});

test('高德营业时间原文超过契约上限时截断，落库行程能通过 schema 校验', async () => {
  const longOpenTime = '周一至周日 09:00-17:00（16:30 停止入场；法定节假日开放时间以景区公告为准，特殊情况另行通知）';
  const poiSource = {
    ...getNullPoiSource(),
    kind: 'amap' as const,
    searchPois: async () => [{
      name: '测试公园a', type: '风景名胜', address: '测试路', rating: '', cost: '',
      opentime: longOpenTime, photoUrls: [], adcode: '110000', location: { lat: 39.9, lng: 116.4 },
    }],
  };
  const outcome: ResearchOutcome = { pool: [], summary: '', locations: new Map() };
  const tools = buildResearchTools({
    destination: '北京', verifiedPlaces: [], outcome, poiSource,
    searchSource: getNullSearchSource(), searchWebMax: 2,
    amapPhotos: { photosFor: async () => [], calls: 0 },
  });
  // 同一组工具共享 openTimeByName：先 search_pois 捕获原文，再 add_candidate 自动回填。
  await tools.find((t) => t.name === 'search_pois')!.execute('search', { category: 'attraction', keyword: '公园' });
  const result = await tools.find((t) => t.name === 'add_candidate')!
    .execute('long-open', { name: '测试公园a', category: 'attraction', intro: '城市公园' });
  assert.equal(result.details.ok, true);
  const openTime = outcome.pool[0]?.openTime;
  assert.ok(openTime && openTime.length <= 60, `openTime 应截断到 60 字，实际 ${openTime?.length}`);
});
