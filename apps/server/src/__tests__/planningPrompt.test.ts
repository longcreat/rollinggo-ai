import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlanningBriefData } from '@tripweaver/shared';
import { PLANNING_INSTRUCTIONS, buildPlanningPrompt } from '../chat/agent/planningPrompt';

const brief: PlanningBriefData = {
  destination: '成都',
  days: 3,
  startDate: '2026-11-20',
  partySize: 2,
  pace: 'moderate',
  constraints: [],
  preferences: ['美食', '文化'],
  transportMode: 'transit',
};

test('行前提示包含用户原文与结构化出行条件', () => {
  const prompt = buildPlanningPrompt({ brief, text: '想吃火锅，不早起', autostart: true });
  assert.match(prompt, /用户：想吃火锅，不早起/);
  assert.match(prompt, /成都/);
  assert.match(prompt, /3 天/);
  assert.match(prompt, /2026-11-20/);
  assert.match(prompt, /2 人/);
  assert.match(prompt, /偏好 美食、文化/);
});

test('autostart 才附加「立即调用 generate_trip」指令', () => {
  assert.match(buildPlanningPrompt({ brief, text: '', autostart: true }), /立即调用 generate_trip/);
  assert.doesNotMatch(buildPlanningPrompt({ brief, text: '', autostart: false }), /立即调用 generate_trip/);
});

test('行前回答禁止固定话术与逐项复述', () => {
  assert.doesNotMatch(PLANNING_INSTRUCTIONS, /已在后台开始，可在任务里查看进度/);
  assert.match(PLANNING_INSTRUCTIONS, /不要逐项复述/);
  assert.match(PLANNING_INSTRUCTIONS, /真人接单/);
  assert.match(PLANNING_INSTRUCTIONS, /任务节点已经展示进度/);
});

test('缺字段在条件行里明确标出，不编造默认值', () => {
  const prompt = buildPlanningPrompt({ brief: { destination: '西安', constraints: [] }, text: '', autostart: false });
  assert.match(prompt, /西安/);
  assert.match(prompt, /未填天数/);
  assert.match(prompt, /未定日期/);
});
