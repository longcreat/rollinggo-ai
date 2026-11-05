import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/client';
import { createPlaceRetriever } from '../generation/placeRetrieval';
import { prepareResearchContext, renderRetrievedPlaces } from '../generation/researchContext';
import { buildResearchTools, type ResearchOutcome } from '../generation/tools/researchTools';
import { getNullPoiSource } from '../integrations/nullPoiSource';
import { getNullSearchSource } from '../integrations/websearch/searchSource';
import { rankPlaces, type PlaceRow } from '../generation/retrievalRanking';

const city = `召回测试-${randomUUID()}`;
const otherCity = `${city}-外地`;
const placeIds: string[] = [];
const idByName = new Map<string, string>();
let embeddingCalls = 0;
const retrieve = createPlaceRetriever({ query: (sql, values) => pool.query(sql, values), embed: async () => { embeddingCalls++; return null; } });

before(async () => {
  const records = [
    { name: '故宫博物院', category: '文化', source: 'goldset', payload: { aliases: ['紫禁城'], recommendScore: 30 } },
    { name: '天坛', category: '文化', source: 'xhs', payload: { recommendScore: 30, reservation: 'required', reservationNote: '官方渠道预约' } },
    { name: '天坛公园', category: '文化', source: 'goldset', payload: {} },
    ...['颐和园', '景山公园', '北海公园', '恭王府', '国家博物馆', '钟鼓楼', '雍和宫'].map((name) => ({ name, category: '文化', source: 'xhs', payload: { recommendScore: 25 } })),
    ...['天坛东门', '天坛东门右边转角处', '天坛玻璃祥云倒影', '天坛西门'].map((name) => ({ name, category: '文化', source: 'xhs', payload: { recommendScore: 99, xhsPlaceType: 'photo_spot' } })),
    { name: '西湖', category: '自然', source: 'xhs', payload: {} },
    { name: '西湖边酒店', category: '住宿', source: 'goldset', payload: { recommendScore: 999 } },
    { name: '当地小吃', category: '美食', source: 'xhs', payload: {} },
  ];
  for (const [i, row] of records.entries()) {
    const id = randomUUID(); placeIds.push(id); idByName.set(row.name, id);
    await pool.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,lat,lng,payload,created_at)
      VALUES($1,$2,$3,$4,$5,true,$6,$7,$8,now())`, [id, city, row.name, row.category, row.source, 39.9 + i * 0.01, 116.4, row.payload]);
  }
  for (const [targetCity, verified] of [[otherCity, true], [city, false]] as const) {
    const id = randomUUID(); placeIds.push(id);
    await pool.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'隔离景点','文化','xhs',$3,'{}',now())`, [id, targetCity, verified]);
  }
  // 两条来源记录必须明确声明同一实体；仅名称去后缀相同不再构成合并依据。
  await pool.query(`UPDATE canonical_places SET payload=payload || $2::jsonb WHERE id=ANY($1::text[])`,
    [[idByName.get('天坛'), idByName.get('天坛公园')], { aliases: ['天坛', '天坛公园'], identity: { entityId: idByName.get('天坛公园') } }]);
  for (const [kind, strength] of [['xhs_reason', 'weak'], ['xhs_warning', 'weak'], ['xhs_warning', 'direct'], ['xhs_reservation', 'risk_only']] as const) {
    await pool.query(`INSERT INTO research_evidence(id,place_id,city,kind,content,strength,source_url,fetched_at)
      VALUES($1,$2,$3,$4,$5,$6,'https://example.com/evidence',now())`,
    [randomUUID(), idByName.get('天坛'), city, kind, `${kind}-${strength}`, strength]);
  }
});

after(async () => {
  await pool.query('DELETE FROM research_evidence WHERE place_id=ANY($1)', [placeIds]);
  await pool.query('DELETE FROM canonical_places WHERE id=ANY($1)', [placeIds]);
  await pool.end();
});

test('多主题SQL足量时不调向量，返回主景点且归并实体，不被入口机位挤满', async () => {
  embeddingCalls = 0;
  const result = await retrieve(['故宫', '天坛', '历史人文'], { city, category: 'attraction' });
  assert.equal(result.length, 8);
  assert.equal(embeddingCalls, 0);
  assert.ok(result.some((place) => place.name === '故宫博物院'));
  assert.equal(result.filter((place) => place.name.startsWith('天坛')).length, 1);
  assert.ok(result.every((place) => place.category !== '住宿'));
  const temple = result.find((place) => place.name === '天坛公园')!;
  assert.equal(temple.payload?.reservation, 'required', '金集代表行复用同实体社区事实');
  assert.equal(temple.evidence.length, 3);
  assert.deepEqual(temple.evidence.map((e) => [e.kind, e.strength]), [
    ['xhs_warning', 'direct'], ['xhs_warning', 'weak'], ['xhs_reservation', 'risk_only'],
  ]);
  assert.match(renderRetrievedPlaces([temple]), /实证.*网友感受.*仅风险/);
});

test('别名可精确命中；空查询、通配符、跨城与未验证行不泄漏', async () => {
  assert.equal((await retrieve(['紫禁城'], { city, limit: 1 }))[0]?.name, '故宫博物院');
  assert.deepEqual(await retrieve([], { city }), []);
  assert.deepEqual(await retrieve(['%'], { city }), []);
  assert.deepEqual(await retrieve(['隔离景点'], { city }), []);
  assert.equal((await retrieve(['隔离景点'], { city: otherCity, limit: 1 })).length, 1);
});

