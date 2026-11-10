// 旧事件流 → 投影：直播的真相变成行与状态，客户端不再重放事件重新合成。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GenerationEvent, GenerationEventPayload } from '@tripweaver/shared';
import { createGenerationProjection } from '@tripweaver/agent/generation/projectionAdapter';

const ev = (payload: GenerationEventPayload): GenerationEvent => ({ ...payload, at: 0 });

describe('生成投影适配器', () => {
  it('job_start 建空天与运行态', () => {
    const projection = createGenerationProjection('job-1');
    projection.consume(ev({ type: 'job_start', destination: '成都', days: 2, startDate: '2026-11-10', xhsEnabled: false, dataSources: [] }));
    const { snapshot } = projection.channel;
    assert.equal(snapshot.rows.window.length, 2);
    assert.deepEqual(snapshot.rows.window.map((row) => row.rowId), [1, 2]);
    assert.equal(snapshot.state.control.status, 'running');
    assert.equal(snapshot.state.trip?.destination, '成都');
    assert.equal(snapshot.state.trip?.id, 'job-1');
  });

  it('plan_day 逐日填充行；重复到达整体替换', () => {
    const projection = createGenerationProjection('job-1');
    projection.consume(ev({ type: 'job_start', destination: '成都', days: 2, startDate: '2026-11-10', xhsEnabled: false, dataSources: [] }));
    projection.consume(ev({ type: 'plan_day', dayIndex: 1, title: '市区', stops: [
      { name: '人民公园', lat: 30.66, lng: 104.06, startTime: '09:00', endTime: '11:00', category: '文化' },
    ] }));
    projection.consume(ev({ type: 'plan_day', dayIndex: 1, title: '市区改', stops: [
      { name: '宽窄巷子', lat: 30.67, lng: 104.05, startTime: '10:00', endTime: '12:00', category: '文化' },
    ] }));
    const day = projection.channel.snapshot.rows.window[0]!;
    assert.equal(day.title, '市区改');
    assert.deepEqual(day.activities.map((activity) => activity.name), ['宽窄巷子']);
    assert.equal(day.activities[0]!.coordSource, 'geocoded');
  });

  it('phase / tool 进度进入 taskGraph，状态按结束更新', () => {
    const projection = createGenerationProjection('job-1');
    projection.consume(ev({ type: 'job_start', destination: '成都', days: 1, startDate: '', xhsEnabled: false, dataSources: [] }));
    projection.consume(ev({ type: 'phase_start', phase: 'routing', round: 1 }));
    projection.consume(ev({ type: 'tool_start', phase: 'routing', toolCallId: 'c1', tool: 'plan_day', label: '规划第 1 天', args: '{}' }));
    projection.consume(ev({ type: 'tool_end', phase: 'routing', toolCallId: 'c1', tool: 'plan_day', label: '规划第 1 天', summary: 'ok', isError: false, durationMs: 12 }));
    projection.consume(ev({ type: 'phase_end', phase: 'routing', round: 1, summary: '活动 11 个', durationMs: 99 }));
    const nodes = projection.channel.snapshot.state.taskGraph;
    assert.equal(projection.channel.snapshot.state.control.phase, 'routing');
    assert.equal(nodes.find((node) => node.id === 'c1')?.status, 'done');
    const phase = nodes.find((node) => node.id === 'phase:routing:1');
    assert.equal(phase?.status, 'done');
    assert.equal(phase?.summary, '活动 11 个');
    assert.equal(phase?.durationMs, 99);
  });

  it('停止/失败后仍在运行的阶段与工具收口，不保留转圈状态', () => {
    const projection = createGenerationProjection('job-1');
    projection.consume(ev({ type: 'job_start', destination: '成都', days: 1, startDate: '', xhsEnabled: false, dataSources: [] }));
    projection.consume(ev({ type: 'phase_start', phase: 'routing', round: 1 }));
    projection.consume(ev({ type: 'tool_start', phase: 'routing', toolCallId: 'c1', tool: 'plan_day', label: '规划第 1 天', args: '{}' }));
    projection.consume(ev({ type: 'job_cancelled', reason: 'user' }));
    const nodes = projection.channel.snapshot.state.taskGraph;
    assert.equal(nodes.find((node) => node.id === 'phase:routing:1')?.status, 'error');
    assert.equal(nodes.find((node) => node.id === 'c1')?.status, 'error');
    assert.equal(projection.channel.snapshot.state.control.status, 'cancelled');
  });

  it('候选累积到行程头，usage 进入状态', () => {
    const projection = createGenerationProjection('job-1');
    projection.consume(ev({ type: 'job_start', destination: '成都', days: 1, startDate: '', xhsEnabled: false, dataSources: [] }));
    projection.consume(ev({ type: 'candidate', poi: { id: 'p1', name: '武侯祠', category: 'attraction', intro: '', reservation: 'unknown', sourceLinks: [] } }));
    projection.consume(ev({ type: 'usage', tokensIn: 10, tokensOut: 20, xhsCalls: 0, amapCalls: 3, searchCalls: 1 }));
    assert.deepEqual(projection.channel.snapshot.state.trip?.overview?.map((poi) => poi.id), ['p1']);
    assert.deepEqual(projection.channel.snapshot.state.usage, { tokensIn: 10, tokensOut: 20, amapCalls: 3, searchCalls: 1 });
  });

  it('job_done 落定终态与正式 tripId', () => {
    const projection = createGenerationProjection('job-1');
    projection.consume(ev({ type: 'job_start', destination: '成都', days: 1, startDate: '', xhsEnabled: false, dataSources: [] }));
    projection.consume(ev({ type: 'job_done', tripId: 'trip-9', usedXhs: false, dataSources: [], reviewNotes: [] }));
    const { snapshot } = projection.channel;
    assert.equal(snapshot.state.control.status, 'done');
    assert.equal(snapshot.state.control.tripId, 'trip-9');
    assert.equal(snapshot.state.trip?.id, 'trip-9');
    assert.equal(snapshot.state.trip?.title, '成都');
  });

  it('job_error / job_cancelled 给出明确终态', () => {
    const error = createGenerationProjection('job-1');
    error.consume(ev({ type: 'job_error', message: '模型不可用' }));
    assert.deepEqual([error.channel.snapshot.state.control.status, error.channel.snapshot.state.control.message], ['error', '模型不可用']);

    const cancelled = createGenerationProjection('job-2');
    cancelled.consume(ev({ type: 'job_cancelled', reason: 'timeout' }));
    assert.deepEqual([cancelled.channel.snapshot.state.control.status, cancelled.channel.snapshot.state.control.message], ['cancelled', 'timeout']);
  });
});