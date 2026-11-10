// Agent 回归用的固定行程与替身：确定性层（faux 模型）与真实层（真模型）共用。
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { defineTool } from '@earendil-works/pi-durable';
import { obj } from '@earendil-works/pi-schema';
import type { Trip } from '@rollinggo-trip/shared';
import type { DetailSources } from '@rollinggo-trip/integrations/detailSources';

const DESCRIPTION = ('人民公园是成都老牌市民公园，早晨有大量本地人喝茶、打太极。公园内有鹤鸣茶社，可体验盖碗茶。'
  + '东门自 2026 年 11 月起封闭施工，请从南门或西门进入。').repeat(4).slice(0, 500);

export const fixtureTrip: Trip = {
  id: 'eval-trip', title: '成都两日', destination: '成都', startDate: '2026-11-10',
  budgetLevel: '舒适', totalBudget: 3000, preferences: ['文化', '少走路'], partySize: 2,
  extraNotes: '带老人，节奏慢一点', transportMode: 'transit',
  lodging: { name: '春熙路某酒店', area: '锦江区' },
  days: [
    {
      id: 'day-1', dayIndex: 1, title: '市区漫步',
      activities: [
        { id: 'act-1', name: '人民公园', startTime: '09:00', endTime: '11:00', description: DESCRIPTION, lat: 30.66, lng: 104.06, coordSource: 'geocoded', category: '文化', cost: 0, openTime: '06:00-22:00', sourceNotes: [] },
        { id: 'act-2', name: '宽窄巷子', startTime: '14:00', endTime: '16:00', description: '逛街区、看院落。', lat: 30.67, lng: 104.05, coordSource: 'geocoded', category: '文化', cost: 0, sourceNotes: [] },
      ],
      legs: [{ fromActivityId: 'act-1', toActivityId: 'act-2', mode: 'walk', durationMin: 18, distanceM: 1200, source: 'heuristic' }],
    },
    {
      id: 'day-2', dayIndex: 2, title: '博物馆与晚餐',
      activities: [
        { id: 'act-3', name: '四川博物院', startTime: '10:00', endTime: '12:00', description: '常设展免费，需提前预约。', lat: 30.66, lng: 104.03, coordSource: 'geocoded', category: '文化', cost: 0, sourceNotes: [] },
        { id: 'act-4', name: '陈麻婆豆腐', startTime: '18:00', endTime: '19:00', description: '川菜老字号。', lat: 30.67, lng: 104.05, coordSource: 'geocoded', category: '美食', cost: 80, sourceNotes: [] },
      ],
    },
  ],
  meta: { usedXhs: false, reviewNotes: [] }, createdAt: 1, updatedAt: 1,
};

export interface FakeSources {
  sources: DetailSources;
  calls: { poi: string[]; web: string[] };
}

/** 可注入搜索结果/地点结果的替身数据源；默认全空，调用会被记录。 */
export function fakeSources(options: {
  web?: { title: string; url: string; summary: string }[];
  places?: { name: string; type?: string; address?: string; lat?: number; lng?: number }[];
} = {}): FakeSources {
  const calls = { poi: [] as string[], web: [] as string[] };
  const sources = {
    poi: {
      kind: 'null',
      searchPois: async (_category: string, keyword: string) => {
        calls.poi.push(keyword);
        return (options.places ?? []).map((p) => ({
          name: p.name, type: p.type ?? '川菜', address: p.address ?? '', rating: '', cost: '',
          opentime: '', photoUrls: [], adcode: '', location: { lat: p.lat ?? 30.67, lng: p.lng ?? 104.05 },
        }));
      },
      selfCheck: async () => ({ configured: true, checked: true, ok: true, message: '' }),
    },
    search: {
      kind: 'null',
      search: async (query: string) => {
        calls.web.push(query);
        return (options.web ?? []).map((hit) => ({
          title: hit.title, url: hit.url, summary: hit.summary, siteName: 'example', datePublished: '2026-11-01',
        }));
      },
      selfCheck: async () => ({ configured: true, checked: true, ok: true, message: '' }),
    },
    notes: new Set<string>(), calls: { poi: 0, search: 0 }, web: [], assertHealthy: () => {},
  } as unknown as DetailSources;
  return { sources, calls };
}

export function fauxModels() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models };
}

/** 可被测试卡住的工具：制造「一轮正在运行」的窗口；abort 时立刻放行。 */
export function gatedTool(onStart: () => void, gate: Promise<void>, signal: AbortSignal) {
  return defineTool({
    name: 'get_trip',
    description: '测试用阻塞工具',
    parameters: obj({}),
    execute: async () => {
      onStart();
      await Promise.race([
        gate,
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      return { output: [{ type: 'text' as const, text: JSON.stringify({ trip: 'fixture' }) }] };
    },
  });
}

export function gateOf() {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  return { gate, release, started: startedPromise, markStarted: started };
}
