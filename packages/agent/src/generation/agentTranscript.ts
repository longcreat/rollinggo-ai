// 子 Agent 会话 → 主页面可渲染的工作流。
//
// 只输出工具调用（名称/状态/耗时）与调用顺序；不输出 user/system prompt、
// thinking/reasoning、tool 参数或原始 assistant 正文，避免把内部上下文带到用户界面。
import type { EntryRecord } from '@earendil-works/pi-durable';

export interface AgentTranscriptStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
  durationMs?: number;
}

export function normalizeAgentTranscript(
  entries: readonly EntryRecord[],
  terminal: boolean,
): AgentTranscriptStep[] {
  const steps: AgentTranscriptStep[] = [];
  const byId = new Map<string, AgentTranscriptStep>();

  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === 'assistant') {
        for (const part of message.content) {
          if (part.type !== 'toolCall' || byId.has(part.id)) continue;
          const step: AgentTranscriptStep = { id: part.id, label: part.name, status: 'running' };
          byId.set(part.id, step);
          steps.push(step);
        }
      } else if (message.role === 'toolResult') {
        const step = byId.get(message.toolCallId);
        if (!step) continue;
        step.status = message.isError ? 'error' : 'done';
        if (message.durationMs !== undefined) step.durationMs = message.durationMs;
        if (message.toolName) step.label = message.toolName;
      }
    }
  }

  // 会话已结束但没拿到结果的调用不再显示“运行中”，避免子页面永远转圈。
  if (terminal) {
    for (const step of steps) if (step.status === 'running') step.status = 'done';
  }
  return steps;
}
