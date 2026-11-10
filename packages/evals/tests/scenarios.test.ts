import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { GenerateFormSchema } from '@rollinggo-trip/shared';
import { ALL_CASES, MATRIX_CASES, MATRIX_CITIES, NOTE_CASES } from '../scenarios';
import { currentFixture } from './currentFixture';
import { checkNotePlaces } from '../noteChecks';
import { createManifest, reportMarkdown } from '../artifacts';
import { buildReport, evaluateCase } from '../runner';

test('矩阵覆盖每城 3/5 日与四种偏好，云南排除，历史金集 ID 不冲突', () => {
  assert.equal(MATRIX_CASES.length, 88);
  assert.equal(NOTE_CASES.length, 8);
  assert.equal(new Set(ALL_CASES.map((c) => c.id)).size, ALL_CASES.length);
  for (const c of ALL_CASES) assert.ok(Value.Check(GenerateFormSchema, c.form), c.id);
  for (const [, city] of MATRIX_CITIES) for (const days of [3, 5]) {
    const rows = MATRIX_CASES.filter((c) => c.form.destination === city && c.form.days === days);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((c) => c.form.preferences), [[], ['美食'], ['文化'], ['自然']]);
  }
  assert.ok(MATRIX_CASES.every((c) => c.form.destination !== '云南'));
});
test('明确必去/避开检查最终产物，不以保存备注当作满足', () => {
  const required = NOTE_CASES[0]!;
  const avoided = NOTE_CASES[1]!;
  const snapshot = currentFixture(required);
  assert.equal(checkNotePlaces(required.id, snapshot.trip).length, 1);
  assert.equal(evaluateCase(required, snapshot, false).outcome.status, 'FAIL');
  snapshot.trip.days[0]!.activities[0]!.name = '故宫博物院';
  assert.deepEqual(checkNotePlaces(required.id, snapshot.trip), []);
  assert.equal(checkNotePlaces(avoided.id, snapshot.trip).length, 1);
  snapshot.trip.days[0]!.activities[0]!.name = '沈阳故宫';
  assert.deepEqual(checkNotePlaces(avoided.id, snapshot.trip), []);
});
test('矩阵部分结果如实标范围，未执行用例不通过整体门槛', () => {
  const c = MATRIX_CASES[0]!;
  const report = buildReport(createManifest(MATRIX_CASES, 'live', 'matrix'), [evaluateCase(c, currentFixture(c), true).outcome], []);
  assert.equal(report.gate.pass, false);
  const subset = buildReport(createManifest([c], 'live', 'matrix'), report.cases, []);
  assert.match(reportMarkdown(subset), /从 matrix 88 例中选择 1 例/);
});
