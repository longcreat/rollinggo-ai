import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/client';
import { loadPlaceRelations } from '../generation/scheduling/placeRelations';
import { captureIdentityImport, rollbackIdentityImport } from '../services/placeIdentityAudit';

after(() => pool.end());

test('关系消费与真实重导入隔离受控主体，空清单只清其旧边并可倒序回滚', async () => {
  const city = `关系范围-${randomUUID()}`;
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const names = ['受控门店', '普通甲', '普通乙', '撤回泛名', '受控旧名'];
  const folder = await mkdtemp(path.join(tmpdir(), 'place-relation-policy-'));
  const file = path.join(folder, 'xhs-place-relations-scope.json');
  const client = await pool.connect();
  const execute = () => promisify(execFile)(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../../scripts/seed-xhs-relations.ts', import.meta.url)), file],
    { env: process.env, windowsHide: true, timeout: 30000 });
  try {
    for (const [i, id] of ids.entries()) {
      const payload = { identity: { version: 2, entityId: id, memberIds: [id], memberNames: [names[i]], kind: 'same_entity' },
        ...(i === 0 ? { mentionSources: [] } : i === 3 ? { identityWithdrawal: { candidateIds: [ids[0]] } }
          : i === 4 ? { canonicalRedirectTo: ids[0] } : {}) };
      await client.query(`INSERT INTO canonical_places(id,city,name,category,source,verified,payload,created_at)
        VALUES($1,$2,$3,'文化','xhs',$4,$5,now())`, [id, city, names[i], i !== 3, payload]);
    }
    const pairs = [[0, 1], [3, 1], [4, 1], [1, 2]] as const;
    for (const [from, to] of pairs) await client.query(`INSERT INTO place_relation(id,city,from_name,to_name,strength,note_count,created_at)
      VALUES($1,$2,$3,$4,'direct',2,now())`, [randomUUID(), city, ...[names[from], names[to]].sort()]);
    const before = await captureIdentityImport(client, city);
    const consumed = await loadPlaceRelations(city);
    assert.equal(consumed.size, 2);
    assert.deepEqual(consumed.get(`id:${ids[1]}`), [`id:${ids[2]}`]);
    await writeFile(file, JSON.stringify({ city, generatedAt: '2026-10-07', relations: [] }));
    await execute();
    assert.equal((await client.query('SELECT count(*)::int n FROM place_relation WHERE city=$1', [city])).rows[0].n, 1);
    assert.equal((await client.query("SELECT row_count FROM data_import WHERE city=$1 AND source='xhs_relations'", [city])).rows[0].row_count, 0);
    await writeFile(file, JSON.stringify({ city, generatedAt: '2026-10-07', relations: pairs.map(([from, to]) => ({
      from: names[from], to: names[to], strength: 'direct', noteCount: 2,
    })) }));
    await execute();
    assert.equal((await client.query('SELECT count(*)::int n FROM place_relation WHERE city=$1', [city])).rows[0].n, 1);
    await writeFile(file, JSON.stringify({ city, generatedAt: '2026-10-07' }));
    await assert.rejects(execute(), /缺少完整 relations/);
    const audits = (await client.query('SELECT id FROM place_identity_imports WHERE city=$1 ORDER BY created_at DESC', [city])).rows;
    assert.equal(audits.length, 2);
    await client.query('BEGIN');
    await assert.rejects(rollbackIdentityImport(client, audits[1]!.id, true), /后续修改/);
    for (const audit of audits) await rollbackIdentityImport(client, audit.id, true);
    assert.deepEqual(await captureIdentityImport(client, city), before);
    await client.query('COMMIT');
    assert.equal((await loadPlaceRelations(city)).size, 2, '恢复旧物理边也不能绕过当前消费政策');
  } finally {
    await client.query('ROLLBACK');
    await client.query('DELETE FROM place_identity_imports WHERE city=$1', [city]);
    await client.query('DELETE FROM place_relation WHERE city=$1', [city]);
    await client.query('DELETE FROM canonical_places WHERE city=$1', [city]);
    await client.query('DELETE FROM data_import WHERE city=$1', [city]);
    client.release();
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('place-relation-policy-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
