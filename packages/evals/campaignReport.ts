import fs from 'node:fs';
import path from 'node:path';
import { hash, readReport, writeJson } from './artifacts';
import { parseSnapshot } from './contracts';
import { readFrozen } from './frozenKnowledge';
import { placeCoverage } from './placeCoverage';
import type { GoldenCase } from './golden/cases';
import type { Report, Snapshot } from './contracts';

export function campaignReport(directory: string) {
  const plan = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8')) as {
    knowledgeDirectory: string; knowledgeHash: string; cases: GoldenCase[]; stages: Array<{ id: string; city: string; suite: string }>;
  };
  const knowledge = readFrozen(plan.knowledgeDirectory);
  if (knowledge.contentHash !== plan.knowledgeHash) throw new Error('知识输入 hash 变化');
  const reports: Array<{ file: string; report: Report }> = [];
  const snapshots: Snapshot[] = [];
  for (const stage of plan.stages) {
    const batch = path.join(directory, stage.id);
    if (!fs.existsSync(batch)) continue;
    if (!fs.existsSync(path.join(batch, 'result.json'))) continue; // 正在执行的批次只能算待完成，不读半份报告。
    for (const name of fs.readdirSync(batch)) {
      const file = path.join(batch, name, 'report.json');
      if (!fs.existsSync(file)) continue;
      const report = readReport(file);
      if (report.manifest.knowledge.snapshotHash !== plan.knowledgeHash) throw new Error(`批次 ${stage.id} 知识版本不一致`);
      reports.push({ file, report });
      for (const c of report.cases) {
        if (c.snapshotHash === null) continue;
        const source = path.join(path.dirname(file), 'snapshots', `${c.caseId}.json`);
        if (!fs.existsSync(source)) continue;
        const snapshot = parseSnapshot(JSON.parse(fs.readFileSync(source, 'utf8')));
        if (hash(snapshot) !== c.snapshotHash) throw new Error(`快照 hash 不一致：${c.caseId}`);
        snapshots.push(snapshot);
      }
    }
  }
  const outcomes = reports.flatMap((r) => r.report.cases);
  if (new Set(outcomes.map((c) => c.caseId)).size !== outcomes.length) throw new Error('存在重复运行，必须明确选择版本，不能悄悄覆盖');
  const expected = new Set(plan.cases.map((c) => c.id));
  if (outcomes.some((c) => !expected.has(c.caseId))) throw new Error('存在计划外用例');
  const missing = plan.cases.filter((c) => !outcomes.some((o) => o.caseId === c.id)).map((c) => c.id);
  const coverage = placeCoverage(knowledge.data, snapshots);
  const complete = missing.length === 0 && outcomes.every((c) => c.status !== 'SKIPPED');
  const pass = complete && outcomes.every((c) => c.status === 'PASS') && reports.every((r) => !r.report.errors.length);
  const output = path.join(directory, 'summary');
  fs.mkdirSync(output, { recursive: true });
  writeJson(path.join(output, 'place-coverage.json'), coverage);
  const table = (rows: typeof coverage.rows) => ['| ID | 城市 | 地点 | 分类 | 来源 | 状态/原因 |', '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((p) => `| ${p.id} | ${p.city} | ${p.name.replaceAll('|', '\\|')} | ${p.category} | ${p.source} | ${p.exclusion ?? (p.candidateCases.length ? '已入候选、未入行程' : '未覆盖')} |`)].join('\n');
  fs.writeFileSync(path.join(output, 'uncovered-places.md'), '# 未进入候选或行程的可选地点\n\n' + table(coverage.rows.filter((p) => !p.exclusion && !p.candidateCases.length && !p.selectedCases.length)) + '\n');
  fs.writeFileSync(path.join(output, 'not-selected-places.md'), '# 未入行程的全部知识地点\n\n' + table(coverage.rows.filter((p) => !p.selectedCases.length)) + '\n');
  const counts = outcomes.reduce<Record<string, number>>((out, c) => { out[c.status] = (out[c.status] ?? 0) + 1; return out; }, {});
  const recordedTotals = ['tokensIn', 'tokensOut', 'totalMs', 'calls.amap', 'calls.search'].reduce<Record<string, number>>((out, key) => {
    out[key] = outcomes.reduce((sum, c) => sum + (c.metrics[key] ?? 0), 0); return out;
  }, {});
  const highTravelDays = outcomes.flatMap((c) => Object.entries(c.metrics).filter(([key, value]) => /^day\.\d+\.betweenActivityMinutes$/.test(key) && value !== null && value >= 240)
    .map(([key, minutes]) => ({ caseId: c.caseId, day: Number(key.split('.')[1]), minutes })));
  writeJson(path.join(output, 'summary.json'), { complete, pass, counts, expected: expected.size, missing,
    recordedTotals, highTravelDays,
    knowledgeHash: plan.knowledgeHash, runs: reports.map((r) => ({ file: path.relative(directory, r.file), manifest: r.report.manifest })),
    cases: outcomes, cities: coverage.cities });
  const rows = plan.cases.map((c) => {
    const result = outcomes.find((o) => o.caseId === c.id);
    const found = coverage.cases.find((o) => o.caseId === c.id);
    return `| ${c.id} | ${result?.status ?? 'PENDING'} | ${result?.metrics.hard ?? '—'} | ${result?.metrics.soft ?? '—'} | ${result?.metrics.flowDegraded ?? '—'} | ${found?.candidateCount ?? '—'} | ${found?.selectedIds.length ?? '—'} | ${found?.foodCount ?? '—'}/${found?.areaMealCount ?? '—'} |`;
  });
  fs.writeFileSync(path.join(output, 'report.md'), [
    '# 真实模型城市与偏好矩阵', '', `生成场景完成：${outcomes.length}/${expected.size}；完整执行：${complete}；当前门槛：${pass ? 'PASS' : complete ? 'FAIL' : 'PARTIAL'}。`, '',
    `结果计数：${JSON.stringify(counts)}。云南按用户要求排除。知识库 ${knowledge.name}，${knowledge.data.places.length} 地点。`, '',
    `已保存观测合计：token 入/出 ${recordedTotals.tokensIn}/${recordedTotals.tokensOut}，生成总耗时 ${(recordedTotals.totalMs! / 60000).toFixed(1)} 分钟；这是记录用量，不是计费账单，缺观测的消耗未计入。`, '',
    '完整执行不代表全部通过；意图识别与语义审阅见独立报告。硬规则通过不证明偏好/备注全部满足。', '',
    '| 城市 | 全部记录 | 可选地点 | 排除/不适用 | 候选覆盖 | 行程覆盖 | 完全未覆盖 |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...coverage.cities.map((c) => `| ${c.city} | ${c.total} | ${c.eligible} | ${c.excluded} | ${c.candidateCovered} | ${c.selectedCovered} | ${c.uncovered} |`), '',
    coverage.method, '', '[完全未覆盖地点](uncovered-places.md) · [全部未入选地点（含排除原因）](not-selected-places.md) · [逐地点/逐场景数据](place-coverage.json)', '',
    '| 场景 | 状态 | hard | soft | 增强降级 | 候选 | 入选知识地点 | 餐次/区域餐次 |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, '',
    '## 同城同天数偏好对照', '', '只比较可唯一关联的非餐饮景点 ID；Jaccard 为共同景点数/两例景点并集。相似或不同本身不代表质量优劣，需结合语义审阅。', '',
    '| 偏好场景（对照同城无偏好） | 共同景点 | 移除景点 | 新增景点 | Jaccard |', '| --- | --- | --- | --- | --- |',
    ...coverage.preferenceComparisons.map((p) => `| ${p.variant} | ${p.sharedIds.length} | ${p.baselineOnlyIds.length} | ${p.variantOnlyIds.length} | ${p.attractionJaccard === null ? '—' : p.attractionJaccard.toFixed(3)} |`), '',
    '## 已记录的长通勤日期', '', '以下日期仅活动间交通就达到 240 分钟；不含游玩与住宿往返。这是观察阈值，不新增质量硬门槛；缺失路线不能按零分钟解读。', '',
    '| 场景 | 日期序号 | 活动间交通分钟 |', '| --- | --- | --- |',
    ...highTravelDays.map((r) => `| ${r.caseId} | D${r.day} | ${r.minutes} |`), '',
    '## 发现的问题', '', ...outcomes.flatMap((c) => c.problems.map((p) => `- ${c.caseId}：${p.replace(/[\r\n]/g, ' ')}`)), '',
    '## 原始运行', '', ...reports.map((r) => `- [${r.report.manifest.runId}](${path.relative(output, r.file).replaceAll('\\', '/').replace(/report\.json$/, 'report.md')})`), '',
  ].join('\n'));
  return { directory: output, complete, pass, counts, missing: missing.length };
}
