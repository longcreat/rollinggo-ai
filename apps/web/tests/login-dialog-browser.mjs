// 登录与访客路由回归：只使用隔离 API fixture，不写真实账号或生成任务。
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';

const base = process.env.LOGIN_TEST_URL ?? 'http://127.0.0.1:5173';
const output = '.trellis/tasks/10-05-home-login-dialog/research';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  let authenticated = false;
  let serviceError = false;
  let expireTrips = false;
  let registrationMode = 'open';
  let registrationBody;
  let emailTaken = false;
  const emailCodeRequests = [];
  let generationBody;
  const guestPrivateRequests = [];
  await context.route(`${base}/api/**`, async route => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    if (p === '/api/trips' && expireTrips) {
      authenticated = false;
      return route.fulfill({ status: 401, json: apiFailure(401, '会话已过期') });
    }
    if (p === '/api/auth/me') {
      if (serviceError) return route.fulfill({ status: 503, json: apiFailure(503, '服务暂不可用') });
      return route.fulfill({ json: apiSuccess(authenticated ? { id: 'login-test', email: 'fixture@example.test' } : null) });
    }
    if (p === '/api/auth/login') {
      if (request.postDataJSON().password === 'wrong') return route.fulfill({ status: 401, json: apiFailure(401, '邮箱或密码错误') });
      authenticated = true;
      return route.fulfill({ json: apiSuccess({ id: 'login-test', email: 'fixture@example.test' }) });
    }
    if (p === '/api/auth/email-code') {
      const body = request.postDataJSON();
      emailCodeRequests.push(body);
      if (emailTaken && body.purpose === 'register') return route.fulfill({ status: 409, json: apiFailure(409, '该邮箱已注册，请直接登录') });
      return route.fulfill({ json: apiSuccess({ ok: true }) });
    }
    if (p === '/api/auth/register') {
      registrationBody = request.postDataJSON();
      authenticated = true;
      return route.fulfill({ json: apiSuccess({ id: 'login-test', email: 'fixture@example.test' }) });
    }
    if (p === '/api/auth/logout') { authenticated = false; return route.fulfill({ json: apiSuccess({ ok: true }) }); }
    if (!authenticated && !['/api/auth/config', '/api/destinations/covered'].includes(p)) guestPrivateRequests.push(p);
    if (p === '/api/generations' && request.method() === 'POST') {
      generationBody = request.postDataJSON();
      return route.fulfill({ status: 503, json: apiFailure(503, '测试暂停生成') });
    }
    const fixtures = {
      '/api/auth/config': { registrationMode, githubEnabled: true },
      '/api/destinations/covered': { cities: ['北京', '杭州'] },
      '/api/settings/travel-preferences': { pace: 'moderate', partySize: 2, preferences: [], transportMode: 'transit', extraNotes: '' },
      '/api/usage': { remaining: 3, dailyLimit: 5 },
      '/api/generations/current': null,
      '/api/notifications': { items: [], hasUnread: false, readThrough: 0, nextCursor: null },
      '/api/trips': { items: [], total: 0, destinations: [] },
    };
    return route.fulfill({ json: apiSuccess(fixtures[p] ?? {}) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('tw.activeJobId', 'stale-guest-job'));
  await page.goto(base);
  await page.getByRole('button', { name: '开始规划', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  const tripsLink = page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '我的行程', exact: true });
  assert.ok(await tripsLink.isVisible(), '访客也能从顶部进入我的行程');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await tripsLink.click();
  await page.getByRole('dialog', { name: '登录 RollingGo' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/', '登录前保留首页');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.ok(await tripsLink.evaluate(el => el === document.activeElement), '关闭登录后焦点返回顶部入口');
  const plan = page.getByRole('button', { name: '开始规划', exact: true });
  assert.equal(await plan.isDisabled(), true, '访客未选目的地和节奏时不可规划');
  assert.equal(await plan.getAttribute('title'), '先选目的地与节奏');
  await plan.evaluate(el => el.click());
  assert.equal(await page.getByRole('dialog').count(), 0, '未填必填项不能触发登录');
  await page.getByRole('button', { name: /^目的地/ }).click();
  await page.getByRole('button', { name: '杭州', exact: true }).click();
  assert.equal(await plan.isDisabled(), true, '只填目的地仍不可规划');
  await page.getByRole('button', { name: /节奏与同行/ }).click();
  await page.getByRole('button', { name: /经典地标全景体验/ }).click();
  await page.keyboard.press('Escape');
  assert.equal(await plan.isEnabled(), true, '必填项完整后才允许弹出登录');
  await plan.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.screenshot({ path: `${output}/login-desktop.png` });
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.test');
  await page.getByLabel('密码', { exact: true }).fill('wrong');
  await dialog.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '邮箱或密码错误' }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '开始规划', exact: true }).evaluate(el => el === document.activeElement), true);
  assert.deepEqual(guestPrivateRequests, []);

  await page.getByRole('button', { name: '开始规划', exact: true }).click();
  await dialog.waitFor();
  const homeUrl = page.url();
  await dialog.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByRole('dialog', { name: '注册 RollingGo', exact: true }).waitFor();
  assert.equal(page.url(), homeUrl, '切换注册不改变首页 URL');
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.test');
  await page.getByLabel('密码（至少 8 位）', { exact: true }).fill('fixture-password');
  await page.getByLabel('确认密码', { exact: true }).fill('different-password');
  // 验证码字段带 required：留空时原生校验会拦住 submit，应用层的密码一致性提示不会出现
  await page.getByLabel('邮箱验证码').fill('123456');
  await dialog.getByRole('button', { name: '注册并登录', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '两次输入的密码不一致' }).waitFor();
  assert.equal(registrationBody, undefined);

  // 10-21：发码前先做应用层格式校验（浏览器 type=email 会放行 a@b）
  await page.getByLabel('邮箱', { exact: true }).fill('bad-email');
  await dialog.getByRole('button', { name: '获取验证码', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '邮箱格式不正确' }).waitFor();
  assert.equal(emailCodeRequests.length, 0, '格式非法不该发起发码请求');

  // 10-21：已注册邮箱不再静默成功，而是明确提示 + 可一键切登录
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.test');
  emailTaken = true;
  await dialog.getByRole('button', { name: '获取验证码', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '该邮箱已注册，请直接登录' }).waitFor();
  await dialog.getByRole('button', { name: '去登录', exact: true }).click();
  await page.getByRole('dialog', { name: '登录 RollingGo', exact: true }).waitFor();
  // 回到注册态，后续断言仍走「密码不一致 → 直接登录」原路径
  await dialog.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByRole('dialog', { name: '注册 RollingGo', exact: true }).waitFor();
  emailTaken = false;
  await dialog.getByRole('button', { name: '直接登录', exact: true }).click();
  await page.getByRole('dialog', { name: '登录 RollingGo', exact: true }).waitFor();
  assert.equal(page.url(), homeUrl);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: /^目的地.*杭州/ }).waitFor();
  await page.getByRole('button', { name: '开始规划', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.test');
  await page.getByLabel('密码', { exact: true }).fill('fixture-password');
  await dialog.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/trips/new?**');
  assert.equal(new URL(page.url()).searchParams.get('city'), '杭州');
  await page.getByRole('link', { name: '我的行程', exact: true }).waitFor();
  await page.getByText('测试暂停生成', { exact: true }).waitFor();
  assert.ok(generationBody, '登录成功后自动继续已填写的规划');
  await page.goto(`${base}/trips`);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '登录', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  await page.goto(`${base}/trips?filter=all#top`);
  await dialog.waitFor();
  await dialog.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill('fixture@example.test');
  await page.getByLabel('密码（至少 8 位）', { exact: true }).fill('fixture-password');
  await page.getByLabel('确认密码', { exact: true }).fill('fixture-password');
  // 验证码字段带 required：留空时原生校验会拦住 submit，注册请求根本发不出去
  await page.getByLabel('邮箱验证码').fill('123456');
  await dialog.getByRole('button', { name: '注册并登录', exact: true }).click();
  await page.waitForURL(`${base}/trips?filter=all#top`);
  assert.equal(registrationBody.email, 'fixture@example.test');
  await page.locator('.trip-collection').waitFor();
  await page.getByRole('link', { name: '首页', exact: true }).click();
  await page.locator('.home-page-root').waitFor();
  expireTrips = true;
  await page.getByRole('link', { name: '我的行程', exact: true }).click();
  await dialog.waitFor();
  assert.equal(await page.getByRole('button', { name: '退出登录', includeHidden: true }).count(), 0, '会话过期后移除账号操作');
  assert.equal(await page.getByRole('link', { name: '我的行程', exact: true, includeHidden: true }).count(), 1, '会话过期后仍保留顶部行程入口');
  expireTrips = false;
  authenticated = false;
  await page.goto(`${base}/login?error=github_denied`);
  await page.getByText('GitHub 授权已取消', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().width <= innerWidth));
  await page.screenshot({ path: `${output}/login-mobile.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  registrationMode = 'invite';
  await page.goto(`${base}/register`);
  await page.getByRole('dialog', { name: '注册 RollingGo', exact: true }).waitFor();
  await page.getByLabel('邀请码', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().width <= innerWidth && el.getBoundingClientRect().height <= innerHeight));
  await page.screenshot({ path: `${output}/register-mobile.png` });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `${output}/register-desktop.png` });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  registrationMode = 'closed';
  await page.goto(`${base}/register`);
  await page.getByText('注册暂未开放，请联系站长', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '注册并登录', exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '直接登录', exact: true }).click();
  await page.getByRole('dialog', { name: '登录 RollingGo', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  serviceError = true;
  await page.goto(`${base}/trips`);
  await page.getByText('服务暂不可用，请稍后刷新重试', { exact: true }).waitFor();
  assert.equal(await dialog.count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: guest home, no private requests, dialog error/close/focus, draft retention, login continuation, logout, deep link, OAuth, mobile, 503');
} finally { await browser.close(); }

