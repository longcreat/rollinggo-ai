import assert from 'node:assert/strict';
import test from 'node:test';
import { configFingerprint, literalCoverage, parseVariantSpecs, realAliases, recallMetrics,
  renderRetrievalQuality, renderVariantComparison, retrievalQualityReport,
  type PlaceCoverageRow, type RecallCase, type VariantReport } from '../retrievalQuality';

const row = (over: Partial<PlaceCoverageRow> & Pick<PlaceCoverageRow, 'id' | 'name'>): PlaceCoverageRow => ({
  city: '北京', category: '文化', source: 'xhs', payload: {}, hasEvidence: false, ...over });

test('只填充主名本身的 aliases 数组不算真别名', () => {
  assert.deepEqual(realAliases(row({ id: 'a', name: '故宫博物院', payload: { aliases: ['故宫博物院'] } })), []);
  assert.deepEqual(realAliases(row({ id: 'b', name: '故宫博物院', payload: { aliases: ['故宫博物院', '紫禁城'] } })), ['紫禁城']);
  assert.deepEqual(realAliases(row({ id: 'c', name: '天坛', payload: { aliases: [' ', null, 1, ' 天坛 '] } })), []);
  assert.deepEqual(realAliases(row({ id: 'd', name: '天坛', payload: null })), []);
  assert.deepEqual(realAliases(row({ id: 'e', name: ' 天坛 ', payload: { aliases: ['天坛'] } })), []);
});

test('字面层覆盖区分真别名与字段填充，并按城市与同城同名分组', () => {
  const rows = [
    row({ id: '1', name: '故宫博物院', payload: { aliases: ['故宫博物院', '紫禁城'], themes: ['历史'] }, hasEvidence: true }),
    row({ id: '2', name: '天坛', payload: { aliases: ['天坛'] } }),
    row({ id: '3', name: '西湖', city: '杭州', payload: { themes: ['自然'] }, hasEvidence: true }),
    row({ id: '4', name: '同名', city: '杭州' }),
    row({ id: '5', name: '同名', city: '杭州' }),
  ];
  const coverage = literalCoverage(rows);
  assert.equal(coverage.total, 5);
  assert.equal(coverage.withRealAlias, 1, '只有故宫有除主名外的写法');
  assert.equal(coverage.withThemes, 2);
  assert.equal(coverage.withEvidence, 2);
  assert.equal(coverage.duplicateNameGroups, 1);
  assert.equal(coverage.duplicateNameRows, 2);
  assert.deepEqual(coverage.byCity.map((city) => city.city), ['杭州', '北京']);
  assert.deepEqual(coverage.byCity.find((city) => city.city === '北京'),
    { city: '北京', total: 2, withRealAlias: 1, withThemes: 1, withEvidence: 1 });
  assert.match(coverage.method, /真别名/);
});

test('召回分母是实际执行的 query 数，命中按返回实体的规范实体 ID 判定', () => {
  const cases: RecallCase[] = [
    { city: '北京', query: '紫禁城', expectId: 'p1', expectName: '故宫博物院', hitGroups: [['p1']], actualNames: ['故宫博物院'] },
    // 目标以成员行身份出现在合并实体里，排位不是第一
    { city: '北京', query: '天坛', expectId: 'member', expectName: '天坛', hitGroups: [['other'], ['root', 'member']], actualNames: ['其他', '天坛公园'] },
    // 排位恰好超出 depth
    { city: '杭州', query: '西湖', expectId: 'p3', expectName: '西湖',
      hitGroups: Array.from({ length: 9 }, (_, index) => [`x${index}`]), actualNames: [] },
    { city: '杭州', query: '灵隐寺', expectId: 'p4', expectName: '灵隐寺', hitGroups: [], actualNames: [] },
  ];
  const metrics = recallMetrics(cases, 8);
  assert.equal(metrics.total, 4, '分母是 query 数，不是被跳过的样本行数');
  assert.equal(metrics.depth, 8);
  assert.equal(metrics.at1, 1);
  assert.equal(metrics.atDepth, 2);
  // MRR = (1/1 + 1/2 + 0 + 0) / 4；超出 depth 与未命中同样记 0。
  assert.equal(metrics.mrr, 0.375);
  assert.deepEqual(metrics.misses.map((miss) => miss.query), ['西湖', '灵隐寺']);
  assert.deepEqual(metrics.misses[1], { city: '杭州', query: '灵隐寺', expectName: '灵隐寺', actualNames: [] });
  assert.deepEqual(metrics.byCity.find((city) => city.city === '杭州'), { city: '杭州', total: 2, at1: 0, atDepth: 0 });
  assert.match(metrics.method, /分母是实际执行的 query 数/);
});

