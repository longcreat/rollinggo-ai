import type { FastifyInstance } from 'fastify';
import { isApiResponse, type ApiResponse } from '@tripweaver/shared';
import { SsrfError } from '../integrations/ssrfGuard';

/**
 * 统一 API 信封（`{ code, message, data }`）与全局错误处理。
 *
 * 为什么用 onSend 钩子而不是改每个 handler：
 * - onSend 在 Fastify 完成 schema 序列化**之后**执行，所以业务字段仍由路由声明的
 *   TypeBox response schema 过滤，信封只加外层皮，不会让 schema 之外的字段漏出去。
 * - 跳过非 /api 路径、204/304/3xx、非 JSON 载荷 —— 静态文件、SSE（handler 内 hijack）、
 *   重定向都不该被包。
 * - 错误分支把 handler 返回的 `{ error, code, ...extra }` 重排为 `{ code, message, data }`：
 *   `code` 优先用业务字符串码（Fastify 内部的 `FST_*` 码要丢弃，否则前端拿到无语义的错误码），
 *   没给就用 HTTP 状态码；`message` 取 `message` 再退到 `error`。
 */
export function installApiResponses(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0] ?? '';
    if (path !== '/api' && !path.startsWith('/api/')) return payload;
    if (reply.statusCode === 204 || reply.statusCode === 304 || (reply.statusCode >= 300 && reply.statusCode < 400)) return payload;
    if (!String(reply.getHeader('content-type')).includes('application/json') || typeof payload !== 'string') return payload;
    const value: unknown = JSON.parse(payload);
    if (isApiResponse(value)) return payload;
    let response: ApiResponse;
    if (reply.statusCode < 400) {
      response = { code: 0, message: '成功', data: value };
    } else {
      const body = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
      const { error, message, code, statusCode: _status, ...data } = body;
      response = {
        code: typeof code === 'string' && code && !code.startsWith('FST_') ? code :
          typeof code === 'number' && Number.isInteger(code) && code !== 0 ? code : reply.statusCode,
        message: typeof message === 'string' ? message : typeof error === 'string' ? error : '请求失败',
        data: Object.keys(data).length ? data : null,
      };
    }
    reply.removeHeader('content-length');
    return JSON.stringify(response);
  });

  // 全局错误出口：SSRF 拦截转成 400（用户输入问题，不是 500）；参数校验失败统一 400 且不回显 schema 细节；
  // 5xx 只在服务端打日志，对外默认「服务器内部错误」不外泄堆栈或数据库报错；
  // 例外：带 expose 标记的业务错误（如生图服务 502/504）保留原 message，
  // 否则用户无法区分「上游挂了」「配额用完」与「代码炸了」。
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof SsrfError) return reply.code(400).send({ error: error.message });
    const err = error as { statusCode?: number; validation?: unknown; message?: string; expose?: boolean };
    if (err.validation) return reply.code(400).send({ error: '请求参数不正确' });
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(error);
    const message = status >= 500 ? (err.expose ? err.message ?? '服务器内部错误' : '服务器内部错误') : (err.message ?? '请求失败');
    return reply.code(status).send({ error: message });
  });
}
