// 把一个生成阶段跑在 pi-durable 会话上（第 6 项：逐步取代 pi-agent-core 的 runner）。
//
// 工具是每阶段闭包，pi-durable 按名字从 registry 解析；与对话共用存储后，
// 靠「每次安装唯一命名的扩展 + 会话显式选择它」隔离，而不是靠分文件。
// 阶段是顺序执行的，工具闭包在阶段生命周期内稳定。
import {
  AssistantEntry,
  LiveDoc,
  defineExtension,
  defineTool,
  type Harness,
  type Registry,
  type TaskId,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { uid } from '@tripweaver/shared';
import type { PhaseEventSink, RunAgentOptions, RunAgentResult } from './phase';

export interface DurablePhaseHost {
  harness: Harness;
  registry: Registry;
  context: Context;
  /** 生成任务 id：phase 会话归属到任务，随任务级联 abort，避免无主会话堆积。 */
  taskId?: TaskId;
}

export interface DurablePhaseOptions {
  host: DurablePhaseHost;
  /** 扩展名前缀（每阶段唯一），用于隔离不同阶段的工具闭包。 */
  phaseKey: string;
  modelRef: { provider: string; modelId: string };
  opts: RunAgentOptions;
  onConversationCreated?: (conversationId: string) => void;
}

/** AgentTool（pi-agent-core）→ ToolRegistration（pi-durable）。返回形状与 terminate 语义一一对应。 */
function toDurableTool(tool: AgentTool, signal: AbortSignal): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as object,
    execute: async (args) => {
      const result = await tool.execute(uid(), args as never, signal);
      return {
        output: result.content,
        ...(result.details !== undefined ? { details: result.details as never } : {}),
        ...(result.isError ? { isError: true } : {}),
        ...(result.terminate ? { control: { terminate: true } } : {}),
      };
    },
  });
}

export async function runDurablePhaseAgent(input: DurablePhaseOptions): Promise<RunAgentResult> {
  const { host, phaseKey, modelRef, opts } = input;
  const { signal, sink } = opts;
  signal.throwIfAborted();
  if (opts.sink.onTextDelta) throw new Error('durable 阶段暂不支持逐字正文流');

  const labels = new Map(opts.tools.map((tool) => [tool.name, tool.label]));
  const tools = opts.tools.map((tool) => toDurableTool(tool, signal));
  if (!tools.length) throw new Error(`durable 阶段 ${phaseKey} 至少需要一个工具`);
  // 扩展名按阶段固定：同名 replace 不会在 registry 里累积（生成任务单用户串行，闭包在阶段内稳定）。
  const extension = defineExtension({ name: `gen-${phaseKey}`, tools });
  host.registry.install(extension);

  const conversation = await host.harness.createConversation({
    // 有任务 id 时归属任务；旧调用点不传时退回 ownerless（兼容测试与历史路径）。
    ownership: host.taskId ? { kind: 'task', taskId: host.taskId } : { kind: 'ownerless' },
    agent: {
      instructions: opts.systemPrompt,
      model: modelRef,
      maxTurns: opts.maxTurns ?? 16,
      // 显式只选本阶段的扩展：与对话共用存储后，默认「全部已安装」会串进主 Agent 的工具。
      extensions: [extension],
      tools,
      modelTools: tools,
    },
  }, host.context);
  input.onConversationCreated?.(String(conversation.id));

  const live = await host.harness.watchDoc(LiveDoc, conversation.id, host.context);
  if (!live) throw new Error('LiveDoc 不可用');

  const started = new Map<string, { name: string; at: number }>();
  const seen = new Set<string>();
  live.start(async (call) => {
    if (call.kind !== 'value') return;
    for (const slot of call.value?.tools ?? []) {
      if (!seen.has(slot.callId)) {
        seen.add(slot.callId);
        started.set(slot.callId, { name: slot.name, at: Date.now() });
        sink.onToolStart(slot.callId, slot.name, labels.get(slot.name) ?? slot.name, {});
      }
      if (slot.status === 'done' && started.has(slot.callId)) {
        const meta = started.get(slot.callId)!;
        started.delete(slot.callId);
        const failed = Boolean(slot.diagnostics?.some((item) => item.severity === 'error')) || slot.entry === undefined;
        sink.onToolEnd(slot.callId, slot.name, labels.get(slot.name) ?? slot.name, failed ? '未完成' : '完成', failed);
        void meta;
      }
    }
  });

  const onAbort = () => { void conversation.abort(host.context).catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });

  let turnLimitExceeded = false;
  let errorMessage: string | undefined;
  try {
    const first = await conversation.submit({ type: 'input', content: opts.userPrompt }, host.context);
    let settled = await first.wait(host.context);
    if (settled.status === 'unanswered' && settled.reason === 'turn_limit') turnLimitExceeded = true;
    // 必须经工具提交的阶段：正文停机但没提交时提醒一次，复用同一会话与轮次上限。
    if (opts.completion && settled.status === 'done' && !opts.completion.isComplete()) {
      const retry = await conversation.submit({ type: 'input', content: opts.completion.reminder }, host.context);
      settled = await retry.wait(host.context);
      if (settled.status === 'unanswered' && settled.reason === 'turn_limit') turnLimitExceeded = true;
    }
    await conversation.waitForIdle(host.context);
    signal.throwIfAborted();
    if (settled.status !== 'done') {
      errorMessage = opts.completion?.errorMessage ?? String(settled.reason ?? 'unanswered');
    } else if (opts.completion && !opts.completion.isComplete()) {
      errorMessage = opts.completion.errorMessage;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await live.stop().catch(() => {});
  }

  // usage 从已提交的 assistant entries 累计，并按消息补发 sink 事件：
  // 评测依赖 llm_response 计数（plan 阶段必须调用模型），投影依赖 usage 事件。
  const entries = await conversation.entries({ order: 'ascending' }, 400, undefined, host.context).catch(() => undefined);
  let tokensIn = 0;
  let tokensOut = 0;
  let turn = 0;
  for (const entry of entries?.items ?? []) {
    if (entry.kind !== AssistantEntry.kind) continue;
    for (const message of entry.model ?? []) {
      if (message.role !== 'assistant') continue;
      const input = message.usage?.input ?? 0;
      const output = message.usage?.output ?? 0;
      tokensIn += input;
      tokensOut += output;
      sink.onUsage(input, output);
      sink.onLlmResponse?.({
        turn: (turn += 1),
        stopReason: message.stopReason,
        usage: { input, output },
        errorMessage: message.errorMessage,
      });
    }
  }

  return {
    tokensIn,
    tokensOut,
    aborted: signal.aborted,
    turnLimitExceeded,
    conversationId: String(conversation.id),
    ...(errorMessage ? { errorMessage } : {}),
  };
}