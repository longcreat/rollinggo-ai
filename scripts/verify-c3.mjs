import { apiFailure } from './lib/api-contract.mjs';
// C3 浏览器自动化验收：首页城市选择 → 结构化表单 → SSE 时间线三阶段（含候选卡片实时长出）→ 完成跳编辑器（含备选抽屉）
//                     → 编辑器内嵌对话修订 → 刷新恢复 → 取消 → 配额文案 → 旧行程（无 overview）兼容
// 走生产模式静态托管（同源 SSE），mock LLM 驱动。运行：node scripts/verify-c3.mjs
// 数据库：09-26 起与 verify-c2 同例——独占专用测试库（默认 tripweaver_verify_c3，
// 可用 VERIFY_C3_DATABASE_URL 覆盖），每次运行先 drop/create 保证干净，结束时 drop 清理。
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { startMockLlm } from './lib/mock-llm.mjs';

const MOCK_PORT = 18788;
const API_PORT = 18791;
const BASE = `http://127.0.0.1:${API_PORT}`;
const SHOTS = 'verify-shots';
const DATABASE_URL =
  process.env.VERIFY_C3_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/tripweaver_verify_c3';
const DATABASE_URL_NOKEY =
  process.env.VERIFY_C3_NOKEY_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/tripweaver_verify_c3_nokey';
const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { Client } = requireFromServer('pg');

const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

// ---------- 测试库管理（与 verify-c2 同例） ----------

function adminUrlAndDbName(url) {
  const u = new URL(url);
  const dbName = u.pathname.replace(/^\//, '');
  if (!dbName || dbName === 'postgres') throw new Error('VERIFY_C3_DATABASE_URL 必须指向专用测试库，禁止 postgres');
  u.pathname = '/postgres';
  return { adminUrl: u.toString(), dbName };
}

async function recreateDatabase(url) {
  const { adminUrl, dbName } = adminUrlAndDbName(url);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // PG 13+ 支持 WITH (FORCE)，自动断开存量连接
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(url) {
  const { adminUrl, dbName } = adminUrlAndDbName(url);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * 已覆盖城市种子（09-26 首页城市选择的数据前提）：
 * 每个城市插 100 条 verified（= CITY_COVERAGE_THRESHOLD），少于该值首页不列、表单页拒绝直达。
 */
async function seedCoveredCities(url, cities) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const city of cities) {
      await client.query(
        `insert into canonical_places (id, city, name, category, source, verified, created_at)
         select 'c3-' || $1 || '-' || g, $1, $1 || '地点' || g, '景点', 'goldset', true, now() from generate_series(1, 100) g`,
        [city],
      );
    }
  } finally {
    await client.end();
  }
}

// ---------- 表单入口辅助（09-26：/trips/new 已由对话页改为结构化表单页） ----------

const CHAT_INPUT = '输入你的行程想法';

/** 生成额度只看顶栏 chip（AppLayout 常驻，全页面可比） */
async function generationQuota(page) {
  return (await page.locator('.quota-chip').innerText()).trim();
}

/** 首页点城市卡片进表单页 */
async function gotoFormFromHome(page, city) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: city }).click();
  await page.waitForURL('**/trips/new?city=*', { timeout: 10_000 });
}

/** 胶囊段按钮（面板的「下一步：×× →」文案含同名，必须用 class 限定） */
function capsuleSegment(page, name) {
  return page.locator('button.capsule-segment', { hasText: name });
}

/** 表单填必填项并发起生成（胶囊交互：日期预填明天起 3 天，天数用快捷 chip，节奏进面板点选） */
async function startGenerationViaForm(page, { city, days = 2, extraNotes = '' }) {
  await gotoFormFromHome(page, city);
  await capsuleSegment(page, '出行日期').click();
  await page.getByRole('button', { name: `${days}天`, exact: true }).click();
  await capsuleSegment(page, '节奏与同行').click();
  await page.getByRole('button', { name: /适中充实/ }).click();
  if (extraNotes) {
    await capsuleSegment(page, '偏好与更多').click();
    await page.getByLabel(/补充说明/).fill(extraNotes);
  }
  await page.getByRole('button', { name: /开始生成/ }).click();
}

