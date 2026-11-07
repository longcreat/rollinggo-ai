// Dedicated disposable PG database. No real external provider calls.
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { makeSampleTrip } from '@tripweaver/shared';
import { Client } from 'pg';
import { mock } from 'node:test';

const databaseName = `route_options_verify_${Date.now()}`;
const adminUrl = process.env.VERIFY_GENERATION_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:18797/postgres';
const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
process.env.DATABASE_URL = databaseUrl.toString();
process.env.DOTENV_CONFIG_PATH = './data/route-options-absent.env';
process.env.MASTER_KEY = 'a'.repeat(64);
process.env.AMAP_KEY = 'route-test-fixture';
process.env.AMAP_DAILY_BUDGET = '40';
process.env.AMAP_QUOTA_ENFORCE = 'true';
process.env.GITHUB_CLIENT_ID = '';
process.env.GITHUB_CLIENT_SECRET = '';
process.env.REGISTRATION_MODE = 'open';
// 在服务构造并捕获 Date.now 前设置时钟，避免 admission 与请求侧看到不同日期。
mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T04:00:00Z') });
const { db, pool } = await import('../apps/server/src/db/client');
const { runMigrations } = await import('../apps/server/src/db/migrate');
const { users } = await import('../apps/server/src/db/schema');
const { createSession } = await import('../apps/server/src/auth/session');
const { createTrip } = await import('../apps/server/src/services/tripService');
const { tripRoutes } = await import('../apps/server/src/routes/trips');
const { amapBudgetRemaining } = await import('../apps/server/src/services/quotaService');
const { installApiResponses } = await import('../apps/server/src/http/apiResponse');
const app = Fastify();
installApiResponses(app);
const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async (url) => {
  externalCalls++;
  const path = new URL(String(url)).pathname;
  assert.equal(new URL(String(url)).hostname, 'restapi.amap.com');
  const body = path.includes('/geocode/')
    ? { status: '1', geocodes: [{ location: '116.39,39.91', adcode: '110000' }] }
    : { status: '1', route: { paths: [{ distance: '1000', cost: { duration: '600' }, steps: [{ polyline: '116.39,39.91;116.40,39.92' }] }], transits: [{ distance: '2000', cost: { duration: '900' } }] } };
  return new Response(JSON.stringify(body));
};
try {
  await runMigrations(pool); // second run must preserve new table/data
  await db.insert(users).values(['owner', 'other'].map((id) => ({ id, email: `${id}@route.test`, passwordHash: '', createdAt: new Date() })));
  const ownerCookie = `tw_session=${(await createSession('owner')).token}`;
  const otherCookie = `tw_session=${(await createSession('other')).token}`;
  const trip = await createTrip('owner', makeSampleTrip());
  const body = { from: trip.days[0]!.activities[0]!, to: trip.days[0]!.activities[1]!, destination: trip.destination };
  await app.register(cookie);
  await app.register(tripRoutes, { prefix: '/api/trips' });
  const request = (cookieValue?: string, payload: unknown = body, id = trip.id) => app.inject({ method: 'POST', url: `/api/trips/${id}/route-options`, headers: cookieValue ? { cookie: cookieValue } : {}, payload });
  assert.equal((await request()).statusCode, 401);
  assert.equal((await request(otherCookie)).statusCode, 404);
  assert.equal((await request(ownerCookie, body, 'missing')).statusCode, 404);
  assert.equal((await request(ownerCookie, { ...body, from: { ...body.from, lat: 999 } })).statusCode, 400);
  assert.equal(externalCalls, 0);
  const response = await request(ownerCookie);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.options.filter((o: { status: string }) => o.status === 'available').length, 4);
  assert.equal(response.body.includes('route-test-fixture'), false);
  assert.equal(await amapBudgetRemaining(), 240 - externalCalls, 'only actual outbound attempts charged by service');
  const afterFirstQuery = externalCalls;
  assert.equal((await request(ownerCookie, { ...body, mode: 'drive' })).statusCode, 200);
  assert.equal(externalCalls, afterFirstQuery, 'single-mode query reuses prefetched result');
  assert.equal(await amapBudgetRemaining(), 240 - externalCalls, 'server cache hit consumes no quota');
  const selected = response.json().data.options[0].leg;
  trip.days[0]!.legs = [selected];
  const saved = await app.inject({ method: 'PUT', url: `/api/trips/${trip.id}`, headers: { cookie: ownerCookie }, payload: trip });
  assert.equal(saved.statusCode, 200);
  const savedId = saved.json().data.id;
  assert.notEqual(savedId, trip.id, '编辑保存生成新版本，原行程冻结');
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/trips/${savedId}`, headers: { cookie: ownerCookie } })).json().data.days[0].legs[0], selected);
  const callsBefore = externalCalls;
  assert.equal((await request(ownerCookie)).statusCode, 200);
  assert.equal(externalCalls, callsBefore);
  await runMigrations(pool);
  assert.equal(await amapBudgetRemaining(), 240 - externalCalls, 'migration preserves usage');
  const { upsertSettings } = await import('../apps/server/src/services/settingsService');
  await upsertSettings('owner', { amapApiKey: 'changed-fixture' });
  assert.equal((await request(ownerCookie, { ...body, mode: 'drive' })).statusCode, 200);
  assert.equal(await amapBudgetRemaining(), 240 - externalCalls, 'credential changes do not charge adapter cache hits');
  const shifted = { ...body, mode: 'drive', from: { ...body.from, lat: body.from.lat + 0.01 } };
  assert.equal((await request(ownerCookie, shifted)).statusCode, 200);
  assert.equal(await amapBudgetRemaining(), 240 - externalCalls, 'coordinate change charges actual requests');
  const beforeExpiry = externalCalls;
  mock.timers.setTime(Date.now() + 301_000);
  assert.equal((await request(ownerCookie, shifted)).statusCode, 200);
  assert.equal(externalCalls, beforeExpiry + 1, 'expired route/result cache queries provider again');
  const { createAmapQuotaLedger } = await import('../apps/server/src/lib/amapQuotaLedger');
  const { AMAP_SERVICES, amapDay } = await import('../apps/server/src/integrations/amap/services');
  const limits = Object.fromEntries(AMAP_SERVICES.map(service => [service, 5])) as Record<typeof AMAP_SERVICES[number], number>;
  limits.place = 0;
  let quotaNow = Date.parse('2026-10-01T15:59:59Z');
  const ledger = createAmapQuotaLedger(pool, limits, () => quotaNow);
  const decisions = await Promise.all(Array.from({ length: 50 }, () => ledger.acquire('walk')));
  assert.equal(decisions.filter(d => d.allowed).length, 5, '50 concurrent requests cannot exceed 5');
  assert.equal((await ledger.acquire('place')).allowed, false, 'zero disables service');
  assert.equal((await ledger.acquire('drive')).allowed, true, 'walk cannot consume drive budget');
  assert.equal((await createAmapQuotaLedger(pool, limits, () => quotaNow).acquire('walk')).allowed, false, 'restart preserves usage');
  quotaNow += 1000;
  assert.equal((await ledger.acquire('walk')).used, 1, 'UTC+8 midnight resets daily budget');

  // Exhaust just drive for the current API day; uncached route degrades, other modes remain usable.
  await pool.query('UPDATE amap_service_usage SET calls = 40 WHERE day = $1 AND service = $2', [amapDay().day, 'drive']);
  const beforeDenied = externalCalls;
  const exhausted = await request(ownerCookie, { ...shifted, from: { ...shifted.from, lat: shifted.from.lat + 0.02 } });
  assert.equal(exhausted.statusCode, 200);
  assert.equal(exhausted.json().data.options[0].status, 'unavailable');
  assert.equal(externalCalls, beforeDenied);

  // Simulate the first upgrade in this disposable DB, with legacy aggregate usage.
  await pool.query('DELETE FROM amap_service_usage');
  await pool.query("INSERT INTO editor_geo_usage(day, source, calls) VALUES ($1, 'amap', 7)", [amapDay().day]);
  await runMigrations(pool);
  const seeded = await pool.query('SELECT calls FROM amap_service_usage');
  assert.deepEqual(seeded.rows.map(row => row.calls), Array(6).fill(7));
  await runMigrations(pool);
  assert.deepEqual((await pool.query('SELECT calls FROM amap_service_usage')).rows, seeded.rows, 'legacy usage seeded once only');
  console.log('PASS route API and real PG: authorization, caches, save/reload, atomic service budgets, zero limit, restart, UTC+8 rollover, legacy migration');
} finally {
  globalThis.fetch = originalFetch;
  mock.timers.reset();
  await app.close();
  await pool.end();
  if (!/^route_options_verify_\d+$/.test(databaseName)) throw new Error('Invalid disposable database name');
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
}
