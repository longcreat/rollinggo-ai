import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanningBriefData } from '@rollinggo-trip/shared';
import { delegateGeneration, type DelegateStore } from '@rollinggo-trip/agent/chat/agent/delegate';
import type { GenerationTaskInput } from '@rollinggo-trip/agent/generation/generationTask';
import type { GenerationTaskView } from '@rollinggo-trip/agent/generation/taskStore';

const brief: PlanningBriefData = {
  destination: '成都',
  days: 2,
  startDate: '2026-11-20',
  partySize: 2,
  pace: 'moderate',
  constraints: [],
};

function fakeStore(overrides: Partial<DelegateStore> = {}) {
  const calls: string[] = [];
  const store: DelegateStore = {
    beginGenerationTask: async () => { calls.push('begin'); },
    finalizeGenerationTask: async (_ref, status) => { calls.push(`finalize:${status}`); },
    findActiveRunningTask: async () => null,
    getTaskByRequestId: async () => null,
    setGenerationDurableTaskId: async () => { calls.push('durable'); },
    ...overrides,
  };
  return { store, calls };
}

test('缺出行条件时拒绝委派，不建任务', async () => {
  const { store, calls } = fakeStore();
  let created = 0;
  const result = await delegateGeneration({
    userId: 'delegate-missing', conversationId: 'c1', brief: { destination: '成都', constraints: [] },
    onRunning: 'error', createTask: async () => { created += 1; },
  }, store);
  assert.match(result.error ?? '', /生成还缺少/);
  assert.equal(created, 0);
  assert.deepEqual(calls, []);
});

test('创建任务失败：返回错误并把任务行标 error', async () => {
  const { store, calls } = fakeStore();
  const userId = `delegate-fail-${Date.now()}`;
  const result = await delegateGeneration({
    userId, conversationId: 'c1', brief, onRunning: 'error',
    createTask: async () => { throw new Error('boom'); },
  }, store);
  assert.equal(result.error, 'boom');
  assert.deepEqual(calls, ['begin', 'finalize:error']);
});

test('已有任务在跑：工具模式报错，表单模式复用该任务', async () => {
  const existing: GenerationTaskView = {
    jobId: 'job-running', status: 'running', tripId: null, createdAt: Date.now(),
  };
  const { store } = fakeStore({ findActiveRunningTask: async () => existing });
  let created = 0;
  const error = await delegateGeneration({
    userId: 'delegate-running', conversationId: 'c1', brief, onRunning: 'error',
    createTask: async () => { created += 1; },
  }, store);
  assert.match(error.error ?? '', /已有一份行程正在生成/);
  assert.equal(created, 0);

  const adopted = await delegateGeneration({
    userId: 'delegate-running', conversationId: 'c1', brief, onRunning: 'adopt',
    createTask: async () => { created += 1; },
  }, store);
  assert.equal(adopted.jobId, 'job-running');
  assert.equal(created, 0);
});

test('有当前行程时委派修订：provenance 带 revision 与 targetTripId，并写回 durable id', async () => {
  const { store, calls } = fakeStore();
  let seen: GenerationTaskInput | undefined;
  const result = await delegateGeneration({
    userId: 'delegate-rev', conversationId: 'c1', brief, targetTripId: 'trip-current',
    onRunning: 'error', createTask: async (input) => { seen = input; return 'durable-1' as never; },
  }, store);
  assert.ok(result.jobId);
  assert.equal(seen?.provenance.kind, 'revision');
  assert.equal(seen?.provenance.targetTripId, 'trip-current');
  assert.equal(seen?.jobId, result.jobId);
  assert.equal(typeof seen?.createdAt, 'number');
  assert.deepEqual(calls, ['begin', 'durable']);
});

test('同一 requestId 命中已有任务：直接返回，不重复创建', async () => {
  const existing: GenerationTaskView = {
    jobId: 'job-existing', status: 'running', tripId: null, createdAt: 1,
  };
  const { store, calls } = fakeStore({ getTaskByRequestId: async () => existing });
  let created = 0;
  const result = await delegateGeneration({
    userId: 'delegate-idem', conversationId: 'c1', brief, requestId: 'req-1',
    onRunning: 'error', createTask: async () => { created += 1; },
  }, store);
  assert.equal(result.jobId, 'job-existing');
  assert.equal(created, 0);
  assert.deepEqual(calls, []);
});
