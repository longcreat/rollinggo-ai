import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { Type } from 'typebox';
import type { Model } from '@earendil-works/pi-ai/compat';
import { runPhaseAgent, type PhaseEventSink } from '../generation/agents/runner';

type Reply = 'text' | 'submit' | 'error';
async function run(t: TestContext, replies: Reply[], options: { completion?: boolean; abort?: boolean; maxTurns?: number } = {}) {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  let submitted = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const reply = replies[requests.length - 1] ?? 'error';
    if (reply === 'error') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid request', type: 'invalid_request_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = reply === 'submit'
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'submit-call', type: 'function', function: { name: 'submit_research', arguments: '{"accepted":true}' } }] }
      : { role: 'assistant', content: '```json\n{"candidates":[{"placeId":"place-a"}]}\n```' };
    for (const part of [
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: reply === 'submit' ? 'tool_calls' : 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]) res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', model: 'test', ...part })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(async () => { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const model: Model<'openai-completions'> = { id: 'test', name: 'test', api: 'openai-completions', provider: 'test',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ['text'], contextWindow: 20000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const sink: PhaseEventSink = { onThought() {}, onToolStart() {}, onToolEnd() {}, onUsage() {},
    onLlmResponse() { if (options.abort) controller.abort(); } };
  const result = await runPhaseAgent({ model, apiKey: 'local-test', signal: controller.signal, sink,
    systemPrompt: '调用工具提交候选', userPrompt: '筛选地点', maxTurns: options.maxTurns,
    tools: [{ name: 'submit_research', label: '提交', description: '提交候选', parameters: Type.Object({ accepted: Type.Boolean() }),
      execute: async () => { submitted = true; return { content: [{ type: 'text', text: '已提交' }], details: {}, terminate: true }; } }],
    ...(options.completion === false ? {} : { completion: { isComplete: () => submitted,
      reminder: '必须通过 submit_research 工具提交，正文 JSON 无效。', errorMessage: '调研未成功提交候选' } }),
  });
  return { requests, result, submitted };
}

test('调研正文 JSON 停机后只提醒一次，保留上下文并通过工具提交', async (t) => {
  const { requests, result, submitted } = await run(t, ['text', 'submit']);
  assert.equal(requests.length, 2);
  assert.equal(submitted, true);
  assert.equal(result.errorMessage, undefined);
  assert.equal(result.tokensIn, 20);
  assert.ok(requests[1]!.messages.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('place-a')));
  assert.ok(JSON.stringify(requests[1]!.messages.at(-1)?.content).includes('正文 JSON 无效'));
});

test('两次都只写正文时明确失败，不自动解析 JSON 或无限追加请求', async (t) => {
  const { requests, result, submitted } = await run(t, ['text', 'text']);
  assert.equal(requests.length, 2);
  assert.equal(submitted, false);
  assert.match(result.errorMessage!, /未成功提交/);
});

test('正常工具提交与无需提交的正文阶段不会追加请求', async (t) => {
  const normal = await run(t, ['submit']);
  assert.equal(normal.requests.length, 1);
  assert.equal(normal.result.errorMessage, undefined);
  const text = await run(t, ['text'], { completion: false });
  assert.equal(text.requests.length, 1);
  assert.equal(text.result.errorMessage, undefined);
});

test('上游错误不触发提交纠正，保留原始错误分类', async (t) => {
  const { requests, result } = await run(t, ['error']);
  assert.equal(requests.length, 1);
  assert.match(result.errorMessage!, /invalid request/);
});

test('取消或达到总轮次上限后不再追加请求', async (t) => {
  const cancelled = await run(t, ['text'], { abort: true });
  assert.equal(cancelled.requests.length, 1);
  assert.equal(cancelled.result.aborted, true);
  const limited = await run(t, ['text'], { maxTurns: 1 });
  assert.equal(limited.requests.length, 1);
  assert.match(limited.result.errorMessage!, /未成功提交/);
});
