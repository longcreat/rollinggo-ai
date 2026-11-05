// 写工具的装配与回执契约：工具清单、地点解析失败降级、读工具能看到本轮改动。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Trip } from '@tripweaver/shared';
import { createTripTools } from '../chat/agent/tools';
import { createTripDraft } from '../chat/agent/tripDraft';
import { createTripWriteTools } from '../chat/agent/writeTools';
import type { DetailSources } from '../chat/detailSources';

function trip(): Trip {
  return {
    id: 't1', title: '成都两日', destination: '成都', startDate: '2026-11-10',
    budgetLevel: '舒适', totalBudget: 3000, preferences: [], partySize: 2, extraNotes: '',
    transportMode: 'transit',
    days: [{
      id: 'd1', dayIndex: 1, title: '市区',
      activities: [{ id: 'a1', name: '人民公园', startTime: '', endTime: '', description: '', lat: 30.66, lng: 104.06, coordSource: 'geocoded', coordSystem: 'gcj02', category: '自然', sourceNotes: [] }],
      legs: [],
    }],
    meta: { usedXhs: false, reviewNotes: [] }, createdAt: 1, updatedAt: 1,
  };
}

// 手写空数据源：这一层不测检索，避免为了一个 stub 去加载 env 与网络栈。
function sources(): DetailSources {
  const idle = { configured: false, checked: false, ok: false, message: '未配置' };
  return {
    poi: { kind: 'null', searchPois: async () => [], selfCheck: async () => idle },
    search: { kind: 'null', search: async () => [], selfCheck: async () => idle },
    notes: new Set<string>(),
    calls: { poi: 0, search: 0 },
    web: [],
    assertHealthy: () => {},
  } as unknown as DetailSources;
}

type ToolResultShape = { output: { type: string; text: string }[] };
/** 运行时只用到第一个参数；真实工具签名还有 api/context，测试里忽略。 */
const execute = (tool: { execute: (...args: never[]) => Promise<unknown> }, args: unknown) =>
  (tool.execute as unknown as (input: unknown) => Promise<ToolResultShape>)(args);
const run = async (tool: { execute: (...args: never[]) => Promise<unknown> }, args: unknown) => {
  const result = await execute(tool, args);
  return JSON.parse(result.output[0]!.text) as {
    ok: boolean; summary: string;
    day?: { activities: { name: string; located: boolean }[] };
  };
};

describe('工具装配', () => {
  it('没有草稿时只有 5 个只读工具（P1 行为不变）', () => {
    const tools = createTripTools({ trip: trip(), sources: sources(), signal: new AbortController().signal });
    assert.deepEqual(tools.map((tool) => tool.name), ['get_trip', 'get_day', 'search_places', 'web_search', 'get_weather']);
  });

  it('有草稿时追加 9 个写工具，且读工具仍在', () => {
    const draft = createTripDraft(trip());
    const tools = createTripTools({ trip: trip(), sources: sources(), signal: new AbortController().signal, draft });
    assert.deepEqual(tools.map((tool) => tool.name), [
      'get_trip', 'get_day', 'search_places', 'web_search', 'get_weather',
      'add_activity', 'update_activity', 'delete_activity', 'move_activity', 'reorder_day',
      'add_day', 'update_day', 'delete_day', 'update_trip',
    ]);
  });
});

