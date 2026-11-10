// 验证当前 LLM 端点是否可用：鉴权 → 基础对话 → 工具调用。
//
//   doppler run -p trip -c dev -- npx tsx scripts/verify-llm-provider.mts
//
// 切换供应商后先跑这个，比在页面上试错快得多。两步分别覆盖：
//   1. buildModel 的请求参数（max_tokens / 思考开关）能被端点接受；
//   2. 模型真的会发 tool_call（详情页 Agent 与生成链路都依赖它）。
import 'dotenv/config';
import { Type } from 'typebox';
import { buildModel } from '@tripweaver/agent/generation/model';
import { runPhaseAgent } from '../apps/server/src/generation/agents/runner';
import { defineTool } from '@tripweaver/agent/generation/tools/defineTool';
import { isDashScopeBaseUrl } from '@tripweaver/core/lib/llmCompat';
import type { LlmConfig } from '@tripweaver/core/settingsService';

const baseUrl = process.env.SITE_LLM_BASE_URL?.trim() ?? '';
const apiKey = process.env.SITE_LLM_API_KEY?.trim() ?? '';
const modelId = process.env.SITE_LLM_MODEL?.trim() ?? '';
if (!baseUrl || !apiKey || !modelId) {
  console.error('缺少 SITE_LLM_BASE_URL / SITE_LLM_API_KEY / SITE_LLM_MODEL');
  process.exit(2);
}
const cfg: LlmConfig = { baseUrl, apiKey, model: modelId, byok: false };

function diagnose(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|invalid.*(api|key)|authentication/i.test(message)) return '鉴权失败：检查 SITE_LLM_API_KEY 是否是该平台的 Key';
  if (/404|model.*not.*(found|exist)|does not exist/i.test(message)) return `模型不存在：${modelId} 是否是当前平台的模型 ID？`;
  if (/400|invalid.*param|unsupported.*(max_tokens|max_completion)/i.test(message)) return '参数不兼容：检查 lib/llmCompat.ts 的 compat 分支';
  if (/429|quota|balance|insufficient/i.test(message)) return '额度不足或限流';
  return message;
}

console.log(`端点：${new URL(baseUrl).host}${new URL(baseUrl).pathname}`);
console.log(`模型：${modelId}${isDashScopeBaseUrl(baseUrl) ? '（阿里云百炼）' : ''}`);
const model = await buildModel(cfg, { disableDeepSeekThinking: true });
console.log('compat：', JSON.stringify({ reasoning: model.reasoning, ...model.compat }));

let failed = false;

console.log('\n[1/2] 基础对话 …');
try {
  let text = '';
  const result = await runPhaseAgent({
    model, apiKey,
    systemPrompt: '只回答一个短句。',
    tools: [],
    userPrompt: '用一句话说你好。',
    signal: AbortSignal.timeout(60_000),
    sink: { onTextDelta: (delta) => { text += delta; }, onThought() {}, onToolStart() {}, onToolEnd() {}, onUsage() {} },
    maxTurns: 1,
  });
  if (result.errorMessage || !text.trim()) throw new Error(result.errorMessage ?? '空响应');
  console.log('  PASS：', text.trim().slice(0, 60));
} catch (error) {
  failed = true;
  console.error('  FAIL：', diagnose(error));
}

console.log('\n[2/2] 工具调用 …');
if (!failed) {
  try {
    let called = '';
    const result = await runPhaseAgent({
      model, apiKey,
      systemPrompt: '先调用 record 工具，再用一句话确认。',
      tools: [defineTool({
        name: 'record', label: '记录', description: '记录一条信息',
        parameters: Type.Object({ text: Type.String() }),
        execute: async (_id, params) => {
          called = String((params as { text?: string }).text ?? '');
          return { content: [{ type: 'text' as const, text: '已记录' }], details: {} };
        },
      })],
      userPrompt: '记录：测试通过。',
      signal: AbortSignal.timeout(90_000),
      sink: { onThought() {}, onToolStart() {}, onToolEnd() {}, onUsage() {} },
      maxTurns: 3,
    });
    if (result.errorMessage) throw new Error(result.errorMessage);
    if (!called) throw new Error('模型没有发起工具调用（该模型可能不支持 function calling）');
    console.log('  PASS：调用了 record（', called, '）');
  } catch (error) {
    failed = true;
    console.error('  FAIL：', diagnose(error));
  }
}

if (failed) {
  console.error('\n验证未通过');
  process.exit(1);
}
console.log('\nPASS：当前端点可用于生成与工具调用');