import assert from 'node:assert/strict';
import test from 'node:test';
import { cancelJob, completeJob, createJob, emit, failJob, getRunningJobId, subscribe, type StoredEvent } from '../generation/jobManager';

test('终态唯一，迟到的阶段消息和重复终态不覆盖结果，终态重放不保留监听器', () => {
  const job = createJob('terminal-once');
  completeJob(job, 'saved', [], []);
  cancelJob(job);
  failJob(job, 'late error');
  emit(job, { type: 'thought', phase: 'review', text: 'late writer' });
  assert.equal(job.status, 'done');
  assert.equal(job.tripId, 'saved');
  assert.equal(getRunningJobId(job.userId), null);
  assert.equal(job.events.length, 1);
  const replay: StoredEvent[] = [];
  subscribe(job, 0, (event) => replay.push(event));
  assert.equal(replay.length, 1);
  assert.equal(job.listeners.size, 0);
});

test('job manager timestamps events and fixes terminal duration', () => {
  const job = createJob(`timing-user-${Date.now()}`);
  const received: StoredEvent[] = [];
  const unsubscribe = subscribe(job, 0, (event) => received.push(event));

  emit(job, { type: 'thought', phase: 'research', text: 'working' });
  cancelJob(job);
  unsubscribe();

  assert.equal(job.status, 'cancelled');
  assert.equal(received.length, 2);
  assert.equal(typeof received[0]?.event.at, 'number');
  const terminal = received[1]?.event;
  assert.equal(terminal?.type, 'job_cancelled');
  if (terminal?.type !== 'job_cancelled') return;
  assert.equal(typeof terminal.at, 'number');
  assert.ok((terminal.durationMs ?? -1) >= 0);
});

test('cancelJob emits cancel reason (user default, explicit override)', () => {
  const userJob = createJob(`cancel-reason-user-${Date.now()}`);
  const userReceived: StoredEvent[] = [];
  const userUnsubscribe = subscribe(userJob, 0, (event) => userReceived.push(event));
  cancelJob(userJob);
  userUnsubscribe();
  const userTerminal = userReceived.at(-1)?.event;
  assert.equal(userTerminal?.type, 'job_cancelled');
  if (userTerminal?.type !== 'job_cancelled') return;
  assert.equal(userTerminal.reason, 'user');

  const timeoutJob = createJob(`cancel-reason-timeout-${Date.now()}`);
  timeoutJob.cancelReason = 'timeout';
  const timeoutReceived: StoredEvent[] = [];
  const timeoutUnsubscribe = subscribe(timeoutJob, 0, (event) => timeoutReceived.push(event));
  cancelJob(timeoutJob);
  timeoutUnsubscribe();
  const timeoutTerminal = timeoutReceived.at(-1)?.event;
  assert.equal(timeoutTerminal?.type, 'job_cancelled');
  if (timeoutTerminal?.type !== 'job_cancelled') return;
  assert.equal(timeoutTerminal.reason, 'timeout');
});
