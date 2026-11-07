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

test('按阶段分组：阶段节点只做状态，不混进工具流程', () => {
  const stream = buildLiveStreamFromProjection(snapshot({ control: { phase: 'plan', status: 'running' } }, [
    { id: 'phase:research:1', phase: 'research', label: '调研', status: 'done', summary: '候选 8 个｜成都市区' },
    { id: 'c1', phase: 'plan', label: '规划第 1 天', status: 'running' },
    { id: 'c2', phase: 'plan', label: '校验', status: 'error' },
  ]));
  assert.deepEqual(stream.phases.map((phase) => phase.key), ['research', 'plan']);
  const research = stream.phases[0]!;
  assert.equal(research.status, 'done');
  assert.equal(research.summary, '候选 8 个｜成都市区');
  assert.equal(research.lines.length, 0, '阶段节点本身不能出现在详情步骤里');
  const plan = stream.phases[1]!;
  assert.equal(plan.status, 'error');
  assert.equal(plan.current, '正在规划第 1 天…');
  assert.equal(plan.completed, 0);
  assert.equal(plan.total, 2);
  assert.deepEqual(plan.lines.map((line) => line.text), ['正在规划第 1 天…', '校验未完成']);
  assert.equal(stream.active?.id, 'c1');
});

test('阶段摘要、步数与耗时进入卡片模型', () => {
  const stream = buildLiveStreamFromProjection(snapshot({}, [
    { id: 'phase:plan:1', phase: 'plan', label: '规划', status: 'done', summary: '活动 11 个｜候选 8 个', durationMs: 65000 },
    { id: 't1', phase: 'plan', label: '排第 1 天', status: 'done', durationMs: 1200 },
    { id: 't2', phase: 'plan', label: '排第 2 天', status: 'done', durationMs: 900 },
  ]));
  const plan = stream.phases[0]!;
  assert.equal(plan.status, 'done');
  assert.equal(plan.completed, 2);
  assert.equal(plan.total, 2);
  assert.equal(plan.summary, '活动 11 个｜候选 8 个');
  assert.equal(plan.durationMs, 65000);
  assert.equal(plan.lines[0]!.durationMs, 1200);
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