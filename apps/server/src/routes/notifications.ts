// 通知路由（`/api/notifications`）：游标分页列表 / SSE 推送 / 单条已读 / 批量已读
//
// 分页用 `before` 游标而非 offset：通知会陆续插入，offset 翻页会重复或跳条。
//
// `/stream` 只负责「有新通知」的即时提示，客户端收到后回查列表；轮询是兜底。
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { NotificationPageSchema, NotificationQuerySchema, NotificationReadAllSchema } from '@tripweaver/shared';
import { requireAuth } from '../auth/guard';
import { listNotifications, readAllNotifications, readNotification } from '../services/notificationService';
import { subscribeNotifications } from '../services/notificationStream';

const HEARTBEAT_MS = 15_000;

export const notificationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.get('/', { schema: { querystring: NotificationQuerySchema, response: { 200: NotificationPageSchema } } }, async (request) =>
    listNotifications(request.user!.id, request.query.before, request.query.limit));
  app.get('/stream', async (request, reply) => {
    // 先 hijack：否则 Fastify 会尝试序列化返回值，事件流必须直写原始响应
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',     // nginx 类反代禁缓冲，否则事件会被攒成一团
    });
    res.write(': connected\n\n');

    const send = (event: unknown) => {
      if (!res.destroyed) res.write(`event: notification\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = subscribeNotifications(request.user!.id, send);
    // 心跳防反代/浏览器空闲超时；同时兼作连接存活信号
    const heartbeat = setInterval(() => {
      if (!res.destroyed) res.write(': heartbeat\n\n');
    }, HEARTBEAT_MS);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  app.post('/read-all', { schema: { body: NotificationReadAllSchema } }, async (request) => {
    await readAllNotifications(request.user!.id, request.body.through);
    return { ok: true };
  });
  app.post('/:id/read', { schema: { params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }) } }, async (request, reply) => {
    if (!(await readNotification(request.user!.id, request.params.id))) return reply.code(404).send({ error: '通知不存在' });
    return { ok: true };
  });
};
