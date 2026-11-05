import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { hash, writeJson, readReport } from './artifacts';
import { parseSnapshot, type Snapshot } from './contracts';
import { reviewInput, validateVerdicts, type SemanticVerdict } from './semanticReview';

const { values } = parseArgs({ options: { campaign: { type: 'string' }, reviews: { type: 'string', default: 'semantic,semantic-recheck-v1' } }, strict: true });
if (!values.campaign) throw new Error('需要 --campaign');
const directory = path.resolve(values.campaign);
const plan = JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8')) as { stages: Array<{ id: string; suite: string }> };
const sources = new Map<string, Snapshot>();
for (const stage of plan.stages) {
  const resultFile = path.join(directory, stage.id, 'result.json');
  if (!fs.existsSync(resultFile)) continue;
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (!result.report) continue;
  const reportFile = path.join(directory, result.report);
  for (const c of readReport(reportFile).cases) {
    if (!c.snapshotHash) continue;
    const file = path.join(path.dirname(reportFile), 'snapshots', `${c.caseId}.json`);
    const snapshot = parseSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (hash(snapshot) !== c.snapshotHash) throw new Error(`生成快照改变：${c.caseId}`);
    sources.set(c.caseId, snapshot);
  }
}
const groups = plan.stages.flatMap((s) => (s.suite === 'matrix' ? [3,5] : [3]).map((d) => `${s.id}-${d}d`));
const results = groups.map((group) => {
  const attempts: Array<{ file: string; error: string; valid: boolean }> = [];
  let selected: string | null = null;
  let verdicts: SemanticVerdict[] = [];
  for (const folder of values.reviews.split(',').filter(Boolean)) {
    const file = path.join(directory, folder, `${group}.json`);
    if (!fs.existsSync(file)) continue;
    const review = JSON.parse(fs.readFileSync(file, 'utf8'));
    let error = '';
    try {
      if (review.error) throw new Error(review.error);
      if (review.missing?.length) throw new Error('部分生成快照缺失，不能声称完整审阅');
      const snapshots = (review.expectedCaseIds as string[]).map((id) => {
        const snapshot = sources.get(id); if (!snapshot) throw new Error(`缺少已结束运行的生成证据：${id}`); return snapshot;
      });
      if (hash(reviewInput(snapshots)) !== review.inputHash) throw new Error('审阅输入与实际生成快照不一致');
      const validated = validateVerdicts(review.verdicts, snapshots);
      selected = path.relative(directory, file).replaceAll('\\','/'); verdicts = validated;
    } catch (e) { error = e instanceof Error ? e.message : '审阅校验失败'; }
    attempts.push({ file: path.relative(directory, file).replaceAll('\\','/'), error, valid: !error });
  }
  return { group, status: selected ? 'VALID' : attempts.length ? 'ERROR' : 'PENDING', selected, attempts, verdicts };
});
const counts = results.reduce<Record<string,number>>((out,r) => { out[r.status] = (out[r.status] ?? 0) + 1; return out; }, {});
writeJson(path.join(directory, 'semantic-audit.json'), { complete: results.every((r) => r.status === 'VALID'), counts, results });
fs.writeFileSync(path.join(directory, 'semantic-audit.md'), ['# 语义审阅证据核对', '',
  `分组状态：${JSON.stringify(counts)}。VALID 只代表输入及引用有效，语义结论仍需人工复核。`, '',
  '| 分组 | 状态 | 采用结果 | 失败记录 |', '| --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.group} | ${r.status} | ${r.selected ? `[结果](${r.selected})` : '—'} | ${r.attempts.filter((a) => !a.valid).map((a) => a.error).join('；')} |`), '',
  '| 场景 | 结论 | 理由 |', '| --- | --- | --- |',
  ...results.flatMap((r) => r.verdicts.map((v) => `| ${v.caseId} | ${v.verdict} | ${v.reason.replaceAll('|','\\|').replace(/[\r\n]/g,' ')} |`)), '',
  '优先采用目录参数中靠后的有效审阅，保留全部尝试；不会依据 aligned/mixed 标签挑选结果。', ''].join('\n'));
console.log({ counts, retryGroups: results.filter((r) => r.status === 'ERROR').map((r) => r.group) });
process.exitCode = results.every((r) => r.status === 'VALID') ? 0 : 1;
