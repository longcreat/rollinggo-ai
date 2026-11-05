import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationEvent } from '@tripweaver/shared';
import { buildTimeline, formatDuration } from '../../../web/src/lib/generationTimeline';

test('buildTimeline keeps server durations stable across replay', () => {
  const events: GenerationEvent[] = [
    { type: 'job_start', destination: '杭州', xhsEnabled: false, dataSources: [], at: 1_000 },
    { type: 'phase_start', phase: 'research', round: 1, at: 1_100 },
    { type: 'tool_start', phase: 'research', toolCallId: 't1', tool: 'search_web', label: '搜索攻略', args: '{}', at: 1_200 },
    { type: 'tool_end', phase: 'research', toolCallId: 't1', tool: 'search_web', label: '搜索攻略', summary: '完成', isError: false, at: 1_700, durationMs: 500 },
    { type: 'phase_end', phase: 'research', round: 1, at: 2_000, durationMs: 900 },
    { type: 'job_cancelled', at: 2_500, durationMs: 1_500 },
  ];

  const model = buildTimeline(events);
  assert.equal(model.startedAt, 1_000);
  assert.equal(model.durationMs, 1_500);
  assert.equal(model.phases[0]?.durationMs, 900);
  const tool = model.phases[0]?.items.find((item) => item.kind === 'tool');
  assert.equal(tool?.durationMs, 500);
  assert.equal(tool?.running, false);
  // 10-22：进度文案按稳定工具名查表，label 只作兜底展示
  assert.equal(tool?.tool, 'search_web');
});

test('buildTimeline tolerates legacy events without timing fields', () => {
  const model = buildTimeline([
    { type: 'job_start', destination: '杭州', xhsEnabled: false, dataSources: [] },
    { type: 'phase_start', phase: 'research', round: 1 },
    { type: 'phase_end', phase: 'research', round: 1 },
  ]);
  assert.equal(model.durationMs, undefined);
  assert.equal(model.phases[0]?.durationMs, undefined);
});

// 09-27 视觉对齐：刷新/恢复链路的 URL 只有 city，标题天数只能来自 job_start
test('buildTimeline exposes job_start destination and days for the title', () => {
  const model = buildTimeline([
    { type: 'job_start', destination: '北京', days: 4, xhsEnabled: false, dataSources: [] },
  ]);
  assert.equal(model.destination, '北京');
  assert.equal(model.days, 4);
});

test('buildTimeline leaves days undefined for legacy job_start events', () => {
  const model = buildTimeline([
    { type: 'job_start', destination: '北京', xhsEnabled: false, dataSources: [] },
  ]);
  assert.equal(model.days, undefined);
});

test('formatDuration uses compact Chinese units', () => {
  assert.equal(formatDuration(450), '0.5 秒');
  assert.equal(formatDuration(12_300), '12 秒');
  assert.equal(formatDuration(83_000), '1 分 23 秒');
});
