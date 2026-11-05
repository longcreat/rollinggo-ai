// 用景用量路由：只读视图（已用/上限/重置时间），扣减发生在生成与对话链路内部
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { requireAuth } from '../auth/guard';
import { usageView } from '../services/quotaService';

export const usageRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireAuth);
  app.get('/', async (request) => usageView(request.user!.id));
};
