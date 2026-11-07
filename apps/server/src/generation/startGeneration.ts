// 表单入口启动生成 durable task 的唯一入口（对话里的 generate_trip 直接在工具内创建子任务，以便等待结果）。
// 失败由调用方决定终态（路由 failJob）。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { GenerationTask, type GenerationTaskInput } from './generationTask';
import { agentStoragePath, ensureAgentStorageDir } from './agentStorage';
import { getAgentRuntime } from '../chat/agent/runtime';

export async function startGenerationTask(input: GenerationTaskInput): Promise<void> {
  await ensureAgentStorageDir();
  const runtime = await getAgentRuntime(agentStoragePath(input.userId));
  const root = await runtime.harness.root(BACKGROUND_CONTEXT);
  await root.commit(
    (tx) => tx.createTask(GenerationTask, input, { ownership: { kind: 'conversation' } }),
    BACKGROUND_CONTEXT,
  );
  runtime.harness.resume();
}