import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '@tripweaver/core/db/client';
import { prepareImportedPlaces, reconcileImportedPlaces } from '@tripweaver/services/placeImportIdentity';
import { createPlaceRetriever } from '@tripweaver/agent/generation/placeRetrieval';
import { renderRetrievedPlaces } from '@tripweaver/agent/generation/researchContext';
import { buildResearchTools, type ResearchOutcome } from '@tripweaver/agent/generation/tools/researchTools';
import { getNullPoiSource } from '@tripweaver/integrations/nullPoiSource';
import { getNullSearchSource } from '@tripweaver/integrations/websearch/searchSource';
import { loadCityPlaceFacts } from '@tripweaver/agent/generation/scheduling/placeFacts';
import { createPlaceIdentityIndex } from '@tripweaver/core/lib/placeIdentity';
import { captureIdentityImport, recordIdentityImport, rollbackIdentityImport } from '@tripweaver/services/placeIdentityAudit';

after(() => pool.end());

test('实际导入脚本解除金集子项的旧组合重定向，重跑和审计回滚保留原行', async () => {
  const city = `脚本组合-${randomUUID()}`, parentId = randomUUID(), childId = randomUUID();
  const folder = await mkdtemp(path.join(tmpdir(),'place-identity-import-'));
  const client = await pool.connect();
  try {
    const contract = (id: string, name: string, kind='same_entity') => ({version:2,entityId:id,revision:1,
      canonicalName:name,kind,memberIds:[id],memberNames:[name]});
    const parent = {id:parentId,name:'主景区',category:'文化',lat:39.9,lng:116.4,payload:{
      identity:contract(parentId,'主景区','complex'),components:[{name:'独立城楼',canonicalPlaceId:childId}]}};
    const child = {id:childId,name:'独立城楼',category:'文化',lat:39.91,lng:116.41,payload:{
      identity:contract(childId,'独立城楼'),openHours:{text:'城楼时段'}}};
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'主景区','文化','xhs',true,$3,now()),($4,$2,'独立城楼','文化','goldset',true,$5,now())`,
      [parentId,city,parent.payload,childId,{canonicalRedirectTo:parentId,coverImage:'original.webp'}]);
    const before = await captureIdentityImport(client,city);
    const file = path.join(folder,'xhs-places-components.json');
    await writeFile(file,JSON.stringify({city,generatedAt:'2026-10-06T00:00:00Z',places:[parent,child]}));
    for (let i=0;i<2;i++) {
      await promisify(execFile)(process.execPath,['--import','tsx',fileURLToPath(new URL('../../scripts/seed-xhs-places.ts',import.meta.url)),file],
        {env:process.env,windowsHide:true,timeout:30000});
      const row = (await client.query('SELECT source,payload FROM canonical_places WHERE id=$1',[childId])).rows[0];
      assert.equal(row.source,'goldset');assert.equal(row.payload.coverImage,'original.webp');
      assert.equal(row.payload.canonicalRedirectTo,undefined);
      assert.equal(row.payload.identity.entityId,childId);
      assert.equal(row.payload.openHours.text,'城楼时段');
    }
    const audits = (await client.query('SELECT id FROM place_identity_imports WHERE city=$1 ORDER BY created_at DESC',[city])).rows;
    assert.equal(audits.length,2);
    await client.query('BEGIN');
    for (const audit of audits) await rollbackIdentityImport(client,audit.id,true);
    assert.deepEqual(await captureIdentityImport(client,city),before);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    await client.query('DELETE FROM place_identity_imports WHERE city=$1',[city]);
    await client.query('DELETE FROM canonical_places WHERE city=$1',[city]);
    client.release();await rm(folder,{recursive:true,force:true});
  }
});

test('权威v2父子契约解除旧组合重定向，保留来源图片并可幂等回滚；同义成员不复活', async () => {
  const city = `组合解锁-${randomUUID()}`;
  const [rootId, childId, siblingId, memberId] = Array.from({length:4}, () => randomUUID());
  const identity = (id: string, name: string, extra: Record<string, unknown> = {}) => ({version:2,entityId:id,
    canonicalName:name,revision:1,kind:'same_entity',memberNames:[name],memberIds:[id],...extra});
  const parent = {id:rootId!,name:'天安门',payload:{identity:identity(rootId!,'天安门',{kind:'complex'}),
    components:[{name:'天安门升旗',canonicalPlaceId:childId},{name:'天安门降旗',canonicalPlaceId:siblingId}]}};
  const child = {id:childId!,name:'天安门升旗',payload:{identity:identity(childId!,'天安门升旗')}};
  const sibling = {id:siblingId!,name:'天安门降旗',payload:{identity:identity(siblingId!,'天安门降旗')}};
  const member = {id:memberId!,name:'旧同义成员',payload:{identity:identity(memberId!,'旧同义成员')}};
  const client = await pool.connect(); await client.query('BEGIN');
  try {
    for (const [place,source,payload] of [
      [parent,'xhs',{identity:{...parent.payload.identity,memberIds:[rootId,memberId]},components:parent.payload.components}],
      [child,'goldset',{canonicalRedirectTo:rootId,coverImage:'rise.webp',openHours:{text:'升旗时段'}}],
      [sibling,'xhs',{canonicalRedirectTo:rootId,coverImage:'lower.webp'}],
      [member,'xhs',{canonicalRedirectTo:rootId}],
    ] as const) await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,$3,'文化',$4,true,$5,now())`,[place.id,city,place.name,source,payload]);
    // 父项省略、仅名称组成信息或真正的同义成员都不能解除重定向。
    assert.deepEqual(await prepareImportedPlaces(client,city,[child]),[]);
    const authoritativeParent = {...parent,payload:{...parent.payload,identity:{...parent.payload.identity,memberIds:[rootId,memberId]}}};
    const namesOnlyParent = {...authoritativeParent,payload:{...authoritativeParent.payload,components:[{name:child.name}]}};
    assert.equal((await prepareImportedPlaces(client,city,[namesOnlyParent,child])).length,1);
    await assert.rejects(prepareImportedPlaces(client,city,[authoritativeParent,member]),/归属冲突/);
    const before = await captureIdentityImport(client,city);
    const prepared = await prepareImportedPlaces(client,city,[authoritativeParent,child,sibling]);
    assert.equal(prepared.length,3);
    assert.equal(await reconcileImportedPlaces(client,city,prepared),2);
    assert.equal(await reconcileImportedPlaces(client,city,prepared),0);
    const rows = (await client.query('SELECT id,city,name,source,payload FROM canonical_places WHERE city=$1',[city])).rows;
    const index = createPlaceIdentityIndex(rows);
    assert.equal(index.resolve(city,child.name,child.id).status,'resolved');
    assert.equal(index.resolve(city,sibling.name,sibling.id).status,'resolved');
    assert.equal(rows.find(p=>p.id===child.id).payload.canonicalRedirectTo,undefined);
    assert.equal(rows.find(p=>p.id===child.id).source,'goldset');
    assert.equal(rows.find(p=>p.id===child.id).payload.coverImage,'rise.webp');
    assert.equal(rows.find(p=>p.id===sibling.id).payload.coverImage,'lower.webp');
    assert.equal(rows.find(p=>p.id===member.id).payload.canonicalRedirectTo,rootId);
    assert.deepEqual(await prepareImportedPlaces(client,city,[{id:child.id,name:child.name}]),[]);
    const auditId = await recordIdentityImport(client,city,'legacy-components-test',before);
    assert.equal((await rollbackIdentityImport(client,auditId,true)).restored,true);
    assert.deepEqual(await captureIdentityImport(client,city),before);
    // 已有 v2 子实体被同义治理后，不能用老的独立契约抢回。
    await client.query(`UPDATE canonical_places SET payload=payload||jsonb_build_object('identity',$2::jsonb) WHERE id=$1`,
      [child.id,JSON.stringify(child.payload.identity)]);
    assert.equal((await prepareImportedPlaces(client,city,[authoritativeParent,child])).length,1);
  } finally {await client.query('ROLLBACK');client.release();}
});

