import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Type } from 'typebox';
import { buildModel } from '../generation/model';
import { runPhaseAgent } from '../generation/agents/runner';
import { defineTool } from '../generation/tools/defineTool';

test('实际SDK请求：V4关闭思考且工具续轮含空reasoning_content，其他模型不注入；提交后无额外请求', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tool = request.messages.some((m: { role: string }) => m.role === 'tool') ? 'submit' : 'lookup';
    const delta = { tool_calls: [{ index: 0, id: `call_${tool}`, type: 'function', function: { name: tool, arguments: '{}' } }] };
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  let submissions = 0;
  try {
    for (const [modelId, optIn, disabled] of [
      ['deepseek-v4-flash', true, true], ['deepseek-v4-pro', true, true],
      ['other-model', true, false], ['deepseek/deepseek-v4-flash', true, false],
      ['deepseek-v4-flash', false, false],
    ] as const) {
      const model = await buildModel({ baseUrl, model: modelId, apiKey: 'test-key', byok: false }, { disableDeepSeekThinking: optIn });
      const before = requests.length;
      const result = await runPhaseAgent({ model, apiKey: 'test-key', systemPrompt: '测试工具提交', userPrompt: '提交',
        signal: AbortSignal.timeout(30000), tools: [defineTool({ name: 'lookup', label: '补查', description: '补查后继续', parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: '候选资料' }], details: {} }) }),
          defineTool({ name: 'submit', label: '提交', description: '提交并结束', parameters: Type.Object({}),
          execute: async () => { submissions++; return { content: [{ type: 'text', text: '已提交' }], details: {}, terminate: true }; } })],
        sink: { onThought() {}, onToolStart() {}, onToolEnd() {}, onUsage() {} },
      });
      assert.equal(result.errorMessage, undefined);
      assert.equal(result.aborted, false);
      assert.equal(requests.length - before, 2);
      assert.deepEqual(requests.at(-1)?.thinking, disabled ? { type: 'disabled' } : undefined);
      const messages = requests.at(-1)?.messages as Array<{ role: string; reasoning_content?: string }>;
      assert.equal(messages.find((m) => m.role === 'assistant')?.reasoning_content, disabled ? '' : undefined);
      assert.equal(requests.at(-1)?.reasoning_effort, undefined);
      assert.equal(model.maxTokens, 32000, '保留工具输出预算，不靠截断减少思考');
    }
    assert.equal(submissions, 5);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
