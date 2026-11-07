// 主 Agent 的「全功能」工具：美食卡片、结构化追问、Brief 更新、重新生成请求。
// 纯内存，不连模型/数据库；验证工具写入回合状态，由 turn 统一组装附件与提交。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentQuestion, AgentQuestionAnswer, Trip } from '@tripweaver/shared';
import { createTripTools, type TripToolDeps } from '../chat/agent/tools';
import { createTripDraft } from '../chat/agent/tripDraft';
import { createAgentTurnState } from '../chat/agent/turnState';
import type { DetailSources } from '../chat/detailSources';

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
  generateTrip?: NonNullable<TripToolDeps['generateTrip']>,
) {
  const state = createAgentTurnState();
  const tools = createTripTools({
    trip, sources: sources(), signal: AbortSignal.timeout(5_000),
    draft: createTripDraft(trip), state, scopeDayId: 'day-1',
    ...(askUser ? { askUser } : {}),
    ...(generateTrip ? { generateTrip } : {}),
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

  it('generate_trip 把生成结果写回回合状态，未启用时明确失败', async () => {
    const { state, tool } = build(undefined, async () => ({ tripId: 'trip-new' }));
    const result = await run(tool('generate_trip'), {});
    assert.equal(result.isError, undefined);
    assert.equal(state.generatedTripId, 'trip-new');

    const disabled = build();
    const failed = await run(disabled.tool('generate_trip'), {});
    assert.equal(failed.isError, true);
    assert.equal(disabled.state.generatedTripId, undefined);
  });
});
