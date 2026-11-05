// 单测：对话视图的纯派生逻辑（web lib 的纯函数统一放在这里，与 generationTimeline.test.ts 同例）
// 注：追问控件（isIntakeLive / activeIntake / intakeShape）已在 10-17 下线，相应用例一并删除。
import assert from 'node:assert/strict';
import test from 'node:test';
import { chatErrorMessage } from '../../../web/src/lib/chatDerive';
import { ApiError } from '../../../web/src/api/client';

test('对话额度耗尽的错误文案给出下一步（引导去生成），而不是死胡同', () => {
  const text = chatErrorMessage(new ApiError(429, '今日对话次数已用完', { resetAt: Date.now() }));
  assert.match(text, /开始生成/);
});

test('未配置 AI 的错误按 hasSiteKey 分流；未知错误保留原文', () => {
  assert.match(chatErrorMessage(new ApiError(400, 'x', { hasSiteKey: false }, 'no_llm')), /高级选项/);
  assert.match(chatErrorMessage(new ApiError(400, 'x', { hasSiteKey: true }, 'no_llm')), /联系站长/);
  assert.equal(chatErrorMessage(new ApiError(418, '我是一只茶壶')), '我是一只茶壶');
});
