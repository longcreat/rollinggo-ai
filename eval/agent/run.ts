// 详情页 Agent 回归：确定性层（faux 模型，零 token，进 eval:test）+ 真实层（真模型，验证事实覆盖）。
//
//   npm run eval:agent               # 确定性层
//   npm run eval:agent:live          # 真实层（需要 doppler 注入的 SITE_LLM_*）
//   npm run eval:agent:live -- --only facts,day-scope
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { fakeSources, fauxModels, fixtureTrip, gateOf, gatedTool } from './fixtures';
import { AgentBusyError, closeAgentRuntime, runAgentTurn } from '../../apps/server/src/chat/agent/runtime';
import { createTripDraft } from '../../apps/server/src/chat/agent/tripDraft';
import { createTripTools, tripSnapshot, webSearchPayload } from '../../apps/server/src/chat/agent/tools';
import { SUBAGENT_READ_ONLY_TOOL_NAMES, assertSubagentToolNames } from '../../apps/server/src/chat/agent/toolPolicy';

export interface CaseResult { id: string; name: string; ok: boolean; detail: string }

const FAUX_MODEL = { provider: 'faux', modelId: 'faux-1' };

type Recorder = (id: string, name: string, fn: () => Promise<string> | string) => Promise<void>;

function recorder(cases: CaseResult[]): Recorder {
  return async (id, name, fn) => {
    try {
      cases.push({ id, name, ok: true, detail: await fn() });
    } catch (error) {
      cases.push({ id, name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
}

/** 确定性层：不连模型、不连库，只依赖 pi-durable 的本地 SQLite。 */
export async function runDeterministic(): Promise<CaseResult[]> {
  const cases: CaseResult[] = [];
  const record = recorder(cases);
  const dirs: string[] = [];
  const storage = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-agent-'));
    dirs.push(dir);
    return join(dir, 'runs.sqlite');
  };

  try {
    await record('tool-policy', '子代理只读白名单：写/交互/派生工具一律拒绝', () => {
      assert.deepEqual([...SUBAGENT_READ_ONLY_TOOL_NAMES].sort(), ['get_day', 'get_trip', 'get_weather', 'search_places', 'web_search']);
      assert.doesNotThrow(() => assertSubagentToolNames([...SUBAGENT_READ_ONLY_TOOL_NAMES]));
      for (const forbidden of ['add_activity', 'delete_day', 'search_food', 'ask_user', 'update_brief', 'delegate_task', 'task_status', 'spawn_subagents']) {
        assert.throws(() => assertSubagentToolNames(['get_trip', forbidden]), /只读工具/, forbidden);
      }
      return '白名单与拒绝规则符合预期';
    });

    await record('tool-inventory', '主 Agent 全量工具：只读 6 + 交互/委派/状态 5 + 写 9', () => {
      const signal = AbortSignal.timeout(5_000);
      const draft = createTripDraft(fixtureTrip);
      const writable = createTripTools({ trip: fixtureTrip, sources: fakeSources().sources, signal, draft })
        .map((tool) => tool.name).sort();
      assert.deepEqual(writable, [
        'add_activity', 'add_day', 'ask_user', 'delegate_task', 'delete_activity', 'delete_day',
        'get_day', 'get_trip', 'get_weather', 'move_activity', 'reorder_day', 'search_area_places', 'search_food',
        'search_places', 'task_status', 'update_activity', 'update_brief', 'update_day', 'update_trip', 'web_search',
      ]);
      return `${writable.length} 个全量工具`;
    });

    await record('write-draft', '写工具改草稿，读工具立即看到，不落库', async () => {
      const draft = createTripDraft(fixtureTrip);
      const tools = createTripTools({
        trip: fixtureTrip, sources: fakeSources().sources, signal: AbortSignal.timeout(5_000), draft,
        resolvePlace: async () => ({ lat: 31.24, lng: 121.49 }),
      });
      const add = tools.find((tool) => tool.name === 'add_activity')!;
      const result = await (add.execute as unknown as (input: unknown) => Promise<{ output: { text: string }[] }>)({ dayIndex: 1, name: '外滩', category: '自然' });
      const payload = JSON.parse(result.output[0]!.text) as { ok: boolean; summary: string; day: { activities: { located: boolean }[] } };
      assert.equal(payload.ok, true);
      assert.equal(payload.day.activities.at(-1)!.located, true);
      assert.ok(JSON.stringify(tripSnapshot(draft.current())).includes('外滩'), '读工具必须看到草稿里的新增');
      assert.equal(draft.changed(), true);
      assert.equal(JSON.stringify(fixtureTrip).includes('外滩'), false, '草稿不得改动调用方对象');
      return payload.summary;
    });

    await record('no-truncation', '工具输出不截断摘要与条数', () => {
      const longSummary = '预约说明：需提前三天在官方小程序实名预约。'.repeat(60);
      const hits = Array.from({ length: 6 }, (_, i) => ({
        title: `攻略 ${i}`, url: `https://example.com/${i}`, summary: `${longSummary}#${i}`, siteName: 'example', datePublished: '2026-11-01',
      }));
      const payload = webSearchPayload(hits);
      assert.equal(payload.length, 6);
      assert.equal(payload[0]!.summary, hits[0]!.summary);
      return `摘要 ${payload[0]!.summary.length} 字原样保留`;
    });

    await record('snapshot-full', '行程快照不裁剪描述与关键字段', () => {
      const snapshot = tripSnapshot(fixtureTrip);
      const day = snapshot.days[0]!;
      const activity = day.activities[0]!;
      assert.equal(activity.description, fixtureTrip.days[0]!.activities[0]!.description);
      assert.equal(activity.openTime, '06:00-22:00');
      assert.deepEqual(day.legs, [{ from: 'act-1', to: 'act-2', mode: 'walk', durationMin: 18, distanceM: 1200 }]);
      assert.equal(snapshot.lodging?.name, '春熙路某酒店');
      assert.deepEqual(snapshot.preferences, ['文化', '少走路']);
      return `描述 ${activity.description.length} 字 + 通勤段/住宿/偏好齐全`;
    });

    await record('concurrency', '同一用户并发回合立刻 409', async () => {
      const { faux, models } = fauxModels();
      const path = await storage();
      const { gate, release, started, markStarted } = gateOf();
      const signal = AbortSignal.timeout(30_000);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('A 回答'),
      ]);
      const first = runAgentTurn({
        storagePath: path, models, tools: [gatedTool(markStarted, gate, signal)],
        instructions: '测试', model: FAUX_MODEL, prompt: 'A 问',
      });
      await started;
      try {
        await runAgentTurn({ storagePath: path, models, tools: [], instructions: '测试', model: FAUX_MODEL, prompt: 'B 问' });
        assert.fail('并发请求应当被拒绝');
      } catch (error) {
        assert.ok(error instanceof AgentBusyError, '应当是 AgentBusyError');
        assert.equal(error.statusCode, 409);
      }
      release();
      const result = await first;
      assert.equal(result.text, 'A 回答');
      return '第二个请求 409，第一个回合不受影响';
    });

    await record('abort', '停止后中断并释放锁', async () => {
      const { faux, models } = fauxModels();
      const path = await storage();
      const controller = new AbortController();
      const { gate, started, markStarted } = gateOf();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('不该出现'),
      ]);
      const turn = runAgentTurn({
        storagePath: path, models, tools: [gatedTool(markStarted, gate, controller.signal)],
        instructions: '测试', model: FAUX_MODEL, prompt: '长问题', signal: controller.signal,
      });
      await started;
      controller.abort();
      await assert.rejects(turn, (error: unknown) => (error as Error)?.name === 'AbortError');

      faux.setResponses([fauxAssistantMessage('停止后的回答')]);
      const next = await runAgentTurn({ storagePath: path, models, tools: [], instructions: '测试', model: FAUX_MODEL, prompt: '新问题' });
      assert.equal(next.text, '停止后的回答');
      return 'AbortError 后仍可继续提问';
    });
  } finally {
    for (const dir of dirs) {
      await closeAgentRuntime(join(dir, 'runs.sqlite')).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return cases;
}

/** 真实层：真模型 + 真数据源，验证事实覆盖与只读边界（会产生模型/搜索调用）。 */
export async function runLive(only = new Set<string>()): Promise<CaseResult[]> {
  const cases: CaseResult[] = [];
  const record = recorder(cases);
  const dirs: string[] = [];
  const storage = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-agent-live-'));
    dirs.push(dir);
    return join(dir, 'runs.sqlite');
  };

  const { env } = await import('../../apps/server/src/env');
  const { buildAgentModels, agentModelRef } = await import('../../apps/server/src/chat/agent/models');
  const { AmapPoiSource } = await import('../../apps/server/src/integrations/amap/poiSource');
  const { WebSearchSource } = await import('../../apps/server/src/integrations/websearch/searchSource');

  if (!env.siteLlm.baseUrl || !env.siteLlm.apiKey || !env.siteLlm.model) {
    throw new Error('缺少 SITE_LLM_*（用 doppler run 注入）');
  }
  const cfg = { baseUrl: env.siteLlm.baseUrl, apiKey: env.siteLlm.apiKey, model: env.siteLlm.model, byok: false };
  const models = await buildAgentModels(cfg);
  const model = agentModelRef(cfg.model);

  const realSources = () => ({
    poi: new AmapPoiSource(env.amapKey),
    search: new WebSearchSource(env.searchApiBaseUrl, env.searchApiKey),
    notes: new Set<string>(), calls: { poi: 0, search: 0 }, web: [], assertHealthy: () => {},
  }) as never;

  const ask = async (prompt: string) => runAgentTurn({
    storagePath: await storage(), models,
    tools: createTripTools({ trip: fixtureTrip, sources: realSources(), signal: AbortSignal.timeout(120_000), draft: createTripDraft(fixtureTrip) }),
    instructions: '你是行程详情页的旅行助手。先调用工具确认事实再回答，只依据工具结果，不补充自己的知识；中文，不超过 80 字。',
    model, prompt,
  });

  const wanted = (id: string) => only.size === 0 || only.has(id);

  try {
    if (wanted('facts')) {
      await record('facts', '行程事实：调用工具且答对时间地点', async () => {
        const result = await ask('第 1 天上午几点、去哪儿？一句话。');
        assert.equal(result.status, 'done');
        assert.ok(result.toolCalls.some((name) => name === 'get_trip' || name === 'get_day'), `未调用行程工具：${result.toolCalls}`);
        assert.match(result.text, /09:00|9:00|人民公园/, `答案未命中事实：${result.text}`);
        return result.text;
      });
    }

    if (wanted('day-scope')) {
      await record('day-scope', '单日范围：只答第 2 天', async () => {
        const result = await ask('当前范围：第 2 天「博物馆与晚餐」。\n\n用户：这天怎么安排？一句话。');
        assert.equal(result.status, 'done');
        assert.ok(result.toolCalls.includes('get_day') || result.toolCalls.includes('get_trip'), `未调用行程工具：${result.toolCalls}`);
        assert.match(result.text, /四川博物院|10:00/, `未答第 2 天安排：${result.text}`);
        assert.equal(/人民公园/.test(result.text), false, `串到了第 1 天：${result.text}`);
        return result.text;
      });
    }

    if (wanted('places')) {
      await record('places', '地点查询：走 search_places', async () => {
        if (!env.amapKey) return '跳过：未配置 AMAP_KEY';
        const result = await ask('附近有什么川菜馆？一句话。');
        assert.equal(result.status, 'done');
        assert.ok(result.toolCalls.includes('search_places'), `未调用地点工具：${result.toolCalls}`);
        assert.ok(result.text.trim().length > 0);
        return result.text;
      });
    }

    if (wanted('web')) {
      await record('web', '时效查询：走 web_search', async () => {
        if (!env.searchApiKey) return '跳过：未配置 SEARCH_API_KEY';
        const result = await ask('成都最近景区预约有什么新变化？一句话。');
        assert.equal(result.status, 'done');
        assert.ok(result.toolCalls.includes('web_search'), `未调用搜索工具：${result.toolCalls}`);
        assert.ok(result.text.trim().length > 0);
        return result.text;
      });
    }

    if (wanted('read-only')) {
      await record('read-only', '只读边界：给建议不改行程', async () => {
        const before = JSON.stringify(fixtureTrip);
        const result = await ask('把第二天换成博物馆，合适吗？一句话。');
        assert.equal(result.status, 'done');
        assert.ok(result.text.trim().length > 0);
        assert.equal(JSON.stringify(fixtureTrip), before, '行程对象被改动了');
        return result.text;
      });
    }
  } finally {
    for (const dir of dirs) {
      await closeAgentRuntime(join(dir, 'runs.sqlite')).catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return cases;
}

function report(results: CaseResult[]) {
  const width = Math.max(...results.map((result) => result.name.length), 8);
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.id.padEnd(16)} ${result.name.padEnd(width)}  ${result.detail}`);
  }
  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed}/${results.length} 通过${failed ? `，${failed} 项失败` : ''}`);
  return failed;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  const { values } = parseArgs({ options: { only: { type: 'string' }, live: { type: 'boolean', default: false } }, strict: true });
  const only = new Set((values.only ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  const results = values.live ? await runLive(only) : await runDeterministic();
  process.exitCode = report(results) ? 1 : 0;
}
