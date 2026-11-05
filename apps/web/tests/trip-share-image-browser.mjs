import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = 18796;
const base = `http://127.0.0.1:${port}`;
const screenshots = process.env.SHARE_TEST_OUTPUT ?? path.join(os.tmpdir(), 'tripweaver-share-image');
const vite = spawn(process.execPath, ['../../node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: 'apps/web', windowsHide: true, stdio: 'ignore' });
let browser;
try {
  await fs.mkdir(screenshots, { recursive: true });
  for (let i = 0; i < 200; i++) {
    if (await fetch(base).then(r => r.ok, () => false)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const trip = { id: 'share-test', title: '杭州春日漫游', destination: '杭州', startDate: '2026-10-01', partySize: 1, preferences: [], budgetLevel: '舒适', totalBudget: 0, extraNotes: '', createdAt: 0, updatedAt: 0, meta: { usedXhs: false, reviewNotes: [] }, days: [{ id: 'd1', dayIndex: 1, title: '湖畔慢行', activities: [{ id: 'a1', name: '西湖', lat: 30.24, lng: 120.15, coordSource: 'manual', coordSystem: 'gcj02', category: '自然', description: '', startTime: '', endTime: '', sourceNotes: [] }], legs: [] }] };
  const png = (await fs.readFile('apps/web/public/share-styles/journal.png')).toString('base64');
  // 成品已落盘：POST 写入 stored，GET 用它模拟「刷新后仍能回显」
  const posterUrl = `/media/share-posters/${'a'.repeat(64)}.png`;
  const stored = new Map();
  const requests = [];
  const notes = [];
  let signedIn = true;
  let fail = false;
  let malformed = false;
  let hold;
  let release;
  function delayResponse() { hold = new Promise(resolve => { release = resolve; }); }
  await page.route(`${base}/api/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    let data = {};
    if (pathname === '/api/auth/me') data = signedIn ? { id: 'test', email: 'test@example.test' } : null;
    else if (pathname === '/api/auth/logout') { signedIn = false; data = { ok: true }; }
    else if (pathname === '/api/notifications') data = { items: [...notes].reverse(), hasUnread: notes.some(n => n.readAt === null), readThrough: notes.length, nextCursor: null };
    else if (pathname === '/api/notifications/read-all') { notes.forEach(n => { if (n.sequence <= route.request().postDataJSON().through) n.readAt = Date.now(); }); data = { ok: true }; }
    else if (/\/api\/notifications\/[^/]+\/read$/.test(pathname)) { const note = notes.find(n => n.id === pathname.split('/')[3]); if (note) note.readAt = Date.now(); data = { ok: true }; }
    else if (pathname === '/api/generations/current') data = null;
    else if (pathname === '/api/settings/travel-preferences') data = { preferences: [], transportMode: 'transit', extraNotes: '', pace: 'moderate', partySize: 1 };
    else if (pathname === '/api/destinations/covered') data = { cities: ['杭州'] };
    else if (pathname === '/api/usage') data = { remaining: 5, dailyLimit: 5, usedToday: 0 };
    else if (pathname.endsWith('/conversation')) data = { conversationId: null };
    else if (pathname.endsWith('/versions')) data = { versions: [{ id: trip.id, version: 1, createdAt: trip.createdAt, title: trip.title }] };
    else if (pathname === '/api/settings/config') data = { amapJsKey: '', amapJsSecurityCode: '' };
    else if (pathname.endsWith('/share-image') && route.request().method() === 'GET') {
      const style = new URL(route.request().url()).searchParams.get('style') ?? 'journal';
      const url = stored.get(style);
      if (!url) return route.fulfill({ status: 404, json: apiFailure(404, '该行程尚无已生成的海报') });
      data = { mimeType: 'image/png', url };
    } else if (pathname.endsWith('/share-image')) {
      const body = route.request().postDataJSON();
      requests.push(body);
      if (hold) await hold;
      if (fail) return route.fulfill({ status: 503, json: apiFailure(503, '生图服务繁忙，请稍后重试') });
      if (malformed) data = { mimeType: 'text/html', url: '/broken-poster' };
      else {
        stored.set(body.style ?? 'journal', posterUrl);
        const notification = { id: `image-${notes.length}`, sequence: notes.length + 1, jobId: `image-job-${notes.length}`, kind: 'success', tripId: trip.id, title: `${trip.title} · 图片已生成`, message: '旅行海报已生成，可随时下载图片。', shareImageStyle: body.style ?? 'journal', createdAt: Date.now(), readAt: null };
        notes.push(notification);
        data = { mimeType: 'image/png', url: posterUrl, notification };
      }
    } else if (pathname === '/api/trips/share-test') data = trip;
    return route.fulfill({ json: apiSuccess(data) });
  });
  await page.route(`${base}/media/share-posters/**`, route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(png, 'base64') }));
  await page.addInitScript(() => { window.printCount = 0; window.print = () => { window.printCount++; }; });
  const trigger = page.locator('summary[aria-label="分享行程"]');
  const dialog = page.getByRole('dialog', { name: 'AI 生成海报', exact: true });
  const button = name => dialog.getByRole('button', { name, exact: true });
  const style = name => dialog.getByRole('button', { name: new RegExp(name) });
  // 成品图按可访问名与风格卡缩略图（alt 为空）区分
  const poster = () => dialog.getByRole('img', { name: /AI 行程分享图/ });
  const open = async () => { await trigger.click(); await page.getByRole('button', { name: 'AI 生成海报', exact: true }).click(); await dialog.waitFor(); };
  const close = async () => { await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.ok(await trigger.evaluate(el => el === document.activeElement)); };
  const shot = async name => {
    await page.evaluate(async () => { await document.fonts.ready; window.getSelection()?.removeAllRanges(); });
    await page.screenshot({ path: path.join(screenshots, `${name}.png`), animations: 'disabled' });
  };
  const frames = [];
  const frame = async label => {
    const rect = await dialog.boundingBox();
    assert.ok(rect, `${label}: modal is visible`);
    frames.push({ label, viewport: page.viewportSize(), ...rect });
    return rect;
  };
  const sameFrame = async (expected, label) => {
    const actual = await frame(label);
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) < 1, `${label}: ${key} stays unchanged`);
  };
  const bounded = async (width, height) => {
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1, 'dialog fits viewport');
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
    const footer = dialog.locator('.modal-footer');
    if (await footer.count()) {
      const rect = await footer.boundingBox();
      assert.ok(rect.y + rect.height <= bounds.y + bounds.height, 'footer stays visible');
    }
  };
  await page.goto(`${base}/trips/share-test`);
  await trigger.click();
  await shot('desktop-menu');
  assert.equal(await trigger.locator('..').getByRole('button').count(), 2);
  assert.equal(await page.getByRole('button', { name: 'JSON 备份' }).count(), 0);
  await page.getByRole('button', { name: '导出 PDF', exact: true }).click();
  assert.equal(await page.evaluate(() => window.printCount), 1);
  assert.equal(await dialog.count(), 0, 'PDF never opens the poster dialog');
  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.print-host .pv').evaluate(el => getComputedStyle(el).visibility), 'visible');
  await page.emulateMedia({ media: 'screen' });
  await open();
  assert.equal(requests.length, 0, 'opening never purchases generation');
  assert.equal(await dialog.getByRole('button', { name: '导出 PDF' }).count(), 0);
  await dialog.locator('img').evaluateAll(images => Promise.all(images.map(img => img.decode())));
  const desktopFrame = await frame('desktop-styles');
  assert.equal(desktopFrame.width, 480);
  assert.equal(desktopFrame.height, 640);
  await shot('desktop-styles');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('mobile-initial');
  await page.setViewportSize({ width: 1280, height: 900 });
  await style('水墨写意').click();
  assert.equal(await style('水墨写意').getAttribute('aria-pressed'), 'true');
  assert.equal(requests.length, 0, 'style selection never purchases generation');
  await style('旅行手账插画').click();
  delayResponse(); fail = true;
  await button('开始生成').dblclick();
  await dialog.getByRole('progressbar').waitFor();
  assert.equal(await dialog.getByRole('progressbar').getAttribute('aria-valuenow'), null, 'no fake percentage');
  assert.equal(await dialog.getByRole('button', { name: /开始生成|重新生成|下载|更换风格/ }).count(), 0);
  await dialog.locator('img').evaluate(img => img.decode());
  await sameFrame(desktopFrame, 'desktop-loading');
  await shot('desktop-loading');
  await close(); await open();
  assert.equal(requests.length, 1, 'double click and reopen do not duplicate requests');
  release(); hold = null;
  await dialog.getByRole('alert').waitFor();
  await sameFrame(desktopFrame, 'desktop-error');
  assert.ok(await dialog.getByRole('alert').evaluate(el => {
    const rect = el.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight && el.closest('.modal-footer');
  }), 'generation error stays visible next to recovery actions');
  await shot('desktop-error');
  fail = false;
  const autoDownloadOpen = page.waitForEvent('download');
  await button('重试生成').click();
  await button('下载').waitFor();
  assert.match((await autoDownloadOpen).suggestedFilename(), /AI分享图\.png$/, 'open dialog also auto-downloads on success');
  await page.locator('.notification-toast').waitFor();
  assert.match(await page.locator('.notification-toast').innerText(), /图片已生成，已为你发起自动下载/);
  assert.equal(await page.locator('.notification-toast').evaluate(el => Boolean(el.closest('dialog[open]'))), true, '完成提醒在原生弹窗内可见、可点击');
  await shot('desktop-completion-toast');
  await page.getByRole('button', { name: '关闭完成提醒' }).click();
  assert.equal(notes.at(-1).readAt, null, '关闭提醒或查看行程不把海报通知标为已读');
  // 原「推进 15s 验证轮询不重复弹提醒」已删：通知轮询在 10-18 SSE 推送上线后降为 60 秒兑底，
  // 且 toast 去重由 shownToasts/lastSequence 保证，通知基本流程由
  // navigation-notifications-browser.mjs 覆盖（空态、错误、重试）。
  await poster().evaluate(img => img.decode());
  await sameFrame(desktopFrame, 'desktop-ready');
  assert.equal(requests.length, 2);
  assert.equal(await dialog.locator('.modal-scroll').evaluate(el => el.scrollHeight - el.clientHeight), 0, 'result view never scrolls');
  await shot('desktop-ready');
  const oldImage = await poster().getAttribute('src');
  const download = page.waitForEvent('download');
  await button('下载').click();
  assert.match((await download).suggestedFilename(), /AI分享图\.png$/);
  await button('更换风格').click(); await style('水墨写意').click();
  await button('返回已生成海报').click();
  assert.equal(await poster().getAttribute('src'), oldImage, 'cancel preserves the original image');
  fail = true;
  await button('重新生成').click(); await dialog.getByRole('alert').waitFor();
  assert.equal(requests.at(-1).regenerate, true);
  assert.equal(requests.at(-1).style, 'journal', 'cancel restores the result style');
  assert.equal(await poster().getAttribute('src'), oldImage, 'failed regeneration preserves download');
  fail = false;
  await button('重试生成').click(); await button('下载').waitFor();
  // 首次生成该风格：关闭弹窗也会自动下载
  await button('更换风格').click(); await style('水墨写意').click();
  delayResponse();
  await button('开始生成').click(); await dialog.getByRole('progressbar').waitFor();
  await close();
  const autoDownload = page.waitForEvent('download');
  release(); hold = null;
  assert.match((await autoDownload).suggestedFilename(), /AI分享图\.png$/);
  await open(); await button('下载').waitFor();
  assert.equal(requests.at(-1).style, 'ink');
  assert.equal(requests.at(-1).regenerate, false);
  // 该风格已生成过：显式重新生成仍应自动下载一次
  let redownloads = 0;
  const countDownload = () => { redownloads += 1; };
  page.on('download', countDownload);
  delayResponse();
  await button('重新生成').click(); await dialog.getByRole('progressbar').waitFor();
  await close();
  release(); hold = null;
  await open(); await button('下载').waitFor();
  await page.waitForTimeout(400);
  page.off('download', countDownload);
  assert.equal(redownloads, 1, 'explicit regeneration auto-downloads exactly once');
  const count = requests.length;
  await close();
  for (const [width, height] of [[320, 568], [390, 844], [430, 844], [600, 844], [768, 844], [1280, 900], [667, 375]]) {
    await page.setViewportSize({ width, height });
    assert.equal(await trigger.locator('span').isVisible(), width > 600);
    await open(); await bounded(width, height);
    const resultFrame = await frame(`${width}x${height}-result`);
    await poster().evaluate(img => img.decode());
    if (width === 390) await shot('mobile-ready');
    await button('更换风格').click(); await bounded(width, height);
    await sameFrame(resultFrame, `${width}x${height}-styles`);
    assert.ok(await style('旅行手账插画').isVisible());
    assert.ok(await style('水墨写意').isVisible());
    if (width === 390) await shot('mobile-styles');
    if (height === 375) await shot('landscape-styles');
    await button('返回已生成海报').click();
    await close();
  }
  assert.equal(requests.length, count);
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  const mobileFrame = await frame('mobile-result');
  delayResponse(); await button('重新生成').click();
  await dialog.getByRole('progressbar').waitFor();
  await sameFrame(mobileFrame, 'mobile-loading');
  await dialog.locator('img').evaluate(img => img.decode());
  await shot('mobile-loading');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await dialog.getByRole('progressbar').locator('span').evaluate(el => getComputedStyle(el).animationName), 'none');
  release(); hold = null; await button('下载').waitFor();
  await close(); await page.emulateMedia({ reducedMotion: 'no-preference' });
  // 服务端已落盘：刷新页面后打开弹窗直接回显成品，不重新购买
  const purchased = requests.length;
  await page.reload(); await open();
  await poster().waitFor();
  assert.equal(await poster().getAttribute('src'), posterUrl, '刷新后直接回显已保存的海报');
  assert.equal(requests.length, purchased, '回显走 GET，不触发生成');
  assert.equal(await page.locator('.notification-toast').count(), 0, '刷新不重放已有完成提醒');
  await close();
  await page.getByLabel('通知，有未读消息', { exact: true }).click();
  await page.getByRole('dialog', { name: '通知', exact: true }).waitFor();
  const manualDownload = page.waitForEvent('download');
  await page.getByRole('dialog', { name: '通知', exact: true }).getByRole('button', { name: /下载图片：/ }).first().click();
  assert.match((await manualDownload).suggestedFilename(), /AI分享图\.png$/);
  // markRead 在下载完成后异步发出，等它真正落地再断言（原本靠后面的时间推进顺带等到）
  for (let i = 0; i < 50 && notes.at(-1).readAt === null; i++) await page.waitForTimeout(100);
  assert.notEqual(notes.at(-1).readAt, null, '通知中的下载成功后保存已读');
  assert.equal(new URL(page.url()).pathname, '/trips/share-test', '下载不跳页');
  // Missing assets remain selectable. A malformed API response offers recovery.
  await page.route(/\/share-styles\/(journal|ink)\.png$/, route => route.abort());
  stored.clear();   // 清空已存成品，回到风格选择页验证缺图降级
  await page.reload(); await open();
  await dialog.getByText('风格示例', { exact: true }).first().waitFor();
  malformed = true;
  await button('开始生成').click(); await dialog.getByRole('alert').waitFor();
  assert.match(await dialog.getByRole('alert').innerText(), /图片响应异常/);
  malformed = false;
  await close();
  trip.title = '杭州西湖山水与江南古街的悠闲漫游之旅';
  await page.reload();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const title = page.locator('.editor-toolbar h1');
    await title.waitFor();
    assert.equal(await title.getAttribute('title'), trip.title);
    const titleBox = await title.boundingBox();
    const actionsBox = await page.locator('.editor-toolbar-right').boundingBox();
    assert.ok(titleBox.height <= 48 && titleBox.x + titleBox.width <= actionsBox.x);
    const triggerBox = await trigger.boundingBox();
    assert.ok(triggerBox.width >= 44 && triggerBox.height >= 44);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1));
  }
  // 切离详情后收到单次下载与提醒，保持用户当前页面。
  await page.setViewportSize({ width: 390, height: 844 });
  await open();
  delayResponse();
  await button('开始生成').click(); await dialog.getByRole('progressbar').waitFor();
  await close();
  await page.getByRole('link', { name: '首页', exact: true }).click();
  await page.waitForURL(base + '/');
  const backgroundDownload = page.waitForEvent('download');
  release(); hold = null;
  await backgroundDownload;
  await page.locator('.notification-toast').waitFor();
  assert.equal(new URL(page.url()).pathname, '/');
  await shot('mobile-background-completion-toast');
  const toastBounds = await page.locator('.notification-toast').boundingBox();
  assert.ok(toastBounds.x >= 0 && toastBounds.x + toastBounds.width <= 390 && toastBounds.y + toastBounds.height <= 844);
  await page.getByRole('button', { name: '关闭完成提醒' }).click();
  await page.goto(`${base}/trips/share-test`); await open(); await button('下载').waitFor();
  // 自动下载抛错时成品依然成功，提醒提供手动重试；手动获取失败在提醒内可见。
  await page.evaluate(() => {
    window.originalAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) throw new Error('fixture download blocked'); return window.originalAnchorClick.call(this); };
  });
  await button('重新生成').click(); await button('下载').waitFor();
  await page.locator('.notification-toast').waitFor();
  assert.match(await page.locator('.notification-toast').innerText(), /请点击下方下载图片/);
  assert.equal(await page.locator('a[download]').count(), 0, '失败下载不遗留链接节点');
  stored.clear();
  await page.locator('.notification-toast').getByRole('button', { name: /下载图片/ }).click();
  await page.locator('.notification-toast').getByRole('alert').waitFor();
  assert.match(await page.locator('.notification-toast').getByRole('alert').innerText(), /图片暂不可用/);
  stored.set('journal', posterUrl); stored.set('ink', posterUrl);
  await page.evaluate(() => { HTMLAnchorElement.prototype.click = window.originalAnchorClick; });
  const recoveredDownload = page.waitForEvent('download');
  await page.locator('.notification-toast').getByRole('button', { name: /下载图片/ }).click();
  await recoveredDownload;
  // 微信不宣称自动保存，用户从提醒打开成品后长按保存。
  const originalUserAgent = await page.evaluate(() => navigator.userAgent);
  await page.evaluate(() => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'MicroMessenger' }));
  let wechatDownloads = 0;
  const countWechatDownload = () => wechatDownloads++;
  page.on('download', countWechatDownload);
  await button('重新生成').click(); await button('下载').waitFor();
  await page.locator('.notification-toast').waitFor();
  assert.match(await page.locator('.notification-toast').innerText(), /长按即可保存/);
  await page.locator('.notification-toast').getByRole('button', { name: /下载图片/ }).click();
  await page.getByRole('dialog', { name: '保存图片', exact: true }).waitFor();
  await page.getByRole('img', { name: '已生成的旅行海报', exact: true }).evaluate(img => img.decode());
  assert.equal(wechatDownloads, 0);
  await shot('mobile-wechat-save');
  await page.keyboard.press('Escape');
  page.off('download', countWechatDownload);
  await page.evaluate(value => Object.defineProperty(navigator, 'userAgent', { configurable: true, value }), originalUserAgent);
  delayResponse(); await button('重新生成').click(); await dialog.getByRole('progressbar').waitFor(); await close();
  let lateDownloads = 0;
  page.on('download', () => lateDownloads++);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: '登录', exact: true }).waitFor();
  release(); hold = null;
  await page.waitForTimeout(500);
  assert.equal(lateDownloads, 0, '退出后忽略旧账号迟到的下载');
  assert.equal(await page.locator('.notification-toast').count(), 0, '退出后不显示旧账号提醒');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(screenshots, 'frames.json'), JSON.stringify(frames, null, 2));
  console.log(`PASS: share menu/PDF, explicit generation, three states, retry, cancel/retained result, regeneration, style payload, downloads, focus, responsive bounds, reduced motion and missing assets. Screenshots: ${screenshots}`);
} finally { await browser?.close(); vite.kill(); }