if (!existsSync('apps/web/dist/index.html')) {
  console.error('缺少 apps/web/dist，请先 npm run build');
  process.exit(2);
}

await recreateDatabase(DATABASE_URL);

const mock = await startMockLlm(MOCK_PORT, { delayMs: 400 });
const server = spawn(process.execPath, ['../../node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
  cwd: 'apps/server',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(API_PORT),
    DATABASE_URL,
    MASTER_KEY: crypto.randomBytes(32).toString('hex'),
    REGISTRATION_MODE: 'invite',   // 钉死邀请码模式：不受本机 apps/server/.env 影响
    INVITE_CODE: 'C3TEST',
    SITE_LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    SITE_LLM_API_KEY: 'site-mock-key',
    SITE_LLM_MODEL: 'mock-chat',
    GEN_DAILY_LIMIT: '3',
    // 外部数据源钉死为空（同 verify-c2）：否则会读本机 apps/server/.env 并真实调用高德/搜索，
    // 使候选池、住宿推导与降级标注全变成环境相关。
    AMAP_KEY: '',
    SEARCH_API_KEY: '',
    SSRF_ALLOWLIST: `127.0.0.1:${MOCK_PORT}`,
    NO_PROXY: 'localhost,127.0.0.1',
  },
});
server.stderr.on('data', (d) => process.env.VERBOSE && console.error(String(d)));

