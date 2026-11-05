// 注册发码的两个守门（10-21）：邮箱格式与「是否已注册」。
// 重点验证「已注册不再静默成功」——旧行为返回 ok 但不发信，用户永远收不到码。
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';

const created: string[] = [];
const { db, pool } = await import('../db/client');
const { users } = await import('../db/schema');
const { authRoutes } = await import('../routes/auth');
const { installApiResponses } = await import('../http/apiResponse');
const { runMigrations } = await import('../db/migrate');

await runMigrations(pool);

const app = Fastify();
installApiResponses(app);
await app.register(authRoutes, { prefix: '/api/auth' });
await app.ready();

// Resend 投递走真实 fetch：拦下来只记录，不发信
const originalFetch = globalThis.fetch;
const delivered: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://api.resend.com/emails') {
    delivered.push(String(JSON.parse(String(init?.body)).to[0]));
    return new Response(JSON.stringify({ id: 'fixture' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return originalFetch(input as RequestInfo, init);
}) as typeof fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
  if (created.length) {
    await db.delete(users).where(eq(users.email, created[0]!));
  }
  await pool.end();
});

const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@verify.test`;

test('已注册邮箱点获取验证码 → 409 且不发信', async () => {
  const email = uniqueEmail('taken');
  created.push(email);
  await db.insert(users).values({ id: crypto.randomUUID(), email, passwordHash: 'x', createdAt: new Date() });

  const before = delivered.length;
  const res = await app.inject({ method: 'POST', url: '/api/auth/email-code', payload: { email, purpose: 'register' } });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { code: 409, message: '该邮箱已注册，请直接登录', data: null });
  assert.equal(delivered.length, before, '已注册邮箱不该再消耗一次发信');
});

test('未注册邮箱请求注册码 → 200 并发信', async () => {
  const email = uniqueEmail('fresh');
  const before = delivered.length;
  const res = await app.inject({ method: 'POST', url: '/api/auth/email-code', payload: { email, purpose: 'register' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { code: 0, message: '成功', data: { ok: true } });
  assert.equal(delivered.length, before + 1, '未注册邮箱应发出验证码');
});

test('找回密码对未注册邮箱仍静默成功（不变成探测器）', async () => {
  const email = uniqueEmail('unknown');
  const before = delivered.length;
  const res = await app.inject({ method: 'POST', url: '/api/auth/email-code', payload: { email, purpose: 'reset' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { code: 0, message: '成功', data: { ok: true } });
  assert.equal(delivered.length, before, '未注册邮箱不该收到重置码');
});

test('邮箱格式非法直接 400，不消耗发信与限流额度', async () => {
  const before = delivered.length;
  for (const email of ['no-at-sign', 'missing@tld', 'has space@example.com', `${'a'.repeat(95)}@example.com`]) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/email-code', payload: { email, purpose: 'register' } });
    assert.equal(res.statusCode, 400, `${email} 应被拒`);
    assert.equal(res.json().message, '请求参数不正确');
  }
  assert.equal(delivered.length, before, '格式非法不该触发发信');
});

test('注册接口对已注册邮箱返回同一句可操作提示', async () => {
  const email = uniqueEmail('dup');
  created.push(email);
  await db.insert(users).values({ id: crypto.randomUUID(), email, passwordHash: 'x', createdAt: new Date() });
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'password123', code: '123456' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().message, '该邮箱已注册，请直接登录');
});
