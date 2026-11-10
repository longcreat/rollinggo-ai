// HITL 注册表：暂停/回答/超时/取消/校验。纯内存，不连模型。
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { AgentQuestion, PendingQuestionView } from '@tripweaver/shared';
import {
  answerPendingQuestion, cancelPendingQuestions, createHitlSession, pendingQuestion, startHardTimeout,
} from '@tripweaver/agent/chat/agent/humanInLoop';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const question: AgentQuestion = {
  id: 'day', question: '想安排在哪一天？',
  options: [{ label: '第 1 天' }, { label: '第 2 天' }],
};

function session(overrides: Partial<Parameters<typeof createHitlSession>[0]> = {}) {
  let view: PendingQuestionView | undefined;
  let answered: unknown;
  let expired: string | undefined;
  let expiredReason: 'timeout' | 'cancelled' | undefined;
  const hitl = createHitlSession({
    userId: 'u1', conversationId: 'c1', requestId: 'r1', signal: new AbortController().signal,
    onQuestion: (value) => { view = value; },
    onAnswered: (_id, answers) => { answered = answers; },
    onExpired: (id, reason) => { expired = id; expiredReason = reason; },
    ...overrides,
  });
  return { hitl, get view() { return view; }, get answered() { return answered; }, get expired() { return expired; }, get expiredReason() { return expiredReason; } };
}

describe('HITL 问题生命周期', () => {
  it('问题登记后可回答，Promise 在答案回注时 resolve', async () => {
    const state = session();
    const pending = state.hitl.ask([question], 1_000);
    assert.ok(state.view);
    assert.equal(state.view!.questions[0]!.question, '想安排在哪一天？');

    const result = answerPendingQuestion({
      userId: 'u1', conversationId: 'c1', questionId: state.view!.id,
      answers: [{ id: 'day', selected: ['第 2 天'] }],
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(await pending, [{ id: 'day', selected: ['第 2 天'] }]);
    assert.deepEqual(state.answered, [{ id: 'day', selected: ['第 2 天'] }]);
    assert.equal(pendingQuestion('u1', 'c1'), null);
  });

  it('超时 resolve null 并发出 expired；之后回答被拒绝', async () => {
    const state = session();
    const pending = state.hitl.ask([question], 20);
    const view = state.view!;
    assert.equal(await pending, null);
    assert.equal(state.expired, view.id);
    assert.equal(state.expiredReason, 'timeout');
    assert.equal(pendingQuestion('u1', 'c1'), null);
    const late = answerPendingQuestion({
      userId: 'u1', conversationId: 'c1', questionId: view.id,
      answers: [{ id: 'day', selected: ['第 1 天'] }],
    });
    assert.equal(late.ok, false);
  });

  it('取消信号让问题立即结束，不留下 pending', async () => {
    const controller = new AbortController();
    const state = session({ signal: controller.signal });
    const pending = state.hitl.ask([question], 1_000);
    assert.ok(state.hitl.hasPending());
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(state.hitl.hasPending(), false);
    assert.ok(state.expired);
    assert.equal(state.expiredReason, 'cancelled');
  });

  it('同会话已有 pending 时新问题被拒绝', async () => {
    const first = session({ conversationId: 'c-busy' });
    const firstPending = first.hitl.ask([question], 1_000);
    const second = session({ conversationId: 'c-busy' });
    await assert.rejects(second.hitl.ask([question], 1_000), /已有待回答的问题/);
    cancelPendingQuestions('c-busy');
    assert.equal(await firstPending, null);
  });

  it('答案校验：非法选项/数量不匹配不消耗 pending，修正后仍可回答', async () => {
    const state = session({ userId: 'u2', conversationId: 'c2' });
    const pending = state.hitl.ask([
      question,
      { id: 'who', question: '几个人？', options: [{ label: '2 人' }, { label: '3 人' }] },
    ], 1_000);
    const view = state.view!;
    const invalid = answerPendingQuestion({
      userId: 'u2', conversationId: 'c2', questionId: view.id,
      answers: [{ id: 'day', selected: ['不存在'] }, { id: 'who', selected: ['2 人'] }],
    });
    assert.equal(invalid.ok, false);
    assert.ok(state.hitl.hasPending());
    const valid = answerPendingQuestion({
      userId: 'u2', conversationId: 'c2', questionId: view.id,
      answers: [{ id: 'day', selected: ['第 1 天'] }, { id: 'who', selected: [], custom: '带一个小孩' }],
    });
    assert.deepEqual(valid, { ok: true });
    assert.deepEqual(await pending, [
      { id: 'day', selected: ['第 1 天'] },
      { id: 'who', selected: [], custom: '带一个小孩' },
    ]);
  });
});

describe('硬超时闸门（5min 防挂死 × pending HITL）', () => {
  it('有待回答问题时不触发 abort，问题 settle 后下一次检查才触发', async () => {
    const state = session();
    const pending = state.hitl.ask([question], 60_000);
    let fired = 0;
    const gate = startHardTimeout(20, () => state.hitl.hasPending(), () => { fired += 1; });
    try {
      await sleep(90);
      assert.equal(fired, 0, 'pending 问题挂起时砍回合会把已提交的答案变成 502');
      assert.equal(answerPendingQuestion({
        userId: 'u1', conversationId: 'c1', questionId: state.view!.id,
        answers: [{ id: 'day', selected: ['第 2 天'] }],
      }).ok, true);
      await pending;
      await sleep(90);
      assert.equal(fired, 1, '问题 settle 后恢复硬超时判定');
    } finally {
      gate.clear();
      cancelPendingQuestions('c1');
    }
  });

  it('没有 pending 时到点即触发并自动停表', async () => {
    let fired = 0;
    const gate = startHardTimeout(20, () => false, () => { fired += 1; });
    await sleep(90);
    gate.clear();
    await sleep(60);
    assert.equal(fired, 1, '触发后不再重复 abort');
  });

  it('问题跨过 deadline 后 settle，最迟一个轮询周期内触发，而不是再等一整段', async () => {
    const state = session();
    // 问题自身用真实定时器且给足时间，避免被假时钟推进判成超时。
    const pending = state.hitl.ask([question], 3_600_000);
    let fired = 0;
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() });
    try {
      const gate = startHardTimeout(300_000, () => state.hitl.hasPending(), () => { fired += 1; });
      mock.timers.tick(301_000); // 跨过 deadline，但仍 pending → 不触发
      assert.equal(fired, 0, 'pending 问题挂起时不能砍回合');
      assert.equal(answerPendingQuestion({
        userId: 'u1', conversationId: 'c1', questionId: state.view!.id,
        answers: [{ id: 'day', selected: ['第 2 天'] }],
      }).ok, true);
      await pending;
      mock.timers.tick(1_000); // 旧实现要到下一个 5min tick 才触发
      assert.equal(fired, 1, 'settle 后应在一个轮询周期内恢复硬超时判定');
      gate.clear();
    } finally {
      mock.timers.reset();
      cancelPendingQuestions('c1');
    }
  });
});