const browser = await chromium.launch({ args: ['--no-proxy-server'] });
try {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch {}
    await sleep(500);
    if (i === 119) throw new Error('服务端启动超时');
  }
  console.log('[api] 生产模式服务端就绪（静态托管 + SSE 同源）');
  // 城市覆盖种子必须在首次访问首页前落库：listCoveredCities 进程内缓存无 TTL
  await seedCoveredCities(DATABASE_URL, ['东京', '大阪', '北京']);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // 注册进入
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(`c3-${Date.now()}@test.dev`);
  await page.getByLabel('密码（至少 8 位）').fill('password123');
  await page.getByLabel('确认密码').fill('password123');
  await page.getByLabel('邀请码').fill('C3TEST');
  await page.getByRole('button', { name: '注册并登录' }).click();
  await page.waitForURL('**/trips', { timeout: 10_000 });

  // 1. 首页：已覆盖城市图集 + 顶栏生成额度
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const cityCards = await page.locator('.city-card').allInnerTexts();
  check('首页仅列出已覆盖城市（3 个种子城市）', cityCards.length === 3, cityCards.join('｜'));
  const quotaText = await generationQuota(page);
  check('顶栏显示今日剩余生成次数', quotaText.includes('3/3'), quotaText);

  // 1.5 表单页：日期已预填（明天起 3 天），只欠节奏时按钮禁用，点选后可用
  await page.getByRole('link', { name: '东京' }).click();
  await page.waitForURL('**/trips/new?city=*', { timeout: 10_000 });
  // URL 变化先于 React 重渲：等胶囊条出现再读 h1，否则可能读到旧首页的标题
  await page.waitForSelector('.capsule-deck', { timeout: 10_000 });
  const h1Text = await page.locator('h1').innerText();
  check('表单页标题带城市名', h1Text.includes('东京'), h1Text);
  const submitBtn = page.getByRole('button', { name: /开始生成/ });
  check('必填未齐时生成按钮禁用', await submitBtn.isDisabled());
  await capsuleSegment(page, '节奏与同行').click();
  await page.getByRole('button', { name: /适中充实/ }).click();
  check('必填补齐后生成按钮可用', !(await submitBtn.isDisabled()));
  await capsuleSegment(page, '偏好与更多').click();
  await page.getByLabel(/补充说明/).fill('想住得离地铁近');
  // 未覆盖城市直达防护：手写 URL 进表单页应被弹回首页
  await page.goto(`${BASE}/trips/new?city=${encodeURIComponent('拉萨')}`, { waitUntil: 'networkidle' });
  await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });
  check('未覆盖城市直达表单页被弹回首页', true);
  await page.screenshot({ path: `${SHOTS}/08-city-home.png` });

  // 2. 第一次生成：完整流水线（extraNotes 随表单进 Brief 快照，3.55 验证留档）
  await startGenerationViaForm(page, { city: '东京', extraNotes: '想住得离地铁近' });
  await page.screenshot({ path: `${SHOTS}/08b-form-filled.png` });

  await page.waitForSelector('.gen-phase', { timeout: 15_000 });
  check('时间线出现', true);
  // 降级标注随 job_start（首个事件）出现；给短超时，避免断言失败时白等 30s 把生成拖完
  const bannerText = await page.locator('.gen-banner').innerText({ timeout: 5_000 }).catch(() => '');
  check('降级标注可见（未配置外部数据源 → 模型知识调研）', bannerText.includes('模型知识'), bannerText.trim() || '(无 banner)');

  // 2.5 调研阶段候选卡片实时长出（生成尚未结束时即可见）
  await page.waitForSelector('.gen-candidates .poi-card', { timeout: 20_000 });
  const doneWhileCandidates = await page.locator('.gen-result-ok').count();
  check('候选卡片在生成过程中实时出现', doneWhileCandidates === 0);

  await page.waitForSelector('.gen-phase-head:has-text("编排行程")', { timeout: 20_000 });
  const candCount = await page.locator('.gen-candidates .poi-card').count();
  check('候选去重（4 次写入 → 3 张卡片）', candCount === 3, `cards=${candCount}`);
  await page.screenshot({ path: `${SHOTS}/09-gen-running.png` });
  await page.waitForSelector('.gen-result-ok', { timeout: 30_000 });
  const phaseTitles = await page.locator('.gen-phase-title').allInnerTexts();
  check(
    '三阶段齐全',
    ['调研灵感', '编排行程', '打磨标题'].every((t) => phaseTitles.some((x) => x.includes(t))),
    phaseTitles.join('，'),
  );
  const toolLabels = await page.locator('.gen-tool-label').allInnerTexts();
  check('工具时间线有条目', toolLabels.length >= 3, `tools=${toolLabels.length}`);
  const reviewNote = await page.locator('.gen-review-notes').innerText().catch(() => '');
  check('审校提示展示', reviewNote.includes('留意闭馆时间'), reviewNote.trim());
  const usageFoot = await page.locator('.gen-foot .muted').innerText();
  check('token 用量展示', usageFoot.includes('Token'), usageFoot.trim());
  await page.screenshot({ path: `${SHOTS}/10-gen-done.png` });

  // 3. 完成自动跳编辑器
  await page.waitForURL('**/trips/*', { timeout: 10_000 });
  await page.waitForSelector('.day-section', { timeout: 10_000 });
  const dayCount = await page.locator('.day-section').count();
  check('自动跳转编辑器且天数正确', dayCount === 2, `days=${dayCount}`);
  // ST3：mock 规划师已 set_lodging → 有住宿锚点，不显示「未设住宿」弱提示；
  // 无高德 Key → lodging 无坐标 → 不生成住宿 leg（🏨 chip 为 0），静默降级不报错
  // ST3 ↩ 09-22 决定：hotel 候选不进编排、也不推导住宿区域（只给区域名、严禁具体酒店），
  // 因此每天都会显示「未设住宿」弱提示。这是预期行为，不是回归。
  const lodgingHints = await page.locator('.day-lodging-hint').count();
  check('住宿不由候选推导 → 每天显示未设住宿弱提示（09-22 决定）', lodgingHints === dayCount, `hints=${lodgingHints}, days=${dayCount}`);
  // 版本切换器只在真有多版时出现（单版本行程不应多出一排按钮）
  check('单版本行程不显示版本切换器', (await page.locator('.trip-versions').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/11-generated-trip.png` });

  // 3.5 概览与备选抽屉
  // 外部数据源已钉死为空 → 候选池就只有 mock 的 3 条；确定性排程（09-21）会把非 hotel
  // 候选排成活动，所以命中活动的候选不会出现在备选抽屉里。断言按这一现实写：
  //   概览层（payload）断言候选全量与预约种子表；抽屉层只断言未命中活动的两项。
  const tripId = page.url().split('/').pop();
  // 用页面内 fetch（同源、带 cookie），不用 page.request —— 后者在某些 Playwright 版本下不共用会话 cookie
  const tripPayload = await page.evaluate(async (id) => (await fetch(`/api/trips/${id}`)).json().then(body => body.data), tripId);
  const overview = tripPayload.overview ?? [];
  check('概览持久化 3 条候选', overview.length === 3, `overview=${overview.length}`);
  const gugong = overview.find((p) => p.name === '故宫博物院');
  check('预约种子表覆盖为 required', gugong?.reservation === 'required', String(gugong?.reservation));
  check('种子来源链接注入', gugong?.sourceLinks?.[0]?.url?.includes('dpm.org.cn') === true, JSON.stringify(gugong?.sourceLinks));
  check(
    '住宿候选不排成活动（只给区域名，不推具体酒店）',
    (tripPayload.days ?? []).flatMap((d) => d.activities).every((a) => a.category !== '住宿'),
  );

  await page.waitForSelector('.editor-left .candidate-drawer', { timeout: 5_000 });
  await page.locator('.editor-left .candidate-drawer summary').click();
  const groupHeads = await page.locator('.editor-left .candidate-drawer .overview-group h3').allInnerTexts();
  check(
    '未命中活动的候选按类目分组（美食 + 住宿）',
    ['美食', '住宿'].every((t) => groupHeads.some((x) => x.includes(t))),
    groupHeads.join('，'),
  );
  const poiCards = await page.locator('.editor-left .candidate-drawer .poi-card').count();
  const fallbackCovers = await page.locator('.editor-left .candidate-drawer .poi-cover-fallback').count();
  check('无 coverUrl 时占位图兜底', poiCards === 2 && fallbackCovers === 2, `cards=${poiCards}, fallback=${fallbackCovers}`);
  const unknownBadges = await page.locator('.editor-left .candidate-drawer .rsv-unknown').count();
  check('预约未知 → 中性徽章（建议核实）', unknownBadges === 2, `unknown=${unknownBadges}`);
  const overviewNote = await page.locator('.editor-left .overview-note').innerText();
  check('来源标注 +「以官方为准」提示', overviewNote.includes('以官方为准') && overviewNote.includes('模型知识'), overviewNote.trim());
  // 需要预约的候选（故宫）已被排成活动、不在抽屉里，因此离线候选池下抽屉无外链——
  // 外链 rel 属性只在真的有外链时才有断言对象。
  const sourceLinkCount = await page.locator('.editor-left .candidate-drawer .tag-source').count();
  if (sourceLinkCount > 0) {
    const sourceLinkRel = await page.locator('.editor-left .candidate-drawer .tag-source').first().getAttribute('rel');
    check('来源外链带 noopener noreferrer', sourceLinkRel === 'noopener noreferrer', String(sourceLinkRel));
  } else {
    check('来源外链检查跳过（离线候选池中需要预约的候选已排成活动）', true);
  }
  await page.screenshot({ path: `${SHOTS}/11b-trip-overview.png` });

  // 3.55 表单生成的会话关联（09-26）：提交时惰性建会话 + Brief 快照，编辑器据此挂对话面板
  const convProbe = await page.evaluate(async (id) => {
    const conv = await (await fetch(`/api/trips/${id}/conversation`)).json().then(body => body.data);
    if (!conv.conversationId) return { conversationId: null };
    const detail = await (await fetch(`/api/conversations/${conv.conversationId}`)).json().then(body => body.data);
    return { conversationId: conv.conversationId, brief: detail.conversation.brief.data };
  }, tripId);
  check('表单生成的行程已关联会话', Boolean(convProbe.conversationId));
  check(
    'Brief 快照留档表单输入（含补充说明）',
    convProbe.brief?.destination === '东京' && convProbe.brief?.extraNotes === '想住得离地铁近',
    JSON.stringify({ destination: convProbe.brief?.destination, extraNotes: convProbe.brief?.extraNotes }),
  );

  // 3.9 旧行程兼容：无 overview 字段 → 备选抽屉不渲染，编辑器正常
  const ctxOld = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pOld = await ctxOld.newPage();
  await pOld.goto(`${BASE}/register`, { waitUntil: 'networkidle' });
  await pOld.getByLabel('邮箱').fill(`c3old-${Date.now()}@test.dev`);
  await pOld.getByLabel('密码（至少 8 位）').fill('password123');
  await pOld.getByLabel('确认密码').fill('password123');
  await pOld.getByLabel('邀请码').fill('C3TEST');
  await pOld.getByRole('button', { name: '注册并登录' }).click();
  await pOld.waitForURL('**/trips', { timeout: 10_000 });
  await pOld.getByRole('button', { name: '加载示例行程' }).click();
  await pOld.waitForSelector('.day-section', { timeout: 10_000 });
  const oldDayCount = await pOld.locator('.day-section').count();
  const oldDrawer = await pOld.locator('.candidate-drawer').count();
  check(
    '旧行程（无 overview）不渲染备选抽屉且编辑器正常',
    oldDayCount === 3 && oldDrawer === 0,
    `days=${oldDayCount}, drawer=${oldDrawer}`,
  );
  // ST3 旧行程兼容：无 lodging → 每个有活动的天显示「未设住宿」弱提示
  const oldHints = await pOld.locator('.day-lodging-hint').count();
  check('旧行程（无 lodging）显示未设住宿弱提示', oldHints === oldDayCount, `hints=${oldHints}`);
  await ctxOld.close();

  // 3.6 版本链前端（PR6）：列表每条链一行、首版不显示版本徽章、单版本不显示切换器
  await page.goto(`${BASE}/trips`, { waitUntil: 'networkidle' });
  const listCards = await page.locator('.trip-card').count();
  const versionBadges = await page.locator('.trip-version-badge').count();
  check('列表每条版本链一行且首版无徽章', listCards === 1 && versionBadges === 0, `cards=${listCards}, badges=${versionBadges}`);

  // 3.7 编辑器内嵌对话（09-24 R2/R4，09-26 起为对话的唯一入口）：发起按需修改落版本链
  // 放在 3.6 之后：编辑会产生 v2，列表断言（首版无徽章）必须赶在编辑之前跑
  await page.goto(`${BASE}/trips/${tripId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.editor-chat .chat-panel', { timeout: 5_000 });
  const panelMsgs = await page.locator('.editor-chat .chat-msg').count();
  check('编辑器左侧常驻对话面板且 Brief 快照消息可见', panelMsgs >= 2, `msgs=${panelMsgs}`);
  // 按需修订（R1）：说「换成」→ 服务端应用编辑操作并落 v2，面板跳转到新版本
  await page.locator('.editor-chat').getByLabel(CHAT_INPUT).fill('把第 2 天换成博物馆');
  await page.locator('.editor-chat').getByLabel(CHAT_INPUT).press('Enter');
  await page.waitForFunction((oldId) => !location.pathname.endsWith(oldId), tripId, { timeout: 20_000 });
  await page.waitForSelector('.trip-versions', { timeout: 10_000 });
  const editedNames = await page.locator('.day-section .activity-name').allInnerTexts();
  check('对话修改落新版本且只动目标活动', editedNames.some((n) => n.includes('成都博物馆')), editedNames.join('｜'));
  const versionChips = await page.locator('.trip-versions .btn-chip').allInnerTexts();
  check('版本链切换器出现 v1+v2', versionChips.length === 2, versionChips.join('，'));
  await page.screenshot({ path: `${SHOTS}/11c-editor-chat-edit.png` });

  // 4. 刷新恢复：开第二次生成，中途 reload
  await startGenerationViaForm(page, { city: '大阪' });
  await page.waitForSelector('.gen-phase', { timeout: 15_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });   // SSE 长连接会卡 networkidle
  // 恢复有两条正路：任务仍在跑 → 重放时间线后自动跳；快照已 done → 直接跳编辑器
  try {
    await page.waitForURL((url) => /\/trips\/(?!new)[^/]+$/.test(url.pathname ?? String(url)), { timeout: 30_000 });
    await page.waitForSelector('.day-section', { timeout: 10_000 });
    check('刷新恢复（sessionStorage + 快照 + 重放）并最终进入编辑器', true);
  } catch (e) {
    await page.screenshot({ path: `${SHOTS}/98-debug-restore.png` });
    const resultText = await page.locator('.gen-result').innerText().catch(() => '(无结果框)');
    const bodyText = await page.locator('body').innerText().catch(() => '');
    check('刷新恢复（sessionStorage + 快照 + 重放）并最终进入编辑器', false, `url=${page.url()}｜result=${resultText.replace(/\n/g, ' ')}｜body=${bodyText.slice(0, 900).replace(/\n/g, ' ')}`);
  }

  // 5. 取消：开第三次生成后立即取消
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const quotaBefore = await generationQuota(page);
  await gotoFormFromHome(page, '北京');
  await capsuleSegment(page, '节奏与同行').click();
  await page.getByRole('button', { name: /适中充实/ }).click();
  await page.getByRole('button', { name: /开始生成/ }).click();
  let rejectNextCancellation = true;
  const cancellationRoutePattern = '**/api/generations/*/cancel';
  const cancellationSnapshotRoutePattern = /\/api\/generations\/[^/]+$/;
  await page.route(cancellationRoutePattern, async (route) => {
    await sleep(300);
    if (rejectNextCancellation) {
      rejectNextCancellation = false;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify(apiFailure(500, '模拟取消失败')) });
      return;
    }
    await route.continue();
  });
  let delayNextCancellationSnapshot = true;
  await page.route(cancellationSnapshotRoutePattern, async (route) => {
    if (delayNextCancellationSnapshot && route.request().method() === 'GET') {
      delayNextCancellationSnapshot = false;
      await sleep(1_500);
    }
    await route.continue();
  });

  await page.getByRole('button', { name: '取消生成' }).click({ timeout: 10_000 });
  const firstPendingButton = page.getByRole('button', { name: '取消中…' });
  await firstPendingButton.waitFor({ timeout: 5_000 });
  check('取消点击立即显示 pending 且禁用', await firstPendingButton.isDisabled());
  const cancellationError = await page.locator('.form-error').innerText({ timeout: 5_000 });
  const retryCancellationButton = page.getByRole('button', { name: '取消生成' });
  check(
    '取消失败可见且按钮可重试',
    cancellationError.includes('模拟取消失败') && !(await retryCancellationButton.isDisabled()),
    cancellationError.trim(),
  );

  await retryCancellationButton.click();
  const retryPendingButton = page.getByRole('button', { name: '取消中…' });
  await retryPendingButton.waitFor({ timeout: 5_000 });
  check('重试取消再次显示 pending 且禁用', await retryPendingButton.isDisabled());
  await page.waitForSelector('.gen-result:has-text("已取消")', { timeout: 15_000 });
  await page.unroute(cancellationRoutePattern);
  check('取消后展示已取消', true);
  await page.getByRole('button', { name: '返回表单' }).click();
  // 表单状态在组件内保留：回来后不必重填即可再次提交
  await page.getByRole('button', { name: /开始生成/ }).waitFor({ timeout: 5_000 });
  const quotaAfterCancel = await generationQuota(page);
  check('取消不消耗次数', quotaAfterCancel === quotaBefore, `${quotaBefore} → ${quotaAfterCancel}`);

  // 6. 旧取消轮询迟到时不得污染随后启动的新任务；随后用完配额
  await page.getByRole('button', { name: /开始生成/ }).click();
  await page.waitForSelector('.gen-phase', { timeout: 15_000 });
  // 先确认任务在跑（取消按钮可见）再断言无污染，避免生成过快时把「已完成」误判为污染
  const cancelVisible = await page
    .getByRole('button', { name: /取消生成|取消中…/ })
    .waitFor({ timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  await sleep(1_800);
  check(
    '旧取消轮询迟到不关闭新任务 SSE 或注入取消终态',
    (await page.locator('.gen-result:has-text("已取消")').count()) === 0 && cancelVisible,
    `cancelVisible=${cancelVisible}`,
  );
  await page.unroute(cancellationSnapshotRoutePattern);
  await page.waitForSelector('.gen-result-ok', { timeout: 30_000 });
  await page.waitForURL('**/trips/*', { timeout: 10_000 });
  await gotoFormFromHome(page, '北京');
  const disabledBtn = await page.getByRole('button', { name: '今日次数已用完' }).isDisabled();
  check('配额用尽按钮禁用 + 文案', disabledBtn);
  await page.screenshot({ path: `${SHOTS}/12-quota-exhausted.png` });

  // 7. 移动端首页视口（390px）：城市图集在小屏正常渲染
  const mob = await context.newPage();
  await mob.setViewportSize({ width: 390, height: 844 });
  await mob.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const mobCards = await mob.locator('.city-card').count();
  check('移动端首页城市图集渲染正常', mobCards === 3, `cards=${mobCards}`);
  await mob.screenshot({ path: `${SHOTS}/13-mobile-home.png` });
  await mob.close();

  // 8. 无 Key 文案（纯 BYOK 模式站点）：另起无站点 Key 服务（独立库）
  await recreateDatabase(DATABASE_URL_NOKEY);
  const server2 = spawn(process.execPath, ['../../node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
    cwd: 'apps/server',
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(API_PORT + 1),
      DATABASE_URL: DATABASE_URL_NOKEY,
      MASTER_KEY: crypto.randomBytes(32).toString('hex'),
      REGISTRATION_MODE: 'invite',   // 钉死邀请码模式：不受本机 apps/server/.env 影响
      INVITE_CODE: 'C3TEST',
      SITE_LLM_BASE_URL: '',
      SITE_LLM_API_KEY: '',
      SITE_LLM_MODEL: '',
      GEN_DAILY_LIMIT: '3',
      NO_PROXY: 'localhost,127.0.0.1',
    },
  });
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${API_PORT + 1}/api/health`);
        if (r.ok) break;
      } catch {}
      await sleep(500);
    }
    await seedCoveredCities(DATABASE_URL_NOKEY, ['东京']);
    const p2 = await context.newPage();
    await p2.goto(`http://127.0.0.1:${API_PORT + 1}/register`, { waitUntil: 'networkidle' });
    await p2.getByLabel('邮箱').fill(`nk-${Date.now()}@test.dev`);
    await p2.getByLabel('密码（至少 8 位）').fill('password123');
    await p2.getByLabel('确认密码').fill('password123');
    await p2.getByLabel('邀请码').fill('C3TEST');
    await p2.getByRole('button', { name: '注册并登录' }).click();
    await p2.waitForURL('**/trips', { timeout: 10_000 });
    // 无站点 Key：表单提交时 POST /api/generations 拿 400 no_llm，文案分流不变
    await p2.goto(`http://127.0.0.1:${API_PORT + 1}/`, { waitUntil: 'networkidle' });
    await p2.getByRole('link', { name: '东京' }).click();
    await p2.waitForURL('**/trips/new?city=*', { timeout: 10_000 });
    await capsuleSegment(p2, '节奏与同行').click();
    await p2.getByRole('button', { name: /适中充实/ }).click();
    await p2.getByRole('button', { name: /开始生成/ }).click();
    const errText = await p2.locator('.form-error').innerText({ timeout: 10_000 });
    check('无 Key 双轨文案（联系站长 + 高级选项自填）', errText.includes('联系站长') && errText.includes('高级选项'), errText.trim());
    await p2.screenshot({ path: `${SHOTS}/14-no-llm-copy.png` });
    await p2.close();
  } finally {
    server2.kill();
  }
} catch (err) {
  check('脚本执行中断', false, String(err).slice(0, 300));
} finally {
  await browser.close();
  mock.close();
  server.kill();
  await sleep(800);
  await dropDatabase(DATABASE_URL).catch(() => {});
  await dropDatabase(DATABASE_URL_NOKEY).catch(() => {});
}

console.log('\n===== C3 浏览器验收结果 =====');
for (const r of results) console.log(r);
console.log(`===== ${results.length - failed}/${results.length} 通过 =====`);
process.exit(failed ? 1 : 0);

