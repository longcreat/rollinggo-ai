// 公共 Agent 运行器：pi-agent-core Agent 装配 + 事件转发 + 轮次上限 + 外部取消
// 三个 LLM Agent（调研 / 文案 / 建议）共用；上下文互相隔离（每次调用都是全新 Agent）
// 注意：plan（确定性排程）不经过本文件 —— 它不调模型，请去 scheduling/ 看。
//
// ┌─ Agent 控制的 4 个机制（本文件全部职责）───────────────────┐
// │ 1. 轮次上限（turn_start）：每次 turn_start 计数 +1，超 maxTurns 就 agent.abort()；│
// │    调研 16 轮、文案 3 轮、建议 3 轮。防止模型无限循环调工具。          │
// │ 2. completion 强提交（runPhaseAgent 尾部）：正文停了但没调 submit_* 工具  │
// │    时，补一句 reminder 让它重新提交，不重跑检索。正文里的 JSON 不算提交。  │
// │ 3. 上游重试（streamWithRetry）：只重试「尚未产生任何工具调用」的失败，   │
// │    因为重放会重复执行有副作用的工具（search_pois 是要计费的）。           │
// │ 4. 事件转发（agent.subscribe）：把 pi-agent-core 的事件翻译成 sink 回调， │
// │    再由 orchestrator 的 sinkFor 转成 SSE。本文件不碰数据库也不碰 HTTP。 │
// └───────────────────────────────────────────────────────────────┘
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai/compat';
import { getSystemMessageText } from '@earendil-works/pi-ai';
import { isRetryableAssistantError } from '@earendil-works/pi-ai/utils/retry';
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
  model: Model<'openai-completions'>;
  apiKey: string;
  systemPrompt: string;
  tools: AgentTool[];
  userPrompt: string;
  signal: AbortSignal;
  sink: PhaseEventSink;
  maxTurns?: number;
  /** LLM 请求上下文快照（09-20）：传入后每次 API 请求落库，失败不影响生成 */
  recorder?: LlmRequestRecorder;
  /** 必须经工具提交的阶段：正文停机后最多提醒一次，复用同一 Agent 上下文与总轮次上限。 */
  completion?: { isComplete(): boolean; reminder: string; errorMessage: string };
}

export interface RunAgentResult {
  tokensIn: number;
  tokensOut: number;
  aborted: boolean;
  turnLimitExceeded: boolean;
  errorMessage?: string;
}

/** 阶段运行器策略：默认 pi-agent-core；有 durable 宿主时换成 pi-durable 会话。 */
export type PhaseAgentRunner = (options: RunAgentOptions) => Promise<RunAgentResult>;

const DEFAULT_MAX_TURNS = 24;

/** 提取工具结果首个文本块作为时间线摘要 */
function summarizeToolResult(result: unknown): string {
  const content = (result as { content?: { type?: string; text?: string }[] })?.content;
  const firstText = Array.isArray(content) ? content.find((c) => typeof c?.text === 'string')?.text : undefined;
  return (firstText ?? '').slice(0, 200);
}

// ---------- 上游瞬时故障重试（09-20） ----------
// 网关/上游抖动（模型短时不可用、限流、5xx、连接中断）只重试当前这一次请求：
// 已完成的工具调用不回滚，单次抖动不再把整次生成判死。请求本身不合法的 400（字段/角色错误）不重试。
// terminated（09-25）：undici 在响应体未读完就被上游关掉时抛的 TypeError，与 socket hang up 同类。
// 实测文案阶段一次长响应跑到 62s 后被切断，因不在白名单而硬失败（文案降级），已纳入。
const LLM_RETRY_DELAYS_MS = [1000, 3000] as const;

/**
 * 只认「换一次请求就可能成功」的错误：主分类交给 pi-ai 的瞬态错误分类器
 * （overloaded / 429 / 5xx / 网络中断，并明确排除 quota/billing 这类确定性失败）；
 * 上游未覆盖的厂商文案（实测「Model is unavailable」）在下面补一条。
 */
const VENDOR_TRANSIENT_ERROR = /model is unavailable/i;

export function isRetryableUpstreamError(message: string): boolean {
  if (VENDOR_TRANSIENT_ERROR.test(message)) return true;
  return isRetryableAssistantError({ stopReason: 'error', errorMessage: message } as AssistantMessage);
}

