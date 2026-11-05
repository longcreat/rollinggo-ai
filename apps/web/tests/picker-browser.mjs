import { apiSuccess } from '../../../scripts/lib/api-contract.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const out = '.trellis/tasks/archive/2026-10/09-29-ui-consistency/research/pickers';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.clock.setFixedTime(new Date('2027-05-01T12:00:00+08:00'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://127.0.0.1:5173/api/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const data = {
      '/api/auth/me': { id: 'picker', email: 'picker@example.test' },
      '/api/usage': { remaining: 3, dailyLimit: 5 },
      '/api/destinations/covered': { cities: ['北京', '杭州', '成都'] },
      '/api/trips': { items: [], total: 0, destinations: [] },
    };
    return route.fulfill({ json: apiSuccess(data[pathname] ?? {}) });
  });
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('button', { name: /出行日期/ }).click();
    await page.locator('.range-calendar').waitFor();
    assert.equal(await page.locator('.range-calendar-month').count(), width < 640 ? 1 : 2);
    await page.getByRole('button', { name: '2027-05-31', exact: true }).waitFor();
    const day = page.locator('.range-calendar-day.is-start').last();
    const dayStyle = await day.evaluate(el => { const s = getComputedStyle(el); return { radius: s.borderRadius, height: el.clientHeight, width: el.clientWidth }; });
    assert.ok(parseFloat(dayStyle.radius) >= 16 || dayStyle.radius.includes('%') || dayStyle.radius.includes('infinity'), JSON.stringify(dayStyle));
    await page.screenshot({ path: `${out}/${name}-date.png`, fullPage: true });
    await page.getByRole('button', { name: '关闭选择出行日期', exact: true }).click();
    await page.getByRole('button', { name: /偏好与出行/ }).click();
    const preference = page.getByRole('button', { name: '美食', exact: true });
    await preference.click();
    assert.equal(await preference.getAttribute('aria-pressed'), 'true');
    const style = await preference.evaluate(el => { const s = getComputedStyle(el); return { background: s.backgroundColor, color: s.color, border: s.borderTopWidth, radius: s.borderRadius }; });
    assert.equal(style.background, 'rgb(47, 107, 243)', JSON.stringify(style));
    assert.equal(style.color, 'rgb(255, 255, 255)');
    assert.equal(style.border, '1px');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'open preferences must not overflow');
    await page.screenshot({ path: `${out}/${name}-preferences.png`, fullPage: true });
    await page.goto('http://127.0.0.1:5173/trips');
    const select = page.getByRole('combobox', { name: '排序', exact: true });
    await select.waitFor();
    assert.ok(await select.evaluate(el => parseFloat(getComputedStyle(el).paddingRight) >= 36));
    await select.click();
    await page.screenshot({ path: `${out}/${name}-select.png`, fullPage: true });
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  console.log('PASS picker visuals: dates, selected preferences, dropdowns, desktop and mobile');
} finally { await browser.close(); }
