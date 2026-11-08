// 子代理（官方前台模型）：工具调用任务拥有的子会话、只读工具白名单、结果回传主代理。
// 用 faux provider 驱动，不碰网络与数据库（SQLite 在临时目录）。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { defineTool } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import { closeAgentRuntime, getAgentRuntime, runAgentTurn, type AgentStreamEvent } from '../chat/agent/runtime';
import { createSubagentTool, resetSubagentCache } from '../chat/agent/subagent';

const directories: string[] = [];
const paths: string[] = [];

async function storage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tripweaver-subagent-'));
  directories.push(dir);
  const path = join(dir, 'runs.sqlite');
  paths.push(path);
  return path;
}

after(async () => {
  for (const path of paths) await closeAgentRuntime(path).catch(() => {});
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
});

function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

/** 只读工具的替身：子代理白名单里只放它 */
const readTool = defineTool({
  name: 'get_trip',
  description: '读行程',
  parameters: obj({}),
  execute: async () => ({ output: [{ type: 'text' as const, text: '{"days":2}' }] }),
});
const writeTool = defineTool({
  name: 'update_trip',
  description: '改行程',
  parameters: obj({}),
  execute: async () => ({ output: [{ type: 'text' as const, text: '{"ok":true}' }] }),
});

/** 父会话里所有非空子会话（工具调用任务拥有的子代理会话）。 */
async function childConversations(path: string, parentId: string) {
  const runtime = await getAgentRuntime(path);
  const root = await runtime.harness.root(BACKGROUND_CONTEXT);
  const page = await root.commit((tx) => tx.scanConversations({}, 50), BACKGROUND_CONTEXT);
  const children = [];
  for (const record of page.items) {
    if (String(record.id) === parentId) continue;
    const conversation = await runtime.harness.conversation(record.id, BACKGROUND_CONTEXT);
    const entries = await conversation?.entries({ order: 'ascending' }, 20, undefined, BACKGROUND_CONTEXT);
    if (entries?.items.length) children.push({ id: String(record.id), conversation: conversation!, entries: entries.items });
  }
  return children;
}

/** 主代理收到最近一次 spawn_subagents 的工具结果。 */
async function lastSubagentPayload(path: string, parentId: string) {
  const runtime = await getAgentRuntime(path);
  const conversation = await runtime.harness.conversation(parentId as never, BACKGROUND_CONTEXT);
  const entries = await conversation!.entries({ order: 'ascending' }, 50, undefined, BACKGROUND_CONTEXT);
  const results = entries.items.filter((entry) => entry.kind === 'pi.tool-result');
  const content = results.at(-1)?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined;
  const text = content?.content?.find((block) => block.type === 'text')?.text ?? '';
  return JSON.parse(text) as { results: { id: string; ok: boolean; kind: string; text: string; data?: { kind: string; places: { name: string; lat: number; lng: number }[] } }[] };
}

it('主代理派发 → 子代理在任务拥有的子会话里回答 → 主代理收尾，且只看到只读白名单', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('spawn_subagents', { tasks: [{ id: 'day1', prompt: '调研第 1 天的人民公园' }] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('人民公园：09:00-22:00，东门施工走南门'),
    fauxAssistantMessage('主代理最终答案：已确认人民公园开放时间'),
  ]);

  const events: AgentStreamEvent[] = [];
  const result = await runAgentTurn({
    storagePath: path, models, tools: [readTool, writeTool], instructions: '主代理',
    model: { provider: 'faux', modelId: 'faux-1' }, prompt: '帮我确认第 1 天的人民公园', maxTurns: 5,
    subagent: { instructions: '子代理', childTools: ['get_trip'], maxTurns: 3, maxTasks: 2 },
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.text, '主代理最终答案：已确认人民公园开放时间');
  assert.deepEqual(result.toolCalls, ['spawn_subagents']);

  const payload = await lastSubagentPayload(path, String(result.conversationId));
  assert.deepEqual(payload.results.map((item) => [item.id, item.ok]), [['day1', true]]);
  assert.match(payload.results[0]!.text, /人民公园/);

  const children = await childConversations(path, String(result.conversationId));
  assert.equal(children.length, 1, '工具调用应当创建一个子会话');
  const agent = await children[0]!.conversation.agent(BACKGROUND_CONTEXT);
  assert.deepEqual(agent.tools.map((item) => item.name), ['get_trip'], '子代理只能看到白名单里的只读工具');

  // 官方模型：子会话由工具调用任务拥有，转录里能看到子代理自己的输入与回答。
  const childKinds = children[0]!.entries.map((entry) => entry.kind);
  assert.ok(childKinds.includes('pi.user'));
  assert.ok(childKinds.includes('pi.assistant'));
});

