/**
 * 行程详情页对话路由（挂在 `/api/conversations/:id/...` 下，由 conversations.ts 注册）。
 *
 * 与首页会话对话的区别：这里的上下文是**已有的行程**（改活动、换餐厅、问行程细节），
 * 每条消息都可能直接落到一个新的行程版本上。两类接口并存：
 * - `/messages/stream`：SSE 流式主通道，一轮对话 = 一个 turn（可由 operationId 停止/回查）
 * - `/operations/:operationId`：刷新页面后拉回上一轮的结果（流断了也不丢）
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { DetailChatRequestSchema, AddFoodRequestSchema, type ChatStreamEvent } from '@tripweaver/shared';
import { hasSiteLlm } from '../env';
import { getConversation } from '../services/conversationService';
import { prepareDetailChat, runDetailChat } from '../services/detailChatService';
import { readOperation, startDetailTurn, stopDetailTurn } from '../services/detailOperationService';
import { resolveLlmConfig } from '../services/settingsService';
import { addFood } from '../services/tripHistoryService';

const Id = Type.Object({ id: Type.String({ maxLength: 100 }) });
const Operation = Type.Object({ id: Type.String({ maxLength: 100 }), operationId: Type.String({ maxLength: 100 }) });

export const detailChatRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // 操作结果回查：SSE 中途断开时前端靠它拿回最终结果（服务端 turn 仍在跑，不会因断流被丢弃）
  app.get('/:id/operations/:operationId', { schema: { params: Operation } }, async (request, reply) => {
    if (!await getConversation(request.user!.id, request.params.id)) return reply.code(404).send({ error: '会话不存在' });
    return { result: await readOperation(request.user!.id, request.params.operationId) };
  });
  // 主动停止：先对服务端 turn 发 abort，再返回当前已有结果（可能是半成品）
  app.post('/:id/operations/:operationId/stop', { schema: { params: Operation } }, async (request, reply) => {
    if (!await getConversation(request.user!.id, request.params.id)) return reply.code(404).send({ error: '会话不存在' });
    stopDetailTurn(request.user!.id, request.params.id, request.params.operationId);
    return { result: await readOperation(request.user!.id, request.params.operationId) };
  });
  app.post('/:id/food', { schema: { params: Id, body: AddFoodRequestSchema } }, async (request) =>
    addFood(request.user!.id, request.params.id, request.body));

  /**
   * 一轮详情对话的流式主通道。
   *
   * 协议：`data: {type, requestId, sequence}` 逐条下发（无 `id:` 行，不做 Last-Event-ID 重放；
   * 断线重连靠 `/operations/:operationId` 回查）。本轮只能有一个终态事件（done / error）。
   *
   * `prepareDetailChat` 先处理幂等重发：同一个 requestId 重试时直接回放已保存的结果，不重跑模型。
   * `startDetailTurn` 登记本轮 controller，供 `/stop` 与客户端断开时 abort。
   */
  app.post('/:id/messages/stream', { schema: { params: Id, body: DetailChatRequestSchema } }, async (request, reply) => {
    const userId = request.user!.id;
    const conversationId = request.params.id;
    const input = request.body;
    const prepared = await prepareDetailChat(userId, conversationId, input);
    const cfg = prepared.saved ? null : await resolveLlmConfig(userId);
    if (!prepared.saved && !cfg) return reply.code(400).send({ error: '当前没有可用的 AI 配置', code: 'no_llm', hasSiteKey: hasSiteLlm() });
    const turn = startDetailTurn(userId, conversationId, input.requestId);
    // sequence 只在本轮内递增，前端据此丢弃重复/乱序的事件
    let sequence = 0;
    let terminal = false;
    type Payload = ChatStreamEvent extends infer E ? E extends ChatStreamEvent ? Omit<E, 'requestId' | 'sequence'> : never : never;
    const send = (event: Payload) => {
      if (terminal || reply.raw.destroyed) return;
      if (event.type === 'done' || event.type === 'error') terminal = true;
      reply.raw.write(`data: ${JSON.stringify({ ...event, requestId: input.requestId, sequence: ++sequence })}\n\n`);
    };
    reply.hijack();                                   // 绕过 Fastify 信封与序列化，直接写原始响应流
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    // 浏览器断开 → abort 服务端 turn（释放模型调用，不再往死连接写）
    const disconnect = () => { if (!reply.raw.writableEnded) turn.controller.abort(); };
    reply.raw.on('close', disconnect);
    // 15s 心跳防反代/浏览器空闲超时；5min 硬超时防模型挂死占住 turn
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15000);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; turn.controller.abort(); }, 5 * 60 * 1000);
    try {
      send({ type: 'accepted' });                  // 先确认连接可用，前端据此切换「思考中」态
      const result = prepared.saved ?? await runDetailChat(userId, conversationId, input, cfg!, turn.controller.signal, (type, text) => send({ type, text }));
      if (result.replyMessage.attachment) send({ type: 'recommendations', attachment: result.replyMessage.attachment });
      if (result.editResult) send({ type: 'edit_result', result: result.editResult });
      send({ type: 'done', result });
    } catch (error) {
      // 错误分三类，文案与分析行为不同：
      // stopped = 用户主动停止或被断开（不记警告）；expected = 4xx 业务错（如额度不足，已知，不打栈）
      const stopped = turn.controller.signal.aborted;
      const expected = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500;
      if (!stopped && !expected) request.log.warn({ requestId: input.requestId }, '详情对话失败');
      send({ type: 'error', code: timedOut ? 'timeout' : stopped ? 'stopped' : 'chat_failed', error: timedOut ? '处理超时，原行程未改动，请重试或缩小范围' : stopped ? '已停止' : expected ? error.message : '回答中断，请重试' });
    } finally {
      // 无论哪条退出路径都要清定时器 + 释放 turn 锁，否则同会话后续消息会被判「进行中」
      clearInterval(heartbeat);
      clearTimeout(timeout);
      reply.raw.removeListener('close', disconnect);
      turn.release();
      reply.raw.end();
    }
  });
};
