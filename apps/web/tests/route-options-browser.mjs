import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const port = 18796;
const base = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['../../node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: 'apps/web', windowsHide: true, stdio: 'ignore' });
let browser;
let page;
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(base).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let trip = { id: 'route-test', title: '北京路线验证', destination: '北京', startDate: '2026-10-01', partySize: 1, preferences: [], budgetLevel: '舒适', totalBudget: 0, extraNotes: '', createdAt: 0, updatedAt: 0, meta: { usedXhs: false, reviewNotes: [] }, days: [{ id: 'd1', dayIndex: 1, title: '第一天', activities: ['故宫', '景山', '北海'].map((name, i) => ({ id: `a${i}`, name, lat: 39.91 + i * .01, lng: 116.39, coordSource: 'manual', coordSystem: 'gcj02', category: '文化', description: '', startTime: '', endTime: '', sourceNotes: [] })), legs: [] }] };
  trip.days.push({ id: 'd2', dayIndex: 2, title: '第二天', activities: [], legs: [] });
  let calls = 0; let fail = false; let hold; let release; let walkDistance = 1000;
  const requested = [];
  const until = async (condition) => {
    for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(condition(), 'condition timed out');
  };
  const saved = [];
  await page.route(`${base}/api/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    let data = {};
    if (pathname === '/api/auth/me') data = { id: 'test', email: 'test@example.test' };
    else if (pathname === '/api/usage') data = { remaining: 5, dailyLimit: 5, usedToday: 0 };
    else if (pathname.endsWith('/conversation')) data = { conversationId: null };
    else if (pathname.endsWith('/versions')) data = { versions: [{ id: trip.id, version: 1 }] };
    else if (pathname.endsWith('/weather')) data = { destination: trip.destination, checkedAt: Date.now(), status: 'not_needed' };
    else if (pathname === '/api/settings/config') data = { amapJsKey: '', amapJsSecurityCode: '' };
    else if (pathname.endsWith('/route-options')) {
      calls++;
      const input = route.request().postDataJSON();
      requested.push(input.mode);
      if (hold) await hold;
      if (fail) return route.fulfill({ status: 503, json: apiFailure(503, '路线服务暂不可用，请重试') });
      const mode = input.mode;
      const i = ['walk', 'cycle', 'transit', 'drive'].indexOf(mode);
      data = { options: [mode === 'cycle' ? { status: 'unavailable', mode, reason: '暂无可用路线' } : { status: 'available', leg: { fromActivityId: input.from.id, toActivityId: input.to.id, mode, source: 'amap', durationMin: 20 - i * 4, distanceM: mode === 'walk' ? walkDistance : 1000 + i * 100, polyline: `116.39,39.91;116.4,${39.93 + i * .01}` } }] };
    } else if (pathname === '/api/trips/route-test') {
      if (route.request().method() === 'PUT') {
        const next = route.request().postDataJSON();
        if (saved.length === 0) await new Promise((r) => setTimeout(r, 1200));
        trip = next; saved.push(structuredClone(trip));
      }
      data = trip;
    }
    return route.fulfill({ json: apiSuccess(data) });
  });
  hold = new Promise((r) => { release = r; });
  await page.goto(`${base}/trips/route-test`);
  const selectFirstDay = () => page.getByRole('group', { name: '行程天数' }).getByRole('button', { name: '第1天', exact: true }).click();
  await selectFirstDay();
  await until(() => calls === 1);
  assert.equal(await page.locator('details[open]').count(), 0, 'prefetch starts without opening menu');
  const summary = page.getByLabel('切换交通方式').first();
  await summary.click();
  assert.equal(await page.getByRole('button', { name: /^(重试|重新查询|查询中…)$/ }).count(), 0, 'normal prefetch has no retry button');
  await page.getByRole('button', { name: /^驾车/ }).click();
  await page.getByRole('button', { name: /^公交/ }).click();
  release(); hold = null;
  await page.waitForFunction(() => document.body.textContent.includes('公交/地铁约12 分钟'));
  assert.deepEqual(requested.slice(0, 2), ['walk', 'transit'], 'last user selection promoted ahead of background work');
  await until(() => calls === 8);
  // Let the first autosave start, then select again; serialized saves must preserve the latest route.
  await page.waitForTimeout(900);
  await summary.click();
  assert.equal(await page.getByRole('button', { name: /骑行/ }).isDisabled(), true);
  await page.getByRole('button', { name: /^步行/ }).click();
  await page.waitForTimeout(2200);
  assert.equal(trip.days[0].legs[0].mode, 'walk');
  assert.equal(calls, 8, 'reopening prefetched options should not refetch');
  assert.equal(saved.length, 2);
  assert.ok(await page.locator('.leaflet-overlay-pane path').count() >= 2, 'selected polyline rendered');
  const days = page.getByRole('group', { name: '行程天数' });
  await days.getByRole('button', { name: '第2天', exact: true }).click();
  await days.getByRole('button', { name: '第1天', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(calls, 8, 'returning to the day reuses shared cache');
  await page.getByLabel('切换交通方式').first().click();
  assert.equal(await page.getByRole('button', { name: /^(重试|重新查询)$/ }).count(), 0, 'successful and unavailable results have no retry button');
  fail = true;
  await page.reload();
  await selectFirstDay();
  await page.getByLabel('切换交通方式').first().click();
  await page.getByRole('alert').filter({ hasText: '暂不可用' }).waitFor();
  hold = new Promise((r) => { release = r; });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  const refreshing = page.getByRole('button', { name: '查询中…', exact: true });
  assert.equal(await refreshing.isDisabled(), true);
  assert.equal(await refreshing.getAttribute('aria-busy'), 'true');
  assert.equal(await refreshing.locator('svg.animate-spin').count(), 1);
  fail = false;
  release(); hold = null;
  await page.getByRole('button', { name: /^驾车.*8 分钟/ }).waitFor();
  await refreshing.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0, 'successful retry hides button');
  // A response arriving after reorder must not become selectable on the changed pair.
  fail = true;
  await page.reload();
  await selectFirstDay();
  await page.getByLabel('切换交通方式').first().click();
  await page.getByRole('alert').filter({ hasText: '暂不可用' }).waitFor();
  hold = new Promise((r) => { release = r; });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  fail = false;
  await page.getByLabel('故宫更多操作').click();
  await page.getByRole('button', { name: '下移', exact: true }).first().click();
  release(); hold = null;
  await page.waitForTimeout(100);
  assert.equal(await page.getByRole('button', { name: /^驾车/ }).count(), 0);
  await page.waitForFunction(() => [...document.querySelectorAll('summary[aria-label="切换交通方式"]')].every((el) => el.textContent.includes('步行约20 分钟')));
  await page.waitForTimeout(1000);
  assert.deepEqual(trip.days[0].legs.map((leg) => [leg.fromActivityId, leg.toActivityId, leg.mode]).sort(), [['a0', 'a2', 'walk'], ['a1', 'a0', 'walk']]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('切换交通方式').first().click();
  await page.getByRole('button', { name: /^驾车.*8 分钟/ }).waitFor();
  await page.getByRole('button', { name: /^驾车/ }).click();
  await page.getByLabel('切换交通方式').first().click();
  const selected = page.getByRole('button', { name: /^驾车/ });
  assert.equal(await selected.getAttribute('aria-pressed'), 'true');
  assert.ok(await selected.evaluate((el) => getComputedStyle(el).backgroundImage.includes('linear-gradient')), 'editor blue gradient selected state');
  await page.waitForFunction(() => [...document.querySelectorAll('details[open] button[aria-pressed="true"]')].some((button) => getComputedStyle(button).color === 'rgb(255, 255, 255)'));
  assert.equal(await selected.evaluate((el) => getComputedStyle(el).color), 'rgb(255, 255, 255)', 'selected text keeps contrast over editor parent styles');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await fs.mkdir('verify-shots/route-options', { recursive: true });
  await page.screenshot({ path: 'verify-shots/route-options/mobile-options.png' });
  assert.deepEqual(errors, []);
  await selected.press('Escape');
  assert.equal(await page.locator('details[open]').count(), 0);
  await page.waitForTimeout(1000);
  await page.reload();
  await selectFirstDay();
  await page.getByText('驾车约8 分钟', { exact: false }).waitFor();
  fail = true;
  await page.getByLabel('故宫更多操作').click();
  await page.getByRole('article', { name: '故宫', exact: true }).getByLabel('移至其他天').selectOption('d2');
  await page.getByRole('button', { name: '重试推荐' }).waitFor();
  fail = false;
  walkDistance = 1600;
  await page.getByRole('button', { name: '重试推荐' }).click();
  await page.getByLabel('切换交通方式').filter({ hasText: '驾车约8 分钟' }).waitFor();
  // The destination is hidden but must still be planned and saved.
  await page.getByLabel('北海更多操作').click();
  await page.getByRole('article', { name: '北海', exact: true }).getByLabel('移至其他天').selectOption('d2');
  await until(() => trip.days[1].legs.some((leg) => leg.fromActivityId === 'a0' && leg.toActivityId === 'a2' && leg.mode === 'drive'));
  await days.getByRole('button', { name: '第2天', exact: true }).click();
  await page.getByLabel('切换交通方式').filter({ hasText: '驾车约8 分钟' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS routes: prefetch, request priority, latest selection, cache across days, save ordering/reload, map, retry, stale response, mobile style and Escape');
} catch (error) {
  console.error(await page?.locator('body').innerText());
  throw error;
} finally {
  await browser?.close();
  vite.kill();
}
