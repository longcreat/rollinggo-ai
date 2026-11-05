// 主流程故障回归：专用本地 PostgreSQL + mock LLM；不访问真实模型/地图服务。
// node --import tsx scripts/verify-generation-flow.mts
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mock } from 'node:test';
import { Client } from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { startMockLlm } from './lib/mock-llm.mjs';

const databaseName = `generation_flow_verify_${Date.now()}`;
const adminUrl = process.env.VERIFY_GENERATION_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:18797/postgres';
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
Object.assign(process.env, {
  DATABASE_URL: databaseUrl.toString(),
  DOTENV_CONFIG_PATH: './data/generation-flow-absent.env', MASTER_KEY: 'a'.repeat(64),
  AMAP_KEY: '', SEARCH_API_KEY: '', SEARCH_API_BASE_URL: '',
  SITE_LLM_BASE_URL: '', SITE_LLM_API_KEY: '', SITE_LLM_MODEL: '',
  GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', REGISTRATION_MODE: 'open',
  SSRF_ALLOWLIST: '127.0.0.1:18808',
});
const llm = await startMockLlm(18808, { delayMs: 1 });
const { db, pool } = await import('../apps/server/src/db/client');
const { runGeneration } = await import('../apps/server/src/generation/orchestrator');
const { createJob, completeJob, cancelJob, getRunningJobId } = await import('../apps/server/src/generation/jobManager');
const { loadPlaceFacts } = await import('../apps/server/src/generation/scheduling/placeFacts');
const { poiScore, scoreMaxima } = await import('../apps/server/src/generation/scheduling/score');
const { createSession } = await import('../apps/server/src/auth/session');
const { generationRoutes } = await import('../apps/server/src/routes/generations');
const { notificationRoutes } = await import('../apps/server/src/routes/notifications');
const { recordGenerationNotification, listNotifications } = await import('../apps/server/src/services/notificationService');
const { applyDeterministicSchedule } = await import('../apps/server/src/generation/scheduling/buildDraft');
const { DraftTrip } = await import('../apps/server/src/generation/draft');
const form = { destination: '北京', days: 3, startDate: '', budgetLevel: '经济' as const,
  partySize: 1, preferences: ['美食'] as ['美食'], totalBudget: 0, extraNotes: '', pace: 'tight' as const };
