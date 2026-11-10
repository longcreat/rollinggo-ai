import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { EVAL_DIR, ROOT, createManifest, createRunDirectory, hash, readReport, writeJson } from '../artifacts';
import { GOLDEN_CASES } from '../golden/cases';
import { buildReport, evaluateCase, executeCases, saveReport } from '../runner';
import { compareReports } from '../compare';
import { acceptBaseline } from '../baseline';
import { parseReport, parseSnapshot } from '../contracts';
import { validateAdminUrl } from '../isolation';
import { loadKnowledge } from '../knowledge';
import { sanitizeError } from '../live';
import { currentFixture } from './currentFixture';

const gc = GOLDEN_CASES[0]!;
const load = () => parseSnapshot(JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'snapshots', `${gc.id}.json`), 'utf8')));
function temporary(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rollinggo-trip-eval-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^rollinggo-trip-eval-test-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function cli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'packages/evals/run.ts', ...args], {
    cwd: ROOT, env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 25000,
  });
}
function onlyRun(root: string): string {
  const names = fs.readdirSync(root);
  assert.equal(names.length, 1);
  return path.join(root, names[0]!);
}

test('历史回放保留 PASS，但缺失研究/耗时明确为 unavailable', () => {
  const { outcome } = evaluateCase(gc, load(), false);
  assert.equal(outcome.status, 'PASS');
  assert.equal(outcome.metrics.totalMs, null);
  assert.ok(outcome.unavailable.includes('research'));
  assert.equal(evaluateCase(gc, load(), true).outcome.status, 'ERROR');
});

test('live 必须完整采集三阶段、非空候选与各服务用量', () => {
  const snapshot = currentFixture(gc);
  snapshot.research = { candidates: [{ id: 'poi', name: '测试景点', category: 'attraction', intro: '测试', reservation: 'unknown', sourceLinks: [] }] };
  snapshot.timing = { phases: { 'research#1': 1, 'plan#1': 2, 'review#1': 3 }, totalMs: 4,
    tokensIn: 100, tokensOut: 20, providerCalls: { amap: 0, search: 0, xhs: 0 } };
  assert.equal(evaluateCase(gc, snapshot, true).outcome.status, 'PASS');
  delete snapshot.timing.phases['plan#1'];
  assert.equal(evaluateCase(gc, snapshot, true).outcome.status, 'ERROR');
});

test('错误输入不能套用旧快照；注入超长日被判 FAIL', () => {
  assert.throws(() => evaluateCase({ ...gc, form: { ...gc.form, days: 1 } }, load(), false), /不一致/);
  const snapshot = load();
  snapshot.trip.days[0]!.activities[0]!.startTime = '06:00';
  snapshot.trip.days[0]!.activities[0]!.endTime = '23:30';
  const { outcome } = evaluateCase(gc, snapshot, false);
  assert.equal(outcome.status, 'FAIL');
  assert.ok(outcome.metrics.hard! > 0);
});

test('缺失/损坏/异常样例分别记录，后续样例继续且基准不变', async (t) => {
  const root = temporary(t);
  const cases = GOLDEN_CASES.slice(0, 4);
  const manifest = createManifest(cases, 'offline', 'full');
  const directory = createRunDirectory(manifest, root);
  const originalHash = hash(load());
  const outcomes = await executeCases({ manifest, directory, cases, load: async (item) => {
    if (item.id === cases[0]!.id) return null;
    if (item.id === cases[1]!.id) return { trip: {} };
    if (item.id === cases[2]!.id) throw new Error('模拟来源中断');
    return JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'snapshots', `${item.id}.json`), 'utf8'));
  } });
  assert.deepEqual(outcomes.map((c) => c.status), ['SKIPPED', 'ERROR', 'ERROR', 'PASS']);
  assert.equal(readReport(directory).gate.pass, false);
  assert.equal(hash(load()), originalHash);
  assert.ok(fs.existsSync(path.join(directory, 'snapshots', `${cases[1]!.id}.json`)));
});

