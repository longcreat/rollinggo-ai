import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBailianDeepSeekModel, isDashScopeBaseUrl, resolveOpenAiCompat } from '@tripweaver/core/lib/llmCompat';

const DASHSCOPE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

describe('OpenAI 兼容端点差异', () => {
  it('百炼的 DeepSeek 用 max_tokens，并声明 reasoning + qwen 思考开关', () => {
    const decision = resolveOpenAiCompat({ baseUrl: DASHSCOPE, model: 'deepseek-v3.2' });
    assert.equal(decision.compat?.maxTokensField, 'max_tokens');
    assert.equal(decision.compat?.thinkingFormat, 'qwen');
    assert.equal(decision.compat?.requiresReasoningContentOnAssistantMessages, undefined, '对齐官方规范：百炼端点不强设 requiresReasoningContent');
    assert.equal(decision.compat?.supportsDeveloperRole, false, '百炼不接受 developer 角色');
    assert.equal(decision.compat?.supportsStore, false, '百炼不接受 store 字段');
    assert.equal(decision.reasoning, true, 'pi-ai 只有 reasoning=true 才发思考开关');
    assert.equal(decision.supportsThinking, true);
  });

  it('百炼的非 DeepSeek 模型只改参数名，不声明思考能力', () => {
    const decision = resolveOpenAiCompat({ baseUrl: DASHSCOPE, model: 'qwen-plus' });
    assert.equal(decision.compat?.maxTokensField, 'max_tokens');
    assert.equal(decision.compat?.thinkingFormat, undefined);
    assert.equal(decision.reasoning, false);
    assert.equal(decision.supportsThinking, false);
  });

  it('原生 DeepSeek 使用 thinking 开关协议', () => {
    const decision = resolveOpenAiCompat({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' });
    assert.equal(decision.compat?.thinkingFormat, 'deepseek');
    assert.equal(decision.compat?.maxTokensField, undefined);
    assert.equal(decision.reasoning, true);
    assert.equal(decision.supportsThinking, true);
  });

  it('其他兼容网关不声明思考、不注入私有参数', () => {
    const decision = resolveOpenAiCompat({ baseUrl: 'https://example.com/v1', model: 'other-model' });
    assert.equal(decision.compat, undefined);
    assert.equal(decision.reasoning, false);
    assert.equal(decision.supportsThinking, false);
  });

  it('hostname 判断不接受伪装域名', () => {
    assert.equal(isDashScopeBaseUrl(DASHSCOPE), true);
    assert.equal(isDashScopeBaseUrl('https://dashscope.aliyuncs.com.evil.com/v1'), false);
    assert.equal(isDashScopeBaseUrl('not a url'), false);
    assert.equal(isBailianDeepSeekModel('deepseek-v3'), true);
    assert.equal(isBailianDeepSeekModel('deepseek-v3.2-exp'), true);
    assert.equal(isBailianDeepSeekModel('qwen-max'), false);
  });
});
