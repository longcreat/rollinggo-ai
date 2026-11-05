import { readApiResponse } from './lib/api-contract.mjs';
// C2 端到端验收（离线可复跑）：mock OpenAI 兼容端点驱动三 Agent 流水线
// 覆盖：SSE 三阶段与 job_done 落库 / candidate 候选池事件 / 预约种子表覆盖 / Last-Event-ID 重放 /
//       配额 429 / 取消不计数不残留 / BYOK 走自有端点且计次 / 第二轮只局部修订并保留活动 ID
// 用法：node scripts/verify-c2.mjs
// 数据库：09-18 起运行态为 PostgreSQL。本脚本独占一个专用测试库（默认 tripweaver_verify_c2，
// 可用 VERIFY_C2_DATABASE_URL 覆盖），每次运行先 drop/create 保证干净，结束时 drop 清理。
import { startMockLlm } from './lib/mock-llm.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

const MOCK_PORT = 18788;
const API_PORT = 18791;
const API = `http://127.0.0.1:${API_PORT}`;
const DATABASE_URL =
  process.env.VERIFY_C2_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/tripweaver_verify_c2';
const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Client } = requireFromServer('pg');

const failures = [];
function check(name, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures.push(name);
}

// ---------- 测试库管理 ----------

/** 解析出库名，并返回连到 postgres 维护库的连接串（drop/create 需在库外执行） */
function adminUrlAndDbName(url) {
  const u = new URL(url);
  const dbName = u.pathname.replace(/^\//, '');
  if (!dbName || dbName === 'postgres') throw new Error('VERIFY_C2_DATABASE_URL 必须指向专用测试库，禁止 postgres');
  u.pathname = '/postgres';
  return { adminUrl: u.toString(), dbName };
}

async function dropDatabase(adminClient, dbName) {
  // PG 13+ 支持 WITH (FORCE)，自动断开存量连接
  await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
}

async function recreateTestDatabase() {
  const { adminUrl, dbName } = adminUrlAndDbName(DATABASE_URL);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await dropDatabase(admin, dbName);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

// ---------- HTTP 小工具 ----------

let cookie = '';
async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie,
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const json = await readApiResponse(res);
  return { status: res.status, json };
}

/** 读 SSE 直到终态事件或超时；返回 {events, lastId} */
async function readEvents(jobId, { lastEventId = 0, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  let lastId = lastEventId;
  try {
    const res = await fetch(`${API}/api/generations/${jobId}/events?lastEventId=${lastEventId}`, {
      headers: { cookie },
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const idLine = frame.split('\n').find((l) => l.startsWith('id: '));
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        if (idLine) lastId = Number(idLine.slice(4));
        const ev = JSON.parse(dataLine.slice(6));
        events.push(ev);
        if (['job_done', 'job_error', 'job_cancelled'].includes(ev.type)) break outer;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return { events, lastId };
}

// ---------- 主流程 ----------

let server;
// 模拟存量库：旧 trips / generations 表缺少当前列，启动迁移必须自动补齐。
// 每次运行先重建测试库（drop + create），避免上一轮残留影响幂等迁移断言。
await recreateTestDatabase();
const legacyClient = new Client({ connectionString: DATABASE_URL });
await legacyClient.connect();
try {
  await legacyClient.query(`CREATE TABLE trips (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    destination TEXT NOT NULL,
    days_count INTEGER NOT NULL,
    activity_count INTEGER NOT NULL,
    total_cost INTEGER NOT NULL,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`);
  await legacyClient.query(`CREATE TABLE generations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trip_id TEXT,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`);
  // 存量行：用于验证 trips.root_id 的「补列 → 回填 → SET NOT NULL」链路
  // （空表时 SET NOT NULL 不会失败，盖不住真实升级路径，所以必须插一行）
  await legacyClient.query(
    `INSERT INTO trips (id, user_id, title, destination, days_count, activity_count, total_cost, data, created_at, updated_at)
     VALUES ('legacy-trip-1', 'legacy-user', '存量行程', '北京', 1, 1, 0, '{}'::jsonb, NOW(), NOW())`,
  );
} finally {
  await legacyClient.end();
}

// 首个完成任务让审校模型持续 get_draft 直到超过 12 轮，验证审校耗尽只降级、不拖垮整次生成。
const mock = await startMockLlm(MOCK_PORT, { delayMs: 300, reviewerOverrunOnce: true, requestRevisionOnce: true });
const seenAuthHeaders = mock.seenAuthHeaders;
console.log(`[mock] OpenAI 兼容端点就绪 :${MOCK_PORT}`);
try {
  server = spawn(process.execPath, ['../../node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
    cwd: 'apps/server',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      // 隔离真实 .env：PG 连接由 DATABASE_URL 显式指定，不再依赖 sqlite 文件路径
      DOTENV_CONFIG_PATH: `./data/verify-c2-${Date.now()}.absent.env`,
      PORT: String(API_PORT),
      DATABASE_URL,
      MASTER_KEY: crypto.randomBytes(32).toString('hex'),
      REGISTRATION_MODE: 'invite',
      INVITE_CODE: 'C2TEST',
      CHAT_DAILY_LIMIT: '7',
      GITHUB_CLIENT_ID: '',
      GITHUB_CLIENT_SECRET: '',
      APP_BASE_URL: '',
      SITE_LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      SITE_LLM_API_KEY: 'site-mock-key',
      SITE_LLM_MODEL: 'mock-chat',
      GEN_DAILY_LIMIT: '2',
      AMAP_KEY: '',
      SEARCH_API_KEY: '',
      SSRF_ALLOWLIST: `127.0.0.1:${MOCK_PORT}`,
      // Keep this verification offline and deterministic: localhost reaches the mock LLM,
      // while optional public geocoding fails fast into its documented null fallback.
      HTTP_PROXY: 'http://127.0.0.1:1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: 'localhost,127.0.0.1',
    },
  });
  // Pino 默认写 stdout（不是 stderr），两侧都要接：VERBOSE 下才输出，否则测试静默
  server.stdout.on('data', (d) => process.env.VERBOSE && console.error(String(d)));
  server.stderr.on('data', (d) => process.env.VERBOSE && console.error(String(d)));

  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${API}/api/health`);
      if (r.ok) break;
    } catch {}
    await sleep(500);
    if (i === 119) throw new Error('服务端启动超时');
  }
  console.log('[api] 服务端就绪');

  // 用户 1：站点 Key 路径
  const email = `u${Date.now()}@test.dev`;
  const reg = await api('POST', '/api/auth/register', { email, password: 'password123', inviteCode: 'C2TEST' });
  check('注册成功', reg.status === 200 || reg.status === 201, `status=${reg.status}`);

  // ① 取消：不残留、不计数
  console.log('\n— 取消路径 —');
  const jobA = await api('POST', '/api/generations', { destination: '东京', days: 2, budgetLevel: '经济', partySize: 1 });
  check('建任务 A 202', jobA.status === 202, JSON.stringify(jobA.json));
  const cancelRes = await api('POST', `/api/generations/${jobA.json.jobId}/cancel`);
  check('取消 202', cancelRes.status === 202);
  const cancelled = await readEvents(jobA.json.jobId);
  check('收到 job_cancelled', cancelled.events.at(-1)?.type === 'job_cancelled', cancelled.events.at(-1)?.type);
  check('取消事件携带 reason=user', cancelled.events.at(-1)?.reason === 'user', String(cancelled.events.at(-1)?.reason));
  const cancelledSnapshot = await api('GET', `/api/generations/${jobA.json.jobId}`);
  check('取消快照收敛到 cancelled', cancelledSnapshot.json?.status === 'cancelled', cancelledSnapshot.json?.status);
  const usageAfterCancel = await api('GET', '/api/usage');
  check('取消不计配额', usageAfterCancel.json?.usedToday === 0, `usedToday=${usageAfterCancel.json?.usedToday}`);

  // ② 完整流水线：三阶段 + job_done 落库
  console.log('\n— 完整流水线（站点 Key）—');
  const jobB = await api('POST', '/api/generations', { destination: '东京', days: 2, budgetLevel: '经济', partySize: 1 });
  check('取消后可立即新建（无残留）', jobB.status === 202, `status=${jobB.status}`);
  const run = await readEvents(jobB.json.jobId);
  const types = run.events.map((e) => e.type);
  const phases = run.events.filter((e) => e.type === 'phase_start').map((e) => e.phase);
  check('三阶段齐全', ['research', 'plan', 'review'].every((p) => phases.includes(p)), phases.join(','));
  check('有工具时间线', types.includes('tool_start') && types.includes('tool_end'));
  check('有用量事件', types.includes('usage'));
  const done = run.events.at(-1);
  check('job_done 收尾', done?.type === 'job_done', done?.type);
  check('降级标注 usedXhs=false', done?.usedXhs === false);
  check('job_done 数据源为空（未配 Key）', Array.isArray(done?.dataSources) && done.dataSources.length === 0, JSON.stringify(done?.dataSources));
  check('审校建议传递', Array.isArray(done?.reviewNotes) && done.reviewNotes.length > 0, JSON.stringify(done?.reviewNotes));
  check(
    '文案阶段未触发结构修订轮',
    run.events.filter((event) => event.type === 'phase_start' && event.phase === 'plan').length === 1,
  );
  const reviewPhaseEnd = run.events.find((event) => event.type === 'phase_end' && event.phase === 'review');
  check('review 阶段已降为文案阶段', reviewPhaseEnd?.summary?.includes('文案') === true, reviewPhaseEnd?.summary);

  // 时序前移（M0-A）仍成立：geoPipeline 紧随确定性排程，可行性与修复器拿到的是真实坐标/leg。
  // 09-25 起文案与该解析并发，不再要求「解析早于 review」——文案不需要坐标/leg。
  const firstReviewIdx = run.events.findIndex((e) => e.type === 'phase_start' && e.phase === 'review');
  const geoResolveIdx = run.events.findIndex((e) => e.type === 'thought' && /解析坐标与通勤|解析活动坐标/.test(e.text ?? ''));
  const scheduleIdx = run.events.findIndex((e) => e.type === 'tool_start' && e.tool === 'schedule_itinerary');
  check(
    '坐标/通勤解析紧随排程（时序前移）',
    scheduleIdx >= 0 && geoResolveIdx > scheduleIdx,
    `scheduleIdx=${scheduleIdx} geoIdx=${geoResolveIdx}`,
  );
  const reviewEndIdx = run.events.findIndex((e) => e.type === 'phase_end' && e.phase === 'review');
  check(
    '文案与地理解析并发（文案先启动，在地理之后收尾）',
    firstReviewIdx >= 0 && firstReviewIdx < geoResolveIdx && reviewEndIdx > geoResolveIdx,
    `review=${firstReviewIdx} geo=${geoResolveIdx} reviewEnd=${reviewEndIdx}`,
  );
  check(
    '解析发生在编排阶段（thought 归属 plan）',
    run.events[geoResolveIdx]?.phase === 'plan',
    run.events[geoResolveIdx]?.phase,
  );

  // 候选池 SSE 事件：mock 调 4 次 add_candidate（1 次同名去重）→ 3 条 candidate
  const candidates = run.events.filter((e) => e.type === 'candidate');
  check('candidate 事件 3 条（同名去重）', candidates.length === 3, `count=${candidates.length}`);
  const gugong = candidates.find((e) => e.poi?.name === '故宫博物院');
  check('预约种子表强制覆盖 required', gugong?.poi?.reservation === 'required', gugong?.poi?.reservation);
  check('种子来源链接注入', gugong?.poi?.sourceLinks?.[0]?.url?.includes('dpm.org.cn') === true, JSON.stringify(gugong?.poi?.sourceLinks));
  check('candidate 三类齐全', ['attraction', 'food', 'hotel'].every((c) => candidates.some((e) => e.poi?.category === c)));

  const trip = await api('GET', `/api/trips/${done.tripId}`);
  // R3（09-25）：东京不在 canonical_places → 未覆盖 → 调研 prompt 的 search_web 上限放宽为 6
  const tokyoResearch = mock.seenResearchPrompts.find((p) => p.destination === '东京');
  check('未覆盖城市 search_web 上限放宽为 6', tokyoResearch?.searchWebMaxLine === '全阶段最多 6 次', String(tokyoResearch?.searchWebMaxLine));
  check('行程已落库', trip.status === 200 && trip.json?.days?.length === 2, `days=${trip.json?.days?.length}`);
  check('活动已填充', trip.json?.days?.every((d) => d.activities.length >= 1));
  check('overview 随行程持久化', Array.isArray(trip.json?.overview) && trip.json.overview.length === 3, `overview=${trip.json?.overview?.length}`);
  check('overview 预约徽章数据正确', trip.json?.overview?.find((p) => p.name === '故宫博物院')?.reservation === 'required');
  check('meta.dataSources 未配 Key 时不写入', trip.json?.meta?.dataSources === undefined, JSON.stringify(trip.json?.meta));
  // ST3：transportMode 缺省 transit 持久化；住宿区域由代码推导（用户未填时取知识库住宿候选）。
  // 坐标解析走高德→Nominatim 降级链：本脚本无高德 Key，Nominatim 视网络可用性可能成功——
  // 两种结果都合法，按「有坐标 ⇔ 有住宿哨兵 leg」的一致性断言（哨兵契约见 TransitLegSchema）。
  check('transportMode 缺省 transit 持久化', trip.json?.transportMode === 'transit', trip.json?.transportMode);
  check('住宿不由生成产出（未指定时留空，不推具体商家）', trip.json?.lodging === undefined, JSON.stringify(trip.json?.lodging));
  const lodgingHasCoord = typeof trip.json?.lodging?.lat === 'number' && typeof trip.json?.lodging?.lng === 'number';
  const sentinelConsistent = trip.json?.days?.every((d) => {
    const legs = d.legs ?? [];
    const dep = legs.some((l) => l.fromActivityId === 'lodging' && l.toActivityId === d.activities[0]?.id);
    const ret = legs.some((l) => l.toActivityId === 'lodging' && l.fromActivityId === d.activities.at(-1)?.id);
    return lodgingHasCoord ? dep && ret : !legs.some((l) => l.fromActivityId === 'lodging' || l.toActivityId === 'lodging');
  });
  check(
    `住宿哨兵 leg 与坐标解析结果一致（本次${lodgingHasCoord ? '解析成功→首尾住宿 leg' : '解析失败→无住宿 leg，不报错'}）`,
    sentinelConsistent === true,
  );

  // Last-Event-ID 重放（终态任务在 TTL 内可全量重放）
  const replay = await readEvents(jobB.json.jobId, { lastEventId: 0 });
  check('SSE 全量重放', replay.events.at(-1)?.type === 'job_done', `events=${replay.events.length}`);
  const partial = await readEvents(jobB.json.jobId, { lastEventId: run.lastId - 1 });
  check('Last-Event-ID 增量重放', partial.events.length === 1 && partial.events[0].type === 'job_done', `events=${partial.events.length}`);

  // 快照端点
  const snap = await api('GET', `/api/generations/${jobB.json.jobId}`);
  check('快照 done+tripId', snap.json?.status === 'done' && snap.json?.tripId === done.tripId);

  // ③ 配额用尽 → 429 + resetAt（GEN_DAILY_LIMIT=2：第 2 次仍可用，第 3 次才拦）
  console.log('\n— 配额路径 —');
  const usage = await api('GET', '/api/usage');
  check('usedToday=1', usage.json?.usedToday === 1, `usedToday=${usage.json?.usedToday}`);
  const jobC = await api('POST', '/api/generations', { destination: '东京', days: 2, budgetLevel: '经济', partySize: 1 });
  check('第 2 次仍在额度内 202', jobC.status === 202, `status=${jobC.status}`);
  const runC = await readEvents(jobC.json?.jobId);
  check('第 2 次生成完成', runC.events.at(-1)?.type === 'job_done', runC.events.at(-1)?.type);
  const jobC2 = await api('POST', '/api/generations', { destination: '东京', days: 2, budgetLevel: '经济', partySize: 1 });
  check('配额尽 429', jobC2.status === 429, `status=${jobC2.status}`);
  check('429 带 resetAt', typeof jobC2.json?.data?.resetAt === 'number');

  // ④ BYOK：走自有端点 + 计次
  console.log('\n— BYOK 路径 —');
  cookie = '';
  const email2 = `b${Date.now()}@test.dev`;
  await api('POST', '/api/auth/register', { email: email2, password: 'password123', inviteCode: 'C2TEST' });
  const put = await api('PUT', '/api/settings', {
    byokEnabled: true,
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiKey: 'byok-secret-key',
    model: 'mock-chat',
  });
  check('BYOK 设置保存（SSRF 白名单放行）', put.status === 200, JSON.stringify(put.json));
  const authCountBefore = seenAuthHeaders.length;
  const jobD = await api('POST', '/api/generations', { destination: '大阪', days: 2, budgetLevel: '舒适', partySize: 2 });
  check('BYOK 建任务 202', jobD.status === 202);
  const runD = await readEvents(jobD.json.jobId);
  check('BYOK job_done', runD.events.at(-1)?.type === 'job_done', runD.events.at(-1)?.type);
  const planRounds = runD.events.filter((event) => event.type === 'phase_start' && event.phase === 'plan').map((event) => event.round);
  check('确定性排程只跑一轮（无修订轮）', planRounds.join(',') === '1', planRounds.join(','));
  const structureTools = ['set_trip_skeleton', 'add_activity', 'update_activity', 'move_activity', 'remove_activity', 'check_feasibility', 'submit_plan'];
  const structureCalls = runD.events.filter((event) => event.type === 'tool_start' && structureTools.includes(event.tool)).map((event) => event.tool);
  check('排程阶段零 LLM 规划工具（结构由代码决定）', structureCalls.length === 0, structureCalls.join(','));
  const writer = mock.seenWriter;
  const writerRequests = run.events.filter((event) => event.type === 'llm_request' && event.phase === 'review');
  check('常规标题仅一次模型请求', writerRequests.length === 1, String(writerRequests.length));
  check(
    '文案阶段拿到行程且一次 update_titles 即收口',
    Boolean(writer?.hasDraft)
      && JSON.stringify(writer?.tools ?? []) === JSON.stringify(['update_titles']),
    JSON.stringify(writer?.tools),
  );
  const revisedTrip = await api('GET', `/api/trips/${runD.events.at(-1)?.tripId}`);
  const revisedActivities = revisedTrip.json?.days?.flatMap((day) => day.activities) ?? [];
  check('行程标题已由文案阶段写入', revisedTrip.json?.title === '测试行程标题', revisedTrip.json?.title);
  check(
    '每天标题已由文案阶段写入',
    (revisedTrip.json?.days ?? []).every((day) => day.title === `第${day.dayIndex}天主题`),
    JSON.stringify((revisedTrip.json?.days ?? []).map((day) => day.title)),
  );
  check(
    '活动说明来自候选 intro（模型不再二次编写）',
    revisedActivities.length > 0 && revisedActivities.every((activity) => activity.description.length > 0),
    JSON.stringify(revisedActivities.map((activity) => activity.description.slice(0, 14))),
  );
  check('排程保证每天至少一个活动', (revisedTrip.json?.days ?? []).every((day) => day.activities.length >= 1));
  check(
    '行程不产出时间轴（时间留空，前端按未排时刻展示）',
    revisedActivities.every((activity) => activity.startTime === '' && activity.endTime === ''),
    JSON.stringify(revisedActivities.map((activity) => `${activity.startTime}-${activity.endTime}`)),
  );
  check('生成内部定位引用未泄漏到持久化 Trip', revisedActivities.length > 0 && revisedActivities.every((activity) => !('placeName' in activity) && !('poiId' in activity)));
  const byokAuths = seenAuthHeaders.slice(authCountBefore);
  check('BYOK 请求带自己的 Key', byokAuths.length > 0 && byokAuths.every((a) => a.includes('byok-secret-key')), byokAuths[0]);
  const usage2 = await api('GET', '/api/usage');
  check('BYOK 计入次数配额', usage2.json?.usedToday === 1, `usedToday=${usage2.json?.usedToday}`);

  // ⑤ 问答式入口：对话不消耗生成配额；Brief 齐备才谈生成；一切读写都带 userId 谓词
  console.log('\n— 问答式入口 —');
  // 越权验证要换一个用户，但 /register 限制 3 次/分钟（本脚本已用满），
  // 因此复用 ④ 的 BYOK 用户会话而不是再注一个。
  const cookieOtherUser = cookie;
  cookie = '';
  const email3 = `c${Date.now()}@test.dev`;
  await api('POST', '/api/auth/register', { email: email3, password: 'password123', inviteCode: 'C2TEST' });

  const created = await api('POST', '/api/conversations', {});
  check('新建会话 201', created.status === 201, `status=${created.status}`);
  const conversationId = created.json?.id;
  check(
    '新会话 Brief 为空且缺 4 项必填',
    created.json?.brief?.status === 'collecting' && created.json?.brief?.missingFields?.length === 4,
    JSON.stringify(created.json?.brief?.missingFields),
  );

  const turn1 = await api('POST', `/api/conversations/${conversationId}/messages`, { text: '11月去成都玩3天，带2岁小孩，先不定日期' });
  check('发消息 200', turn1.status === 200, JSON.stringify(turn1.json));
  // R2（09-25）：测试库 canonical_places 为空 → 成都未覆盖 → 回复尾部拼降级提示
  check('未覆盖城市回复带降级提示', turn1.json?.replyMessage?.content?.includes('攻略数据我掌握得比较少') === true, turn1.json?.replyMessage?.content);
  check('意图=update_brief', turn1.json?.intent === 'update_brief', turn1.json?.intent);
  check(
    '抽取目的地/天数/节奏',
    turn1.json?.brief?.data?.destination === '成都'
      && turn1.json?.brief?.data?.days === 3
      && turn1.json?.brief?.data?.pace === 'moderate',
    JSON.stringify(turn1.json?.brief?.data),
  );
  check(
    '约束落地且带来源消息序号（可追溯）',
    turn1.json?.brief?.data?.constraints?.[0]?.valueText === '带 2 岁小孩'
      && turn1.json?.brief?.data?.constraints?.[0]?.polarity === 'fact'
      && turn1.json?.brief?.data?.constraints?.[0]?.evidenceSequence === 1,
    JSON.stringify(turn1.json?.brief?.data?.constraints),
  );
  check('仅缺出发日期', JSON.stringify(turn1.json?.brief?.missingFields) === JSON.stringify(['startDate']), JSON.stringify(turn1.json?.brief?.missingFields));
  check(
    '缺字段时给可点选控件而非纯文本要求',
    turn1.json?.replyMessage?.intake?.inputSchema?.format === 'date-range',
    JSON.stringify(turn1.json?.replyMessage?.intake),
  );
  const afterFirst = await api('GET', `/api/conversations/${conversationId}`);
  check('首条用户消息成为会话标题', afterFirst.json?.conversation?.title?.startsWith('11月去成都玩3天') === true, afterFirst.json?.conversation?.title);

  const turn2 = await api('POST', `/api/conversations/${conversationId}/messages`, { text: '11月5号出发' });
  check('第二轮意图=confirm', turn2.json?.intent === 'confirm', turn2.json?.intent);
  check('必填齐备 → ready 且无缺字段', turn2.json?.brief?.status === 'ready' && turn2.json?.brief?.missingFields?.length === 0, JSON.stringify(turn2.json?.brief));
  check('齐备后不再追问', turn2.json?.replyMessage?.intake === undefined, JSON.stringify(turn2.json?.replyMessage?.intake));

  // R3（09-24）：confirm + Brief 齐备 → 服务端自动触发生成，无需用户再点「开始生成」
  const autoJobId = turn2.json?.autoStartedJobId;
  check('confirm 自动触发生成', typeof autoJobId === 'string', JSON.stringify(turn2.json?.autoStartedJobId));
  const autoRun = await readEvents(autoJobId);
  check('自动触发的生成完成', autoRun.events.at(-1)?.type === 'job_done', autoRun.events.at(-1)?.type);
  const autoTripId = autoRun.events.at(-1)?.tripId;
  const autoTrip = await api('GET', `/api/trips/${autoTripId}`);
  check('自动触发的行程已落库', autoTrip.status === 200 && autoTrip.json?.days?.length === 3, `status=${autoTrip.status}`);

  const patch = await api('PATCH', `/api/conversations/${conversationId}/brief`, { destination: '重庆' });
  check('确认卡编辑 200', patch.status === 200, JSON.stringify(patch.json));
  check('编辑落成人话的用户消息', patch.json?.userMessage?.content?.includes('目的地改为「重庆」') === true, patch.json?.userMessage?.content);
  check('编辑立即回写 Brief', patch.json?.brief?.data?.destination === '重庆', patch.json?.brief?.data?.destination);
  check('编辑追加 AI 确认回复', patch.json?.replyMessage?.content?.includes('已更新') === true, patch.json?.replyMessage?.content);

  const detailAfter = await api('GET', `/api/conversations/${conversationId}`);
  check('消息成对落库（3 轮 = 6 条）', detailAfter.json?.messages?.length === 6, `messages=${detailAfter.json?.messages?.length}`);
  check(
    '消息序号连续（刷新恢复的排序基础）',
    JSON.stringify(detailAfter.json?.messages?.map((m) => m.sequence)) === JSON.stringify([1, 2, 3, 4, 5, 6]),
    JSON.stringify(detailAfter.json?.messages?.map((m) => m.sequence)),
  );
  check('刷新后 Brief 可恢复', detailAfter.json?.conversation?.brief?.data?.destination === '重庆');

  const chatList = await api('GET', '/api/conversations');
  check('会话列表包含自身会话', chatList.json?.conversations?.length === 1, `count=${chatList.json?.conversations?.length}`);
  check('对话额度独立计数（3 轮）', chatList.json?.chatUsage?.usedToday === 3, `usedToday=${chatList.json?.chatUsage?.usedToday}`);
  check('自动生成计入生成配额（1 次）', (await api('GET', '/api/usage')).json?.usedToday === 1, '自动触发的生成应计 1 次');

  // 5.w 缺条件时给可点选项（PR6 修正）：模型下发 clarification.options → 前端渲染按钮，而不是让用户手打
  const askConv = await api('POST', '/api/conversations', {});
  const askTurn = await api('POST', `/api/conversations/${askConv.json?.id}/messages`, { text: '想去玩几天但不知道去哪' });
  const askIntake = askTurn.json?.replyMessage?.intake;
  check(
    '模型选项原样下发为可点按钮',
    JSON.stringify(askIntake?.inputSchema?.enum) === JSON.stringify(['成都', '重庆', '西安']),
    JSON.stringify(askIntake),
  );
  check('选项标记为自然语言（点击走消息而非 PATCH）', askIntake?.inputSchema?.enumKind === 'natural', String(askIntake?.inputSchema?.enumKind));
  check('模型问题文案直接用于卡片', askIntake?.question === '这次想去哪里？', String(askIntake?.question));
  check('缺字段清单包含目的地', askIntake?.missingFields?.includes('destination') === true, JSON.stringify(askIntake?.missingFields));

  const answerTurn = await api('POST', `/api/conversations/${askConv.json?.id}/messages`, { text: '成都吧' });
  check('点选后目的地落入 Brief', answerTurn.json?.brief?.data?.destination === '成都', JSON.stringify(answerTurn.json?.brief?.data));
  check('补齐后无缺字段', answerTurn.json?.brief?.missingFields?.length === 0, JSON.stringify(answerTurn.json?.brief?.missingFields));

  // 5.x 按需修订（09-24 R1）：对话里直接给编辑操作 → 服务端确定性应用 → 落版本链下一版。
  // 不再是「重跑一次生成」：不消耗生成配额、不动其余活动。
  const seed = new Client({ connectionString: DATABASE_URL });
  await seed.connect();
  const v1 = 'c2-revision-v1';
  const seedUserId = (await seed.query('select id from users where email = $1', [email3])).rows[0]?.id;
  const v1Data = {
    id: v1,
    title: '旧版行程',
    destination: '成都',
    startDate: '2026-11-05',
    budgetLevel: '舒适',
    totalBudget: 0,
    preferences: [],
    partySize: 2,
    extraNotes: '',
    transportMode: 'transit',
    days: [
      {
        id: 'c2-v1-d1',
        dayIndex: 1,
        title: '第 1 天',
        activities: [
          { id: 'c2-v1-d1-a1', name: '宽窄巷子', startTime: '', endTime: '', description: '', lat: 0, lng: 0, coordSource: 'estimated', category: '文化', sourceNotes: [] },
        ],
      },
      {
        id: 'c2-v1-d2',
        dayIndex: 2,
        title: '第 2 天',
        activities: [
          { id: 'c2-v1-d2-a1', name: '青羊宫', startTime: '', endTime: '', description: '', lat: 0, lng: 0, coordSource: 'estimated', category: '文化', sourceNotes: [] },
          { id: 'c2-v1-d2-a2', name: '锦里', startTime: '', endTime: '', description: '', lat: 0, lng: 0, coordSource: 'estimated', category: '美食', sourceNotes: [] },
        ],
      },
    ],
    meta: { usedXhs: false, reviewNotes: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await seed.query(
    `insert into trips (id, user_id, title, destination, days_count, activity_count, total_cost, used_xhs, root_id, version, parent_id, data, created_at, updated_at)
     values ($1, $2, '旧版行程', '成都', 2, 3, 0, false, $1, 1, null, $3::jsonb, now(), now())`,
    [v1, seedUserId, JSON.stringify(v1Data)],
  );
  await seed.query(
    `insert into generations (id, user_id, trip_id, conversation_id, kind, status, created_at)
     values ('c2-revision-gen-1', $1, $2, $3, 'generation', 'done', now())`,
    [seedUserId, v1, conversationId],
  );

  const withTrip = await api('GET', `/api/conversations/${conversationId}`);
  check(
    '会话详情带上最近一次成功生成的行程',
    withTrip.json?.latestTrip?.id === v1 && withTrip.json?.latestTrip?.version === 1,
    JSON.stringify(withTrip.json?.latestTrip),
  );

  // 配额基线：上面 seed 的 v1 已占 1 次 done，绝不能比对绝对值
  const usageBeforeEdit = (await api('GET', '/api/usage')).json?.usedToday;
  const modifyTurn = await api('POST', `/api/conversations/${conversationId}/messages`, { text: '把第 2 天换成博物馆' });
  check(
    '修订意图识别',
    modifyTurn.json?.intent === 'modify_itinerary',
    `status=${modifyTurn.status} body=${JSON.stringify(modifyTurn.json).slice(0, 300)}`,
  );
  const editResult = modifyTurn.json?.editResult;
  check('按需编辑直接落新版本', editResult?.version === 2 && typeof editResult?.tripId === 'string', JSON.stringify(editResult));
  check('编辑操作回执已应用', editResult?.outcomes?.[0]?.applied === true, JSON.stringify(editResult?.outcomes));
  const v2 = editResult?.tripId;

  const v2Trip = await api('GET', `/api/trips/${v2}`);
  const v2day2 = v2Trip.json?.days?.find((d) => d.dayIndex === 2);
  check(
    '目标天第 1 个活动被替换为博物馆',
    v2day2?.activities?.[0]?.name === '成都博物馆' && v2day2?.activities?.length === 2,
    JSON.stringify(v2day2?.activities?.map((a) => a.name)),
  );
  check(
    '其余行程原样保留',
    v2Trip.json?.days?.find((d) => d.dayIndex === 1)?.activities?.[0]?.name === '宽窄巷子'
      && v2day2?.activities?.[1]?.name === '锦里',
  );
  const chain = (await seed.query('select root_id, version, parent_id from trips where id = $1', [v2])).rows[0];
  check(
    '修订产出 v2，挂在同一版本链',
    chain?.root_id === v1 && chain?.version === 2 && chain?.parent_id === v1,
    JSON.stringify(chain),
  );
  check('旧版 v1 原样保留', (await seed.query('select id from trips where id = $1', [v1])).rows.length === 1);
  check(
    '按需编辑不消耗生成配额',
    (await api('GET', '/api/usage')).json?.usedToday === usageBeforeEdit,
    `编辑前后均应为 ${usageBeforeEdit}`,
  );
  const noGenRow = (await seed.query('select count(*)::int as n from generations where trip_id = $1', [v2])).rows[0];
  check('按需编辑不产生 generations 行', noGenRow?.n === 0, `n=${noGenRow?.n}`);

  // 连续第二轮修改：锚点应跟随到 v2（latestConversationTrip 看消息 relatedTripId）
  const modify2 = await api('POST', `/api/conversations/${conversationId}/messages`, { text: '第 2 天别去锦里了' });
  check(
    '第二轮修订基于 v2（版本 3）',
    modify2.json?.editResult?.version === 3,
    JSON.stringify(modify2.json?.editResult ?? modify2.json),
  );

  // 版本链前端契约：版本接口 + 列表去重
  const chainRes = await api('GET', `/api/trips/${v1}/versions`);
  check(
    '版本链接口按 version 升序返回 v1+v2+v3',
    chainRes.json?.versions?.length === 3 && chainRes.json?.versions?.[0]?.version === 1 && chainRes.json?.versions?.[2]?.version === 3,
    JSON.stringify(chainRes.json?.versions?.map((v) => v.version)),
  );
  const listAfterRevision = await api('GET', '/api/trips');
  const listItems = listAfterRevision.json?.items ?? [];
  const v3 = modify2.json?.editResult?.tripId;
  // 该用户还有一条自动触发生成的独立行程；版本链去重只针对同一 root
  check(
    '行程列表只显示版本链最新版',
    listItems.some((t) => t.id === v3 && t.version === 3) === true
      && listItems.some((t) => t.id === v1 || t.id === v2) === false,
    JSON.stringify({ total: listAfterRevision.json?.total, items: listItems.map((t) => `${t.id}:v${t.version}`) }),
  );
  const oldVersionStillReadable = await api('GET', `/api/trips/${v1}`);
  check('旧版仍可按 id 直接访问', oldVersionStillReadable.status === 200, `status=${oldVersionStillReadable.status}`);

  // R3 对照（09-25）：seed 北京 100 条 verified → 已覆盖 → search_web 上限保持 2。
  // 用 BYOK 用户的最后一次额度跑（user3 的 2 次已被自动触发与 seed 修订行占满）
  await seed.query(
    `insert into canonical_places (id, city, name, category, source, verified, created_at)
     select 'c2-bj-' || g, '北京', '北京地点' || g, '景点', 'goldset', true, now() from generate_series(1, 100) g`,
  );
  const chatUserCookie = cookie;
  cookie = cookieOtherUser;
  const bjJob = await api('POST', '/api/generations', { destination: '北京', days: 2, budgetLevel: '舒适', partySize: 2 });
  check('已覆盖城市生成建任务 202', bjJob.status === 202, JSON.stringify(bjJob.json));
  const bjRun = await readEvents(bjJob.json?.jobId);
  check('已覆盖城市生成完成', bjRun.events.at(-1)?.type === 'job_done', bjRun.events.at(-1)?.type);
  const bjResearch = mock.seenResearchPrompts.find((p) => p.destination === '北京');
  check('已覆盖城市首轮模型直接收到SQL候选', bjResearch?.hasPrefetch === true);
  check('已覆盖城市调研一次请求即完成', bjRun.events.filter((e) => e.type === 'llm_request' && e.phase === 'research').length === 1);
  check('批量提交仍逐条发布候选', bjRun.events.filter((e) => e.type === 'candidate').length === 6);
  check('已知候选没有逐条模型入池调用', !bjRun.events.some((e) => e.type === 'tool_start' && e.tool === 'add_candidate'));
  check('已覆盖城市 search_web 上限保持 2', bjResearch?.searchWebMaxLine === '全阶段最多 2 次', String(bjResearch?.searchWebMaxLine));
  // 09-26：已覆盖城市列表接口（城市选择首页数据源）——测试库此时仅北京达阈值（其余为空库）
  const covered = await api('GET', '/api/destinations/covered');
  check('已覆盖城市列表仅含北京', covered.status === 200 && JSON.stringify(covered.json?.cities) === JSON.stringify(['北京']), JSON.stringify(covered.json));
  cookie = chatUserCookie;
  await seed.end();

  const overQuota = await api('POST', `/api/conversations/${conversationId}/messages`, { text: '再来一轮' });
  check('对话额度尽 429', overQuota.status === 429, `status=${overQuota.status}`);
  check(
    '429 带可操作码与恢复时刻',
    overQuota.json?.code === 'chat_quota_exhausted' && typeof overQuota.json?.data?.resetAt === 'number',
    JSON.stringify(overQuota.json),
  );
  check('被拒的一轮不落库', (await api('GET', `/api/conversations/${conversationId}`)).json?.messages?.length === 10);

  cookie = cookieOtherUser;
  check('他人会话详情 404', (await api('GET', `/api/conversations/${conversationId}`)).status === 404);
  check('他人会话发消息 404', (await api('POST', `/api/conversations/${conversationId}/messages`, { text: 'hi' })).status === 404);
  check('他人会话改 Brief 404', (await api('PATCH', `/api/conversations/${conversationId}/brief`, { destination: 'X' })).status === 404);
  check('他人会话删除 404', (await api('DELETE', `/api/conversations/${conversationId}`)).status === 404);
  check(
    '把生成挂到他人会话 404',
    (await api('POST', '/api/generations', { destination: '东京', days: 2, budgetLevel: '经济', partySize: 1, conversationId })).status === 404,
  );
  check(
    '基于他人行程发起修订 404',
    (await api('POST', '/api/generations', { destination: '东京', days: 2, budgetLevel: '经济', partySize: 1, kind: 'revision', targetTripId: v1 })).status === 404,
  );
  check(
    '修订不传目标行程 400',
    (await api('POST', '/api/generations', { destination: '东京', days: 2, budgetLevel: '经济', partySize: 1, kind: 'revision' })).status === 400,
  );

  // ⑥ generations 表落库核对（直接查 PG）
  console.log('\n— generations 表 —');
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const colsOf = async (table) =>
      (await db.query('select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1', [table]))
        .rows.map((r) => r.column_name);
    // 迁移把 root_id 置为 NOT NULL 是真实约束（NULL 会让版本链断链），断言列属性而非仅存在性
    const isNotNull = async (table, column) =>
      (await db.query(
        'select is_nullable from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = $2',
        [table, column],
      )).rows[0]?.is_nullable === 'NO';
    const persistedTrip = (await db.query('select used_xhs from trips where id = $1', [done.tripId])).rows[0];
    check('迁移后行程写入 used_xhs 成功', persistedTrip?.used_xhs === false, `used_xhs=${persistedTrip?.used_xhs}`);
    const tripColumns = await colsOf('trips');
    check('存量 trips 表迁移补齐 used_xhs', tripColumns.includes('used_xhs'), tripColumns.join(','));
    // 问答式入口（09-23）：版本链三列。root_id 需要回填存量行后才能置 NOT NULL
    check(
      '存量 trips 表迁移补齐版本链三列',
      ['root_id', 'version', 'parent_id'].every((column) => tripColumns.includes(column)),
      tripColumns.join(','),
    );
    const legacyTrip = (await db.query('select root_id, version, parent_id from trips where id = $1', ['legacy-trip-1'])).rows[0];
    check('存量行程 root_id 回填为自身 id', legacyTrip?.root_id === 'legacy-trip-1', `root_id=${legacyTrip?.root_id}`);
    check('存量行程 version 默认 1', legacyTrip?.version === 1, `version=${legacyTrip?.version}`);
    check('存量行程 parent_id 为空', legacyTrip?.parent_id === null, String(legacyTrip?.parent_id));
    const newTrip = (await db.query('select root_id, version from trips where id = $1', [done.tripId])).rows[0];
    check('新生成行程自为版本链根', newTrip?.root_id === done.tripId && newTrip?.version === 1, `root=${newTrip?.root_id} v=${newTrip?.version}`);
    check('存量 trips 表 root_id 已置 NOT NULL', await isNotNull('trips', 'root_id'));
    const generationColumns = await colsOf('generations');
    check(
      '存量 generations 表迁移补齐审计列',
      ['used_xhs', 'used_byok', 'tokens_in', 'tokens_out', 'xhs_calls', 'amap_calls', 'search_calls', 'conversation_id', 'kind', 'target_trip_id'].every((column) =>
        generationColumns.includes(column),
      ),
      generationColumns.join(','),
    );
    // 问答式入口三张新表
    const tableNames = (
      await db.query(`select table_name from information_schema.tables where table_schema = current_schema()`)
    ).rows.map((r) => r.table_name);
    check(
      '问答式入口三张表已建',
      ['conversations', 'chat_messages', 'planning_briefs'].every((table) => tableNames.includes(table)),
      tableNames.join(','),
    );
    const rows = (
      await db.query(
        `select status, used_byok, tokens_in, tokens_out, amap_calls, search_calls, trip_id from generations where conversation_id is null order by created_at`,
      )
    ).rows;
    check('五行记录（cancelled + 四次 done）', rows.length === 5, JSON.stringify(rows.map((r) => r.status)));
    check('cancelled 无 trip', rows[0]?.status === 'cancelled' && rows[0]?.trip_id === null);
    check('done 有 token 用量', rows[1]?.status === 'done' && rows[1].tokens_in > 0 && rows[1].tokens_out > 0, `in=${rows[1]?.tokens_in} out=${rows[1]?.tokens_out}`);
    check('Null 源不烧数据源额度', rows[1]?.amap_calls === 0 && rows[1]?.search_calls === 0, `amap=${rows[1]?.amap_calls} search=${rows[1]?.search_calls}`);
    check('BYOK 行 used_byok=true', rows.some((row) => row.used_byok === true));
  } finally {
    await db.end();
  }

  console.log(failures.length ? `\nFAIL：${failures.length} 项未过` : '\nPASS —— C2 验收全过');
} catch (err) {
  console.error('\n[verify-c2] 异常终止：', err);
  failures.push('脚本异常');
} finally {
  mock.close();
  server?.kill();
  await sleep(500);
  // 清理：杀掉服务后 drop 整个测试库（比 truncate 更干净，也避免下轮遗留 schema 漂移）
  try {
    const { adminUrl, dbName } = adminUrlAndDbName(DATABASE_URL);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await dropDatabase(admin, dbName);
    } finally {
      await admin.end();
    }
  } catch {}
}
process.exit(failures.length ? 1 : 0);
