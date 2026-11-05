import { apiFailure } from './lib/api-contract.mjs';
// 当前首页 → 自动生成 → 编辑器，以及刷新恢复/取消重试的生产浏览器验收。
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
// 服务端内部操作名（tool label）：只允许出现在日志里，绝不能出现在用户可见的进度文案中
const INTERNAL_LABELS = ['查已验证地点库', '搜索地点', '搜索攻略', '写入候选池', '提交调研结果', '提交调研摘要',
  '查询地点坐标', '建立行程骨架', '添加活动', '修改活动', '删除活动', '查看草稿', '调整活动日期', '建议住宿区域',
  '可行性自查', '改写活动说明', '撰写行程标题', '提交行程草稿', '提交文案', '撰写旅行建议与注意事项',
  '筛选行程地点', '解析活动坐标', '调整顺路顺序', '估算通勤路线', '检查时空可行性', '排定每日行程',
  '优化远郊行程', '解析改动地点坐标', '复核最终通勤路线', '优化跨天路线', '复核顺路通勤', '整理行程相关资料'];
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
    await seed.query(`insert into canonical_places (id, city, name, category, source, verified, created_at)
      select 'browser-' || g, '北京', '北京地点' || g, '景点', 'goldset', true, now() from generate_series(1,100) g`);
  } finally { await seed.end(); }

  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
    args: ['--no-proxy-server'], headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const browserErrors = [];
  const generationPosts = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/generations') generationPosts.push(req.postDataJSON());
  });
  await page.goto(`${base}/register`);
  await page.getByLabel('邮箱').fill(`generation-${Date.now()}@test.dev`);
  await page.getByLabel('密码（至少 8 位）').fill('password123');
  await page.getByLabel('确认密码').fill('password123');
  await page.getByLabel('邀请码').fill('GENFLOW');
  await page.getByRole('button', { name: '注册并登录' }).click();
  // /register 会重定向到首页并在 auth Modal 里渲染注册表单；URL 早就是 /，得等 Modal 真正卸载才算登录完成。
  await page.locator('dialog[open]').waitFor({ state: 'detached' });

  const json = (path) => page.evaluate(async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return (await response.json()).data;
  }, path);
  const begin = async () => {
    await page.goto(`${base}/`);
    await page.getByRole('button', { name: /^目的地/ }).click();
    await page.getByRole('button', { name: '北京', exact: true }).click();
    if (generationPosts.length === 0) assert.ok(await page.getByRole('button', { name: '开始规划', exact: true }).isDisabled());
    await page.getByRole('button', { name: /节奏与同行/ }).click();
    await page.getByRole('button', { name: /^特种兵打卡/ }).click();
    await page.getByRole('button', { name: /偏好与出行/ }).click();
    const food = page.getByRole('button', { name: '美食', exact: true });
    if (await food.getAttribute('aria-pressed') !== 'true') await food.click();
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByRole('button', { name: '取消生成', exact: true }).waitFor();
    return page.evaluate(() => sessionStorage.getItem('tw.activeJobId'));
  };
  const editor = async () => {
    await page.waitForURL((url) => /^\/trips\/(?!new$)[^/]+$/.test(url.pathname), { timeout: 35_000 });
    await page.getByRole('group', { name: '行程天数', exact: true }).getByRole('button', { name: '第1天', exact: true }).click();
    await page.locator('.day-section').first().waitFor();
    return page.url().split('/').at(-1);
  };

  await begin();
  await page.locator('figcaption.gen-polaroid-caption').first().waitFor();
  assert.equal(await page.locator('.gen-step-title').count(), 3);
  assert.match(await page.locator('.gen-title').innerText(), /北京.*3 天/);
  // 10-22：进度文案只能来自 lib/generationToolCopy 的工具名映射表，不得泄露服务端内部 label。
  const liveLines = new Set();
  for (let i = 0; i < 15; i++) {
    for (const text of await page.locator('.gen-step-hint-live').allInnerTexts()) liveLines.add(text.replace(/\s+/g, ''));
    await sleep(200);
  }
  assert.ok(liveLines.size > 0, '未采样到进度文案');
  console.log('进度文案采样：', [...liveLines].join(' | '));
  for (const line of liveLines) {
    assert.match(line, /^正在/, `进度文案格式异常：${line}`);
    // 精确比对：fallback 到 label 时会变成「正在<label>…」，而 thought 行带括号进度（12/16）不算泄露
    const core = line.replace(/^正在/, '').replace(/[…\.]+$/, '');
    assert.ok(!INTERNAL_LABELS.includes(core), `进度文案直接显示了内部 label：${line}`);
  }
  const firstTripId = await editor();
  assert.equal(generationPosts.length, 1, '首页单次操作只发起一次任务');
  assert.equal(generationPosts[0].pace, 'tight');
  assert.deepEqual(generationPosts[0].preferences, ['美食']);
  const detail = await json(`/api/trips/${firstTripId}`);
  const trip = detail.trip ?? detail;
  assert.equal(trip.days.length, 3);
  for (const day of trip.days) {
    assert.ok(day.activities.length <= 8);
    assert.ok(day.activities.some((a) => a.name.includes('午餐')));
    assert.ok(day.activities.some((a) => a.name.includes('晚餐')));
  }
  const { conversationId } = await json(`/api/trips/${firstTripId}/conversation`);
  assert.ok(conversationId);
  const conversation = await json(`/api/conversations/${conversationId}`);
  assert.equal(conversation.conversation.brief.data.pace, 'tight');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tw.activeJobId')), null);
  console.log('PASS 当前首页单次提交 → 三阶段/候选 → 编辑器；美食空天完整、活动上限、Brief 留档');

  const restoredJobId = await begin();
  await page.locator('figcaption.gen-polaroid-caption').first().waitFor();
  await page.reload({ waitUntil: 'domcontentloaded' });
  const restoredTripId = await editor();
  assert.notEqual(restoredTripId, firstTripId);
  assert.equal(generationPosts.length, 2, '刷新不得重复发起');
  const restored = await json(`/api/generations/${restoredJobId}`);
  assert.equal(restored.tripId, restoredTripId);
  console.log('PASS 生成中刷新恢复到同一任务，完成跳转且无重复提交');

  await page.evaluate((id) => sessionStorage.setItem('tw.activeJobId', id), restoredJobId);
  await page.goto(`${base}/trips/new?city=${encodeURIComponent('北京')}`);
  assert.equal(await editor(), restoredTripId);
  assert.equal(generationPosts.length, 2);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tw.activeJobId')), null);
  console.log('PASS 恢复已完成快照直接打开原行程，不被首页守卫截走');

  const usageBefore = await json('/api/usage');
  const cancelledJobId = await begin();
  let firstCancel = true;
  await page.route('**/api/generations/*/cancel', async (route) => {
    await sleep(250);
    if (firstCancel) {
      firstCancel = false;
      return route.fulfill({ status: 500, json: apiFailure(500, '模拟取消失败') });
    }
    return route.continue();
  });
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  await page.getByRole('button', { name: '取消中…', exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: '取消中…', exact: true }).isDisabled());
  await page.getByText('模拟取消失败', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消生成', exact: true }).click();
  await page.getByText('已取消', { exact: true }).waitFor();
  assert.equal((await json(`/api/generations/${cancelledJobId}`)).status, 'cancelled');
  assert.equal((await json('/api/usage')).remaining, usageBefore.remaining);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tw.activeJobId')), null);
  await page.getByRole('button', { name: '返回重新规划', exact: true }).click();
  await page.waitForURL(`${base}/`);
  await page.unroute('**/api/generations/*/cancel');
  console.log('PASS 取消 pending/失败重试/权威终态与配额不变，返回首页');

  await begin();
  await page.getByRole('link', { name: '首页', exact: true }).click();
  await page.getByRole('button', { name: /节奏与同行/ }).click();
  await page.getByRole('button', { name: /^轻松悠闲/ }).click();
  await page.getByRole('button', { name: '关闭节奏与同行', exact: true }).click();
  await page.locator('.notification-toast').waitFor({ timeout: 35_000 });
  assert.equal(new URL(page.url()).pathname, '/');
  assert.match(await page.getByRole('button', { name: /节奏与同行/ }).innerText(), /轻松悠闲/);
  assert.equal((await json('/api/settings/travel-preferences')).pace, 'tight', '完成时记住提交快照，不误存首页新草稿');
  await page.locator('.notification-toast').getByRole('button', { name: /查看行程/ }).click();
  await editor();
  assert.equal(generationPosts.length, 4);
  assert.equal((await json('/api/usage')).remaining, usageBefore.remaining - 1);
  assert.deepEqual(browserErrors, []);
  assert.ok(!serverOutput.includes('ReferenceError'));
  console.log('PASS 取消释放运行锁，随后新任务成功；后台完成不抢页面、不覆盖新偏好草稿，通知可打开详情；浏览器无未处理异常');
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
