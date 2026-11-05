// OpenAI 兼容端点的参数差异。
//
// pi-ai 只按 baseUrl 自动识别 DeepSeek 原生（`*.deepseek.com`）；托管在别家（如阿里云百炼
// dashscope.aliyuncs.com）的 DeepSeek 认不出来，会按 OpenAI 默认发 `max_completion_tokens`，
// 而百炼要 `max_tokens`。这类差异在这里集中判断，避免散落到两处模型构造里。
import type { Model } from '@earendil-works/pi-ai/compat';

export type OpenAiCompat = NonNullable<Model<'openai-completions'>['compat']>;

/** 原生 DeepSeek V4 系列：只有它们认 `thinking: {type:"disabled"}` 这一套开关。 */
const NATIVE_DEEPSEEK_THINKING_MODEL = /^deepseek(-(v4|v4\.1))?-(flash|pro)$/;

/** 百炼上的 DeepSeek 模型 ID（v3 / v3.1 / v3.2 / r1 等）。 */
const BAILIAN_DEEPSEEK_MODEL = /^deepseek-(v\d+(\.\d+)?|r\d|chat|reasoner|coder)/i;

const DASHSCOPE_HOST = /(^|\.)aliyuncs\.com$/i;

/** 用 hostname 判断而不是字符串包含：`dashscope.aliyuncs.com.evil.com` 不算。 */
export function isDashScopeBaseUrl(baseUrl: string): boolean {
  try {
    return DASHSCOPE_HOST.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export function isBailianDeepSeekModel(model: string): boolean {
  return BAILIAN_DEEPSEEK_MODEL.test(model);
}

export interface CompatDecision {
  /** 传给 pi-ai Model 的 compat；undefined = 用自动探测的默认值。 */
  compat: OpenAiCompat | undefined;
  /** 是否声明为 reasoning 模型：pi-ai 只有在 reasoning 为 true 时才会发送思考开关。 */
  reasoning: boolean;
}

/**
 * 决定一个模型该如何和端点对话。
 *
 * - 百炼：一律 `max_tokens`，并关掉 developer 角色与 store 字段；DeepSeek 模型要关思考时
 *   用百炼的 `enable_thinking: false`（pi-ai 的 qwen 分支会发这个字段），并补 reasoning
 *   占位以兼容工具续轮。
 * - 原生 DeepSeek：保持既有行为（`thinking: {type:"disabled"}`）。
 * - 其他：不加任何私有参数，交给 pi-ai 默认。
 */
export function resolveOpenAiCompat(input: {
  baseUrl: string;
  model: string;
  disableThinking: boolean;
}): CompatDecision {
  const dashscope = isDashScopeBaseUrl(input.baseUrl);
  if (dashscope) {
    const thinkingOff = input.disableThinking && isBailianDeepSeekModel(input.model);
    return {
      compat: {
        maxTokensField: 'max_tokens',
        // 百炼不接受 OpenAI 的 developer 角色与 store 字段；不关掉会随 reasoning=true 一起被发出去。
        supportsDeveloperRole: false,
        supportsStore: false,
        ...(thinkingOff
          ? {
            thinkingFormat: 'qwen' as const,
            requiresReasoningContentOnAssistantMessages: true,
          }
          : {}),
      },
      reasoning: thinkingOff,
    };
  }
  const thinkingOff = input.disableThinking && NATIVE_DEEPSEEK_THINKING_MODEL.test(input.model);
  return {
    compat: thinkingOff
      ? { thinkingFormat: 'deepseek' as const, requiresReasoningContentOnAssistantMessages: true }
      : undefined,
    reasoning: thinkingOff,
  };
}