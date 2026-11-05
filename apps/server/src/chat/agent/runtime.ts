// 行程详情 Agent 的运行时：一个用户一份 SQLite，一个会话一个 durable conversation。
//
// 这里只做三件事：装配 Harness、把一轮消息跑完、把 LiveDoc 的变化翻成事件。
// 业务数据（行程、来源、提交）全部由调用方通过工具闭包注入，运行时不懂旅行。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai/models';
import {
  AssistantEntry,
  Harness,
  LiveDoc,
  createRegistry,
  defineExtension,
  type ConversationId,
  type Registry,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; callId: string; name: string }
  | { type: 'tool_end'; callId: string; name: string; status: string }
  | { type: 'done'; conversationId: ConversationId }
  | { type: 'error'; message: string };

export interface RunAgentTurnOptions {
  storagePath: string;
  models: Models | (() => Models);
  tools: ToolRegistration[];
  /** 系统提示词；每个会话只在创建时写一次。 */
  instructions: string;
  /** 本轮的模型（provider + modelId），每次运行都写回会话配置。 */
  model: { provider: string; modelId: string };
  prompt: string;
  /** 不传则新建 durable 会话。 */
  conversationId?: ConversationId | null;
  maxTurns?: number;
  onEvent?: (event: AgentStreamEvent) => void;
  /** 新建会话后回调，调用方借此把 durable id 写进业务库。 */
  onConversationCreated?: (id: ConversationId) => Promise<void>;
}

export interface AgentTurnResult {
  conversationId: ConversationId;
  status: string;
  text: string;
  toolCalls: string[];
}

interface Runtime {
  harness: Harness;
  registry: Registry;
  /** 每轮写入当前模型的容器：Harness 在请求时才读，避免为换 Key 重开存储。 */
  holder: { current: Models | (() => Models) | null };
}

const runtimes = new Map<string, Promise<Runtime>>();

async function openRuntime(storagePath: string): Promise<Runtime> {
  const registry = createRegistry();
  const holder: Runtime['holder'] = { current: null };
  const harness = await Harness.open(await openNodeSqliteStorage(storagePath), {
    models: () => {
      if (!holder.current) throw new Error('Agent 模型尚未配置');
      return typeof holder.current === 'function' ? holder.current() : holder.current;
    },
    registry,
  }, BACKGROUND_CONTEXT);
  return { harness, registry, holder };
}

/** 同一个存储只开一个 Harness（pi-durable 要求单进程独占存储）。 */
export function getAgentRuntime(storagePath: string): Promise<Runtime> {
  const existing = runtimes.get(storagePath);
  if (existing) return existing;
  const opened = openRuntime(storagePath);
  runtimes.set(storagePath, opened);
  return opened;
}

/** 测试/关停用：释放某份存储上的 Harness。 */
export async function closeAgentRuntime(storagePath: string): Promise<void> {
  const pending = runtimes.get(storagePath);
  if (!pending) return;
  runtimes.delete(storagePath);
  const runtime = await pending;
  await runtime.harness.close(BACKGROUND_CONTEXT);
}

function readAnswerText(message: unknown): string {
  const content = (message as { content?: { type?: string; text?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text!).join('');
}

/**
 * 跑一轮：订阅 LiveDoc（工具状态 + 流式片段），结束后读最终答案。
 * 工具事件同时用于 SSE 的进度提示。
 */
export async function runAgentTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
  const context = BACKGROUND_CONTEXT;
  const runtime = await getAgentRuntime(options.storagePath);
  runtime.holder.current = options.models;
  const { harness, registry } = runtime;

  // 工具是每轮闭包（绑定当轮行程与数据源），同名替换即可，会话里的工具选择按名字延续。
  registry.install(defineExtension({ name: 'trip-tools', tools: options.tools }));

  let conversationId = options.conversationId ?? null;
  if (conversationId === null) {
    const conversation = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: { instructions: options.instructions, model: options.model, maxTurns: options.maxTurns ?? 10 },
    }, context);
    conversationId = conversation.id;
    await options.onConversationCreated?.(conversationId);
  }
  const conversation = await harness.conversation(conversationId, context);
  if (!conversation) throw new Error(`durable 会话 ${conversationId} 不存在`);

  // 模型按轮写回：用户切换 Key/模型后，旧会话也会跟着换。
  await conversation.configure({ model: options.model }, context);

  const live = await harness.watchDoc(LiveDoc, conversationId, context);
  if (!live) throw new Error('LiveDoc 不可用');
  const toolStates = new Map<string, string>();
  const toolCalls: string[] = [];
  let streamed = '';

  live.start(async (call) => {
    if (call.kind !== 'value') return;
    const value = call.value;
    for (const slot of value?.tools ?? []) {
      const previous = toolStates.get(slot.callId);
      if (!previous) {
        toolStates.set(slot.callId, slot.status);
        toolCalls.push(slot.name);
        options.onEvent?.({ type: 'tool_start', callId: slot.callId, name: slot.name });
      }
      if (slot.status === 'done' && previous !== 'done') {
        toolStates.set(slot.callId, 'done');
        options.onEvent?.({ type: 'tool_end', callId: slot.callId, name: slot.name, status: slot.status });
      }
    }
    const partial = value?.generation?.message;
    const text = readAnswerText(partial);
    if (text.length > streamed.length) {
      options.onEvent?.({ type: 'text', text: text.slice(streamed.length) });
      streamed = text;
    }
  });

  try {
    const submission = await conversation.submit({ type: 'input', content: options.prompt }, context);
    const settled = await submission.wait(context);
    await conversation.waitForIdle(context);
    if (settled.status !== 'done' || settled.type !== 'input') {
      const reason = settled.status === 'unanswered' ? settled.reason : settled.status;
      options.onEvent?.({ type: 'error', message: String(reason) });
      return { conversationId, status: String(reason), text: '', toolCalls };
    }
    const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
    const answer = readAnswerText(entry?.model?.[0]);
    if (answer.length > streamed.length) options.onEvent?.({ type: 'text', text: answer.slice(streamed.length) });
    options.onEvent?.({ type: 'done', conversationId });
    return { conversationId, status: 'done', text: answer, toolCalls };
  } finally {
    await live.stop();
  }
}