const cfg = { baseUrl: 'http://127.0.0.1:18808/v1', apiKey: 'mock', model: 'mock-chat', byok: false };
const auditErrors: unknown[] = [];
const logger = { info() {}, error(...args: unknown[]) { auditErrors.push(args); } };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') throw new Error('Public provider disabled by verification');
  return originalFetch(input, init);
};
const appErrors: unknown[] = [];
const { installApiResponses } = await import('../apps/server/src/http/apiResponse');
const app = Fastify();
installApiResponses(app);
app.setErrorHandler((error, _request, reply) => {
  if (error.validation) { reply.code(400).send({ error: '请求格式错误' }); return; }
  appErrors.push(error); reply.code(500).send({ error: 'test failure' });
});
const counts = async (userId: string) => (await pool.query(
  `SELECT (SELECT count(*)::int FROM trips WHERE user_id=$1) AS trips,
          (SELECT count(*)::int FROM generations WHERE user_id=$1 AND status='done') AS done`, [userId],
)).rows[0];
async function waitFor(check: () => Promise<boolean> | boolean, label: string) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
try {
  // 初始化本身和失败审计都抛错，仍须释放运行锁，不允许脱离编排器的 rejection。
  const init = createJob('init-failure');
  const selectFailure = mock.method(db, 'select', () => { throw new Error('lookup failed'); });
  const insertFailure = mock.method(db, 'insert', () => { throw new Error('audit failed'); });
  try { await runGeneration(init, form, cfg, logger); }
  finally { selectFailure.mock.restore(); insertFailure.mock.restore(); }
  assert.equal(init.status, 'error');
  assert.equal(getRunningJobId(init.userId), null);
  assert.equal(init.events.at(-1)?.event.type, 'job_error');
  assert.ok(auditErrors.some((args) => JSON.stringify(args).includes('generation audit write failed')));
  console.log('PASS 初始化与审计双重失败发布 error 并解锁');

  const cancelledInit = createJob('init-cancel');
  const cancelLookup = mock.method(db, 'select', () => { cancelledInit.abort.abort(); throw new Error('cancelled lookup'); });
  try { await runGeneration(cancelledInit, form, cfg, logger); }
  finally { cancelLookup.mock.restore(); }
  assert.equal(cancelledInit.status, 'cancelled');
  assert.equal(getRunningJobId(cancelledInit.userId), null);
  console.log('PASS 初始化取消收口');

  await pool.query(`CREATE FUNCTION reject_success_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.user_id='rollback' AND NEW.status='done' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER generation_audit_failure BEFORE INSERT ON generations FOR EACH ROW EXECUTE FUNCTION reject_success_audit()`);
  const rollback = createJob('rollback');
  await runGeneration(rollback, form, cfg, logger);
  assert.equal(rollback.status, 'error');
  assert.deepEqual(await counts(rollback.userId), { trips: 0, done: 0 });
  assert.equal((await pool.query(`SELECT status FROM generations WHERE user_id=$1`, [rollback.userId])).rows[0]?.status, 'error');
  console.log('PASS 成功审计 SQL 失败时行程事务回滚');

  const success = createJob('success');
  await pool.query(`INSERT INTO canonical_places (id,city,name,category,verified,source,lat,lng,payload,created_at)
    VALUES ('advice-palace','北京','故宫博物院','文化',TRUE,'goldset',39.9163,116.3972,
      '{"reservation":"required","reservationNote":"需提前实名预约"}',NOW())`);
  await pool.query(`INSERT INTO research_evidence (id,place_id,city,kind,strength,content,source_url,fetched_at)
    VALUES ('advice-evidence','advice-palace','北京','xhs_warning','weak','有游客反馈院落之间步行较多','https://example.com/palace-evidence',NOW())`);
  await runGeneration(success, form, cfg, logger);
  assert.equal(success.status, 'done');
  assert.deepEqual(await counts(success.userId), { trips: 1, done: 1 });
  const saved = (await pool.query(`SELECT data FROM trips WHERE id=$1`, [success.tripId])).rows[0].data;
  assert.equal(saved.days.length, 3);
  const { personalAdviceIsCurrent, TripSchema } = await import('@tripweaver/shared');
  const { Value } = await import('@sinclair/typebox/value');
  assert.ok(Value.Check(TripSchema, saved));
  assert.ok(saved.meta.advice?.suggestions.length && saved.meta.advice?.cautions.length);
  assert.ok(personalAdviceIsCurrent(saved), '建议基于最终路线，保存新版本ID后仍有效');
  assert.ok(saved.meta.advice.suggestions.some((item: { sources: { url: string }[] }) =>
    item.sources.some(s => s.url === 'https://example.com/palace-evidence')), '真实SQL知识库证据通过模型工具引用后持久化');
  for (const day of saved.days) {
    assert.ok(day.activities.length <= 8);
    assert.ok(day.activities.some((a: { name: string }) => a.name.startsWith('午餐')));
    assert.ok(day.activities.some((a: { name: string }) => a.name.startsWith('晚餐')));
  }
  console.log('PASS 候选不足的美食行程完整生成并同时记账');
  await pool.query(`DELETE FROM research_evidence WHERE id='advice-evidence'`);
  await pool.query(`DELETE FROM canonical_places WHERE id='advice-palace'`);

  llm.setAdviceResponse('error');
  const adviceFallback = createJob('advice-fallback');
  try { await runGeneration(adviceFallback, form, cfg, logger); }
  finally { llm.setAdviceResponse('tool'); }
  assert.equal(adviceFallback.status, 'done');
  const fallbackSaved = (await pool.query(`SELECT data FROM trips WHERE id=$1`, [adviceFallback.tripId])).rows[0].data;
  assert.equal(fallbackSaved.meta.advice, undefined);
  assert.deepEqual(await counts(adviceFallback.userId), { trips: 1, done: 1 });
  console.log('PASS 专属建议模型失败仍交付行程，成功生成则持久化最终行程专属建议');

  const savedNotice = (await listNotifications(success.userId)).items[0]!;
  assert.equal(savedNotice.tripId, success.tripId);
  assert.equal(savedNotice.jobId, success.id);
  assert.equal(savedNotice.readAt, null);
  await recordGenerationNotification({ userId: success.userId, jobId: success.id, kind: 'success', tripId: success.tripId,
    destination: '北京', days: 3, title: '重复通知', message: '', jobCreatedAt: new Date(success.createdAt) });
  assert.equal((await listNotifications(success.userId)).items.length, 1);
  console.log('PASS 生成事务持久化正确通知，同一任务幂等去重');

  await pool.query(`CREATE FUNCTION reject_success_notification() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.user_id='notification-rollback' AND NEW.kind='success' THEN RAISE EXCEPTION 'injected notification failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER notification_failure BEFORE INSERT ON generation_notifications FOR EACH ROW EXECUTE FUNCTION reject_success_notification()`);
  const notificationRollback = createJob('notification-rollback');
  await runGeneration(notificationRollback, form, cfg, logger);
  assert.equal(notificationRollback.status, 'error');
  assert.deepEqual(await counts(notificationRollback.userId), { trips: 0, done: 0 });
  assert.equal((await listNotifications(notificationRollback.userId)).items[0]?.kind, 'error');
  console.log('PASS 成功通知落库失败整体回滚，不产生虚假成功消息或扣额');

  const revision = createJob('success', { kind: 'revision', targetTripId: success.tripId! });
  await runGeneration(revision, form, cfg, logger);
  assert.equal(revision.status, 'done');
  const lineage = (await pool.query(`SELECT root_id, version, parent_id FROM trips WHERE id=$1`, [revision.tripId])).rows[0];
  assert.deepEqual(lineage, { root_id: success.tripId, version: 2, parent_id: success.tripId });
  console.log('PASS 修订版本链在同一事务内保持正确');

  // 锁住 trips，让插入请求确定进入等待后才取消；实际数据库解除锁后插入须回滚。
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE trips IN ACCESS EXCLUSIVE MODE');
  const cancelSave = createJob('cancel-save');
  const pendingSave = runGeneration(cancelSave, form, cfg, logger);
  try {
    await waitFor(async () => Number((await admin.query(`SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query ILIKE '%trips%'`, [databaseName])).rows[0].count) > 0, 'save waiting for database lock');
    cancelSave.abort.abort();
  } finally {
    await blocker.query('ROLLBACK');
    await blocker.end();
    await pendingSave;
  }
  assert.equal(cancelSave.status, 'cancelled');
  assert.deepEqual(await counts(cancelSave.userId), { trips: 0, done: 0 });
  console.log('PASS 事务期间取消不残留行程或成功配额');

  // 真事务已 COMMIT、编排器尚未拿到返回值时收到取消：保存结果仍须宣告成功。
  const committed = createJob('cancel-after-commit');
  const transact = db.transaction.bind(db);
  const lateAbort = mock.method(db, 'transaction', async (...args: Parameters<typeof db.transaction>) => {
    const saved = await transact(...args);
    committed.abort.abort();
    return saved;
  });
  try { await runGeneration(committed, form, cfg, logger); }
  finally { lateAbort.mock.restore(); }
  assert.equal(committed.status, 'done');
  assert.deepEqual(await counts(committed.userId), { trips: 1, done: 1 });
  assert.equal(committed.events.at(-1)?.event.type, 'job_done');
  console.log('PASS COMMIT 后取消不改判已提交结果');

  // 真实 SQL 加载必须保留缺失语义，不能只测手工构造的 score 参数。
  await pool.query(`INSERT INTO canonical_places (id,name,city,category,lat,lng,source,verified,payload,created_at)
    VALUES ('unknown','金集地标','测试城','文化',39.9,116.4,'goldset',true,'{}',NOW()),
           ('known','社区点','测试城','文化',39.91,116.41,'xhs',true,'{"recommendScore":80,"mentionCount":10}',NOW())`);
  const facts = await loadPlaceFacts(['金集地标', '社区点'], '测试城');
  assert.equal(facts.size, 2);
  assert.equal(facts.get('金集地标')!.recommendScore, undefined);
  assert.equal(poiScore(facts.get('金集地标'), scoreMaxima([...facts.values()])), 65);
  console.log('PASS 数据库缺失评分经加载、合并、评分后仍为中性值');

  const denseDraft = new DraftTrip({ ...form, days: 1 });
  const names = Array.from({ length: 8 }, (_, i) => `街区${i}`);
  applyDeterministicSchedule({ draft: denseDraft, form: { ...form, days: 1 }, foodFocused: true,
    pool: names.map((name) => ({ id: name, name, category: 'attraction', intro: '', reservation: 'unknown', sourceLinks: [] })),
    locations: new Map(names.map((name, i) => [name, { lat: 39.9, lng: 116.4 + i * .001, adcode: '' }])),
    facts: new Map(names.map((name) => [name, { name, source: 'xhs', category: '购物', themes: [], aliases: [], placeType: 'street' }])),
    longHaul: [], relations: new Map(),
  });
  assert.deepEqual(denseDraft.validate(), []);
  assert.equal(denseDraft.mutableDays()[0]!.activities.length, 8);
  console.log('PASS 紧凑美食排程写入真实草稿满足 8 活动上限');

  const suburbForm = { ...form, days: 1 };
  const suburbDraft = new DraftTrip(suburbForm);
  applyDeterministicSchedule({ draft: suburbDraft, form: suburbForm, foodFocused: true,
    pool: [{ id: 'wall', name: '八达岭长城', category: 'attraction', intro: '长城游览', reservation: 'unknown', sourceLinks: [] }],
    locations: new Map([['八达岭长城', { lat: 40.36, lng: 116.01, adcode: '' }]]),
    longHaul: [], facts: new Map(), relations: new Map(),
  });
  const suburbMeals = suburbDraft.mutableDays()[0]!.activities.filter((a) => a.category === '美食');
  assert.equal(suburbMeals.length, 2);
  for (const meal of suburbMeals) {
    assert.match(meal.name, /八达岭长城周边/);
    assert.equal(meal.placeName, '八达岭长城');
    assert.equal(meal.lat, 40.36);
    assert.equal(meal.lng, 116.01);
    assert.equal(meal.poiId, undefined);
    assert.equal(meal.startTime, '');
    assert.match(meal.description, /片区锚点/);
  }
  console.log('PASS 远郊餐次保留景点周边参考点，不重定位市中心或冒充门店');

  await pool.query(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('success','success@verify.test','',NOW())`);
  const auth = `tw_session=${(await createSession('success')).token}`;
  await app.register(cookie);
  await app.register(generationRoutes, { prefix: '/api/generations' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.listen({ host: '127.0.0.1', port: 18809 });
  const notificationRequest = (url: string, method: 'GET' | 'POST' = 'GET', payload?: object) => app.inject({ method, url, headers: { cookie: auth }, ...(payload ? { payload } : {}) });
  assert.equal((await app.inject({ method: 'GET', url: '/api/notifications' })).statusCode, 401);
  const beforeRead = (await notificationRequest('/api/notifications')).json().data;
  assert.equal(beforeRead.hasUnread, true);
  const cursor = beforeRead.readThrough;
  await recordGenerationNotification({ userId: 'success', jobId: 'persisted-only', kind: 'success', tripId: success.tripId,
    destination: '北京', days: 3, title: '新通知', message: '', jobCreatedAt: new Date() });
  await notificationRequest('/api/notifications/read-all', 'POST', { through: cursor });
  const afterRead = (await notificationRequest('/api/notifications')).json().data;
  assert.equal(afterRead.hasUnread, true);
  assert.equal(afterRead.items.filter((item: { readAt: number | null }) => item.readAt === null).length, 1);
  const fresh = afterRead.items.find((item: { jobId: string }) => item.jobId === 'persisted-only');
  await notificationRequest(`/api/notifications/${fresh.id}/read`, 'POST');
  assert.equal((await notificationRequest('/api/notifications')).json().data.hasUnread, false);
  const other = (await listNotifications(notificationRollback.userId)).items[0]!;
  assert.equal((await notificationRequest(`/api/notifications/${other.id}/read`, 'POST')).statusCode, 404);
  assert.equal((await listNotifications(notificationRollback.userId)).items[0]?.readAt, null);
  assert.equal((await notificationRequest('/api/notifications?before=-1')).statusCode, 400);
  const firstPage = (await notificationRequest('/api/notifications?limit=1')).json().data;
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const nextPage = (await notificationRequest(`/api/notifications?limit=1&before=${firstPage.nextCursor}`)).json().data;
  assert.notEqual(firstPage.items[0].id, nextPage.items[0].id);
  const persistedSnapshot = (await notificationRequest('/api/generations/persisted-only')).json().data;
  assert.equal(persistedSnapshot.status, 'done');
  assert.equal(persistedSnapshot.tripId, success.tripId);
  assert.equal((await notificationRequest(`/api/generations/${other.jobId}`)).statusCode, 404);
  const discoverable = createJob('success');
  assert.equal((await notificationRequest('/api/generations/current')).json().data.jobId, discoverable.id);
  cancelJob(discoverable);
  assert.equal((await notificationRequest('/api/generations/current')).json().data, null);
  console.log('PASS 通知鉴权、分页、未读持久化与已读边界，内存任务过期后恢复结果，按账号发现任务');
  const sse = async (id: string, after = 0) => {
    const response = await fetch(`http://127.0.0.1:18809/api/generations/${id}/events?lastEventId=${after}`, {
      headers: { cookie: auth }, signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    return response.text();
  };
  // 真实生成闭館无解不能写占位成功；同一错误经实际 HTTP SSE 到 EOF，且不消耗成功配额。
  await pool.query(`INSERT INTO canonical_places (id,name,city,category,lat,lng,source,verified,payload,created_at)
    VALUES ('closed-palace','故宫博物院','北京','文化',39.918,116.397,'xhs',true,
    '{"openHours":{"closedWeekdays":[1]},"content":{"intro":"历史建筑。"}}',NOW())`);
  const beforeClosed = await counts('success');
  const closedJob = createJob('success');
  await runGeneration(closedJob, { ...form, days: 1, startDate: '2026-10-19' }, cfg, logger);
  assert.equal(closedJob.status, 'error');
  assert.deepEqual(await counts('success'), beforeClosed);
  assert.equal(getRunningJobId('success'), null);
  const closedSse = await sse(closedJob.id);
  assert.match(closedSse, /job_error/);
  assert.match(closedSse, /闭馆/);
  assert.match(closedSse, /调整出发日期/);
  assert.doesNotMatch(closedSse, /job_done/);
  assert.equal(closedJob.events.filter((e) => e.event.type === 'job_error').length, 1);
  assert.equal(closedJob.listeners.size, 0);
  await pool.query(`DELETE FROM canonical_places WHERE id='closed-palace'`);
  console.log('PASS 闭馆无解明确失败、无落库或成功配额，SSE 只终止一次');

  await pool.query(`INSERT INTO canonical_places (id,name,city,category,lat,lng,source,verified,payload,created_at)
    VALUES ('hours-unknown','待审街区','营业测试城','美食',30.67,104.06,'xhs',true,
      '{"openHours":{"version":2,"subject":"待审街区","scope":"place","status":"unknown","closedWeekdays":[],"review":[{"sentence":"其他博物馆周一闭馆"}]}}',NOW()),
      ('hours-valid','明确博物馆','营业测试城','文化',30.68,104.06,'xhs',true,
      '{"openHours":{"version":2,"subject":"明确博物馆","scope":"place","status":"attributed","closedWeekdays":[1]}}',NOW())`);
  await pool.query(`INSERT INTO research_evidence (id,place_id,city,kind,strength,content,source_url,fetched_at)
    VALUES ('hours-legacy','hours-unknown','营业测试城','xhs_reason','strong','其他博物馆周一闭馆','https://example.org',NOW())`);
  const hoursFacts = await loadPlaceFacts(['待审街区', '明确博物馆'], '营业测试城');
  assert.equal(hoursFacts.get('待审街区')!.openTime, undefined);
  assert.equal(hoursFacts.get('待审街区')!.closureText, undefined, '不能从旧 evidence 再次引入已拒绝规则');
  assert.equal(hoursFacts.get('明确博物馆')!.openTime, '周一闭馆');
  console.log('PASS 营业归属待审不经旧证据回流，明确博物馆闭馆仍保留');
  const replay = await sse(success.id);
  assert.match(replay, /job_done/);
  assert.equal(success.listeners.size, 0);
  assert.doesNotMatch(await sse(success.id, success.nextEventId - 1), /data:/);
  const cancelled = createJob('success'); cancelJob(cancelled);
  assert.match(await sse(cancelled.id), /job_cancelled/);
  const live = createJob('success');
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:18809/api/generations/${live.id}/events`, { headers: { cookie: auth }, signal: controller.signal });
  assert.equal(live.listeners.size, 1);
  controller.abort();
  await response.body?.cancel().catch(() => {});
  await waitFor(() => live.listeners.size === 0, 'SSE unsubscribe on disconnect');
  completeJob(live, 'terminal', [], []);
  assert.deepEqual(appErrors, []);
  console.log('PASS 终态全量/增量 SSE 重放正常结束，断连清理订阅，无路由异常');
  console.log('PASS 主流程故障验收全部通过');
} finally {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  await app.close();
  llm.close();
  await pool.end();
  // 名称由当前脚本生成，且仅连接专用本地测试实例。
  assert.match(databaseName, /^generation_flow_verify_\d+$/);
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
}
