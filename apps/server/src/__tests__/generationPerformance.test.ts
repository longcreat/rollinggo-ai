import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationPerformance, unionDurationMs } from '../generation/performance';

test('并行阶段按并集计算，包含嵌套、零耗时和间隔', () => {
  assert.equal(unionDurationMs([{ start: 0, end: 100 }, { start: 80, end: 150 }, { start: 90, end: 95 }, { start: 200, end: 210 }]), 160);
  assert.equal(unionDurationMs([]), 0);
  assert.equal(unionDurationMs([{ start: 1, end: 1 }]), 0);
});

test('GenerationPerformance records stable phase and task durations', () => {
  let now = 1_000;
  const timing = new GenerationPerformance(now, () => now);

  assert.equal(timing.startPhase('research', 1), 1_000);
  now = 1_250;
  assert.deepEqual(timing.endPhase('research', 1), { at: 1_250, durationMs: 250 });

  assert.equal(timing.startTask('tool-1', 'search_web'), 1_250);
  now = 1_400;
  assert.deepEqual(timing.endTask('tool-1'), { at: 1_400, durationMs: 150 });
  timing.startTask('tool-2', 'search_web');
  now = 1_500;
  timing.endTask('tool-2');

  assert.deepEqual(timing.summary('done'), {
    status: 'done',
    totalMs: 500,
    phases: { 'research:1': 250 },
    tasks: { search_web: { count: 2, totalMs: 250, maxMs: 150 } },
    activePhases: {},
    activeTasks: {},
  });
});

test('GenerationPerformance includes active work in terminal diagnostics', () => {
  let now = 2_000;
  const timing = new GenerationPerformance(now, () => now);
  timing.startPhase('plan', 2);
  timing.startTask('tool-running', 'route_estimate');
  now = 2_075;

  const summary = timing.summary('cancelled');
  assert.deepEqual(summary.activePhases, { 'plan:2': 75 });
  assert.deepEqual(summary.activeTasks, { route_estimate: 75 });
});
