import fs from 'node:fs';
import path from 'node:path';
import { EVAL_DIR, createManifest, hash, readReport, reportPath, writeJson } from './artifacts';
import { ALL_CASES } from './scenarios';
import { evaluateCase } from './runner';
import { readFrozen, summarizeFrozen } from './frozenKnowledge';
import { evaluationInput } from './input';

/** 显式接纳已检查的完整运行；从不覆盖既有名称或历史 snapshots。 */
export function acceptBaseline(source: string, name: string, root = path.join(EVAL_DIR, 'baselines')): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('基线名称仅允许小写字母、数字和短横线（1–64 字符）');
  const report = readReport(source);
  if (!report.gate.pass || report.errors.length || !report.cases.length || report.cases.some((c) => c.status !== 'PASS')) {
    throw new Error('不能接纳失败或不完整的运行');
  }
  if (report.manifest.checksHash !== createManifest([], 'offline', 'full').checksHash) throw new Error('检查器已改变，请先用当前版本重新评估');
  const inputDirectory = path.dirname(reportPath(source));
  const frozenDirectory = path.join(inputDirectory, 'knowledge');
  const frozen = report.manifest.knowledge.mode === 'frozen' ? readFrozen(frozenDirectory) : null;
  if (frozen && (frozen.contentHash !== report.manifest.knowledge.snapshotHash ||
    hash({ snapshotHash: frozen.contentHash, skipVectors: report.manifest.knowledge.vectorMode === 'omitted' }) !== report.manifest.knowledge.hash)) {
    throw new Error('冻结知识库与运行 manifest 不一致，不能接纳基线');
  }
  const snapshots = report.cases.map((c) => {
    const gc = ALL_CASES.find((item) => item.id === c.caseId);
    if (!gc) throw new Error(`未知用例：${c.caseId}`);
    const snapshot: unknown = JSON.parse(fs.readFileSync(path.join(inputDirectory, 'snapshots', `${c.caseId}.json`), 'utf8'));
    const checked = evaluateCase(gc, snapshot, report.manifest.mode === 'live');
    if (checked.outcome.status !== 'PASS' || c.inputHash !== hash(evaluationInput(gc.form)) || c.snapshotHash !== hash(snapshot)) {
      throw new Error(`快照校验失败或运行后被修改：${c.caseId}`);
    }
    return checked.snapshot;
  });
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, name);
  fs.mkdirSync(target);
  for (const snapshot of snapshots) writeJson(path.join(target, 'snapshots', `${snapshot.caseId}.json`), snapshot);
  if (frozen) {
    fs.mkdirSync(path.join(target, 'knowledge'));
    fs.copyFileSync(path.join(frozenDirectory, 'knowledge.json.gz'), path.join(target, 'knowledge/knowledge.json.gz'), fs.constants.COPYFILE_EXCL);
    writeJson(path.join(target, 'knowledge/manifest.json'), summarizeFrozen(frozen));
  }
  writeJson(path.join(target, 'report.json'), report);
  writeJson(path.join(target, 'manifest.json'), report.manifest);
  writeJson(path.join(target, 'accepted.json'), { acceptedAt: new Date().toISOString(), sourceRunId: report.manifest.runId });
  return target;
}
