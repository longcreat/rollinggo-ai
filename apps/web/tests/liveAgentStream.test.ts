// 投影 → 播报模型：阶段/工具进度来自 state.taskGraph，终态来自 state.control。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TripProjectionSnapshot, TripProjectionState } from '@tripweaver/shared';
import { buildLiveStreamFromProjection } from '../src/lib/liveAgentStream';

function snapshot(state: Partial<TripProjectionState>, taskGraph: TripProjectionState['taskGraph'] = []): TripProjectionSnapshot {
  return {
    seq: 1,
    rows: { window: [], totalCount: 0, firstRowId: null },
    state: {
      trip: { id: 'job-1', title: '成都 · 生成中', destination: '成都', startDate: '', updatedAt: 0, overview: [] },
      control: { phase: 'idle', status: 'running' },
      taskGraph,
      usage: null,
      pendingInteractions: [],
      availability: { canSend: true },
      ...state,
    },
  };
}

test('按阶段分组并给出进行中/完成文案', () => {
  const stream = buildLiveStreamFromProjection(snapshot({ control: { phase: 'plan', status: 'running' } }, [
    { id: 'phase:research:1', phase: 'research', label: '调研', status: 'done' },
    { id: 'c1', phase: 'plan', label: '规划第 1 天', status: 'running' },
    { id: 'c2', phase: 'plan', label: '校验', status: 'error' },
  ]));
  assert.deepEqual(stream.phases.map((phase) => phase.key), ['research', 'plan']);
  assert.equal(stream.phases[0]!.done, true);
  assert.equal(stream.phases[1]!.done, false);
  assert.equal(stream.phases[1]!.lines[0]!.text, '正在规划第 1 天…');
  assert.equal(stream.phases[1]!.lines[1]!.text, '校验未完成');
  assert.equal(stream.active?.id, 'c1');
});

test('候选来自行程头，终态来自 control', () => {
  const candidate = { id: 'p1', name: '武侯祠', category: 'attraction' as const, intro: '', reservation: 'unknown' as const, sourceLinks: [] };
  const running = buildLiveStreamFromProjection(snapshot({
    trip: { id: 'job-1', title: '成都', destination: '成都', startDate: '', updatedAt: 0, overview: [candidate] },
  }));
  assert.deepEqual(running.candidates.map((poi) => poi.id), ['p1']);
  assert.equal(running.terminal, null);

  const done = buildLiveStreamFromProjection(snapshot({ control: { phase: 'commit', status: 'done', tripId: 'trip-9' } }));
  assert.deepEqual(done.terminal, { type: 'job_done', tripId: 'trip-9', usedXhs: false, dataSources: [], reviewNotes: [] });

  const failed = buildLiveStreamFromProjection(snapshot({ control: { phase: 'idle', status: 'error', message: '模型不可用' } }));
  assert.deepEqual(failed.terminal, { type: 'job_error', message: '模型不可用' });

  const cancelled = buildLiveStreamFromProjection(snapshot({ control: { phase: 'idle', status: 'cancelled', message: 'timeout' } }));
  assert.deepEqual(cancelled.terminal, { type: 'job_cancelled', reason: 'timeout' });
});