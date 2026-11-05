// 文案阶段收尾工具（原审校结论工具）：09-21 确定性排程接管结构决策后，审校职责由代码承担，
// 本工具只剩「提交并终止本阶段」。approved / revisionRequests 两个参数当时就没被 orchestrator 消费过，
// 却让模型为「是否通过」「结构性修订要求」先做一遍结构推理（实测 review 单轮 4535 输出里 reasoning 占八成），
// 09-25 一并去掉。
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { defineTool } from './defineTool';

function text(t: string) {
  return [{ type: 'text' as const, text: t }];
}

export interface ReviewOutcome {
  submitted: boolean;
  notes: string[];
}

export function buildReviewTools(outcome: ReviewOutcome): AgentTool[] {
  const submitTool = defineTool({
    name: 'submit_review',
    label: '提交文案',
    description: '提交文案撰写结果，提交后本阶段结束。',
    parameters: Type.Object({
      notes: Type.Array(Type.String(), { description: '给用户看的实用建议/遗留提示，≤3 条，可为空' }),
    }),
    execute: async (_id, params) => {
      outcome.submitted = true;
      outcome.notes = params.notes.slice(0, 3).map((n) => n.slice(0, 200));
      return { content: text('文案已提交。'), details: { submitted: true }, terminate: true };
    },
  });

  return [submitTool];
}
