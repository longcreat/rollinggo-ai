// 生产前端 + 正式响应边界；隔离内存会话与业务夹具，不访问数据库或真实供应商。
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright';

process.env.MASTER_KEY = 'a'.repeat(64);
const { installApiResponses } = await import('../apps/server/src/http/apiResponse');
const app = Fastify();
await app.register(cookie);
installApiResponses(app);
let activeUser = '';
let nextUser = 'first';
let settingsStatus = 200;
let meCalls = 0;
let loginCalls = 0;
app.get('/api/auth/config', async () => ({ registrationMode: 'open', githubEnabled: false }));
app.post('/api/auth/login', async (req, reply) => {
  loginCalls++;
  const body = req.body as { password: string };
  if (body.password !== 'fixture-password') return reply.code(401).send({ error: '邮箱或密码不正确' });
  activeUser = nextUser;
  reply.setCookie('tw_session', activeUser, { path: '/', httpOnly: true });
  return { id: activeUser, email: `${activeUser}@example.test` };
});
await app.register(async (protectedApi) => {
  protectedApi.addHook('preHandler', async (req, reply) => {
    if (!activeUser || req.cookies.tw_session !== activeUser) return reply.code(401).send({ error: '未登录或会话已过期' });
  });
  protectedApi.get('/auth/me', async () => { meCalls++; return { id: activeUser, email: `${activeUser}@example.test` }; });
  protectedApi.get('/usage', async () => ({ remaining: 4, dailyLimit: 5 }));
  protectedApi.get('/trips', async () => ({ items: [{ id: activeUser, title: activeUser === 'first' ? '旧用户的行程' : '新用户的行程', destination: '北京', daysCount: 2, activityCount: 4, version: 1, createdAt: 0, updatedAt: 0 }], total: 1, destinations: ['北京'] }));
  protectedApi.get('/settings', async (_req, reply) => settingsStatus === 200 ? { byokEnabled: false, baseUrl: '', model: '', apiKeyLast4: '', hasSiteKey: false } : reply.code(settingsStatus).send({ error: '服务暂不可用' }));
}, { prefix: '/api' });
await app.register(fastifyStatic, { root: resolve('apps/web/dist') });
app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'));
await app.listen({ port: 18831, host: '127.0.0.1' });
const base = 'http://127.0.0.1:18831';
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const signIn = async (password = 'fixture-password') => {
    await page.getByLabel('邮箱').fill(`${nextUser}@example.test`);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
  };
  await page.goto(`${base}/trips?sort=name#saved`);
  await page.waitForURL('**/login');
  await signIn('wrong-password');
  await page.getByText('邮箱或密码不正确', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(loginCalls, 1, '登录写入不重试');
  await signIn();
  await page.waitForURL(`${base}/trips?sort=name#saved`);
  await page.getByRole('heading', { name: '旧用户的行程', exact: true }).waitFor();
  const callsBeforeExpiry = meCalls;
  activeUser = '';
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForURL('**/login');
  assert.equal(meCalls, callsBeforeExpiry, '普通业务请求失效，无需先刷新 /auth/me');
  nextUser = 'second';
  await signIn();
  await page.waitForURL(`${base}/trips?sort=name#saved`);
  await page.getByRole('heading', { name: '新用户的行程', exact: true }).waitFor();
  assert.equal(await page.getByText('旧用户的行程', { exact: true }).count(), 0, '旧账号缓存已清理');
  settingsStatus = 503;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(new URL(page.url()).pathname, '/trips', '服务错误不能误判为登出');
  await page.keyboard.press('Escape');
  settingsStatus = 401;
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.waitForURL('**/login');
  const output = resolve('.trellis/tasks/10-03-api-response-contract/research/browser');
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: resolve(output, 'session-expired-login.png') });
  assert.deepEqual(errors, []);
  console.log('PASS 生产前端：初次鉴权、错误密码、原路径恢复、业务 401、缓存隔离、503 不登出、重新登录后再次失效');
} finally { await browser?.close(); await app.close(); }
