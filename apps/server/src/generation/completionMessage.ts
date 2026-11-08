// 生成结束后往来源会话补一条完成消息：用户回到对话能看到结果与任务卡，而不是只有一条通知。
// 用 commitOperation((userId, jobId)) 幂等：重启重跑、重复回调都不会产生第二条消息。
import type { ChatAttachment } from '@tripweaver/shared';
import { appendMessages } from '../services/conversationService';
import { commitOperation } from '../services/detailOperationService';

export interface GenerationCompletionInput {
  userId: string;
  jobId: string;
  conversationId?: string | null;
  status: 'done' | 'error';
  tripId?: string | null;
  tripTitle?: string;
  destination?: string;
  days?: number;
  message?: string;
  /** 主 Agent 完成回合的回答；缺省时退回固定文案。 */
  answer?: string;
}

export async function appendGenerationCompletion(input: GenerationCompletionInput): Promise<void> {
  if (!input.conversationId) return;
  const done = input.status === 'done' && Boolean(input.tripId);
  const label = input.tripTitle || input.destination || '新行程';
  // 任务卡只属于发起任务的委派消息：完成消息只播报结果并指向新行程，
  // 不重复挂 task，也不重复摘要（摘要由任务卡按 jobId 读取）。
  const fallback = done
    ? `行程已生成：${label}${input.days ? `（${input.days} 天）` : ''}。`
    : `生成没有完成：${input.message ?? '请稍后重试'}。`;
  const content = input.answer?.trim() || fallback;
  const attachment: ChatAttachment = {
    tripId: done ? input.tripId! : '',
    summary: [],
    candidates: [],
  };

  await commitOperation(input.userId, `gen-completion:${input.jobId}`, 'generation-completion', async (tx) => {
    const messages = await appendMessages({
      userId: input.userId,
      conversationId: input.conversationId!,
      messages: [{
        role: 'assistant',
        content,
        turnId: `gen-completion:${input.jobId}`,
        taskId: input.jobId,
        attachment,
        ...(done ? { relatedTripId: input.tripId! } : {}),
      }],
    }, tx);
    return { messages };
  });
}
