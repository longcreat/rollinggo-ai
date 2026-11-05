import fs from 'node:fs';
import path from 'node:path';
import { runChecks } from './checks';
import { parseSnapshot, type Manifest, type Report, type RunCase, type Snapshot } from './contracts';
import { hash, reportMarkdown, writeJson } from './artifacts';
import type { GoldenCase } from './golden/cases';
import { assessCoverage } from './coverage';
import { evaluationInput } from './input';
import { checkCurrentFlow } from './currentFlow';
import { checkNotePlaces } from './noteChecks';

export function evaluateCase(gc: GoldenCase, value: unknown, live: boolean): { outcome: RunCase; snapshot: Snapshot } {
  const snapshot = parseSnapshot(value);
  if (snapshot.caseId !== gc.id || hash(evaluationInput(snapshot.form)) !== hash(evaluationInput(gc.form))) throw new Error('快照 caseId/form 与当前用例不一致，不能重放');
  const checked = runChecks(gc.id, snapshot.trip, gc.form, { candidates: snapshot.research?.candidates, timing: snapshot.timing });
  const coverage = assessCoverage(snapshot.trip, gc.form);
  const flow = checkCurrentFlow(snapshot.trip, gc.form, snapshot.execution);
  const flowProblems = flow.filter((row) => row.status === 'FAIL');
  const noteProblems = checkNotePlaces(gc.id, snapshot.trip);
  const metrics: RunCase['metrics'] = {
    ...coverage.metrics,
    flowFailures: snapshot.execution ? flowProblems.length : null,
    notePlaceFailures: noteProblems.length,
    flowDegraded: snapshot.execution ? flow.filter((row) => row.status === 'DEGRADED').length : null,
    hard: checked.hardViolations.length, soft: checked.softViolations.length, structural: checked.structural.length,
    geoProblems: checked.geoGate.length, locatedRatio: checked.geo.locatedRatio,
    estimatedRatio: checked.geo.estimatedRatio, providerLegRatio: checked.geo.providerLegRatio,
    outliers: checked.geo.outlierActivities.length,
    poolSize: checked.research?.poolSize ?? null, adoptionRatio: checked.research?.adoptionRatio ?? null,
    totalMs: snapshot.timing?.totalMs ?? null, tokensIn: snapshot.timing?.tokensIn ?? null, tokensOut: snapshot.timing?.tokensOut ?? null,
  };
  for (const [key, value] of Object.entries(snapshot.timing?.phases ?? {})) metrics[`phase.${key}`] = value;
  for (const [key, value] of Object.entries(snapshot.timing?.providerCalls ?? {})) metrics[`calls.${key}`] = value;
  const unavailable = [
    ...(!snapshot.execution ? ['execution'] : []),
    ...(!snapshot.research || (live && snapshot.research.candidates.length === 0) ? ['research'] : []),
    ...(['totalMs', 'tokensIn', 'tokensOut'] as const).filter((key) => snapshot.timing?.[key] === undefined),
    ...(!Object.keys(snapshot.timing?.phases ?? {}).length ? ['phases'] : []),
    ...(!snapshot.timing?.providerCalls ? ['providerCalls'] : []),
    ...(live ? ['research#1', 'plan#1', 'review#1'].filter((phase) => snapshot.timing?.phases[phase] === undefined).map((phase) => `phase.${phase}`) : []),
    ...(live ? ['amap', 'search', 'xhs'].filter((key) => snapshot.timing?.providerCalls?.[key] === undefined).map((key) => `calls.${key}`) : []),
  ];
  const problems = [...noteProblems.map((message) => `[notes] ${message}`), ...flowProblems.map((row) => `[flow/${row.id}] ${row.detail}`), ...checked.hardViolations.map((v) => `[hard/${v.code}] D${v.dayIndex} ${v.message}`),
    ...checked.softViolations.map((v) => `[soft/${v.code}] D${v.dayIndex} ${v.message}`),
    ...checked.structural, ...checked.geoGate];
  if (live && unavailable.length) problems.push(`live 观测不完整：${unavailable.join(', ')}`);
  return { snapshot, outcome: {
    caseId: gc.id, inputHash: hash(evaluationInput(gc.form)), status: live && unavailable.length ? 'ERROR' : checked.pass && !flowProblems.length && !noteProblems.length ? 'PASS' : 'FAIL',
    problems, unavailable, flow, limitations: coverage.limitations, metrics, snapshotHash: hash(snapshot), source: { generatedAt: snapshot.generatedAt, model: snapshot.model },
  } };
}
export function failedCase(gc: GoldenCase, status: 'ERROR' | 'SKIPPED', message: string): RunCase {
  return { caseId: gc.id, inputHash: hash(evaluationInput(gc.form)), status, problems: [message], unavailable: ['snapshot'],
    metrics: {}, snapshotHash: null, source: null };
}
export function buildReport(manifest: Manifest, cases: RunCase[], errors: string[]): Report {
  const counts = { PASS: 0, FAIL: 0, ERROR: 0, SKIPPED: 0 };
  for (const c of cases) counts[c.status]++;
  return { schemaVersion: 1, manifest, finishedAt: new Date().toISOString(), errors, cases,
    gate: { pass: errors.length === 0 && cases.length > 0 && cases.length === manifest.caseIds.length && counts.PASS === cases.length,
      counts, totalHard: cases.reduce((n, c) => n + (c.metrics.hard ?? 0), 0), totalSoft: cases.reduce((n, c) => n + (c.metrics.soft ?? 0), 0) } };
}
export async function executeCases(options: {
  manifest: Manifest; directory: string; cases: GoldenCase[];
  load: (gc: GoldenCase) => Promise<unknown | null>;
  signal?: AbortSignal; sanitize?: (error: unknown) => string;
}): Promise<RunCase[]> {
  const outcomes: RunCase[] = [];
  for (const gc of options.cases) {
    let outcome: RunCase;
    try {
      if (options.signal?.aborted) outcome = failedCase(gc, 'SKIPPED', '运行已取消');
      else {
        const value = await options.load(gc);
        if (value === null) outcome = failedCase(gc, 'SKIPPED', '缺少输入快照');
        else {
          // 先保存原始输入，即使解析/检查失败也可复现；与基准目录完全分离。
          writeJson(path.join(options.directory, 'snapshots', `${gc.id}.json`), value);
          outcome = evaluateCase(gc, value, options.manifest.mode === 'live').outcome;
        }
      }
    } catch (error) {
      outcome = failedCase(gc, 'ERROR', options.sanitize?.(error) ?? (error instanceof Error ? error.message : '未知评估错误'));
    }
    outcomes.push(outcome);
    writeJson(path.join(options.directory, 'cases', `${gc.id}.json`), outcome);
    saveReport(options.directory, buildReport(options.manifest, outcomes, []));
    console.log(`${outcome.status} ${gc.id}｜hard ${outcome.metrics.hard ?? '—'}｜soft ${outcome.metrics.soft ?? '—'}`);
    if (outcome.status !== 'PASS') console.log(`  ${outcome.problems.join('\n  ')}`);
  }
  return outcomes;
}
export function saveReport(directory: string, report: Report): void {
  writeJson(path.join(directory, 'manifest.json'), report.manifest);
  writeJson(path.join(directory, 'report.json'), report);
  fs.writeFileSync(path.join(directory, 'report.md'), reportMarkdown(report));
}
