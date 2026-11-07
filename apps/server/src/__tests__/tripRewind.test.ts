// rewind 回归（隔离库）：会话关联只挂在将被删除的版本上时，回退后关联重新锚回存活版本、Brief 天数同步。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { makeSampleTrip } from '@tripweaver/shared';
import { pool } from '../db/client';
import { createTrip } from '../services/tripService';
import { rewindTrip } from '../services/tripHistoryService';
import { findConversationForTrip, getConversationDetail } from '../services/conversationService';

after(() => pool.end());

test('rewind 后会话关联锚回存活版本，Brief 天数与回退行程一致', async () => {
  const user = randomUUID();
  await pool.query(`INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,'',now())`, [user, `${user}@example.test`]);
  const source = makeSampleTrip();
  source.days = source.days.slice(0, 2);
  source.days.forEach((day) => { day.legs = []; });
  const v1 = await createTrip(user, source);
  const extended = structuredClone(source);
  extended.days.push({ ...structuredClone(source.days[0]!), id: randomUUID(), dayIndex: 3, title: '第 3 天', activities: [], legs: [] });
  const v2 = await createTrip(user, extended, v1.id);

  // 会话只经 chat_messages.relatedTripId 关联 v2（rewind 会删掉它）；Brief 天数故意留旧值 5
  const conversationId = randomUUID();
  await pool.query(`INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES ($1,$2,'回退测试',now(),now())`, [conversationId, user]);
  await pool.query(`INSERT INTO planning_briefs(conversation_id,user_id,status,data,updated_at) VALUES ($1,$2,'ready',$3,now())`,
    [conversationId, user, JSON.stringify({ destination: source.destination, startDate: source.startDate, days: 5, constraints: [] })]);
  await pool.query(`INSERT INTO chat_messages(id,user_id,conversation_id,role,content,related_trip_id,sequence,created_at)
    VALUES ($1,$2,$3,'assistant','旧关联',$4,1,now())`, [randomUUID(), user, conversationId, v2.id]);

  const result = (await rewindTrip(user, v2.id, {
    operationId: randomUUID(), expectedTripId: v2.id, updatedAt: v2.updatedAt, targetTripId: v1.id,
  }) as { version: number });
  assert.equal(result.version, 1);
  const versions = await pool.query(`SELECT version FROM trips WHERE user_id=$1`, [user]);
  assert.deepEqual(versions.rows.map((row) => row.version), [1], 'target 之后的版本已删除');

  // 关联重新锚回 v1：下一轮「行程 → 会话」反查不落空（prepareDetailChat / ensureTripConversation 依赖它）
  assert.equal(await findConversationForTrip(user, v1.id), conversationId);
  // Brief 天数同步为回退后的行程，而不是停留在旧值
  const detail = await getConversationDetail(user, conversationId);
  assert.equal(detail?.conversation.brief.data.days, 2);
  assert.ok(detail!.messages.some((message) => message.relatedTripId === v1.id), '回退消息把关联锚回存活版本');
});

test('没有关联会话的行程 rewind 不报错', async () => {
  const user = randomUUID();
  await pool.query(`INSERT INTO users(id,email,password_hash,created_at) VALUES ($1,$2,'',now())`, [user, `${user}@example.test`]);
  const source = makeSampleTrip();
  source.days = source.days.slice(0, 1);
  source.days.forEach((day) => { day.legs = []; });
  const v1 = await createTrip(user, source);
  const v2 = await createTrip(user, structuredClone(source), v1.id);
  const result = (await rewindTrip(user, v2.id, {
    operationId: randomUUID(), expectedTripId: v2.id, updatedAt: v2.updatedAt, targetTripId: v1.id,
  }) as { version: number });
  assert.equal(result.version, 1);
});
