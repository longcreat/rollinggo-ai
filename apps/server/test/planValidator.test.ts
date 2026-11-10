// 方案验收：稀薄、跨区、重复坐标、杂项、闭馆都要能被量化并给出可读违规。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closedWeekdays, dayDate, measurePlan, percentile, planViolations, PLAN_POLICY, weekdayOf } from '@tripweaver/agent/generation/planner/validator';

const activity = (id: string, name: string, lat: number, lng: number, extra: Record<string, unknown> = {}) => ({
  id, name, lat, lng, startTime: '', endTime: '', description: '', coordSource: 'geocoded', category: '文化', sourceNotes: [], ...extra,
});

test('日期与星期：2026-11-09 是周一', () => {
  assert.equal(dayDate('2026-11-09', 1), '2026-11-09');
  assert.equal(dayDate('2026-11-09', 2), '2026-11-10');
  assert.equal(weekdayOf('2026-11-09'), 1);
  assert.equal(weekdayOf(''), null);
});

test('闭馆日解析：周一闭馆 / 无休 / 无法解析', () => {
  assert.deepEqual(closedWeekdays('周一闭馆'), [1]);
  assert.deepEqual(closedWeekdays('每周二闭馆；旺季 08:00-17:00'), [2]);
  assert.deepEqual(closedWeekdays('全年无休 09:00-18:00'), []);
  assert.deepEqual(closedWeekdays('08:00-17:00'), []);
  assert.deepEqual(closedWeekdays(undefined), []);
});

test('闭馆日解析与 isClosedOnDate 同口径：「休息 / 不开放」也算闭馆', () => {
  assert.deepEqual(closedWeekdays('周一休息'), [1]);
  assert.deepEqual(closedWeekdays('周一、周二不开放；09:00-17:00'), [1, 2]);
  assert.deepEqual(closedWeekdays('周三停业'), [3]);
});

test('指标：重复坐标、零段距、杂项、稀疏', () => {
  const trip = {
    startDate: '2026-11-09',
    days: [
      { id: 'd1', dayIndex: 1, title: '', activities: [
        activity('a1', '断桥残雪', 30.258, 120.151),
        activity('a2', '白堤', 30.258, 120.151),
        activity('a3', '花港码头售票亭', 30.23, 120.139),
        activity('a4', '自由安排｜杭州', 0, 0),
        activity('a5', '楼外楼', 30.25, 120.14, { category: '美食' }),
      ], legs: [] },
    ],
  };
  const metrics = measurePlan(trip as never);
  assert.equal(metrics.stopsPerDay[1], 2, '美食与占位项不计入景点数');
  assert.equal(metrics.dupCoordPairs, 1);
  assert.ok(metrics.zeroLegShare > 0);
  assert.equal(metrics.junkRatio, 0.4, '售票亭与占位项 / 5 条活动');
  assert.equal(metrics.missingCoordStops, 1);
  const violations = planViolations(metrics, PLAN_POLICY.moderate, 1);
  assert.ok(violations.some((item) => item.code === 'sparse'));
  assert.ok(violations.some((item) => item.code === 'dup-coord' && item.severity === 'hard'));
  assert.ok(violations.some((item) => item.code === 'junk'));
});

test('集簇：单日跨度与段距分位数', () => {
  const trip = {
    startDate: '2026-11-09',
    days: [
      { id: 'd1', dayIndex: 1, title: '', activities: [
        activity('a1', 'A', 30.20, 120.10),
        activity('a2', 'B', 30.21, 120.11),
        activity('a3', 'C', 30.30, 120.20),
      ], legs: [] },
    ],
  };
  const metrics = measurePlan(trip as never);
  assert.equal(metrics.hopKm.length, 2);
  assert.ok(metrics.daySpanKm[0]! > 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  const violations = planViolations(metrics, { ...PLAN_POLICY.moderate, maxDaySpanKm: 5 }, 1);
  assert.ok(violations.some((item) => item.code === 'day-span'));
});

test('闭馆违规：周一闭馆的活动排在周一当天', () => {
  const trip = {
    startDate: '2026-11-09',
    days: [{ id: 'd1', dayIndex: 1, title: '', activities: [
      activity('a1', '博物馆', 30.25, 120.15, { openTime: '周一闭馆 09:00-17:00' }),
    ], legs: [] }],
  };
  const metrics = measurePlan(trip as never);
  assert.equal(metrics.closureViolations, 1);
  assert.ok(planViolations(metrics, PLAN_POLICY.relaxed, 1).some((item) => item.code === 'closure' && item.severity === 'hard'));
});

test('空行程直接判 hard', () => {
  const violations = planViolations(measurePlan({ startDate: '', days: [] } as never), PLAN_POLICY.moderate, 0);
  assert.ok(violations.some((item) => item.code === 'sparse' && item.severity === 'hard'));
});
