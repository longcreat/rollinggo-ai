// 子 Agent 任务结束后，把任务结果作为通知交回主 Agent 的同一会话。
//
// 对齐 harness 的「后台任务完成 → 通知主 Agent → 主 Agent 继续会话」：
// 这里复用 main chat 的 durable conversation（没有则创建并绑定），只跑一轮无工具回合，
// 再把回答写回业务会话；失败时退回固定完成文案，不阻断已经成功的任务。
// 提示词只描述「任务结果」，不包含任何行程生成专属规则。
import type { ConversationId } from '@earendil-works/pi-durable';
import type { LlmConfig } from '@rollinggo-trip/core/settingsService';
import { readBinding, saveBinding } from '../chat/agent/binding';
import { agentModelRef, buildAgentModels } from '../chat/agent/models';
import { runAgentTurn } from '../chat/agent/runtime';
import { agentStoragePath, ensureAgentStorageDir } from '../generation/agentStorage';
import { appendTaskCompletion } from './completionMessage';
import { taskResultLines, type DelegatedTaskResult } from './delegatedTask';

const DELIVERY_INSTRUCTIONS = [
  '你是 RollingGo 的主行程助手。一个后台子 Agent 任务已经结束。',
  '只根据给定的任务结果，用 1–2 句简洁中文告诉用户结果，并给出最重要的 1 条提醒。',
  '不要调用工具，不要编造未提供的信息，不要输出 JSON、Markdown 表格或长列表。',
].join('\n');

export interface TaskCompletionTurnInput {
  userId: string;
  conversationId?: string | null;
  result: DelegatedTaskResult;
  cfg: LlmConfig;
  signal?: AbortSignal;
}

export async function deliverTaskResult(input: TaskCompletionTurnInput): Promise<void> {
  const conversationId = input.conversationId;
  if (!conversationId) return;
  try {
    await ensureAgentStorageDir();
    const prompt = [
      '后台任务结果：',
      ...taskResultLines(input.result),
      '请给用户一句最终回复。',
    ].join('\n');

    const binding = await readBinding(input.userId, conversationId);
    const turn = await runAgentTurn({
      storagePath: agentStoragePath(input.userId),
      models: await buildAgentModels(input.cfg),
      tools: [],
      instructions: DELIVERY_INSTRUCTIONS,
      model: agentModelRef(input.cfg.model),
      thinkingLevel: 'off',
      prompt,
      maxTurns: 1,
      ...(binding !== null ? { conversationId: binding as unknown as ConversationId } : {}),
      onConversationCreated: async (id) => {
        await saveBinding(input.userId, conversationId, id);
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });

    await appendTaskCompletion({
      userId: input.userId,
      conversationId,
      result: input.result,
      answer: turn.text,
    });
  } catch {
    // 完成回合失败不改变任务成败：至少保留一条固定完成消息。
    await appendTaskCompletion({
      userId: input.userId,
      conversationId,
      result: input.result,
    }).catch(() => {});
  }
}
