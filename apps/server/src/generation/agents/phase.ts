// 生成阶段的公共契约：sink 事件、运行参数与结果。与具体运行时（pi-durable）解耦，
// 供 orchestrator / research / planner / advice / writer 共用。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai/compat';
import type { LlmRequestRecorder } from '../llmRequestLog';

export interface PhaseEventSink {
  /** 仅无工具的用户正文流使用；不转发 thinking/toolcall。 */
  onTextDelta?(text: string): void;
  onThought(text: string): void;
  onToolStart(toolCallId: string, tool: string, label: string, args: unknown): void;
  onToolEnd(toolCallId: string, tool: string, label: string, summary: string, isError: boolean): void;
  onUsage(tokensIn: number, tokensOut: number): void;
  /** 该 turn 响应结束（message_end）时回填结果 */
  onLlmResponse?(info: { turn: number; stopReason?: string; usage?: { input: number; output: number }; errorMessage?: string }): void;
}

export interface RunAgentOptions {
  /** 已在 buildModel 中解析的模型；durable 运行器只取 provider/id，其余由 Harness 的 Models 解析。 */
  model: Model<'openai-completions'>;
  apiKey: string;
  systemPrompt: string;
  tools: AgentTool[];
  userPrompt: string;
  signal: AbortSignal;
  sink: PhaseEventSink;
  maxTurns?: number;
  /** LLM 请求上下文快照：durable 路径暂不接入 recorder。 */
  recorder?: LlmRequestRecorder;
  /** 必须经工具提交的阶段：正文停机后最多提醒一次。 */
  completion?: { isComplete(): boolean; reminder: string; errorMessage: string };
}

export interface RunAgentResult {
  tokensIn: number;
  tokensOut: number;
  aborted: boolean;
  turnLimitExceeded: boolean;
  errorMessage?: string;
}

export type PhaseAgentRunner = (options: RunAgentOptions) => Promise<RunAgentResult>;