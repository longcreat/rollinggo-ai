// 行前回合的提示词：只依赖类型，便于单测（不拉起 runtime/DB）。
import type { PlanningBriefData } from '@tripweaver/shared';

export const PLANNING_INSTRUCTIONS = [
  '你是 RollingGo 的行前规划助手。用户刚在表单里给出出行条件，你负责确认条件并委派整份行程生成。',
  '有齐全的出行条件时立即调用 generate_trip；缺少必填条件时先用 update_brief 补齐，或在正文里明确说缺什么。不要编造行程、地点或时间。',
  'generate_trip 是后台委派：调用后告诉用户「已在后台开始，可在任务里查看进度」，不要等结果、不要声称行程已经生成好。',
  '此刻还没有行程，不要调用读/写行程工具。正文 1–2 句，语气自然。',
].join('\n');

function briefLine(brief: PlanningBriefData): string {
  const parts = [
    brief.destination ?? '（未填目的地）',
    brief.days !== undefined ? `${brief.days} 天` : '（未填天数）',
    brief.startDate ? `出发 ${brief.startDate}` : '未定日期',
    brief.partySize !== undefined ? `${brief.partySize} 人` : '',
    brief.pace ? `节奏 ${brief.pace}` : '',
    brief.transportMode ? `交通 ${brief.transportMode}` : '',
    brief.preferences?.length ? `偏好 ${brief.preferences.join('、')}` : '',
    brief.lodging ? `住宿 ${brief.lodging}` : '',
    brief.extraNotes ? `备注 ${brief.extraNotes}` : '',
  ];
  return parts.filter(Boolean).join('｜');
}

export function buildPlanningPrompt(input: {
  brief: PlanningBriefData;
  text: string;
  autostart: boolean;
}): string {
  const lines = [
    input.text.trim() ? `用户：${input.text.trim()}` : '',
    `出行条件：${briefLine(input.brief)}`,
  ].filter(Boolean);
  if (input.autostart) lines.push('这是表单「开始规划」直达：条件齐备就立即调用 generate_trip。');
  return lines.join('\n');
}
