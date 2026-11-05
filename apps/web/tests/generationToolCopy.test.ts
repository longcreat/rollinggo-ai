import assert from 'node:assert/strict';
import test from 'node:test';
import { FALLBACK_TOOL_COPY, TOOL_COPY, TOOL_NAMES, toolCopy } from '../src/lib/generationToolCopy';

// 10-22：映射表改用稳定工具名后，satisfies 在编译期保证「漏配一条」，这里补运行期断言。
test('every tool name has non-empty user-facing copy', () => {
  for (const name of TOOL_NAMES) {
    const copy = TOOL_COPY[name];
    assert.equal(typeof copy, 'string', `${name} 缺少文案`);
    assert.ok(copy.trim().length > 0, `${name} 的文案为空`);
    // 文案里不该出现工具名本身（说明有人漏填了值）
    assert.ok(!copy.includes(name), `${name} 的文案直接贴了工具名`);
  }
});

test('the copy table covers exactly the declared tool names', () => {
  assert.deepEqual(Object.keys(TOOL_COPY).sort(), [...TOOL_NAMES].sort());
});

test('unknown tool names fall back to generic copy instead of leaking the internal label', () => {
  assert.equal(toolCopy('search_web'), TOOL_COPY.search_web);
  // 模型幻觉出未注册的工具、或新工具尚未配文案时，只能给泛化文案
  assert.equal(toolCopy('hallucinated_tool'), FALLBACK_TOOL_COPY);
  assert.equal(toolCopy('查已验证地点库'), FALLBACK_TOOL_COPY);
});

test('fallback copy never duplicates a mapped copy', () => {
  assert.ok(!Object.values(TOOL_COPY).includes(FALLBACK_TOOL_COPY));
  assert.notEqual(FALLBACK_TOOL_COPY.trim(), '');
});

// 线上真实缺陷回归：服务端 label 是「提交调研结果」，前端旧 key 写成「提交调研摘要」
test('submit_research shows a user-facing line', () => {
  assert.equal(toolCopy('submit_research'), '整理旅行灵感');
});
