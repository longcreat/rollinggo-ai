import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Value } from '@sinclair/typebox/value';
import { ChatAttachmentSchema, DetailChatRequestSchema, makeSampleTrip } from '@tripweaver/shared';
import { completeFollowUpSuggestions, generateFollowUpSuggestions, readFollowUpSuggestions } from '../chat/followUpSuggestions';

const boarding = { label: '了解上船地点', text: '去鼓浪屿前怎样确定出发码头与上船流程？', kind: 'follow_up' };
const ferry = { label: '了解返程轮渡', text: '从鼓浪屿回厦门时如何安排返程轮渡？', kind: 'follow_up' };

test('不足两条时按最新回答补足；保留三条有效建议，不从寒暄或旧问题生成菜单', () => {
  const input = { trip: makeSampleTrip(), question: '推荐附近美食', answer: '当然可以！从鼓浪屿返程需提前查看轮渡运营信息。' };
  const fallback = completeFollowUpSuggestions([], input);
  assert.equal(fallback.length, 2);
  assert.ok(fallback.every((item) => item.text.includes('轮渡') && !item.text.includes('当然可以') && item.kind === 'follow_up'));
  const three = [ferry, boarding, { label: '轮渡注意事项', text: '从鼓浪屿返程乘轮渡有哪些注意事项？', kind: 'follow_up' }];
  assert.deepEqual(completeFollowUpSuggestions(three, input), three);
  const one = completeFollowUpSuggestions([ferry], input);
  assert.deepEqual(one[0], ferry); assert.equal(one.length, 2);
});

test('附件兼容旧建议，结构化建议限制文案与能力，过滤重复和已问过的问题', () => {
  const attachment = { tripId: 'trip', summary: [], candidates: [], suggestions: ['food', ferry] };
  assert.ok(Value.Check(ChatAttachmentSchema, attachment));
  assert.ok(Value.Check(DetailChatRequestSchema, { requestId: 'follow-up-test', tripId: 'trip', updatedAt: 1, text: ferry.text, suggestion: 'follow_up' }));
  assert.deepEqual(readFollowUpSuggestions([
    ferry, { ...ferry, label: '另一个标题' }, { ...ferry, text: '另一个问题' },
    { ...ferry, kind: 'modify_itinerary' }, { ...ferry, label: ' ' },
    { ...ferry, text: '长'.repeat(301) }, { ...ferry, text: '当前问题' },
    { label: '  上船地点  ', text: '  从厦门哪个码头前往鼓浪屿？  ', kind: 'follow_up' },
  ], '当前问题'), [ferry, { label: '上船地点', text: '从厦门哪个码头前往鼓浪屿？', kind: 'follow_up' }]);
  assert.equal(Value.Check(ChatAttachmentSchema, { ...attachment, suggestions: [{ ...ferry, kind: 'delete' }] }), false);
  assert.deepEqual(readFollowUpSuggestions(null, ''), []);
});

test('真实 runner 将本轮完整回答、日期和候选交给建议工具；只提交一次，不足与异常补足两条，取消继续上抛', async (t) => {
  const requests: Array<{ messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }> }> = [];
  let suggestions: unknown = [ferry, boarding];
  let mode: 'tool' | 'plain' | 'error' | 'hang' = 'tool';
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    if (mode === 'hang') return;
    if (mode === 'error') { res.writeHead(400); res.end('{"error":{"message":"invalid request"}}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = mode === 'plain' ? { content: '不调用工具的正文不能当建议' }
      : { tool_calls: [{ index: 0, id: 'suggestion-call', type: 'function', function: { name: 'suggest_follow_ups', arguments: JSON.stringify({ suggestions }) } }] };
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: mode === 'plain' ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const input = {
    cfg: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'fixture', model: 'fixture', byok: false },
    trip: makeSampleTrip(), question: '怎么去鼓浪屿？', answer: '去鼓浪屿需要乘轮渡，请提前查询运营方公布的班次。',
    candidates: [], signal: new AbortController().signal,
  };
  input.trip.destination = '厦门';
  const dayId = input.trip.days[0]!.id;
  try {
    assert.deepEqual(await generateFollowUpSuggestions({ ...input, dayId }), [ferry, boarding]);
    assert.equal(requests.length, 1, '工具提交即结束，不另发模型续轮');
    const content = requests[0]!.messages.find((message) => message.role === 'user')!.content;
    const context = JSON.parse(typeof content === 'string' ? content : content.map((part) => part.text).join(''));
    assert.equal(context.answer, input.answer);
    assert.equal(context.question, input.question);
    assert.equal(context.scope, '第 1 天');
    assert.equal(context.trip.days.length, 1);
    assert.deepEqual(context.candidates, []);

    const pacing = { label: '了解连续步行距离', text: '第 1 天哪些景点之间的连续步行较多？', kind: 'pace' };
    const pacingInput = { ...input, answer: '第 1 天连续步行较多，可适当安排休息。' };
    suggestions = [pacing, { ...pacing }];
    const supplemented = await generateFollowUpSuggestions(pacingInput);
    assert.equal(supplemented.length, 2);
    assert.deepEqual(supplemented[0], pacing);
    assert.match(supplemented[1]!.text, /连续步行/);
    const fallback = completeFollowUpSuggestions([], input);
    suggestions = [{ ...ferry, kind: 'delete' }];
    assert.deepEqual(await generateFollowUpSuggestions(input), fallback);
    mode = 'plain'; assert.deepEqual(await generateFollowUpSuggestions(input), fallback);
    mode = 'error'; assert.deepEqual(await generateFollowUpSuggestions(input), fallback);

    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', () => timeout(50));
    mode = 'hang'; assert.deepEqual(await generateFollowUpSuggestions(input), fallback);
    const controller = new AbortController();
    const pending = generateFollowUpSuggestions({ ...input, signal: controller.signal });
    controller.abort(new Error('用户已停止'));
    await assert.rejects(pending, /用户已停止/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
