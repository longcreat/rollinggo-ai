// 当前用户流程的验证入口；复用维护中的脚本，独立报告，不伪装成模型质量分数。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ROOT, hashSources, writeJson } from './artifacts';
import { validateAdminUrl } from './isolation';

const { values } = parseArgs({ options: { 'no-browser': { type: 'boolean' }, list: { type: 'boolean' } }, strict: true });
const node = (...args: string[]) => [process.execPath, ...args];
const script = (file: string, ...args: string[]) => node('--import', './scripts/lib/local-fetch-only.mjs', '--import', 'tsx', file, ...args);
const stages = [
  { id: 'eval', label: '评估器、兼容数据和流程判定', command: node('--import', 'tsx', '--test',
    ...fs.readdirSync(path.join(ROOT, 'eval/tests')).filter((f) => f.endsWith('.test.ts')).map((f) => `eval/tests/${f}`), 'apps/server/src/__tests__/evalChecks.test.ts') },
  { id: 'generation-units', label: '输入转换、检索/调研、节奏/闭馆/餐次、路线/照片复用、导出', command: script('scripts/verify-sql-first.mts', '--flow') },
  { id: 'transactions', label: '完整生成、原子保存、修订版本、失败/取消与 SSE', command: script('scripts/verify-generation-flow.mts') },
  { id: 'live', label: 'live 采集、最终行程契约、成功审计读回', command: script('eval/verify-live.mjs') },
  { id: 'research-recovery', label: '调研未提交的同上下文纠正', command: script('eval/verify-live.mjs', '--research-response', 'text-first') },
  { id: 'research-rejection', label: '调研持续未提交时停止生成', command: script('eval/verify-live.mjs', '--research-response', 'text-only') },
  { id: 'preferences', label: '账号偏好保存、人数/节奏、跨账号隔离', command: script('scripts/verify-travel-preferences.mts') },
  { id: 'route-options', label: '详情路线选项、权限和降级', command: script('scripts/verify-route-options.mts') },
  { id: 'weather', label: '天气日期匹配、缓存、刷新和服务降级', command: script('scripts/verify-trip-weather.mts') },
  { id: 'build', label: '生产前端构建', browser: true, command: node(process.env.npm_execpath ?? '', 'run', 'build') },
  { id: 'homepage', label: '首页→Brief→生成→详情、刷新恢复、取消重试', browser: true, command: script('scripts/verify-generation-browser.mjs') },
  { id: 'detail', label: '详情对话、真实候选添加、保存并发和版本恢复', browser: true, command: script('scripts/verify-detail-chat.mts') },
];
if (values.list) {
  for (const stage of stages) console.log(`${stage.id}：${stage.label}`);
} else {
  validateAdminUrl(process.env.EVAL_PG_ADMIN_URL);
  if (!values['no-browser'] && !process.env.npm_execpath) throw new Error('请通过 npm run eval:flow 执行（需要构建前端）');
  const id = `flow-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const directory = path.join(ROOT, 'eval/runs', id);
  fs.mkdirSync(directory, { recursive: true });
  const env = { ...process.env,
    VERIFY_GENERATION_ADMIN_URL: process.env.EVAL_PG_ADMIN_URL,
    VERIFY_PREFERENCES_ADMIN_URL: process.env.EVAL_PG_ADMIN_URL,
    WEATHER_TEST_ADMIN_URL: process.env.EVAL_PG_ADMIN_URL,
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(ROOT, 'scripts/lib/local-fetch-only.mjs')).href}`,
    TSX_TSCONFIG_PATH: path.join(ROOT, 'eval/tsconfig.json'),
    // 所有脚本必须自建专用库；意外导入应用连接会连接失败，不能退回应用数据库。
    DATABASE_URL: 'postgres://forbidden:forbidden@127.0.0.1:1/application_must_not_connect',
    DOTENV_CONFIG_PATH: path.join(directory, 'absent.env'),
    MASTER_KEY: 'a'.repeat(64), REGISTRATION_MODE: 'open', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
    SITE_LLM_BASE_URL: '', SITE_LLM_API_KEY: '', SITE_LLM_MODEL: '', AMAP_KEY: '',
    SEARCH_API_KEY: '', SEARCH_API_BASE_URL: '', EMBEDDING_BASE_URL: '', EMBEDDING_API_KEY: '', EMBEDDING_MODEL: '',
    IMAGE_API_KEY: '',
    QWEATHER_KEY: '', QWEATHER_API_HOST: '', QWEATHER_JWT_KEY_ID: '', QWEATHER_JWT_PROJECT_ID: '', QWEATHER_JWT_DEVELOPER_ID: '', QWEATHER_JWT_PRIVATE_KEY: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: 'localhost,127.0.0.1,::1',
  };
  const results: Array<{ id: string; label: string; status: string; durationMs: number; log: string }> = [];
  const runtimeHash = hashSources(['eval/flow.ts', 'eval/currentFlow.ts', 'scripts', 'apps/server/src', 'apps/web/src', 'packages/shared/src']);
  const save = () => {
    const complete = results.length === stages.length && results.every((r) => r.status === 'PASS');
    const status = results.some((r) => r.status === 'FAIL') ? 'FAIL' : complete ? 'PASS' : 'PARTIAL';
    writeJson(path.join(directory, 'flow-report.json'), { id, status, complete, runtimeHash, results });
    fs.writeFileSync(path.join(directory, 'flow-report.md'), ['# 当前功能流程验证', '', `状态：${status}；完整执行：${complete}`, '',
      '预算功能已删除，不评估预算。所有模型、地图、天气调用均为受控 mock；本报告验证当前流程，不代表真实服务质量。', '',
      '| 环节 | 状态 | 耗时 ms | 日志 |', '| --- | --- | --- | --- |',
      ...results.map((r) => `| ${r.label} | ${r.status} | ${r.durationMs} | [${r.id}](${r.log}) |`), '',
      '仅当所有环节 PASS 才是完整流程通过；--no-browser 会明确留下 PARTIAL。真实知识内容/向量用 eval:knowledge:verify，真实模型质量用同版本 frozen live 单独验证。', ''].join('\n'));
  };
  console.log(`流程报告目录：${directory}`);
  for (const stage of stages) {
    const log = `${stage.id}.log`;
    if (stage.browser && (values['no-browser'] || (stage.id !== 'build' && results.find((r) => r.id === 'build')?.status !== 'PASS'))) {
      results.push({ id: stage.id, label: stage.label, status: 'SKIPPED', durationMs: 0, log });
      fs.writeFileSync(path.join(directory, log), '浏览器显式跳过，或构建失败。'); save(); continue;
    }
    console.log(`开始 ${stage.id}：${stage.label}`);
    const start = Date.now();
    let output = '';
    const [command, ...args] = stage.command;
    const code = await new Promise<number>((resolve) => {
      const child = spawn(command!, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      child.once('error', (error) => { output += error.message; resolve(1); });
      child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    // 日志仅需结果；连接串/URL 统一隐藏，避免脚本异常回显环境或凭据。
    output = output.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"'<>]+/g, '[endpoint]');
    fs.writeFileSync(path.join(directory, log), output);
    results.push({ id: stage.id, label: stage.label, status: code === 0 ? 'PASS' : 'FAIL', durationMs: Date.now() - start, log });
    save(); console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${stage.id}`);
  }
  process.exitCode = results.some((r) => r.status === 'FAIL') ? 1 : 0;
  console.log(`报告：${path.join(directory, 'flow-report.md')}`);
}
