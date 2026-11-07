// 直播播报：阶段中文名、工具文案、进行中状态与候选摘要。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerationEvent } from '@tripweaver/shared';
import { buildTimeline } from '../src/lib/generationTimeline';
import { buildLiveStream } from '../src/lib/liveAgentStream';

const events: GenerationEvent[] = [
  { type: 'job_start', destination: '杭州', days: 2, xhsEnabled: true, dataSources: ['amap'] },
  { type: 'phase_start', phase: 'plan', round: 1, note: 'Agent 规划' },
  { type: 'thought', phase: 'plan', text: '先看西湖片区的候选' },
  { type: 'tool_start', phase: 'plan', toolCallId: 'c1', tool: 'list_areas', label: '查看片区', args: '{}' },
  { type: 'tool_end', phase: 'plan', toolCallId: 'c1', tool: 'list_areas', label: '查看片区', summary: '8 个', isError: false, durationMs: 120 },
  { type: 'tool_start', phase: 'plan', toolCallId: 'c2', tool: 'plan_day', label: '排定一天', args: '{}' },
];

test('阶段中文名、工具文案与进行中状态', () => {
  const stream = buildLiveStream(buildTimeline(events));
  assert.equal(stream.phases.length, 1);
  assert.equal(stream.phases[0]!.label, '规划每日行程');
  assert.equal(stream.phases[0]!.done, false);
  const texts = stream.phases[0]!.lines.map((line) => line.text);
  assert.ok(texts.includes('先看西湖片区的候选'));
  assert.ok(texts.includes('寻找适合游玩的片区完成'));
  assert.ok(texts.includes('正在安排这一天的路线…'));
  assert.ok(stream.active, '有进行中的动作');
  assert.equal(stream.terminal, null);
});

test('终态事件透出，候选按到达顺序保留', () => {
  const stream = buildLiveStream(buildTimeline([
    ...events,
    { type: 'candidate', poi: { id: 'p1', name: '断桥残雪', category: 'attraction', intro: '', reservation: 'unknown', sourceLinks: [] } },
    { type: 'job_done', tripId: 't1', usedXhs: false, dataSources: [], reviewNotes: [] },
  ]));
  assert.equal(stream.candidates.at(-1)?.name, '断桥残雪');
  assert.equal(stream.terminal?.type, 'job_done');
});