/** 网关 HTML 不作为模型诊断正文透出；保留 HTTP 状态便于区分网络故障。 */
export function summarizeUpstreamError(message: string): string {
  if (!/<(?:!doctype|html|head|body)\b/i.test(message)) return message;
  const status = message.match(/\b([45]\d{2})\b/)?.[1];
  return `${status ? `HTTP ${status}：` : ''}模型网关返回 HTML 错误页，上游连接失败或超时`;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** 构造错误终态事件：用于 streamSimple 直接抛出（未走事件流）的场景 */
function llmErrorEvent(model: Model<Api>, message: string): AssistantMessageEvent {
  return {
    type: 'error',
    reason: 'error',
    error: {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error',
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

type StreamCall = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/**
 * 包一层上游重试：整次尝试的事件先缓冲，成功（done）才下发 —— 重试不会把上一半消息塞进 agent 上下文。
 * 已产出工具调用增量（toolcall_*）的失败不重试——重放会重复执行有副作用的工具（search_pois 计费）。
 * 仅正文/思考增量的失败仍可重试（09-25）：实测长 reasoning 请求断流必带 thinking_delta，
 * 若按「任何非 start 事件」判死，这类上游抖动会永久判死整次生成（实测 research 阶段 87s 白等、候选 0）。
 */
export function streamWithRetry(
  call: StreamCall,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  delays: readonly number[] = LLM_RETRY_DELAYS_MS,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    for (let attempt = 1; ; attempt++) {
      const buffered: AssistantMessageEvent[] = [];
      let terminal: AssistantMessageEvent;
      try {
        let finished: AssistantMessageEvent | null = null;
        for await (const ev of call(model, context, options)) {
          if (ev.type === 'done' || ev.type === 'error') {
            finished = ev;
            break;
          }
          buffered.push(ev);
        }
        terminal = finished ?? llmErrorEvent(model, '上游响应意外中断');
      } catch (err) {
        terminal = llmErrorEvent(model, err instanceof Error ? err.message : String(err));
      }

      const failed = terminal.type === 'error' ? (terminal.error.errorMessage ?? '') : '';
      const hasToolCall = buffered.some((ev) => ev.type.startsWith('toolcall'));
      const canRetry =
        Boolean(failed) &&
        !hasToolCall &&
        attempt <= delays.length &&
        !options?.signal?.aborted &&
        isRetryableUpstreamError(failed);

      if (!canRetry) {
        for (const ev of buffered) stream.push(ev);
        if (terminal.type === 'error') {
          terminal.error.errorMessage = summarizeUpstreamError(terminal.error.errorMessage ?? failed)
            + (attempt > 1 ? `（上游已重试 ${attempt - 1} 次）` : '');
        }
        stream.push(terminal);
        return;
      }

      const delayMs = delays[attempt - 1] ?? 0;
      console.warn(`[llm-retry] 第 ${attempt} 次请求失败，${delayMs}ms 后重试：${summarizeUpstreamError(failed).slice(0, 200)}`);
      await abortableSleep(delayMs, options?.signal);
    }
  })();
  return stream;
}

export async function runPhaseAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  opts.signal.throwIfAborted();
  if (opts.sink.onTextDelta && opts.tools.length) throw new Error('用户正文流必须使用无工具调用');
  const labelByTool = new Map(opts.tools.map((t) => [t.name, t.label]));
  const result: RunAgentResult = { tokensIn: 0, tokensOut: 0, aborted: false, turnLimitExceeded: false };
  let turns = 0;

  // 请求上下文快照：recorder 落库（llm_request_logs）供排查；requestSeq 为阶段内请求序号（从 1 递增），
  // pendingRowId/pendingTurn 供 message_end 回写响应。
  let requestSeq = 0;
  let pendingRowId: string | null = null;
  let pendingTurn = 0;
  const streamFn: StreamFn = async (model, context, options) => {
    const turn = ++requestSeq;
    pendingTurn = turn;
    // pi 1.5 起 context 只给归一化后的 messages：system prompt 与工具声明都挂在 system 消息上。
    const messages = (context.messages ?? []) as unknown[];
    const leading = context.messages?.find((message) => message.role === 'system');
    const systemPrompt = leading && leading.role === 'system' ? getSystemMessageText(leading) : '';
    const tools = (context.messages ?? []).flatMap((message) => message.role === 'system' ? message.toolsAdded ?? [] : []);
    pendingRowId = opts.recorder
      ? await opts.recorder.recordRequest({ turn, model: model.id, systemPrompt, messages, tools })
      : null;
    // 正文已发给用户后不可重放；共用生成通道继续保留原有完整重试语义。
    return opts.sink.onTextDelta ? streamSimple(model, context, options) : streamWithRetry(streamSimple, model, context, options);
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      // 生成阶段的 DeepSeek V4 通过 model.ts 显式 compat 将 off 发送为 thinking.disabled。
      // 对任意模型，off 本身并不保证请求体含关闭开关；不要用 reasoning_effort 猜测兼容性。
      thinkingLevel: 'off',
      tools: opts.tools,
    },
    getApiKey: () => opts.apiKey,
    streamFn,
  });

  const onAbort = () => agent.abort();
  opts.signal.addEventListener('abort', onAbort, { once: true });

  agent.subscribe((ev) => {
    switch (ev.type) {
      case 'message_update':
        if (ev.assistantMessageEvent.type === 'text_delta') opts.sink.onTextDelta?.(ev.assistantMessageEvent.delta);
        break;
      case 'turn_start':
        turns += 1;
        if (turns > (opts.maxTurns ?? DEFAULT_MAX_TURNS)) {
          result.turnLimitExceeded = true;
          result.errorMessage = `轮次超限（>${opts.maxTurns ?? DEFAULT_MAX_TURNS}），已中止`;
          agent.abort();
        }
        break;
      case 'message_end': {
        const msg = ev.message as { role?: string; usage?: { input: number; output: number }; content?: unknown; stopReason?: string; errorMessage?: string };
        if (msg.role !== 'assistant') break;
        result.tokensIn += msg.usage?.input ?? 0;
        result.tokensOut += msg.usage?.output ?? 0;
        opts.sink.onUsage(result.tokensIn, result.tokensOut);
        const texts = Array.isArray(msg.content)
          ? (msg.content as { type?: string; text?: string }[]).filter((c) => c.type === 'text' && c.text).map((c) => c.text!)
          : [];
        const thought = texts.join('\n').trim();
        if (thought) opts.sink.onThought(thought.slice(0, 1500));
        if (msg.stopReason === 'error' && msg.errorMessage) result.errorMessage = msg.errorMessage;
        if (pendingTurn) {
          opts.sink.onLlmResponse?.({ turn: pendingTurn, stopReason: msg.stopReason, usage: msg.usage, errorMessage: msg.errorMessage });
          pendingTurn = 0;
        }
        if (pendingRowId && opts.recorder) {
          const rowId = pendingRowId;
          pendingRowId = null;
          void opts.recorder.recordResponse(rowId, {
            stopReason: msg.stopReason,
            usage: msg.usage,
            errorMessage: msg.errorMessage,
            text: thought || undefined,
          });
        }
        break;
      }
      case 'tool_execution_start':
        opts.sink.onToolStart(ev.toolCallId, ev.toolName, labelByTool.get(ev.toolName) ?? ev.toolName, ev.args);
        break;
      case 'tool_execution_end':
        opts.sink.onToolEnd(ev.toolCallId, ev.toolName, labelByTool.get(ev.toolName) ?? ev.toolName, summarizeToolResult(ev.result), ev.isError);
        break;
    }
  });

  try {
    await agent.prompt(opts.userPrompt);
    await agent.waitForIdle();
    if (opts.completion && !opts.completion.isComplete() && !opts.signal.aborted
      && !result.errorMessage && !agent.state.errorMessage && turns < (opts.maxTurns ?? DEFAULT_MAX_TURNS)) {
      // 正文中的 JSON 没有经过工具校验，不能直接当作提交；让模型修正协议，不重跑搜索。
      await agent.prompt(opts.completion.reminder);
      await agent.waitForIdle();
    }
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
  }

  result.aborted = opts.signal.aborted;
  if (!result.errorMessage && agent.state.errorMessage && !result.aborted) {
    result.errorMessage = agent.state.errorMessage;
  }
  if (!result.errorMessage && !result.aborted && opts.completion && !opts.completion.isComplete()) {
    result.errorMessage = opts.completion.errorMessage;
  }
  return result;
}