describe('写工具回执', () => {
  const build = (
    draft = createTripDraft(trip()),
    resolvePlace?: (name: string) => Promise<{ lat: number; lng: number } | null>,
    cachedPoint?: (name: string) => { lat: number; lng: number } | null,
  ) => createTripWriteTools({
    draft, signal: new AbortController().signal,
    ...(resolvePlace ? { resolvePlace } : {}),
    ...(cachedPoint ? { cachedPoint } : {}),
  });

  it('add_activity 解析坐标后回传当天快照', async () => {
    const draft = createTripDraft(trip());
    const tool = build(draft, async () => ({ lat: 30.661, lng: 104.061 })).find((item) => item.name === 'add_activity')!;
    const payload = await run(tool, { dayIndex: 1, name: '鹤鸣茶社', category: '美食', description: '喝盖碗茶' });
    assert.equal(payload.ok, true);
    assert.match(payload.summary, /新增「鹤鸣茶社」/);
    assert.equal(payload.day!.activities.length, 2);
    assert.equal(payload.day!.activities[1]!.located, true);
  });

  it('地点解析失败仍然写入，只是标记未定位', async () => {
    const draft = createTripDraft(trip());
    const tool = build(draft, async () => null).find((item) => item.name === 'add_activity')!;
    const payload = await run(tool, { dayIndex: 1, name: '不知名小馆' });
    assert.equal(payload.ok, true);
    assert.equal(payload.day!.activities[1]!.located, false);
  });

  it('删除不存在的活动返回 ok=false 与可复述原因', async () => {
    const tool = build().find((item) => item.name === 'delete_activity')!;
    const payload = await run(tool, { dayIndex: 1, activityId: 'nope' });
    assert.equal(payload.ok, false);
    assert.match(payload.summary, /没找到/);
  });

  it('改名优先复用本回合 search_places 的精确坐标', async () => {
    const draft = createTripDraft(trip());
    const tool = build(draft, async () => ({ lat: 1, lng: 1 }), () => ({ lat: 30.6572, lng: 104.063 }))
      .find((item) => item.name === 'update_activity')!;
    const payload = await run(tool, { dayIndex: 1, activityId: 'a1', name: '成都博物馆' });
    assert.equal(payload.ok, true);
    const target = draft.current().days[0]!.activities[0]!;
    assert.deepEqual([target.lat, target.lng], [30.6572, 104.063]);
    assert.equal(target.coordSource, 'geocoded');
  });

  it('改名时模糊解析到 50km 外不采信：落「位置待核实」并给提示，不写入错误坐标', async () => {
    const draft = createTripDraft(trip());
    // 需要一个同城参照点，否则无法判断解析结果是否离谱
    draft.addActivity({ dayIndex: 1, name: '宽窄巷子', lat: 30.6691, lng: 104.0553 });
    const tool = build(draft, async () => ({ lat: 30.3971, lng: 104.5477 }))  // 约 56km 外的同名点
      .find((item) => item.name === 'update_activity')!;
    const payload = await run(tool, { dayIndex: 1, activityId: 'a1', name: '人民公园东门' }) as {
      ok: boolean; warning?: string; day?: { activities: { located: boolean }[] };
    };
    assert.equal(payload.ok, true);
    assert.match(payload.warning ?? '', /位置待核实/);
    const target = draft.current().days[0]!.activities[0]!;
    assert.deepEqual([target.lat, target.lng], [0, 0], '绝不能写入 56km 外的错误坐标');
    assert.equal(target.coordSource, 'estimated');
    assert.equal(payload.day!.activities[0]!.located, false);
  });

  it('改名时模糊解析在合理范围内则采信', async () => {
    const draft = createTripDraft(trip());
    const tool = build(draft, async () => ({ lat: 30.6619, lng: 104.0641 })).find((item) => item.name === 'update_activity')!;
    const payload = await run(tool, { dayIndex: 1, activityId: 'a1', name: '人民公园东门' });
    assert.equal(payload.ok, true);
    assert.equal(draft.current().days[0]!.activities[0]!.coordSource, 'geocoded');
  });

  it('update_trip 只改传入字段', async () => {
    const draft = createTripDraft(trip());
    const tool = build(draft).find((item) => item.name === 'update_trip')!;
    const payload = await run(tool, { partySize: 4, startDate: '2026-12-01' });
    assert.equal(payload.ok, true);
    assert.equal(draft.current().partySize, 4);
    assert.equal(draft.current().startDate, '2026-12-01');
    assert.equal(draft.current().title, '成都两日');
  });
});

describe('读工具读草稿', () => {
  it('本回合新增的活动立刻出现在 get_trip 里', async () => {
    const draft = createTripDraft(trip());
    draft.addActivity({ dayIndex: 1, name: '宽窄巷子', lat: 30.67, lng: 104.05 });
    const tools = createTripTools({ trip: trip(), sources: sources(), signal: new AbortController().signal, draft });
    const payload = await run(tools.find((tool) => tool.name === 'get_trip')!, {});
    assert.ok(JSON.stringify(payload).includes('宽窄巷子'), '读工具必须看到草稿里的新增，否则模型会重复添加');
  });
});
