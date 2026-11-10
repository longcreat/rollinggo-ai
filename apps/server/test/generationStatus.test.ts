import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationStatusView } from '@rollinggo-trip/agent/generation/statusView';
import type { GenerationTaskView } from '@rollinggo-trip/agent/generation/taskStore';

const task = (overrides: Partial<GenerationTaskView> = {}): GenerationTaskView => ({
  jobId: 'job-1',
  status: 'done',
  tripId: 'trip-1',
  createdAt: 1_000,
  ...overrides,
});

test('运行中的内存任务带阶段与步骤', () => {
  const view = generationStatusView({
    live: {
      jobId: 'job-1', status: 'running', tripId: null,
      destination: '成都', days: 3, phase: 'plan', steps: ['调研完成', '规划进行中'],
    },
  });
  assert.equal(view.running, true);
  assert.equal(view.phase, 'plan');
  assert.deepEqual(view.steps, ['调研完成', '规划进行中']);
  assert.equal(view.destination, '成都');
});

test('内存任务终态不再标 running', () => {
  const view = generationStatusView({ live: { jobId: 'job-1', status: 'done', tripId: 'trip-1' } });
  assert.equal(view.running, false);
  assert.equal(view.status, 'done');
});

test('重启后读持久任务：带摘要与告警', () => {
  const view = generationStatusView({
    task: task({
      summary: '成都市区 3 天',
      reviewNotes: ['建议优化：第 1 天偏满'],
      warnings: [{ severity: 'soft', code: 'overpacked', dayIndex: 1, message: '几乎排满' }],
    }),
  });
  assert.equal(view.running, false);
  assert.equal(view.tripId, 'trip-1');
  assert.equal(view.summary, '成都市区 3 天');
  assert.equal(view.warnings?.length, 1);
});

test('持久行 running 超时：不冒充进行中，标记 stale', () => {
  const view = generationStatusView({
    task: task({ status: 'running', tripId: null }),
    now: 10 * 60_000,
    staleAfterMs: 60_000,
  });
  assert.equal(view.running, false);
  assert.equal(view.status, 'error');
  assert.equal(view.stale, true);
});

test('没有任务时明确 running=false', () => {
  assert.deepEqual(generationStatusView({}), { running: false });
  assert.deepEqual(generationStatusView({ task: null }), { running: false });
});