it('同一父会话 + 同一槽位复用子会话，不重复创建', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('spawn_subagents', { tasks: [{ id: 'day1', prompt: '第一次调研' }] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('第一次'),
    fauxAssistantMessage('主代理一'),
    fauxAssistantMessage([fauxToolCall('spawn_subagents', { tasks: [{ id: 'day1', prompt: '再补充一点' }] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('第二次'),
    fauxAssistantMessage('主代理二'),
  ]);

  const first = await runAgentTurn({
    storagePath: path, models, tools: [readTool], instructions: '主代理',
    model: { provider: 'faux', modelId: 'faux-1' }, prompt: '调研', maxTurns: 5,
    subagent: { instructions: '子代理', childTools: ['get_trip'], maxTurns: 3, maxTasks: 2 },
  });
  const second = await runAgentTurn({
    storagePath: path, models, tools: [readTool], instructions: '主代理',
    model: { provider: 'faux', modelId: 'faux-1' }, prompt: '再调研', maxTurns: 5,
    conversationId: first.conversationId,
    subagent: { instructions: '子代理', childTools: ['get_trip'], maxTurns: 3, maxTasks: 2 },
  });
  assert.equal(second.text, '主代理二');
  const payload = await lastSubagentPayload(path, String(second.conversationId));
  assert.equal(payload.results[0]!.text, '第二次');
  const children = await childConversations(path, String(second.conversationId));
  assert.equal(children.length, 1, '同一槽位复用同一个子会话，避免 SQLite 无限增长');
});

it('超过 maxTasks 的任务被截断', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('spawn_subagents', { tasks: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('只有一个结果'),
    fauxAssistantMessage('主代理收尾'),
  ]);
  const result = await runAgentTurn({
    storagePath: path, models, tools: [readTool], instructions: '主代理',
    model: { provider: 'faux', modelId: 'faux-1' }, prompt: '调研', maxTurns: 5,
    subagent: { instructions: '子代理', childTools: ['get_trip'], maxTurns: 3, maxTasks: 1 },
  });
  const payload = await lastSubagentPayload(path, String(result.conversationId));
  assert.equal(payload.results.length, 1);
});

it('kind=places：子代理输出约定 JSON，服务端校验后变成结构化地点并回写点位缓存', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  const captured: { name: string; lat: number; lng: number }[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('spawn_subagents', { tasks: [{ id: 'day2', kind: 'places', prompt: '第 2 天四川博物院附近午饭' }] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage(JSON.stringify({
      places: [{ name: '陈麻婆豆腐(旗舰店)', lat: 30.6648, lng: 104.0332, category: '美食', rating: '4.7', cost: 71, openTime: '11:00-21:00' }],
    })),
    fauxAssistantMessage('主代理收尾'),
  ]);
  const result = await runAgentTurn({
    storagePath: path, models, tools: [readTool], instructions: '主代理',
    model: { provider: 'faux', modelId: 'faux-1' }, prompt: '调研', maxTurns: 5,
    subagent: {
      instructions: '子代理', childTools: ['get_trip'], maxTurns: 3, maxTasks: 2,
      onPlaces: (places) => { captured.push(...places.map((place) => ({ name: place.name, lat: place.lat, lng: place.lng }))); },
    },
  });

  const payload = await lastSubagentPayload(path, String(result.conversationId));
  const place = payload.results[0]!;
  assert.equal(place.kind, 'places');
  assert.equal(place.data?.kind, 'places');
  assert.equal(place.data?.places[0]?.name, '陈麻婆豆腐(旗舰店)');
  assert.deepEqual([place.data?.places[0]?.lat, place.data?.places[0]?.lng], [30.6648, 104.0332]);
  assert.deepEqual(captured, [{ name: '陈麻婆豆腐(旗舰店)', lat: 30.6648, lng: 104.0332 }], '坐标要回写给主代理的点位缓存');
});

it('坐标非法或缺失的地点被丢弃；没有可解析内容时回退为文本', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  const captured: string[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('spawn_subagents', {
      tasks: [
        { id: 'a', kind: 'places', prompt: 'A' },
        { id: 'b', kind: 'notes', prompt: 'B' },
      ],
    })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('```json\n{"places":[{"name":"乱填的","lat":0,"lng":0},{"name":"正常的","lat":30.66,"lng":104.06}]}\n```'),
    fauxAssistantMessage('没有 JSON，只是一段话'),
    fauxAssistantMessage('主代理收尾'),
  ]);
  const result = await runAgentTurn({
    storagePath: path, models, tools: [readTool], instructions: '主代理',
    model: { provider: 'faux', modelId: 'faux-1' }, prompt: '调研', maxTurns: 5,
    subagent: {
      instructions: '子代理', childTools: ['get_trip'], maxTurns: 3, maxTasks: 2,
      onPlaces: (places) => { captured.push(...places.map((place) => place.name)); },
    },
  });

  const payload = await lastSubagentPayload(path, String(result.conversationId));
  const byId = new Map(payload.results.map((item) => [item.id, item]));
  assert.deepEqual(byId.get('a')?.data?.places.map((place) => place.name), ['正常的']);
  assert.equal(byId.get('b')?.data, undefined);
  assert.match(byId.get('b')!.text, /一段话/);
  assert.deepEqual(captured, ['正常的']);
});

it('子代理配置里出现写工具时在构造期直接拒绝', () => {
  assert.throws(() => createSubagentTool({
    harness: {} as never, context: BACKGROUND_CONTEXT, parentId: 'parent',
    model: { provider: 'faux', modelId: 'faux-1' }, instructions: '子代理',
    childTools: [readTool, writeTool], maxTurns: 3, maxTasks: 2,
  }), /只读工具/);
});
