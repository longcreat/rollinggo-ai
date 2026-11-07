// 子代理：真实创建 durable 子会话、只读工具白名单、结果回传主代理。
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

/** 只读工具的替身：子代理白名单里只放它和 update_trip 之外的东西 */
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

type Result = { output: { type: string; text: string }[] };
const run = (tool: { execute: (...args: never[]) => Promise<unknown> }, args: unknown) =>
  (tool.execute as unknown as (input: unknown) => Promise<Result>)(args);

it('子代理在独立会话里跑完并把结论回传，且只看到白名单工具', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  const runtime = await getAgentRuntime(path);
  runtime.holder.current = models;

  const parent = await runtime.harness.createConversation({
    ownership: { kind: 'ownerless' },
    agent: { instructions: '主代理', model: { provider: 'faux', modelId: 'faux-1' }, maxTurns: 3 },
  }, BACKGROUND_CONTEXT);
  runtime.registry.install({ name: 'trip-tools', tools: [readTool, writeTool] } as never);

  let childId: string | undefined;
  const tool = createSubagentTool({
    harness: runtime.harness,
    context: BACKGROUND_CONTEXT,
    parentId: String(parent.id),
    model: { provider: 'faux', modelId: 'faux-1' },
    instructions: '你是只读探索子代理',
    // 只给只读工具：写工具不在白名单里
    childTools: [readTool],
    maxTurns: 3,
    maxTasks: 2,
    onChildCreated: (id) => { childId = String(id); },
  });

  faux.setResponses([fauxAssistantMessage('人民公园：09:00-22:00，东门施工走南门')]);

  const payload = JSON.parse((await run(tool, { tasks: [{ id: 'day1', prompt: '调研第 1 天的人民公园' }] })).output[0]!.text) as {
    results: { id: string; ok: boolean; text: string }[];
  };
  assert.equal(payload.results.length, 1);
  assert.deepEqual([payload.results[0]!.id, payload.results[0]!.ok], ['day1', true]);
  assert.match(payload.results[0]!.text, /人民公园/);

  assert.ok(childId, '应当创建一个子会话');
  const child = await runtime.harness.conversation(childId as never, BACKGROUND_CONTEXT);
  const agent = await child!.agent(BACKGROUND_CONTEXT);
  assert.deepEqual(agent.tools.map((item) => item.name), ['get_trip'], '子代理只能看到白名单里的只读工具');
});

it('同一父会话 + 同一槽位复用子会话，不重复创建', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  const runtime = await getAgentRuntime(path);
  runtime.holder.current = models;

  const parent = await runtime.harness.createConversation({
    ownership: { kind: 'ownerless' },
    agent: { instructions: '主代理', model: { provider: 'faux', modelId: 'faux-1' }, maxTurns: 3 },
  }, BACKGROUND_CONTEXT);
  runtime.registry.install({ name: 'trip-tools', tools: [readTool] } as never);

  const created: string[] = [];
  const tool = createSubagentTool({
    harness: runtime.harness, context: BACKGROUND_CONTEXT, parentId: String(parent.id),
    model: { provider: 'faux', modelId: 'faux-1' }, instructions: '子代理',
    childTools: [readTool], maxTurns: 2, maxTasks: 2,
    onChildCreated: (id) => created.push(String(id)),
  });

  faux.setResponses([fauxAssistantMessage('第一次'), fauxAssistantMessage('第二次')]);
  await run(tool, { tasks: [{ id: 'day1', prompt: '第一次调研' }] });
  const second = JSON.parse((await run(tool, { tasks: [{ id: 'day1', prompt: '再补充一点' }] })).output[0]!.text) as {
    results: { text: string }[];
  };
  assert.equal(second.results[0]!.text, '第二次');
  assert.equal(created.length, 1, '同一槽位复用同一个子会话，避免 SQLite 无限增长');
});

it('超过 maxTasks 的任务被截断', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  const runtime = await getAgentRuntime(path);
  runtime.holder.current = models;
  const parent = await runtime.harness.createConversation({
    ownership: { kind: 'ownerless' },
    agent: { instructions: '主代理', model: { provider: 'faux', modelId: 'faux-1' }, maxTurns: 3 },
  }, BACKGROUND_CONTEXT);
  runtime.registry.install({ name: 'trip-tools', tools: [readTool] } as never);

  const tool = createSubagentTool({
    harness: runtime.harness, context: BACKGROUND_CONTEXT, parentId: String(parent.id),
    model: { provider: 'faux', modelId: 'faux-1' }, instructions: '子代理',
    childTools: [readTool], maxTurns: 2, maxTasks: 1,
  });
  faux.setResponses([fauxAssistantMessage('只有一个结果')]);
  const payload = JSON.parse((await run(tool, {
    tasks: [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }],
  })).output[0]!.text) as { results: unknown[] };
  assert.equal(payload.results.length, 1);
});

