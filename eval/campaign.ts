// 按城市串行执行真实模型矩阵；单批独立库/日志，失败保留，支持断点继续未开始批次。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ROOT, hash, hashSources, readReport, writeJson } from './artifacts';
import { readFrozen } from './frozenKnowledge';
import { MATRIX_CITIES, MATRIX_CASES, NOTE_CASES } from './scenarios';
import { validateAdminUrl } from './isolation';

const { values } = parseArgs({ options: { 'knowledge-snapshot': { type: 'string' }, out: { type: 'string' }, resume: { type: 'string' }, list: { type: 'boolean' } }, strict: true });
const stages = [...MATRIX_CITIES.map(([id, city]) => ({ id, city, suite: 'matrix' })), { id: 'beijing-notes', city: '北京', suite: 'notes' }];
if (values.list) {
  stages.forEach((s) => console.log(`${s.id}：${s.city} ${s.suite} 8 例`));
} else {
  validateAdminUrl(process.env.EVAL_PG_ADMIN_URL);
  const directory = path.resolve(values.resume ?? values.out ?? `eval/runs/campaign-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const previous = values.resume ? JSON.parse(fs.readFileSync(path.join(directory, 'plan.json'), 'utf8')) : null;
  const knowledgeDirectory = path.resolve(values['knowledge-snapshot'] ?? previous?.knowledgeDirectory ?? '');
  if (!values['knowledge-snapshot'] && !previous) throw new Error('需要 --knowledge-snapshot');
  const knowledge = readFrozen(knowledgeDirectory);
  const cities = knowledge.data.cities.filter((c) => c !== '云南');
  if (cities.length !== MATRIX_CITIES.length || cities.some((c) => !MATRIX_CITIES.some(([, city]) => city === c))) {
    throw new Error('冻结库城市集合已变化，请先更新并审核矩阵城市清单（云南除外）');
  }
  const runtimeHash = hashSources(['apps/server/src', 'packages/shared/src', 'eval/run.ts', 'eval/live.ts', 'eval/runner.ts', 'eval/scenarios.ts', 'eval/noteChecks.ts', 'package-lock.json']);
  const plan = { knowledgeDirectory, knowledgeHash: knowledge.contentHash, runtimeHash,
    excludedCities: ['云南'], stages, cases: [...MATRIX_CASES, ...NOTE_CASES] };
  if (previous && hash(previous) !== hash(plan)) throw new Error('代码、输入或知识版本变化，不可混入旧活动；请创建新目录');
  if (!previous) { fs.mkdirSync(directory); writeJson(path.join(directory, 'plan.json'), plan); }
  const lock = path.join(directory, 'campaign.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' });
  let stopped = false;
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => { stopped = true; child?.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const update = () => {
    const results = stages.map((stage) => {
      const file = path.join(directory, stage.id, 'result.json');
      if (!fs.existsSync(file)) return { ...stage, status: 'PENDING', report: null, exitCode: null };
      const result = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...stage, ...result };
    });
    writeJson(path.join(directory, 'campaign.json'), { knowledgeHash: knowledge.contentHash, runtimeHash,
      allExecuted: results.every((r) => r.status !== 'PENDING'), pass: results.every((r) => r.status === 'PASS'), results });
    return results;
  };
  try {
    console.log(`真实评估活动：${directory}`);
    update();
    for (const stage of stages) {
      if (stopped) break;
      const batch = path.join(directory, stage.id);
      if (fs.existsSync(path.join(batch, 'result.json'))) continue; // 已失败的批次也保留，不自动重试覆盖。
      fs.mkdirSync(batch, { recursive: true });
      const existing = fs.readdirSync(batch).filter((name) => fs.statSync(path.join(batch, name)).isDirectory());
      if (existing.length) throw new Error(`批次 ${stage.id} 有未收口的运行；先核对进程和产物，禁止自动重跑`);
      console.log(`开始 ${stage.city} / ${stage.suite}，8 例`);
      const log = fs.createWriteStream(path.join(batch, 'run.log'), { flags: 'wx' });
      const code = await new Promise<number>((resolve) => {
        child = spawn(process.execPath, ['--import', 'tsx', 'eval/run.ts', '--live', '--suite', stage.suite, '--city', stage.city,
          '--knowledge', 'frozen', '--knowledge-snapshot', knowledgeDirectory, '--out', batch], {
          cwd: ROOT, env: { ...process.env, TSX_TSCONFIG_PATH: path.join(ROOT, 'eval/tsconfig.json') }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = (chunk: Buffer) => { const safe = chunk.toString().replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"'<>]+/g, '[endpoint]'); log.write(safe); process.stdout.write(safe); };
        child.stdout!.on('data', output); child.stderr!.on('data', output);
        child.once('error', () => resolve(2)); child.once('exit', (exitCode) => resolve(exitCode ?? 2));
      });
      await new Promise<void>((resolve) => log.end(resolve));
      child = undefined;
      const runs = fs.readdirSync(batch).filter((name) => fs.existsSync(path.join(batch, name, 'report.json')));
      const reportPath = runs.length === 1 ? path.join(batch, runs[0]!, 'report.json') : null;
      const report = reportPath ? readReport(reportPath) : null;
      writeJson(path.join(batch, 'result.json'), { status: code === 0 && report?.gate.pass ? 'PASS' : 'FAIL', exitCode: code,
        report: reportPath ? path.relative(directory, reportPath).replaceAll('\\', '/') : null });
      update();
    }
    process.exitCode = update().every((r) => r.status === 'PASS') ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    fs.unlinkSync(lock);
  }
}