test('向量失败保留SQL命中，force自然语言查询会尝试向量，取消不外呼', async () => {
  let calls = 0;
  const failing = createPlaceRetriever({ query: (sql, values) => pool.query(sql, values), embed: async () => { calls++; throw new Error('unavailable'); } });
  assert.equal((await failing(['紫禁城'], { city }))[0]?.name, '故宫博物院');
  assert.equal(calls, 1);
  await failing(['适合带老人轻松散步'], { city, vector: 'force' });
  assert.equal(calls, 2);
  assert.deepEqual(await failing(['紫禁城'], { city, signal: AbortSignal.abort() }), []);
  assert.equal(calls, 2);
});

test('向量实际补入同城已验证景点，不混入酒店或其他城市', async () => {
  const vector = `[${Array(1024).fill(0.1).join(',')}]`;
  await pool.query('UPDATE canonical_places SET embedding=$1 WHERE id=ANY($2)', [vector, placeIds]);
  const semantic = createPlaceRetriever({ query: (sql, values) => pool.query(sql, values), embed: async () => Array(1024).fill(0.1) });
  const result = await semantic(['适合带老人轻松散步'], { city, category: 'attraction', vector: 'force' });
  assert.equal(result.length, 8);
  assert.ok(result.every((place) => place.city === city && place.verified && !['住宿', '美食'].includes(place.category)));
});

test('共享泛称别名不合并不同地点，也不跨城归并同名地点', () => {
  const row = (name: string, destination = city): PlaceRow => ({ id: name + destination, city: destination, name, category: '自然',
    source: 'xhs', verified: true, lat: null, lng: null, payload: { aliases: ['市民公园'] } });
  assert.equal(rankPlaces([row('中山公园'), row('滨江公园'), row('中山公园', otherCity)], [], [], 8).length, 3);
});

test('点名独立子项时优先于高热度父景区，父项仍能作为组合背景召回', async () => {
  const testCity = `组成排序-${randomUUID()}`;
  const parentId=randomUUID(),childId=randomUUID();
  const client=await pool.connect();await client.query('BEGIN');
  try {
    for(const [id,name,payload] of [
      [parentId,'天安门',{recommendScore:9999,identity:{version:2,entityId:parentId,kind:'complex',memberNames:['天安门','天安门升旗']}}],
      [childId,'天安门升旗',{identity:{version:2,entityId:childId,kind:'same_entity',memberNames:['天安门升旗','广场升旗']}}],
    ] as const) await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,$3,'文化','xhs',true,$4,now())`,[id,testCity,name,payload]);
    const search=createPlaceRetriever({query:(sql,args)=>client.query(sql,args),embed:async()=>null});
    for(const name of ['天安门升旗','广场升旗']) {
      const hits=await search([name],{city:testCity,vector:'off',limit:8});
      assert.equal(hits[0]?.canonicalPlaceId,childId);
    }
    const hits=await search(['天安门升旗'],{city:testCity,vector:'off',limit:8});
    assert.ok(hits.some(p=>p.canonicalPlaceId===parentId));
    assert.equal((await search(['天安门'],{city:testCity,vector:'off',limit:8}))[0]?.canonicalPlaceId,parentId);
  } finally {await client.query('ROLLBACK');client.release();}
});

test('预取无themes城市照常返回候选；非美食行程不查餐饮、不发embedding', async () => {
  embeddingCalls = 0;
  const result = await prepareResearchContext({ destination: city, days: 2, startDate: '', budgetLevel: '舒适',
    totalBudget: 0, preferences: ['自然'], partySize: 2, extraNotes: '', pace: 'moderate' }, retrieve);
  assert.ok(result.some((place) => place.name === '西湖'));
  assert.ok(result.every((place) => !['美食', '住宿'].includes(place.category)));
  assert.equal(embeddingCalls, 0);
});

test('候选引用复用证据与坐标、不再查询XHS，别名去重且拒绝错误引用', async () => {
  const places = await retrieve(['天坛'], { city, category: 'attraction', vector: 'off' });
  const known = places.find((place) => place.name === '天坛公园')!;
  const outcome: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const tool = buildResearchTools({ destination: city, outcome, verifiedPlaces: places, searchWebMax: 2,
    poiSource: getNullPoiSource(), searchSource: getNullSearchSource() }).find((tool) => tool.name === 'add_candidate')!;
  const noQueries = mock.method(pool, 'query', () => { throw new Error('不应重复查库'); });
  try {
    const result = await tool.execute('known', { placeId: known.id, name: '天坛', category: 'attraction', intro: '公园漫步' });
    assert.equal(result.details.ok, true);
    assert.equal(noQueries.mock.callCount(), 0);
    assert.equal(outcome.pool[0]?.name, '天坛公园');
    assert.ok(outcome.locations.has('天坛公园'));
    assert.equal(outcome.pool[0]?.sourceLinks[0]?.url, 'https://example.com/evidence');
    await tool.execute('dup', { name: '天坛公园', category: 'attraction', intro: '重复' });
    assert.equal(outcome.pool.length, 1);
    const bad = await tool.execute('bad', { placeId: known.id, name: '故宫', category: 'attraction', intro: '错误引用' });
    assert.equal(bad.details.ok, false);
  } finally { noQueries.mock.restore(); }
});
