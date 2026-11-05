// 单测：调研与文案 prompt 的内容契约（node:test 经 tsx 运行）
// 原 planner / reviewer prompt 用例随其调用点消失一并删除（09-25）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GenerateForm } from '@tripweaver/shared';
import { researchSystemPrompt, WRITER_SYSTEM_PROMPT, formBrief, writerUserPrompt } from '../generation/prompts';

const form: GenerateForm = {
  destination: '测试市',
  days: 2,
  startDate: '',
  budgetLevel: '舒适',
  totalBudget: 0,
  preferences: [],
  partySize: 2,
  extraNotes: '',
  transportMode: 'transit',
};

test('formBrief 不含用户预算决策（预算不参与生成）', () => {
  const brief = formBrief({ ...form, budgetLevel: '豪华', totalBudget: 99999 });
  assert.equal(brief.includes('预算'), false);
});

test('调研 prompt：知识库为主力源，并带并行调用与禁止逐项补漏的纪律', () => {
  const prompt = researchSystemPrompt({ searchWebMax: 2 });
  assert.ok(prompt.includes('search_verified_places'));
  assert.ok(prompt.includes('一条消息里并行发多个调用'));
  assert.ok(prompt.includes('禁止逐项补漏'));
  assert.ok(prompt.includes('评分、人均、营业与排队均是动态信息'));
});

test('调研 prompt：search_web 上限按参数注入（覆盖 2 / 未覆盖 6）', () => {
  assert.ok(researchSystemPrompt({ searchWebMax: 2 }).includes('全阶段最多 2 次'));
  assert.ok(researchSystemPrompt({ searchWebMax: 6 }).includes('全阶段最多 6 次'));
});

test('文案 prompt：只写标题，不改活动说明', () => {
  assert.ok(WRITER_SYSTEM_PROMPT.includes('update_titles'));
  assert.ok(WRITER_SYSTEM_PROMPT.includes('不得新增、删除、移动任何活动'));
  assert.equal(WRITER_SYSTEM_PROMPT.includes('update_descriptions'), false, '活动说明不再由模型改写');
  assert.equal(WRITER_SYSTEM_PROMPT.includes('approved'), false, '不再要求模型给审校结论');
});

test('调研 prompt：intro 按活动说明标准写并会被直接复用', () => {
  const prompt = researchSystemPrompt({ searchWebMax: 2 });
  assert.ok(prompt.includes('按「完整景点介绍」写'));
  assert.ok(prompt.includes('直接作为该活动在行程里的说明文案'));
});

test('文案 user prompt 带上用户需求与当前草稿', () => {
  const text = writerUserPrompt(form, '第 1 天：主题');
  assert.ok(text.includes('用户需求'));
  assert.ok(text.includes('第 1 天：主题'));
});
