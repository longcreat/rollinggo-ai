import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { GoldenCase } from './golden/cases';
import { parseReport, type Manifest, type Report } from './contracts';
import { SUITES } from './scenarios';
import { evaluationInput } from './input';

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(EVAL_DIR);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hash = (value: unknown): string => crypto.createHash('sha256').update(canonical(value)).digest('hex');

function sourceFiles(relative: string): string[] {
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) return [];
  if (!fs.statSync(full).isDirectory()) return [relative];
  return fs.readdirSync(full).sort().flatMap((name) => sourceFiles(path.join(relative, name)));
}
export function hashSources(paths: string[]): string {
  return hash(paths.flatMap(sourceFiles).sort().map((file) => [file.replaceAll('\\', '/'),
    fs.readFileSync(path.join(ROOT, file), 'utf8').replaceAll('\r\n', '\n')]));
}
export function createManifest(cases: GoldenCase[], mode: Manifest['mode'], suite: Manifest['suite']): Manifest {
  let head: string | null = null;
  let dirty: boolean | null = null;
  try {
    const git = (args: string[]) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    head = git(['rev-parse', 'HEAD']);
    dirty = git(['status', '--porcelain']).length > 0;
  } catch { /* 无 Git 的部署包仍可用内容 hash 追溯。 */ }
  const startedAt = new Date().toISOString();
  return {
    schemaVersion: 1, snapshotVersion: 3,
    runId: `${startedAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`,
    startedAt, mode, suite, caseIds: cases.map((c) => c.id), datasetHash: hash(cases.map((c) => ({ id: c.id, form: evaluationInput(c.form) }))),
    checksHash: hashSources(['eval/checks.ts', 'eval/coverage.ts', 'eval/input.ts', 'eval/currentFlow.ts', 'eval/noteChecks.ts', 'eval/scenarios.ts', 'eval/contracts.ts', 'eval/runner.ts', 'apps/server/src/generation/mealPlanning.ts', 'packages/shared/src']),
    promptHash: hashSources(['apps/server/src/generation/prompts.ts']),
    runtimeHash: hashSources(['apps/server/src', 'packages/shared/src', 'package-lock.json',
      ...fs.readdirSync(EVAL_DIR).filter((f) => f.endsWith('.ts')).map((f) => `eval/${f}`)]),
    code: { head, dirty }, knowledge: { mode: 'historical-snapshots', hash: 'unavailable', rows: 0 },
    configuration: {},
  };
}
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}
export function createRunDirectory(manifest: Manifest, root = path.join(EVAL_DIR, 'runs')): string {
  fs.mkdirSync(root, { recursive: true });
  const directory = path.join(root, manifest.runId);
  fs.mkdirSync(directory); // 不允许复用或覆盖已有运行。
  writeJson(path.join(directory, 'manifest.json'), manifest);
  return directory;
}
export function reportPath(target: string): string {
  return fs.statSync(target).isDirectory() ? path.join(target, 'report.json') : target;
}
export function readReport(target: string): Report {
  return parseReport(JSON.parse(fs.readFileSync(reportPath(target), 'utf8')));
}
export function reportMarkdown(report: Report): string {
  const metric = (value: number | null | undefined) => value == null ? '—' : String(Math.round(value * 1000) / 1000);
  const escape = (s: string) => s.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
  const suiteSize = SUITES[report.manifest.suite].length;
  const scope = report.manifest.caseIds.length === suiteSize ? `${report.manifest.suite} 全组 ${suiteSize} 例`
    : `${report.manifest.caseIds.length === 1 ? '单例' : '部分用例'}（从 ${report.manifest.suite} ${suiteSize} 例中选择 ${report.manifest.caseIds.length} 例）`;
  const dayRows = report.cases.flatMap((c) => Object.keys(c.metrics).filter((key) => /^day\.\d+\.activities$/.test(key)).sort(
    (a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1])).map((key) => {
    const day = key.split('.')[1];
    const m = (field: string) => metric(c.metrics[`day.${day}.${field}`]);
    return `| ${c.caseId} D${day} | ${m('activities')} | ${m('timedActivities')} | ${m('activityMinutes')} | ${m('betweenActivityMinutes')} | ${m('betweenActivityKm')} | ${m('lodgingMinutes')} |`;
  }));
  return [
    `# 评估 ${report.manifest.runId}`, '',
    `模式：${report.manifest.mode}；范围：${scope}；当前检查门槛：${report.gate.pass ? 'PASS' : 'FAIL'}`, '',
    report.manifest.mode === 'offline' ? '输入：已保存行程快照；本次未加载知识库，原生成的知识条件请查来源运行。' :
      `知识库：${report.manifest.knowledge.mode}；地点 ${report.manifest.knowledge.rows}` +
      (report.manifest.knowledge.snapshotName ? `；版本 ${report.manifest.knowledge.snapshotName}；证据 ${report.manifest.knowledge.evidenceRows}；关系 ${report.manifest.knowledge.relationRows}；向量 ${report.manifest.knowledge.vectorMode}` : ''), '',
    report.manifest.mode === 'live' ? '本次执行了生成链路；阶段耗时包含并行部分，不能直接相加。'
      : '本次离线重放已保存行程，未重新调用模型、地图或执行生成链路；表内生成耗时与 token 来自原快照。', '',
    'PASS 仅表示可判定的当前门槛通过；未评估项见下方说明。— 表示缺数据或不适用，不是 0。候选采用率表示活动名称命中候选池的比例，不是候选池使用率或地点准确率。', '',
    '| 用例 | 状态 | hard | soft | 坐标覆盖率 | 候选采用率 | 生成总耗时 ms | token 入/出 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.cases.map((c) => `| ${c.caseId} | ${c.status} | ${metric(c.metrics.hard)} | ${metric(c.metrics.soft)} | ${metric(c.metrics.locatedRatio)} | ${metric(c.metrics.adoptionRatio)} | ${metric(c.metrics.totalMs)} | ${metric(c.metrics.tokensIn)}/${metric(c.metrics.tokensOut)} |`), '',
    '## 当前流程检查', '',
    'FAIL 表示当前功能契约违规；DEGRADED 表示增强功能降级；UNAVAILABLE 表示没有执行证据；NOT_APPLICABLE 表示本次输入不要求该功能。预算不参与评估。', '',
    '| 用例 | 环节 | 状态 | 依据 |', '| --- | --- | --- | --- |',
    ...report.cases.flatMap((c) => (c.flow ?? []).map((row) => `| ${c.caseId} | ${row.label} | ${row.status} | ${escape(row.detail)} |`)), '',
    '此生成报告不覆盖首页交互、刷新恢复或详情编辑；这些流程由 npm run eval:flow 的独立场景实际执行并汇总。', '',
    ...(dayRows.length ? ['## 每日时间与交通覆盖', '',
      '| 用例 / 天 | 活动数 | 有时刻活动数 | 已知活动时长 min | 活动间交通 min | 活动间距离 km | 住宿往返 min |',
      '| --- | --- | --- | --- | --- | --- | --- |', ...dayRows, '',
      '活动间交通按已保存路段统计，不含未记录的住宿往返、等候或游玩时长。', ''] : []),
    ...(report.cases.some((c) => c.limitations?.length) ? ['## 评估范围限制', '',
      ...report.cases.flatMap((c) => (c.limitations ?? []).map((note) => `- ${c.caseId}：${escape(note)}`)), ''] : []),
    ...report.errors.map((e) => `- 运行错误：${escape(e)}`),
    ...report.cases.flatMap((c) => [...c.problems.map((p) => `- ${c.caseId}：${escape(p)}`),
      ...(c.unavailable.length ? [`- ${c.caseId} 缺少观测：${c.unavailable.join(', ')}`] : [])]), '',
  ].join('\n');
}
