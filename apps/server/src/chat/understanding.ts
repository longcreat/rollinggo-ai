// 对话理解：单次 LLM 调用 → { reply, Brief 增量, 编辑操作 }。
//
// 复用 generation 层的 Agent 运行器（上游重试 / 轮次上限 / 取消都在那里），
// 但工具面只有 propose_decision 一个：模型除了「交判断」没有别的动作可做。
//
// 边界：这里只理解，不生成行程、也不落地编辑。Brief 的落地由 brief.ts 负责，
// 编辑操作的应用由 editOps.ts + 路由层负责（R1：修订 = 按需编辑，不再整单重跑）。
import type { ChatMessage, PlanningBriefData, Trip } from '@tripweaver/shared';
import { Type } from 'typebox';
import { runPhaseAgent } from '../generation/agents/runner';
import { buildModel } from '../generation/model';
import { defineTool } from '../generation/tools/defineTool';
import type { LlmConfig } from '../services/settingsService';
import {
  DialogueDecisionSchema,
  DialogueUnderstandingError,
  readClarification,
  readDecisionHead,
  readEditOps,
  type DialogueIntent,
} from './models';
import { DIALOGUE_SYSTEM_PROMPT, dialogueUserPrompt, renderBrief, renderCurrentTrip } from './prompts';

/** 只依赖 warn 一个方法，避免把 Fastify 类型带进 chat 模块 */
export interface DialogueLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface UnderstandInput {
  cfg: LlmConfig;
  brief: PlanningBriefData;
  history: ChatMessage[];
  userText: string;
  signal: AbortSignal;
  /** 本会话已生成行程的完整内容；渲染进 prompt（含活动 id），模型才能定位要改哪个活动 */
  currentTrip?: Trip;
  /** 详情页始终用单项问答补充信息，不回退到生成前的表单采集。 */
  detailMode?: boolean;
  logger?: DialogueLogger;
}

export interface UnderstandOutcome {
  intent: DialogueIntent;
  reply: string;
  /** 模型原始输出，交给 applyDialogueDecision 做防御性归一；未调工具时为 null */
  decision: unknown;
  /** 修订操作（R1）；非修订或未给出时为 null，逐条校验由 normalizeEditOps 负责 */
  editOps: unknown[] | null;
  /** 模型给的可点追问（PR6 修正）；没给时为 null，由服务端模板兜底 */
  clarification: { question: string; options: string[] } | null;
  tokensIn: number;
  tokensOut: number;
}

/** 理解只需「调用一次工具」，2 轮留一点自愈余量 */
const MAX_TURNS = 2;

export async function understandMessage(input: UnderstandInput): Promise<UnderstandOutcome> {
  let decision: unknown = null;
  let lastText = '';

  const tool = defineTool({
    name: 'propose_decision',
    label: '提交对话判断',
    description: '提交对用户这条消息的理解，以及需要更新的出行条件。每次回复用户都必须调用一次。',
    parameters: DialogueDecisionSchema,
    execute: async (_toolCallId, params) => {
      decision = params;
      return { content: [{ type: 'text' as const, text: '已记录' }], details: {}, terminate: true };
    },
  });

  const model = await buildModel(input.cfg);
  const result = await runPhaseAgent({
    model,
    apiKey: input.cfg.apiKey,
    systemPrompt: [
      DIALOGUE_SYSTEM_PROMPT,
      renderBrief(input.brief),
      ...(input.currentTrip ? [renderCurrentTrip(input.currentTrip)] : []),
      ...(input.detailMode ? ['当前在已生成行程的详情对话中。优先回答本轮问题，不重新采集已有出行条件。需要补充信息或消除歧义时，一次只问一个问题，在 clarification 提供 2～3 个具体、短小、可直接回答该问题的选项；包括日期也用当前行程日期选项，不要求用户填表。历史选项回答要结合紧邻的助手问题理解；只讨论、问建议不执行修改。'] : []),
    ].join('\n\n'),
    tools: [tool],
    userPrompt: dialogueUserPrompt(input.history, input.userText),
    signal: input.signal,
    maxTurns: MAX_TURNS,
    sink: {
      onThought: (text) => {
        lastText = text;
      },
      onToolStart: () => {},
      onToolEnd: () => {},
      onUsage: () => {},
    },
  });

  const tokensIn = result.tokensIn;
  const tokensOut = result.tokensOut;
  const editOps = readEditOps(decision);
  const clarification = readClarification(decision);
  const head = readDecisionHead(decision);
  if (head) return { ...head, decision, editOps, clarification, tokensIn, tokensOut };

  // 没调工具但有可见正文：当作一轮普通回复，Brief 不变 —— 比直接判失败对用户友好
  const text = lastText.trim();
  if (text) {
    return { intent: 'unclear', reply: text.slice(0, 400), decision: null, editOps: null, clarification: null, tokensIn, tokensOut };
  }

  input.logger?.warn(
    { errorMessage: result.errorMessage ?? '模型未返回内容', aborted: result.aborted },
    '对话理解失败：既没有工具调用也没有正文',
  );
  throw new DialogueUnderstandingError();
}
