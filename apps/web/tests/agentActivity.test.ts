import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { AgentStepSchema, ChatAttachmentSchema, ChatStreamEventSchema, type AgentStep } from '@rollinggo-trip/shared';
import { stepsFromSummary, upsertAgentStep } from '../src/lib/agentActivity';

const step = (id: string, name: string, status: AgentStep['status'], durationMs?: number): AgentStep => ({
  id, name, label: name, status, ...(durationMs !== undefined ? { durationMs } : {}),
});

test('旧 summary 回退：去掉过程词缀、合并连续重复、过滤保存提示', () => {
  const steps = stepsFromSummary([
    '正在查地点…', '查地点完成', '查天气完成', '已保存为 v3，调整了第 2 天。',
    '正在查地点…', '查地点完成', '本轮问答已保存，可展开回看。',
  ]);
  assert.deepEqual(steps.map((item) => item.label), ['查地点', '查天气', '查地点']);
  assert.ok(steps.every((item) => item.status === 'done' && item.durationMs === undefined));
  assert.equal(stepsFromSummary(undefined).length, 0);
  assert.equal(stepsFromSummary(['   ', '完成']).length, 0);
});

test('步骤按 id upsert 而不是追加重复行', () => {
  const first = upsertAgentStep([], step('call-1', '查地点', 'running'));
  const second = upsertAgentStep(first, { ...step('call-1', '查地点', 'done', 900), label: '查地点' });
  assert.equal(second.length, 1);
  assert.equal(second[0]!.status, 'done');
  assert.equal(second[0]!.durationMs, 900);
  assert.equal(upsertAgentStep(second, step('call-2', '查天气', 'running')).length, 2);
});

test('契约：progress 可携带结构化步骤，非法状态被拒绝', () => {
  const base = { requestId: 'r1', sequence: 1 };
  const validStep = { id: 'call-1', name: 'search_places', label: '查地点', status: 'running', startedAt: 1, durationMs: 0 };
  assert.ok(Value.Check(ChatStreamEventSchema, { ...base, type: 'progress', text: '正在查地点…', step: validStep }));
  assert.ok(Value.Check(ChatStreamEventSchema, { ...base, type: 'progress', text: '正在查地点…' }));
  assert.ok(!Value.Check(AgentStepSchema, { ...validStep, status: 'failed' }));
  assert.ok(Value.Check(ChatAttachmentSchema, {
    tripId: 't1', summary: ['查地点'], steps: [validStep], elapsedMs: 1200,
    candidates: [],
  }));
  assert.ok(!Value.Check(ChatAttachmentSchema, {
    tripId: 't1', summary: ['查地点'], steps: [{ ...validStep, durationMs: 700_000 }],
    candidates: [],
  }));
});
