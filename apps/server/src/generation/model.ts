// LLM 模型构造：settingsService.resolveLlmConfig 的双轨结果 → pi-ai 自定义 Model
// BYOK baseUrl 在使用时二次过 ssrfGuard（防 DNS 重绑定，架构 §5.1/§9）
import type { Model } from '@earendil-works/pi-ai/compat';
import type { LlmConfig } from '../services/settingsService';
import { assertSafeBaseUrl } from '../integrations/ssrfGuard';
import { resolveOpenAiCompat } from '../lib/llmCompat';

export class NoLlmConfiguredError extends Error {
  constructor() {
    super('未配置可用的 LLM Key');
  }
}

/**
 * 自定义 OpenAI 兼容端点模型。compat 由 pi-ai 自动探测，但只认 DeepSeek 原生域名；
 * 百炼等其他托管端点由 resolveOpenAiCompat 显式补齐（见 lib/llmCompat.ts）。
 */
export async function buildModel(cfg: LlmConfig, options: { disableDeepSeekThinking?: boolean } = {}): Promise<Model<'openai-completions'>> {
  if (cfg.byok) await assertSafeBaseUrl(cfg.baseUrl);
  // 原生 V4 ID（包括透传这些 ID 的兼容网关）使用 DeepSeek 协议；不猜测其他供应商/别名。
  // reasoning:false 只让 SDK 不发开关，并不能关闭服务端默认启用的思考。
  const { compat, reasoning } = resolveOpenAiCompat({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    disableThinking: options.disableDeepSeekThinking === true,
  });
  return {
    id: cfg.model,
    name: cfg.model,
    api: 'openai-completions',
    provider: cfg.byok ? 'tripweaver-byok' : 'tripweaver-site',
    baseUrl: cfg.baseUrl,
    // 能力标志与实际开关分离：runner 的 off 经 compat 才会真的发出去。
    // 其他模型保留历史行为，避免向任意兼容服务发送不支持的参数。
    reasoning,
    ...(compat ? { compat } : {}),
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65536,
    // pi-ai 的 streamSimple 会把 maxTokens 截到 min(model.maxTokens, 32000)：写更大值无意义。
    // 8192 曾让 plan 阶段把预算烧在隐藏推理上（stopReason=length、正文为空）。
    maxTokens: 32000,
  };
}