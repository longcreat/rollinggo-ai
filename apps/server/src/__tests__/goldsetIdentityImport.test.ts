import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/client';
import { captureIdentityImport, rollbackIdentityImport } from '../services/placeIdentityAudit';
import { relationDigest } from '../services/placeRelationIdentity';
import { importGoldsetCity } from '../services/goldsetPlaceImport';

after(()=>pool.end());
const derived=(city:string,name:string)=>createHash('sha256').update(city+name).digest('hex').slice(0,32);
const activity=(name:string,category='文化')=>({name,category,lat:30,lng:120,coordSource:'geocoded' as const});
const execute=(script:string,folder:string,...args:string[])=>promisify(execFile)(process.execPath,
  ['--import','tsx',fileURLToPath(new URL(`../../scripts/${script}`,import.meta.url)),'--snapshot-dir',folder,...args],
  {env:process.env,windowsHide:true,timeout:30000});
async function cleanup(folder:string) {
  assert.equal(path.dirname(path.resolve(folder)).toLowerCase(),path.resolve(tmpdir()).toLowerCase());
  assert.ok(path.basename(folder).startsWith('goldset-identity-'));
  await rm(folder,{recursive:true,force:true});
}

test('实际金集seed不能重建已声明的旧别名ID或撤回名称，独立新增可审计回滚',async()=>{
  const city=`金集新增-${randomUUID()}`,folder=await mkdtemp(path.join(tmpdir(),'goldset-identity-'));
  const rootId=derived(city,'乙园'),aliasId=derived(city,'乙园旧名'),retiredId=derived(city,'旧咖啡');
  const rootPayload={identity:{version:2,entityId:rootId,revision:2,canonicalName:'乙园',kind:'same_entity',
    memberIds:[rootId,aliasId],memberNames:['乙园','乙园旧名']},aliases:['乙园旧名','乙园别称']};
  const client=await pool.connect();
  try {
    await client.query(`INSERT INTO canonical_places(id,city,name,category,verified,source,payload,created_at)
      VALUES($1,$2,'乙园','文化',TRUE,'xhs',$3,now()),($4,$2,'旧咖啡','美食',FALSE,'xhs',$5,now())`,
      [rootId,city,rootPayload,retiredId,{identityWithdrawal:{candidateIds:[]},aliases:['旧咖啡别称']}]);
    const before=await captureIdentityImport(client,city);
    await writeFile(path.join(folder,'fixture.json'),JSON.stringify({caseId:'identity',trip:{destination:city,
      days:[{activities:[activity('乙园旧名'),activity('乙园别称'),activity('旧咖啡'),activity('旧咖啡别称'),activity('独立新园')]}]}}));
    await execute('seed-canonical-places.ts',folder);
    assert.equal((await client.query('SELECT 1 FROM canonical_places WHERE id=$1',[aliasId])).rowCount,0,'已被memberIds占用的旧ID不能重建');
    for(const name of ['乙园别称','旧咖啡别称']) assert.equal((await client.query('SELECT 1 FROM canonical_places WHERE id=$1',[derived(city,name)])).rowCount,0,name);
    assert.deepEqual((await client.query('SELECT payload FROM canonical_places WHERE id=$1',[rootId])).rows[0].payload,rootPayload);
    assert.equal((await client.query('SELECT verified FROM canonical_places WHERE id=$1',[retiredId])).rows[0].verified,false);
    assert.equal((await client.query('SELECT source FROM canonical_places WHERE id=$1',[derived(city,'独立新园')])).rows[0].source,'goldset');
    const audits=(await client.query('SELECT id FROM place_identity_imports WHERE city=$1',[city])).rows;
    assert.equal(audits.length,1);
    await execute('seed-canonical-places.ts',folder);
    assert.equal((await client.query('SELECT 1 FROM place_identity_imports WHERE city=$1',[city])).rowCount,1);
    await client.query('BEGIN'); await rollbackIdentityImport(client,audits[0].id,true);
    assert.deepEqual(await captureIdentityImport(client,city),before); await client.query('COMMIT');
    await execute('seed-canonical-places.ts',folder,'--dry-run');
    assert.deepEqual(await captureIdentityImport(client,city),before);
  } finally {await client.query('ROLLBACK');client.release();await cleanup(folder);}
});

