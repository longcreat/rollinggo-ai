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
  type EntryId,
  type Registry,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createSubagentTool } from './subagent';
import { assertSubagentToolNames, toolsForRole } from './toolPolicy';

export type AgentStreamEvent =
  // 当前 generation 的完整正文快照；HITL 后 generation 会重开，增量不可靠。
  | { type: 'text'; text: string }
  | { type: 'tool_start'; callId: string; name: string; startedAt: number }
  | { type: 'tool_end'; callId: string; name: string; status: 'done' | 'error' | 'stopped'; durationMs: number }
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
  /** 用户停止/请求超时：中断本轮并立刻释放存储锁。 */
  signal?: AbortSignal;
  /**
   * 子代理能力：给了它才注册 `spawn_subagents` 工具。
   * 子代理是只读的探索代理（白名单工具），深度固定为 1。
   */
  subagent?: {
    instructions: string;
    /** 子代理模型可见的工具名（只读白名单） */
    childTools: readonly string[];
    maxTurns?: number;
    maxTasks?: number;
    /** 子代理交回结构化地点后回调：调用方把坐标写进本回合点位缓存 */
    onPlaces?: (places: readonly { name: string; lat: number; lng: number }[]) => void;
  };
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

/**
 * 同一份存储同一时刻只允许一个回合。
 *
 * 原因：`registry` 与 `holder` 都是 Harness 级共享槽位 —— 工具扩展按名字整组替换、模型每轮覆盖。
 * 同一用户开两个会话（两个标签页 / 手机+电脑）并发提问时，后一轮会把前一轮的工具闭包换掉，
 * 于是 A 行程的问题可能用 B 行程的 trip 闭包或模型配置回答。只读阶段是答错事实，接上写工具后会改错行程。
 *
 * 取不到锁直接 409：排队会让用户在几十秒后拿到一份基于旧行程快照的回答，比明确失败更糟。
 * 锁是进程内的，前提与既有 startDetailTurn 一致：单实例部署；多副本需要换成分布式锁。
 *
 * 为什么不能用上游的 `submit({ whenBusy: "reject" })` 取代：那是**会话级**判忙，
 * 而 `configure({ tools })` 只把工具**名字**落盘（durable/harness/agent.ts 的 `names()`），
 * 执行时仍从 Harness 共享 registry 解析 —— 同一份存储上两个会话的工具闭包照样互相覆盖。
 * 只要工具还是每轮闭包，这把存储级锁就仍有必要；等工具改为无闭包的纯配置驱动再考虑删。
 */
const activeStorages = new Set<string>();

export class AgentBusyError extends Error {
  readonly statusCode = 409;
  readonly code = 'AGENT_BUSY';
  constructor() {
    super('上一条回答还在进行中，请等它结束后再发');
    this.name = 'AgentBusyError';
  }
}

