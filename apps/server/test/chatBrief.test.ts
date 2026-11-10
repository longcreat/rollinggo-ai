// 单测：Brief 就绪判定与约束 schema（纯函数，服务端与前端共用同一规则）
// 注：追问控件（briefIntake / briefIntakeWithOptions）已在 10-17 下线，相应用例删除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import {
  PlanningBriefDataSchema,
  TripConstraintSchema,
  isBriefReady,
  requiredBriefFields,
  type PlanningBriefData,
} from '@tripweaver/shared';

const base: PlanningBriefData = { destination: '成都', startDate: '2026-11-05', days: 3, pace: 'moderate', constraints: [] };

test('必填只有 4 项：全空时按固定顺序报缺', () => {
  assert.deepEqual(requiredBriefFields({ constraints: [] }), ['destination', 'startDate', 'endDate', 'pace']);
});

test('days 是 endDate 的合法等价表达——给了 days 就不再报缺 endDate', () => {
  assert.deepEqual(requiredBriefFields({ constraints: [], destination: '成都', startDate: '2026-11-05', days: 3, pace: 'moderate' }), []);
});

test('startDate + endDate 齐备时无需 days', () => {
  assert.deepEqual(requiredBriefFields({ ...base, days: undefined, endDate: '2026-11-07' }), []);
});

test('非法日期被拒：格式错误与日历上不存在的日期都算缺失', () => {
  assert.ok(requiredBriefFields({ ...base, startDate: '2026/11/05' }).includes('startDate'));
  assert.ok(requiredBriefFields({ ...base, startDate: '2026-02-30' }).includes('startDate'));
});

test('结束早于开始 → 合成项 dateRange；相等不报错', () => {
  assert.ok(requiredBriefFields({ ...base, days: undefined, startDate: '2026-11-05', endDate: '2026-11-01' }).includes('dateRange'));
  assert.deepEqual(requiredBriefFields({ ...base, days: undefined, startDate: '2026-11-05', endDate: '2026-11-05' }), []);
});

test('齐备时 isBriefReady 为真，缺任一必填为假', () => {
  assert.equal(isBriefReady(base), true);
  assert.equal(isBriefReady({ ...base, pace: undefined }), false);
});

test('约束 schema：接受 4 种 polarity，拒绝未知分类与未知极性', () => {
  const constraint = { id: 'c1', category: 'companion_context', valueText: '带 2 岁小孩', polarity: 'fact', evidenceSequence: 1 };
  assert.ok(Value.Check(TripConstraintSchema, constraint));
  assert.ok(Value.Check(TripConstraintSchema, { ...constraint, polarity: 'avoid' }));
  assert.ok(!Value.Check(TripConstraintSchema, { ...constraint, polarity: 'neutral' }));
  assert.ok(!Value.Check(TripConstraintSchema, { ...constraint, category: 'mood' }));
});

test('Brief data schema：字段全可选（只要求 constraints），未知字段不通过', () => {
  assert.ok(Value.Check(PlanningBriefDataSchema, { constraints: [] }));
  assert.ok(!Value.Check(PlanningBriefDataSchema, {}));
  assert.ok(Value.Check(PlanningBriefDataSchema, base));
  assert.ok(Value.Check(PlanningBriefDataSchema, { ...base, pace: 'tight' }));
  assert.ok(!Value.Check(PlanningBriefDataSchema, { ...base, pace: 'whatever' }));
});
