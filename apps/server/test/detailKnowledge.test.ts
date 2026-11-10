import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceRetriever, type RetrievedPlace } from '@tripweaver/agent/generation/placeRetrieval';
import { rankPlaces } from '@tripweaver/agent/generation/retrievalRanking';
import { createDetailSources } from '@tripweaver/integrations/detailSources';
import { allowsWebSearch, collectReferences } from '@tripweaver/agent/chat/detailKnowledge';

const place = (id: string, name = id): RetrievedPlace => ({ id, name, city: '北京', category: '文化', source: 'manual', verified: true, lat: 39.9, lng: 116.4, payload: {}, evidence: [], aliases: [] });
const signal = () => new AbortController().signal;
const selfCheck = async () => ({ configured: true, checked: true, ok: true, message: '' });
function sources(options: { search?: () => Promise<any[]>; reserve?: (source: 'poi' | 'search', count: number) => Promise<null | ((used: number) => Promise<void>)>; abort?: AbortSignal; budgets?: { poi: number; search: number } } = {}) {
  return createDetailSources({
    poi: { kind: 'amap', searchPois: async () => [], selfCheck },
    search: { kind: 'websearch', search: options.search ?? (async () => []), selfCheck },
    reserve: options.reserve ?? (async () => async () => {}),
    ...(options.budgets ? { budgets: options.budgets } : {}),
  }, options.abort ?? signal());
}

test('混合检索使用独立语义问题，保留精确实体、语义候选与证据', async () => {
  let embedded = '';
  const exact = place('exact', '故宫'); const semantic = { ...place('semantic', '公园'), distance: 0.03 };
  const queries: { sql: string; values: unknown[] }[] = [];
  const retrieve = createPlaceRetriever({
    embed: async (text) => { embedded = text; return [1, 0]; },
    query: async <T>(sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      const rows = sql.includes('research_evidence') ? [{ place_id: 'exact', kind: 'xhs_warning', content: '周一闭馆', strength: 'risk_only', sourceUrl: 'https://example.com/policy', fetched_at: new Date() }]
        : sql.includes('embedding <=>') ? [semantic] : [exact];
      return { rows: rows as T[] };
    },
  });
  let state = '';
  const results = await retrieve(['故宫'], { city: '北京', category: 'attraction', vector: 'force', semanticQuery: '带孩子想在故宫附近找安静的自然空间', onDiagnostics: (d) => { state = d.vector; } });
  assert.equal(embedded, '带孩子想在故宫附近找安静的自然空间');
  assert.deepEqual(results.map((r) => r.id), ['exact', 'semantic']);
  assert.equal(results[0]!.evidence[0]!.strength, 'risk_only');
  assert.equal(state, 'used');
  assert.equal(queries[1]!.values[1], '北京');
  assert.match(queries[1]!.sql, /verified = TRUE/);
});

test('同一实体不同来源融合时保留语义分，不覆盖优先的正式名称', () => {
  const results = rankPlaces([
    { ...place('gold', '故宫博物院'), source: 'goldset', payload: { aliases: ['故宫'] } },
    { ...place('vector', '故宫'), payload: { identity: { entityId: 'gold' } }, distance: 0.1 },
  ], [], [], 8);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.row.name, '故宫博物院');
  assert.equal(results[0]!.row.distance, 0.1);
});

test('无向量配置或向量服务失败时保留 SQL，正式生成关闭向量时零嵌入调用', async () => {
  for (const mode of ['missing', 'failure', 'off'] as const) {
    let calls = 0; let vector = '';
    const retrieve = createPlaceRetriever({
      embed: async () => { calls++; if (mode === 'failure') throw new Error('unavailable'); return null; },
      query: async <T>(sql: string) => ({ rows: (sql.includes('research_evidence') ? [] : [place('stored')]) as T[] }),
    });
    const hits = await retrieve(['自然'], { vector: mode === 'off' ? 'off' : 'force', onDiagnostics: (d) => { vector = d.vector; } });
    assert.equal(hits[0]!.id, 'stored');
    assert.equal(calls, mode === 'off' ? 0 : 1);
    assert.equal(vector, mode === 'missing' ? 'unavailable' : mode === 'failure' ? 'failed' : 'off');
  }
});

test('联网意愿是纯函数：明确拒绝联网即禁网；引用消毒去凭据/去重/限量', () => {
  assert.equal(allowsWebSearch('不要联网搜索'), false);
  assert.equal(allowsWebSearch('只用知识库回答'), false);
  assert.equal(allowsWebSearch('现在需要预约吗？'), true);
  const references = collectReferences([
    { title: 'x', url: 'javascript:alert(1)' },
    { title: 'x', url: 'https://user:password@example.com' },
    { title: '官方说明', url: 'https://example.com/policy' },
    { title: '官方说明', url: 'https://example.com/policy' },
  ]);
  assert.deepEqual(references, [{ title: '官方说明', url: 'https://example.com/policy' }]);
});

test('本轮来源共享去重和额度，预算服务异常必须向上抛', async () => {
  const charged: number[] = []; let requests = 0;
  // 钉住预算：这条测的是「超过上限会被拦」这个机制，不该随默认值调整而失效。
  const session = sources({ budgets: { poi: 8, search: 2 }, search: async () => { requests++; return []; }, reserve: async () => async (used) => { charged.push(used); } });
  await Promise.all([session.search.search('同一个问题'), session.search.search('同一个问题')]);
  await session.search.search('另一个问题'); await session.search.search('超出本轮上限');
  assert.equal(requests, 2); assert.deepEqual(charged, [1, 1]);
  assert.match([...session.notes].join(''), /上限/);
  await assert.rejects(sources({ reserve: async () => { throw new Error('ledger unavailable'); } }).search.search('问题'), /ledger unavailable/);
});

test('预留后取消退回未发出的额度，来源失败仍记实际尝试', async () => {
  const controller = new AbortController(); const charged: number[] = []; let requests = 0;
  const session = sources({ abort: controller.signal, search: async () => { requests++; return []; },
    reserve: async () => { controller.abort(); return async (used) => { charged.push(used); }; } });
  await assert.rejects(session.search.search('取消问题'), { name: 'AbortError' });
  assert.equal(requests, 0); assert.deepEqual(charged, [0]);
  const failed = sources({ search: async () => { throw new Error('provider unavailable'); }, reserve: async () => async (used) => { charged.push(used); } });
  assert.deepEqual(await failed.search.search('失败问题'), []); assert.deepEqual(charged, [0, 1]);
});
