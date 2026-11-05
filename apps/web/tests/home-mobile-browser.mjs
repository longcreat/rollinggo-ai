// 首页响应式布局与弹层行为；所有业务请求都使用隔离数据，不写真实账号。
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';

const base = process.env.HOME_TEST_URL ?? 'http://127.0.0.1:5173';
const output = path.resolve(process.env.HOME_TEST_OUTPUT ?? 'data/home-mobile-verification');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-proxy-server'] });
const reports = [];
const cities = ['北京', '杭州', '成都', '上海', '济南', '广州', '西安', '厦门', '重庆', '苏州', '青岛'];
const sizes = [[320, 568], [375, 812], [390, 844], [430, 932], [768, 1024], [844, 390], [1024, 768], [1440, 900]].filter(([width]) => !process.env.HOME_TEST_WIDTH || width === Number(process.env.HOME_TEST_WIDTH));

async function stable(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
  });
}

async function withinViewport(locator, page, label) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label} is visible`);
  const { width, height } = page.viewportSize();
  assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${label} fits width: ${JSON.stringify(box)}`);
  assert.ok(box.y >= -1 && box.y + box.height <= height + 1, `${label} fits height: ${JSON.stringify(box)}`);
}

try {
  for (const [width, height] of sizes) {
    const mobile = width < 1024;
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: mobile, isMobile: mobile, reducedMotion: 'reduce' });
    const errors = [];
    let cityMode = 'normal';
    const writes = [];
    let generationBody;
    await context.route(`${base}/api/**`, route => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      if (req.method() !== 'GET') writes.push(`${req.method()} ${p}`);
      if (p === '/api/generations' && req.method() === 'POST') {
        generationBody = req.postDataJSON();
        return route.fulfill({ status: 503, json: apiFailure(503, '测试暂停生成') });
      }
      if (p === '/api/auth/me' && width === 390) return route.fulfill({ json: apiSuccess(null) });
      if (p === '/api/destinations/covered' && cityMode === 'error') return route.fulfill({ status: 503, json: apiFailure(503, '暂不可用') });
      const fixtures = {
        '/api/auth/me': { id: 'home-mobile-fixture', email: 'home@example.test' },
        '/api/auth/config': { registrationMode: 'open', githubEnabled: false },
        '/api/usage': { remaining: 4, dailyLimit: 5 },
        '/api/settings/travel-preferences': { preferences: [], transportMode: 'transit', pace: null, partySize: 2, extraNotes: '' },
        '/api/destinations/covered': { cities: cityMode === 'empty' ? [] : cities },
        '/api/generations/current': null,
        '/api/trips': { items: [], total: 0, destinations: [] },
        '/api/notifications': { items: [], hasUnread: false, readThrough: 0, nextCursor: null },
      };
      return route.fulfill({ json: apiSuccess(fixtures[p] ?? {}) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.goto(base);
    const dateTrigger = page.getByRole('button', { name: /^出行日期/ });
    await dateTrigger.waitFor();
    await stable(page);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no horizontal overflow`);
    await withinViewport(page.locator('.topbar-capsule'), page, 'navigation');
    await withinViewport(page.getByRole('link', { name: '返回首页' }), page, 'brand');
    const navigation = page.getByRole('navigation', { name: '主导航' });
    await withinViewport(navigation, page, 'top navigation');
    assert.equal(await page.getByRole('navigation', { name: '底部导航' }).count(), 0, 'no bottom tabs');
    assert.equal(await navigation.getByRole('link', { name: '首页', exact: true }).getAttribute('aria-current'), 'page');
    const tripsLink = navigation.getByRole('link', { name: '我的行程', exact: true });
    await withinViewport(tripsLink, page, 'trips link');
    const navBox = await navigation.boundingBox();
    const actionsBox = await page.locator('.topbar-actions').boundingBox();
    assert.ok(navBox.x + navBox.width <= actionsBox.x + 1, 'navigation does not overlap account actions');
    assert.equal(await page.locator('.app-main').evaluate(el => getComputedStyle(el).marginBottom), '0px', 'no bottom tab spacer');
    if (width !== 390) await withinViewport(page.getByRole('button', { name: '退出登录' }), page, 'logout');
    const start = page.getByRole('button', { name: mobile ? '生成我的行程' : '开始规划', exact: true });
    assert.ok(await start.isDisabled());
    await page.screenshot({ path: path.join(output, `home-${width}.png`), fullPage: true });

    if (mobile) {
      assert.equal(await page.getByRole('img', { name: /中国地图/ }).count(), 0, 'home starts with planning');
      assert.equal(await page.getByRole('region', { name: '目的地精选' }).getByRole('button', { name: /^选择/ }).count(), 3);
      await page.getByRole('button', { name: /^目的地/ }).click();
      await withinViewport(page.getByRole('dialog', { name: '选择目的地' }), page, 'destination screen');
      assert.equal(new URL(page.url()).searchParams.get('choose'), 'destination');
      assert.ok(await page.getByRole('button', { name: '确认目的地' }).isDisabled());
    }

    const mapView = page.getByRole('img', { name: /中国地图/ }).locator(':scope > g');
    const initialTransform = await mapView.getAttribute('transform');
    if (mobile) {
      const dialog = page.getByRole('dialog', { name: '选择目的地' });
      assert.equal(await dialog.getByRole('searchbox').count(), 0, 'picker has no search field');
      assert.equal(await page.getByRole('button', { name: /^(放大|缩小|重置)地图$/ }).count(), 0, 'mobile map has no tool group');
      const map = page.getByRole('img', { name: /中国地图/ });
      assert.ok(await map.evaluate(svg => {
        const box = svg.getBoundingClientRect();
        const matrix = svg.getScreenCTM();
        // 检查整张画布都在视口内；南海诸岛由原有右下插图呈现。
        return [[0, 0], [900, 700]].every(([x, y]) => {
          const point = new DOMPoint(x, y).matrixTransform(matrix);
          return point.x >= box.left - 1 && point.x <= box.right + 1 && point.y >= box.top - 1 && point.y <= box.bottom + 1;
        });
      }), 'complete map canvas fits without cropping');
      const box = await map.boundingBox();
      await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 3 + 70, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      assert.equal(await mapView.getAttribute('transform'), initialTransform, 'mobile horizontal drag cannot move map');
      const canScroll = await page.locator('.modal-scroll').evaluate(el => el.scrollHeight > el.clientHeight);
      await page.mouse.wheel(0, 80);
      if (canScroll) await page.waitForFunction(() => document.querySelector('.modal-scroll').scrollTop > 0);
      else await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await mapView.getAttribute('transform'), initialTransform, 'mobile wheel scroll cannot zoom map');
      await page.locator('.modal-scroll').evaluate(el => { el.scrollTop = 0; });
      const jinan = await page.getByRole('dialog').locator('.map-city-label').filter({ hasText: '济南' }).boundingBox();
      const qingdao = await page.getByRole('dialog').locator('.map-city-label').filter({ hasText: '青岛' }).boundingBox();
      assert.ok(jinan.x + jinan.width <= qingdao.x || jinan.y + jinan.height <= qingdao.y || qingdao.y + qingdao.height <= jinan.y, 'nearby city labels remain separate');
    } else {
      await page.getByRole('button', { name: '放大地图' }).click();
      assert.notEqual(await mapView.getAttribute('transform'), initialTransform);
      await page.getByRole('button', { name: '重置地图' }).click();
      assert.equal(await mapView.getAttribute('transform'), initialTransform);
      if (width === 1024) {
        await page.getByRole('button', { name: '放大地图' }).click();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole('button', { name: '放大地图' }).waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: /^目的地/ }).click();
        const pickerMap = page.getByRole('dialog').getByRole('img', { name: /中国地图/ }).locator(':scope > g');
        assert.equal(await pickerMap.getAttribute('transform'), 'translate(0 0) scale(1)', 'mobile view resets after desktop zoom');
        await page.getByRole('button', { name: '返回首页' }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.setViewportSize({ width, height });
        await page.getByRole('button', { name: '放大地图' }).waitFor();
        assert.equal(await mapView.getAttribute('transform'), initialTransform, 'desktop default view returns after breakpoint change');
      }
    }
    await page.getByRole('button', { name: '选择目的地城市 北京', exact: true }).click();
    if (mobile) {
      const selectedCard = page.getByRole('dialog').getByRole('button', { name: '选择北京', exact: true });
      assert.equal(await selectedCard.getAttribute('aria-pressed'), 'true');
      assert.doesNotMatch(await selectedCard.textContent(), /[✓✔]/, 'featured selection has no checkmark');
      await page.screenshot({ path: path.join(output, `picker-${width}.png`) });
      if (width === 320) {
        const cdp = await context.newCDPSession(page);
        const map = await page.getByRole('img', { name: /中国地图/ }).boundingBox();
        const x = map.x + 60;
        const y = map.y + map.height - 50;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let dx = 20; dx <= 100; dx += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await mapView.getAttribute('transform'), initialTransform, 'native horizontal swipe keeps fixed map');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x + 30, y }, { id: 2, x: x + 80, y }] });
        for (let spread = 5; spread <= 25; spread += 5) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 30 - spread, y }, { id: 2, x: x + 80 + spread, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await mapView.getAttribute('transform'), initialTransform, 'native pinch keeps fixed map');
        assert.equal(await page.evaluate(() => visualViewport.scale), 1, 'map pinch does not magnify page');
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        for (let dy = 20; dy <= 120; dy += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - dy }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForFunction(() => document.querySelector('.modal-scroll').scrollTop > 0);
        assert.equal(await mapView.getAttribute('transform'), initialTransform, 'native vertical swipe scrolls page while map stays fixed');
        assert.equal(await selectedCard.getAttribute('aria-pressed'), 'true', 'map gestures preserve selected city');
        await cdp.detach();
      }
      await page.getByRole('button', { name: '确认目的地' }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    await page.getByRole('button', { name: /^目的地.*北京/ }).waitFor();

    await dateTrigger.click();
    await page.locator('.range-calendar').waitFor();
    assert.equal(await page.locator('.range-calendar-month').count(), mobile ? 1 : 2);
    if (mobile) await withinViewport(page.getByRole('dialog', { name: '选择出行日期' }), page, 'date sheet');
    await page.getByRole('button', { name: '下一月' }).click();
    const days = page.locator('.range-calendar-day:not(:disabled)');
    const begin = await days.nth(1).getAttribute('aria-label');
    const end = await days.nth(3).getAttribute('aria-label');
    await days.nth(1).click();
    await days.nth(3).click();
    assert.equal(await page.locator('.range-calendar-day.is-start:not(:disabled)').getAttribute('aria-label'), begin);
    assert.equal(await page.locator('.range-calendar-day.is-end:not(:disabled)').getAttribute('aria-label'), end);
    await page.screenshot({ path: path.join(output, `date-${width}.png`) });
    await page.keyboard.press('Escape');
    await page.locator('.range-calendar').waitFor({ state: 'hidden' });
    if (mobile) assert.ok(await dateTrigger.evaluate(el => el === document.activeElement), 'sheet restores trigger focus');

    await page.getByRole('button', { name: /^目的地/ }).click();
    if (mobile) {
      const cityList = page.getByRole('dialog').locator('details');
      await cityList.locator('summary').click();
      assert.equal(await cityList.getByRole('button').count(), cities.length, 'city list contains covered cities only');
      await cityList.getByRole('button', { name: '杭州', exact: true }).click();
      await page.getByRole('button', { name: '确认目的地' }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    } else {
      await page.getByRole('button', { name: '杭州', exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: /^目的地.*杭州/ }).waitFor();
    if (mobile) {
      const selectedCard = page.getByRole('button', { name: '选择杭州', exact: true });
      assert.equal(await selectedCard.getAttribute('aria-pressed'), 'true');
      assert.doesNotMatch(await selectedCard.textContent(), /[✓✔]/, 'home featured selection has no checkmark');
    }
    await page.getByRole('button', { name: /^节奏与同行/ }).click();
    if (mobile) await withinViewport(page.getByRole('dialog', { name: '节奏与同行' }), page, 'pace sheet');
    await page.getByRole('button', { name: /经典地标全景体验/ }).click();
    await page.getByRole('button', { name: '增加人数' }).click();
    await page.getByText('3 人同行', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, `pace-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.ok(await start.isEnabled());
    await page.screenshot({ path: path.join(output, `ready-${width}.png`), fullPage: true });

    await page.getByRole('button', { name: /^偏好与出行/ }).click();
    if (mobile) await withinViewport(page.getByRole('dialog', { name: '偏好与出行' }), page, 'preferences sheet');
    const preference = page.locator('fieldset').first().getByRole('button').first();
    await preference.click();
    assert.equal(await preference.getAttribute('aria-pressed'), 'true');
    await page.getByLabel('备注', { exact: true }).fill('希望慢慢旅行，每天留出午休时间。'.repeat(10));
    if (mobile) assert.ok(await page.getByLabel('备注', { exact: true }).evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16));
    await page.screenshot({ path: path.join(output, `preferences-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    if (mobile) {
      const dateSummary = await dateTrigger.textContent();
      const paceSummary = await page.getByRole('button', { name: /^节奏与同行/ }).textContent();
      const preferenceSummary = await page.getByRole('button', { name: /^偏好与出行/ }).textContent();
      for (const exit of ['button', 'back', 'escape']) {
        await page.getByRole('button', { name: /^目的地/ }).click();
        await page.getByRole('dialog', { name: '选择目的地' }).getByRole('button', { name: '选择目的地城市 上海', exact: true }).click();
        if (exit === 'button') await page.getByRole('button', { name: '返回首页' }).click();
        else if (exit === 'back') await page.goBack();
        else await page.keyboard.press('Escape');
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: /^目的地.*杭州/ }).waitFor();
        assert.equal(await dateTrigger.textContent(), dateSummary);
        assert.equal(await page.getByRole('button', { name: /^节奏与同行/ }).textContent(), paceSummary);
        assert.equal(await page.getByRole('button', { name: /^偏好与出行/ }).textContent(), preferenceSummary);
      }
      await page.goForward();
      await page.getByRole('dialog', { name: '选择目的地' }).waitFor();
      await page.getByRole('button', { name: '返回首页' }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: /^偏好与出行/ }).click();
      assert.equal(await page.getByLabel('备注', { exact: true }).inputValue(), '希望慢慢旅行，每天留出午休时间。'.repeat(10));
      await page.keyboard.press('Escape');
    }

    if (width === 390) {
      await start.click();
      await page.getByRole('dialog').waitFor();
      await page.getByLabel('邮箱', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await tripsLink.click();
      await page.getByRole('dialog', { name: '登录 RollingGo' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^目的地.*杭州/ }).waitFor();
      for (const mode of ['empty', 'error']) {
        cityMode = mode;
        await page.reload();
        await page.getByText(mode === 'empty' ? '暂时没有可规划的城市，请稍后再来。' : '城市列表加载失败，请刷新重试。').waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, [], 'homepage only edits local drafts');
    if (width === 375) {
      await start.click();
      await page.getByText('测试暂停生成', { exact: true }).waitFor();
      assert.equal(generationBody.destination, '杭州');
      assert.equal(generationBody.partySize, 3);
      assert.equal(generationBody.pace, 'moderate');
      assert.equal(generationBody.extraNotes, '希望慢慢旅行，每天留出午休时间。'.repeat(10));
      assert.equal(generationBody.preferences.length, 1);
      await tripsLink.click();
      await page.locator('.trip-collection').waitFor();
      await withinViewport(navigation, page, 'collection top navigation');
      assert.equal(await page.getByRole('navigation', { name: '底部导航' }).count(), 0);
      assert.equal(await tripsLink.getAttribute('aria-current'), 'page');
      await page.screenshot({ path: path.join(output, `trips-${width}.png`), fullPage: true });
      await navigation.getByRole('link', { name: '首页', exact: true }).click();
      await page.getByRole('button', { name: /^目的地/ }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/');
      assert.equal(await navigation.getByRole('link', { name: '首页', exact: true }).getAttribute('aria-current'), 'page');
    }
    if (width === 430) {
      await page.goto(`${base}/?choose=destination&keep=yes`);
      await page.getByRole('dialog', { name: '选择目的地' }).waitFor();
      await page.getByRole('button', { name: '返回首页' }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).searchParams.get('keep'), 'yes');
      assert.equal(new URL(page.url()).searchParams.has('choose'), false);
      await context.route(url => {
        const pathname = decodeURIComponent(url.pathname);
        return pathname.includes('/src/assets/destinations/') || /^\/assets\/(北京|杭州|厦门)-[^/]+\.webp$/.test(pathname);
      }, route => route.request().resourceType() === 'image' ? route.abort() : route.continue());
      await page.reload();
      await page.getByRole('button', { name: '选择北京', exact: true }).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="目的地精选"] img')].every(img => img.complete && img.naturalWidth > 0 && img.src.includes('.png')));
      await page.screenshot({ path: path.join(output, 'image-fallback.png'), fullPage: true });
      await context.route(url => {
        const pathname = decodeURIComponent(url.pathname);
        return pathname.includes('/src/assets/city-landmarks/') || /^\/assets\/(北京|杭州|厦门)-[^/]+\.png$/.test(pathname);
      }, route => route.request().resourceType() === 'image' ? route.abort() : route.continue());
      await page.reload();
      await page.getByRole('img', { name: '北京城市图片暂缺' }).waitFor();
      assert.ok(await page.getByRole('button', { name: '选择北京', exact: true }).isEnabled(), 'missing photos do not block selection');
      await page.getByRole('button', { name: /^目的地/ }).click();
      const cityList = page.getByRole('dialog').locator('details');
      await cityList.locator('summary').click();
      await cityList.getByRole('button', { name: '厦门', exact: true }).click();
      assert.equal(await cityList.getByRole('button', { name: '厦门', exact: true }).getAttribute('aria-pressed'), 'true', 'city list still selects destinations with missing images');
    }
    reports.push({ width, height, status: 'passed' });
    console.log(`PASS ${width}x${height}`);
    await context.close();
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify(reports, null, 2));
} finally {
  await browser.close();
}
