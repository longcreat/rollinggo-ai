import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerateForm } from '@tripweaver/shared';
import { DraftTrip } from '../generation/draft';
import { orderUntimedDayRoutes } from '../generation/routeCoherence';
import { optimizeRouteOrder, routeBacktracks, routeDistanceMeters } from '../generation/scheduling/routeOrder';

// 来源：用户北京三日行程 Day 2 的真实坐标；不依赖在线数据库或地图。
const beijing = [
  { name: '什刹海', lat: 39.93735463694218, lng: 116.39630882455526 },
  { name: '北海公园', lat: 39.92779858763959, lng: 116.38870021355056 },
  { name: '雍和宫', lat: 39.947239, lng: 116.417296 },
  { name: '颐和园', lat: 39.991321733211166, lng: 116.27078135779443 },
];
const form: GenerateForm = { destination: '北京', days: 2, startDate: '', budgetLevel: '舒适',
  totalBudget: 0, preferences: [], partySize: 2, extraNotes: '', transportMode: 'transit' };
const names = (points: readonly { name: string }[]) => points.map((p) => p.name);

test('北京真实路线：2处明显回折降为0，几何路程缩短，地点和对象不丢失', () => {
  const before = structuredClone(beijing);
  const result = optimizeRouteOrder(beijing);
  assert.equal(routeBacktracks(beijing), 2);
  assert.equal(routeBacktracks(result), 0);
  assert.ok(routeDistanceMeters(result) < routeDistanceMeters(beijing) - 1000);
  assert.deepEqual(new Set(result), new Set(beijing));
  assert.deepEqual(beijing, before);
  assert.deepEqual(optimizeRouteOrder(result), result, '重复执行稳定');
  const draft = new DraftTrip(form);
  draft.setSkeleton('北京', ['前', '后']);
  beijing.forEach((p) => draft.addActivity(1, p));
  result.forEach((p) => draft.addActivity(2, p));
  for (const [index, points] of [beijing, result].entries()) {
    assert.equal(draft.feasibility().violations.filter((v) => v.code === 'backtrack' && v.dayIndex === index + 1).length,
      routeBacktracks(points), '与正式可行性报警使用相同口径');
  }
});

test('固定餐次、未知坐标、不可满足约束保持安全降级，不为顺路丢点', () => {
  const meal = { name: '午餐', lat: 39.93, lng: 116.4 };
  const missing = { name: '未知坐标' };
  const input = [beijing[0]!, meal, beijing[1]!, missing, beijing[2]!, beijing[3]!];
  const result = optimizeRouteOrder(input, { fixedIndexes: new Set([1]) });
  assert.equal(result[1], meal);
  assert.equal(result[3], missing);
  assert.deepEqual(new Set(result), new Set(input));
  assert.ok(routeDistanceMeters(result) <= routeDistanceMeters(input) + 1);
  const cycle = [{ before: '什刹海', after: '北海公园' }, { before: '北海公园', after: '什刹海' }];
  assert.deepEqual(optimizeRouteOrder(beijing, { constraints: cycle }), beijing);
  const invalid = [beijing[0]!, { name: '无效坐标', lat: NaN, lng: 181 }, ...beijing.slice(1)];
  assert.equal(optimizeRouteOrder(invalid)[1], invalid[1]);
});

test('强制先后优先，住宿往返纳入路程，超过8点不做阶乘搜索', () => {
  const constraints = [{ before: '北海公园', after: '什刹海' }];
  const origin = { lat: 39.92, lng: 116.39 };
  const result = optimizeRouteOrder(beijing, { constraints, origin });
  assert.ok(names(result).indexOf('北海公园') < names(result).indexOf('什刹海'));
  const valid = [beijing[1]!, beijing[0]!, beijing[2]!, beijing[3]!];
  assert.ok(routeDistanceMeters(optimizeRouteOrder(valid, { origin }), origin) <= routeDistanceMeters(valid, origin) + 1);
  const large = Array.from({ length: 9 }, (_, i) => ({ name: String(i), lat: 39.9 + i / 100, lng: 116.4 }));
  assert.deepEqual(optimizeRouteOrder(large), large);
});

test('坐标补齐后的草稿只重排无时刻天，清理旧legs并保留跨日成员和故宫先于景山', () => {
  const draft = new DraftTrip(form);
  draft.setSkeleton('北京', ['可重排', '已排时刻']);
  beijing.forEach((p) => draft.addActivity(1, p));
  beijing.forEach((p, i) => draft.addActivity(2, { ...p, startTime: `${10 + i}:00`, endTime: `${10 + i}:30` }));
  const days = draft.mutableDays();
  days[0]!.legs = [];
  const originalTimed = structuredClone(days[1]);
  const originalIds = days[0]!.activities.map((a) => a.id).sort();
  assert.deepEqual(orderUntimedDayRoutes(draft, '北京'), [1]);
  assert.equal(routeBacktracks(days[0]!.activities), 0);
  assert.equal(days[0]!.legs, undefined);
  assert.deepEqual(days[0]!.activities.map((a) => a.id).sort(), originalIds);
  assert.deepEqual(days[1], originalTimed);
  assert.deepEqual(orderUntimedDayRoutes(draft, '北京'), []);

  draft.setSkeleton('约束', ['中轴线']);
  for (const p of [
    { name: '景山公园', lat: 39.925, lng: 116.396 },
    { name: '故宫博物院', lat: 39.916, lng: 116.397 },
    { name: '天安门广场', lat: 39.904, lng: 116.397 },
  ]) draft.addActivity(1, p);
  orderUntimedDayRoutes(draft, '北京');
  const ordered = names(draft.mutableDays()[0]!.activities);
  assert.ok(ordered.indexOf('故宫博物院') < ordered.indexOf('景山公园'));
});
