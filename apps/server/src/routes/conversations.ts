// 会话路由：只保留仍在用的三个接口 + 行程内对话子路由。
//
// 活着的（10-17 核过调用点）：
//   POST   /            惰性建会话（NewTripPage：发起生成前建会话，给编辑器内嵌对话留关联）
//   GET    /:id         会话详情（ChatPanel 读历史消息）
//   PATCH  /:id/brief   写整包 Brief 快照（NewTripPage：首页胶囊收集的参数留档）
//   \+ 子路由            /:id/messages/stream、/:id/operations/*、/:id/food（detailChat.ts）
//
// 已删除的（首页改成地图选城 + 胶囊收集 Brief 后无前端调用点）：
//   GET /、DELETE /:id、POST /:id/messages、PATCH /:id/brief 的确认卡分支。
//   注意「对话理解」本身没有下线 —— 它现在的入口是行程内对话
//   （/:id/messages/stream → services/detailChatService → chat/understanding）。
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { ConversationCreateSchema, PlanningBriefPatchSchema } from '@tripweaver/shared';
import { requireAuth } from '../auth/guard';
import { applyDialogueDecision, briefStatus } from '../chat/brief';
import { createConversation, getConversationDetail, saveBrief } from '../services/conversationService';
import { detailChatRoutes } from './detailChat';

const IdParams = Type.Object({ id: Type.String() });

export const conversationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireAuth);
  await app.register(detailChatRoutes);

  app.post('/', { schema: { body: ConversationCreateSchema } }, async (request, reply) => {
    const conversation = await createConversation(request.user!.id, request.body.title);
    return reply.code(201).send(conversation);
  });

  app.get('/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const detail = await getConversationDetail(request.user!.id, request.params.id);
    if (!detail) return reply.code(404).send({ error: '会话不存在' });
    return detail;
  });

  /**
   * 写 Brief 快照：整包替换，字段归一由 applyDialogueDecision 负责（与对话链路同一个函数，
   * 夹带 id / 来源序号由服务端补），不追加任何对话消息 —— 这不是「用户说过的话」。
   * 前端请求 URL 仍带 `?snapshot=1`，语义已固定在这里，参数不再参与分支。
   */
  app.patch('/:id/brief', { schema: { params: IdParams, body: PlanningBriefPatchSchema } }, async (request, reply) => {
    const userId = request.user!.id;
    const detail = await getConversationDetail(userId, request.params.id);
    if (!detail) return reply.code(404).send({ error: '会话不存在' });

    const evidenceSequence = (detail.messages.at(-1)?.sequence ?? 0) + 1;
    const nextData = applyDialogueDecision(detail.conversation.brief.data, request.body, evidenceSequence);
    const brief = await saveBrief(userId, request.params.id, nextData, briefStatus(nextData, detail.conversation.brief.status));
    if (!brief) return reply.code(404).send({ error: '会话不存在' });
    return { brief, intent: 'update_brief' as const };
  });
};
