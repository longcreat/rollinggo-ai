// C0 冒烟 ①：pi-agent-core 单工具 Agent 打真实 OpenAI 兼容端点
// 用法（任选其一提供 SITE_LLM_* 三件套）：
//   1) 写入 apps/server/.env 后：node scripts/smoke-pi.mjs
//   2) 环境变量直传：SITE_LLM_BASE_URL=... SITE_LLM_API_KEY=... SITE_LLM_MODEL=... node scripts/smoke-pi.mjs
// 核对架构 §12 前三项：Agent 构造形状 / getApiKey / 中止方式 / 工具返回与 terminate / 自定义 Model 最小必填集
import { existsSync } from 'node:fs';
import { config } from 'dotenv';
import { Agent } from '@mariozechner/pi-agent-core';
import { Type } from 'typebox';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

// 系统代理环境下 Node fetch 需显式接管（与 apps/server/src/lib/proxy.ts 一致）
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy: process.env.NO_PROXY ?? 'localhost,127.0.0.1,::1' }));
}

for (const p of ['apps/server/.env', '.env']) if (existsSync(p)) config({ path: p });

const baseUrl = process.env.SITE_LLM_BASE_URL ?? '';
const apiKey = process.env.SITE_LLM_API_KEY ?? '';
const modelId = process.env.SITE_LLM_MODEL ?? '';

if (!baseUrl || !apiKey || !modelId) {
  console.error('[smoke-pi] 缺少 SITE_LLM_BASE_URL / SITE_LLM_API_KEY / SITE_LLM_MODEL，无法打真实端点。');
  console.error('[smoke-pi] 离线核对（类型层）已在架构文档 §12 记录；填好 env 后重跑本脚本做在线验证。');
  process.exit(2);
}

// 自定义 Model 最小必填集（架构 §12 第三项）：compat 缺省时由 baseUrl 自动探测
const model = {
  id: modelId,
  name: modelId,
  api: 'openai-completions',
  provider: 'tripweaver-site',
  baseUrl,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 4096,
};

const checks = { toolCalled: false, toolResultSeen: false, usageCounted: false, terminated: false, aborted: false };

const echoTool = {
  name: 'echo_probe',
  label: '回声探针',
  description: 'Echo the given text back. Always call this tool exactly once, then stop.',
  parameters: Type.Object({ text: Type.String({ description: 'text to echo' }) }),
  execute: async (_id, params) => {
    checks.toolCalled = true;
    return { content: [{ type: 'text', text: `echo: ${params.text}` }], details: params, terminate: true };
  },
};

const agent = new Agent({
  initialState: {
    systemPrompt: 'You are a probe. Call the echo_probe tool with text "pong", then stop.',
    model,
    thinkingLevel: 'off',
    tools: [echoTool],
  },
  getApiKey: () => apiKey, // §12：getApiKey(provider) 按 model.provider 回查
});

agent.subscribe((ev) => {
  if (ev.type === 'tool_execution_end') checks.toolResultSeen = !ev.isError;
  if (ev.type === 'message_end' && ev.message.role === 'assistant') {
    const u = ev.message.usage;
    console.log(`[smoke-pi] assistant 消息结束：stopReason=${ev.message.stopReason} tokens in/out=${u?.input}/${u?.output}`);
    if ((u?.input ?? 0) > 0 || (u?.output ?? 0) > 0) checks.usageCounted = true;
  }
  if (ev.type === 'agent_end') checks.terminated = true;
});

console.log(`[smoke-pi] 端点 ${baseUrl} 模型 ${modelId} —— 发起单工具运行`);
await agent.prompt('ping');
await agent.waitForIdle();

// §12 中止方式：abort() 应使运行以 aborted 收尾且不抛未捕获异常
const agent2 = new Agent({
  initialState: { systemPrompt: 'Write a 500 word essay about clouds.', model, thinkingLevel: 'off', tools: [] },
  getApiKey: () => apiKey,
});
agent2.subscribe((ev) => {
  if (ev.type === 'message_end' && ev.message.role === 'assistant' && ev.message.stopReason === 'aborted') checks.aborted = true;
});
const run = agent2.prompt('go');
setTimeout(() => agent2.abort(), 800);
await run.catch(() => {});
await agent2.waitForIdle();

console.log('[smoke-pi] 核对结果：', checks);
const pass = checks.toolCalled && checks.toolResultSeen && checks.usageCounted && checks.terminated;
console.log(pass ? '[smoke-pi] PASS —— §12 前三项在线核对通过' : '[smoke-pi] FAIL —— 按计划启用后备（手写工具循环）并回记文档');
process.exit(pass ? 0 : 1);
