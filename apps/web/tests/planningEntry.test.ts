import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolvePlanningEntry, type PlanningEntry } from '../src/lib/planningEntry';

const stored: PlanningEntry = { conversationId: 'c1', requestId: 'r1', params: 'city=成都&days=3' };

test('已有运行任务时直接接管', () => {
  assert.equal(resolvePlanningEntry({ stored, params: 'city=成都&days=3', runningJobId: 'job-1' }), 'adopt');
});

test('参数一致时复用会话与 requestId', () => {
  assert.equal(resolvePlanningEntry({ stored, params: 'city=成都&days=3', runningJobId: null }), 'resume');
});

test('参数变化或无记录时视为全新提交', () => {
  assert.equal(resolvePlanningEntry({ stored, params: 'city=西安&days=2', runningJobId: null }), 'fresh');
  assert.equal(resolvePlanningEntry({ stored: null, params: 'city=成都&days=3', runningJobId: null }), 'fresh');
});
