// 流式回合的正文段 / 工具段归约：对话面板与主 Agent 启动页共用，避免各自维护一套事件处理。
import type { AgentPart, ChatStreamEvent } from '@tripweaver/shared';
import { upsertAgentStep } from './agentActivity';

export interface StreamParts {
  parts: AgentPart[];
  /** 当前最后一段正文是否仍在流式增长；工具出现后关闭。 */
  textOpen: boolean;
}

export function reduceStreamParts(state: StreamParts, event: ChatStreamEvent): StreamParts | null {
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
