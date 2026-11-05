import { apiSuccess } from '../../../scripts/lib/api-contract.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('.trellis/tasks/archive/2026-10/09-29-ui-consistency/research/shared-verification');
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let authenticated = false;
  await page.route(/^http:\/\/127\.0\.0\.1:5173\/api\//, route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me' && !authenticated) return route.fulfill({ json: apiSuccess(null) });
    if (pathname === '/api/auth/login') { authenticated = true; return route.fulfill({ json: apiSuccess({ id: 'fixture', email: 'fixture@example.test' }) }); }
    const fixtures = {
      '/api/auth/config': { registrationMode: 'open', githubEnabled: false },
      '/api/auth/me': { id: 'fixture', email: 'fixture@example.test' },
      '/api/usage': { remaining: 2, dailyLimit: 4 },
      '/api/settings/travel-preferences': { preferences: [], transportMode: 'transit', pace: null, partySize: 2, extraNotes: '' },
      '/api/destinations/covered': { cities: ['北京', '杭州', '成都'] },
      '/api/trips': { items: [], total: 0, destinations: [] },
      '/api/settings': { byokEnabled: false, baseUrl: '', model: '', apiKeyLast4: '', hasSiteKey: true, hasPersonalAmapKey: false, amapApiKeyLast4: '', hasSiteAmapKey: true, hasPersonalSearchKey: false, searchApiKeyLast4: '', searchApiBaseUrl: '', hasSiteSearchKey: true },
    };
    return route.fulfill({ json: apiSuccess(fixtures[pathname] ?? {}) });
  });
  await page.goto('http://127.0.0.1:5173/login');
  // 登录已改为弹窗：页头也有同名「登录」按钮，弹窗内操作必须限定 scope，否则 exact 命中 2 个
  const authDialog = page.locator('dialog[open]').first();
  await authDialog.waitFor();
  await authDialog.getByLabel('邮箱').fill('fixture@example.test');
  await authDialog.getByLabel('密码', { exact: true }).fill('fixture-password');
  const login = authDialog.getByRole('button', { name: '登录', exact: true });
  const loginStyle = await login.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, height: el.getBoundingClientRect().height }));
  assert.equal(loginStyle.color, 'rgb(255, 255, 255)');
  assert.notEqual(loginStyle.background, 'rgba(0, 0, 0, 0)');
  assert.ok(loginStyle.height >= 35);
  await page.screenshot({ path: path.join(out, 'login.png') });
  // 弹窗里切换注册是 button（只有 RegisterPage 独立页才是 link）
  await authDialog.getByRole('button', { name: '注册', exact: true }).click();
  // 切换后会重建弹窗，用带标题的可访问名重新定位
  const regDialog = page.getByRole('dialog', { name: '注册 RollingGo', exact: true });
  await regDialog.waitFor();
  await regDialog.getByLabel('邮箱', { exact: true }).fill('fixture@example.test');
  await regDialog.getByLabel('密码（至少 8 位）', { exact: true }).fill('fixture-password');
  await regDialog.getByLabel('确认密码').fill('different-password');
  // 验证码字段带 required：留空时浏览器原生校验会拦住 submit，应用层提示永远不会出现
  await regDialog.getByLabel('邮箱验证码').fill('123456');
  await regDialog.getByRole('button', { name: '注册并登录', exact: true }).click();
  await regDialog.getByText('两次输入的密码不一致').waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(out, 'register-mobile.png') });
  await page.goto('http://127.0.0.1:5173/login');
  const loginDialog = page.locator('dialog[open]').first();
  await loginDialog.waitFor();
  await loginDialog.getByLabel('邮箱').fill('fixture@example.test');
  await loginDialog.getByLabel('密码', { exact: true }).fill('fixture-password');
  await loginDialog.getByRole('button', { name: '登录', exact: true }).click();
  // 弹窗登录成功后回原页（无 from 时是首页），再走顶部导航进行程列表
  await page.locator('.home-page-root').waitFor();
  await page.getByRole('link', { name: '我的行程', exact: true }).click();
  await page.locator('.trip-collection').waitFor();
  // 原「设置」弹窗段落已删：SettingsDialog 当前无任何入口（全仓仅剩定义），
  // Modal 的 aria-labelledby / 宽度 / ESC 关闭 / 焦点恢复由 login-dialog-browser.mjs 覆盖
  await page.setViewportSize({ width: 375, height: 812 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(out, 'trips-mobile.png') });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('http://127.0.0.1:5173/');
  await page.locator('.home-page-root').waitFor();
  await page.getByRole('button', { name: /出行日期/ }).click();
  await page.locator('.range-calendar').waitFor();
  const days = page.locator('.range-calendar-day:not(:disabled)');
  assert.ok(await days.count() > 10);
  await days.nth(3).click();
  await days.nth(5).click();
  assert.ok(await page.locator('.range-calendar-day.is-start').count() > 0);
  assert.ok(await page.locator('.range-calendar-day.is-end').count() > 0);
  await page.screenshot({ path: path.join(out, 'home-calendar.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5173/');
  await page.locator('.home-page-root').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(out, 'home-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ status: 'passed', checks: ['login styling and navigation', 'register validation', 'mobile auth layout', 'settings dialog and Escape', 'calendar range selection', 'mobile home overflow'], errors }, null, 2));
  console.log('Shared UI checks passed:', out);
} finally {
  await browser.close();
}
