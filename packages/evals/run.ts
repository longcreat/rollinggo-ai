import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SUITES, type Suite } from './scenarios';
import { EVAL_DIR, createManifest, createRunDirectory, readReport, writeJson } from './artifacts';
import { buildReport, executeCases, failedCase, saveReport } from './runner';
import { compareReports, comparisonMarkdown } from './compare';
import type { RunCase } from './contracts';

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    live: { type: 'boolean', default: false }, case: { type: 'string' }, suite: { type: 'string', default: 'full' }, city: { type: 'string' },
    snapshots: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' },
    knowledge: { type: 'string', default: 'golden' }, 'allow-no-geo': { type: 'boolean', default: false },
    'knowledge-snapshot': { type: 'string' }, 'skip-vectors': { type: 'boolean', default: false },
    'timeout-ms': { type: 'string', default: '600000' }, help: { type: 'boolean', default: false },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    console.log('npm run eval -- [--suite smoke|full|matrix|notes] [--city 城市] [--case id] [--snapshots 目录] [--baseline 目录] [--out 目录]\n' +
      'npm run eval:live -- [--suite smoke|full|matrix|notes] [--knowledge golden|empty|frozen] [--knowledge-snapshot 目录] [--skip-vectors] [--timeout-ms 600000] [--allow-no-geo]\n' +
      'live 必须设置 EVAL_PG_ADMIN_URL；每次运行保存到独立目录，不覆盖快照或基线。');
    return 0;
  }
  if (!Object.hasOwn(SUITES, values.suite)) throw new Error('--suite 仅支持 smoke/full/matrix/notes');
  const suite = values.suite as Suite;
  if (values.knowledge !== 'golden' && values.knowledge !== 'empty' && values.knowledge !== 'frozen') throw new Error('--knowledge 仅支持 golden/empty/frozen');
  if (values.knowledge === 'frozen' && (!values.live || !values['knowledge-snapshot'])) throw new Error('frozen 必须搭配 --live 与 --knowledge-snapshot');
  if (values.knowledge !== 'frozen' && (values['knowledge-snapshot'] || values['skip-vectors'])) throw new Error('知识库副本/向量参数只能用于 --knowledge frozen');
  if (values.live && values.snapshots) throw new Error('--live 不能搭配 --snapshots');
  const timeoutMs = Number(values['timeout-ms']);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('--timeout-ms 必须在 1000–600000 之间');
  const cases = SUITES[suite].filter((c) => (!values.case || c.id === values.case) && (!values.city || c.form.destination === values.city));
  if (!cases.length) throw new Error(`没有匹配的用例；可用：${SUITES[suite].map((c) => c.id).join(', ')}`);
  const manifest = createManifest(cases, values.live ? 'live' : 'offline', suite);
  const directory = createRunDirectory(manifest, values.out ? path.resolve(values.out) : undefined);
  console.log(`运行目录：${directory}`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let live: Awaited<ReturnType<typeof import('./live')['startLive']>> | undefined;
  let outcomes: RunCase[] = [];
  const errors: string[] = [];
  let sanitize = (error: unknown) => error instanceof Error ? error.message : '未知评估错误';
  try {
    if (values.live) {
      const adapter = await import('./live');
      sanitize = adapter.sanitizeError;
      live = await adapter.startLive({ directory, manifest, knowledge: values.knowledge, allowNoGeo: values['allow-no-geo'], timeoutMs,
        knowledgeSnapshot: values['knowledge-snapshot'], skipVectors: values['skip-vectors'], cities: [...new Set(cases.map((c) => c.form.destination))] });
    }
    const snapshotDirectory = values.snapshots ? path.resolve(values.snapshots) : path.join(EVAL_DIR, 'snapshots');
    outcomes = await executeCases({ manifest, directory, cases, signal: controller.signal, sanitize,
      load: async (gc) => {
        if (live) return live.generate(gc, controller.signal);
        const file = path.join(snapshotDirectory, `${gc.id}.json`);
        if (!fs.existsSync(file)) return null;
        const raw = fs.readFileSync(file, 'utf8');
        try { return JSON.parse(raw); }
        catch {
          fs.mkdirSync(path.join(directory, 'inputs'), { recursive: true });
          fs.writeFileSync(path.join(directory, 'inputs', `${gc.id}.invalid.json.txt`), raw);
          throw new Error('快照 JSON 损坏，原始输入已保存在 inputs/');
        }
      },
    });
  } catch (error) {
    errors.push(sanitize(error));
    for (const gc of cases) if (!outcomes.some((c) => c.caseId === gc.id)) outcomes.push(failedCase(gc, 'ERROR', errors.at(-1)!));
  } finally {
    try { await live?.close(); } catch (error) { errors.push(`清理失败：${sanitize(error)}`); }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  let report = buildReport(manifest, outcomes, errors);
  for (const outcome of outcomes) writeJson(path.join(directory, 'cases', `${outcome.caseId}.json`), outcome);
  saveReport(directory, report);
  let exitCode = errors.length || report.gate.counts.ERROR ? 2 : report.gate.pass ? 0 : 1;
  if (values.baseline) {
    try {
      const comparison = compareReports(readReport(path.resolve(values.baseline)), report);
      writeJson(path.join(directory, 'comparison.json'), comparison);
      fs.writeFileSync(path.join(directory, 'comparison.md'), comparisonMarkdown(comparison));
      exitCode = Math.max(exitCode, comparison.exitCode);
      console.log(`比较结果：${comparison.incompatible ? '不可比' : comparison.regression ? '出现退化' : '无新增硬性退化'}`);
    } catch (error) {
      errors.push(`基线比较失败：${sanitize(error)}`);
      report = buildReport(manifest, outcomes, errors);
      saveReport(directory, report);
      exitCode = 2;
    }
  }
  console.log(`门槛 ${report.gate.pass ? 'PASS' : 'FAIL'}｜hard ${report.gate.totalHard}｜soft ${report.gate.totalSoft}`);
  for (const error of errors) console.error(error);
  console.log(`报告：${path.join(directory, 'report.md')}`);
  return exitCode;
}
main().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '评估入口失败');
  process.exitCode = 2;
});
