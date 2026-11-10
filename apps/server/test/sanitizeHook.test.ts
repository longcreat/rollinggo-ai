import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message, UserMessage, AssistantMessage } from '@earendil-works/pi-ai';
import { sanitizeRequestMessages } from '@tripweaver/agent/chat/agent/sanitizeHook';

describe('beforeRequest 思考块防伪过滤 (对齐 Pi Durable 规范)', () => {
  it('当上下文刚经历 Compaction，紧接其后的首条 Assistant 消息必须剥离孤立 thinking 块', () => {
    const input: Message[] = [
      {
        role: 'user',
        timestamp: Date.now(),
        content: [
          {
            type: 'text',
            text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>...</summary>',
          },
        ],
      } as UserMessage,
      {
        role: 'assistant',
        timestamp: Date.now(),
        api: 'openai-completions',
        provider: 'tripweaver',
        model: 'qwen-plus',
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
        stopReason: 'stop',
        content: [
          {
            type: 'thinking',
            thinking: '这是旧话题的思考过程，上文的用户问题已经被压缩到 summary 里了',
          },
          {
            type: 'text',
            text: '这是之前的正文回答',
          },
        ],
      } as AssistantMessage,
      {
        role: 'user',
        timestamp: Date.now(),
        content: '查一下成都天气',
      } as UserMessage,
    ];

    const result = sanitizeRequestMessages(input);
    const firstAssistant = result[1];
    assert.ok(firstAssistant);
    assert.equal(firstAssistant.role, 'assistant');
    if (Array.isArray(firstAssistant.content)) {
      const thinkingBlocks = firstAssistant.content.filter((b) => b.type === 'thinking');
      assert.equal(thinkingBlocks.length, 0, 'Compaction 之后的首条 assistant 思考块必须被剥离，防止触发防伪报警');
      const textBlocks = firstAssistant.content.filter((b) => b.type === 'text');
      assert.equal(textBlocks.length, 1);
      assert.equal((textBlocks[0] as { text: string }).text, '这是之前的正文回答');
    }
  });

  it('保留具有有效加密签名的 thinking 块（如 OpenAI encrypted reasoning）', () => {
    const input: Message[] = [
      {
        role: 'user',
        timestamp: Date.now(),
        content: '你好',
      } as UserMessage,
      {
        role: 'assistant',
        timestamp: Date.now(),
        api: 'openai-completions',
        provider: 'tripweaver',
        model: 'qwen-plus',
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
        stopReason: 'stop',
        content: [
          {
            type: 'thinking',
            thinking: '思考中',
            thinkingSignature: 'valid_encrypted_signature_abc123',
          },
          {
            type: 'text',
            text: '你好！',
          },
        ],
      } as AssistantMessage,
    ];

    const result = sanitizeRequestMessages(input);
    const assistant = result[1];
    assert.ok(assistant);
    if (Array.isArray(assistant.content)) {
      const thinkingBlocks = assistant.content.filter((b) => b.type === 'thinking');
      assert.equal(thinkingBlocks.length, 1, '带有效签名的 thinking 块应当保留');
    }
  });
});