it('runtime 装配：主代理派发 → 子代理回答 → 主代理收尾', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('spawn_subagents', { tasks: [{ id: 'day1', prompt: '调研第 1 天的人民公园' }] })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('子代理结论：人民公园 09:00-22:00，东门施工走南门'),
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
  assert.ok(events.some((event) => event.type === 'tool_start' && event.name === 'spawn_subagents'), '主代理应当调用派发工具');
});

it('kind=places：子代理输出约定 JSON，服务端校验后变成结构化地点并回写点位缓存', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  const runtime = await getAgentRuntime(path);
  runtime.holder.current = models;

  const parent = await runtime.harness.createConversation({
    ownership: { kind: 'ownerless' },
    agent: { instructions: '主代理', model: { provider: 'faux', modelId: 'faux-1' }, maxTurns: 3 },
  }, BACKGROUND_CONTEXT);
  runtime.registry.install({ name: 'trip-tools', tools: [readTool, writeTool] } as never);

  const captured: { name: string; lat: number; lng: number }[] = [];
  const tool = createSubagentTool({
    harness: runtime.harness, context: BACKGROUND_CONTEXT, parentId: String(parent.id),
    model: { provider: 'faux', modelId: 'faux-1' }, instructions: '子代理',
    childTools: [readTool], maxTurns: 3, maxTasks: 2,
    onPlaces: (places) => { captured.push(...places.map((place) => ({ name: place.name, lat: place.lat, lng: place.lng }))); },
  });

  faux.setResponses([fauxAssistantMessage(JSON.stringify({
    places: [{ name: '陈麻婆豆腐(旗舰店)', lat: 30.6648, lng: 104.0332, category: '美食', rating: '4.7', cost: 71, openTime: '11:00-21:00' }],
  }))]);

  const payload = JSON.parse((await run(tool, {
    tasks: [{ id: 'day2', kind: 'places', prompt: '第 2 天四川博物院附近午饭' }],
  })).output[0]!.text) as {
    results: { id: string; ok: boolean; kind: string; data?: { kind: string; places: { name: string; lat: number; lng: number }[] } }[];
  };

  const result = payload.results[0]!;
  assert.equal(result.kind, 'places');
  assert.equal(result.data?.kind, 'places');
  assert.equal(result.data?.places[0]?.name, '陈麻婆豆腐(旗舰店)');
  assert.deepEqual([result.data?.places[0]?.lat, result.data?.places[0]?.lng], [30.6648, 104.0332]);
  assert.deepEqual(captured, [{ name: '陈麻婆豆腐(旗舰店)', lat: 30.6648, lng: 104.0332 }], '坐标要回写给主代理的点位缓存');
});

it('坐标非法或缺失的地点被丢弃；没有可解析内容时回退为文本', async () => {
  resetSubagentCache();
  const path = await storage();
  const { faux, models } = fauxModels();
  const runtime = await getAgentRuntime(path);
  runtime.holder.current = models;
  const parent = await runtime.harness.createConversation({
    ownership: { kind: 'ownerless' },
    agent: { instructions: '主代理', model: { provider: 'faux', modelId: 'faux-1' }, maxTurns: 3 },
  }, BACKGROUND_CONTEXT);
  runtime.registry.install({ name: 'trip-tools', tools: [readTool] } as never);

  const tool = createSubagentTool({
    harness: runtime.harness, context: BACKGROUND_CONTEXT, parentId: String(parent.id),
    model: { provider: 'faux', modelId: 'faux-1' }, instructions: '子代理',
    childTools: [readTool], maxTurns: 3, maxTasks: 2,
  });

  faux.setResponses([
    fauxAssistantMessage('```json\n{"places":[{"name":"乱填的","lat":0,"lng":0},{"name":"正常的","lat":30.66,"lng":104.06}]}\n```'),
    fauxAssistantMessage('没有 JSON，只是一段话'),
  ]);
  const first = JSON.parse((await run(tool, { tasks: [{ id: 'a', kind: 'places', prompt: 'A' }] })).output[0]!.text) as {
    results: { data?: { places: { name: string }[] } }[];
  };
  assert.deepEqual(first.results[0]!.data?.places.map((place) => place.name), ['正常的']);

  const second = JSON.parse((await run(tool, { tasks: [{ id: 'b', kind: 'notes', prompt: 'B' }] })).output[0]!.text) as {
    results: { ok: boolean; text: string; data?: unknown }[];
  };
  assert.equal(second.results[0]!.data, undefined);
  assert.match(second.results[0]!.text, /一段话/);
});

it('子代理配置里出现写工具时在构造期直接拒绝', () => {
  assert.throws(() => createSubagentTool({
    harness: {} as never, context: BACKGROUND_CONTEXT, parentId: 'parent',
    model: { provider: 'faux', modelId: 'faux-1' }, instructions: '子代理',
    childTools: [readTool, writeTool], maxTurns: 3, maxTasks: 2,
  }), /只读工具/);
});
