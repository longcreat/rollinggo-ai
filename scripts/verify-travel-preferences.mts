// 专用临时数据库；验证账号隔离、幂等迁移与 API 契约，不调用外部服务。
import assert from 'node:assert/strict';
import { Client } from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const name = `travel_preferences_verify_${Date.now()}`;
const adminUrl = process.env.VERIFY_PREFERENCES_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:18797/postgres';
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${name}"`);
const url = new URL(adminUrl);
url.pathname = `/${name}`;
Object.assign(process.env, {
  DATABASE_URL: url.toString(), MASTER_KEY: 'a'.repeat(64),
  DOTENV_CONFIG_PATH: './data/preferences-absent.env', REGISTRATION_MODE: 'open',
  SITE_LLM_API_KEY: '', SITE_LLM_BASE_URL: '', SITE_LLM_MODEL: '',
  GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
});
const { pool } = await import('../apps/server/src/db/client');
const { runMigrations } = await import('../apps/server/src/db/migrate');
const { settingsRoutes } = await import('../apps/server/src/routes/settings');
const { installApiResponses } = await import('../apps/server/src/http/apiResponse');
const { createSession } = await import('../apps/server/src/auth/session');
const app = Fastify();
installApiResponses(app);
await app.register(cookie);
await app.register(settingsRoutes, { prefix: '/api/settings' });
const path = '/api/settings/travel-preferences';
const defaults = { preferences: [], transportMode: 'transit', pace: null, partySize: 2, extraNotes: '' };
try {
  // 旧库升级路径：已有用户设置不因新增表而改变。
  await pool.query("INSERT INTO user_settings (user_id, model, updated_at) VALUES ('a', 'preserve-model', NOW())");
  await pool.query('DROP TABLE user_travel_preferences');
  await runMigrations(pool);
  await runMigrations(pool);
  assert.equal((await pool.query("SELECT model FROM user_settings WHERE user_id='a'")).rows[0].model, 'preserve-model');
  await pool.query("INSERT INTO users (id,email,password_hash,created_at) VALUES ('a','a@example.test','',NOW()),('b','b@example.test','',NOW())");
  const a = { tw_session: (await createSession('a')).token };
  const b = { tw_session: (await createSession('b')).token };
  assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 401);
  assert.equal((await app.inject({ method: 'PUT', url: path, payload: defaults })).statusCode, 401);
  assert.deepEqual((await app.inject({ method: 'GET', url: path, cookies: a })).json().data, defaults);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_travel_preferences')).rows[0].n, 0);
  // 上一版格式的行（没有 pace / partySize）按缺省读出，不能当成损坏数据报 500。
  await pool.query('INSERT INTO user_travel_preferences (user_id, data, updated_at) VALUES ($1, $2::jsonb, NOW())',
    ['a', JSON.stringify({ preferences: ['文化'], transportMode: 'drive', extraNotes: '旧记录' })]);
  assert.deepEqual((await app.inject({ method: 'GET', url: path, cookies: a })).json().data,
    { preferences: ['文化'], transportMode: 'drive', pace: null, partySize: 2, extraNotes: '旧记录' });
  await pool.query("DELETE FROM user_travel_preferences WHERE user_id = 'a'");
  const saved = { preferences: ['美食'], transportMode: 'drive', pace: 'relaxed', partySize: 4, extraNotes: '带小孩一起\n需要午休' };
  const response = await app.inject({ method: 'PUT', url: path, cookies: a, payload: saved });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().code, 0);
  assert.deepEqual(response.json().data, saved);
  const aSecondSession = { tw_session: (await createSession('a')).token };
  assert.deepEqual((await app.inject({ method: 'GET', url: path, cookies: aSecondSession })).json().data, saved);
  assert.deepEqual((await app.inject({ method: 'GET', url: path, cookies: b })).json().data, defaults);
  for (const invalid of [
    { ...saved, extraNotes: '长'.repeat(201) }, { ...saved, transportMode: 'invalid' },
    { ...saved, preferences: ['美食', '美食'] }, { ...saved, preferences: ['invalid'] },
    { ...saved, extraNotes: null }, { ...saved, preferences: null },
    { ...saved, extraNotes: 123 }, { ...saved, preferences: '美食' },
    { ...saved, userId: 'b' },
    { ...saved, pace: 'fast' }, { ...saved, pace: 'moderate ' }, { ...saved, pace: undefined },
    { ...saved, partySize: 0 }, { ...saved, partySize: 21 }, { ...saved, partySize: 2.5 },
    { ...saved, partySize: '3' }, { ...saved, partySize: null },
    { preferences: [], transportMode: 'transit' },
  ]) assert.equal((await app.inject({ method: 'PUT', url: path, cookies: a, payload: invalid })).statusCode, 400, JSON.stringify(invalid));
  assert.deepEqual((await app.inject({ method: 'GET', url: path, cookies: a })).json().data, saved);
  await app.inject({ method: 'PUT', url: path, cookies: a, payload: defaults });
  assert.deepEqual((await app.inject({ method: 'GET', url: path, cookies: a })).json().data, defaults);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_travel_preferences')).rows[0].n, 1);
  // 库内损坏和存储失败必须明确失败，不能回落到默认值或假装保存成功。
  await pool.query("UPDATE user_travel_preferences SET data = '{}'::jsonb WHERE user_id = 'a'");
  const corrupt = await app.inject({ method: 'GET', url: path, cookies: a });
  assert.equal(corrupt.statusCode, 500);
  assert.equal(corrupt.json().code, 500);
  assert.equal(corrupt.json().data, null);
  // 非法 pace 也不能被缺省补齐掩盖掉
  await pool.query("UPDATE user_travel_preferences SET data = $1::jsonb WHERE user_id = 'a'", [JSON.stringify({ ...saved, pace: 'fast' })]);
  assert.equal((await app.inject({ method: 'GET', url: path, cookies: a })).statusCode, 500);
  await app.inject({ method: 'PUT', url: path, cookies: a, payload: saved });
  await pool.query('ALTER TABLE user_travel_preferences RENAME TO preferences_unavailable');
  try {
    for (const method of ['GET', 'PUT'] as const) {
      const failed = await app.inject({ method, url: path, cookies: a, ...(method === 'PUT' ? { payload: defaults } : {}) });
      assert.equal(failed.statusCode, 500);
      assert.equal(failed.json().code, 500);
      assert.equal(failed.json().data, null);
      assert.doesNotMatch(failed.body, /preferences_unavailable|user_travel_preferences|SELECT|INSERT/);
    }
  } finally {
    await pool.query('ALTER TABLE preferences_unavailable RENAME TO user_travel_preferences');
  }
  assert.deepEqual((await app.inject({ method: 'GET', url: path, cookies: a })).json().data, saved);
  console.log('PASS 幂等迁移、原设置保留、鉴权、账号隔离、重新登录恢复、旧格式行缺省补齐、节奏与同行的非法输入、清空持久化、存储损坏及故障');
} finally {
  await app.close();
  await pool.end();
  await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