test('比较对齐用例并识别硬性退化，缺失观测不产生虚假改善', () => {
  const base = buildReport(createManifest([gc], 'offline', 'full'), [evaluateCase(gc, load(), false).outcome], []);
  const next = structuredClone(base);
  next.cases[0]!.status = 'FAIL';
  next.cases[0]!.metrics.hard = 1;
  const comparison = compareReports(base, next);
  assert.equal(comparison.exitCode, 1);
  assert.equal(comparison.rows[0]!.deltas.hard, 1);
  assert.equal(comparison.rows[0]!.deltas.totalMs, null);
  next.manifest.checksHash = 'changed';
  assert.equal(compareReports(base, next).exitCode, 2);
  next.manifest.checksHash = base.manifest.checksHash;
  next.cases[0]!.inputHash = 'changed';
  assert.equal(compareReports(base, next).rows[0]!.state, 'INCOMPARABLE');
});

test('比较不忽略缺失样例、运行错误和重复 caseId', () => {
  const base = buildReport(createManifest([gc], 'offline', 'full'), [evaluateCase(gc, load(), false).outcome], []);
  const missing = structuredClone(base);
  missing.cases = [];
  assert.equal(compareReports(base, missing).exitCode, 2);
  assert.throws(() => parseReport(missing), /不完整/);
  const duplicate = structuredClone(base);
  duplicate.cases.push(duplicate.cases[0]!);
  assert.throws(() => parseReport(duplicate), /重复/);
  const errored = buildReport(base.manifest, base.cases, ['清理失败']);
  assert.equal(compareReports(base, errored).exitCode, 1);
});

test('基线接纳校验状态与快照完整性，同名拒绝覆盖，副本可以回放', (t) => {
  const root = temporary(t);
  const manifest = createManifest([gc], 'offline', 'full');
  const run = createRunDirectory(manifest, path.join(root, 'runs'));
  const snapshot = load();
  const report = buildReport(manifest, [evaluateCase(gc, snapshot, false).outcome], []);
  writeJson(path.join(run, 'snapshots', `${gc.id}.json`), snapshot);
  saveReport(run, report);
  const baselines = path.join(root, 'baselines');
  const accepted = acceptBaseline(run, 'reviewed', baselines);
  assert.equal(readReport(accepted).gate.pass, true);
  assert.equal(evaluateCase(gc, JSON.parse(fs.readFileSync(path.join(accepted, 'snapshots', `${gc.id}.json`), 'utf8')), false).outcome.status, 'PASS');
  assert.throws(() => acceptBaseline(run, 'reviewed', baselines), /EEXIST/);
  snapshot.model = 'changed-after-eval';
  writeJson(path.join(run, 'snapshots', `${gc.id}.json`), snapshot);
  assert.throws(() => acceptBaseline(run, 'tampered', baselines), /被修改/);
  report.gate.pass = false;
  saveReport(run, report);
  assert.throws(() => acceptBaseline(run, 'failed', baselines), /失败/);
  assert.throws(() => acceptBaseline(run, '../escape', baselines), /名称/);
});

test('管理库地址拒绝应用库/远端/连接重定向参数', () => {
  assert.equal(validateAdminUrl('postgres://postgres@127.0.0.1:5432/postgres').pathname, '/postgres');
  for (const value of [undefined, 'postgres://localhost/rollinggo_trip', 'postgres://db.example/postgres',
    'postgres://localhost/postgres?host=db.example', 'postgres://localhost/postgres?options=-csearch_path=public', 'https://localhost/postgres']) {
    assert.throws(() => validateAdminUrl(value));
  }
});

