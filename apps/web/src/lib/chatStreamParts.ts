// 流式回合的正文段 / 工具段 / 思考段归约：对话面板与主 Agent 启动页共用，避免各自维护一套事件处理。
import type { AgentPart, ChatStreamEvent } from '@tripweaver/shared';
import { upsertAgentStep } from './agentActivity';

/** 只保留思考状态与规模；原始 CoT 不进入前端状态，也不落库。 */
export interface StreamThinking {
  active: boolean;
  chunks: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

export interface StreamParts {
  parts: AgentPart[];
  /** 当前最后一段正文是否仍在流式增长；工具出现后关闭。 */
  textOpen: boolean;
  thinking?: StreamThinking;
}

export function reduceStreamParts(state: StreamParts, event: ChatStreamEvent): StreamParts | null {
  if (event.type === 'thinking_start') {
    return { ...state, thinking: { active: true, chunks: 0, startedAt: Date.now() } };
  }
  if (event.type === 'thinking_delta') {
    const previous = state.thinking;
    return {
      ...state,
      thinking: {
        active: true,
        chunks: (previous?.chunks ?? 0) + 1,
        startedAt: previous?.startedAt ?? Date.now(),
      },
    };
  }
  if (event.type === 'thinking_end') {
    if (!state.thinking) return null;
    const endedAt = Date.now();
    return {
      ...state,
      thinking: {
        ...state.thinking,
        active: false,
        endedAt,
        durationMs: state.thinking.startedAt !== undefined ? Math.max(0, endedAt - state.thinking.startedAt) : undefined,
      },
    };
  }
  if (event.type === 'answer_delta') {
    if (!event.text) return null;
    const parts = [...state.parts];
    const last = parts.at(-1);
    if (event.replace) {
      if (state.textOpen && last?.type === 'text') parts[parts.length - 1] = { type: 'text', text: event.text };
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
