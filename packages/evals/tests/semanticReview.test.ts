import assert from 'node:assert/strict';
import test from 'node:test';
import { validateVerdicts, reviewInput } from '../semanticReview';
import { currentFixture } from './currentFixture';
import { MATRIX_CASES } from '../scenarios';

test('语义审阅必须覆盖全部场景且引用所属行程真实活动，不能借用别例或编造 ID', () => {
  const a = currentFixture(MATRIX_CASES[0]!);
  const b = currentFixture(MATRIX_CASES[1]!);
  b.trip.days.forEach((d) => d.activities.forEach((x) => { x.id = `b-${x.id}`; }));
  const rows = [a,b].map((s) => ({ caseId: s.caseId, verdict: 'aligned', reason: '具体依据', activityIds: [s.trip.days[0]!.activities[0]!.id] }));
  assert.equal(validateVerdicts(rows,[a,b]).length,2);
  assert.throws(() => validateVerdicts(rows.slice(0,1),[a,b]));
  assert.throws(() => validateVerdicts([rows[0],rows[0]],[a,b]));
  assert.throws(() => validateVerdicts([{ ...rows[0], activityIds: rows[1]!.activityIds },rows[1]],[a,b]));
  assert.throws(() => validateVerdicts([{ ...rows[0], activityIds: [] },rows[1]],[a,b]));
  assert.throws(() => validateVerdicts([{ ...rows[0], reason: '引用其他场景 11111111-2222-3333-4444-555555555555' },rows[1]],[a,b]));
  assert.throws(() => validateVerdicts([{ ...rows[0], reason: '陈家祠(124cafc8)' },rows[1]],[a,b]));
  assert.ok(!('totalBudget' in reviewInput([a])[0]!.form));
});
