// 生成 durable 任务：终态映射（纯函数）与进程重启后的 Job 重建。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createJob, getJob, rehydrateJob } from '../generation/jobManager';
import { taskOutcome } from '../generation/generationTask';
import { serializeResearch } from '../generation/checkpoint';

describe('生成任务终态映射', () => {
  it('done → completed 带 tripId', () => {
    assert.deepEqual(taskOutcome({ status: 'done', tripId: 'trip-1' }), {
      status: 'terminal',
      outcome: { status: 'completed', result: { tripId: 'trip-1' } },
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

describe('进程重启后的 Job 重建', () => {
  it('按原 id 重建，归属校验仍生效', () => {
    const id = `resume-${Date.now()}`;
    const job = rehydrateJob(id, 'user-1', { kind: 'generation' });
    assert.equal(job.id, id);
    assert.equal(getJob(id, 'user-1')?.id, id);
    assert.equal(getJob(id, 'user-2'), null, '别人的任务不可见');
    assert.equal(rehydrateJob(id, 'user-1'), job, '已存在时复用，不覆盖事件');
  });

  it('createJob 生成的 id 与传入的 userId 绑定', () => {
    const job = createJob(`create-${Date.now()}`);
    assert.equal(getJob(job.id, job.userId)?.id, job.id);
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