test('导入主实体后旧名只重定向，检索仍可用别名且不串用城楼闭馆信息', async () => {
  const city = `实体-${randomUUID()}`;
  const names = ['天安门', '天安门广场', '天安门城楼', '奥林匹克森林公园', '奥森', '奥林匹克公园'];
  const rows = names.map((name) => ({ id: randomUUID(), name }));
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    for (const row of rows) await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,lat,lng,payload,created_at)
      VALUES($1,$2,$3,'文化','goldset',true,39.9,116.4,$4,now())`, [row.id, city, row.name,
      { coverImage: 'keep.webp', reservation: 'required', openHours: { closedWeekdays: [1] } }]);
    const root = { ...rows[0]!, payload: {
      identity: { version: 1, canonicalName: '天安门', kind: 'complex', memberNames: names.slice(0, 3) },
      components: [{ name: '天安门城楼', openHours: { closedWeekdays: [1] }, reservation: 'required', reservationNote: '城楼需单独预约' }],
      reservation: 'unknown', reservationNote: '分项核实',
      content: { version: 1, intro: '天安门位于北京中轴线上，红墙与城楼构成标志性景观。广场参观、登城楼与观看升旗可按兴趣选择，各项预约要求应通过对应官方渠道确认。' },
    } };
    const forest = { ...rows[3]!, payload: { identity: { version: 1, canonicalName: '奥林匹克森林公园', kind: 'same_entity', memberNames: names.slice(3, 5) }, aliases: ['奥森'] } };
    assert.equal(await reconcileImportedPlaces(client, city, [root, forest]), 3);
    assert.equal(await reconcileImportedPlaces(client, city, [root, forest]), 0, '重跑幂等');
    const saved = (await client.query('SELECT payload FROM canonical_places WHERE id=$1', [root.id])).rows[0].payload;
    assert.equal(saved.coverImage, 'keep.webp');
    assert.equal(saved.openHours, undefined);
    assert.equal(saved.components[0].openHours.closedWeekdays[0], 1);
    const retrieve = createPlaceRetriever({ query: (sql, values) => client.query(sql, values), embed: async () => null });
    const all = await retrieve([], { city, browse: true, vector: 'off' });
    assert.deepEqual(new Set(all.map((p) => p.name)), new Set(['天安门', '奥林匹克森林公园', '奥林匹克公园']));
    assert.equal((await retrieve(['天安门城楼'], { city, vector: 'off' }))[0]?.name, '天安门');
    assert.equal((await retrieve(['奥森'], { city, vector: 'off' }))[0]?.name, '奥林匹克森林公园');
    assert.match(renderRetrievedPlaces(all), /分项政策/);
    assert.match(renderRetrievedPlaces(all), /红墙与城楼/);
    const routedQuery = mock.method(pool, 'query', client.query.bind(client));
    try {
      const facts = await loadCityPlaceFacts(city);
      assert.equal(facts.get('天安门')?.openTime, undefined, '排程补全不能重新引入被重定向子项的闭馆日');
      assert.equal(facts.get('天安门城楼'), undefined);
    } finally { routedQuery.mock.restore(); }
    const outcome: ResearchOutcome = { pool: [], summary: '', locations: new Map() };
    const tools = buildResearchTools({ destination: city, verifiedPlaces: all, outcome, poiSource: getNullPoiSource(),
      searchSource: getNullSearchSource(), searchWebMax: 2 });
    await tools.find((t) => t.name === 'submit_research')!.execute('submit', { candidates: [{ placeId: root.id, intro: '模型给了一个短句' }] });
    assert.equal(outcome.pool[0]?.intro, root.payload.content.intro, '完整介绍原文复用，不被短句覆盖');
    assert.equal(outcome.pool[0]?.reservation, 'unknown', '主景区不能套用广场预约种子');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('有冲突的归一清单在任何写入之前拒绝', async () => {
  let calls = 0;
  const client = { query: async () => { calls++; return { rows: [], rowCount: 0 }; } };
  const item = (name: string) => ({ id: name, name, payload: { identity: { version: 1, canonicalName: name, memberNames: [name, '冲突名'] } } });
  await assert.rejects(reconcileImportedPlaces(client, '北京', [item('甲'), item('乙')]), /归属冲突/);
  assert.equal(calls, 0);
});

test('稳定身份重命名、旧导出重跑、坐标类别修复和别名检索保持一致', async () => {
  const city = `稳定身份-${randomUUID()}`;
  const id = randomUUID(); const oldId = randomUUID();
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    for (const [placeId, name] of [[id, '老商埠'], [oldId, '经三路老商埠']]) {
      await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,lat,lng,payload,created_at)
        VALUES($1,$2,$3,'美食','xhs',true,36.97,117.20,$4,now())`, [placeId, city, name, { coverImage: `${placeId}.webp` }]);
    }
    const place = { id, name: '济南老商埠', category: '文化', lat: 36.662082, lng: 116.992757, payload: {
      aliases: ['老商埠', '经三路老商埠'], identity: { version: 2, entityId: id, canonicalName: '济南老商埠',
        revision: 1, memberNames: ['济南老商埠', '老商埠', '经三路老商埠'], memberIds: [id, oldId], kind: 'same_entity' },
    } };
    assert.equal((await prepareImportedPlaces(client, city, [place])).length, 1);
    assert.equal(await reconcileImportedPlaces(client, city, [place]), 1);
    assert.equal(await reconcileImportedPlaces(client, city, [place]), 0);
    const retrieve = createPlaceRetriever({ query: (sql, values) => client.query(sql, values), embed: async () => null });
    for (const name of ['济南老商埠', '老商埠', '经三路老商埠', ' 经 三 路 老 商 埠 ']) {
      const places = await retrieve([name], { city, vector: 'off' });
      assert.equal(places.length, 1);
      assert.equal(places[0]!.canonicalPlaceId, id);
      assert.equal(places[0]!.category, '文化');
      assert.equal(places[0]!.lat, place.lat);
    }
    const saved = (await client.query('SELECT id,name,payload FROM canonical_places WHERE city=$1 ORDER BY id', [city])).rows;
    assert.equal(saved.find(p => p.id === id).payload.coverImage, `${id}.webp`);
    assert.equal(saved.find(p => p.id === oldId).payload.coverImage, `${oldId}.webp`);
    assert.equal(saved.find(p => p.id === oldId).payload.canonicalRedirectTo, id);
    assert.deepEqual(await prepareImportedPlaces(client, city, [{ id: oldId, name: '经三路老商埠' }, { id, name: '老商埠' }]), [], '旧导出既不能复活成员，也不能降级主实体');
    await assert.rejects(prepareImportedPlaces(client, city, [{ ...place, payload: { ...place.payload,
      identity: { ...place.payload.identity, revision: 0 } } }]), /身份无效/);
    const newAlias = { ...place, payload: { ...place.payload, aliases: [...place.payload.aliases, '新别名'] } };
    await assert.rejects(prepareImportedPlaces(client, city, [newAlias]), /同版本实体身份声明冲突/);
    assert.equal((await prepareImportedPlaces(client, city, [{ ...place, payload: { ...place.payload,
      aliases: [...place.payload.aliases].reverse(), identity: { ...place.payload.identity,
        memberIds: [...place.payload.identity.memberIds].reverse() } } }])).length, 1, '集合顺序和派生 nameKeys 不影响幂等');
    assert.equal((await prepareImportedPlaces(client, city, [{ ...newAlias, payload: { ...newAlias.payload,
      identity: { ...place.payload.identity, revision: 2 } } }])).length, 1);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('同义合并保留成员原图，主图库至多三张且封面等于首图', async () => {
  const city = `身份图库-${randomUUID()}`;
  const ids = [randomUUID(), randomUUID()];
  const client = await pool.connect(); await client.query('BEGIN');
  try {
    const galleries = ids.map((_, i) => Array.from({ length: 3 }, (_, n) => ({ key: `xhs/${i}-${n}.webp`, provenance: { source: i } })));
    for (const [i,id] of ids.entries()) await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'图库地点','自然','xhs',true,$3,now())`, [id,city,{ coverImage: 'xhs/stale.webp', imageGallery: galleries[i] }]);
    await reconcileImportedPlaces(client,city,[{id:ids[0]!,name:'图库地点',payload:{identity:{version:2,entityId:ids[0],revision:1,
      canonicalName:'图库地点',memberNames:['图库地点'],memberIds:ids,kind:'same_entity'}}}]);
    const rows = (await client.query('SELECT id,payload FROM canonical_places WHERE city=$1',[city])).rows;
    const root = rows.find(row=>row.id===ids[0]).payload;
    assert.equal(root.coverImage,galleries[0]![0]!.key);
    assert.deepEqual(root.imageGallery,galleries[0]);
    assert.deepEqual(rows.find(row=>row.id===ids[1]).payload.imageGallery,galleries[1]);
  } finally {await client.query('ROLLBACK');client.release();}
});

test('v2 按成员 ID 合并，不吞掉同名分店；跨城成员和两个主实体互吞整批拒绝', async () => {
  const city = `身份边界-${randomUUID()}`;
  const ids = Array.from({ length: 4 }, () => randomUUID());
  const client = await pool.connect(); await client.query('BEGIN');
  const item = (id: string, members: string[]) => ({ id, name: '同名饭店', payload: {
    identity: { version: 2, entityId: id, revision: 1, kind: 'same_entity', canonicalName: '同名饭店', memberNames: ['同名饭店'], memberIds: members },
  } });
  try {
    for (let i = 0; i < ids.length; i++) await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'同名饭店','美食','xhs',true,'{}',now())`, [ids[i], i === 3 ? `${city}-其他` : city]);
    await assert.rejects(reconcileImportedPlaces(client, city, [item(ids[0]!, [ids[0]!, ids[3]!])]), /成员范围冲突/);
    await assert.rejects(reconcileImportedPlaces(client, city, [item(ids[0]!, [ids[0]!, ids[1]!]), item(ids[1]!, [ids[1]!])]), /归属冲突/);
    assert.equal(await reconcileImportedPlaces(client, city, [item(ids[0]!, [ids[0]!, ids[1]!])]), 1);
    assert.equal((await client.query("SELECT payload->>'canonicalRedirectTo' redirect FROM canonical_places WHERE id=$1", [ids[2]])).rows[0].redirect, null);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('连续归并压平旧链，明确清空错误坐标并继承同义成员图片', async () => {
  const city = `身份链-${randomUUID()}`;
  const ids = Array.from({length:3},()=>randomUUID());
  const client = await pool.connect(); await client.query('BEGIN');
  const item = (id:string,members:string[]) => ({id,name:'主地点',lat:null,lng:null,payload:{geoStatus:'unresolvable',identity:{version:2,
    entityId:id,revision:2,canonicalName:'主地点',memberNames:['主地点'],memberIds:members,kind:'same_entity'}}});
  try {
    for (const [i,id] of ids.entries()) await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,lat,lng,payload,created_at)
      VALUES($1,$2,'主地点','文化','goldset',true,36.97,117.2,$3,now())`,
      [id,city,{geoStatus:'resolved',...(i===0?{coverImage:'xhs/old.webp'}:{})}]);
    await reconcileImportedPlaces(client,city,[item(ids[1]!,ids.slice(0,2))]);
    await reconcileImportedPlaces(client,city,[item(ids[2]!,ids)]);
    const rows = (await client.query('SELECT id,lat,lng,payload FROM canonical_places WHERE city=$1',[city])).rows;
    const root = rows.find(row=>row.id===ids[2]);
    assert.equal(root.lat,null); assert.equal(root.lng,null); assert.equal(root.payload.coverImage,'xhs/old.webp');
    assert.equal(root.payload.geoStatus,'unresolvable','未知坐标必须同步覆盖金集原有已定位状态');
    assert.ok(rows.filter(row=>row.id!==ids[2]).every(row=>row.payload.canonicalRedirectTo===ids[2]));
  } finally {await client.query('ROLLBACK');client.release();}
});

test('同城并发归并同一成员时只接受一个归属', async () => {
  const city = `身份并发-${randomUUID()}`;
  const ids = Array.from({length:3},()=>randomUUID());
  try {
    for (const id of ids) await pool.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'主地点','文化','xhs',true,'{}',now())`,[id,city]);
    const run = async (id:string) => {
      const client = await pool.connect(); await client.query('BEGIN');
      try {
        await reconcileImportedPlaces(client,city,[{id,name:'主地点',payload:{identity:{version:2,entityId:id,revision:1,
          canonicalName:'主地点',memberNames:['主地点'],memberIds:[id,ids[0]!],kind:'same_entity'}}}]);
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
    };
    const results = await Promise.allSettled([run(ids[1]!),run(ids[2]!)]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
  } finally {await pool.query('DELETE FROM canonical_places WHERE city=$1',[city]);}
});
