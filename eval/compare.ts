import type { Report } from './contracts';

export interface ComparisonRow {
  caseId: string; before: string; after: string;
  state: 'UNCHANGED' | 'CHANGED' | 'REGRESSION' | 'INCOMPARABLE';
  reasons: string[]; deltas: Record<string, number | null>;
}
export function compareReports(baseline: Report, candidate: Report) {
  const reasons: string[] = [];
  if (baseline.manifest.mode !== candidate.manifest.mode) reasons.push('运行模式不同（offline/live）');
  if (baseline.manifest.checksHash !== candidate.manifest.checksHash) reasons.push('检查器或共享契约版本不同');
  if (baseline.manifest.mode === 'live' && baseline.manifest.knowledge.hash !== candidate.manifest.knowledge.hash) reasons.push('知识库版本不同');
  if (baseline.manifest.mode === 'live' && ['allowNoGeo', 'photos', 'weather', 'amap', 'search'].some(
    (key) => baseline.manifest.configuration[key] !== candidate.manifest.configuration[key])) reasons.push('服务启用或降级条件不同');
  const before = new Map(baseline.cases.map((c) => [c.caseId, c]));
  const after = new Map(candidate.cases.map((c) => [c.caseId, c]));
  const rows: ComparisonRow[] = [...new Set([...before.keys(), ...after.keys()])].map((caseId) => {
    const a = before.get(caseId), b = after.get(caseId);
    const localReasons = [...reasons];
    if (!a || !b) localReasons.push(!a ? '基线没有此用例' : '候选缺少此用例');
    if (a && b && a.inputHash !== b.inputHash) localReasons.push('用例输入发生变化');
    const deltas: ComparisonRow['deltas'] = {};
    for (const key of new Set([...Object.keys(a?.metrics ?? {}), ...Object.keys(b?.metrics ?? {})])) {
      const x = a?.metrics[key], y = b?.metrics[key];
      deltas[key] = localReasons.length || x == null || y == null ? null : y - x;
    }
    let state: ComparisonRow['state'] = 'UNCHANGED';
    if (localReasons.length) state = 'INCOMPARABLE';
    else if ((a?.status === 'PASS' && b?.status !== 'PASS') || ['hard', 'structural', 'geoProblems', 'flowFailures'].some((k) => (deltas[k] ?? 0) > 0)) state = 'REGRESSION';
    else if (a?.status !== b?.status || Object.values(deltas).some((d) => d !== null && d !== 0) ||
      JSON.stringify(a?.unavailable) !== JSON.stringify(b?.unavailable)) state = 'CHANGED';
    return { caseId, before: a?.status ?? 'MISSING', after: b?.status ?? 'MISSING', state, reasons: localReasons, deltas };
  });
  const incompatible = rows.some((r) => r.state === 'INCOMPARABLE');
  const regression = rows.some((r) => r.state === 'REGRESSION') || (baseline.gate.pass && !candidate.gate.pass && !incompatible);
  return { baseline: baseline.manifest.runId, candidate: candidate.manifest.runId,
    exitCode: incompatible ? 2 : regression ? 1 : 0, incompatible, regression, rows };
}
export function comparisonMarkdown(comparison: ReturnType<typeof compareReports>): string {
  const delta = (n: number | null | undefined) => n == null ? '—' : `${n > 0 ? '+' : ''}${Math.round(n * 1000) / 1000}`;
  return ['# 评估版本比较', '', `${comparison.baseline} → ${comparison.candidate}`, '',
    '差值为候选减基线；— 表示缺少数据或不可比。耗时/token 变化是观测结果，未作统计显著性判断。', '',
    '| 用例 | 状态变化 | 判定 | Δhard | Δsoft | Δ耗时 ms | Δtoken 入/出 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...comparison.rows.map((r) => `| ${r.caseId} | ${r.before} → ${r.after} | ${r.state} | ${delta(r.deltas.hard)} | ${delta(r.deltas.soft)} | ${delta(r.deltas.totalMs)} | ${delta(r.deltas.tokensIn)}/${delta(r.deltas.tokensOut)} |`), '',
    ...comparison.rows.flatMap((r) => r.reasons.map((s) => `- ${r.caseId}：${s}`)), '',
  ].join('\n');
}
