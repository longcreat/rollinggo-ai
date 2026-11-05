import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/client';
import { captureIdentityImport, recordIdentityImport, rollbackIdentityImport } from '../services/placeIdentityAudit';
import { resolveImageIdentities } from '../services/placeImageIdentity';

after(() => pool.end());

test('导入审计原样恢复照片与语料，后续修改拒绝回滚；重复回滚幂等', async () => {
  const city = `回滚-${randomUUID()}`;
  const id = randomUUID();
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'老商埠','美食','xhs',true,$3,now())`, [id, city, { coverImage: 'xhs/old.webp', aliases: [] }]);
    await client.query(`INSERT INTO research_evidence(id,place_id,city,kind,strength,content,source_url,fetched_at)
      VALUES($1,$2,$3,'xhs_reason','weak','原始介绍','https://example.com/note',now())`, [randomUUID(), id, city]);
    const before = await captureIdentityImport(client, city);
    await client.query("UPDATE canonical_places SET name='融汇老商埠',category='文化' WHERE id=$1", [id]);
    await client.query('DELETE FROM research_evidence WHERE city=$1', [city]);
    const audit = await recordIdentityImport(client, city, 'test-hash', before);
    assert.deepEqual(await rollbackIdentityImport(client, audit), { city, restored: false });
    await client.query("UPDATE canonical_places SET name='之后的修改' WHERE id=$1", [id]);
    await assert.rejects(rollbackIdentityImport(client, audit, true), /后续修改/);
    await client.query("UPDATE canonical_places SET name='融汇老商埠' WHERE id=$1", [id]);
    assert.equal((await rollbackIdentityImport(client, audit, true)).restored, true);
    assert.deepEqual(await captureIdentityImport(client, city), before);
    assert.equal((await rollbackIdentityImport(client, audit, true)).restored, true);
  } finally { await client.query('ROLLBACK'); client.release(); }
});

test('旧图片清单用成员ID解析，保留文件及溯源，不把子景点照片借给母景区', () => {
  const places = [{ id: 'root', city: '济南', name: '融汇老商埠', payload: {
    identity: { entityId: 'root', kind: 'same_entity', memberIds: ['root', 'old'] } } },
    { id: 'old', city: '济南', name: '经三路老商埠', payload: { canonicalRedirectTo: 'root' } },
    { id: 'complex', city: '济南', name: '组合', payload: { identity: { kind: 'complex', memberIds: ['complex', 'child'] } } }];
  const photo = { key: 'xhs/old/00.webp', provenance: { sourceUrl: 'https://example.com/a' } };
  const skipped: string[] = [];
  const result = resolveImageIdentities('济南', new Map([['old', [photo]], ['child', [{ key: 'xhs/child.webp' }]],
    ['missing', [photo]]]), places, id => skipped.push(id));
  assert.deepEqual(result.get('root'), [photo]);
  assert.equal(result.has('complex'), false);
  assert.deepEqual(skipped, ['child', 'missing']);
  assert.equal(resolveImageIdentities('杭州', new Map([['old', [photo]]]), places).size, 0);
});

test('旧批次没有关系快照时按原边界回滚，保留后来建立的普通关系', async () => {
  const city = `旧审计-${randomUUID()}`, id = randomUUID();
  const client = await pool.connect(); await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
      VALUES($1,$2,'原名','文化','xhs',true,'{}',now())`, [id, city]);
    const before = await captureIdentityImport(client, city);
    await client.query("UPDATE canonical_places SET name='新名' WHERE id=$1", [id]);
    const audit = await recordIdentityImport(client, city, 'legacy-format', before);
    await client.query(`UPDATE place_identity_imports SET before_state=before_state-'relations'-'relationImports',
      after_state=after_state-'relations'-'relationImports' WHERE id=$1`, [audit]);
    await client.query(`INSERT INTO place_relation(id,city,from_name,to_name,strength,note_count,created_at)
      VALUES($1,$2,'普通甲','普通乙','direct',2,now())`, [randomUUID(), city]);
    await rollbackIdentityImport(client, audit, true);
    assert.equal((await client.query('SELECT name FROM canonical_places WHERE id=$1', [id])).rows[0].name, '原名');
    assert.equal((await client.query('SELECT count(*)::int n FROM place_relation WHERE city=$1', [city])).rows[0].n, 1);
  } finally { await client.query('ROLLBACK'); client.release(); }
});
