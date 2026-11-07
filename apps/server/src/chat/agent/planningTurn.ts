// 行前回合：还没有行程，只有会话与 Brief。表单入口把首条消息交给主 Agent，
// Agent 确认条件后调用 generate_trip 委派后台任务；模型漏调时用确定性兜底启动。
import { Value } from '@sinclair/typebox/value';
import type { AgentStep, ChatAttachment, PlanningBriefData, PlanningTurnRequest, SendMessageResult } from '@tripweaver/shared';
import { SendMessageResultSchema, requiredBriefFields } from '@tripweaver/shared';
import { agentStoragePath, ensureAgentStorageDir } from '../../generation/agentStorage';
import { startGenerationTask } from '../../generation/startGeneration';
import { GenerationTask, type GenerationTaskInput } from '../../generation/generationTask';
import { appendMessages, getConversationDetail, saveBrief } from '../../services/conversationService';
import { commitOperation } from '../../services/detailOperationService';
import type { LlmConfig } from '../../services/settingsService';
import { applyDialogueDecision, briefStatus } from '../brief';
import { readBinding, saveBinding } from './binding';
import { delegateGeneration, readGenerationStatus } from './delegate';
import { TOOL_LABEL } from './labels';
import { PLANNING_INSTRUCTIONS, buildPlanningPrompt } from './planningPrompt';
import { agentModelRef, buildAgentModels } from './models';
import { runAgentTurn } from './runtime';
import { createPlanningTools } from './tools';
import { createAgentTurnState } from './turnState';
import type { DetailChatEmit } from './turn';
import type { ConversationId, ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';

export interface RunPlanningAnswerOptions {
  userId: string;
  conversationId: string;
  detail: NonNullable<Awaited<ReturnType<typeof getConversationDetail>>>;
  input: PlanningTurnRequest;
  cfg: LlmConfig;
  fingerprint: string;
  signal: AbortSignal;
  emit: DetailChatEmit;
}

export async function runPlanningAnswer(options: RunPlanningAnswerOptions): Promise<SendMessageResult> {
  const { userId, conversationId, detail, input, cfg, fingerprint, signal, emit } = options;
  await ensureAgentStorageDir();
  const state = createAgentTurnState();
  const evidenceSequence = (detail.messages.at(-1)?.sequence ?? 0) + 1;
  const briefWithPatch = (): PlanningBriefData => state.briefPatch
    ? applyDialogueDecision(detail.conversation.brief.data, { ...state.briefPatch, intent: 'update_brief' }, evidenceSequence)
    : detail.conversation.brief.data;

  const createTask = (taskInput: GenerationTaskInput) => startGenerationTask(taskInput);
  const generateTrip = (api: ToolExecutionApi, context: Context) => delegateGeneration({
    userId,
    conversationId,
    brief: briefWithPatch(),
    requestId: input.requestId,
    onRunning: 'adopt',
    createTask: (taskInput) =>
      api.createTask(GenerationTask, taskInput, { ownership: { kind: 'conversation' }, background: true }, context),
  });
  const generationStatus = () => readGenerationStatus(userId, state.startedGenerationJobId);

  const durableId = await readBinding(userId, conversationId);
  const steps: AgentStep[] = [];
  const result = await runAgentTurn({
    storagePath: agentStoragePath(userId),
    models: await buildAgentModels(cfg),
    tools: createPlanningTools({ state, generateTrip, generationStatus }),
    instructions: PLANNING_INSTRUCTIONS,
    model: agentModelRef(cfg.model),
    prompt: buildPlanningPrompt({ brief: detail.conversation.brief.data, text: input.text, autostart: Boolean(input.autostart) }),
    // 行前回合只确认并委派，不需要长工具链；给上限避免异常模型把表单提交拖住。
    maxTurns: 6,
    conversationId: durableId === null ? null : durableId as unknown as ConversationId,
    signal,
    onConversationCreated: (id) => saveBinding(userId, conversationId, id),
    onEvent: (event) => {
      if (event.type === 'tool_start' || event.type === 'tool_end') {
        const label = (TOOL_LABEL[event.name] ?? '处理中').slice(0, 40);
        const previous = steps.find((item) => item.id === event.callId.slice(0, 100));
        const step: AgentStep = event.type === 'tool_start'
          ? { id: event.callId.slice(0, 100), name: event.name.slice(0, 60), label, status: 'running', startedAt: event.startedAt }
          : {
            id: event.callId.slice(0, 100), name: event.name.slice(0, 60), label, status: event.status,
            ...(previous?.startedAt !== undefined ? { startedAt: previous.startedAt } : {}),
            durationMs: event.durationMs,
          };
        const index = steps.findIndex((item) => item.id === step.id);
        if (index >= 0) steps[index] = step; else steps.push(step);
        emit({ type: 'progress', text: event.type === 'tool_start' ? `正在${label}…` : `${label}${event.status === 'done' ? '完成' : '未完成'}`, step: { ...step } });
      }
      if (event.type === 'text') emit({ type: 'answer_delta', text: event.text, replace: true });
    },
  });
  signal.throwIfAborted();

  // 模型没调用 generate_trip 时确定性兜底：表单「开始规划」不能因为一次模型判断而没反应。
  let startedJobId = state.startedGenerationJobId;
  let failure: string | undefined;
  if (input.autostart && !startedJobId) {
    const brief = briefWithPatch();
    const missing = requiredBriefFields(brief);
    if (missing.length) {
      failure = `生成还缺少：${missing.join('、')}`;
    } else {
      const delegated = await delegateGeneration({
        userId,
        conversationId,
        brief,
        requestId: input.requestId,
        onRunning: 'adopt',
        createTask,
      });
      if (delegated.jobId) startedJobId = delegated.jobId;
      else failure = delegated.error;
      if (delegated.jobId) state.startedGenerationJobId = delegated.jobId;
    }
  }

  const spoken = result.text.trim();
  let answer = (spoken
    || (startedJobId ? '已经按表单条件在后台开始生成，可在任务里查看进度。' : '')
    || (failure ? `没有开始生成：${failure}` : '已收到你的出行条件。')).slice(0, 4000);
  if (result.status !== 'done' && !startedJobId) {
    throw Object.assign(new Error('回答中断，请重试'), { statusCode: 502 });
  }

  const briefData = briefWithPatch();
  const nextBriefStatus = briefStatus(briefData, detail.conversation.brief.status);
  const attachment: ChatAttachment = {
    tripId: '',
    summary: steps.map((step) => step.label).slice(0, 20),
    ...(steps.length ? { steps: steps.slice(0, 24) } : {}),
    candidates: [],
    ...(startedJobId ? { task: { jobId: startedJobId } } : {}),
  };

  const committed = await commitOperation(userId, input.requestId, fingerprint, async (tx) => {
    signal.throwIfAborted();
    const messages = await appendMessages({
      userId,
      conversationId,
      messages: [
        { role: 'user', content: input.text },
        { role: 'assistant', content: answer, attachment },
      ],
    }, tx);
    const brief = await saveBrief(userId, conversationId, briefData, nextBriefStatus, tx);
    if (!messages?.[0] || !messages[1] || !brief) throw new Error('会话保存失败');
    const payload = {
      userMessage: messages[0],
      replyMessage: messages[1],
      brief,
      intent: startedJobId ? 'confirm' : state.briefPatch ? 'update_brief' : 'travel_qa',
      ...(startedJobId ? { startedGenerationJobId: startedJobId } : {}),
    };
    if (!Value.Check(SendMessageResultSchema, payload)) throw new Error('对话结果无效');
    return payload;
  });
  if (!Value.Check(SendMessageResultSchema, committed)) throw new Error('对话结果无效');
  return committed;
}
