// 行程详情 Agent 的模型接入：LlmConfig → pi-ai Models。
//
// 与 generation/model.ts 的区别：那边返回单个 Model 给 pi-agent-core 的 runner；
// 这里要喂给 pi-durable 的 Harness，它只认 Models 集合（provider + auth + 模型清单）。
// BYOK 的 baseUrl 仍要过 ssrfGuard（架构 §5.1/§9），自建供应商的鉴权用闭包注入用户 Key。
import { createModels, createProvider, type Models } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Model } from '@earendil-works/pi-ai';
import type { LlmConfig } from '../../services/settingsService';
import { assertSafeBaseUrl } from '../../integrations/ssrfGuard';
import { isDashScopeBaseUrl, resolveOpenAiCompat } from '../../lib/llmCompat';

export const AGENT_PROVIDER_ID = 'tripweaver';

/** 构造一个带用户 Key 的 Models 集合；每次调用返回独立实例，便于按用户切换配置。 */
export async function buildAgentModels(cfg: LlmConfig): Promise<Models> {
  if (cfg.byok) await assertSafeBaseUrl(cfg.baseUrl);
  // 百炼托管的 DeepSeek 参数名与原生不同：显式关思考，工具轮更稳、也更便宜。
  const disableThinking = isDashScopeBaseUrl(cfg.baseUrl);
  const { compat, reasoning } = resolveOpenAiCompat({ baseUrl: cfg.baseUrl, model: cfg.model, disableThinking });
  const model: Model<'openai-completions'> = {
    id: cfg.model,
    name: cfg.model,
    api: 'openai-completions',
    provider: AGENT_PROVIDER_ID,
    baseUrl: cfg.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65536,
    maxTokens: 32000,
    reasoning,
    ...(compat ? { compat } : {}),
  };
  const provider = createProvider({
    id: AGENT_PROVIDER_ID,
    name: 'TripWeaver',
    baseUrl: cfg.baseUrl,
    auth: {
      apiKey: {
        name: 'TripWeaver LLM key',
        resolve: async () => ({
          auth: { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl },
          source: cfg.byok ? 'BYOK' : 'site',
        }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return models;
}

/** 当前模型引用，供 Harness 的 agent 配置使用。 */
export function agentModelRef(modelId: string) {
  return { provider: AGENT_PROVIDER_ID, modelId };
}