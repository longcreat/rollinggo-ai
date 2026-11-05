import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test, mock, afterEach } from 'node:test';
import { looksLikeJwt, normalizePem, parseQWeatherPrivateKey, qweatherAuthHeader, signQWeatherJwt, type QWeatherAuth } from '../integrations/qweather/auth';
import { qweatherQuotaGate, qweatherDay, qweatherRequest, setQWeatherLogger } from '../integrations/qweather/client';

afterEach(() => { mock.restoreAll(); mock.timers.reset(); });
const HOST = 'fixture.qweatherapi.com';
const allowed = () => ({ ...qweatherDay(), service: 'qweather', allowed: true, used: 1, limit: 5 });
const apiKey: QWeatherAuth = { mode: 'api-key', apiKey: 'k' };
const call = (host = HOST, auth: QWeatherAuth = apiKey) => qweatherRequest(host, '/v7/weather/15d', new URLSearchParams({ location: '101010100' }), auth);

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, auth: { mode: 'jwt', keyId: kid, developerId: 'Q12345ABCD', projectId: 'PROJ1', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() } as QWeatherAuth };
}

test('daily boundary is midnight UTC+8', () => {
  const before = qweatherDay(Date.parse('2026-09-29T15:59:59Z'));
  const after = qweatherDay(Date.parse('2026-09-29T16:00:00Z'));
  assert.equal(after.start, before.resetAt);
  assert.equal(after.start - before.start, 86400_000);
});

test('jwt credentials sign an EdDSA token the console public key can verify', () => {
  const { publicKey, auth } = keyPair('KEY-1');
  const now = Date.parse('2026-10-04T04:00:00Z');
  const jwt = auth as Extract<QWeatherAuth, { mode: 'jwt' }>;
  const token = signQWeatherJwt(jwt, parseQWeatherPrivateKey(jwt.privateKey), now);
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header!, 'base64url').toString()), { alg: 'EdDSA', kid: 'KEY-1' });
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
  assert.equal(claims.iss, 'Q12345ABCD');
  assert.equal(claims.sub, 'PROJ1');
  assert.equal(claims.iat, Math.floor(now / 1000) - 30, 'iat is backdated 30s for clock skew');
  assert.equal(claims.exp - claims.iat, 900, 'well within the 24h ceiling');
  assert.equal(verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url')), true);
  assert.equal(verify(null, Buffer.from(`${header}.${payload}x`), publicKey, Buffer.from(signature!, 'base64url')), false);
  assert.equal(looksLikeJwt(token), true);
  assert.equal(looksLikeJwt('ABCD1234EFGH'), false);
});

test('auth headers follow the credential mode and jwts are re-signed before they expire', () => {
  const { auth } = keyPair('KEY-2');
  const start = Date.parse('2026-10-04T04:00:00Z');
  assert.deepEqual(qweatherAuthHeader({ mode: 'api-key', apiKey: 'ABCD1234EFGH' }), { 'X-QW-Api-Key': 'ABCD1234EFGH' });
  assert.deepEqual(qweatherAuthHeader({ mode: 'token', token: 'eyJ.a.b' }), { Authorization: 'Bearer eyJ.a.b' });
  const first = qweatherAuthHeader(auth, start).Authorization!;
  assert.equal(qweatherAuthHeader(auth, start + 100_000).Authorization, first, 'cached while far from expiry');
  const renewed = qweatherAuthHeader(auth, start + 700_000).Authorization!;
  assert.notEqual(renewed, first, 're-signed with a 5 minute margin');
  assert.equal(renewed.startsWith('Bearer eyJ'), true);
});

test('a pem written on one line, or with literal \\n, still signs (the .env trap)', () => {
  const { publicKey, auth } = keyPair('KEY-4');
  const pem = (auth as Extract<QWeatherAuth, { mode: 'jwt' }>).privateKey.trim();
  const oneLine = { ...(auth as Extract<QWeatherAuth, { mode: 'jwt' }>), privateKey: pem.split('\n').join('') };
  assert.equal(oneLine.privateKey.includes('\n'), false, 'openSSL rejects an unwrapped single-line pem, we must not');
  const header = qweatherAuthHeader(oneLine, Date.parse('2026-10-04T04:00:00Z')).Authorization!;
  const [head, payload, signature] = header.replace('Bearer ', '').split('.');
  assert.equal(verify(null, Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(signature!, 'base64url')), true);
  const escaped = { ...oneLine, privateKey: pem.split('\n').join('\\n') };
  assert.equal(qweatherAuthHeader(escaped).Authorization!.startsWith('Bearer eyJ'), true, 'literal \\n is restored');
  assert.equal(normalizePem(oneLine.privateKey).split('\n').length, 4, 'header, wrapped body, footer, trailing newline');
  assert.equal(normalizePem('not a pem'), 'not a pem');
});