test('depth 变化同时限制命中范围与报告标注', () => {
  const cases: RecallCase[] = [
    { city: '北京', query: 'a', expectId: 'p1', expectName: 'n', hitGroups: [['p1']], actualNames: ['n'] },
    { city: '北京', query: 'b', expectId: 'p2', expectName: 'n', hitGroups: [['x'], ['p2']], actualNames: ['x', 'n'] },
  ];
  const metrics = recallMetrics(cases, 1);
  assert.equal(metrics.at1, 1);
  assert.equal(metrics.atDepth, 1, '排位 1 超出 depth=1，不计命中');
  assert.equal(metrics.misses.length, 1);
  assert.match(renderRetrievalQuality(retrievalQualityReport([], cases, 1)), /Recall@1/);
});

test('人读摘要给出覆盖率、召回率与未命中清单', () => {
  const rows = [row({ id: '1', name: '故宫博物院', payload: { aliases: ['紫禁城'] } }), row({ id: '2', name: '天坛' })];
  const cases: RecallCase[] = [{ city: '北京', query: '紫禁城', expectId: 'other', expectName: '故宫博物院', hitGroups: [], actualNames: [] }];
  const text = renderRetrievalQuality(retrievalQualityReport(rows, cases));
  assert.match(text, /真别名\s+1\s+50\.0%/);
  assert.match(text, /Recall@1\s+0\.0%/);
  assert.match(text, /Recall@8\s+0\.0%/);
  assert.match(text, /未命中 1 条/);
  assert.match(text, /「紫禁城」→ 期望「故宫博物院」，实得 \(空\)/);
});

test('变体定义拒绝未知参数、重复 label 与非法取值，而不是静默忽略', () => {
  assert.deepEqual(parseVariantSpecs([{ label: 'off' }]), [{ label: 'off', vector: 'off' }]);
  assert.deepEqual(parseVariantSpecs([{ label: 'force', vector: 'force', limit: 8 }]),
    [{ label: 'force', vector: 'force', limit: 8 }]);
  // 未知 key 必须报错：静默忽略会让人以为参数生效了。
  assert.throws(() => parseVariantSpecs([{ label: 'a', vector: 'off', reranker: 'ce' }]), /未知参数「reranker」/);
  assert.throws(() => parseVariantSpecs([]), /非空数组/);
  assert.throws(() => parseVariantSpecs([{ label: 'a', vector: 'off' }, { label: 'a', vector: 'force' }]), /label 重复/);
  assert.throws(() => parseVariantSpecs([{ label: 'a', vector: 'hybrid' }]), /vector 必须是/);
  assert.throws(() => parseVariantSpecs([{ label: 'a', limit: 64 }]), /limit 必须是 1–48/);
  assert.throws(() => parseVariantSpecs([{ vector: 'off' }]), /缺少 label/);
});

test('配置指纹只由配置内容决定，与键顺序无关', () => {
  assert.equal(configFingerprint({ vector: 'auto', limit: 8 }), configFingerprint({ limit: 8, vector: 'auto' }));
  assert.notEqual(configFingerprint({ vector: 'auto', limit: 8 }), configFingerprint({ vector: 'force', limit: 8 }));
  assert.match(configFingerprint({ vector: 'off' }), /^[0-9a-f]{8}$/);
});

test('变体对比以首个变体为基准标出各子集的百分点差值', () => {
  const metrics = (at1: number, atDepth: number, total = 10) => ({ total, depth: 8, at1, atDepth, mrr: at1 / total,
    byCity: [], misses: [], method: '' });
  const report: VariantReport = { coverage: literalCoverage([]), subsets: [{ name: 'literalFail', queries: 10, method: '测试子集' }],
    variants: [
      { label: 'off', config: { vector: 'off' }, fingerprint: 'aaaaaaaa', recall: { literalFail: metrics(0, 0) },
        channels: { literalFail: { keywordHits: 0, vectorHits: 0, vectorSelected: 0, embedFailures: 0, skippedFilled: 0 } } },
      { label: 'force', config: { vector: 'force' }, fingerprint: 'bbbbbbbb', recall: { literalFail: metrics(2, 3) },
        channels: { literalFail: { keywordHits: 4, vectorHits: 489, vectorSelected: 120, embedFailures: 2, skippedFilled: 0 } } },
    ] };
  const text = renderVariantComparison(report);
  assert.match(text, /off\s+\[\{"vector":"off"\}\]\s+指纹 aaaaaaaa/);
  assert.match(text, /literalFail\s+n=\s+10\s+Recall@1 0\.0%\s+Recall@8 0\.0%\s+MRR 0\.000/);
  assert.match(text, /literalFail\s+n=\s+10\s+Recall@1 20\.0%\s+Recall@8 30\.0%\s+MRR 0\.200\s+ΔRecall@8 30\.0pt/);
  // 通道统计暴露「召回很多、进入结果很少」的落差；但落差本身不等于排序问题，只在跨变体比较时作参考。
  assert.match(text, /关键词命中 4\s+向量命中 489\s+进入结果 120\s+外呼失败 2\s+字面已足够 0/);
});
