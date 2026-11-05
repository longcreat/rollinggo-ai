import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { makeSampleTrip, chinaDate, dateForDayIndex, tripAdviceInputSnapshot } from '@tripweaver/shared';
import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';

const base = process.env.BASE ?? 'http://127.0.0.1:5173';
const out = process.env.OUT ?? 'verify-shots/trip-weather';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--no-proxy-server', '--disable-features=LocalNetworkAccessChecks'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
page.setDefaultTimeout(15_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let trip = { ...makeSampleTrip(), id: 'weather-test', title: '北京 · 宫苑与街巷', destination: '北京', startDate: chinaDate(), weather: undefined };
const places = [['故宫博物院', '景山公园', '北海公园', '什刹海'], ['雍和宫', '国子监', '南锣鼓巷', '烟袋斜街'], ['颐和园', '圆明园', '清华艺术博物馆']];
trip.days.forEach((day, index) => {
  day.title = ['中轴宫苑漫步', '胡同里的慢时光', '山水园林一日'][index];
  day.activities.forEach((activity, i) => { activity.name = places[index][i]; activity.lat = 39.92 + index * .01 + i * .007; activity.lng = 116.39 + index * .01 - i * .004; });
});
trip.overview = [{ id: 'p1', name: trip.days[0].activities[0].name, category: 'attraction', intro: '走进宫苑，看红墙与古建。', reservation: 'required', sourceLinks: [] }];
const reportTime = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
const forecast = { city: '北京市', locationId: '101010100', reportTime, casts: [
  { date: trip.startDate, dayWeather: '晴', nightWeather: '多云', dayTemp: 24, nightTemp: 14, dayWind: '北', nightWind: '北', dayPower: '≤3', nightPower: '≤3' },
  { date: dateForDayIndex(trip.startDate, 2), dayWeather: '小雨', nightWeather: '阴', dayTemp: 20, nightTemp: 12, dayWind: '东', nightWind: '东', dayPower: '≤3', nightPower: '≤3' },
  { date: dateForDayIndex(trip.startDate, 3), dayWeather: '多云', nightWeather: '晴', dayTemp: 22, nightTemp: 13, dayWind: '北', nightWind: '北', dayPower: '≤3', nightPower: '≤3' },
] };
let weatherMode = 'available';
let writes = 0;
let weatherCalls = 0;
let gate;
let release;
await page.route(`${base}/api/**`, async route => {
  const path = new URL(route.request().url()).pathname;
  const ok = data => route.fulfill({ json: apiSuccess(data) });
  if (path === '/api/auth/me') return ok({ id: 'weather-user', email: 'weather@example.test' });
  if (path === '/api/settings/travel-preferences') return ok({ preferences: [], transportMode: 'transit', pace: null, partySize: 2, extraNotes: '' });
  if (path === '/api/settings/config') return ok({ amapJsKey: '', amapJsSecurityCode: '' });
  if (path === '/api/usage') return ok({ remaining: 3, dailyLimit: 5 });
  if (path.endsWith('/conversation')) return ok({ conversationId: 'weather-chat' });
  if (path === '/api/conversations/weather-chat') return ok({ messages: [] });
  if (path.endsWith('/versions')) return ok({ rootId: trip.id, versions: [{ id: trip.id, version: 1, title: trip.title, createdAt: 0, updatedAt: 0 }] });
  if (path.endsWith('/weather')) {
    weatherCalls++;
    if (gate) await gate;
    if (weatherMode === 'error') return route.fulfill({ status: 503, json: apiFailure(503, '天气服务暂不可用') });
    return ok({ destination: trip.destination, checkedAt: Date.now(), status: weatherMode, ...(weatherMode === 'available' ? { forecast } : {}) });
  }
  if (path.endsWith('/route-options')) return ok({ options: [{ status: 'unavailable', mode: route.request().postDataJSON().mode, reason: '测试中不查询路线' }] });
  if (path === `/api/trips/${trip.id}`) {
    if (route.request().method() !== 'GET') writes++;
    return ok(trip);
  }
  return ok({});
});
const select = name => page.getByRole('group', { name: '行程天数' }).getByRole('button', { name, exact: true });
try {
  gate = new Promise(resolve => { release = resolve; });
  await page.goto(`${base}/trips/${trip.id}`);
  await page.getByRole('region', { name: '行程总览', exact: true }).waitFor();
  assert.equal(await select('总览').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.getByText('天气查询中…', { exact: true }).count());
  release(); gate = undefined;
  await page.getByText('14–24℃', { exact: true }).waitFor();
  assert.ok((await page.locator('.editor-overview').innerText()).includes('第 1 天'), 'overview lists each day with its date');
  assert.equal(await page.getByRole('button', { name: '更新天气', exact: true }).count(), 0, 'overview has no bottom weather-refresh row');
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.getByRole('heading', { name: /^(出行手册|每日安排)$/ }).count(), 0);
  for (const title of ['旅行建议', '注意事项']) {
    const adviceBounds = await page.getByRole('region', { name: title, exact: true }).boundingBox();
    const firstDayBounds = await page.locator('.editor-overview-day').first().boundingBox();
    assert.ok(adviceBounds && firstDayBounds && adviceBounds.y + adviceBounds.height <= firstDayBounds.y,
      `${title} appears above daily itinerary cards`);
  }
  await page.screenshot({ path: `${out}/overview-desktop.png` });
  await select('第1天').click();
  const palaceCard = page.getByRole('article', { name: '故宫博物院', exact: true });
  assert.equal(await palaceCard.locator('.activity-tags .cat-badge').count(), 1, '类别标签保留在标签行容器内');
  assert.equal(await palaceCard.locator('.activity-tags .rsv-badge').count(), 1, '预约徽章与类别标签同行');
  await select('总览').click();
  await page.setViewportSize({ width: 1600, height: 1600 });
  await page.locator('.editor-overview').screenshot({ path: `${out}/overview-panel.png` });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('heading', { name: '旅行建议', exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole('heading', { name: '注意事项', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole('heading', { name: '旅行建议', exact: true }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: '注意事项', exact: true }).count(), 1);
  assert.ok(await page.getByText(/第 2 天有雨雪预报/).count());
  const scrollList = () => page.locator('.editor-left-scroll').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  await scrollList();
  await page.screenshot({ path: `${out}/advice-desktop.png` });
  await page.locator('section[aria-label="注意事项"] li').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/cautions-desktop.png` });
  await page.getByRole('button', { name: /^查看第2天/ }).click();
  const dayWeather = page.locator('.day-section .day-weather');
  await dayWeather.waitFor();
  assert.equal(await dayWeather.count(), 1);
  const dayWeatherText = await dayWeather.innerText();
  assert.ok(dayWeatherText.includes('12–20℃'), dayWeatherText);
  assert.equal(/白天|夜间|风|和风天气|更新/.test(dayWeatherText), false, '每日卡片只保留天气图标 + 天气 + 温度');
  await page.screenshot({ path: `${out}/day-desktop.png` });
  await select('总览').click();
  const before = weatherCalls;
  await page.reload();
  await page.getByText('14–24℃', { exact: true }).waitFor();
  assert.ok(weatherCalls > before, 'every overview visit re-reads the forecast');
  assert.equal(writes, 0, 'weather reads and day navigation never save a trip');
  weatherMode = 'error';
  await page.reload();
  await page.getByRole('region', { name: '行程总览', exact: true }).waitFor();
  await page.getByText('天气暂不可用', { exact: true }).first().waitFor();
  await page.getByText('天气信息待补充', { exact: true }).waitFor();
  weatherMode = 'available';
  await page.reload();
  await page.getByText('14–24℃', { exact: true }).waitFor();
  weatherMode = 'not_configured';
  await page.reload();
  await page.getByRole('region', { name: '行程总览', exact: true }).waitFor();
  await page.getByText('天气服务未配置', { exact: true }).first().waitFor();
  await page.getByText('天气未接入', { exact: true }).waitFor();
  assert.equal(await page.getByText('可稍后重试', { exact: false }).count(), 0, 'a missing data source is not offered as retryable');
  await page.screenshot({ path: `${out}/unconfigured-desktop.png` });
  trip = { ...trip, startDate: '2099-10-01' };
  weatherMode = 'not_needed';
  await page.reload();
  await page.getByRole('region', { name: '行程总览', exact: true }).waitFor();
  assert.equal(await page.locator('.day-weather').getByText('预报待更新', { exact: true }).count(), 3);
  assert.equal(await page.getByText(/\d+–\d+℃/).count(), 0);
  trip = { ...trip, startDate: '' };
  await page.reload();
  await page.getByRole('region', { name: '行程总览', exact: true }).waitFor();
  assert.ok(await page.getByText('日期待定', { exact: true }).count());
  trip = { ...trip, startDate: chinaDate() };
  weatherMode = 'available';
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.reload();
    await page.getByText('14–24℃', { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${out}/overview-${width}.png` });
    await page.setViewportSize({ width, height: 1800 });
    await page.locator('.editor-overview').screenshot({ path: `${out}/overview-panel-${width}.png` });
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px page overflow`);
    assert.ok(await page.locator('.editor-left-scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${width}px content overflow`);
    await page.getByRole('button', { name: /^查看第2天/ }).click();
    await page.locator('.day-section .day-weather').waitFor();
    await page.screenshot({ path: `${out}/day-${width}.png` });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  const firstId = trip.days[0].activities[0].id;
  const secondId = trip.days[1].activities[0].id;
  trip.meta.advice = { version: 1, generatedAt: Date.now(), inputSnapshot: tripAdviceInputSnapshot(trip),
    suggestions: [
      { title: '宫苑与胡同分开慢游', text: '第1天按故宫、景山、北海到什刹海的安排逐站游览，把停留时间留给喜欢的院落；第2天再体验雍和宫周边胡同。', activityIds: [firstId, secondId], sources: [] },
      { title: '园林日留足步行体力', text: '第3天安排了颐和园与圆明园，可按体力选择重点区域，避免为了走遍每一处压缩休息时间。', activityIds: [trip.days[2].activities[0].id], sources: [] },
    ],
    cautions: [{ title: '先核实故宫预约', text: '第1天的故宫参观涉及预约；入场与分项展馆要求请通过官方渠道核实后安排，知识库资料不代表实时余票。', activityIds: [firstId], sources: [{ title: '故宫资料来源', url: 'https://example.com/palace' }] }],
  };
  for (const width of [1600, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.reload();
    await page.getByText('宫苑与胡同分开慢游', { exact: true }).waitFor();
    await page.getByText(/第 2 天有雨雪预报/).waitFor();
    assert.equal(await page.getByRole('link', { name: '先核实故宫预约：故宫资料来源' }).getAttribute('href'), 'https://example.com/palace');
    assert.equal(await page.getByText('随身物品', { exact: true }).count(), 0);
    const suggestions = page.getByRole('region', { name: '旅行建议', exact: true });
    assert.equal(await suggestions.locator('li').count(), 4, '默认显示全部条目');
    assert.equal(await page.getByRole('button', { name: /展开完整内容|^收起$/ }).count(), 0);
    assert.equal(await suggestions.locator('.line-clamp-3').count(), 0, '正文不截断');
    assert.ok(await page.locator('.editor-left-scroll').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await page.locator('.editor-overview').screenshot({ path: `${out}/personal-advice-${width}.png` });
  }
  trip.days[0].activities.reverse();
  await page.reload();
  await page.getByRole('status').filter({ hasText: '专属旅行建议与注意事项待更新' }).waitFor();
  assert.equal(await page.getByText('宫苑与胡同分开慢游', { exact: true }).count(), 0);
  await page.locator('.editor-overview').screenshot({ path: `${out}/personal-advice-stale.png` });
  assert.equal(writes, 0);
  assert.deepEqual(errors, []);
  console.log('PASS weather UI: default overview, daily forecasts, personal advice/sources/stale state, unconfigured/error/pending/undated states, no writes, 390/768/1600px; mocked provider data');
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png` });
  console.error((await page.locator('body').innerText()).slice(0, 5000));
  throw error;
} finally { await browser.close(); }
