// 启动生成 durable task 的唯一入口：路由与详情对话（start_generation）共用。
// 失败由调用方决定终态（路由 failJob、对话 cancelJob）。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { GenerationTask, type GenerationTaskInput } from './generationTask';
import { generationStoragePath, ensureAgentStorageDir } from './agentStorage';
import { getAgentRuntime } from '../chat/agent/runtime';

export async function startGenerationTask(input: GenerationTaskInput): Promise<void> {
  await ensureAgentStorageDir();
  const runtime = await getAgentRuntime(generationStoragePath(input.userId));
  const root = await runtime.harness.root(BACKGROUND_CONTEXT);
  await root.commit(
    (tx) => tx.createTask(GenerationTask, input, { ownership: { kind: 'conversation' } }),
    BACKGROUND_CONTEXT,
  );
  runtime.harness.resume();
}