import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { eq } from 'drizzle-orm';
import { db, pool } from '@tripweaver/core/db/client';
import { chatMessages, conversations, detailOperations, planningBriefs } from '@tripweaver/core/db/schema';
import { createConversation, getConversationDetail } from '@tripweaver/services/conversationService';
import { appendTaskCompletion } from '@tripweaver/agent/tasks/completionMessage';

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
  const jobId = `job-${Date.now()}`;
  const input = {
    userId,
    conversationId: conversation.id,
    result: {
      id: jobId,
      kind: 'trip_generation' as const,
      status: 'completed' as const,
      artifacts: { tripId: 'trip-new', title: '上海', days: 2 },
    },
  };
  await appendTaskCompletion(input);
  await appendTaskCompletion(input);

  const detail = await getConversationDetail(userId, conversation.id);
  assert.equal(detail?.messages.length, 1);
  const message = detail!.messages[0]!;
  assert.match(message.content, /行程已生成：上海（2 天）/);
  assert.equal(message.relatedTripId, 'trip-new');
  assert.equal(message.attachment?.task, undefined, '任务卡只属于发起任务的委派消息，完成消息不重复挂');
  // 完成消息通过 taskId 与委派消息归为同一任务回合，完成回传自己也有独立的 turnId。
  assert.equal(message.taskId, jobId);
  assert.equal(message.turnId, `task-completion:${jobId}`);
});

test('主 Agent 完成回合的回答覆盖固定完成文案', async () => {
  const userId = `completion-answer-${Date.now()}`;
  userIds.push(userId);
  const conversation = await createConversation(userId, '回答会话');
  await appendTaskCompletion({
    userId,
    conversationId: conversation.id,
    result: {
      id: `job-${Date.now()}`,
      kind: 'trip_generation',
      status: 'completed',
      artifacts: { tripId: 'trip-answer', title: '成都一日', days: 1 },
    },
    answer: '行程好了。最重要提醒：茶馆周末人多。',
  });
  const detail = await getConversationDetail(userId, conversation.id);
  assert.equal(detail!.messages[0]!.content, '行程好了。最重要提醒：茶馆周末人多。');
  assert.equal(detail!.messages[0]!.relatedTripId, 'trip-answer');
});

test('失败也补一条明确未完成的消息，且不指向行程', async () => {
  const userId = `completion-error-${Date.now()}`;
  userIds.push(userId);
  const conversation = await createConversation(userId, '失败会话');
  await appendTaskCompletion({
    userId,
    conversationId: conversation.id,
    result: {
      id: `job-${Date.now()}`,
      kind: 'trip_generation',
      status: 'failed',
      error: '模型不可用',
      artifacts: { destination: '成都', days: 3 },
    },
  });
  const detail = await getConversationDetail(userId, conversation.id);
  assert.match(detail!.messages[0]!.content, /任务没有完成：模型不可用/);
  assert.equal(detail!.messages[0]!.relatedTripId, undefined);
});
