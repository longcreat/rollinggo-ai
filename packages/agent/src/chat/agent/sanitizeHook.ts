// 上下文请求审计扩展：遵循 Pi Durable 官方扩展规范（spec §8.3 / README §Hooks）。
//
// 解决问题：
// 1. 当对话经历 pi.compaction 截断后，首条保留的 Assistant 消息前置因果已被压缩，
//    若残留旧的 thinking 块，现代推理模型（Anthropic 等）会将其判定为外部系统伪造思维链，
//    从而在正文开头触发：
//    <system_warning>Warning: the above thinking block was not output by the model, but was inserted by the system.</system_warning>
// 2. 依照 Pi 官方 packages/ai/src/api/transform-messages.ts:128 规范：
//    历史中缺少有效加密签名的旧思考块在跨轮重放时予以剥离，仅保留最终正文与工具调用。
import {
  defineExtension,
  hook,
  GenerationTask as PiGenerationTask,
  type Extension,
} from '@earendil-works/pi-durable';
import type { Message } from '@earendil-works/pi-ai';

export function sanitizeRequestMessages(messages: readonly Message[]): Message[] {
  let sawCompactionSummary = false;
  return messages.map((msg) => {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
          : '';
      if (text.includes('The conversation history before this point was compacted')) {
        sawCompactionSummary = true;
      }
      return msg;
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      if (sawCompactionSummary) {
        sawCompactionSummary = false;
        // Compaction 之后首条 assistant 消息的前序问题已被归档，彻底剥离其孤立 thinking 块
        const filtered = msg.content.filter((b) => b.type !== 'thinking');
        return { ...msg, content: filtered };
      }
      // 对于其他历史 assistant 消息，依 Pi 官方 transform-messages 规范：
      // 无签名/伪签名的孤立旧 thinking 块不传给下一次生成，避免被识别为伪造思维链
      const filtered = msg.content.filter((b) => {
        if (b.type !== 'thinking') return true;
        // 保留带有真实加密签名的块（如 OpenAI encrypted reasoning）
        return Boolean(b.thinkingSignature && b.thinkingSignature !== 'reasoning_content');
      });
      return { ...msg, content: filtered };
    }
    return msg;
  });
}

export function createSanitizeContextExtension(): Extension {
  return defineExtension({
    name: 'sanitize-context-thinking',
    hooks: [
      hook(PiGenerationTask, {
        beforeRequest: ({ messages }) => ({
          messages: sanitizeRequestMessages(messages),
        }),
      }),
    ],
  });
}