test('知识库种子可重现且显式空库与默认种子不混淆', () => {
  const first = loadKnowledge('golden'), second = loadKnowledge('golden'), empty = loadKnowledge('empty');
  assert.ok(first.kind === 'legacy');
  assert.equal(first.manifest.rows, 87);
  assert.equal(first.manifest.hash, second.manifest.hash);
  assert.notEqual(first.manifest.hash, empty.manifest.hash);
  assert.equal(empty.places.length, 0);
  assert.equal(new Set(first.places.map((p) => `${p.city}|${p.name}`)).size, first.places.length);
  assert.ok(first.places.every((place) => place.coordSystem === 'gcj02'));
  const fixture = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'fixtures/places.json'), 'utf8'));
  const wgs = fixture.places.find((place: { coordSystem: string }) => place.coordSystem === 'wgs84');
  assert.ok(wgs);
  const converted = first.places.find((place) => place.city === wgs.city && place.name === wgs.name)!;
  assert.notEqual(converted.lng, wgs.lng);
});

test('错误信息隐藏凭据与连接串', (t) => {
  const previous = process.env.EVAL_TEST_TOKEN;
  const previousPg = process.env.POSTGRES_PASSWORD;
  process.env.EVAL_TEST_TOKEN = 'secret-test-value';
  // 真实环境里数据库口令常与 URL scheme 同名（compose 默认 postgres），先替换会打坏 URL 再漏出密码。
  process.env.POSTGRES_PASSWORD = 'postgres';
  t.after(() => {
    if (previous === undefined) delete process.env.EVAL_TEST_TOKEN; else process.env.EVAL_TEST_TOKEN = previous;
    if (previousPg === undefined) delete process.env.POSTGRES_PASSWORD; else process.env.POSTGRES_PASSWORD = previousPg;
  });
  const result = sanitizeError(new Error('bad secret-test-value postgres://user:password@localhost/app https://service/?key=value'));
  assert.ok(!result.includes('secret-test-value') && !result.includes('password') && !result.includes('key=value'));
  assert.ok(result.includes('[endpoint]'), '端点整体替换，不残留 URL 片段');
});

test('CLI smoke 保存 3 例与独立运行目录', (t) => {
  const root = temporary(t);
  const result = cli(['--suite', 'smoke', '--out', root]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = readReport(onlyRun(root));
  assert.equal(report.cases.length, 3);
  assert.equal(report.gate.pass, true);
});

test('CLI 缺失快照返回非零并输出完整报告', (t) => {
  const root = temporary(t), input = path.join(root, 'input'), out = path.join(root, 'out');
  fs.mkdirSync(input);
  const result = cli(['--case', gc.id, '--snapshots', input, '--out', out]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(readReport(onlyRun(out)).cases[0]!.status, 'SKIPPED');
});

test('CLI 拒绝未知参数与无效用例，不会静默跑全量', () => {
  assert.equal(cli(['--case']).status, 2);
  assert.equal(cli(['--case', 'unknown']).status, 2);
  assert.equal(cli(['--sutie', 'smoke']).status, 2);
});

test('live 未指定隔离管理库时不会连接应用库，并保留失败报告', (t) => {
  const root = temporary(t);
  const result = cli(['--live', '--case', gc.id, '--out', root], {
    EVAL_PG_ADMIN_URL: '', DATABASE_URL: 'postgres://blocked:blocked@invalid.example/application',
  });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const report = readReport(onlyRun(root));
  assert.equal(report.cases[0]!.status, 'ERROR');
  assert.match(report.errors[0]!, /EVAL_PG_ADMIN_URL/);
  assert.ok(!JSON.stringify(report).includes('blocked'));
});

test('CLI 损坏 JSON 保留原文且 ERROR 返回 2', (t) => {
  const root = temporary(t), input = path.join(root, 'input'), out = path.join(root, 'out');
  fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, `${gc.id}.json`), '{broken');
  const result = cli(['--case', gc.id, '--snapshots', input, '--out', out]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const run = onlyRun(out);
  assert.equal(readReport(run).cases[0]!.status, 'ERROR');
  assert.equal(fs.readFileSync(path.join(run, 'inputs', `${gc.id}.invalid.json.txt`), 'utf8'), '{broken');
});
