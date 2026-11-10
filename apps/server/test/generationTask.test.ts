// 生成 durable 任务：终态映射（纯函数）与进程重启后的直播层重建。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLiveRun, emitLive, getLiveRun } from '@tripweaver/agent/generation/liveRun';
import { taskOutcome } from '@tripweaver/agent/generation/generationTask';
import { serializeResearch } from '@tripweaver/agent/generation/checkpoint';

describe('生成任务终态映射', () => {
  it('done → completed 带 tripId 与任务摘要', () => {
    assert.deepEqual(taskOutcome({
      status: 'done',
      tripId: 'trip-1',
      summary: '成都市区 3 天',
      reviewNotes: ['建议优化：第 1 天偏满'],
      dataSources: ['amap'],
      warnings: [{ severity: 'soft', code: 'overpacked', dayIndex: 1, message: '几乎排满' }],
    }), {
      status: 'terminal',
      outcome: {
        status: 'completed',
        result: {
          tripId: 'trip-1',
          summary: '成都市区 3 天',
          reviewNotes: ['建议优化：第 1 天偏满'],
          dataSources: ['amap'],
          warnings: [{ severity: 'soft', code: 'overpacked', dayIndex: 1, message: '几乎排满' }],
        },
      },
    });
  });

  it('done 缺摘要字段时补空数组，不丢 tripId', () => {
    assert.deepEqual(taskOutcome({ status: 'done', tripId: 'trip-1' }), {
      status: 'terminal',
      outcome: { status: 'completed', result: { tripId: 'trip-1', reviewNotes: [], dataSources: [], warnings: [] } },
    });
  });

  it('cancelled → aborted', () => {
    assert.deepEqual(taskOutcome({ status: 'cancelled', tripId: null }), {
      status: 'terminal',
      outcome: { status: 'aborted' },
    });
  });

  it('error → failed 保留消息，缺省给通用文案', () => {
    assert.deepEqual(taskOutcome({ status: 'error', tripId: null, message: '模型不可用' }), {
      status: 'terminal',
      outcome: { status: 'failed', error: { message: '模型不可用' } },
    });
    assert.deepEqual(taskOutcome({ status: 'error', tripId: null }), {
      status: 'terminal',
      outcome: { status: 'failed', error: { message: '生成失败' } },
    });
  });
});

describe('进程重启后的直播层重建', () => {
  it('按 jobId 重建，归属校验仍生效', () => {
    const id = `resume-${Date.now()}`;
    const run = createLiveRun({ jobId: id, userId: 'user-1', createdAt: 1, provenance: { kind: 'generation' } });
    assert.equal(run.jobId, id);
    assert.equal(getLiveRun(id, 'user-1')?.jobId, id);
    assert.equal(getLiveRun(id, 'user-2'), null, '别人的任务不可见');
  });

  it('终态唯一：重复终态与迟到事件都不再改变状态', () => {
    const run = createLiveRun({ jobId: `terminal-${Date.now()}`, userId: 'user-1', createdAt: 1, provenance: { kind: 'generation' } });
    emitLive(run, { type: 'job_done', tripId: 'saved', usedXhs: false, dataSources: [], reviewNotes: [] });
    const seqAtDone = run.projection.channel.snapshot.seq;
    emitLive(run, { type: 'job_error', message: 'late error' });
    emitLive(run, { type: 'thought', phase: 'inspection', text: 'late writer' });
    assert.equal(run.status, 'done');
    assert.equal(run.tripId, 'saved');
    assert.equal(run.projection.channel.snapshot.seq, seqAtDone, '终态之后的事件不再进投影');
  });
});
describe('调研 checkpoint 序列化', () => {
  it('Map → entries → Map，候选池原样保留', () => {
    const candidate = { id: 'p1', name: '人民公园', category: 'attraction' as const, intro: '', reservation: 'unknown' as const, sourceLinks: [] };
    const checkpoint = serializeResearch({
      summary: '成都市区',
      pool: [candidate],
      locations: new Map([['人民公园', { lat: 30.66, lng: 104.06, adcode: '510100' }]]),
      placeFacts: new Map([['人民公园', { name: '人民公园', category: '自然', source: 'goldset', themes: [], aliases: [] }]]),
      enabledSources: ['amap'],
    });
    assert.deepEqual(new Map(checkpoint.locations).get('人民公园'), { lat: 30.66, lng: 104.06, adcode: '510100' });
    assert.equal(new Map(checkpoint.placeFacts).get('人民公园')?.source, 'goldset');
    assert.equal(checkpoint.pool[0]?.id, 'p1');
    assert.deepEqual(checkpoint.enabledSources, ['amap']);
  });
});
