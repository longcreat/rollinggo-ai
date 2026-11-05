import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Type } from '@sinclair/typebox';
import { isApiResponse } from '@tripweaver/shared';
import { installApiResponses } from '../http/apiResponse';

test('统一 JSON 外层保留状态、Cookie、数组及 schema 字段过滤', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  installApiResponses(app);
  app.get('/api/item', { schema: { response: { 201: Type.Object({ id: Type.String() }) } } }, async (_req, reply) =>
    reply.code(201).header('set-cookie', 'session=fixture; HttpOnly').send({ id: 'trip', secret: 'must-not-leak' }));
  app.get('/api/list', async () => [{ id: 'trip' }]);
  app.post('/api/job', async (_req, reply) => reply.code(202).send({ jobId: 'job' }));
  app.get('/api/null', async (_req, reply) => reply.type('application/json').send('null'));
  app.get('/api/wrapped', async () => ({ code: 0, message: '成功', data: { id: 'trip' } }));
  const item = await app.inject('/api/item');
  assert.equal(item.statusCode, 201);
  assert.deepEqual(item.json(), { code: 0, message: '成功', data: { id: 'trip' } });
  assert.match(String(item.headers['set-cookie']), /HttpOnly/);
  assert.equal(Number(item.headers['content-length']), Buffer.byteLength(item.body));
  assert.deepEqual((await app.inject('/api/list')).json().data, [{ id: 'trip' }]);
  const job = await app.inject({ method: 'POST', url: '/api/job' });
  assert.equal(job.statusCode, 202);
  assert.equal(job.json().data.jobId, 'job');
  assert.equal((await app.inject('/api/null')).json().data, null);
  assert.deepEqual((await app.inject('/api/wrapped')).json().data, { id: 'trip' });
});

test('鉴权、校验、业务冲突、限流、404 与内部异常均返回同一错误契约', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(rateLimit, { global: false });
  installApiResponses(app);
  app.get('/api/private', { preHandler: async (_req, reply) => { await reply.code(401).send({ error: '请登录' }); } }, async () => ({ secret: 'hidden' }));
  app.post('/api/validate', { schema: { body: Type.Object({ count: Type.Integer() }) } }, async () => ({}));
  app.get('/api/conflict', async (_req, reply) => reply.code(409).send({ code: 'job_running', error: '任务进行中', jobId: 'job' }));
  app.get('/api/quota', async (_req, reply) => reply.code(429).send({ code: 'quota_exhausted', error: '今日次数已用完', resetAt: 123 }));
  app.get('/api/limit', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({}));
  app.get('/api/failure', async () => { throw new Error('secret-token database detail'); });
  // 带 expose 标记的业务 5xx（如生图服务 504）：保留真实原因，否则用户无法分辨上游挂了还是代码炸了
  app.get('/api/exposed', async () => { throw Object.assign(new Error('生图服务暂不可用（HTTP 504）'), { statusCode: 502, expose: true }); });
  assert.deepEqual((await app.inject('/api/private')).json(), { code: 401, message: '请登录', data: null });
  const invalid = await app.inject({ method: 'POST', url: '/api/validate', payload: { count: 'secret' } });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { code: 400, message: '请求参数不正确', data: null });
  assert.deepEqual((await app.inject('/api/conflict')).json(), { code: 'job_running', message: '任务进行中', data: { jobId: 'job' } });
  assert.deepEqual((await app.inject('/api/quota')).json(), { code: 'quota_exhausted', message: '今日次数已用完', data: { resetAt: 123 } });
  await app.inject('/api/limit');
  const limited = await app.inject('/api/limit');
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, 429);
  assert.ok(limited.headers['retry-after']);
  for (const path of ['/api/missing', '/api/failure']) {
    const response = await app.inject(path);
    assert.ok(isApiResponse(response.json()));
    assert.equal(response.json().code, response.statusCode);
    assert.equal(response.body.includes('secret-token'), false);
  }
  assert.equal((await app.inject('/api/failure')).json().message, '服务器内部错误');
  const exposed = await app.inject('/api/exposed');
  assert.equal(exposed.statusCode, 502);
  assert.deepEqual(exposed.json(), { code: 502, message: '生图服务暂不可用（HTTP 504）', data: null });
});

test('SSE、重定向、静态资源及无实体响应保持协议，API fallback 可以由应用安装', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  installApiResponses(app);
  app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.type('text/html').send('<main>app</main>'));
  app.get('/api/events', async (_req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.end('data: {"type":"done"}\n\n');
  });
  app.get('/api/oauth', async (_req, reply) => reply.redirect('/login'));
  app.get('/api/empty', async (_req, reply) => reply.code(204).send());
  app.get('/media/config.json', async () => ({ asset: true }));
  assert.equal((await app.inject('/api/events')).body, 'data: {"type":"done"}\n\n');
  const redirect = await app.inject('/api/oauth');
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, '/login');
  assert.equal((await app.inject('/api/empty')).body, '');
  assert.deepEqual((await app.inject('/media/config.json')).json(), { asset: true });
  assert.equal((await app.inject('/trips')).body, '<main>app</main>');
  assert.deepEqual((await app.inject('/api/unknown')).json(), { code: 404, message: '接口不存在', data: null });
});
