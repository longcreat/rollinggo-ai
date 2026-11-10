// 子代理（探索型）工具：主代理把「需要多次检索的局部调研」并行下发给只读子代理。
//
// 为什么不是纯粹的多次工具调用：
//   - 并行调研 3 个主题时，主代理的上下文会被三份原始搜索结果塞满；子代理各自消化后只回结论。
//   - 参考出发鸭的 explore_sub_*：子代理专精局部检索（POI/通勤/口碑），主代理只做编排与决策。
//
// 结构化返回：子代理最后输出固定 JSON 契约（kind=places / notes），服务端严格解析；
// 解析失败回退文本，不阻塞主代理。pi-durable 的终态工具在创建会话时会被 modelTools 过滤，
// 因此这里不用 submit_places/submit_notes，而是由主代理侧的 parseData 统一校验。
//
// 与 opencode `subagent` 工具的差异（有意为之）：
//   - 不做后台模式、不做「继续某个子会话」：我们的场景是单轮调研，前台阻塞返回就够了。
//   - 一个工具一次派发多个任务（Promise.all 并行）：不依赖运行时是否并行执行多个 tool call。
//   - 子代理固定只读（`childTools` 白名单 + 不注册本工具）→ 深度恒为 1，不会出现子代理改行程。
//
// 会话复用：子会话按「父会话 + 任务槽位」复用，同一槽位串行。pi-durable 没有删除会话的 API，
// 复用避免每轮新建 SQLite 会话；槽位由主代理任务 id 决定，因此任务提示必须自包含。
// 工具面在创建时按 toolPolicy 收敛为只读白名单。
// 缓存有界：slotChains 只保留在跑的链（结束即删），childConversations 超过上限按插入序淘汰最旧的，
// 否则单实例长期运行会随会话数无限增长。
import { AssistantEntry, defineTool, type ConversationId, type Extension, type Harness, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable';
import { arr, obj, opt, str } from '@earendil-works/pi-schema';
import type { Context } from '@earendil-works/chord/context';
import { assertSubagentToolNames } from './toolPolicy';

/** 子代理产出类型：固定两种，避免「让模型自己设计 schema」 */
export type SubagentKind = 'places' | 'notes';

export interface SubagentPlace {
  name: string;
  address?: string;
  lat: number;
  lng: number;
  category?: string;
  reason?: string;
  openTime?: string;
  rating?: string;
  cost?: number;
  sourceUrl?: string;
}

export interface SubagentNote {
  topic: string;
  detail: string;
  sourceUrl?: string;
}

export type SubagentData =
  | { kind: 'places'; places: SubagentPlace[] }
  | { kind: 'notes'; notes: SubagentNote[]; cautions: SubagentNote[] };

export interface SubagentTaskResult {
  id: string;
  ok: boolean;
  kind: SubagentKind;
  text: string;
  /** 终态工具的产出；子代理没提交时缺省，调用方回退到 text */
  data?: SubagentData;
}

export interface SubagentToolOptions {
  harness: Harness;
  context: unknown;
  /** 父会话 id：作为子会话缓存键的一部分 */
  parentId: string;
  model: { provider: string; modelId: string };
  /** 子代理的系统提示词（角色、边界、输出格式） */
  instructions: string;
  /** 子代理模型可见的工具（白名单，传注册对象本身）；不含写工具与 spawn_subagents */
  childTools: readonly ToolRegistration[];
  /** 子会话显式选择的扩展（父会话的工具扩展）：避免默认「全部已安装」把生成阶段工具也选进来。 */
  childExtensions?: readonly Extension[];
  maxTurns: number;
  /** 单次最多并行几个子任务 */
  maxTasks: number;
  signal?: AbortSignal;
  /** 子会话创建后回调（测试用来断言子代理拿到的工具白名单） */
  onChildCreated?: (id: ConversationId) => void;
  /** 结构化地点产出后回调：调用方把坐标写进本回合的点位缓存，供 add_activity 复用 */
  onPlaces?: (places: readonly SubagentPlace[]) => void;
}

/** 进程级子会话表：parentId + 槽位 → durable 会话 id（有界，超限淘汰最旧） */
const childConversations = new Map<string, ConversationId>();
const CHILD_CACHE_MAX = 256;
/** 同一槽位不允许并发跑两个任务（复用的会话同一时刻只能有一个回合）；只保存在跑的链 */
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

function normalizeKind(value: string | undefined): SubagentKind {
  return value === 'places' ? 'places' : 'notes';
}

const PLACE_LIMIT = 6;

/** 从子代理最终回答里取 JSON（允许 ``` 围栏），严格校验后转成结构化产出。 */
function parseData(text: string, kind: SubagentKind): SubagentData | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const raw = fenced ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; }
  const record = parsed as Record<string, unknown>;
  const pick = (item: unknown) => {
    const node = item as Record<string, unknown> | null;
    const topic = typeof node?.topic === 'string' ? node.topic.trim() : '';
    const detail = typeof node?.detail === 'string' ? node.detail.trim() : '';
    if (!topic || !detail) return null;
    const sourceUrl = typeof node?.sourceUrl === 'string' && /^https?:\/\//.test(node.sourceUrl) ? node.sourceUrl : undefined;
    return { topic, detail, ...(sourceUrl ? { sourceUrl } : {}) };
  };
  if (kind === 'places') {
    const list = Array.isArray(record.places) ? record.places : [];
    const places = list.flatMap((item) => {
      const node = item as Record<string, unknown> | null;
      const name = typeof node?.name === 'string' ? node.name.trim() : '';
      const lat = typeof node?.lat === 'number' && Number.isFinite(node.lat) ? node.lat : null;
      const lng = typeof node?.lng === 'number' && Number.isFinite(node.lng) ? node.lng : null;
      if (!name || lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return [];
      return [{
        name,
        lat, lng,
        ...(typeof node?.address === 'string' && node.address.trim() ? { address: node.address.trim() } : {}),
        ...(typeof node?.category === 'string' && node.category.trim() ? { category: node.category.trim() } : {}),
        ...(typeof node?.reason === 'string' && node.reason.trim() ? { reason: node.reason.trim() } : {}),
        ...(typeof node?.openTime === 'string' && node.openTime.trim() ? { openTime: node.openTime.trim() } : {}),
        ...(typeof node?.rating === 'string' && node.rating.trim() ? { rating: node.rating.trim() } : {}),
        ...(typeof node?.cost === 'number' && Number.isFinite(node.cost) ? { cost: Math.round(node.cost) } : {}),
        ...(typeof node?.sourceUrl === 'string' && /^https?:\/\//.test(node.sourceUrl) ? { sourceUrl: node.sourceUrl } : {}),
      }];
    }).slice(0, PLACE_LIMIT);
    return places.length ? { kind: 'places', places } : undefined;
  }
  const notes = (Array.isArray(record.notes) ? record.notes : []).map(pick).filter((item): item is SubagentNote => item !== null).slice(0, 5);
  const cautions = (Array.isArray(record.cautions) ? record.cautions : []).map(pick).filter((item): item is SubagentNote => item !== null).slice(0, 5);
  return notes.length ? { kind: 'notes', notes, cautions } : undefined;
}

export function createSubagentTool(options: SubagentToolOptions): ToolRegistration {
  // 子代理在创建时就只允许只读工具；写/交互/派生工具不能进入子会话（参考 openclaw 的委派策略）。
  assertSubagentToolNames(options.childTools.map((tool) => tool.name));
  const { harness, parentId, maxTasks } = options;
  const context = options.context as never;

  async function ensureChild(slot: string, api: ToolExecutionApi, context: Context) {
    const key = `${parentId}|${slot}`;
    const known = childConversations.get(key);
    if (known) {
      const existing = await harness.conversation(known, context);
      if (existing) {
        // 复用的子会话跟随父会话的模型/指令更新；否则用户切换模型后子代理仍走旧模型。
        await existing.configure({
          model: options.model,
          instructions: options.instructions,
          maxTurns: options.maxTurns,
          // 子代理是检索型工作，不继承主对话的思考等级。
          thinkingLevel: 'off',
          ...(options.childExtensions ? { extensions: options.childExtensions } : {}),
          modelTools: [...options.childTools],
        }, context);
        return existing;
      }
    }
    // 官方子代理模型：子会话由当前工具调用任务拥有（ownership.taskId = api.taskId），
    // 工具被取消/失败/宿主中断时子会话一起被中止，父回合的空闲等待也会覆盖它。
    const childId = await api.commit(async (tx) => {
      const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
      if (existing) return existing.id;
      const created = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
      return created.id;
    }, context);
    const conversation = await harness.conversation(childId, context);
    if (!conversation) throw new Error('子代理会话创建失败');
    await conversation.configure({
      model: options.model,
      instructions: options.instructions,
      maxTurns: options.maxTurns,
      // 子代理是检索型工作，不继承主对话的思考等级。
      thinkingLevel: 'off',
      ...(options.childExtensions ? { extensions: options.childExtensions } : {}),
      // 只有这些工具对子代理的模型可见：写工具与派发工具都被挡在外面（深度恒为 1）。
      modelTools: [...options.childTools],
    }, context);
    childConversations.set(key, conversation.id);
    while (childConversations.size > CHILD_CACHE_MAX) {
      const oldest = childConversations.keys().next().value;
      if (oldest === undefined) break;
      childConversations.delete(oldest);
    }
    options.onChildCreated?.(conversation.id);
    return conversation;
  }

  async function runTask(
    task: { id: string; kind: SubagentKind; prompt: string },
    api: ToolExecutionApi,
    context: Context,
  ): Promise<SubagentTaskResult> {
    const slot = slotOf(task.id);
    const key = `${parentId}|${slot}`;
    // 同一槽位串行：复用同一个子会话，不能同时跑两个回合
    const previous = slotChains.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      options.signal?.throwIfAborted();
      const conversation = await ensureChild(slot, api, context);
      // 官方前台子代理：子会话由工具调用任务拥有，这里只驱动一次提交并等待结果。
      // requestId 绑定任务与槽位：重跑时不会向同一子会话重复投递同一条调研。
      const submission = await conversation.submit({
        type: 'input',
        content: task.prompt,
        requestId: `subagent:${api.taskId}:${slot}`,
      }, context);
      const settled = await submission.wait(context);
      await conversation.waitForIdle(context);
      options.signal?.throwIfAborted();

      if (settled.status !== 'done' || settled.type !== 'input') {
        const reason = settled.status === 'unanswered' ? settled.reason : settled.status;
        // 失败时把子会话最近几条记录带上，便于定位（模型报错/工具校验失败都看得到）
        const recent = await conversation.entries({ order: 'descending' }, 2, undefined, context).catch(() => undefined);
        const detail = recent?.items?.map((item) => (item.data ? JSON.stringify(item.data) : '').slice(0, 300)).filter(Boolean).join(' | ') ?? '';
        return { id: task.id, ok: false, kind: task.kind, text: `子任务未完成：${String(reason)}${detail ? `（${detail}）` : ''}` };
      }
      const entry = settled.answer
        ? await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
        : null;
      const text = (readAnswerText(entry?.model?.[0]) || readAnswerText(settled.answer)).trim();
      const data = parseData(text, task.kind);
      if (data?.kind === 'places' && data.places.length) options.onPlaces?.(data.places);
      const fallback = data
        ? (data.kind === 'places' ? `已提交 ${data.places.length} 个地点` : `已提交 ${data.notes.length} 条结论`)
        : '子任务没有返回可解析的结论';
      return {
        id: task.id,
        ok: Boolean(data) || Boolean(text),
        kind: task.kind,
        text: text || fallback,
        ...(data ? { data } : {}),
      };
    });
    slotChains.set(key, run);
    // 只保留在跑的链：结束后摘掉，否则每个槽位都会永久占一条（下一轮从这里续上即可）。
    // 用 then 的两分支而不是 finally，避免派生出未处理的 rejection。
    void run.then(
      () => { if (slotChains.get(key) === run) slotChains.delete(key); },
      () => { if (slotChains.get(key) === run) slotChains.delete(key); },
    );
    return run;
  }

  return defineTool({
    name: 'spawn_subagents',
    // 子会话按 ownerTaskId 找回、提交按 requestId 去重，重跑不会重复调研。
    replay: 'safe',
    description: [
      '并行派发只读调研子任务：每个子任务是一个独立上下文的探索代理，各自查地点/攻略/天气后只回结论。',
      'kind=places 让子代理核实地点并交回「名称 + 真实坐标 + 营业/人均」，适合找餐厅、景点、住宿；',
      'kind=notes 让它交回结论与风险提示，适合查预约政策、排队、通勤。',
      '适合：一次要同时调研多天安排、多个片区、或对比几组候选地点。不适合：单点查询（直接调 search_places 更快）。',
      '任务提示必须自包含：子代理看不到本轮对话与主代理已得出的结论。',
    ].join('\n'),
    parameters: obj({
      tasks: arr(obj({
        id: str({ description: '任务短标识，如 day1 / day2 / food；同一个 id 会复用同一个子代理会话' }),
        kind: opt(str({ description: '产出类型：places / notes（缺省 notes）' })),
        prompt: str({ description: '自包含的调研任务：范围（第几天/哪个片区）、要找什么、输出要求' }),
      }), { description: `最多 ${maxTasks} 个子任务` }),
    }),
    execute: async (args, api, context) => {
      options.signal?.throwIfAborted();
      const tasks = args.tasks.slice(0, maxTasks).map((task) => ({
        id: task.id.trim() || 'task',
        kind: normalizeKind(task.kind),
        prompt: task.prompt.trim(),
      }));
      const results = await Promise.all(tasks.map((task) => runTask(task, api, context)));
      return { output: [{ type: 'text' as const, text: JSON.stringify({ results }) }] };
    },
  });
}

/** 测试用：清掉进程内子会话与捕获缓存 */
export function resetSubagentCache(): void {
  childConversations.clear();
  slotChains.clear();
}
