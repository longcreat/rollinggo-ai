import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {pool} from '../db/client';

after(()=>pool.end());
test('真实向量回填跳过撤回/待审/重定向，等待模型期间失效的地点也不能写回',async()=>{
  const city=`回填身份-${randomUUID()}`;
  const ids=Object.fromEntries(['active','changing','pending','withdrawn','malformed','redirected'].map(k=>[k,randomUUID()]));
  const requests:string[][]=[];
  const server=createServer(async(req,res)=>{
    try {
      let body='';for await(const chunk of req) body+=chunk;
      const data=JSON.parse(body) as {input:string[]};requests.push(data.input);
      // 仅改变verified，不改变文本快照；写入端必须再次检查资格。
      await pool.query('UPDATE canonical_places SET verified=false WHERE id=$1',[ids.changing]);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({data:data.input.map(()=>({embedding:Array(1024).fill(0.01)}))}));
    } catch(error) {res.writeHead(500);res.end(String(error));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address==='object');
  try {
    for(const [kind,id] of Object.entries(ids)) {
      const payload=kind==='redirected'?{canonicalRedirectTo:ids.active}
        : ['withdrawn','malformed'].includes(kind)?{identityWithdrawal:{version:1,revision:2,reason:'unavailable_source',candidateIds:[]}}:{};
      await pool.query(`INSERT INTO canonical_places(id,city,name,category,verified,source,payload,created_at)
        VALUES($1,$2,$3,'美食',$4,'xhs',$5,now())`,[id,city,kind,!['pending','withdrawn'].includes(kind),payload]);
    }
    const run=()=>promisify(execFile)(process.execPath,['--import','tsx',
      fileURLToPath(new URL('../../scripts/embed-backfill.ts',import.meta.url)),'--tables','places','--city',city],
      {env:{...process.env,EMBEDDING_BASE_URL:`http://127.0.0.1:${address.port}/v1`,EMBEDDING_API_KEY:'local-test',
        EMBEDDING_MODEL:'test',EMBEDDING_DIMS:'1024'},windowsHide:true,timeout:15000});
    await run();
    assert.equal(requests.length,1);
    assert.deepEqual(new Set(requests[0]),new Set([`${city} active 美食`,`${city} changing 美食`]));
    const rows=(await pool.query('SELECT id,embedding IS NOT NULL embedded,payload FROM canonical_places WHERE city=$1',[city])).rows;
    for(const row of rows) {
      assert.equal(row.embedded,row.id===ids.active);
      assert.equal(typeof row.payload.embeddedText==='string',row.id===ids.active);
    }
    await run();assert.equal(requests.length,1,'第二次没有合格待回填行');
  } finally {
    await pool.query('DELETE FROM canonical_places WHERE city=$1',[city]);
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
