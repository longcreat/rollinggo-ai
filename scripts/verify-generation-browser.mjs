// 当前表单直达 → 行前 Agent 委派 → 任务直播 → 详情页，以及刷新恢复/取消的生产浏览器验收。
// 先 npm run build；本地 PG 就绪后 node scripts/verify-generation-browser.mjs。
// VERIFY_GENERATION_ADMIN_URL 只用于创建/删除本脚本随机命名的专用测试库。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startMockLlm } from './lib/mock-llm.mjs';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
// 服务端内部操作名（tool label）：只允许出现在日志里，绝不能出现在用户可见的进度文案中。
const INTERNAL_LABELS = ['查已验证地点库', '搜索地点', '搜索攻略', '写入候选池', '提交调研结果', '提交调研摘要',
  '查询地点坐标', '建立行程骨架', '添加活动', '修改活动', '删除活动', '查看草稿', '调整活动日期', '建议住宿区域',
  '可行性自查', '改写活动说明', '撰写行程标题', '提交行程草稿', '提交文案', '撰写旅行建议与注意事项',
  '筛选行程地点', '解析活动坐标', '调整顺路顺序', '估算通勤路线', '检查时空可行性', '排定每日行程',
  '优化远郊行程', '解析改动地点坐标', '复核最终通勤路线', '优化跨天路线', '复核顺路通勤', '整理行程相关资料',
  '检索片区点位', '查看片区', '排定一天', '验收方案', '提交方案'];
