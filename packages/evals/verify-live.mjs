// 真 PostgreSQL + 本机 mock LLM 验证，不访问真实模型/地图，不加载应用凭据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'knowledge-snapshot': { type: 'string' }, 'skip-vectors': { type: 'boolean', default: false },
  'research-response': { type: 'string', default: 'tool' } }, strict: true });
assert.ok(['tool', 'text-first', 'text-only'].includes(values['research-response']), '无效的 research-response');
const frozenDirectory = values['knowledge-snapshot'];
if (values['skip-vectors'] && !frozenDirectory) throw new Error('--skip-vectors 需要 --knowledge-snapshot');

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const output = path.join(root, 'packages/evals/runs', `verify-live-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const auditFile = path.join(output, 'connections.txt');
const adminUrl = process.env.EVAL_PG_ADMIN_URL;
if (!adminUrl) throw new Error('eval:verify 需要 EVAL_PG_ADMIN_URL 指向本机 /postgres 管理库');
const parsed = new URL(adminUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && parsed.pathname === '/postgres' && !parsed.search);
const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
let researchRequests = 0;
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const data of req) raw += data;
    const body = JSON.parse(raw);
    const tools = new Set((body.tools ?? []).map((tool) => tool.function?.name));
    const isWriter = tools.has('update_titles');
    const isPlanner = tools.has('plan_day') && tools.has('submit_plan');
    const isResearch = tools.has('submit_research');
    // 只统计调研阶段的请求：别的阶段也可能带相似工具，按 submit_research 判定。
    if (isResearch) researchRequests++;
    const textOf = (message) => {
      const content = message?.content;
      if (typeof content === 'string') return content;
      return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
    };
    const promptText = body.messages.map(textOf).join('\n');
    const toolTexts = body.messages.filter((message) => message.role === 'tool').map(textOf);

    // 提交成功后用纯文本收尾，避免 mock 在 turn limit 内反复 submit。
    const submitted = toolTexts.some((text) => text.includes('已提交') || text.includes('"ok":true'));
    let call;
    if (submitted) {
      call = undefined;
    } else if (isWriter) {
      call = { name: 'update_titles', arguments: JSON.stringify({ title: '广州一日漫游', dayTitles: ['广州老城漫步'] }) };
    } else if (isPlanner) {
      const areasText = toolTexts.find((text) => text.includes('"areas"'));
      if (!areasText) {
        call = { name: 'list_areas', arguments: '{}' };
      } else {
        const areas = JSON.parse(areasText.slice(areasText.indexOf('{'), areasText.lastIndexOf('}') + 1)).areas ?? [];
        const area = areas.find((item) => (item.candidates?.length ?? 0) >= 2) ?? areas[0];
        const planned = toolTexts.some((text) => text.includes('"dayIndex"'));
        if (!area || planned) {
          call = { name: 'submit_plan', arguments: '{}' };
        } else {
          const places = area.candidates.length >= 2
            ? area.candidates.slice(0, 3)
            : areas.flatMap((item) => item.candidates ?? []).slice(0, 3);
          call = {
            name: 'plan_day',
            arguments: JSON.stringify({ dayIndex: 1, areaId: area.id, places, startAt: '09:00' }),
          };
        }
      }
    } else if (isResearch) {
      const ids = [...new Set([...JSON.stringify(body.messages).matchAll(/id=([a-zA-Z0-9_-]+)/g)].map((m) => m[1]))].slice(0, 4);
      call = { name: 'submit_research', arguments: JSON.stringify({ candidates: ids.map((placeId) => ({ placeId, intro: '历史街区与城市景点，适合步行参观并体验当地文化。' })), summary: '本机模拟评估' }) };
    }
    const researchTextOnly = isResearch && (values['research-response'] === 'text-only' ||
      (values['research-response'] === 'text-first' && researchRequests === 1));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'eval-mock', object: 'chat.completion.chunk', created: 1, model: 'eval-mock' };
    // 未覆盖的阶段（建议撰写等）回纯文本：允许流水线按现有降级路径继续。
    const textOnly = !call || researchTextOnly;
    const content = call ? `\`\`\`json\n${call.arguments}\n\`\`\`` : '（模拟阶段输出）';
    for (const chunk of [
      { choices: [{ index: 0, delta: textOnly ? { role: 'assistant', content } : { role: 'assistant', content: '', tool_calls: [{ index: 0, id: `eval-call-${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: call }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: textOnly ? 'stop' : 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
    ]) res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch { res.writeHead(500).end(); }
});
await admin.connect();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const env = {
  ...process.env, EVAL_CONNECTION_AUDIT: auditFile,
  EVAL_VERIFY_GEO: 'fixture',
  DATABASE_URL: 'postgres://forbidden:forbidden@127.0.0.1:1/application_must_not_connect',
  SITE_LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, SITE_LLM_API_KEY: 'mock-secret-do-not-log', SITE_LLM_MODEL: 'eval-mock',
  AMAP_KEY: '', SEARCH_API_KEY: '', EMBEDDING_BASE_URL: '', EMBEDDING_API_KEY: '', EMBEDDING_MODEL: '',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: 'localhost,127.0.0.1,::1',
};
let child;
try {
  child = spawn(process.execPath, ['--import', 'tsx', '--import', './packages/evals/tests/live-guard.mjs', 'packages/evals/run.ts',
    '--live', '--case', 'guangzhou-1d-walk', '--allow-no-geo', '--timeout-ms', '30000', '--out', output,
    ...(frozenDirectory ? ['--knowledge', 'frozen', '--knowledge-snapshot', frozenDirectory] : []),
    ...(values['skip-vectors'] ? ['--skip-vectors'] : [])],
  { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill(), frozenDirectory ? 180000 : 60000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  const runName = fs.readdirSync(output).find((name) => fs.statSync(path.join(output, name)).isDirectory());
  assert.ok(runName, stdout + stderr);
  const run = path.join(output, runName);
  const report = JSON.parse(fs.readFileSync(path.join(run, 'report.json'), 'utf8'));
  const rejected = values['research-response'] === 'text-only';
  assert.equal(code, rejected ? 2 : 0, stdout + stderr + JSON.stringify(report.errors));
  assert.equal(report.gate.pass, !rejected, stdout + stderr);
  const expectedRows = frozenDirectory ? JSON.parse(fs.readFileSync(path.join(frozenDirectory, 'manifest.json'), 'utf8')).counts.places : 87;
  assert.equal(report.manifest.knowledge.rows, expectedRows);
  if (frozenDirectory) assert.equal(report.manifest.knowledge.mode, 'frozen');
  const events = JSON.parse(fs.readFileSync(path.join(run, 'events/guangzhou-1d-walk.json'), 'utf8'));
  let snapshot;
  if (rejected) {
    assert.equal(report.cases[0].status, 'ERROR');
    assert.ok(report.cases[0].problems.some((problem) => problem.includes('submit_research')));
    assert.equal(events.terminal, 'error');
    assert.ok(!events.events.some((event) => event.type === 'phase_start' && event.phase === 'plan'));
    assert.ok(!fs.existsSync(path.join(run, 'snapshots/guangzhou-1d-walk.json')), '空池不能生成占位行程');
  } else {
    assert.equal(report.cases[0].unavailable.length, 0);
    snapshot = JSON.parse(fs.readFileSync(path.join(run, 'snapshots/guangzhou-1d-walk.json'), 'utf8'));
    assert.ok(snapshot.research.candidates.length > 0);
    assert.ok(snapshot.timing.totalMs > 0);
    assert.ok(snapshot.timing.tokensIn > 0);
    assert.ok(snapshot.timing.phases['plan#1'] >= 0);
    assert.equal(snapshot.execution.auditCommitted, true);
    assert.equal(snapshot.execution.overviewMatches, true);
    // 当前规划阶段由模型选点/排程，必须真的有模型响应（旧的确定性排程已退出主链）。
    assert.ok(snapshot.execution.planLlmCalls > 0, `规划阶段应调用模型，实际 ${snapshot.execution.planLlmCalls}`);
    assert.equal(report.cases[0].metrics.flowFailures, 0);
    assert.ok(report.cases[0].flow.some((row) => row.id === 'persistence' && row.status === 'PASS'));
    assert.ok(events.events.some((event) => event.type === 'tool_end' && event.tool === 'submit_research'));
  }
  assert.equal(researchRequests, values['research-response'] === 'tool' ? 1 : 2);
  assert.equal(events.events.filter((event) => event.type === 'llm_response' && event.phase === 'research').length, researchRequests);
  const connections = fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/);
  const databases = [...new Set(connections.filter((name) => name !== 'postgres'))];
  assert.equal(databases.length, 1);
  const remaining = await admin.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[])', [databases]);
  assert.equal(remaining.rows.length, 0, '评估库没有清理');
  assert.ok(!fs.existsSync(path.join(root, 'packages/evals/data/live.lock')));
  const artifacts = JSON.stringify(report) + JSON.stringify(snapshot) + JSON.stringify(events) + stdout + stderr;
  assert.ok(!artifacts.includes('mock-secret-do-not-log') && !artifacts.includes('application_must_not_connect'));
  console.log(`PASS live mock (${values['research-response']})：${rejected ? '未提交时在调研阶段失败，未生成占位行程' : `候选 ${snapshot.research.candidates.length}，阶段耗时与用量已采集`}；仅连接管理库/评估库，评估库已清理。\n报告：${run}`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await admin.end();
}