test('exhausted budget, metering outage and a malformed host never reach upstream', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const gate = mock.method(qweatherQuotaGate, 'acquire', async () => ({ ...allowed(), allowed: false }));
  await assert.rejects(call(), /预算已用完/);
  gate.mock.mockImplementation(async () => { throw new Error('database secret'); });
  await assert.rejects(call(), /计量暂不可用/);
  gate.mock.mockImplementation(async () => allowed());
  for (const host of ['localhost:3000/evil', 'not a host', 'api.qweather.com/path', '']) {
    await assert.rejects(call(host), /Host 格式不正确/);
  }
  assert.equal(gate.mock.callCount(), 2, 'a bad host is rejected before it costs a quota unit');
  assert.equal(fetch.mock.callCount(), 0);
});

test('a broken private key is reported before any quota is spent', async () => {
  const records: unknown[] = [];
  setQWeatherLogger({ info: (data: unknown) => { records.push(data); }, warn: (data: unknown) => { records.push(data); } });
  const gate = mock.method(qweatherQuotaGate, 'acquire', async () => allowed());
  await assert.rejects(call(HOST, { mode: 'jwt', keyId: 'K', developerId: 'Q1', projectId: 'P', privateKey: 'not-a-pem' }), /私钥缺少 -----BEGIN/);
  assert.equal(gate.mock.callCount(), 0);
  assert.equal(JSON.stringify(records).includes('not-a-pem'), false);
});

test('the credential travels in a header, never in the URL or diagnostics', async () => {
  const records: unknown[] = [];
  setQWeatherLogger({ info: (data: unknown) => { records.push(data); }, warn: (data: unknown) => { records.push(data); } });
  const gate = mock.method(qweatherQuotaGate, 'acquire', async () => allowed());
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url).includes('private-key'), false, 'credential must not enter the URL');
    assert.equal(new URL(String(url)).hostname, HOST);
    assert.equal((init?.headers as Record<string, string>)['X-QW-Api-Key'], 'private-key');
    return new Response(JSON.stringify({ code: '401' }));
  });
  await assert.rejects(call(HOST, { mode: 'api-key', apiKey: 'private-key' }), /和风 401/);
  assert.equal(gate.mock.callCount(), 1);
  assert.equal(JSON.stringify(records).includes('private-key'), false);
  fetch.mock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
    const header = (init?.headers as Record<string, string>).Authorization ?? '';
    assert.equal(header.startsWith('Bearer eyJ'), true);
    return new Response(JSON.stringify({ code: '200', daily: [] }));
  });
  const { auth } = keyPair('KEY-3');
  assert.equal((await call(HOST, auth)).code, '200');
  assert.equal(JSON.stringify(records).includes('eyJ'), false, 'issued tokens stay out of logs');
});

test('a successful response returns the parsed body after charging exactly one call', async () => {
  const gate = mock.method(qweatherQuotaGate, 'acquire', async () => ({ ...allowed(), used: 2 }));
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    assert.equal(new URL(String(url)).pathname, '/v7/weather/15d');
    return new Response(JSON.stringify({ code: '200', daily: [] }));
  });
  assert.equal((await call()).code, '200');
  assert.equal(gate.mock.callCount(), 1);
});

test('midnight between reservation and fetch requires a new-day reservation', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T15:59:59Z') });
  let reservations = 0;
  mock.method(qweatherQuotaGate, 'acquire', async () => {
    const decision = allowed();
    if (++reservations === 1) mock.timers.setTime(Date.parse('2026-09-29T16:00:00Z'));
    return decision;
  });
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('{"code":"200"}'));
  await call();
  assert.equal(reservations, 2);
  assert.equal(fetch.mock.callCount(), 1);
});
