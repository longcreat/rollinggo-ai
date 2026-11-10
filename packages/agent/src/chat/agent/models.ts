// 行程详情 Agent 的模型接入：LlmConfig → pi-ai Models。
//
// 与 generation/model.ts 的区别：那边返回单个 Model 给 pi-agent-core 的 runner；
// 这里要喂给 pi-durable 的 Harness，它只认 Models 集合（provider + auth + 模型清单）。
// BYOK 的 baseUrl 仍要过 ssrfGuard（架构 §5.1/§9），自建供应商的鉴权用闭包注入用户 Key。
import { createModels, createProvider, type Models } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Model, ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { LlmConfig } from '@tripweaver/core/settingsService';
import { assertSafeBaseUrl } from '@tripweaver/core/ssrfGuard';
import { resolveOpenAiCompat } from '@tripweaver/core/lib/llmCompat';

export const AGENT_PROVIDER_ID = 'tripweaver';

/** 构造一个带用户 Key 的 Models 集合；每次调用返回独立实例，便于按用户切换配置。 */
export async function buildAgentModels(cfg: LlmConfig): Promise<Models> {
  if (cfg.byok) await assertSafeBaseUrl(cfg.baseUrl);
  // reasoning 只声明能力；思考开关由每个会话的 thinkingLevel 决定（见 agentThinkingLevel）。
  const { compat, reasoning } = resolveOpenAiCompat({ baseUrl: cfg.baseUrl, model: cfg.model });
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

/**
 * 主对话的思考等级：只在模型/端点真正支持思考开关时开启。
 * 其余调用（生成阶段、完成回流、子代理）保持默认 off，避免把预算烧在隐藏推理上。
 */
export function agentThinkingLevel(cfg: LlmConfig): ModelThinkingLevel | null {
  return resolveOpenAiCompat({ baseUrl: cfg.baseUrl, model: cfg.model }).supportsThinking ? 'medium' : null;
}