const { Client } = require('pg');
const adminUrl = process.env.VERIFY_GENERATION_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:18797/postgres';
const databaseName = `generation_browser_verify_${Date.now()}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const base = 'http://127.0.0.1:18813';
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
let server;
let mock;
let browser;
let page;
let serverOutput = '';
try {
  mock = await startMockLlm(18812, { delayMs: 1200 });
  server = spawn(process.execPath, ['--import', '../../scripts/lib/local-fetch-only.mjs', '--import', 'tsx', 'src/index.ts'], {
    cwd: 'apps/server', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PORT: '18813', DATABASE_URL: databaseUrl.toString(),
      MASTER_KEY: 'a'.repeat(64), REGISTRATION_MODE: 'invite', INVITE_CODE: 'GENFLOW',
      SITE_LLM_BASE_URL: 'http://127.0.0.1:18812/v1', SITE_LLM_API_KEY: 'mock', SITE_LLM_MODEL: 'mock',
      SSRF_ALLOWLIST: '127.0.0.1:18812', AMAP_KEY: '', SEARCH_API_KEY: '',
      GEN_DAILY_LIMIT: '5', NO_PROXY: 'localhost,127.0.0.1',
    },
  });
  for (const output of [server.stdout, server.stderr]) output.on('data', (data) => { serverOutput += data; });
  let healthy = false;
  for (let i = 0; i < 300; i++) {
    healthy = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
    if (healthy) break;
    await sleep(200);
  }
  assert.ok(healthy, `服务端启动超时\n${serverOutput.slice(-2000)}`);
  const seed = new Client({ connectionString: databaseUrl.toString() });
  await seed.connect();
  try {
    // 健康检查可能早于迁移完成：等表就绪再灌知识库种子。
    for (let i = 0; i < 100; i++) {
      const ready = await seed.query(`select to_regclass('public.canonical_places') as table`);
      if (ready.rows[0]?.table) break;
      await sleep(100);
    }
    await seed.query(`insert into canonical_places (id, city, name, category, source, verified, lat, lng, created_at)
      select 'browser-' || g, '北京', '北京地点' || g, '景点', 'goldset', true, 39.90 + g * 0.0005, 116.39 + g * 0.0005, now()
      from generate_series(1,100) g`);
  } finally { await seed.end(); }

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
    args: ['--no-proxy-server'], headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const browserErrors = [];
  const planningPosts = [];
  const generationPosts = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    const path = new URL(req.url()).pathname;
    if (path.endsWith('/planning')) planningPosts.push(req.postDataJSON());
    if (path === '/api/generations') generationPosts.push(req.postDataJSON());
  });
  await page.goto(`${base}/register`);
  await page.getByLabel('邮箱').fill(`generation-${Date.now()}@test.dev`);
  await page.getByLabel('密码（至少 8 位）').fill('password123');
  await page.getByLabel('确认密码').fill('password123');
  await page.getByLabel('邀请码').fill('GENFLOW');
  await page.getByRole('button', { name: '注册并登录' }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });

  const json = (path) => page.evaluate(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return (await response.json()).data;
  }, path);

  const entry = (city = '北京') => {
    const params = new URLSearchParams({
      city, start: '2026-11-05', end: '2026-11-07', pace: 'tight',
      preferences: '美食', partySize: '2', transport: 'transit',
      autostart: '1', text: `${city}三天，美食优先，节奏紧一点`,
    });
    return `${base}/trips/new?${params.toString()}`;
  };

  /** 表单直达：建会话 → 写 Brief → 行前 Agent 委派任务 → 进入任务直播页。 */
  const begin = async () => {
    await page.goto(entry());
    await page.waitForURL((url) => url.pathname.startsWith('/agent/'), { timeout: 35_000 });
    const jobId = new URL(page.url()).pathname.split('/').at(-1);
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
    return jobId;
  };
  const editor = async () => {
    await page.waitForURL((url) => /^\/trips\/(?!new$)[^/]+$/.test(url.pathname), { timeout: 60_000 });
    return page.url().split('/').at(-1);
  };
  /** SPA 内导航：保留 zustand 选天，复现「看完某天再发起新生成」。 */
  const beginClient = async (url) => {
    await page.evaluate((target) => {
      history.pushState({}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, url);
    await page.waitForURL((u) => u.pathname.startsWith('/agent/'), { timeout: 35_000 });
    const jobId = new URL(page.url()).pathname.split('/').at(-1);
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
    return jobId;
  };

  const jobId = await begin();
  // 主时间线只显示子 Agent 条目（阶段名/状态/步数），不能泄露服务端内部工具名。
  await page.locator('[data-subagent-row]').first().waitFor({ timeout: 30_000 });
  const liveLines = new Set();
  for (let i = 0; i < 6; i++) {
    for (const text of await page.locator('[data-subagent-row]').allInnerTexts()) liveLines.add(text.replace(/\s+/g, ''));
    await sleep(200);
  }
  assert.ok(liveLines.size > 0, '未采样到子 Agent 条目');
  for (const line of liveLines) {
    for (const label of INTERNAL_LABELS) assert.ok(!line.includes(label), `子 Agent 条目直接显示了内部 label：${label}`);
  }
  // 点击条目进入子 Agent 页面（同一工作区、URL 变化），再返回主时间线。
  await page.locator('[data-subagent-row]').first().click();
  await page.waitForURL((url) => new RegExp(`^/agent/${jobId}/agents/[^/]+$`).test(url.pathname), { timeout: 15_000 });
  await page.getByRole('button', { name: '返回主 Agent', exact: true }).click();
  await page.waitForURL((url) => url.pathname === `/agent/${jobId}`, { timeout: 15_000 });
  const firstTripId = await editor();
  assert.ok(await page.getByRole('region', { name: '行程总览' }).isVisible(), '生成完成应停在总览');
  assert.equal(planningPosts.length, 1, '表单提交应只发生一次行前回合');
  assert.equal(generationPosts.length, 0, '前端不得再直接 POST /generations');
  const trip = await json(`/api/trips/${firstTripId}`);
  const detail = trip.trip ?? trip;
  assert.equal(detail.days.length, 3);
  for (const day of detail.days) {
    assert.ok(day.activities.length <= 8);
    assert.ok(day.activities.some((a) => a.name.includes('午餐')));
    assert.ok(day.activities.some((a) => a.name.includes('晚餐')));
  }
  const { conversationId } = await json(`/api/trips/${firstTripId}/conversation`);
  const conversation = await json(`/api/conversations/${conversationId}`);
  assert.equal(conversation.conversation.brief.data.pace, 'tight');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tw.activeJobId')), null);
  console.log('PASS 表单直达 → 行前委派 → 任务直播 → 详情；Brief 留档、餐次完整、无旧 job 入口');

  // 看完第 2 天再发起新生成：新任务必须回到总览，不能继承上一趟的选天。
  await page.goto(`${base}/trips/${firstTripId}`);
  await page.getByRole('button', { name: '第2天', exact: true }).click();
  await page.getByRole('region', { name: '第2天行程' }).waitFor();
  await beginClient(entry());
  const secondTripId = await editor();
  assert.notEqual(secondTripId, firstTripId);
  assert.ok(await page.getByRole('region', { name: '行程总览' }).isVisible(), '新生成不应继承上一趟选中的第2天');
  assert.equal(planningPosts.length, 2);

  const restoredJobId = await begin();
  await page.reload({ waitUntil: 'domcontentloaded' });
  const restoredTripId = await editor();
  assert.notEqual(restoredTripId, firstTripId);
  assert.equal(planningPosts.length, 3, '刷新不得重复发起行前回合');
  assert.equal(generationPosts.length, 0);
  const restored = await json(`/api/generations/${restoredJobId}`);
  assert.equal(restored.status, 'done');
  assert.equal(restored.tripId, restoredTripId);
  console.log('PASS 生成中刷新恢复到同一任务，完成跳转且无重复提交');

  const usageBefore = await json('/api/usage');
  const jobId = await begin();
  let firstCancel = true;
  await page.route('**/api/generations/*/cancel', async (route) => {
    await sleep(250);
    if (firstCancel) {
      firstCancel = false;
      return route.fulfill({ status: 500, json: { code: 500, message: '模拟取消失败', data: null } });
    }
    return route.continue();
  });
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByRole('button', { name: '正在停止…', exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: '正在停止…', exact: true }).isDisabled());
  await page.getByText('模拟取消失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByText('已停止生成', { exact: true }).waitFor();
  assert.equal((await json(`/api/generations/${jobId}`)).status, 'cancelled');
  assert.equal((await json('/api/usage')).remaining, usageBefore.remaining);
  assert.deepEqual(browserErrors, []);
  assert.ok(!serverOutput.includes('ReferenceError'));
  console.log('PASS 取消失败重试、权威终态与额度不变；浏览器无未处理异常');
} catch (error) {
  await mkdir('verify-shots', { recursive: true });
  if (page) {
    console.error('页面：', page.url(), await page.locator('body').innerText().catch(() => ''));
    await page.screenshot({ path: 'verify-shots/generation-flow-failure.png' }).catch(() => {});
  }
  console.error(serverOutput.slice(-5000));
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
  mock?.close();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
