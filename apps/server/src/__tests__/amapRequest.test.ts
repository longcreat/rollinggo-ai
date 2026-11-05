import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { amapQuotaGate, amapRequest, setAmapLogger } from '../integrations/amap/request';
import { AMAP_PATHS, AMAP_SERVICES, amapDay, readAmapServiceBudgets } from '../integrations/amap/services';

afterEach(() => { mock.restoreAll(); mock.timers.reset(); });
const allowed = (service: typeof AMAP_SERVICES[number]) => ({ ...amapDay(), service, allowed: true, used: 1, limit: 5 });

test('service configuration preserves explicit zero, validates integers and defaults', () => {
  assert.deepEqual(readAmapServiceBudgets({}), { geocode: 967, place: 161, walk: 967, cycle: 967, drive: 967, transit: 967 });
  assert.equal(readAmapServiceBudgets({ AMAP_PLACE_DAILY_BUDGET: '0' }).place, 0);
  assert.equal(readAmapServiceBudgets({ AMAP_DAILY_BUDGET: '600' }).place, 161);
  assert.equal(readAmapServiceBudgets({ AMAP_DAILY_BUDGET: '600' }).walk, 600);
  assert.equal(readAmapServiceBudgets({ AMAP_WALK_DAILY_BUDGET: '1' }).geocode, 967);
  assert.throws(() => readAmapServiceBudgets({ AMAP_PLACE_DAILY_BUDGET: '162' }));
  assert.throws(() => readAmapServiceBudgets({ AMAP_DRIVE_DAILY_BUDGET: '1000' }));
  assert.equal(readAmapServiceBudgets({ AMAP_LBS_MONTHLY_BUDGET: '0' }).drive, 0);
  for (const value of ['-1', 'NaN', '1.5', '2147483648']) {
    assert.throws(() => readAmapServiceBudgets({ AMAP_WALK_DAILY_BUDGET: value }));
  }
});

test('daily boundary is midnight UTC+8', () => {
  const before = amapDay(Date.parse('2026-09-29T15:59:59Z'));
  const after = amapDay(Date.parse('2026-09-29T16:00:00Z'));
  assert.equal(after.start, before.resetAt);
  assert.equal(after.start - before.start, 86400_000);
});

test('exhausted budget and database outage never reach upstream', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const gate = mock.method(amapQuotaGate, 'acquire', async (service: import('../integrations/amap/services').AmapService) => ({ ...allowed(service), allowed: false }));
  await assert.rejects(amapRequest('place', new URLSearchParams()));
  gate.mock.mockImplementation(async () => { throw new Error('database secret'); });
  await assert.rejects(amapRequest('walk', new URLSearchParams()), /计量暂不可用/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('each endpoint reserves its service once, including upstream rejection', async () => {
  const gate = mock.method(amapQuotaGate, 'acquire', async (service: import('../integrations/amap/services').AmapService) => allowed(service));
  const paths: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    paths.push(new URL(String(url)).pathname);
    return new Response(JSON.stringify({ status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' }));
  });
  for (const service of AMAP_SERVICES) await assert.rejects(amapRequest(service, new URLSearchParams()));
  assert.deepEqual(paths, AMAP_SERVICES.map(service => AMAP_PATHS[service]));
  assert.equal(gate.mock.callCount(), AMAP_SERVICES.length);
});

test('network failure is charged and sensitive upstream content is excluded from logs', async () => {
  const records: unknown[] = [];
  setAmapLogger({ info: (data: unknown) => { records.push(data); }, warn: (data: unknown) => { records.push(data); } });
  const gate = mock.method(amapQuotaGate, 'acquire', async (service: import('../integrations/amap/services').AmapService) => allowed(service));
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('private-key'); });
  await assert.rejects(amapRequest('drive', new URLSearchParams({ key: 'private-key' })), /请求失败/);
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ status: '0', info: 'private-key', infocode: 'private-key' })));
  await assert.rejects(amapRequest('drive', new URLSearchParams({ key: 'private-key' })), /UPSTREAM_REJECTED/);
  assert.equal(gate.mock.callCount(), 2);
  assert.equal(JSON.stringify(records).includes('private-key'), false);
});

test('midnight between reservation and fetch requires a new-day reservation', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T15:59:59Z') });
  let reservations = 0;
  mock.method(amapQuotaGate, 'acquire', async (service: import('../integrations/amap/services').AmapService) => {
    const decision = allowed(service);
    if (++reservations === 1) mock.timers.setTime(Date.parse('2026-09-29T16:00:00Z'));
    return decision;
  });
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('{"status":"1"}'));
  await amapRequest('walk', new URLSearchParams());
  assert.equal(reservations, 2);
  assert.equal(fetch.mock.callCount(), 1);
});
