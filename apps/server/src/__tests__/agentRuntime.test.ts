// 行程详情 Agent 运行时：工具循环、事件映射、会话续用。
// 用 faux provider 驱动，不碰网络与数据库。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { Trip } from '@tripweaver/shared';
import { closeAgentRuntime, runAgentTurn, type AgentStreamEvent } from '../chat/agent/runtime';
import { createTripTools } from '../chat/agent/tools';
import type { DetailSources } from '../chat/detailSources';

const directories: string[] = [];
const paths: string[] = [];

async function storage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tripweaver-agent-'));
  directories.push(dir);
  const path = join(dir, 'runs.sqlite');
  paths.push(path);
  return path;
}

after(async () => {
  for (const path of paths) await closeAgentRuntime(path).catch(() => {});
  for (const dir of directories) await rm(dir, { recursive: true, force: true });
});

const trip: Trip = {
  id: 'trip-1',
  title: '成都三日',
  destination: '成都',
  startDate: '2026-11-10',
  budgetLevel: '舒适',
  totalBudget: 0,
  preferences: ['文化'],
  partySize: 2,
  extraNotes: '',
  transportMode: 'transit',
  days: [{
    id: 'day-1', dayIndex: 1, title: '市区漫步',
    activities: [
      { id: 'act-1', name: '人民公园', startTime: '09:00', endTime: '11:00', description: '喝茶', lat: 30.66, lng: 104.06, coordSource: 'geocoded', category: '文化', sourceNotes: [] },
      { id: 'act-2', name: '宽窄巷子', startTime: '14:00', endTime: '16:00', description: '逛街', lat: 30.67, lng: 104.05, coordSource: 'geocoded', category: '文化', sourceNotes: [] },
    ],
  }],
  meta: { usedXhs: false, reviewNotes: [] },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function fakeSources() {
  const calls = { poi: [] as string[], web: [] as string[] };
  const sources = {
    poi: {
      kind: 'null',
      searchPois: async (category: string, keyword: string) => {
        calls.poi.push(`${category}:${keyword}`);
        return [{ name: '陈麻婆豆腐', type: '川菜', address: '青羊区', rating: '4.6', cost: '', opentime: '', photoUrls: [], adcode: '', location: { lat: 30.67, lng: 104.05 } }];
      },
      selfCheck: async () => ({ ok: true }),
    },
    search: {
      kind: 'null',
      search: async (query: string) => {
        calls.web.push(query);
        return [{ title: '人民公园攻略', url: 'https://example.com/a', summary: '早上去人少', siteName: 'example', datePublished: '' }];
      },
      selfCheck: async () => ({ ok: true }),
    },
    notes: new Set<string>(),
    calls: { poi: 0, search: 0 },
    web: [],
    assertHealthy: () => {},
  } as unknown as DetailSources;
  return { sources, calls };
}

function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

describe('agent runtime', () => {
  it('模型自己读行程后回答，工具调用进入事件流', async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('get_trip', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('第 1 天上午在人民公园喝茶，下午去宽窄巷子。'),
    ]);
    const { sources } = fakeSources();
    const events: AgentStreamEvent[] = [];
    const result = await runAgentTurn({
      storagePath: await storage(),
      models,
      tools: createTripTools({ trip, sources, signal: AbortSignal.timeout(30_000) }),
      instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' },
      prompt: '第一天怎么安排？',
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.status, 'done');
    assert.match(result.text, /人民公园/);
    assert.deepEqual(result.toolCalls, ['get_trip']);
    assert.ok(events.some((event) => event.type === 'tool_start' && event.name === 'get_trip'));
    assert.ok(events.some((event) => event.type === 'tool_end'));
    assert.ok(events.some((event) => event.type === 'done'));
  });

  it('搜索类工具把结果交给模型，且不伪造未调用的工具', async () => {
    const { faux, models } = fauxModels();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_places', { keyword: '川菜', category: 'food' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('附近有陈麻婆豆腐，青羊区。'),
    ]);
    const { sources, calls } = fakeSources();
    const result = await runAgentTurn({
      storagePath: await storage(),
      models,
      tools: createTripTools({ trip, sources, signal: AbortSignal.timeout(30_000) }),
      instructions: '测试',
      model: { provider: 'faux', modelId: 'faux-1' },
      prompt: '附近有什么川菜？',
    });

    assert.deepEqual(result.toolCalls, ['search_places']);
    assert.deepEqual(calls.poi, ['food:川菜']);
    assert.match(result.text, /陈麻婆/);
  });

  it('同一会话的第二轮复用 transcript，不重新建会话', async () => {
    const { faux, models } = fauxModels();
    const path = await storage();
    const tools = () => createTripTools({ trip, sources: fakeSources().sources, signal: AbortSignal.timeout(30_000) });

    faux.setResponses([fauxAssistantMessage('第一次回答')]);
    const first = await runAgentTurn({ storagePath: path, models, tools: tools(), instructions: '测试', model: { provider: 'faux', modelId: 'faux-1' }, prompt: '第一问' });

    faux.setResponses([fauxAssistantMessage('第二次回答')]);
    const second = await runAgentTurn({
      storagePath: path, models, tools: tools(), instructions: '测试', model: { provider: 'faux', modelId: 'faux-1' }, prompt: '第二问',
      conversationId: first.conversationId,
    });

    assert.equal(second.conversationId, first.conversationId);
    assert.equal(second.text, '第二次回答');
  });
});