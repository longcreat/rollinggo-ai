// 表单入口 / 行前回合兜底启动生成 durable task 的入口（行程内对话直接在工具内创建子任务）。
// 失败由调用方决定终态（路由 failJob）。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId } from '@earendil-works/pi-durable';
import { GenerationTask, type GenerationTaskInput } from './generationTask';
import { agentStoragePath, ensureAgentStorageDir } from './agentStorage';
import { getAgentRuntime } from '../chat/agent/runtime';
import { readBinding } from '../chat/agent/binding';

export async function startGenerationTask(input: GenerationTaskInput): Promise<void> {
  await ensureAgentStorageDir();
  const runtime = await getAgentRuntime(agentStoragePath(input.userId));
  const root = await runtime.harness.root(BACKGROUND_CONTEXT);
  const conversationId = input.provenance.conversationId;
  // provenance 里是业务会话 id；durable 任务需要的是绑定表中的 durable 会话 id。
  const durableConversationId = conversationId ? await readBinding(input.userId, conversationId) : null;
  await root.commit(
    (tx) => tx.createTask(GenerationTask, input, {
      ownership: { kind: 'conversation' },
      // root 提交不绑定会话：显式挂到来源会话，任务才不是「有会话却无主」。
      ...(durableConversationId ? { conversationId: durableConversationId as unknown as ConversationId } : {}),
    }),
    BACKGROUND_CONTEXT,
  );
  runtime.harness.resume();
}