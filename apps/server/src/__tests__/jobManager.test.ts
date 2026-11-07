// 任务表与投影：终态唯一、取消来源、断档重订阅。事件环形缓冲已删除，终态只看投影。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelJob,
  completeJob,
  createJob,
  emit,
  failJob,
  getRunningJobId,
  rehydrateJob,
  subscribeProjection,
} from '../generation/jobManager';

test('终态唯一：迟到消息与重复终态都不覆盖结果，也不再进投影', () => {
  const job = createJob('terminal-once');
  completeJob(job, 'saved', [], []);
  const seqAtDone = job.projection.channel.snapshot.seq;

  cancelJob(job);
  failJob(job, 'late error');
  emit(job, { type: 'thought', phase: 'review', text: 'late writer' });

  assert.equal(job.status, 'done');
  assert.equal(job.tripId, 'saved');
  assert.equal(getRunningJobId(job.userId), null);
  assert.equal(job.projection.channel.snapshot.seq, seqAtDone, '终态之后的事件不再进投影');
});

test('cancelJob 的取消来源进入投影控制态', () => {
  const userJob = createJob(`cancel-reason-user-${Date.now()}`);
  cancelJob(userJob);
  assert.deepEqual(userJob.projection.channel.snapshot.state.control, {
    phase: 'idle', status: 'cancelled', jobId: userJob.id, message: 'user',
  });

  const timeoutJob = createJob(`cancel-reason-timeout-${Date.now()}`);
  timeoutJob.cancelReason = 'timeout';
  cancelJob(timeoutJob);
  assert.equal(timeoutJob.projection.channel.snapshot.state.control.message, 'timeout');
});

test('投影随事件同步推进：实时帧、补增量、越界重发快照', () => {
  const job = createJob(`projection-${Date.now()}`);
  emit(job, { type: 'job_start', destination: '成都', days: 2, startDate: '2026-11-10', xhsEnabled: false, dataSources: [] });
  emit(job, { type: 'plan_day', dayIndex: 1, title: '市区', stops: [
    { name: '人民公园', lat: 30.66, lng: 104.06, startTime: '09:00', endTime: '11:00', category: '文化' },
  ] });

  // 实时：从当前水位订阅，初始无补帧，之后收到实时帧
  const seq = job.projection.channel.snapshot.seq;
  const live: string[] = [];
  const subscription = subscribeProjection(job, seq, (frame) => live.push(frame.delta.op));
  assert.deepEqual(subscription.initial, { kind: 'delta', frames: [] });
  emit(job, { type: 'usage', tokensIn: 1, tokensOut: 2, xhsCalls: 0, amapCalls: 0, searchCalls: 0 });
  subscription.unsubscribe();
  assert.deepEqual(live, ['state.updated']);

  // 从 0 订阅：补发全部增量
  const replay = subscribeProjection(job, 0, () => {});
  assert.equal(replay.initial.kind, 'delta');
  replay.unsubscribe();

  // 水位超前 / 越界：整体重发快照，不做猜测
  const ahead = subscribeProjection(job, 999, () => {});
  assert.equal(ahead.initial.kind, 'snapshot');
  ahead.unsubscribe();

  const snapshot = job.projection.channel.snapshot;
  assert.equal(snapshot.state.trip?.destination, '成都');
  assert.equal(snapshot.rows.window[0]?.activities[0]?.name, '人民公园');
});

test('rehydrateJob 按原 id 重建且已存在时复用', () => {
  const id = `rehydrate-${Date.now()}`;
  const job = rehydrateJob(id, 'u1');
  assert.equal(job.id, id);
  assert.equal(rehydrateJob(id, 'u1'), job);
});
