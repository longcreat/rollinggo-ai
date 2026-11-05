// 向量路径的排序与诊断：字面一无所获时规则分只剩噪声，必须改用纯距离排序。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResultRow } from 'pg';
import { createPlaceRetriever, type RetrievalDiagnostics } from '../generation/placeRetrieval';
import { groupPlaces, rankPlaces, rankPlacesByDistance, type PlaceRow } from '../generation/retrievalRanking';

const place = (over: Partial<PlaceRow> & Pick<PlaceRow, 'id' | 'name'>): PlaceRow => ({
  city: '测试市', category: '文化', verified: true, source: 'xhs', lat: 30, lng: 120, payload: {}, ...over,
});

const embedding = [1, ...Array.from({ length: 1023 }, () => 0)];

/** 用假 deps 收窄 observation：关键字、向量、证据三条 SQL 分别由 `AS distance` 与 `CROSS JOIN LATERAL` 区分。 */
function fakeDeps(keyword: PlaceRow[], vector: PlaceRow[]) {
  const calls = { keyword: 0, vector: 0, embed: 0 };
  return {
    calls,
    deps: {
      query: async <T extends QueryResultRow>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes('AS distance')) { calls.vector += 1; return { rows: vector as unknown as T[] }; }
        if (sql.includes('CROSS JOIN LATERAL')) return { rows: [] };
        calls.keyword += 1;
        return { rows: keyword as unknown as T[] };
      },
      embed: async () => { calls.embed += 1; return embedding; },
    },
  };
}

test('字面一无所获时按向量距离排序，不被热度与子景点降权挤掉', async () => {
  const vector = [
    // 距离最近，但名称触发 detail 正则（-100）、热度为零 —— 规则分会把它压到最后。
    place({ id: 'v1', name: '古镇停车场旁小吃', distance: 0.11 }),
    // 热度极高的热榜地点，规则分会把它顶到第一。
    place({ id: 'v2', name: '热门打卡地', distance: 0.42, payload: { recommendScore: 9999, mentionCount: 9999 } }),
    place({ id: 'v3', name: '普通地点', distance: 0.30 }),
  ];
  const { deps } = fakeDeps([], vector);

  // 先确认前提：三条都有 distance 时规则分排序确实不是按距离。
  assert.deepEqual(rankPlaces(vector, ['完全匹配不上的词'], [], 3).map((item) => item.row.id), ['v2', 'v3', 'v1']);

  const result = await createPlaceRetriever(deps)(['完全匹配不上的词'], { city: '测试市', vector: 'auto', limit: 3 });
  assert.deepEqual(result.map((item) => item.id), ['v1', 'v3', 'v2'], '字面为空必须按向量距离升序');
});

test('字面有命中时保持原排序：规则分决定顺序，向量只做补位', async () => {
  const keyword = [place({ id: 'k1', name: '故宫博物院', payload: { aliases: ['紫禁城'] } })];
  const vector = [
    place({ id: 'k1', name: '故宫博物院', distance: 0.55 }),
    place({ id: 'v1', name: '远处景点', distance: 0.05 }),
  ];
  const { deps, calls } = fakeDeps(keyword, vector);

  const result = await createPlaceRetriever(deps)(['紫禁城'], { city: '测试市', vector: 'auto', limit: 3 });
  assert.equal(calls.embed, 1);
  assert.equal(result[0]!.id, 'k1', '字面命中的精确别名必须保持第一，距离再近也不能越位');
  assert.ok(result.some((item) => item.id === 'v1'), '向量补位仍要进入结果');
});

test('auto 模式字面填满 limit 时记为 skipped:filled 且不请求向量', async () => {
  const keyword = Array.from({ length: 8 }, (_, index) => place({ id: `k${index}`, name: `景点${index}` }));
  const { deps, calls } = fakeDeps(keyword, []);
  let diagnostics: RetrievalDiagnostics | undefined;

  const result = await createPlaceRetriever(deps)(['景点'], { city: '测试市', vector: 'auto', limit: 8,
    onDiagnostics: (value) => { diagnostics = value; } });
  assert.equal(result.length, 8);
  assert.equal(calls.embed, 0, '字面已满 limit，按设计不应外呼 embedding');
  assert.equal(diagnostics?.vector, 'skipped:filled');
  assert.equal(diagnostics?.vectorSelected, 0);
});

test('诊断区分「召回但被排序压掉」：vectorHits 大于 vectorSelected', async () => {
  // 字面命中 1 条，limit=2 只留 1 个向量补位名额，其余向量命中进不了结果。
  const keyword = [place({ id: 'k1', name: '故宫博物院' })];
  const vector = [place({ id: 'k1', name: '故宫博物院', distance: 0.4 }),
    place({ id: 'v1', name: '补位景点', distance: 0.1 }), place({ id: 'v2', name: '落选景点', distance: 0.2 })];
  const { deps } = fakeDeps(keyword, vector);
  let diagnostics: RetrievalDiagnostics | undefined;

  await createPlaceRetriever(deps)(['故宫'], { city: '测试市', vector: 'auto', limit: 2,
    onDiagnostics: (value) => { diagnostics = value; } });
  assert.equal(diagnostics?.vector, 'used');
  assert.equal(diagnostics?.vectorHits, 3);
  assert.equal(diagnostics?.vectorSelected, 1, '只有一条向量命中进入 limit=2 的结果');
});

test('rankPlacesByDistance 合并同一实体并把无距离候选排在最后', () => {
  const rows = [
    place({ id: 'root', name: '天坛公园', distance: 0.6, payload: { identity: { entityId: 'root' } } }),
    place({ id: 'member', name: '天坛', distance: 0.2, payload: { identity: { entityId: 'root' } } }),
    place({ id: 'no-distance', name: '无向量景点' }),
    place({ id: 'near', name: '最近景点', distance: 0.05 }),
  ];
  const groups = groupPlaces(rows);
  assert.equal(groups.length, 3, '同 entityId 的两行必须归并成一个实体');

  const ranked = rankPlacesByDistance(rows, 3);
  assert.deepEqual(ranked.map((item) => item.row.id), ['near', 'root', 'no-distance'], '无距离的候选排在最后');
  assert.deepEqual(ranked[1]!.ids, ['root', 'member'], '归并后保留全部成员行 ID');
});
