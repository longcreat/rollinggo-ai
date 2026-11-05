import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const base = process.env.HANDWRITING_URL ?? 'http://127.0.0.1:5173';
const out = path.resolve(process.env.HANDWRITING_OUTPUT ?? 'verify-shots/handwriting');
await fs.mkdir(out, { recursive: true });
const trip = process.env.HANDWRITING_TRIP_FIXTURE
  ? JSON.parse(await fs.readFile(process.env.HANDWRITING_TRIP_FIXTURE, 'utf8'))
  : { id: 'font-fixture', title: '皇城园林漫游', destination: '北京', startDate: '2026-10-16', partySize: 2,
    preferences: [], budgetLevel: '舒适', totalBudget: 0, extraNotes: '', createdAt: 0, updatedAt: 0,
    meta: { usedXhs: false, reviewNotes: [] },
    days: [{ id: 'day-1', dayIndex: 1, title: '中轴宫苑漫步', legs: [], activities: [
      { id: 'a1', name: '故宫博物院', description: '穿过宫门，沿中轴线看殿宇与庭院。', category: '文化', startTime: '', endTime: '', sourceNotes: [] },
    ] }] };
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1672, height: 941 }, reducedMotion: 'reduce' });
  const errors = [], assetErrors = [], fonts = [], fontRequests = new Set();
  let writes = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400 && /\/src\/|\/fonts\/handwriting\//.test(response.url())) assetErrors.push(response.url());
  });
  page.on('request', request => { if (request.url().includes('/fonts/handwriting/')) fontRequests.add(new URL(request.url()).pathname); });
  await page.route(`${base}/api/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/photos/')) return route.continue();
    // Route menus perform POST reads when mounted; do not call real route providers.
    if (url.pathname.endsWith('/route-options')) return route.fulfill({ status: 503, json: apiFailure(503, 'Font fixture: routing unavailable') });
    if (route.request().method() !== 'GET') writes++;
    let data = {};
    if (url.pathname === '/api/auth/me') data = { id: 'font-test', email: 'font@example.test' };
    else if (url.pathname === '/api/usage') data = { remaining: 2, dailyLimit: 4 };
    else if (url.pathname === '/api/settings/config') data = { amapJsKey: '', amapJsSecurityCode: '' };
    else if (url.pathname === '/api/destinations/covered') data = [];
    else if (url.pathname === '/api/trips') { const items = ['北京', '罍城'].map((destination, i) => ({ id: `cover-${i}`, title: '旅行手账', destination, daysCount: 3, activityCount: 8, totalCost: 0, usedXhs: false, version: 1, createdAt: 0, updatedAt: 0 })); data = { items, total: items.length, destinations: items.map(item => item.destination) }; }
    else if (url.pathname.endsWith('/versions')) data = { versions: [{ id: trip.id, version: 1 }] };
    else if (url.pathname.endsWith('/conversation')) data = { conversationId: 'font-chat' };
    else if (url.pathname === '/api/conversations/font-chat') data = { messages: [{ id: 'message-1', role: 'assistant', content: '今天从故宫开始，慢慢感受老北京的宫苑与街巷。', createdAt: 0 }] };
    else if (url.pathname === `/api/trips/${trip.id}`) data = trip;
    return route.fulfill({ json: apiSuccess(data) });
  });
  const ready = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  async function check(selector, expectedHandwriting, label) {
    await ready();
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert.ok(nodeId, selector);
    const result = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
    assert.ok(result.fonts.length, `No rendered font: ${label}`);
    fonts.push({ label, text: await page.locator(selector).first().innerText(), fonts: result.fonts });
    if (expectedHandwriting) assert.ok(result.fonts.every(font => font.isCustomFont && font.familyName === 'Youran-Handwriting'), label);
    else assert.ok(result.fonts.every(font => font.familyName !== 'Youran-Handwriting'), label);
  }
  await page.goto(`${base}/trips/${trip.id}`);
  await page.getByRole('group', { name: '行程天数' }).getByRole('button', { name: '第1天', exact: true }).click();
  await page.locator('.day-head h2').waitFor().catch(async error => {
    console.log(JSON.stringify({ errors, body: await page.locator('body').innerText() }));
    await page.screenshot({ path: path.join(out, 'failure.png') });
    throw error;
  });
  assert.equal(await page.locator('.day-head h2').first().textContent(), '中轴宫苑漫步');
  await check('.day-head h2', true, '北京旧标题全部使用悠然小楷');
  await page.screenshot({ path: path.join(out, 'editor-desktop.png') });
  await page.getByRole('group', { name: '行程天数' }).getByRole('button', { name: '总览', exact: true }).click();
  await check('.editor-overview-day h4', true, '全程概览标题');
  await page.getByRole('group', { name: '行程天数' }).getByRole('button', { name: '第1天', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await check('.day-head h2', true, '手机标题');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: path.join(out, 'editor-mobile.png') });
  trip.days[0].title = '古罍听风';
  await page.reload();
  await page.getByRole('group', { name: '行程天数' }).getByRole('button', { name: '第1天', exact: true }).click();
  await page.locator('.day-head h2').waitFor();
  await check('.day-head h2', false, '未收录字整段回退');
  assert.equal(await page.locator('.day-head h2').textContent(), '古罍听风');
  await page.setViewportSize({ width: 1672, height: 941 });
  await page.goto(`${base}/trips`);
  await page.locator('.collection-destination').first().waitFor();
  await check('.collection-card:nth-child(1) .collection-destination', true, '北京行程封面');
  await check('.collection-card:nth-child(2) .collection-destination', false, '生僻城市封面整段回退');
  await page.screenshot({ path: path.join(out, 'collection.png') });
  await page.goto(base);
  await page.waitForSelector('#root > *');
  await page.evaluate(async () => {
    const { default: React } = await import('/node_modules/.vite/deps/react.js');
    const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { GenerationRunPanel } = await import('/src/components/GenerationRunPanel.tsx');
    document.querySelector('#root').remove();
    const host = document.createElement('div'); document.body.append(host);
    ReactDOM.createRoot(host).render(React.createElement(GenerationRunPanel, {
      city: '北京', days: 3, cancelling: false, cancellationError: null, onCancel() {}, onReset() {}, onOpenTrip() {},
      events: [
        { type: 'job_start', at: Date.now(), destination: '北京', days: 3, dataSources: [] },
        { type: 'phase_start', phase: 'research', round: 1 },
        { type: 'tool_start', phase: 'research', toolCallId: 'font-status', label: '漫步中轴宫苑' },
        ...['故宫 · 角楼黄昏', '颐和园 · 昆明湖', '古罍听风'].map((name, i) => ({ type: 'candidate', poi: { id: `font-${i}`, name, category: 'attraction', coverUrl: '/home-bg.png', intro: '' } })),
      ],
    }));
  });
  await page.waitForFunction(() => document.querySelectorAll('figcaption.gen-polaroid-caption').length === 3);
  await check('figure:nth-child(1) figcaption', true, '相片题字');
  await check('figure:nth-child(2) figcaption', true, '颐和园相片题字');
  await check('figure:nth-child(3) figcaption', false, '生僻地名相片整段回退');
  assert.equal(writes, 0, 'Font rendering must not rewrite stored trips');
  assert.deepEqual(errors, []);
  assert.deepEqual(assetErrors, []);
  assert.ok([...fontRequests].every(url => /youran-\d+-[a-f0-9]+\.woff2$/.test(url)), 'Do not request cached old handwriting assets');
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ passed: true, fonts, writes, fontRequests: [...fontRequests], errors }, null, 2));
  console.log(JSON.stringify({ passed: true, samples: fonts.length, writes, fontFiles: fontRequests.size, out }));
} finally { await browser.close(); }
