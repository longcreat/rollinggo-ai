import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Message } from '@earendil-works/pi-ai';
import { sanitizeRequestMessages } from '../chat/agent/sanitizeHook';

describe('beforeRequest 思考块防伪过滤 (对齐 Pi Durable 规范)', () => {
  it('当上下文刚经历 Compaction，紧接其后的首条 Assistant 消息必须剥离孤立 thinking 块', () => {
    const input: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'The conversation history before this point was compacted into the following summary:\n\n<summary>...</summary>',
          },
        ],
      },
      {
        role: 'assistant',
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
      },
      {
        role: 'user',
        content: '查一下成都天气',
      },
    ];

    const result = sanitizeRequestMessages(input);
    const firstAssistant = result[1];
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
        content: '你好',
      },
      {
        role: 'assistant',
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
      },
    ];

    const result = sanitizeRequestMessages(input);
    const assistant = result[1];
    if (Array.isArray(assistant.content)) {
      const thinkingBlocks = assistant.content.filter((b) => b.type === 'thinking');
      assert.equal(thinkingBlocks.length, 1, '带有效签名的 thinking 块应当保留');
    }
  });
});
