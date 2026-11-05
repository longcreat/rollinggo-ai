import type { FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE, validateSession } from './session';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; email: string };
  }
}

/** 解析会话 cookie 得到当前用户；未登录返回 null（公开探测端点用） */
export async function resolveUser(request: FastifyRequest): Promise<{ id: string; email: string } | null> {
  const token = request.cookies[SESSION_COOKIE];
  return token ? validateSession(token) : null;
}

// 受保护路由的 preHandler；通过后 request.user 可用
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = await resolveUser(request);
  if (!user) {
    await reply.code(401).send({ error: '未登录或会话已过期' });
    return;
  }
  request.user = user;
}
