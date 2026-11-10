// durable 阶段运行器：工具经 pi-durable 会话执行、terminate 结束、事件进入 sink。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from 'typebox';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import { defineTool } from '@tripweaver/agent/generation/tools/defineTool';
import { runDurablePhaseAgent } from '@tripweaver/agent/generation/agents/durablePhase';
import { buildModel } from '@tripweaver/agent/generation/model';

test('durable 阶段：工具执行、terminate 结束、事件进入 sink', async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    let applied = false;
    const tool = defineTool({
      name: 'update_titles',
      label: '写标题',
      description: '写标题',
      parameters: Type.Object({ title: Type.String() }),
      execute: async () => {
        applied = true;
        return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined, terminate: true };
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('update_titles', { title: '成都三日' })], { stopReason: 'toolUse' }),
    ]);

    const events: string[] = [];
    const llm: number[] = [];
    let usageCalls = 0;
    const result = await runDurablePhaseAgent({
      host: { harness, registry, context: BACKGROUND_CONTEXT },
      phaseKey: 'test',
      modelRef: { provider: 'faux', modelId: 'faux-1' },
      opts: {
        model: await buildModel({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'faux-1', byok: false }),
        apiKey: 'k',
        systemPrompt: '测试',
        tools: [tool],
        userPrompt: '写标题',
        signal: new AbortController().signal,
        sink: {
          onThought() {},
          onToolStart(_id, name) { events.push(`start:${name}`); },
          onToolEnd(_id, name, _label, _summary, isError) { events.push(`end:${name}:${isError}`); },
          onUsage() { usageCalls += 1; },
          onLlmResponse(info) { llm.push(info.turn); },
        },
        maxTurns: 3,
      },
    });

    assert.equal(applied, true);
    assert.deepEqual(events, ['start:update_titles', 'end:update_titles:false']);
    assert.ok(llm.length >= 1, '评测依赖 llm_response 计数');
    assert.ok(usageCalls >= 1, '投影依赖 usage 事件');
    assert.equal(result.aborted, false);
    assert.equal(result.turnLimitExceeded, false);
    assert.equal(result.errorMessage, undefined);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
});
async function completionRun(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  try {
    let submitted = false;
    const submit = defineTool({
      name: 'submit_research', label: '提交', description: '提交', parameters: Type.Object({}),
      execute: async () => {
        submitted = true;
        return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined, terminate: true };
      },
    });
    faux.setResponses(responses);
    const result = await runDurablePhaseAgent({
      host: { harness, registry, context: BACKGROUND_CONTEXT },
      phaseKey: 'completion', modelRef: { provider: 'faux', modelId: 'faux-1' },
      opts: {
        model: await buildModel({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'faux-1', byok: false }),
        apiKey: 'k', systemPrompt: 's', tools: [submit], userPrompt: 'p',
        signal: new AbortController().signal, maxTurns: 4,
        sink: { onThought() {}, onToolStart() {}, onToolEnd() {}, onUsage() {} },
        completion: { isComplete: () => submitted, reminder: '请提交', errorMessage: '未提交' },
      },
    });
    return { result, submitted };
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

test('未提交时提醒一次，工具提交后完成', async () => {
  const { result, submitted } = await completionRun([
    fauxAssistantMessage('正文 JSON 不算提交'),
    fauxAssistantMessage([fauxToolCall('submit_research', {})], { stopReason: 'toolUse' }),
  ]);
  assert.equal(submitted, true);
  assert.equal(result.errorMessage, undefined);
});

test('始终不提交 → 如实报告 completion 错误', async () => {
  const { result, submitted } = await completionRun([
    fauxAssistantMessage('只有正文'),
    fauxAssistantMessage('仍然只有正文'),
  ]);
  assert.equal(submitted, false);
  assert.equal(result.errorMessage, '未提交');
});