function acquireStorage(storagePath: string): () => void {
  if (activeStorages.has(storagePath)) throw new AgentBusyError();
  activeStorages.add(storagePath);
  return () => { activeStorages.delete(storagePath); };
}

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
  const entry = opened.then(
    (runtime) => {
      // 存储错误会让 Harness 自行关闭（README「a failure closes the Harness by itself」）。
      // 不摘掉缓存的话，该用户之后每次提问都会命中一个已死的 Harness，只能重启进程。
      void runtime.harness.closed.then(() => {
        if (runtimes.get(storagePath) === entry) runtimes.delete(storagePath);
      });
      return runtime;
    },
    (error: unknown) => {
      // 打开失败不能把失败的 Promise 永久留在缓存里，否则该用户之后每次提问都会命中同一个错误。
      if (runtimes.get(storagePath) === entry) runtimes.delete(storagePath);
      throw error;
    },
  );
  runtimes.set(storagePath, entry);
  return entry;
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
  options.signal?.throwIfAborted();
  // 锁必须先于一切改写共享槽位的动作获取；失败路径也由最外层 finally 释放。
  const release = acquireStorage(options.storagePath);
  try {
    const runtime = await getAgentRuntime(options.storagePath);
    runtime.holder.current = options.models;
    const { harness, registry } = runtime;

    // 工具是每轮闭包（绑定当轮行程与数据源），同名替换即可，会话里的工具选择按名字延续。
    registry.install(defineExtension({ name: 'trip-tools', tools: options.tools }));

    let conversationId = options.conversationId ?? null;
    if (conversationId === null) {
      const conversation = await harness.createConversation({
        ownership: { kind: 'ownerless' },
        agent: { instructions: options.instructions, model: options.model, maxTurns: options.maxTurns },
      }, context);
      conversationId = conversation.id;
      await options.onConversationCreated?.(conversationId);
    }
    const conversation = await harness.conversation(conversationId, context);
    if (!conversation) throw new Error(`durable 会话 ${conversationId} 不存在`);

    // 模型、系统指令与轮次上限按轮写回：用户切换模型后旧会话跟着换；
    // 提示词更新也必须应用到已经存在的 durable 会话，否则老行程会一直用旧 instructions。
    // maxTurns 未设置时传 null：harness 的默认是无上限，同时清掉旧会话里曾经写死的上限。
    await conversation.configure({
      model: options.model,
      instructions: options.instructions,
      maxTurns: options.maxTurns ?? null,
    }, context);

    // 子代理扩展依赖当前会话 id（子会话按「父会话 + 槽位」复用），只能在会话确定后装配。
    if (options.subagent) {
      // 构造期收敛：配置里出现写/交互/派生工具直接失败；再按 toolPolicy 的只读白名单取交集。
      assertSubagentToolNames(options.subagent.childTools);
      const allowed = new Set(options.subagent.childTools);
      const childTools = toolsForRole(options.tools, 'subagent').filter((tool) => allowed.has(tool.name));
      registry.install(defineExtension({
        name: 'subagents',
        tools: [createSubagentTool({
          harness,
          context,
          parentId: String(conversationId),
          model: options.model,
          instructions: options.subagent.instructions,
          childTools,
          maxTurns: options.subagent.maxTurns ?? 6,
          maxTasks: options.subagent.maxTasks ?? 3,
          ...(options.subagent.onPlaces ? { onPlaces: options.subagent.onPlaces } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })],
      }));
    }

    // 用低层 LiveDoc 而非 `conversation.watch()`：后者的 ConversationView 只有
    // conversation/entries/before/docs，不含 tools 与 generation 流式快照，拿不到进度事件。
    const live = await harness.watchDoc(LiveDoc, conversationId, context);
    if (!live) throw new Error('LiveDoc 不可用');

    // 停止/超时：中断 durable 运行。否则一条已无人接收的回答会占着存储锁，后续消息一直 409。
    const onAbort = () => { void conversation.abort(context).catch(() => {}); };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const toolStates = new Map<string, 'running' | 'done' | 'error' | 'stopped'>();
    const openTools = new Map<string, { name: string; startedAt: number }>();
    const toolCalls: string[] = [];
    let streamed = '';

    const finishOpenTools = () => {
      for (const [callId, tool] of openTools) {
        toolStates.set(callId, 'stopped');
        options.onEvent?.({
          type: 'tool_end', callId, name: tool.name, status: 'stopped',
          durationMs: Math.max(0, Date.now() - tool.startedAt),
        });
      }
      openTools.clear();
    };

    live.start(async (call) => {
      if (call.kind !== 'value') return;
      const value = call.value;
      for (const slot of value?.tools ?? []) {
        const previous = toolStates.get(slot.callId);
        if (!previous) {
          const startedAt = Date.now();
          toolStates.set(slot.callId, 'running');
          openTools.set(slot.callId, { name: slot.name, startedAt });
          toolCalls.push(slot.name);
          options.onEvent?.({ type: 'tool_start', callId: slot.callId, name: slot.name, startedAt });
        }
        if (slot.status === 'done' && previous !== 'done' && previous !== 'error') {
          const startedAt = openTools.get(slot.callId)?.startedAt ?? Date.now();
          const failed = Boolean(slot.diagnostics?.some((item) => item.severity === 'error')) || slot.entry === undefined;
          const status = failed ? 'error' : 'done';
          toolStates.set(slot.callId, status);
          openTools.delete(slot.callId);
          options.onEvent?.({
            type: 'tool_end', callId: slot.callId, name: slot.name, status,
            durationMs: Math.max(0, Date.now() - startedAt),
          });
        }
      }
      const partial = value?.generation?.message;
      const text = readAnswerText(partial);
      // generation.message 本身就是完整快照；HITL 后会从空重新长，按快照替换而不是累加增量。
      if (text !== streamed) {
        options.onEvent?.({ type: 'text', text });
        streamed = text;
      }
    });

    try {
      options.signal?.throwIfAborted();
      // 本轮新产生的 durable entries 边界；HITL 会有多条 assistant entry，全部按顺序读回。
      const head = await conversation.entries({ order: 'descending' }, 1, undefined, context).catch(() => undefined);
      const minEntryId = head?.items[0] ? (head.items[0].id + 1) as EntryId : undefined;
      const submission = await conversation.submit({ type: 'input', content: options.prompt }, context);
      let settled = await submission.wait(context);
      // turn_limit 是可续跑的：工具结果已经落盘，continue 会从结果继续并重置轮次计数。
      for (let resume = 0; settled.status === 'unanswered' && settled.reason === 'turn_limit' && resume < 2; resume++) {
        const continuation = await conversation.submit({ type: 'continue' }, context);
        settled = await continuation.wait(context);
      }
      await conversation.waitForIdle(context);
      // 中断后不再把半截回答当结果返回；抛 AbortError 让调用方走「已停止」分支。
      options.signal?.throwIfAborted();
      if (settled.status !== 'done') {
        finishOpenTools();
        const reason = settled.reason;
        options.onEvent?.({ type: 'error', message: String(reason) });
        return { conversationId, status: String(reason), text: '', toolCalls };
      }
      // 普通输入由宿主提交最终回答；continue 的回答已经作为 entry 落盘，直接读 transcript。
      const entry = settled.type === 'input'
        ? await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
        : undefined;
      const answer = readAnswerText(entry?.model?.[0]);
      if (answer && answer !== streamed) options.onEvent?.({ type: 'text', text: answer });
      // 和 pi 的 transcript 一样以 committed entries 为准：ask_user 前后的正文都在，
      // 不再依赖流式增量拼接（增量在 generation 重开时会重复或缺段）。
      const transcript = await conversation.entries({
        ...(minEntryId !== undefined ? { minEntryId } : {}),
        order: 'ascending',
      }, 200, undefined, context).catch(() => undefined);
      const text = transcript?.items
        .filter((item) => item.kind === AssistantEntry.kind)
        .flatMap((item) => item.model ?? [])
        .map((message) => readAnswerText(message))
        .filter((part) => part.trim())
        .join('\n\n') || answer;
      finishOpenTools();
      options.onEvent?.({ type: 'done', conversationId });
      return { conversationId, status: 'done', text, toolCalls };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      finishOpenTools();
      // 停止失败不能盖住原始错误（尤其是 AbortError，调用方靠它区分「已停止」）。
      await live.stop().catch(() => {});
    }
  } finally {
    release();
  }
}