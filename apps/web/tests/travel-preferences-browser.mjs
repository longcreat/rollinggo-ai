import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { makeSampleTrip } from '../../../packages/shared/src/sample.ts';
import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--no-proxy-server', '--disable-features=LocalNetworkAccessChecks'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(15_000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const defaults = () => ({ preferences: [], transportMode: 'transit', pace: null, partySize: 2, extraNotes: '' });
const saved = { a: defaults(), b: defaults() };
let account = 'a';
let authenticated = true;
let failLoad = false;
let failSave = false;
let generationOk = false;
let activeWrites = 0;
let brief;
let briefUrl = '';
let generation;
const writes = [];
await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
  const req = route.request();
  const path = new URL(req.url()).pathname;
  const ok = (data) => route.fulfill({ json: apiSuccess(data) });
  if (path === '/api/auth/me') return ok(authenticated ? { id: account, email: `${account}@example.test` } : null);
  if (path === '/api/auth/config') return ok({ registrationMode: 'open', githubEnabled: false });
  if (path === '/api/auth/login') {
    authenticated = true;
    account = req.postDataJSON().email.startsWith('b@') ? 'b' : 'a';
    return ok({ id: account, email: `${account}@example.test` });
  }
  if (path === '/api/auth/logout') { authenticated = false; return ok({ ok: true }); }
  if (path === '/api/trips') return ok({ items: [], total: 0, destinations: [] });
  if (path === '/api/notifications') return ok({ items: [], hasUnread: false, readThrough: 0, nextCursor: null });
  if (path === '/api/generations/current') return ok(null);
  if (path === '/api/generations/job-success') return ok({ jobId: 'job-success', status: 'done', tripId: 'trip-generated', createdAt: Date.now() });
  if (path === '/api/trips/trip-generated') return ok({ ...makeSampleTrip(Date.now()), id: 'trip-generated' });
  if (path.endsWith('/versions')) return ok({ versions: [{ id: 'trip-generated', version: 1, title: '测试行程', createdAt: Date.now() }] });
  if (path.endsWith('/conversation')) return ok({ conversationId: null });
  if (path === '/api/usage') return ok({ remaining: 5, dailyLimit: 5 });
  if (path === '/api/destinations/covered') return ok({ cities: ['北京', '杭州'] });
  if (path === '/api/settings/travel-preferences') {
    const owner = account;
    if (req.method() === 'GET') return failLoad
      ? route.fulfill({ status: 500, json: apiFailure(500, '加载失败') }) : ok(saved[owner]);
    if (failSave) return route.fulfill({ status: 500, json: apiFailure(500, '保存失败') });
    activeWrites++;
    const body = req.postDataJSON();
    writes.push(body);
    saved[owner] = body;
    activeWrites--;
    return ok(body);
  }
  if (path === '/api/conversations' && req.method() === 'POST') return ok({ id: 'conversation-test' });
  if (path === '/api/conversations/conversation-test/brief') { brief = req.postDataJSON(); briefUrl = req.url(); return ok({}); }
  if (path === '/api/generations' && req.method() === 'POST') {
    generation = req.postDataJSON();
    return generationOk
      ? ok({ jobId: 'job-success' })
      : route.fulfill({ status: 400, json: apiFailure(400, '测试已捕获生成请求') });
  }
  // SSE：一条 job_done 即生成成功，前端据此把首页草稿写进账号
  if (path === '/api/generations/job-success/events') {
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: `id: 1\ndata: ${JSON.stringify({ type: 'job_done', tripId: 'trip-generated' })}\n\n` });
  }
  return ok({});
});
const base = process.env.BASE ?? 'http://127.0.0.1:5173';
// 备注区不再常驻保存提示：等「正在保存…」消失且 mock 服务端已写入，得到与旧提示等价的同步点。
const waitSaved = async (expected) => {
  const matched = () => Object.keys(expected).every((key) => JSON.stringify(saved[account][key]) === JSON.stringify(expected[key]));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (matched() && activeWrites === 0 && !(await page.getByText('正在保存…', { exact: true }).isVisible())) return;
    await page.waitForTimeout(50);
  }
  assert.fail(`保存未在超时前写入：期望 ${JSON.stringify(expected)}，当前 ${JSON.stringify(saved[account])}`);
};
const openMore = () => page.getByRole('button', { name: /偏好与出行/ }).click();
const pickTrip = async () => {
  await page.getByRole('button', { name: /^目的地/ }).click();
  await page.getByRole('button', { name: '北京', exact: true }).click();
  await page.getByRole('button', { name: /节奏与同行/ }).click();
  await page.getByRole('button', { name: /少走路/ }).click();
};
const checkBounds = async () => {
  const bad = await page.evaluate(() => [...document.querySelectorAll('header a, header button, textarea, dialog[open]')]
    .filter((el) => el.getClientRects().length).map((el) => ({ text: el.textContent, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.left < -1 || r.right > innerWidth + 1));
  assert.deepEqual(bad, []);
};
try {
  await page.goto(base);
  await openMore();
  assert.equal(writes.length, 0, '加载默认设置不应触发保存');
  await page.getByLabel('备注').fill('带小孩一起，需要午休');
  await page.getByRole('button', { name: '美食', exact: true }).click();
  await page.getByRole('button', { name: /自驾/ }).click();
  await page.waitForTimeout(800);
  assert.equal(writes.length, 0, '生成成功前首页选择不得写账号');
  assert.deepEqual(saved.a, defaults());
  await mkdir('data/travel-preferences-review', { recursive: true });
  await page.screenshot({ path: 'data/travel-preferences-review/home-desktop.png' });
  // 新账号还没选过节奏，也不要有预选的同行人数
  await page.getByRole('button', { name: /节奏与同行/ }).click();
  assert.equal(await page.getByRole('button', { name: /少走路/ }).getAttribute('aria-pressed'), 'false', '新账号不预选节奏');
  await page.getByText('2 人同行', { exact: true }).waitFor();
  await page.reload();
  await openMore();
  assert.equal(await page.getByLabel('备注').inputValue(), '', '未生成过的首页改动不跨会话保留');
  assert.equal(await page.getByRole('button', { name: '美食', exact: true }).getAttribute('aria-pressed'), 'false');

  // 生成失败：首页选择同样不进账号
  await pickTrip();
  await openMore();
  const failedNotes = '生成失败不记忆';
  await page.getByLabel('备注').fill(failedNotes);
  await page.getByRole('button', { name: '开始规划', exact: true }).click();
  await page.getByText('测试已捕获生成请求', { exact: true }).waitFor();
  assert.equal(generation.extraNotes, failedNotes);
  assert.equal(brief.extraNotes, failedNotes);
  await page.waitForTimeout(800);
  assert.equal(writes.length, 0, '生成失败不得写账号');
  assert.deepEqual(saved.a, defaults());

  // 生成成功：首页草稿一次性写进账号
  await page.getByRole('link', { name: '回首页重新选择' }).click();
  await pickTrip();
  await openMore();
  const submittedNotes = '带小孩一起，避开台阶，需要午休';
  await page.getByLabel('备注').fill(submittedNotes);
  await page.getByRole('button', { name: '美食', exact: true }).click();
  // 节奏与同行人数也进账号记忆：节奏已由 pickTrip 选中，这里再加一人
  await page.getByRole('button', { name: /节奏与同行/ }).click();
  await page.getByRole('button', { name: '增加人数' }).click();
  generationOk = true;
  const putAfterGeneration = page.waitForResponse((res) =>
    res.request().method() === 'PUT' && new URL(res.url()).pathname === '/api/settings/travel-preferences');
  await page.getByRole('button', { name: '开始规划', exact: true }).click();
  await putAfterGeneration;
  await page.waitForURL('**/trips/trip-generated');
  assert.equal(generation.extraNotes, submittedNotes);
  assert.equal(brief.extraNotes, submittedNotes);
  assert.ok(briefUrl.includes('snapshot=1'), '首页留档 Brief 走 snapshot，不在对话里产生「已更新…」消息');
  await waitSaved({ extraNotes: submittedNotes, preferences: ['美食'], transportMode: 'transit', pace: 'relaxed', partySize: 3 });
  // 生成成功直接跳详情页，不停留进度面板；回首页继续后面的用例
  await page.goto(base);
  await openMore();
  assert.equal(await page.getByLabel('备注').inputValue(), submittedNotes);
  assert.equal(await page.getByRole('button', { name: '美食', exact: true }).getAttribute('aria-pressed'), 'true');
  // 重开首页：节奏与同行人数直接从账号记忆里带出来，不用重选
  await page.getByRole('button', { name: /节奏与同行/ }).click();
  assert.equal(await page.getByRole('button', { name: /少走路/ }).getAttribute('aria-pressed'), 'true', '节奏应随账号记忆预选');
  await page.getByText('3 人同行', { exact: true }).waitFor();

  // 个人资料入口已移除，偏好继续在首页管理；窄屏不溢出。
  assert.equal(await page.getByRole('button', { name: '个人资料', exact: true }).count(), 0);
  await page.setViewportSize({ width: 375, height: 812 });
  await openMore();
  await checkBounds();
  await page.screenshot({ path: 'data/travel-preferences-review/home-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 960 });
  // 跨布局断点会关闭弹层，重新打开仍应保留同一份草稿。
  await openMore();

  // 未提交草稿在账号切换后清理，账号 B 不继承 A 的记忆。
  await page.getByLabel('备注').fill('尚未生成的新草稿');
  account = 'b';
  await page.reload();
  await openMore();
  assert.equal(await page.getByLabel('备注').inputValue(), '');
  assert.deepEqual(saved.b, defaults());

  failLoad = true;
  await page.reload();
  await openMore();
  await page.getByText('偏好加载失败，请重试', { exact: true }).waitFor();
  failLoad = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByLabel('备注').waitFor();

  // 图标退出、同一 SPA 重新登录，恢复账号 A 上次生成成功时的偏好。
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('邮箱').fill('a@example.test');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await page.getByRole('dialog', { name: '登录 RollingGo' }).getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('link', { name: '返回首页', exact: true }).click();
  await openMore();
  assert.equal(await page.getByLabel('备注').inputValue(), submittedNotes);
  assert.equal(writes.length, 1);
  // 生成已成功但偏好保存失败，提示可重试，重试仍写这次提交的快照。
  await pickTrip();
  await openMore();
  await page.getByLabel('备注').fill('等待重试的生成偏好');
  failSave = true;
  const failedPut = page.waitForResponse((res) => res.request().method() === 'PUT' && res.status() === 500);
  await page.getByRole('button', { name: '开始规划', exact: true }).click();
  await failedPut;
  await page.waitForURL('**/trips/trip-generated');
  await page.getByRole('link', { name: '首页', exact: true }).click();
  await openMore();
  await page.getByText('保存失败，当前修改尚未记住', { exact: true }).waitFor();
  failSave = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await waitSaved({ extraNotes: '等待重试的生成偏好' });
  assert.deepEqual(errors, []);
  console.log('PASS 首页偏好仅生成成功后记忆；失败、刷新不写账号；移除资料入口、手机边界、加载重试及退出登录账号隔离');
} catch (error) {
  console.error('Page errors:', errors);
  console.error('Visible page:', await page.locator('body').innerText());
  throw error;
} finally { await browser.close(); }
