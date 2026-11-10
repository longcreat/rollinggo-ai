// 行程详情 Agent 运行时：工具循环、事件映射、会话续用。
// 用 faux provider 驱动，不碰网络与数据库。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineExtension, defineTask, defineTool } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import type { Trip } from '@rollinggo-trip/shared';
import { AgentBusyError, closeAgentRuntime, getAgentRuntime, runAgentTurn, type AgentStreamEvent } from '@rollinggo-trip/agent/chat/agent/runtime';
import { createTripTools } from '@rollinggo-trip/agent/chat/agent/tools';
import { createTripDraft } from '@rollinggo-trip/agent/chat/agent/tripDraft';
import { createAgentTurnState } from '@rollinggo-trip/agent/chat/agent/turnState';
import type { DetailSources } from '@rollinggo-trip/integrations/detailSources';

const directories: string[] = [];
const paths: string[] = [];

async function storage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rollinggo-trip-agent-'));
  directories.push(dir);
  const path = join(dir, 'runs.sqlite');
  paths.push(path);
  return path;
}

after(async () => {
  for (const path of paths) await closeAgentRuntime(path).catch(() => {});
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
});

const trip: Trip = {
  id: 'trip-1',
  title: '成都三日',
  destination: '成都',
  startDate: '2026-11-10',
  budgetLevel: '舒适',
  totalBudget: 0,
  preferences: ['文化'],
  partySize: 2,
  extraNotes: '',
  transportMode: 'transit',
  days: [{
    id: 'day-1', dayIndex: 1, title: '市区漫步',
    activities: [
      { id: 'act-1', name: '人民公园', startTime: '09:00', endTime: '11:00', description: '喝茶', lat: 30.66, lng: 104.06, coordSource: 'geocoded', category: '文化', sourceNotes: [] },
      { id: 'act-2', name: '宽窄巷子', startTime: '14:00', endTime: '16:00', description: '逛街', lat: 30.67, lng: 104.05, coordSource: 'geocoded', category: '文化', sourceNotes: [] },
    ],
  }],
  meta: { usedXhs: false, reviewNotes: [] },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function fakeSources() {
  const calls = { poi: [] as string[], web: [] as string[] };
  const sources = {
    poi: {
      kind: 'null',
      searchPois: async (category: string, keyword: string) => {
        calls.poi.push(`${category}:${keyword}`);
        return [{ name: '陈麻婆豆腐', type: '川菜', address: '青羊区', rating: '4.6', cost: '', opentime: '', photoUrls: [], adcode: '', location: { lat: 30.67, lng: 104.05 } }];
      },
      selfCheck: async () => ({ ok: true }),
    },
    search: {
      kind: 'null',
      search: async (query: string) => {
        calls.web.push(query);
        return [{ title: '人民公园攻略', url: 'https://example.com/a', summary: '早上去人少', siteName: 'example', datePublished: '' }];
      },
      selfCheck: async () => ({ ok: true }),
    },
    notes: new Set<string>(),
    calls: { poi: 0, search: 0 },
    web: [],
    assertHealthy: () => {},
  } as unknown as DetailSources;
  return { sources, calls };
}

function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

/** 可被测试卡住的工具：用于制造「一轮正在运行」的窗口。abort 时立刻放行，避免测试挂死。 */
function gatedTool(onStart: () => void, gate: Promise<void>, signal: AbortSignal) {
  return defineTool({
    name: 'get_trip',
    description: '测试用阻塞工具',
    parameters: obj({}),
    execute: async () => {
      onStart();
      await Promise.race([
        gate,
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      return { output: [{ type: 'text' as const, text: JSON.stringify({ trip: 'A 行程' }) }] };
    },
  });
}

function gateOf() {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  return { gate, release, started: startedPromise, markStarted: started };
}

describe('agent runtime', () => {
  it('模型自己读行程后回答，工具调用进入事件流', async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('第 1 天上午在人民公园喝茶，下午去宽窄巷子。'),
    ]);
    const { sources } = fakeSources();
    const events: AgentStreamEvent[] = [];
    const result = await runAgentTurn({
      storagePath: await storage(),
      models,
      tools: createTripTools({ trip, sources, signal: AbortSignal.timeout(30_000), draft: createTripDraft(trip) }),
      instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' },
      prompt: '第一天怎么安排？',
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.status, 'done');
    assert.match(result.text, /人民公园/);
    assert.deepEqual(result.toolCalls, ['get_trip']);
    const start = events.find((event) => event.type === 'tool_start');
    const end = events.find((event) => event.type === 'tool_end');
    assert.ok(start?.type === 'tool_start' && start.name === 'get_trip');
    assert.equal(typeof start.startedAt, 'number');
    assert.equal(end?.type === 'tool_end' && end.status, 'done');
    assert.ok(end?.type === 'tool_end' && end.durationMs >= 0);
    assert.ok(events.some((event) => event.type === 'done'));
  });

  it('达到轮次上限时自动 continue，不把 run 当成回答中断', async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('续跑后的最终回答'),
    ]);
    const { sources } = fakeSources();
    const result = await runAgentTurn({
      storagePath: await storage(),
      models,
      tools: createTripTools({ trip, sources, signal: AbortSignal.timeout(30_000), draft: createTripDraft(trip) }),
      instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' },
      prompt: '多步任务',
      maxTurns: 1,
    });

    assert.equal(result.status, 'done');
    assert.match(result.text, /续跑后的最终回答/);
  });

  it('ask_user 暂停后拿到用户答案，模型在同一回合继续', async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('ask_user', {
        questions: [{ id: 'day', question: '想安排在哪一天？', options: [{ label: '第 1 天' }, { label: '第 2 天' }] }],
      })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('已按第 2 天安排。'),
    ]);
    const { sources } = fakeSources();
    const state = createAgentTurnState();
    const asked: unknown[] = [];
    const result = await runAgentTurn({
      storagePath: await storage(),
      models,
      tools: createTripTools({
        trip, sources, signal: AbortSignal.timeout(30_000), draft: createTripDraft(trip), state,
        askUser: async (questions) => {
          asked.push(questions);
          return [{ id: questions[0]!.id, selected: ['第 2 天'] }];
        },
      }),
      instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' },
      prompt: '再帮我排一天',
    });

    assert.equal(result.status, 'done');
    assert.deepEqual(result.toolCalls, ['ask_user']);
    assert.equal(asked.length, 1, '工具应等待 HITL 答案');
    assert.match(result.text, /第 2 天/, '回答后模型必须继续本轮');
    assert.deepEqual(state.questions[0]?.selected, ['第 2 天']);
  });

  it('搜索类工具把结果交给模型，且不伪造未调用的工具', async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_places', { keyword: '川菜', category: 'food' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('附近有陈麻婆豆腐，青羊区。'),
    ]);
    const { sources, calls } = fakeSources();
    const result = await runAgentTurn({
      storagePath: await storage(),
      models,
      tools: createTripTools({ trip, sources, signal: AbortSignal.timeout(30_000), draft: createTripDraft(trip) }),
      instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' },
      prompt: '附近有什么川菜？',
    });

    assert.deepEqual(result.toolCalls, ['search_places']);
    assert.deepEqual(calls.poi, ['food:川菜']);
    assert.match(result.text, /陈麻婆/);
  });

  it('同一会话的第二轮复用 transcript，不重新建会话', async () => {
    const { faux, models } = fauxModels();
    const path = await storage();
    const tools = () => createTripTools({ trip, sources: fakeSources().sources, signal: AbortSignal.timeout(30_000), draft: createTripDraft(trip) });

    faux.setResponses([fauxAssistantMessage('第一次回答')]);
    const first = await runAgentTurn({ storagePath: path, models, tools: tools(), instructions: '测试', model: { provider: 'faux', modelId: 'faux-1' }, prompt: '第一问' });

    faux.setResponses([fauxAssistantMessage('第二次回答')]);
    const second = await runAgentTurn({
      storagePath: path, models, tools: tools(), instructions: '测试', model: { provider: 'faux', modelId: 'faux-1' }, prompt: '第二问',
      conversationId: first.conversationId,
    });

    assert.equal(second.conversationId, first.conversationId);
    assert.equal(second.text, '第二次回答');
  });

  it('同一用户并发提问立刻 409，且不替换正在运行的工具闭包', async () => {
    const { faux, models } = fauxModels();
    const path = await storage();
    const { gate, release, started, markStarted } = gateOf();
    const signal = AbortSignal.timeout(30_000);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('A 回答'),
    ]);

    const first = runAgentTurn({
      storagePath: path, models, tools: [gatedTool(markStarted, gate, signal)],
      instructions: '测试', model: { provider: 'faux', modelId: 'faux-1' }, prompt: 'A 问',
    });
    await started;

    // 另一个会话（同一用户）此刻发消息：必须立刻被拒绝，而不是覆盖 registry 里的 trip-tools。
    await assert.rejects(
      runAgentTurn({
        storagePath: path, models, tools: [], instructions: '测试',
        model: { provider: 'faux', modelId: 'faux-1' }, prompt: 'B 问',
      }),
      (error: unknown) => error instanceof AgentBusyError && error.statusCode === 409,
    );

    release();
    const result = await first;
    assert.equal(result.status, 'done');
    assert.equal(result.text, 'A 回答');
    assert.deepEqual(result.toolCalls, ['get_trip']);

    // 结束后锁必须释放，后续消息正常回答。
    faux.setResponses([fauxAssistantMessage('结束后的回答')]);
    const next = await runAgentTurn({
      storagePath: path, models, tools: [], instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' }, prompt: '下一问',
    });
    assert.equal(next.text, '结束后的回答');
  });

  it('回合异常后释放存储锁，不会把用户永久锁死', async () => {
    const { faux, models } = fauxModels();
    const path = await storage();
    await assert.rejects(runAgentTurn({
      storagePath: path, models, tools: [], instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' }, prompt: '坏会话',
      conversationId: 999_999 as never,
    }));

    faux.setResponses([fauxAssistantMessage('恢复')]);
    const ok = await runAgentTurn({
      storagePath: path, models, tools: [], instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' }, prompt: '正常问题',
    });
    assert.equal(ok.text, '恢复');
  });

  it('不同用户（不同存储）可以同时运行，锁不是全局的', async () => {
    const modelsA = fauxModels();
    const modelsB = fauxModels();
    const a = gateOf();
    const b = gateOf();
    const pathA = await storage();
    const pathB = await storage();
    const signal = AbortSignal.timeout(30_000);
    modelsA.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('A 完成'),
    ]);
    modelsB.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('B 完成'),
    ]);

    const turnA = runAgentTurn({
      storagePath: pathA, models: modelsA.models, tools: [gatedTool(a.markStarted, a.gate, signal)],
      instructions: '测试', model: { provider: 'faux', modelId: 'faux-1' }, prompt: 'A 问',
    });
    await a.started;
    const turnB = runAgentTurn({
      storagePath: pathB, models: modelsB.models, tools: [gatedTool(b.markStarted, b.gate, signal)],
      instructions: '测试', model: { provider: 'faux', modelId: 'faux-1' }, prompt: 'B 问',
    });
    // 两个用户都能进入工具执行，说明锁按存储隔离而不是一把全局锁。
    await b.started;

    a.release();
    b.release();
    const [doneA, doneB] = await Promise.all([turnA, turnB]);
    assert.equal(doneA.status, 'done');
    assert.equal(doneB.status, 'done');
  });

  it('用户停止后中断运行并立刻释放锁', async () => {
    const { faux, models } = fauxModels();
    const path = await storage();
    const controller = new AbortController();
    const { gate, started, markStarted } = gateOf();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('不该出现'),
    ]);

    const turn = runAgentTurn({
      storagePath: path, models, tools: [gatedTool(markStarted, gate, controller.signal)],
      instructions: '测试', model: { provider: 'faux', modelId: 'faux-1' }, prompt: '长问题',
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(turn, (error: unknown) => (error as Error)?.name === 'AbortError');

    faux.setResponses([fauxAssistantMessage('停止后的新回答')]);
    const next = await runAgentTurn({
      storagePath: path, models, tools: [], instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' }, prompt: '新问题',
    });
    assert.equal(next.text, '停止后的新回答');
  });

  it('同一份存储里对话与生成阶段的同名工具按会话隔离', async () => {
    const path = await storage();
    const runtime = await getAgentRuntime(path);
    const tool = (text: string) => defineTool({
      name: 'search_area_places',
      description: `同名工具：${text}`,
      parameters: obj({}),
      execute: async () => ({ output: [{ type: 'text' as const, text }] }),
    });
    const chatTool = tool('对话');
    const genTool = tool('生成');
    const chatExt = defineExtension({ name: 'trip-tools-chat', tools: [chatTool] });
    const genExt = defineExtension({ name: 'gen-plan', tools: [genTool] });
    runtime.registry.install(chatExt);
    runtime.registry.install(genExt);

    // 与真实接线一致：先建会话，再按会话写扩展选择（不依赖注册表默认的「全部已安装」）。
    const chat = await runtime.harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    const gen = await runtime.harness.createConversation({ ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    await chat.configure({ extensions: [chatExt] }, BACKGROUND_CONTEXT);
    await gen.configure({ extensions: [genExt] }, BACKGROUND_CONTEXT);

    const [chatAgent, genAgent] = await Promise.all([
      chat.agent(BACKGROUND_CONTEXT),
      gen.agent(BACKGROUND_CONTEXT),
    ]);
    assert.equal(chatAgent.tools.length, 1);
    assert.equal(chatAgent.tools[0], chatTool, '对话会话不能解析到生成阶段的同名工具');
    assert.equal(genAgent.tools[0], genTool, '生成会话不能解析到对话的同名工具');
    await closeAgentRuntime(path);
  });

  it('工具可以创建并等待一个对话拥有的 durable 子任务', async () => {
    const { faux, models } = fauxModels();
    const path = await storage();
    const runtime = await getAgentRuntime(path);
    let ran = false;
    const ChildTask = defineTask<Record<string, never>, { phase: 'run' }, { tripId: string }>({
      name: 'test.child',
      version: 1,
      initial: () => ({ phase: 'run' }),
      phases: {
        run: async (_task, taskRuntime, context) => {
          ran = true;
          await taskRuntime.commit(
            () => ({ status: 'terminal', outcome: { status: 'completed', result: { tripId: 'child-trip' } } }),
            context,
          );
        },
      },
      abort: async (_task, taskRuntime, context) => {
        await taskRuntime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context);
      },
    });
    runtime.registry.install(defineExtension({ name: 'test-child-task', tasks: [ChildTask] }));

    const runChild = defineTool({
      name: 'run_child',
      description: '创建并等待子任务',
      parameters: obj({}),
      execute: async (_args, api, context) => {
        const id = await api.createTask(ChildTask, {}, { ownership: { kind: 'conversation' }, background: true }, context);
        const settled = await api.waitForTask(id, context);
        const outcome = settled.state.outcome;
        return { output: [{ type: 'text' as const, text: JSON.stringify(outcome.status === 'completed' ? outcome.result : { status: outcome.status }) }] };
      },
    });

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('run_child', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('子任务已完成'),
    ]);
    const result = await runAgentTurn({
      storagePath: path, models, tools: [runChild], instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' }, prompt: '跑一个子任务',
    });
    assert.equal(result.status, 'done');
    assert.equal(ran, true, '子任务必须真正执行');
    assert.deepEqual(result.toolCalls, ['run_child']);
    await closeAgentRuntime(path);
  });

  it('工具调用结束后不重复回放工具前已经流过的正文', async () => {
    const path = await storage();
    const { faux, models } = fauxModels();
    const finish = defineTool({
      name: 'finish', description: '结束本轮', parameters: obj({}),
      execute: async () => ({ output: [{ type: 'text' as const, text: 'ok' }], control: { terminate: true } }),
    });
    faux.setResponses([fauxAssistantMessage([fauxText('先确认一下。'), fauxToolCall('finish', {})], { stopReason: 'toolUse' })]);
    const events: AgentStreamEvent[] = [];
    await runAgentTurn({
      storagePath: path, models, tools: [finish], instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' }, prompt: '问题', maxTurns: 2,
      onEvent: (event) => events.push(event),
    });
    assert.deepEqual(
      events.filter((event) => event.type === 'text').map((event) => event.text).filter((text) => text.trim()),
      ['先确认一下。'],
      '工具前已经流过的正文不能在回合结束时再发一遍',
    );
    await closeAgentRuntime(path);
  });

  it('真实 thinking 块按 start/delta/end 透传，且不混入正文', async () => {
    const path = await storage();
    const { faux, models } = fauxModels();
    faux.setResponses([fauxAssistantMessage([fauxThinking('先判断用户要什么。'), fauxText('最终答案')])]);
    const events: AgentStreamEvent[] = [];
    const result = await runAgentTurn({
      storagePath: path, models, tools: [], instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' }, prompt: '问题', maxTurns: 2,
      onEvent: (event) => events.push(event),
    });
    assert.equal(result.text, '最终答案');
    assert.ok(events.some((event) => event.type === 'thinking_start'), '应当有真实的 thinking_start');
    assert.ok(events.some((event) => event.type === 'thinking_end'), '正文开始/回合结束时应收口');
    assert.equal(
      events.filter((event) => event.type === 'thinking_delta').map((event) => event.text).join(''),
      '先判断用户要什么。',
    );
    assert.equal(events.filter((event) => event.type === 'text').at(-1)?.text, '最终答案');
    await closeAgentRuntime(path);
  });

  it('跨工具轮次时思考流不被 slice 截断且工具前正文完整保留', async () => {
    const path = await storage();
    const { faux, models } = fauxModels();
    const getDay = defineTool({
      name: 'get_day', description: '获取某天行程', parameters: obj({}),
      execute: async () => ({ output: [{ type: 'text' as const, text: '第一天已获取' }] }),
    });
    const turn1Thinking = '这次改用新闻频道检索。';
    const turn1Text = '我先看一下你现在的第 1 天怎么排的，再对照主流路线。';
    const turn2Thinking = '用户问"查一下杭州一日游路线"。现在给出对照：……';
    const turn2Text = '现状路线 vs 主流推荐路线。';

    faux.setResponses([
      fauxAssistantMessage([fauxThinking(turn1Thinking), fauxText(turn1Text), fauxToolCall('get_day', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxThinking(turn2Thinking), fauxText(turn2Text)], { stopReason: 'stop' }),
    ]);

    const events: AgentStreamEvent[] = [];
    const result = await runAgentTurn({
      storagePath: path, models, tools: [getDay], instructions: '测试系统提示',
      model: { provider: 'faux', modelId: 'faux-1' }, prompt: '查一下杭州一日游路线', maxTurns: 3,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.status, 'done');
    assert.deepEqual(result.toolCalls, ['get_day']);

    // 检查 assistantEntries 地面真值
    assert.equal(result.assistantEntries?.length, 2, '必须有两个 assistant entry');
    assert.equal(result.assistantEntries?.[0]?.text, turn1Text);
    assert.equal(result.assistantEntries?.[0]?.thinking, turn1Thinking);
    assert.equal(result.assistantEntries?.[1]?.text, turn2Text);
    assert.equal(result.assistantEntries?.[1]?.thinking, turn2Thinking);

    // 检查思考事件：不能被前一轮的 12 字符切除，第二轮必须以完整中文开头
    const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta').map((e) => e.text);
    const fullThinking = thinkingDeltas.join('');
    assert.ok(fullThinking.includes('用户问"查一下杭州一日游路线"'), '第二轮思考前缀绝不能被 slice 切掉');

    // 检查正文事件：工具前必须完整流出 turn1Text
    const textEvents = events.filter((e) => e.type === 'text').map((e) => e.text);
    assert.ok(textEvents.includes(turn1Text), '工具调用前正文必须完整发出全句');

    await closeAgentRuntime(path);
  });

  it('Harness 关闭后从缓存摘除，下一次请求重新打开', async () => {
    const path = await storage();
    const first = await getAgentRuntime(path);
    // 直接关底层 Harness（模拟存储错误导致的自行关闭），不走 closeAgentRuntime 的显式删缓存。
    await first.harness.close(BACKGROUND_CONTEXT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await getAgentRuntime(path);
    assert.notEqual(second.harness, first.harness, '关闭后的 Harness 不该继续留在缓存里');
    await closeAgentRuntime(path);
  });
});