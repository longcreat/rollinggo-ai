import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db, pool } from '@tripweaver/core/db/client';
import { agentQuestions } from '@tripweaver/core/db/schema';
import { expireConversationQuestions, getQuestion, markQuestionAnswered, markQuestionExpired, recordQuestion } from '@tripweaver/agent/chat/agent/questionStore';

const userIds: string[] = [];
function userId(): string {
  const id = `questions-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  userIds.push(id);
  return id;
}

after(async () => {
  for (const id of userIds) await db.delete(agentQuestions).where(eq(agentQuestions.userId, id));
  await pool.end();
});

function question(userId: string, conversationId: string) {
  const now = Date.now();
  return {
    id: `q-${now}-${Math.random().toString(36).slice(2, 6)}`,
    userId,
    conversationId,
    requestId: 'req-1',
    questions: [{ id: 'q1', question: '要不要删掉第 1 天？', options: [{ label: '删' }, { label: '保留' }] }],
    createdAt: now,
    expiresAt: now + 60_000,
  };
}

test('问题落库 → 回答原地更新，重复回答不覆盖', async () => {
  const uid = userId();
  const q = question(uid, 'conv-1');
  await recordQuestion(q);
  const pending = await getQuestion(uid, 'conv-1', q.id);
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.questions.length, 1);

  await markQuestionAnswered(uid, q.id, [{ id: 'q1', selected: ['删'] }]);
  const answered = await getQuestion(uid, 'conv-1', q.id);
  assert.equal(answered?.status, 'answered');
  assert.deepEqual(answered?.answers, [{ id: 'q1', selected: ['删'] }]);

  // 幂等重试：已回答的行不再被 pending 条件更新覆盖
  await markQuestionAnswered(uid, q.id, [{ id: 'q1', selected: ['保留'] }]);
  assert.deepEqual((await getQuestion(uid, 'conv-1', q.id))?.answers, [{ id: 'q1', selected: ['删'] }]);
});

test('过期只作用于 pending，不把已回答的问题改掉', async () => {
  const uid = userId();
  const answered = question(uid, 'conv-2');
  await recordQuestion(answered);
  await markQuestionAnswered(uid, answered.id, [{ id: 'q1', selected: ['保留'] }]);
  await markQuestionExpired(uid, answered.id);
  assert.equal((await getQuestion(uid, 'conv-2', answered.id))?.status, 'answered');

  const pending = question(uid, 'conv-2');
  await recordQuestion(pending);
  await expireConversationQuestions(uid, 'conv-2');
  assert.equal((await getQuestion(uid, 'conv-2', pending.id))?.status, 'expired');
});
