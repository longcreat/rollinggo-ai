// 行前对话（表单入口）：还没有行程，主 Agent 确认条件后委派生成。
// 与详情对话共用 turn 锁、幂等键与错误文案；区别只是准入（会话无行程）与工具面（只有委派）。
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import {
  PlanningTurnRequestSchema,
  requiredBriefFields,
  type ChatAttachment,
  type ChatStreamEvent,
} from '@tripweaver/shared';
import { hasSiteLlm } from '../env';
import { preparePlanningChat, runPlanningChat } from '../services/planningChatService';
import { getConversationDetail, appendMessages, latestConversationTrip } from '../services/conversationService';
import { commitOperation, startDetailTurn } from '../services/detailOperationService';
import { delegateGeneration } from '../chat/agent/delegate';
import { startGenerationTask } from '../generation/startGeneration';
import { getTaskByRequestId } from '../generation/taskStore';
import { resolveLlmConfig } from '../services/settingsService';
import { streamErrorPayload } from '../chat/streamError';
import { requireAuth } from '../auth/guard';

const Id = Type.Object({ id: Type.String({ maxLength: 100 }) });
const DirectGenerateBody = Type.Object({
  requestId: Type.String({ maxLength: 100 }),
  text: Type.Optional(Type.String({ maxLength: 1000 })),
});
const TURN_TIMEOUT_MS = 2 * 60 * 1000;

/** 表单直达：没有 LLM 回合，仍补一条带任务卡的委派消息，对话侧保持同一套节点。 */
async function appendDelegationMessage(
  userId: string,
  conversationId: string,
  jobId: string,
  userText: string,
): Promise<void> {
  // 条件已经由任务节点和行程页承载，这里不再复述，避免用户看到重复/错误的天数信息。
  const attachment: ChatAttachment = {
    tripId: '',
    summary: [],
    candidates: [],
    task: { jobId },
  };
  await commitOperation(userId, `gen-delegation:${jobId}`, 'generation-delegation', async (tx) => {
    const messages = await appendMessages({
      userId,
      conversationId,
      messages: [
        // 首页发送的那句话原样留在同一个 Agent 会话里，而不是消失在一个过渡页。
        { role: 'user', content: userText.slice(0, 1000) },
        { role: 'assistant', content: '', attachment },
      ],
    }, tx);
    return { messages };
  });
}

export const planningRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireAuth);

  /**
   * 表单直达：结构化条件已齐备时直接创建生成任务，返回 jobId。
   * 首页带 autostart 时走这里，跳过行前 LLM 回合，客户端拿到 jobId 立即进直播页。
   */
  app.post('/:id/generate', { schema: { params: Id, body: DirectGenerateBody } }, async (request, reply) => {
    const userId = request.user!.id;
    const conversationId = request.params.id;
    // 幂等优先于「已有行程」：请求超时后重试时任务可能已完成并落库，仍应返回同一个 jobId。
    const existing = await getTaskByRequestId(userId, request.body.requestId);
    if (existing) return { jobId: existing.jobId };
    const detail = await getConversationDetail(userId, conversationId);
    if (!detail) return reply.code(404).send({ error: '会话不存在' });
    if (await latestConversationTrip(userId, conversationId)) {
      return reply.code(409).send({ error: '会话已有行程，请进行程内对话', code: 'trip_exists' });
    }
    const brief = detail.conversation.brief.data;
    const text = request.body.text?.trim();
    const merged = text
      ? { ...brief, extraNotes: [brief.extraNotes, text].filter(Boolean).join(' ').slice(0, 200) }
      : brief;
    const missing = requiredBriefFields(merged);
    if (missing.length) {
      return reply.code(400).send({ error: `生成还缺少：${missing.join('、')}` });
    }
    const result = await delegateGeneration({
      userId,
      conversationId,
      brief: merged,
      requestId: request.body.requestId,
      onRunning: 'adopt',
      createTask: (input) => startGenerationTask(input),
    });
    if (!result.jobId) return reply.code(409).send({ error: result.error ?? '生成没有启动' });
    await appendDelegationMessage(
      userId,
      conversationId,
      result.jobId,
      text || `规划${merged.destination ?? ''}行程`,
    );
    return { jobId: result.jobId };
  });

  app.post('/:id/planning', { schema: { params: Id, body: PlanningTurnRequestSchema } }, async (request, reply) => {
    const userId = request.user!.id;
    const conversationId = request.params.id;
    const input = request.body;

    const prepared = await preparePlanningChat(userId, conversationId, input);
    if ('saved' in prepared) return prepared.saved;
    const cfg = await resolveLlmConfig(userId);
    if (!cfg) return reply.code(400).send({ error: '当前没有可用的 AI 配置', code: 'no_llm', hasSiteLlm: hasSiteLlm() });

    // 表单入口只要最终结果：`?stream=0` 走普通 JSON，避免前端解析 SSE；对话场景可继续用流。
    const streaming = (request.query as { stream?: string }).stream !== '0';
    if (!streaming) {
      const turn = startDetailTurn(userId, conversationId, input.requestId);
      const timer = setTimeout(() => turn.controller.abort(), TURN_TIMEOUT_MS);
      try {
        return await runPlanningChat(userId, conversationId, input, cfg, turn.controller.signal, () => {});
      } finally {
        clearTimeout(timer);
        turn.release();
      }
    }

    const turn = startDetailTurn(userId, conversationId, input.requestId);
    let sequence = 0;
    let terminal = false;
    type Payload = ChatStreamEvent extends infer E ? E extends ChatStreamEvent ? Omit<E, 'requestId' | 'sequence'> : never : never;
    const send = (event: Payload) => {
      if (terminal || reply.raw.destroyed) return;
      if (event.type === 'done' || event.type === 'error') terminal = true;
      reply.raw.write(`data: ${JSON.stringify({ ...event, requestId: input.requestId, sequence: ++sequence })}\n\n`);
    };

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      turn.controller.abort();
    }, TURN_TIMEOUT_MS);
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15000);
    const disconnect = () => { if (!reply.raw.writableEnded) turn.controller.abort(); };
    reply.raw.on('close', disconnect);

    try {
      send({ type: 'accepted' });
      const result = await runPlanningChat(userId, conversationId, input, cfg, turn.controller.signal, (event) => send(event));
      if (result.replyMessage.attachment) send({ type: 'recommendations', attachment: result.replyMessage.attachment });
      send({ type: 'done', result });
    } catch (error) {
      const stopped = turn.controller.signal.aborted;
      const expected = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500;
      if (!stopped && !expected) request.log.warn({ err: error, requestId: input.requestId }, '行前对话失败');
      send({ type: 'error', ...streamErrorPayload(error, { timedOut, stopped }) });
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      reply.raw.removeListener('close', disconnect);
      turn.release();
      reply.raw.end();
    }
  });
};
