// 主 Agent 的「全功能」工具：美食卡片、结构化追问、Brief 更新、重新生成请求。
// 纯内存，不连模型/数据库；验证工具写入回合状态，由 turn 统一组装附件与提交。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentQuestion, AgentQuestionAnswer, Trip } from '@rollinggo-trip/shared';
import { createTripTools, type TripToolDeps } from '@rollinggo-trip/agent/chat/agent/tools';
import { createTripDraft } from '@rollinggo-trip/agent/chat/agent/tripDraft';
import { createAgentTurnState } from '@rollinggo-trip/agent/chat/agent/turnState';
import type { DetailSources } from '@rollinggo-trip/integrations/detailSources';

const trip: Trip = {
  id: 'trip-harness', title: '成都两日', destination: '成都', startDate: '2026-11-10',
  budgetLevel: '舒适', totalBudget: 0, preferences: [], partySize: 2, extraNotes: '',
  transportMode: 'transit',
  days: [{
    id: 'day-1', dayIndex: 1, title: '市区',
    activities: [
      { id: 'act-1', name: '人民公园', startTime: '09:00', endTime: '11:00', description: '', lat: 30.66, lng: 104.06, coordSource: 'geocoded', category: '文化', sourceNotes: [] },
      { id: 'act-2', name: '宽窄巷子', startTime: '14:00', endTime: '16:00', description: '', lat: 30.67, lng: 104.05, coordSource: 'geocoded', category: '文化', sourceNotes: [] },
    ],
  }],
  meta: { usedXhs: false, reviewNotes: [] }, createdAt: 1, updatedAt: 1,
};

function sources(): DetailSources {
  const calls = { poi: 0, search: 0 };
  return {
    poi: {
      kind: 'null',
      searchPois: async () => [{
        name: '陈麻婆豆腐', type: '川菜', address: '青羊区', rating: '4.6', cost: '60',
        opentime: '', photoUrls: [], adcode: '510105', location: { lat: 30.669, lng: 104.06 },
      }],
      selfCheck: async () => ({ configured: true, checked: true, ok: true, message: '' }),
    },
    search: {
      search: async () => [],
      selfCheck: async () => ({ configured: true, checked: true, ok: true, message: '' }),
    },
    notes: new Set<string>(),
    calls,
    web: [],
    assertHealthy: () => {},
  } as unknown as DetailSources;
}

function build(
  askUser?: (questions: AgentQuestion[]) => Promise<AgentQuestionAnswer[] | null>,
  delegateTask?: NonNullable<TripToolDeps['delegateTask']>,
) {
  const state = createAgentTurnState();
  const tools = createTripTools({
    trip, sources: sources(), signal: AbortSignal.timeout(5_000),
    draft: createTripDraft(trip), state, scopeDayId: 'day-1',
    ...(askUser ? { askUser } : {}),
    ...(delegateTask ? { delegateTask } : {}),
  });
  return { state, tool: (name: string) => tools.find((item) => item.name === name)! };
}

type ToolResult = { output?: { type: string; text: string }[]; control?: { terminate?: boolean }; isError?: boolean };
const run = (tool: { execute: (...args: never[]) => Promise<unknown> }, args: unknown) =>
  (tool.execute as unknown as (input: unknown) => Promise<ToolResult>)(args);

