import { apiSuccess } from '../../../scripts/lib/api-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const out = path.resolve(process.env.PHOTO_LAYOUT_OUTPUT ?? 'verify-shots/photo-layout');
await fs.mkdir(out, { recursive: true });
const fixtures = [
  ['横版风景', 1600, 900], ['竖版风景', 800, 1200], ['方形风景', 1000, 1000],
  ['宽幅全景', 2400, 600], ['超长竖图', 600, 2400], ['损坏图片', 800, 1200], ['无图景点', 0, 0],
];
const trip = {
  id: 'photo-layout-fixture', title: '横竖构图展示验证', destination: '杭州', startDate: '2026-09-30',
  partySize: 2, preferences: [], budgetLevel: '舒适', totalBudget: 0, extraNotes: '', createdAt: 0, updatedAt: 0,
  meta: { usedXhs: false, reviewNotes: [] },
  days: [{ id: 'day-1', dayIndex: 1, title: '保留完整构图', legs: [], activities: fixtures.map(([name], i) => ({
    id: `a${i}`, name, category: '文化', description: '保留画面四边与主体，同时控制卡片高度。',
    lat: 0, lng: 0, startTime: '', endTime: '', sourceNotes: [],
  })) }],
  overview: fixtures.map(([name], i) => ({
    id: `p${i}`, name, category: 'attraction', intro: '图片布局验证', reservation: 'none', sourceLinks: [],
    ...(i < 6 ? { coverUrl: `/photo-layout-${i}.svg` } : {}),
  })),
};
trip.overview.push({ ...trip.overview[1], id: 'unused-portrait', name: '候选竖版风景' });
const credit = i => i === 1 ? { source: 'unsplash', photographer: '摄影师2', photographerUrl: 'https://unsplash.com/@fixture?utm_source=tripweaver&utm_medium=referral', sourceUrl: 'https://unsplash.com/photos/fixture?utm_source=tripweaver&utm_medium=referral', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license', changes: '模拟署名验证' }
  : i === 2 ? { source: 'pixabay', photographer: '摄影师3', sourceUrl: 'https://pixabay.com/photos/fixture-123/', license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/', changes: '模拟署名验证' }
  : { source: 'commons', photographer: `摄影师${i + 1}`, sourceUrl: `https://commons.wikimedia.org/wiki/File:Photo${i}.jpg`, license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', changes: '测试图片' };
trip.overview[0].coverAttribution = credit(0);
trip.overview[0].photos = [0, 1, 2, 3].map(i => ({ url: `/photo-layout-${i}.svg`, attribution: credit(i) })); // UI 对旧/异常输入也守住三张；API另测拒绝超限。
trip.overview.at(-1).photos = [1, 5, 2].map(i => ({ url: `/photo-layout-${i}.svg`, attribution: credit(i) }));
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = []; const measurements = []; let writes = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/photo-layout-*.svg', route => {
    const index = Number(route.request().url().match(/photo-layout-(\d)/)[1]);
    if (index === 5) return route.fulfill({ status: 404, body: '' });
    const [name, width, height] = fixtures[index];
    return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#d8e8d2"/><rect x="8" y="8" width="${width - 16}" height="${height - 16}" fill="none" stroke="#2d6252" stroke-width="16"/><circle cx="${width/2}" cy="${height/2}" r="${Math.min(width,height)/4}" fill="#709d88"/><text x="50%" y="50%" text-anchor="middle" font-size="${Math.min(width,height)/12}">${name}</text></svg>` });
  });
  await page.route(/^http:\/\/127\.0\.0\.1:5173\/api\//, route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') writes++;
    let data = {};
    if (url.pathname === '/api/auth/me') data = { id: 'fixture', email: 'photo@example.test' };
    else if (url.pathname === '/api/usage') data = { remaining: 2, dailyLimit: 10 };
    else if (url.pathname === '/api/settings/config') data = { amapJsKey: '', amapJsSecurityCode: '' };
    else if (url.pathname.endsWith('/conversation')) data = { conversationId: 'photo-chat' };
    else if (url.pathname === '/api/conversations/photo-chat') data = { messages: [] };
    else if (url.pathname === '/api/trips/photo-layout-fixture/versions') data = { rootId: trip.id, versions: [{ id: trip.id, version: 1, title: trip.title, createdAt: 0, updatedAt: 0 }] };
    else if (url.pathname === '/api/trips/photo-layout-fixture') data = trip;
    return route.fulfill({ json: apiSuccess(data) });
  });
  await page.goto('http://127.0.0.1:5173/trips/photo-layout-fixture');
  await page.getByRole('group', { name: '行程天数' }).waitFor();
  // 详情页默认落在「总览」，需要每日卡片必须先进某一天
  await page.getByRole('group', { name: '行程天数' }).getByRole('button', { name: '第1天', exact: true }).click();
  assert.equal(await page.locator('.photo-credit').count(), 0, '卡片位置不再展示版权行，只在放大弹窗内展示');
  assert.equal(await page.locator('.poi-card .photo-credit').count(), 0);
  for (const [width, height] of [[1440, 1000], [1280, 800], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    for (const [name, naturalWidth, naturalHeight] of fixtures.slice(0, 5)) {
      const card = page.getByRole('article', { name, exact: true });
      const image = card.locator('img.poi-photo');
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(img => img.decode());
      const box = await image.evaluate(img => {
        const b = img.getBoundingClientRect();
        return { width: b.width, height: b.height, fit: getComputedStyle(img).objectFit };
      });
      assert.equal(box.fit, 'contain');
      assert.ok(Math.abs(box.width / box.height - naturalWidth / naturalHeight) < 0.02, `${name}: image ratio changed`);
      const portraitPhoto = naturalHeight > naturalWidth;
      const maxHeight = width < 640 ? (portraitPhoto ? 110 : 88) : (portraitPhoto ? 150 : 120);
      assert.ok(box.height <= maxHeight + 1 && box.width > 0 && box.height > 0, `${name}: photo must remain secondary to the itinerary`);
      if (name === '横版风景' && (width === 1440 || width === 390)) {
        // 照片宽度 = min(180px, 44% × 内容盒)：中栏 41fr 时 44% ≈ 209px，所以吃满 180px 固定档。
        // 若中栏变窄（曾经改到 37fr），44% 会变成约束、照片掉到 ~161px，这条就会挂。
        assert.ok(box.width >= (width === 1440 ? 170 : 120), `${name}: chosen medium layout should not regress to the small thumbnail`);
      }
      assert.ok(box.width <= (width < 640 ? 128 : 180) + 1, `${name}: photo must stay inside the fixed photo column`);
      const textBox = await card.locator('.activity-main').boundingBox();
      const imageBox = await image.boundingBox();
      const slotBox = await card.locator('.activity-photo').boundingBox();
      assert.ok(Math.abs(slotBox.width - (width < 640 ? 128 : 180)) < 1, `${name}: photo column keeps a fixed width`);
      assert.ok(Math.abs(slotBox.x + slotBox.width / 2 - (imageBox.x + imageBox.width / 2)) < 1, `${name}: photo is centered in its column`);
      assert.ok(textBox.x + textBox.width <= imageBox.x + 1, `${name}: photo should sit beside the text`);
      assert.ok(textBox.width > imageBox.width, `${name}: text must have more space than the photo`);
      const triggerBox = await card.locator('.poi-photo-trigger').boundingBox();
      assert.ok(triggerBox.width >= 44 && triggerBox.height >= 44, `${name}: full photo must remain easy to open`);
      measurements.push({ viewport: [width, height], name, ...box, textWidth: textBox.width });
    }
    const portrait = page.getByRole('button', { name: '查看竖版风景完整照片', exact: true });
    await portrait.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `portrait-${width}.png`) });
    await portrait.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '竖版风景', exact: true });
    await dialog.waitFor();
    await dialog.locator('img').evaluate(img => img.decode());
    const dialogImage = await dialog.locator('img').boundingBox();
    assert.ok(Math.abs(dialogImage.width / dialogImage.height - 2/3) < 0.02);
    const dialogBox = await dialog.boundingBox();
    assert.ok(dialogBox.x >= 0 && dialogBox.y >= 0 && dialogBox.x + dialogBox.width <= width + 1 && dialogBox.y + dialogBox.height <= height + 1);
    await page.screenshot({ path: path.join(out, `dialog-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await portrait.evaluate(button => button === document.activeElement), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  for (const name of ['损坏图片', '无图景点']) {
    const card = page.getByRole('article', { name, exact: true });
    await card.scrollIntoViewIfNeeded();
    await page.waitForFunction(name => [...document.querySelectorAll('article')].find(el => el.getAttribute('aria-label') === name)?.querySelector('button.poi-photo-trigger') == null, name);
    assert.equal(await card.getByRole('button', { name: `查看${name}完整照片` }).count(), 0);
    assert.equal(await card.locator('.activity-photo').count(), 0, `${name}: 无封面不再保留空列`);
    const cardBox = await card.boundingBox();
    const textBox = await card.locator('.activity-main').boundingBox();
    assert.ok(textBox.width > cardBox.width * 0.6, `${name}: 无封面时文字占满宽度`);
  }
  for (const [width, height] of [[1440, 1000], [390, 844], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const trigger = page.getByRole('button', { name: '查看横版风景完整照片', exact: true });
    await trigger.click();
    const gallery = page.getByRole('dialog', { name: '横版风景', exact: true });
    const choices = gallery.getByRole('group', { name: '选择照片' });
    assert.equal(await choices.getByRole('button').count(), 3, '封面在三张总数内，异常第四张不展示');
    assert.match(await gallery.locator('[role="status"]').textContent(), /1 \/ 3/);
    await gallery.getByRole('button', { name: '下一张照片', exact: true }).click();
    await gallery.locator('.poi-photo-expanded').evaluate(img => img.decode());
    assert.match(await gallery.locator('.poi-photo-expanded').getAttribute('src'), /photo-layout-1/);
    assert.match(await gallery.locator('.photo-credit').textContent(), /摄影师2/);
    assert.doesNotMatch(await gallery.locator('.photo-credit').textContent(), /模拟署名验证/, '放大弹窗不再展示裁切说明文字');
    assert.equal(await gallery.locator('.photo-credit').getAttribute('title'), null);
    assert.equal(await gallery.locator('.photo-credit').getByRole('link', { name: '摄影师2', exact: true }).getAttribute('href'), credit(1).photographerUrl);
    assert.equal(await gallery.locator('.photo-credit').getByRole('link', { name: 'Unsplash', exact: true }).getAttribute('href'), credit(1).sourceUrl);
    await gallery.getByRole('button', { name: '查看第3张照片', exact: true }).click();
    assert.match(await gallery.locator('.photo-credit').textContent(), /摄影师3/);
    assert.equal(await gallery.locator('.photo-credit').getByRole('link', { name: 'Pixabay', exact: true }).getAttribute('href'), credit(2).sourceUrl);
    await page.keyboard.press('ArrowLeft');
    assert.match(await gallery.locator('[role="status"]').textContent(), /2 \/ 3/);
    assert.ok(await gallery.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.screenshot({ path: path.join(out, `gallery-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.match(await trigger.locator('img').getAttribute('src'), /photo-layout-0/, '浏览备选不得换掉封面');
    await trigger.click();
    assert.match(await gallery.locator('[role="status"]').textContent(), /1 \/ 3/, '重新打开从封面开始');
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(writes, 0, 'Viewing images must not change a trip or send conversation messages');
  assert.deepEqual(errors, []);
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ passed: true, measurements, writes, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: true, combinations: measurements.length, writes, pageErrors: errors }));
} finally { await browser.close(); }
