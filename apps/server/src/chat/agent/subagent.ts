// 子代理（探索型）工具：主代理把「需要多次检索的局部调研」并行下发给只读子代理。
//
// 为什么不是纯粹的多次工具调用：
//   - 并行调研 3 个主题时，主代理的上下文会被三份原始搜索结果塞满；子代理各自消化后只回结论。
//   - 参考出发鸭的 explore_sub_*：子代理专精局部检索（POI/通勤/口碑），主代理只做编排与决策。
//
// 与 opencode `subagent` 工具的差异（有意为之）：
//   - 不做后台模式、不做「继续某个子会话」：我们的场景是单轮调研，前台阻塞返回就够了。
//   - 一个工具一次派发多个任务（Promise.all 并行）：不依赖运行时是否并行执行多个 tool call。
//   - 子代理固定只读（`childTools` 白名单 + 不注册本工具）→ 深度恒为 1，不会出现子代理改行程。
//
// 会话复用：子会话按「父会话 + 任务槽位」复用，第一次创建后长期保留。
// pi-durable 没有删除会话的 API，若每个任务每次都新建，SQLite 会随对话轮次无限增长；
// 复用后每个父会话最多额外 3 个子会话。子会话首轮上下文是全新的，所以任务提示必须自包含。
import { AssistantEntry, defineTool, type ConversationId, type Harness, type ToolRegistration } from '@earendil-works/pi-durable';
import { arr, obj, str } from '@earendil-works/pi-schema';

export interface SubagentTaskResult {
  id: string;
  ok: boolean;
  text: string;
}

export interface SubagentToolOptions {
  harness: Harness;
  context: unknown;
  /** 父会话 id：作为子会话缓存键的一部分 */
  parentId: string;
  model: { provider: string; modelId: string };
  /** 子代理的系统提示词（角色、边界、输出格式） */
  instructions: string;
  /** 子代理模型可见的工具（白名单，传注册对象）；不含写工具与派发工具 */
  childTools: readonly ToolRegistration[];
  maxTurns: number;
  /** 单次最多并行几个子任务 */
  maxTasks: number;
  signal?: AbortSignal;
  /** 子会话创建后回调（测试用来断言子代理拿到的工具白名单） */
  onChildCreated?: (id: ConversationId) => void;
}

/** 进程级子会话表：parentId + 槽位 → durable 会话 id */
const childConversations = new Map<string, ConversationId>();
/** 同一槽位不允许并发跑两个任务（复用的会话同一时刻只能有一个回合） */
const slotChains = new Map<string, Promise<unknown>>();

function readAnswerText(message: unknown): string {
  const content = (message as { content?: { type?: string; text?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text!).join('');
}

/** 槽位名只保留安全字符，避免把用户/模型给的 id 拼进缓存键时打架 */
function slotOf(taskId: string): string {
  const clean = taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  return clean || 'task';
}

export function createSubagentTool(options: SubagentToolOptions): ToolRegistration {
  const { harness, parentId, maxTasks } = options;
  const context = options.context as never;

  async function ensureChild(slot: string) {
    const key = `${parentId}|${slot}`;
    const known = childConversations.get(key);
    if (known) {
      const existing = await harness.conversation(known, context);
      if (existing) return existing;
    }
    const conversation = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: {
        instructions: options.instructions,
        model: options.model,
        maxTurns: options.maxTurns,
        // 只有这些工具对子代理的模型可见：写工具与派发工具都被挡在外面（深度恒为 1）。
        modelTools: [...options.childTools],
      },
    }, context);
    childConversations.set(key, conversation.id);
    options.onChildCreated?.(conversation.id);
    return conversation;
  }

  async function runTask(task: { id: string; prompt: string }): Promise<SubagentTaskResult> {
    const slot = slotOf(task.id);
    const key = `${parentId}|${slot}`;
    // 同一槽位串行：复用同一个子会话，不能同时跑两个回合
    const previous = slotChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      options.signal?.throwIfAborted();
      const conversation = await ensureChild(slot);
      const submission = await conversation.submit({ type: 'input', content: task.prompt }, context);
      const settled = await submission.wait(context);
      await conversation.waitForIdle(context);
      options.signal?.throwIfAborted();
      if (settled.status !== 'done' || settled.type !== 'input') {
        const reason = settled.status === 'unanswered' ? settled.reason : settled.status;
        return { id: task.id, ok: false, text: `子任务未完成：${String(reason)}` };
      }
      const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      const text = readAnswerText(entry?.model?.[0]).trim() || readAnswerText(settled.answer).trim();
      return { id: task.id, ok: Boolean(text), text: text || '子任务没有返回内容' };
    });
    slotChains.set(key, run);
    return run;
  }

  return defineTool({
    name: 'spawn_subagents',
    description: [
      '并行派发只读调研子任务：每个子任务是一个独立上下文的探索代理，各自查地点/攻略/天气后只回结论。',
      '适合：一次要同时调研多天安排、多个片区、或对比几组候选地点。',
      '不适合：单点查询（直接调 search_places / web_search 更快）、改行程（子代理无写权限）。',
      '任务提示必须自包含：子代理看不到本轮对话与主代理已得出的结论。',
    ].join('\n'),
    parameters: obj({
      tasks: arr(obj({
        id: str({ description: '任务短标识，如 day1 / day2 / food；同一个 id 会复用同一个子代理会话' }),
        prompt: str({ description: '自包含的调研任务：范围（第几天/哪个片区）、要找什么、输出格式' }),
      }), { description: `最多 ${maxTasks} 个子任务` }),
    }),
    execute: async (args) => {
      options.signal?.throwIfAborted();
      const tasks = args.tasks.slice(0, maxTasks).map((task) => ({ id: task.id.trim() || 'task', prompt: task.prompt.trim() }));
      const results = await Promise.all(tasks.map(runTask));
      return { output: [{ type: 'text' as const, text: JSON.stringify({ results }) }] };
    },
  });
}

/** 测试用：清掉进程内子会话缓存 */
export function resetSubagentCache(): void {
  childConversations.clear();
  slotChains.clear();
}
