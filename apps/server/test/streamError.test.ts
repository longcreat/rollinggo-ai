// 详情对话流式错误映射：事件码决定前端如何呈现，不能把并发/额度/故障混成一个「回答中断」。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamErrorPayload } from '@tripweaver/agent/chat/streamError';
import { AgentBusyError } from '@tripweaver/agent/chat/agent/runtime';

test('同一用户的并发回合：busy 码 + 可操作文案', () => {
  const payload = streamErrorPayload(new AgentBusyError(), { timedOut: false, stopped: false });
  assert.equal(payload.code, 'busy');
  assert.match(payload.error, /还在进行中/);
});

test('4xx 业务错保留真实文案，5xx 收敛成可重试提示', () => {
  const quota = Object.assign(new Error('今日对话次数已用完'), { statusCode: 429 });
  assert.deepEqual(streamErrorPayload(quota, { timedOut: false, stopped: false }),
    { code: 'chat_failed', error: '今日对话次数已用完' });
  const upstream = Object.assign(new Error('upstream secret detail'), { statusCode: 502 });
  assert.deepEqual(streamErrorPayload(upstream, { timedOut: false, stopped: false }),
    { code: 'chat_failed', error: '回答中断，请重试' });
});

test('超时与用户停止优先于业务码', () => {
  const busy = new AgentBusyError();
  assert.deepEqual(streamErrorPayload(busy, { timedOut: true, stopped: false }),
    { code: 'timeout', error: '处理超时，原行程未改动，请重试或缩小范围' });
  assert.deepEqual(streamErrorPayload(busy, { timedOut: false, stopped: true }),
    { code: 'stopped', error: '已停止' });
});

test('非 Error 值不泄露内部结构', () => {
  assert.deepEqual(streamErrorPayload('boom', { timedOut: false, stopped: false }),
    { code: 'chat_failed', error: '回答中断，请重试' });
});
