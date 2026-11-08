// 行前对话（兼容端点）：已统一到底层主 Agent（runDetailChat）。
// 保留此路由以防旧客户端或自动化测试依赖 /:id/planning，内部全量走主 Agent ReAct。
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { PlanningTurnRequestSchema, type ChatStreamEvent } from '@tripweaver/shared';
import { hasSiteLlm } from '../env';
import { prepareDetailChat, runDetailChat } from '../services/detailChatService';
import { startDetailTurn } from '../services/detailOperationService';
import { resolveLlmConfig } from '../services/settingsService';
import { streamErrorPayload } from '../chat/streamError';
import { requireAuth } from '../auth/guard';

const Id = Type.Object({ id: Type.String({ maxLength: 100 }) });
const TURN_TIMEOUT_MS = 2 * 60 * 1000;

export const planningRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.post('/:id/planning', { schema: { params: Id, body: PlanningTurnRequestSchema } }, async (request, reply) => {
    const userId = request.user!.id;
    const conversationId = request.params.id;
    const input = request.body;

    const prepared = await prepareDetailChat(userId, conversationId, input);
    if ('saved' in prepared && prepared.saved) return prepared.saved;
    const cfg = await resolveLlmConfig(userId);
    if (!cfg) return reply.code(400).send({ error: '当前没有可用的 AI 配置', code: 'no_llm', hasSiteKey: hasSiteLlm() });

    // 表单入口只要最终结果：`?stream=0` 走普通 JSON，避免前端解析 SSE；对话场景可继续用流。
    const streaming = (request.query as { stream?: string }).stream !== '0';
    if (!streaming) {
      const turn = startDetailTurn(userId, conversationId, input.requestId);
      const timer = setTimeout(() => turn.controller.abort(), TURN_TIMEOUT_MS);
      try {
        return await runDetailChat(userId, conversationId, input, cfg, turn.controller.signal, () => {});
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
      const result = await runDetailChat(userId, conversationId, input, cfg, turn.controller.signal, (event) => send(event));
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
