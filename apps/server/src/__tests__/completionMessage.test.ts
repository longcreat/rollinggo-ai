import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db, pool } from '../db/client';
import { chatMessages, conversations, detailOperations, planningBriefs } from '../db/schema';
import { createConversation, getConversationDetail } from '../services/conversationService';
import { appendGenerationCompletion } from '../generation/completionMessage';

const userIds: string[] = [];
after(async () => {
  for (const id of userIds) {
    await db.delete(chatMessages).where(eq(chatMessages.userId, id));
    await db.delete(planningBriefs).where(eq(planningBriefs.userId, id));
    await db.delete(conversations).where(eq(conversations.userId, id));
    await db.delete(detailOperations).where(eq(detailOperations.userId, id));
  }
  await pool.end();
});

test('完成消息写入来源会话，重复回调只有一条', async () => {
  const userId = `completion-test-${Date.now()}`;
  userIds.push(userId);
  const conversation = await createConversation(userId, '测试会话');
  const input = {
    userId,
    jobId: `job-${Date.now()}`,
    conversationId: conversation.id,
    status: 'done' as const,
    tripId: 'trip-new',
    destination: '上海',
    days: 2,
    summary: '上海两日文化漫步',
  };
  await appendGenerationCompletion(input);
  await appendGenerationCompletion(input);

  const detail = await getConversationDetail(userId, conversation.id);
  assert.equal(detail?.messages.length, 1);
  const message = detail!.messages[0]!;
  assert.match(message.content, /行程已生成/);
  assert.equal(message.relatedTripId, 'trip-new');
  assert.equal(message.attachment?.task?.jobId, input.jobId);
});

test('失败也补一条明确未完成的消息，且不指向行程', async () => {
  const userId = `completion-error-${Date.now()}`;
  userIds.push(userId);
  const conversation = await createConversation(userId, '失败会话');
  await appendGenerationCompletion({
    userId,
    jobId: `job-${Date.now()}`,
    conversationId: conversation.id,
    status: 'error',
    destination: '成都',
    days: 3,
    message: '模型不可用',
  });
  const detail = await getConversationDetail(userId, conversation.id);
  assert.match(detail!.messages[0]!.content, /生成没有完成：模型不可用/);
  assert.equal(detail!.messages[0]!.relatedTripId, undefined);
});