describe('主 Agent 全功能工具', () => {
  it('search_food 产出可添加餐厅并写入回合附件状态', async () => {
    const { state, tool } = build();
    const result = await run(tool('search_food'), { query: '川菜', meal: 'lunch' });
    assert.equal(result.isError, undefined);
    assert.equal(state.foodCandidates.length, 1);
    assert.equal(state.foodCandidates[0]!.name, '陈麻婆豆腐');
    assert.equal(state.foodCandidates[0]!.dayId, 'day-1');
    assert.match(result.output![0]!.text, /陈麻婆豆腐/);
  });

  it('search_food 支持指定异地城市平滑检索餐饮 POI', async () => {
    const { tool } = build();
    // 当前行程是成都，但指定查询杭州美食
    const result = await run(tool('search_food'), { query: '西湖醋鱼', city: '杭州' });
    assert.equal(result.isError, undefined);
    assert.match(result.output![0]!.text, /陈麻婆豆腐/);
  });

  it('ask_user 暂停后拿到答案并写回回合记录（同一回合继续）', async () => {
    let asked: AgentQuestion[] = [];
    const { state, tool } = build(async (questions) => {
      asked = questions;
      return [{ id: questions[0]!.id, selected: ['第 2 天'] }];
    });
    const result = await run(tool('ask_user'), {
      questions: [{
        id: 'day', question: '想安排在哪一天？', header: '范围',
        options: [{ label: '第 1 天' }, { label: '第 2 天', description: '更宽松' }],
      }],
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.control?.terminate, undefined, '回答后不应结束回合');
    assert.deepEqual(asked[0]?.options.map((option) => option.label), ['第 1 天', '第 2 天']);
    assert.deepEqual(state.questions, [{ question: '想安排在哪一天？', options: ['第 1 天', '第 2 天'], selected: ['第 2 天'] }]);
    assert.match(result.output![0]!.text, /第 2 天/);
  });

  it('ask_user 超时返回 pending 并结束本轮', async () => {
    const { state, tool } = build(async () => null);
    const result = await run(tool('ask_user'), { questions: [{ question: '选哪天？', options: [{ label: '第 1 天' }] }] });
    assert.equal(result.isError, true);
    assert.equal(result.control?.terminate, true);
    assert.equal(state.questionExpired, true);
  });

  it('没有 HITL 通道时 ask_user 返回错误', async () => {
    const { tool } = build();
    const result = await run(tool('ask_user'), { questions: [{ question: '选哪天？' }] });
    assert.equal(result.isError, true);
  });

  it('update_brief 记录 Brief 增量', async () => {
    const { state, tool } = build();
    await run(tool('update_brief'), { partySize: 3, extraNotes: '带老人' });
    assert.deepEqual(state.briefPatch, { partySize: 3, extraNotes: '带老人' });
  });

  it('update_brief 多次调用按 merge 合并：标量覆盖、约束拼接去重、未定义字段不动', async () => {
    const { state, tool } = build();
    await run(tool('update_brief'), { partySize: 3, extraNotes: '带老人', addConstraints: [{ category: 'avoid', polarity: 'must', valueText: '爬山' }] });
    await run(tool('update_brief'), {
      partySize: 2,
      addConstraints: [
        { category: 'avoid', polarity: 'must', valueText: '爬山' },
        { category: 'need', polarity: 'should', valueText: ' 有午休 ' },
      ],
      removeConstraintIds: ['c1', 'c1'],
    });
    assert.equal(state.briefPatch!.partySize, 2, '后一次的标量覆盖前一次');
    assert.equal(state.briefPatch!.extraNotes, '带老人', '未提到的字段保持原值');
    assert.deepEqual(state.briefPatch!.addConstraints, [
      { category: 'avoid', polarity: 'must', valueText: '爬山' },
      { category: 'need', polarity: 'should', valueText: ' 有午休 ' },
    ], '重复约束去重（保留首次出现），文本修剪交给 brief 层');
    assert.deepEqual(state.briefPatch!.removeConstraintIds, ['c1'], '删除 id 去重');
  });

  it('delegate_task 只委派任务并写回任务引用，未启用时明确失败', async () => {
    const { state, tool } = build(undefined, async () => ({ taskId: 'job-new' }));
    const result = await run(tool('delegate_task'), { kind: 'trip_generation' });
    assert.equal(result.isError, undefined);
    assert.deepEqual(state.delegatedTask, { id: 'job-new', kind: 'trip_generation' });

    const disabled = build();
    const failed = await run(disabled.tool('delegate_task'), {});
    assert.equal(failed.isError, true);
    assert.equal(disabled.state.delegatedTask, undefined);
  });

  it('delegate_task 拒绝未知任务类型', async () => {
    const { tool } = build(undefined, async () => ({ taskId: 'task-new' }));
    const result = await run(tool('delegate_task'), { kind: 'unknown_kind' });
    assert.equal(result.isError, true);
    assert.match(result.output![0]!.text, /不支持的任务类型/);
  });

  it('ask_user 同一次调用的多个问题合并成一组记录', async () => {
    const recorded: Array<[number, number]> = [];
    const state = createAgentTurnState();
    const tools = createTripTools({
      trip, sources: sources(), signal: AbortSignal.timeout(5_000),
      draft: createTripDraft(trip), state,
      askUser: async (questions) => questions.map((question) => ({ id: question.id, selected: question.options[0] ? [question.options[0].label] : [] })),
      onQuestionRecorded: (index, count) => recorded.push([index, count]),
    });
    const result = await run(tools.find((item) => item.name === 'ask_user')!, {
      questions: [
        { question: '几点出发？', options: [{ label: '15:00' }] },
        { question: '预算多少？', options: [{ label: '500 元' }] },
      ],
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(recorded, [[0, 2]], '两个问题只算一组，前端才能合并成一个气泡');
    assert.equal(state.questions.length, 2);
    assert.deepEqual(state.questions.map((question) => question.selected), [['15:00'], ['500 元']]);
  });

  it('无行程态（行前）：读工具与写工具安全回退，委派与搜索正常可用', async () => {
    const state = createAgentTurnState();
    let delegated = false;
    const tools = createTripTools({
      trip: null,
      draft: null,
      destination: '成都',
      sources: sources(),
      signal: AbortSignal.timeout(5_000),
      state,
      delegateTask: async () => {
        delegated = true;
        return { taskId: 'job-init' };
      },
    });

    const tool = (name: string) => tools.find((item) => item.name === name)!;

    // get_trip
    const tripRes = await run(tool('get_trip'), {});
    assert.match(tripRes.output![0]!.text, /尚未生成行程/);

    // get_day
    const dayRes = await run(tool('get_day'), { dayIndex: '1' });
    assert.match(dayRes.output![0]!.text, /尚未生成行程/);

    // search_places: 使用 destination 兜底成功
    const placesRes = await run(tool('search_places'), { keyword: '川菜' });
    assert.match(placesRes.output![0]!.text, /陈麻婆豆腐/);

    // add_activity: 写工具安全返回 ok=false
    const writeRes = await run(tool('add_activity'), { name: '锦里', dayIndex: '1' });
    assert.match(writeRes.output![0]!.text, /尚未生成行程/);

    // delegate_task: 成功委派
    const delRes = await run(tool('delegate_task'), { kind: 'trip_generation' });
    assert.equal(delRes.isError, undefined);
    assert.equal(delegated, true);
    assert.equal(state.delegatedTask?.id, 'job-init');
  });

  it('get_weather 支持自由指定城市（跨城市/异地查询）且不绑死当前行程', async () => {
    let queriedWith: { trip?: Trip | null; city?: string } | null = null;
    const tools = createTripTools({
      trip, sources: sources(), signal: AbortSignal.timeout(5_000),
      getWeather: async (opts) => {
        queriedWith = opts;
        return { status: 'available', destination: opts.city ?? opts.trip?.destination, forecast: { city: opts.city ?? opts.trip?.destination } };
      },
    });
    const weatherTool = tools.find((item) => item.name === 'get_weather')!;

    // 1. 异地指定城市查询（如当前行程是成都，但查杭州）
    const hzRes = await run(weatherTool, { city: '杭州' });
    assert.deepEqual(queriedWith, { city: '杭州' });
    assert.match(hzRes.output![0]!.text, /杭州/);

    // 2. 缺省 city 时使用当前行程
    const defaultRes = await run(weatherTool, {});
    assert.deepEqual(queriedWith, { trip, city: '成都' });
    assert.match(defaultRes.output![0]!.text, /成都/);
  });

  it('get_weather 在无行程状态下能够按 city 或 destination 兜底正常查询', async () => {
    let queriedWith: { trip?: Trip | null; city?: string } | null = null;
    const tools = createTripTools({
      trip: null, destination: '北京', sources: sources(), signal: AbortSignal.timeout(5_000),
      getWeather: async (opts) => {
        queriedWith = opts;
        return { status: 'available', destination: opts.city };
      },
    });
    const weatherTool = tools.find((item) => item.name === 'get_weather')!;

    // 1. 无行程但指定城市查西安
    await run(weatherTool, { city: '西安' });
    assert.deepEqual(queriedWith, { city: '西安' });

    // 2. 无行程且未传 city 时自动使用 destination 兜底（北京）
    await run(weatherTool, {});
    assert.deepEqual(queriedWith, { city: '北京' });
  });
});
