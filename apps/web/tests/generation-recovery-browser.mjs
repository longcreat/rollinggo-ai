import { apiSuccess, apiFailure } from '../../../scripts/lib/api-contract.mjs';
// Real React hook + native EventSource against a local reconnecting SSE fixture.
// Start Vite on 18811, then: node apps/web/tests/generation-recovery-browser.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const connections = [];
const streams = new Set();
const send = (res, id, event) => res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' });
  res.write('retry: 100\n\n');
  streams.add(res);
  res.on('close', () => streams.delete(res));
  connections.push({ url: req.url, after: req.headers['last-event-id'] ?? '', res });
  if (req.url.includes('/job-a/')) {
    if (!req.headers['last-event-id']) {
      send(res, 1, { type: 'job_start', destination: '北京', days: 3, xhsEnabled: false });
      send(res, 2, { type: 'phase_start', phase: 'research', round: 1 });
      send(res, 3, { type: 'candidate', poi: { id: 'a', name: '故宫' } });
      res.end();
    } else {
      send(res, 3, { type: 'candidate', poi: { id: 'a', name: '故宫' } });
      send(res, 4, { type: 'phase_end', phase: 'research', round: 1 });
    }
  } else {
    send(res, 1, { type: 'job_start', destination: '成都', days: 2, xhsEnabled: false });
    send(res, 2, { type: 'candidate', poi: { id: 'b', name: '武侯祠' } });
  }
});
await new Promise((resolve) => server.listen(18810, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--no-proxy-server', '--disable-features=LocalNetworkAccessChecks'] });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') console.error(message.text()); });
  await page.route('**/generation-recovery-fixture.html', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>',
  }));
  let starts = 0;
  let snapshotUnauthorized = false;
  await page.route((url) => url.port === '18811' && url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request();
    if (request.url().endsWith('/api/generations') && request.method() === 'POST') {
      starts++;
      return route.fulfill({ json: apiSuccess({ jobId: starts === 1 ? 'job-a' : 'job-b' }) });
    }
    if (/\/api\/generations\/job-[ab]$/.test(request.url())) return snapshotUnauthorized
      ? route.fulfill({ status: 401, json: apiFailure(401, '登录过期') })
      : route.fulfill({ json: apiSuccess({ jobId: request.url().split('/').at(-1), status: 'running', tripId: null, createdAt: 1 }) });
    return route.fulfill({ status: 401, json: apiFailure(401, 'fixture') });
  });
  const mount = async () => {
    await page.waitForSelector('#root', { state: 'attached' });
    await page.evaluate(async () => {
      const { default: RefreshRuntime } = await import('/@react-refresh');
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      const { mountGenerationRecovery } = await import('/tests/fixtures/generationRecovery.tsx');
      mountGenerationRecovery();
    });
    await page.locator('#state').waitFor();
  };
  await page.goto('http://127.0.0.1:18811/generation-recovery-fixture.html');
  await mount();
  await page.getByRole('button', { name: '开始测试生成' }).click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#state').textContent).events.length === 4).catch(async (error) => {
    console.error({ state: await page.locator('#state').textContent(), errors, connections: connections.map(({ url, after }) => ({ url, after })) });
    throw error;
  });
  const state = () => page.locator('#state').textContent().then(JSON.parse);
  assert.deepEqual((await state()).events.map((event) => event.type), ['job_start', 'phase_start', 'candidate', 'phase_end']);
  assert.equal(connections.at(-1).after, '3');
  send(connections.at(-1).res, 5, { type: 'job_done', tripId: 'saved-a', usedXhs: false, dataSources: [], reviewNotes: [] });
  await page.waitForFunction(() => JSON.parse(document.querySelector('#state').textContent).done.length === 1);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tw.activeJobId')), null);
  assert.deepEqual((await state()).done, ['saved-a']);
  console.log('PASS 原生 SSE 断线增量恢复保留历史、去除重复事件并完成跳转回调');

  await page.getByRole('button', { name: '开始测试生成' }).click();
  await page.waitForFunction(() => {
    const s = JSON.parse(document.querySelector('#state').textContent);
    return s.jobId === 'job-b' && s.events.length === 2;
  });
  assert.equal((await state()).events[0].destination, '成都');
  assert.equal(connections.at(-1).after, '');
  console.log('PASS 新任务重置事件游标，较小事件 ID 不会被误丢弃');

  await page.reload();
  await mount();
  await page.waitForFunction(() => {
    const s = JSON.parse(document.querySelector('#state').textContent);
    return !s.restoring && s.jobId === 'job-b' && s.events.length === 2;
  });
  assert.equal((await state()).events[1].poi.name, '武侯祠');
  assert.equal(connections.at(-1).after, '');
  assert.deepEqual(errors, []);
  console.log('PASS 刷新后快照恢复并全量重建，没有浏览器异常');
  snapshotUnauthorized = true;
  connections.at(-1).res.end();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#state').textContent).errorMessage === '登录已过期，请重新登录');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tw.activeJobId')), null);
  const connectionCount = connections.length;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(connections.length, connectionCount, '401 后必须停止原生 SSE 重连');
  assert.equal(streams.size, 0);
  assert.deepEqual(errors, []);
  console.log('PASS SSE 重连遇到会话失效时清理恢复状态并停止重连');
} finally {
  await browser.close();
  for (const stream of streams) stream.end();
  await new Promise((resolve) => server.close(resolve));
}
