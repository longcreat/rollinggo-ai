// Disposable database; all QWeather requests are intercepted. No production trip writes.
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { Client } from 'pg';
import { makeSampleTrip, chinaDate, WEATHER_FORECAST_DAYS } from '@rollinggo-trip/shared';

dotenv.config({ path: 'apps/server/.env', quiet: true });
const name = `weather_verify_${Date.now()}`;
const adminUrl = new URL(process.env.WEATHER_TEST_ADMIN_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:18797/postgres');
if (!['127.0.0.1', 'localhost'].includes(adminUrl.hostname)) throw new Error('Weather verification requires a local test database server');
adminUrl.pathname = '/postgres';
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${name}"`);
const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${name}`;
// 走真实的 JWT 链路：用本地生成的 Ed25519 私钥现签，上游收到的 token 要能用公钥验签。
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
Object.assign(process.env, { DATABASE_URL: dbUrl.toString(), MASTER_KEY: 'a'.repeat(64),
  AMAP_KEY: '', QWEATHER_API_HOST: 'fixture.qweatherapi.com', QWEATHER_DAILY_BUDGET: '3', QWEATHER_KEY: '',
  QWEATHER_JWT_KEY_ID: 'VERIFY-KEY', QWEATHER_JWT_DEVELOPER_ID: 'Q12345ABCD', QWEATHER_JWT_PROJECT_ID: 'VERIFY-PROJECT',
  QWEATHER_JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  SEARCH_API_KEY: '', SITE_LLM_API_KEY: '', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' });
const { db, pool } = await import('@rollinggo-trip/core/db/client');
const { users } = await import('@rollinggo-trip/core/db/schema');
const { createSession } = await import('../apps/server/src/auth/session');
const { createTrip, getTrip } = await import('@rollinggo-trip/services/tripService');
const { getTripWeather } = await import('@rollinggo-trip/services/tripWeatherService');
const { tripRoutes } = await import('../apps/server/src/routes/trips');
const { env } = await import('@rollinggo-trip/core/env');
const { installApiResponses } = await import('../apps/server/src/http/apiResponse');
const app = Fastify();
installApiResponses(app);
const originalFetch = globalThis.fetch;
const calls: string[] = [];
const CITY_LOOKUP = '/geo/v2/city/lookup';
const DAILY = `/v7/weather/${WEATHER_FORECAST_DAYS}d`;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.hostname, 'fixture.qweatherapi.com');
  const bearer = (init?.headers as Record<string, string>).Authorization ?? '';
  const token = bearer.replace(/^Bearer /, '');
  const [head, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head!, 'base64url').toString()), { alg: 'EdDSA', kid: 'VERIFY-KEY' });
  assert.equal(JSON.stringify(JSON.parse(Buffer.from(payload!, 'base64url').toString())).includes('VERIFY-PROJECT'), true);
  assert.equal(verify(null, Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(signature!, 'base64url')), true, 'upstream receives a JWT signed by our private key');
  assert.equal(String(input).includes(token), false, 'token never enters the URL');
  calls.push(url.pathname);
  if (url.pathname === CITY_LOOKUP) {
    return Response.json({ code: '200', location: [{ id: url.searchParams.get('location') === '上海' ? '101020100' : '101010100', name: url.searchParams.get('location') }] });
  }
  assert.equal(url.pathname, DAILY);
  return Response.json({ code: '200', updateTime: new Date().toISOString(),
    daily: [{ fxDate: chinaDate(), textDay: '小雨', textNight: '阴', tempMax: '20', tempMin: '12', windDirDay: '北风', windDirNight: '北风', windScaleDay: '≤3', windScaleNight: '≤3' }] });
};
try {
  await db.insert(users).values(['weather-owner', 'weather-other'].map(id => ({ id, email: `${id}@fixture.test`, passwordHash: '', createdAt: new Date() })));
  const owner = `tw_session=${(await createSession('weather-owner')).token}`;
  const other = `tw_session=${(await createSession('weather-other')).token}`;
  const trip = await createTrip('weather-owner', { ...makeSampleTrip(), destination: '北京', startDate: chinaDate() });
  await app.register(cookie);
  await app.register(tripRoutes, { prefix: '/api/trips' });
  const request = (session?: string, id = trip.id) => app.inject({ method: 'GET', url: `/api/trips/${id}/weather`, headers: session ? { cookie: session } : {} });
  assert.equal((await request()).statusCode, 401);
  assert.equal((await request(other)).statusCode, 404);
  assert.equal((await request(owner, 'missing')).statusCode, 404);
  assert.equal(calls.length, 0, 'ownership precedes provider work');
  const response = await request(owner);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().data.status, 'available');
  assert.equal(response.json().data.forecast.casts[0].dayTemp, 20);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.includes('eyJ'), false, 'issued tokens never reach the client');
  await request(owner);
  assert.equal(calls.length, 2, 'repeat detail visit reuses forecast');
  assert.deepEqual(await getTrip('weather-owner', trip.id), trip, 'weather refresh never mutates persisted trip or version');
  const snapshot = await createTrip('weather-owner', { ...trip, weather: await getTripWeather(trip) });
  assert.equal((await getTrip('weather-owner', snapshot.id))?.weather?.status, 'available', 'generation-shaped snapshots round-trip');
  const exhausted = await createTrip('weather-owner', { ...trip, destination: '上海' });
  assert.equal((await request(owner, exhausted.id)).json().data.status, 'unavailable');
  assert.equal(calls.filter(path => path === DAILY).length, 1, 'durable quota stops the second forecast request');
  const persisted = await pool.query('SELECT calls FROM amap_service_usage WHERE service=$1', ['qweather']);
  assert.equal(persisted.rows[0]?.calls, 3);
  env.qweatherJwtReady = false;
  assert.equal((await request(owner)).json().data.status, 'not_configured');
  for (const startDate of ['', '2020-01-01', '2099-10-01']) {
    const dated = await createTrip('weather-owner', { ...trip, startDate });
    assert.equal((await request(owner, dated.id)).json().data.status, 'not_needed');
  }
  assert.equal(calls.length, 3);
  console.log('PASS weather API: 401/404, actual API envelope/schema, exact QWeather protocol, cache, durable weather quota, no key, no-date/past/future, no version mutations; mocked upstream');
} finally {
  globalThis.fetch = originalFetch;
  await app.close(); await pool.end();
  if (!/^weather_verify_\d+$/.test(name)) throw new Error('Invalid disposable database name');
  await admin.query(`DROP DATABASE "${name}"`);
  await admin.end();
}
