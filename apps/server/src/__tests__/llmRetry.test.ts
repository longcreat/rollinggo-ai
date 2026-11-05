// 单测：上游瞬时故障重试（streamWithRetry）——只重试「换一次请求就可能成功」的错误，
// 已产出工具调用增量不重试（防重复执行有副作用的工具），重试耗尽的错误仍按原路径透出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from '@earendil-works/pi-ai/compat';
import { isRetryableUpstreamError, streamWithRetry, summarizeUpstreamError } from '../generation/agents/runner';

const model = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'http://127.0.0.1:1/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<'openai-completions'>;

const context: Context = { systemPrompt: 'sp', messages: [] };

function assistantMessage(errorMessage?: string): AssistantMessage {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: errorMessage ? '' : 'done' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: errorMessage ? ('error' as const) : ('stop' as const),
    errorMessage,
    timestamp: Date.now(),
  };
}

/** 假上游：把事件同步压进流里 */
function fakeStream(push: (stream: AssistantMessageEventStream) => void): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  push(stream);
  return stream;
}

function upstreamError(message: string): AssistantMessageEventStream {
  return fakeStream((stream) => {
    const message_ = assistantMessage(message);
    stream.push({ type: 'start', partial: message_ });
    stream.push({ type: 'error', reason: 'error', error: message_ });
  });
}

function upstreamOk(): AssistantMessageEventStream {
  return fakeStream((stream) => {
    const message = assistantMessage();
    stream.push({ type: 'start', partial: message });
    stream.push({ type: 'done', reason: 'stop', message });
  });
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

test('isRetryableUpstreamError：网关「模型不可用」可重试，请求字段错误不可重试', () => {
  assert.equal(isRetryableUpstreamError('400 Error from provider (Console): Upstream request failed: Model is unavailable.'), true);
  assert.equal(isRetryableUpstreamError('429 rate limit exceeded'), true);
  assert.equal(isRetryableUpstreamError('fetch failed'), true);
  assert.equal(isRetryableUpstreamError('terminated'), true);   // undici 响应体被上游提前关闭
  assert.equal(isRetryableUpstreamError('502 Bad Gateway'), true);
  assert.equal(isRetryableUpstreamError('field Messages[3].Role invalid, should be one of: user, assistant'), false);
  assert.equal(isRetryableUpstreamError('No API key for provider: tripweaver-byok'), false);
  assert.equal(isRetryableUpstreamError(''), false);
});

test('HTML 网关错误保留 504 状态，诊断与最终错误不带网页正文', async () => {
  const html = '504 <html lang="en"><head><title>无法连接到服务器</title></head>PRIVATE-PROVIDER-BODY</html>';
  assert.match(summarizeUpstreamError(html), /HTTP 504/);
  assert.ok(!summarizeUpstreamError(html).includes('PRIVATE-PROVIDER-BODY'));
  const stream = streamWithRetry(() => upstreamError(html), model, context, undefined, []);
  await collect(stream);
  const result = await stream.result();
  assert.match(result.errorMessage!, /HTTP 504/);
  assert.ok(!result.errorMessage!.includes('<html'));
});

test('streamWithRetry：上游瞬时故障重试后成功，失败尝试的事件不透出', async () => {
  let calls = 0;
  const call = () => {
    calls += 1;
    return calls === 1 ? upstreamError('Upstream request failed: Model is unavailable.') : upstreamOk();
  };
  const stream = streamWithRetry(call, model, context, undefined, [0]);
  const events = await collect(stream);
  assert.equal(calls, 2);
  assert.deepEqual(
    events.map((e) => e.type),
    ['start', 'done'],
  );
  assert.equal((await stream.result()).stopReason, 'stop');
});

test('streamWithRetry：请求本身不合法（400 字段错误）不重试', async () => {
  let calls = 0;
  const call = () => {
    calls += 1;
    return upstreamError('field Messages[3].Role invalid, should be one of: user, assistant');
  };
  const events = await collect(streamWithRetry(call, model, context, undefined, [0, 0]));
  assert.equal(calls, 1);
  assert.equal(events.at(-1)!.type, 'error');
  assert.equal((await streamResult(events)).errorMessage, 'field Messages[3].Role invalid, should be one of: user, assistant');
});

test('streamWithRetry：已产出工具调用增量的失败不重试（防重复执行有副作用的工具）', async () => {
  let calls = 0;
  const call = () => {
    calls += 1;
    return fakeStream((stream) => {
      const message = assistantMessage('socket hang up');
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
      stream.push({ type: 'error', reason: 'error', error: message });
    });
  };
  const events = await collect(streamWithRetry(call, model, context, undefined, [0]));
  assert.equal(calls, 1);
  assert.deepEqual(
    events.map((e) => e.type),
    ['start', 'toolcall_start', 'error'],
  );
});

test('streamWithRetry：仅思考/正文增量的失败仍重试（长 reasoning 断流不判死整次生成）', async () => {
  let calls = 0;
  const call = () => {
    calls += 1;
    if (calls > 1) return upstreamOk();
    return fakeStream((stream) => {
      const message = assistantMessage('terminated');
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'thinking_delta', contentIndex: 0, delta: '推理中', partial: message });
      stream.push({ type: 'error', reason: 'error', error: message });
    });
  };
  const events = await collect(streamWithRetry(call, model, context, undefined, [0]));
  assert.equal(calls, 2);
  assert.deepEqual(
    events.map((e) => e.type),
    ['start', 'done'],
  );
});

test('streamWithRetry：重试耗尽后透出错误事件并标注重试次数', async () => {
  let calls = 0;
  const call = () => {
    calls += 1;
    return upstreamError('Model is unavailable');
  };
  const events = await collect(streamWithRetry(call, model, context, undefined, [0, 0]));
  assert.equal(calls, 3);
  const last = events.at(-1)!;
  assert.equal(last.type, 'error');
  assert.equal(last.type === 'error' && last.error.errorMessage, 'Model is unavailable（上游已重试 2 次）');
});

test('streamWithRetry：streamSimple 直接抛出时降级为错误事件（不挂死流）', async () => {
  let calls = 0;
  const call = () => {
    calls += 1;
    throw new Error('No API key for provider: tripweaver-site');
  };
  const events = await collect(streamWithRetry(call, model, context, undefined, [0]));
  assert.equal(calls, 1);
  assert.equal(events.at(-1)!.type, 'error');
});

test('streamWithRetry：取消信号中止退避等待且不再重试', async () => {
  const controller = new AbortController();
  let calls = 0;
  const call = () => {
    calls += 1;
    controller.abort();
    return upstreamError('Model is unavailable');
  };
  const events = await collect(streamWithRetry(call, model, context, { signal: controller.signal }, [60_000]));
  assert.equal(calls, 1);
  assert.equal(events.at(-1)!.type, 'error');
});

/** 从事件列表里取终态错误消息（等价于 agent-core 的 response.result()） */
async function streamResult(events: AssistantMessageEvent[]) {
  const last = events.at(-1)!;
  assert.equal(last.type, 'error');
  return last.type === 'error' ? last.error : assistantMessage();
}
