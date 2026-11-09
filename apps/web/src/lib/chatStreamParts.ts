// 流式回合的正文 / 工具 / 思考段归约：对话面板与主 Agent 启动页共用。
// 思考段按真实事件顺序进入 parts，和 pi 的 assistant content（thinking → text → toolCall）一致。
import type { AgentPart, ChatStreamEvent } from '@tripweaver/shared';
import { upsertAgentStep } from './agentActivity';

export interface StreamParts {
  parts: AgentPart[];
  /** 当前最后一段正文是否仍在流式增长；工具/思考出现后关闭。 */
  textOpen: boolean;
}

function lastThinkingIndex(parts: readonly AgentPart[]): number {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.type === 'thinking') return index;
  }
  return -1;
}

export function reduceStreamParts(state: StreamParts, event: ChatStreamEvent): StreamParts | null {
  if (event.type === 'thinking_start') {
    const parts = [...state.parts];
    // 相邻的 thinking 段直接续上；正常一回合一段，工具轮后会是新的一段。
    const last = parts.at(-1);
    if (last?.type === 'thinking' && last.endedAt === undefined) return { ...state, textOpen: false };
    parts.push({ type: 'thinking', startedAt: Date.now(), chunks: 0 });
    return { ...state, parts, textOpen: false };
  }
  if (event.type === 'thinking_delta') {
    const index = lastThinkingIndex(state.parts);
    if (index < 0) return null;
    const part = state.parts[index];
    if (part?.type !== 'thinking') return null;
    const parts = [...state.parts];
    parts[index] = {
      ...part,
      chunks: (part.chunks ?? 0) + 1,
      thinking: (part.thinking ?? '') + (event.text ?? ''),
    };
    return { ...state, parts, textOpen: false };
  }
  if (event.type === 'thinking_end') {
    const index = lastThinkingIndex(state.parts);
    if (index < 0) return null;
    const part = state.parts[index];
    if (part?.type !== 'thinking') return null;
    const endedAt = Date.now();
    const parts = [...state.parts];
    parts[index] = {
      ...part,
      endedAt,
      durationMs: Math.max(0, endedAt - part.startedAt),
    };
    return { ...state, parts };
  }
  if (event.type === 'answer_delta') {
    if (!event.text) return null;
    const parts = [...state.parts];
    const last = parts.at(-1);
    if (event.replace) {
      if (last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: event.text };
      else parts.push({ type: 'text', text: event.text });
    } else if (state.textOpen && last?.type === 'text') {
      parts[parts.length - 1] = { type: 'text', text: last.text + event.text };
    } else {
      parts.push({ type: 'text', text: event.text });
    }
    return { ...state, parts, textOpen: true };
  }
  if (event.type === 'progress' && event.step) {
    const step = event.step;
    const parts = [...state.parts];
    const existing = parts.findIndex((part) => part.type === 'steps' && part.steps.some((item) => item.id === step.id));
    if (existing >= 0) {
      const part = parts[existing];
      if (part && part.type === 'steps') parts[existing] = { type: 'steps', steps: upsertAgentStep(part.steps, step) };
      return { ...state, parts };
    }
    const last = parts.at(-1);
    if (last?.type === 'steps') parts[parts.length - 1] = { type: 'steps', steps: upsertAgentStep(last.steps, step) };
    else parts.push({ type: 'steps', steps: [step] });
    return { ...state, parts, textOpen: step.status === 'running' ? false : state.textOpen };
  }
  return null;
}
