// 规划工具：片区聚簇、逐日排点（含时刻写入）、验收与提交状态。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DraftTrip } from '@tripweaver/agent/generation/draft';
import { buildAreas, buildPlannerToolsWithStatus } from '@tripweaver/agent/generation/planner/tools';
import { plannerSeeds } from '@tripweaver/agent/generation/planner/plannerAgent';
import type { SourcedPoi } from '@tripweaver/integrations/geoContracts';

const form = {
  destination: '杭州', days: 2, startDate: '2026-11-09', pace: 'moderate', transportMode: 'transit',
  preferences: [], partySize: 2, budgetLevel: '舒适', totalBudget: 0, extraNotes: '',
} as never;

const seed = (name: string, lat: number, lng: number) => ({ name, lat, lng, category: 'attraction' as const });

test('buildAreas：按 2.5km 单链聚簇', () => {
  const areas = buildAreas([
    seed('断桥残雪', 30.258, 120.151),
    seed('白堤', 30.259, 120.149),
    seed('灵隐寺', 30.240, 120.102),
    seed('雷峰塔', 30.2316, 120.1497),
    seed('苏堤春晓', 30.238, 120.136),
  ]);
  assert.equal(areas.length, 3);
  assert.deepEqual(areas[0]!.members.map((item) => item.name), ['断桥残雪', '白堤']);
  assert.deepEqual(areas[1]!.members.map((item) => item.name), ['灵隐寺']);
  assert.deepEqual(areas[2]!.members.map((item) => item.name), ['雷峰塔', '苏堤春晓']);
});

function tool(list: ReturnType<typeof buildPlannerToolsWithStatus>, name: string) {
  const found = list.tools.find((item) => item.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

test('plan_day 写入带时刻的活动，submit 后状态为已提交', async () => {
  const draft = new DraftTrip(form);
  const areas = buildAreas([seed('断桥残雪', 30.258, 120.151), seed('白堤', 30.2595, 120.1495)]);
  const snapshots: { dayIndex: number; stops: { name: string; startTime: string; endTime: string }[] }[] = [];
  const status = buildPlannerToolsWithStatus({
    form, draft, areas, signal: AbortSignal.timeout(5000),
    searchArea: async () => [],
    webSearch: async () => [],
    onDayPlanned: (day) => snapshots.push(day),
  });

  const listed = await tool(status, 'list_areas').execute('t1', {});
  assert.match(JSON.stringify(listed), /断桥残雪/);

  const planned = await tool(status, 'plan_day').execute('t2', {
    dayIndex: 1, areaId: areas[0]!.id, places: ['断桥残雪', '白堤'], startAt: '09:00',
  });
  const payload = JSON.parse((planned as { content: { text: string }[] }).content[0]!.text) as {
    itinerary: { name: string; arrive: string; leave: string }[]; endAt: string;
  };
  assert.deepEqual(payload.itinerary.map((item) => item.name), ['断桥残雪', '白堤']);
  assert.equal(payload.itinerary[0]!.arrive, '09:00');
  assert.ok(payload.itinerary[1]!.arrive > '09:00');

  assert.equal(snapshots.length, 1, '每天排完回调一次');
  assert.equal(snapshots[0]!.dayIndex, 1);
  assert.deepEqual(snapshots[0]!.stops.map((stop) => stop.name), ['断桥残雪', '白堤']);
  assert.equal(snapshots[0]!.stops[0]!.startTime, '09:00');
  assert.ok(snapshots[0]!.stops[1]!.endTime);

  const day = draft.mutableDays()[0]!;
  assert.equal(day.activities.length, 2);
  assert.equal(day.activities[0]!.startTime, '09:00');
  assert.ok(day.activities[0]!.endTime);
  assert.equal(day.activities[1]!.coordSource, 'geocoded');

  const validated = await tool(status, 'validate_plan').execute('t3', {});
  assert.match((validated as { content: { text: string }[] }).content[0]!.text, /sparse/);

  const blocked = await tool(status, 'submit_plan').execute('t4', {});
  assert.equal((blocked as { isError?: boolean }).isError, true, '第 2 天为空不能提交');

  await tool(status, 'plan_day').execute('t5', { dayIndex: 2, areaId: areas[0]!.id, places: ['断桥残雪', '白堤'] });
  const submitted = await tool(status, 'submit_plan').execute('t6', { notes: '西湖步行' });
  assert.equal((submitted as { isError?: boolean }).isError, undefined);
  assert.equal(status.isSubmitted(), true);
});

test('plan_day 透传候选池类目：food 种子落「美食」，attraction 落「文化」', async () => {
  const draft = new DraftTrip(form);
  const areas = buildAreas([
    { name: '楼外楼', lat: 30.25, lng: 120.14, category: 'food' as const },
    seed('平湖秋月', 30.256, 120.145),
  ]);
  const status = buildPlannerToolsWithStatus({
    form, draft, areas, signal: AbortSignal.timeout(5000),
    searchArea: async () => [],
    webSearch: async () => [],
  });
  await tool(status, 'plan_day').execute('t1', { dayIndex: 1, areaId: areas[0]!.id, places: ['楼外楼', '平湖秋月'], startAt: '09:00' });
  const day = draft.mutableDays()[0]!;
  assert.equal(day.activities.find((activity) => activity.name === '楼外楼')!.category, '美食');
  assert.equal(day.activities.find((activity) => activity.name === '平湖秋月')!.category, '文化');
});

test('search_area_places：过滤设施点，结果进入候选后可用于 plan_day', async () => {
  const draft = new DraftTrip(form);
  const areas = buildAreas([seed('西湖', 30.2437, 120.1479)]);
  const pois: SourcedPoi[] = [
    { name: '花港码头售票亭', type: '风景名胜;风景名胜;公园', address: '', rating: '', cost: '', opentime: '', photoUrls: [], location: { lat: 30.23, lng: 120.139 }, adcode: '330100' },
    { name: '苏堤春晓', type: '风景名胜;风景名胜;公园', address: '苏堤', rating: '', cost: '', opentime: '周一至周日 08:00-18:00', photoUrls: [], location: { lat: 30.238, lng: 120.136 }, adcode: '330100' },
  ];
  const status = buildPlannerToolsWithStatus({
    form, draft, areas, signal: AbortSignal.timeout(5000),
    searchArea: async () => pois,
    webSearch: async () => [],
  });
  const found = await tool(status, 'search_area_places').execute('t1', { areaId: areas[0]!.id });
  const payload = JSON.parse((found as { content: { text: string }[] }).content[0]!.text) as { returned: number; places: { name: string }[] };
  assert.equal(payload.returned, 2);
  assert.deepEqual(payload.places.map((item) => item.name), ['苏堤春晓']);

  const planned = await tool(status, 'plan_day').execute('t2', { dayIndex: 1, areaId: areas[0]!.id, places: ['苏堤春晓', '花港码头售票亭'] });
  assert.equal((planned as { isError?: boolean }).isError, true, '设施点不能进入行程');
});

test('plannerSeeds：名称失配时可按候选 id 命中坐标', () => {
  const seeds = plannerSeeds({
    candidates: [{ id: 'p1', name: '深圳湾公园（南门）' }],
    pointOf: (_name, id) => (id === 'p1' ? { lat: 22.5, lng: 113.9 } : undefined),
  });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0]!.name, '深圳湾公园（南门）');
});
