// 生成任务完成后的主 Agent 回合：把子 Agent 的结果交回主对话，由主 Agent 生成最终回复。
//
// 对齐 harness 的「后台任务完成 → 通知主 Agent → 主 Agent 继续同一会话」：
// 这里复用 main chat 的 durable conversation（没有则创建并绑定），只跑一轮无工具回合，
// 再把回答写回业务会话；失败时退回固定完成文案，不阻断已经成功的生成任务。
import type { ConversationId } from '@earendil-works/pi-durable';
import type { LlmConfig } from '../services/settingsService';
import { readBinding, saveBinding } from '../chat/agent/binding';
import { agentModelRef, buildAgentModels } from '../chat/agent/models';
import { runAgentTurn } from '../chat/agent/runtime';
import { getConversationDetail } from '../services/conversationService';
import { appendGenerationCompletion } from './completionMessage';
import { agentStoragePath, ensureAgentStorageDir } from './agentStorage';

const COMPLETION_INSTRUCTIONS = [
  '你是 RollingGo 的主行程助手。后台行程规划任务已经完成。',
  '只根据给定的任务结果，用 1–2 句简洁中文告诉用户行程已生成，并给出最重要的 1 条注意事项。',
  '不要调用工具，不要编造未提供的信息，不要输出 JSON、Markdown 表格或长列表。',
].join('\n');

export interface CompletionTurnInput {
  userId: string;
  jobId: string;
  conversationId?: string | null;
  tripId: string;
  tripTitle: string;
  days: number;
  summary?: string;
  reviewNotes?: string[];
  cfg: LlmConfig;
  signal?: AbortSignal;
}

export async function runCompletionTurn(input: CompletionTurnInput): Promise<void> {
  const conversationId = input.conversationId;
  if (!conversationId) return;
  try {
    await ensureAgentStorageDir();
    const detail = await getConversationDetail(input.userId, conversationId);
    const lastUser = detail?.messages.filter((message) => message.role === 'user').at(-1)?.content.trim();
    const lines = [
      `行程标题：${input.tripTitle}`,
      `天数：${input.days}`,
      ...(input.summary ? [`规划摘要：${input.summary.slice(0, 400)}`] : []),
      ...(input.reviewNotes?.length ? [`提醒：${input.reviewNotes.slice(0, 3).join('；')}`] : []),
    ];
    const prompt = [
      `用户原始请求：${lastUser || '规划一份行程'}`,
      '后台任务结果：',
      ...lines,
      '请给用户一句最终回复。',
    ].join('\n');

    const binding = await readBinding(input.userId, conversationId);
    const result = await runAgentTurn({
      storagePath: agentStoragePath(input.userId),
      models: await buildAgentModels(input.cfg),
      tools: [],
      instructions: COMPLETION_INSTRUCTIONS,
      model: agentModelRef(input.cfg.model),
      prompt,
      maxTurns: 1,
      ...(binding !== null ? { conversationId: binding as unknown as ConversationId } : {}),
      onConversationCreated: async (id) => {
        await saveBinding(input.userId, conversationId, id);
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });

    await appendGenerationCompletion({
      userId: input.userId,
      jobId: input.jobId,
      conversationId,
      status: 'done',
      tripId: input.tripId,
      tripTitle: input.tripTitle,
      days: input.days,
      answer: result.text,
    });
  } catch {
    // 完成回合失败不改变任务成败：至少保留一条固定完成消息。
    await appendGenerationCompletion({
      userId: input.userId,
      jobId: input.jobId,
      conversationId,
      status: 'done',
      tripId: input.tripId,
      tripTitle: input.tripTitle,
      days: input.days,
    }).catch(() => {});
  }
}