test('实际金集restore保留身份、受控来源和图片，旧类别变化清向量，整批幂等并可回滚',async()=>{
  const city=`金集恢复-${randomUUID()}`,folder=await mkdtemp(path.join(tmpdir(),'goldset-identity-'));
  const rootId=derived(city,'乙园'),oldId=derived(city,'旧行');
  const rootPayload={identity:{version:2,entityId:rootId,revision:4,canonicalName:'乙园',kind:'same_entity',memberIds:[rootId],memberNames:['乙园']},
    aliases:['乙园别称'],mentionSources:[{mentionId:1,noteId:1,inputHash:'a'.repeat(64)}],
    imageIdentity:{version:1,mode:'reviewed',entityId:rootId,revision:4,approved:[]},
    coverImage:{key:'kept.webp'},imageGallery:[{key:'kept.webp'}],embeddedText:`${city} 乙园 乙园别称 文化`};
  const oldPayload={coverImage:{key:'old.webp'},embeddedText:`${city} 旧行 文化`};
  const vector=`[${Array(1024).fill(0.01).join(',')}]`;
  const client=await pool.connect();
  try {
    await client.query(`INSERT INTO canonical_places(id,city,name,category,verified,source,payload,embedding,created_at)
      VALUES($1,$2,'乙园','文化',TRUE,'xhs',$3,$6::vector,now()),($4,$2,'旧行','文化',TRUE,'xhs',$5,$6::vector,now())`,
      [rootId,city,rootPayload,oldId,oldPayload,vector]);
    const sourceState={city,algorithmVersion:3,minMentions:2,surfaces:[],mentions:[],entities:[]};
    const manifest={version:1,revision:1,sourceHash:relationDigest(sourceState),relationHash:relationDigest([]),sourceState};
    await client.query('INSERT INTO place_relation_snapshots(city,manifest,relations,available_ids) VALUES($1,$2,$3,$4)',[city,manifest,'[]',JSON.stringify([rootId])]);
    const before=await captureIdentityImport(client,city);
    await writeFile(path.join(folder,'fixture.json'),JSON.stringify({caseId:'identity',trip:{destination:city,
      days:[{activities:[activity('乙园','美食'),activity('旧行','美食')]}]}}));
    await execute('restore-goldset.ts',folder);
    const root=(await client.query('SELECT * FROM canonical_places WHERE id=$1',[rootId])).rows[0];
    for(const [key,value] of Object.entries(rootPayload)) assert.deepEqual(root.payload[key],value,key);
    assert.equal(root.category,'文化');assert.equal(root.source,'goldset');assert.ok(root.embedding);
    const old=(await client.query('SELECT * FROM canonical_places WHERE id=$1',[oldId])).rows[0];
    assert.equal(old.category,'美食');assert.equal(old.embedding,null);assert.equal(old.payload.embeddedText,undefined);
    assert.deepEqual(old.payload.coverImage,oldPayload.coverImage);
    assert.deepEqual((await captureIdentityImport(client,city)).relationSnapshots,before.relationSnapshots);
    const audits=(await client.query('SELECT id FROM place_identity_imports WHERE city=$1',[city])).rows;
    assert.equal(audits.length,1);
    await execute('restore-goldset.ts',folder);
    assert.equal((await client.query('SELECT 1 FROM place_identity_imports WHERE city=$1',[city])).rowCount,1);
    await client.query('BEGIN');await rollbackIdentityImport(client,audits[0].id,true);
    assert.deepEqual(await captureIdentityImport(client,city),before);await client.query('COMMIT');
    await execute('restore-goldset.ts',folder,'--dry-run');
    assert.deepEqual(await captureIdentityImport(client,city),before);
  } finally {await client.query('ROLLBACK');client.release();await cleanup(folder);}
});

test('金集恢复等待图片行锁，读取提交后的图库并将它保存在回滚前快照',async()=>{
  const city=`金集并发-${randomUUID()}`,id=derived(city,'乙园');
  const writer=await pool.connect(),importer=await pool.connect();
  let importing:ReturnType<typeof importGoldsetCity>|undefined;
  try {
    await writer.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'乙园','文化','xhs',TRUE,'{}',now())`,[id,city]);
    await writer.query('BEGIN');
    const newPayload={coverImage:{key:'concurrent.webp'},imageGallery:[{key:'concurrent.webp'}]};
    await writer.query('UPDATE canonical_places SET payload=$2 WHERE id=$1',[id,newPayload]);
    await importer.query('BEGIN');
    await importer.query("SET LOCAL statement_timeout='10s'");
    const pid=(await importer.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    importing=importGoldsetCity(importer,city,[{city,caseId:'concurrent',activity:activity('乙园')}],'restore');
    // 显式等待数据库确认锁冲突，不能靠固定延时猜测调度顺序。
    const deadline=Date.now()+5000;
    let blocked=false;
    while(Date.now()<deadline) {
      blocked=(await writer.query<{blocked:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0]!.blocked;
      if(blocked) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(blocked,'恢复必须等待未提交的图片更新');
    await writer.query('COMMIT');
    const result=await importing;
    await importer.query('COMMIT');
    const row=(await writer.query('SELECT payload FROM canonical_places WHERE id=$1',[id])).rows[0];
    assert.deepEqual(row.payload.coverImage,newPayload.coverImage);
    assert.deepEqual(row.payload.imageGallery,newPayload.imageGallery);
    assert.ok(result.auditId);
    await writer.query('BEGIN');
    await rollbackIdentityImport(writer,result.auditId,true);
    assert.deepEqual((await writer.query('SELECT payload FROM canonical_places WHERE id=$1',[id])).rows[0].payload,newPayload);
    await writer.query('COMMIT');
  } finally {
    await writer.query('ROLLBACK');
    await importing?.catch(()=>{});
    await importer.query('ROLLBACK');
    writer.release();importer.release();
  }
});

test('可选pgvector未提供向量列时仍可恢复金集来源并回滚审计',async()=>{
  const city=`金集无向量-${randomUUID()}`,id=derived(city,'旧行');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // 专用测试库内事务性模拟启动迁移跳过可选pgvector，finally恢复DDL。
    await client.query('ALTER TABLE canonical_places DROP COLUMN embedding');
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'旧行','文化','xhs',TRUE,$3,now())`,[id,city,{coverImage:{key:'kept.webp'},embeddedText:'过期文本'}]);
    const before=await captureIdentityImport(client,city);
    const result=await importGoldsetCity(client,city,[{city,activity:activity('旧行','美食')}],'restore');
    const row=(await client.query('SELECT source,category,payload FROM canonical_places WHERE id=$1',[id])).rows[0];
    assert.equal(row.source,'goldset');assert.equal(row.category,'美食');
    assert.equal(row.payload.embeddedText,undefined);assert.deepEqual(row.payload.coverImage,{key:'kept.webp'});
    assert.ok(result.auditId);await rollbackIdentityImport(client,result.auditId,true);
    assert.deepEqual(await captureIdentityImport(client,city),before);
  } finally {await client.query('ROLLBACK');client.release();}
});
