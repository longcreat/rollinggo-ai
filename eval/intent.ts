import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AssertionError } from 'node:assert';
import { parseArgs } from 'node:util';
import { createRunDirectory, createManifest, hash, hashSources, writeJson } from './artifacts';
import { parseSnapshot } from './contracts';
import { loadLiveCredentials, sanitizeError } from './live';
import { intentCases } from './intentCases';

const { values } = parseArgs({ options: { snapshot: { type: 'string' }, out: { type: 'string' }, repeat: { type: 'string', default: '2' }, case: { type: 'string' } }, strict: true });
if (!values.snapshot) throw new Error('需要 --snapshot 已生成北京行程快照');
const snapshot = parseSnapshot(JSON.parse(fs.readFileSync(values.snapshot, 'utf8')));
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 3) throw new Error('--repeat 仅支持 1–3');
const cases = intentCases(snapshot.trip).filter((c) => !values.case || c.id === values.case);
if (!cases.length) throw new Error('没有匹配的意图用例');
loadLiveCredentials();
if (!process.env.SITE_LLM_BASE_URL || !process.env.SITE_LLM_API_KEY || !process.env.SITE_LLM_MODEL) throw new Error('真实意图验证需要 SITE_LLM_*');
Object.assign(process.env, { MASTER_KEY: crypto.randomBytes(32).toString('hex'), DATABASE_URL: 'postgres://forbidden:forbidden@127.0.0.1:1/intent_must_not_connect',
  DOTENV_CONFIG_PATH: path.resolve('eval/data/absent-intent.env'), REGISTRATION_MODE: 'open' });
await import('../apps/server/src/lib/proxy');
const { understandMessage } = await import('../apps/server/src/chat/understanding');
const { applyDialogueDecision } = await import('../apps/server/src/chat/brief');
const manifest = createManifest([], 'live', 'notes');
const directory = createRunDirectory(manifest, values.out ? path.resolve(values.out) : undefined);
const metadata = { model: process.env.SITE_LLM_MODEL, fixtureHash: hash(snapshot), repeat,
  runtimeHash: hashSources(['apps/server/src/chat', 'apps/server/src/generation/agents', 'apps/server/src/generation/model.ts', 'eval/intent.ts', 'eval/intentCases.ts']),
  expected: cases.length * repeat, path: '真实 understandMessage；不执行修改、不连接数据库；首页备注另由生成用例验证' };
const results: object[] = [];
let failed = 0;
console.log(`意图报告目录：${directory}`);
for (const c of cases) for (let attempt = 1; attempt <= repeat; attempt++) {
  const start = Date.now();
  let observation: object = {};
  let status = 'PASS';
  let problem = '';
  try {
    const outcome = await understandMessage({ cfg: { baseUrl: process.env.SITE_LLM_BASE_URL!, apiKey: process.env.SITE_LLM_API_KEY!, model: process.env.SITE_LLM_MODEL!, byok: false },
      brief: structuredClone(c.brief), history: c.history ?? [], userText: c.text, signal: AbortSignal.timeout(120000),
      ...(c.path === 'detail' ? { currentTrip: snapshot.trip, detailMode: true } : {}) });
    const next = applyDialogueDecision(c.brief, outcome.decision, 10);
    observation = { intent: outcome.intent, reply: outcome.reply, decision: outcome.decision, editOps: outcome.editOps,
      clarification: outcome.clarification, nextBrief: next, tokensIn: outcome.tokensIn, tokensOut: outcome.tokensOut };
    c.check(outcome, next);
  } catch (error) { status = error instanceof AssertionError ? 'FAIL' : 'ERROR'; problem = sanitizeError(error); failed++; }
  results.push({ id: c.id, path: c.path, attempt, input: { text: c.text, brief: c.brief, history: c.history ?? [] }, expected: c.expected,
    status, problem, durationMs: Date.now() - start, observation });
  writeJson(path.join(directory, 'intent-report.json'), { ...metadata, complete: results.length === metadata.expected, failed, results });
  console.log(`${status} ${c.id} #${attempt}${problem ? `：${problem}` : ''}`);
}
fs.writeFileSync(path.join(directory, 'intent-report.md'), ['# 真实模型意图识别', '',
  `模型：${metadata.model}；${results.length}/${metadata.expected} 次完成；失败 ${failed}。`, '', metadata.path, '',
  '| 场景 | 路径 | 次数 | 结果 | 预期 |', '| --- | --- | --- | --- | --- |',
  ...results.map((raw) => { const r = raw as { id: string; path: string; attempt: number; status: string; expected: string }; return `| ${r.id} | ${r.path} | ${r.attempt} | ${r.status} | ${r.expected} |`; }), '',
  '逐次输入、模型判断、归一化 Brief 和失败原因见 intent-report.json。重复两次只是稳定性抽查，不代表统计显著性。', ''].join('\n'));
process.exitCode = failed ? 1 : 0;
