import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { makeSampleTrip } from '@tripweaver/shared';
import { pool } from '../db/client';
import { createTrip, deleteTrip, listTripVersions } from '../services/tripService';

after(() => pool.end());

async function createUser(): Promise<string> {
  const id = randomUUID();
  await pool.query("INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,'',now())", [id, `${id}@example.test`]);
  return id;
}

/** 直接落库灌入历史版本行，绕过 createTrip 以精确控制行数（版本链一行一个快照）。 */
async function fillChain(userId: string, rootId: string, data: unknown, from: number, to: number) {
  await pool.query(
    `INSERT INTO trips(id,user_id,title,destination,days_count,activity_count,total_cost,used_xhs,root_id,version,parent_id,data,created_at,updated_at)
     SELECT $1::text || '-v' || g::text, $2::text, '灌入版本', '测试地', 1, 0, 0, false, $1::text, g, NULL, $3::jsonb, now(), now()
     FROM generate_series($4::int, $5::int) AS g`,
    [rootId, userId, JSON.stringify(data), from, to],
  );
}

test('单用户累计超过 100 行时仍可创建行程（原先会抛 409 上限）', async () => {
  const user = await createUser();
  const first = await createTrip(user, makeSampleTrip());
  await fillChain(user, first.id, first, 2, 100);
  const [{ n }] = (await pool.query('SELECT count(*)::int AS n FROM trips WHERE user_id=$1', [user])).rows;
  assert.equal(n, 100, '前置条件：该用户已有 100 行');

  const created = await createTrip(user, makeSampleTrip());
  assert.ok(created.id, '超过 100 行后仍应创建成功');
});

test('删除整条版本链：传历史版本 id 清空该链，且不动他人与其他行程', async () => {
  const user = await createUser();
  const other = await createUser();
  const chain = await createTrip(user, makeSampleTrip());
  await fillChain(user, chain.id, chain, 2, 5);
  const kept = await createTrip(user, makeSampleTrip());
  const [{ id: middleId }] = (await pool.query('SELECT id FROM trips WHERE root_id=$1 AND version=3', [chain.id])).rows;

  assert.equal(await deleteTrip(other, middleId), false, '越权删除返回 false');
  assert.equal(await deleteTrip(user, randomUUID()), false, '不存在的行程返回 false');
  assert.equal(await deleteTrip(user, middleId), true, '传历史版本 id 也应删除成功');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM trips WHERE root_id=$1', [chain.id])).rows[0].n, 0, '整条链都应清空');
  assert.equal(await listTripVersions(user, chain.id), null, '链已不存在');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM trips WHERE root_id=$1', [kept.id])).rows[0].n, 1, '同一用户的其他行程不受影响');
});
