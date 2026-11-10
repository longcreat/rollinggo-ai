// 任务结束后往来源会话补一条完成消息：用户回到对话能看到结果与任务卡，而不是只有一条通知。
// 用 commitOperation((userId, jobId)) 幂等：重启重跑、重复回调都不会产生第二条消息。
import type { ChatAttachment } from '@tripweaver/shared';
import { appendMessages } from '@tripweaver/services/conversationService';
import { commitOperation } from '@tripweaver/services/detailOperationService';
import type { DelegatedTaskResult } from './delegatedTask';

export interface TaskCompletionMessageInput {
  userId: string;
  conversationId?: string | null;
  result: DelegatedTaskResult;
  /** 主 Agent 完成回合的回答；缺省时退回固定文案。 */
  answer?: string;
}

export async function appendTaskCompletion(input: TaskCompletionMessageInput): Promise<void> {
  if (!input.conversationId) return;
  const { result } = input;
  const tripId = result.artifacts?.tripId;
  const done = result.status === 'completed' && typeof tripId === 'string' && Boolean(tripId);
  const label = result.artifacts?.title || result.artifacts?.destination || '任务';
  const days = result.artifacts?.days;
  // 任务卡只属于发起任务的委派消息：完成消息只播报结果并指向产物，
  // 不重复挂 task，也不重复摘要（摘要由任务卡按 taskId 读取）。
  const fallback = done
    ? `行程已生成：${label}${days ? `（${days} 天）` : ''}。`
    : result.status === 'aborted'
      ? '任务已取消。'
      : `任务没有完成：${result.error ?? '请稍后重试'}。`;
  const content = input.answer?.trim() || fallback;
  const attachment: ChatAttachment = {
    tripId: done ? tripId : '',
    summary: [],
    candidates: [],
  };

  // 操作键沿用 gen-completion：历史完成消息已经按这个键幂等落库。
  await commitOperation(input.userId, `gen-completion:${result.id}`, 'generation-completion', async (tx) => {
    const messages = await appendMessages({
      userId: input.userId,
      conversationId: input.conversationId!,
      messages: [{
        role: 'assistant',
        content,
        turnId: `task-completion:${result.id}`,
        taskId: result.id,
        attachment,
        ...(done ? { relatedTripId: tripId } : {}),
      }],
    }, tx);
    return { messages };
  });
}
