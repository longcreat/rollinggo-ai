import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GOLDEN_CASES } from '../golden/cases';
import { evaluateCase } from '../runner';
import { currentFixture } from './currentFixture';

const gc = GOLDEN_CASES[0]!;
test('流程缺证据为 ERROR，旧离线仅标 unavailable；预算兼容值不改变输入', () => {
  const snapshot = currentFixture(gc);
  const base = evaluateCase(gc, snapshot, true).outcome;
  assert.equal(base.status, 'PASS');
  snapshot.form = { ...snapshot.form, totalBudget: 9000, budgetLevel: '豪华' };
  assert.equal(evaluateCase(gc, snapshot, true).outcome.inputHash, base.inputHash);
  delete snapshot.execution;
  assert.equal(evaluateCase(gc, snapshot, true).outcome.status, 'ERROR');
  assert.equal(evaluateCase(gc, snapshot, false).outcome.flow![0]!.status, 'UNAVAILABLE');
});
test('美食必须双餐，非美食不强加餐次；输入与住宿不得悄悄变化', () => {
  const snapshot = currentFixture(gc);
  snapshot.trip.days[0]!.activities.pop();
  assert.ok(evaluateCase(gc, snapshot, true).outcome.problems.some((p) => p.includes('缺晚餐')));
  const nonfood = { ...gc, form: { ...gc.form, preferences: [] } };
  snapshot.form = nonfood.form; snapshot.trip.preferences = [];
  assert.equal(evaluateCase(nonfood, snapshot, true).outcome.status, 'PASS');
  snapshot.trip.partySize = 7;
  snapshot.trip.lodging = { name: '擅自新增酒店' };
  const rows = evaluateCase(nonfood, snapshot, true).outcome.flow!;
  assert.equal(rows.find((r) => r.id === 'input')!.status, 'FAIL');
  assert.equal(rows.find((r) => r.id === 'lodging-input')!.status, 'FAIL');
});
test('标题/地图可以降级，排程跳过、模型代排或成功审计缺失则不能通过', () => {
  const snapshot = currentFixture(gc);
  delete snapshot.execution!.tasks.update_titles;
  snapshot.execution!.tasks.geo_compute_legs = { ok: 0, errors: 1 };
  assert.equal(evaluateCase(gc, snapshot, true).outcome.status, 'PASS');
  assert.ok(evaluateCase(gc, snapshot, true).outcome.metrics.flowDegraded! > 0);
  snapshot.execution!.tasks.update_titles = { ok: 1, errors: 1 };
  assert.equal(evaluateCase(gc, snapshot, true).outcome.flow!.find((r) => r.id === 'writer')!.status, 'PASS');
  for (const mutate of [() => { delete snapshot.execution!.tasks.schedule_itinerary; },
    () => { snapshot.execution!.planLlmCalls = 1; }, () => { snapshot.execution!.auditCommitted = false; }]) {
    mutate();
    assert.equal(evaluateCase(gc, snapshot, true).outcome.status, 'FAIL');
  }
});
test('换序后残留旧路段或重复路段为 FAIL，确实缺路线只标降级', () => {
  const snapshot = currentFixture(gc);
  const day = snapshot.trip.days[0]!;
  day.legs = [{ fromActivityId: day.activities[0]!.id, toActivityId: day.activities[2]!.id,
    mode: 'walk', distanceM: 10, durationMin: 1, source: 'heuristic' }];
  assert.equal(evaluateCase(gc, snapshot, true).outcome.status, 'FAIL');
  day.legs[0]!.toActivityId = day.activities[1]!.id;
  assert.equal(evaluateCase(gc, snapshot, true).outcome.status, 'PASS');
  day.legs.push({ ...day.legs[0]! });
  assert.equal(evaluateCase(gc, snapshot, true).outcome.status, 'FAIL');
});
