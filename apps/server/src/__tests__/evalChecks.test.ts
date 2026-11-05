// eval 确定性检查单测（node:test，经 tsx 运行）：四类指标正/反例
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSampleTrip, uid, type GenerateForm, type Trip } from '@tripweaver/shared';
import { runChecks } from '../../../../eval/checks';

const NOW = 1_700_000_000_000;

function sampleForm(overrides: Partial<GenerateForm> = {}): GenerateForm {
  return {
    destination: '上海',
    days: 3,
    startDate: '',
    budgetLevel: '舒适',
    totalBudget: 0,
    preferences: ['美食', '文化'],
    partySize: 2,
    extraNotes: '',
    ...overrides,
  };
}

/** 可行版样例：原样例第 2 天「武康大楼→午餐」背靠背（11:30→11:30）真有 transit_infeasible，留出通勤间隙 */
function feasibleSampleTrip(): Trip {
  const trip = makeSampleTrip(NOW);
  trip.days[1]!.activities[0]!.endTime = '11:00';
  return trip;
}

test('样例行程（修正通勤间隙后）：无 hard 违规、结构通过 → pass', () => {
  const result = runChecks('sample', feasibleSampleTrip(), sampleForm());
  assert.equal(result.hardViolations.length, 0);
  assert.deepEqual(result.structural, []);
  assert.equal(result.pass, true);
});

test('可行性：注入 15.5h 超长日 → overpacked hard，pass=false', () => {
  const trip = makeSampleTrip(NOW);
  const day = trip.days[0]!;
  day.activities[0]!.startTime = '08:00';
  day.activities[0]!.endTime = '23:30';
  const result = runChecks('overpacked', trip, sampleForm());
  assert.ok((result.hardByCode['overpacked'] ?? 0) >= 1);
  assert.equal(result.pass, false);
});

test('结构：天数不匹配 + 空天 + 非法时间均被点名', () => {
  const trip = makeSampleTrip(NOW);
  trip.days[1]!.activities[0]!.startTime = '25:99';
  trip.days.push({ id: uid(), dayIndex: 4, title: '空天', activities: [] });
  const result = runChecks('structural', trip, sampleForm());
  assert.ok(result.structural.some((p) => p.includes('天数不匹配')));
  assert.ok(result.structural.some((p) => p.includes('空天')));
  assert.ok(result.structural.some((p) => p.includes('时间格式非法')));
  assert.equal(result.pass, false);
});

test('结构：结束时间不晚于开始时间被点名', () => {
  const trip = makeSampleTrip(NOW);
  trip.days[0]!.activities[0]!.startTime = '12:00';
  trip.days[0]!.activities[0]!.endTime = '10:00';
  const result = runChecks('time-order', trip, sampleForm());
  assert.ok(result.structural.some((p) => p.includes('结束时间不晚于开始时间')));
});

test('地理：异城坐标（>100km）计入离群；geocoded 比例统计正确', () => {
  const trip = makeSampleTrip(NOW);
  const stray = trip.days[0]!.activities[0]!;
  stray.name = '幻觉景点';
  stray.lat = 39.9;      // 北京坐标混入上海行程
  stray.lng = 116.4;
  const result = runChecks('geo', trip, sampleForm());
  assert.deepEqual(result.geo.outlierActivities, ['幻觉景点']);
  assert.equal(result.geo.geocodedRatio, 0);   // 样例全为 manual
});

test('旧预算和费用值不影响当前评估，也不产生预算维度', () => {
  const trip: Trip = makeSampleTrip(NOW);
  const before = runChecks('compatibility', trip, sampleForm());
  for (const day of trip.days) for (const a of day.activities) delete a.cost;
  const after = runChecks('compatibility', trip, sampleForm({ totalBudget: 999999, budgetLevel: '豪华' }));
  assert.deepEqual(after, before);
  assert.ok(!('budget' in after));
});

test('geo 门槛：空心快照形态（全活动 0,0/estimated、无 leg）→ 点名覆盖率，pass=false', () => {
  const trip = makeSampleTrip(NOW);
  for (const day of trip.days) {
    for (const a of day.activities) {
      a.lat = 0;
      a.lng = 0;
      a.coordSource = 'estimated';
    }
  }
  const result = runChecks('vacuous', trip, sampleForm());
  assert.ok(result.geoGate.some((p) => p.includes('有效坐标覆盖率')));
  assert.equal(result.pass, false);
});

test('geo 门槛：估算坐标占比 5/11 超限 → 点名不可信；4/11 在限内 → 通过', () => {
  const over = feasibleSampleTrip();
  for (const a of over.days.flatMap((d) => d.activities).slice(0, 5)) a.coordSource = 'estimated';
  const overResult = runChecks('estimated-over', over, sampleForm());
  assert.ok(overResult.geoGate.some((p) => p.includes('估算坐标占比')));
  assert.equal(overResult.pass, false);

  const within = feasibleSampleTrip();
  for (const a of within.days.flatMap((d) => d.activities).slice(0, 4)) a.coordSource = 'estimated';
  const withinResult = runChecks('estimated-within', within, sampleForm());
  assert.deepEqual(withinResult.geoGate, []);
  assert.equal(withinResult.pass, true);
});

test('geo 门槛：手工金集形态（manual 坐标、无 leg）不误伤 → geoGate 为空', () => {
  const result = runChecks('manual-golden', feasibleSampleTrip(), sampleForm());
  assert.deepEqual(result.geoGate, []);
  assert.equal(result.pass, true);
});
