import { apiFailure, readApiResponse } from './lib/api-contract.mjs';
// 隔离数据库 + 本地增量模型；覆盖真实 API 与生产前端，不调用真实外部供应商。
// 2026-11 适配详情 Agent（harness）：mock LLM 按真实工具名（get_trip/search_food/add_day/
// delete_activity/update_brief/start_generation/ask_user/web_search）逐轮回放，一轮 = 一个新版本。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright';
import { makeSampleTrip, uid } from '@tripweaver/shared';

const databaseName = `detail_chat_verify_${Date.now()}`;
const adminUrl = process.env.VERIFY_GENERATION_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
Object.assign(process.env, {
  DATABASE_URL: databaseUrl.toString(), DOTENV_CONFIG_PATH: './data/detail-chat-absent.env', MASTER_KEY: 'a'.repeat(64),
  AMAP_KEY: '', SEARCH_API_KEY: 'mock-search', SEARCH_API_BASE_URL: 'http://127.0.0.1:18828',
  SITE_LLM_BASE_URL: 'http://127.0.0.1:18828/v1', SITE_LLM_API_KEY: 'mock', SITE_LLM_MODEL: 'mock-chat',
  EMBEDDING_BASE_URL: 'http://127.0.0.1:18828/v1', EMBEDDING_API_KEY: 'mock', EMBEDDING_MODEL: 'mock-embedding',
  GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', REGISTRATION_MODE: 'open',
});
let broken = false;
let modelRequests = 0;
let webRequests = 0;
// 回放引擎：steps 是当前回合要依次发出的真实工具调用；工具用尽后发最终正文。
// 断流（broken）与挂起（hang）用于中断/停止路径；生成任务（submit_research）直接文本收尾，由外层取消。
type Step = { tool: string; args: Record<string, unknown> };
let steps: Step[] = [];
let finalReply = '这段回答正在实时到达。可以结合当前日期查看沿途的餐厅，具体店铺见下方卡片。';
let hang = false;
let releaseHang: (() => void) | undefined;
const hangGate = new Promise<void>((resolve) => { releaseHang = resolve; });
const llm = createServer(async (req, res) => {
  if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'mock-chat' }] })); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const input = JSON.parse(body);
  if (req.url?.endsWith('/embeddings')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: 1024 }, (_, i) => i === 0 ? 1 : 0) }] }));
    return;
  }
  if (req.url?.includes('web-search')) {
    webRequests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { webPages: { value: [{ name: '北京景点官方开放说明', url: 'https://example.com/official-hours', summary: '以景点官方当日公告为准。', datePublished: '2026-10-03' }] } } }));
    return;
  }
  modelRequests++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-detail', object: 'chat.completion.chunk', created: 1, model: 'mock-chat', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (input.tools?.some((tool: any) => tool.function.name === 'submit_research')) {
    // 完整生成任务的调研阶段（重新生成会在启动后立刻被取消）：文本收尾即可，不推进回放队列。
    emit({ role: 'assistant', content: '生成任务已停止。' });
    emit({}, 'stop');
  } else if (input.tools?.length) {
    // 详情 Agent 回合：按「最后一条 user 之后的 tool 消息数」判定已回放到第几步。
    const messages: any[] = input.messages ?? [];
    const lastUser = messages.map((message) => message.role).lastIndexOf('user');
    const consumed = messages.slice(lastUser + 1).filter((message) => message.role === 'tool').length;
    if (hang) await hangGate;
    const step = steps[consumed];
    if (step) {
      emit({ tool_calls: [{ index: 0, id: `call-${consumed}`, type: 'function', function: { name: step.tool, arguments: JSON.stringify(step.args) } }] });
      emit({}, 'tool_calls');
    } else {
      emit({ role: 'assistant', content: '这段回答正在实时到达。' });
      await sleep(650);
      if (broken) { res.destroy(); return; }
      emit({ content: finalReply });
      await sleep(350);
      emit({}, 'stop');
    }
  } else {
    emit({ role: 'assistant', content: '这段回答正在实时到达。' });
    await sleep(650);
    if (broken) { res.destroy(); return; }
    emit({ content: finalReply });
    await sleep(350);
    emit({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
llm.listen(18828, '127.0.0.1'); await once(llm, 'listening');
const { db, pool } = await import('../apps/server/src/db/client');
const { createTrip, updateTrip, listTripVersions, getTrip } = await import('../apps/server/src/services/tripService');
const { createSession } = await import('../apps/server/src/auth/session');
const { ensureTripConversation, restoreTrip, repairChangedRoutes } = await import('../apps/server/src/services/tripHistoryService');
const { appendMessages } = await import('../apps/server/src/services/conversationService');
const { conversationRoutes } = await import('../apps/server/src/routes/conversations');
const { tripRoutes } = await import('../apps/server/src/routes/trips');
const { authRoutes } = await import('../apps/server/src/routes/auth');
const { usageRoutes } = await import('../apps/server/src/routes/usage');
const { settingsRoutes } = await import('../apps/server/src/routes/settings');
const { installApiResponses } = await import('../apps/server/src/http/apiResponse');
const app = Fastify();
installApiResponses(app);
await app.register(cookie);
await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(conversationRoutes, { prefix: '/api/conversations' });
await app.register(tripRoutes, { prefix: '/api/trips' });
await app.register(usageRoutes, { prefix: '/api/usage' });
await app.register(settingsRoutes, { prefix: '/api/settings' });
await app.register(fastifyStatic, { root: resolve('apps/web/dist'), prefix: '/' });
app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: 'missing' }) : reply.sendFile('index.html'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') throw new Error('External providers disabled in verification');
  return originalFetch(input, init);
};
/** 给会话追加一条带美食候选卡片的助手消息：卡片链路（/food 接口与前端 FoodCard）用夹具驱动，
 *  因为离线环境没有高德 POI，search_food 拿不到真实候选。 */
const injectFoodCandidate = async (conversationId: string, tripId: string, name: string, dayId: string, dayIndex: number, nearby: string) => {
  await appendMessages({ userId: 'detail-user', conversationId, messages: [{
    role: 'assistant', content: '',
    attachment: {
      tripId, summary: [], candidates: [{
        id: uid(), poiKey: `poi-${name}`, tripId, name, address: '北京市东城区测试路 1 号',
        lat: 39.9205, lng: 116.4005, reason: `距离「${nearby}」直线约 100 米，可结合第 ${dayIndex} 天路线选择。`,
        dayId, dayIndex, nearby, meal: 'lunch' as const,
        sources: [{ title: '已验证地点资料', url: 'https://example.com/food' }],
        position: { dayId, meal: 'lunch' as const },
      }],
    },
  }] });
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await pool.query(`INSERT INTO users(id,email,password_hash,created_at) VALUES ('detail-user','detail@test.dev','',now()),('other-user','other@test.dev','',now())`);
  const source = makeSampleTrip();
  source.destination = '北京'; source.title = '北京沿途漫游'; source.days = source.days.slice(0, 2);
  for (const [d, day] of source.days.entries()) {
    day.activities = day.activities.slice(0, 2).map((a, i) => ({ ...a, name: `景点${d + 1}-${i + 1}`, category: '文化', lat: 39.92 + d * 0.001 + i * 0.001, lng: 116.40, coordSource: 'geocoded', coordSystem: 'gcj02', startTime: i === 0 ? '09:00' : '13:30', endTime: i === 0 ? '11:00' : '15:00' }));
    day.legs = []; delete day.lodging;
  }
  delete source.lodging;
  const initial = await createTrip('detail-user', source);
  await pool.query('ALTER TABLE trips DROP COLUMN change_summary; ALTER TABLE chat_messages DROP COLUMN attachment');
  const { runMigrations } = await import('../apps/server/src/db/migrate');
  await runMigrations(pool); await runMigrations(pool);
  assert.equal((await getTrip('detail-user', initial.id))!.title, initial.title);
  const { conversationId } = await ensureTripConversation('detail-user', initial.id);
  assert.equal((await ensureTripConversation('detail-user', initial.id)).conversationId, conversationId);
  const routesBefore = structuredClone(initial);
  const routeDay = routesBefore.days[0]!;
  const third = { ...routeDay.activities[1]!, id: uid(), name: '第三站' };
  routeDay.activities.push(third);
  const unchangedLeg = { fromActivityId: routeDay.activities[1]!.id, toActivityId: third.id, mode: 'walk' as const, durationMin: 9, distanceM: 500, source: 'heuristic' as const };
  routeDay.legs = [unchangedLeg];
  routeDay.lodging = { name: '测试住宿', lat: 39.919, lng: 116.40, coordSystem: 'gcj02' };
  const routesAfter = structuredClone(routesBefore);
  routesAfter.days[0]!.activities.splice(1, 0, { ...third, id: uid(), name: '新增用餐', category: '美食' });
  await repairChangedRoutes('detail-user', routesBefore, routesAfter);
  assert.deepEqual(routesAfter.days[0]!.legs!.find((l) => l.fromActivityId === unchangedLeg.fromActivityId && l.toActivityId === unchangedLeg.toActivityId), unchangedLeg);
  assert.equal(routesAfter.days[0]!.legs!.length, 5, '四个活动含住宿首末边');
  const session = await createSession('detail-user');
  const other = await createSession('other-user');
  const headers = { cookie: `tw_session=${session.token}`, 'content-type': 'application/json' };
  const base = 'http://127.0.0.1:18829';
  app.get('/test-login', async (_req, reply) => reply.setCookie('tw_session', session.token, { path: '/' }).redirect(`/trips/${initial.id}`));
  await app.listen({ port: 18829, host: '127.0.0.1' });
  const call = async (path: string, body?: unknown, method = 'POST') => {
    const res = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await readApiResponse(res) as any };
  };
  const firstInput = { requestId: uid(), tripId: initial.id, updatedAt: initial.updatedAt, dayId: initial.days[0]!.id, text: '推荐第 1 天路线附近的美食', suggestion: 'food' };
  const res = await fetch(`${base}/api/conversations/${conversationId}/messages/stream`, { method: 'POST', headers, body: JSON.stringify(firstInput) });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader(); let raw = ''; let firstAt = 0;
  while (true) { const chunk = await reader.read(); if (chunk.done) break; raw += new TextDecoder().decode(chunk.value); if (!firstAt && raw.includes('answer_delta')) firstAt = Date.now(); }
  assert.ok(firstAt && Date.now() - firstAt >= 600, '首段必须在模型完成前到达');
  const events = raw.split('\n\n').filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5)));
  assert.equal(events.at(-1).type, 'done', raw);
  // 离线无高德 POI：search_food 无候选，卡片链路在下方用夹具消息驱动。
  assert.deepEqual(events.at(-1).result.replyMessage.attachment.candidates, []);
  assert.equal((await listTripVersions('detail-user', initial.id))!.versions.length, 1);
  const beforeRetry = modelRequests;
  const retry = await fetch(`${base}/api/conversations/${conversationId}/messages/stream`, { method: 'POST', headers, body: JSON.stringify(firstInput) }); await retry.text();
  assert.equal(modelRequests, beforeRetry, '幂等重试不重调模型');
  console.log('PASS 真实增量提前到达、只读问答不建版本、幂等重试不重调模型');

  // 卡片夹具 + 添加局部路线：候选由夹具消息提供，/food 接口与位置重算走真实链路。
  await injectFoodCandidate(conversationId, initial.id, '测试餐馆1店', initial.days[0]!.id, 1, '景点1-1');
  const candidate = (await call(`/api/conversations/${conversationId}`, undefined, 'GET')).data.messages
    .flatMap((m: any) => m.attachment?.candidates ?? []).at(-1);
  assert.ok(candidate, '夹具候选已落库');
  const addInput = { operationId: uid(), expectedTripId: initial.id, updatedAt: initial.updatedAt, candidateId: candidate.id, position: { dayId: initial.days[0]!.id, beforeActivityId: initial.days[0]!.activities[1]!.id, meal: 'lunch' } };
  const added = await call(`/api/conversations/${conversationId}/food`, addInput);
  assert.equal(added.status, 200, JSON.stringify(added));
  assert.equal(added.data.version, 2);
  assert.equal(added.data.trip.days[0].activities.length, 3);
  assert.equal(added.data.trip.days[0].legs.length, 2);
  assert.deepEqual((await call(`/api/conversations/${conversationId}/food`, addInput)).data, added.data);
  const duplicate = await call(`/api/conversations/${conversationId}/food`, { ...addInput, operationId: uid(), expectedTripId: added.data.trip.id, updatedAt: added.data.trip.updatedAt });
  assert.equal(duplicate.data.alreadyExists, true);
  assert.equal(duplicate.data.trip.id, added.data.trip.id);
  const denied = await fetch(`${base}/api/conversations/${conversationId}/food`, { method: 'POST', headers: { ...headers, cookie: `tw_session=${other.token}` }, body: JSON.stringify({ ...addInput, operationId: uid() }) });
  assert.equal(denied.status, 404);
  const stale = await call(`/api/trips/${initial.id}`, { ...initial, title: '迟到的覆盖' }, 'PUT'); assert.equal(stale.status, 409);
  const saved = await updateTrip('detail-user', added.data.trip.id, { ...added.data.trip, title: '保存后的标题' });
  assert.ok(saved);
  assert.notEqual(saved.id, added.data.trip.id);
  assert.equal((await getTrip('detail-user', added.data.trip.id))!.title, added.data.trip.title);
  assert.equal((await listTripVersions('detail-user', saved.id))!.versions.at(-1)!.summary, '手动修改行程');
  assert.deepEqual(await updateTrip('detail-user', added.data.trip.id, { ...added.data.trip, title: '保存后的标题' }), saved, '保存重试返回同一版本');
  assert.equal((await updateTrip('detail-user', saved.id, saved)).id, saved.id, '无改动不创建版本');
  assert.equal((await listTripVersions('detail-user', saved.id))!.versions.length, 3);
  assert.equal((await call(`/api/conversations/${conversationId}`, undefined, 'GET')).data.latestTrip.id, saved.id, '手动版本成为会话锚点');
  await assert.rejects(updateTrip('detail-user', added.data.trip.id, added.data.trip), /新版本或修改/);
  console.log('PASS 添加局部路线、幂等、跨用户隔离、旧版本冻结、保存并发检查');

  const restoreInput = { operationId: uid(), expectedTripId: saved.id, updatedAt: saved.updatedAt };
  const restored = await call(`/api/trips/${initial.id}/restore`, restoreInput);
  assert.equal(restored.status, 200, JSON.stringify(restored)); assert.equal(restored.data.version, 4);
  assert.deepEqual(restored.data.trip.days, initial.days);
  assert.deepEqual((await call(`/api/trips/${initial.id}/restore`, restoreInput)).data, restored.data);
  assert.deepEqual((await getTrip('detail-user', initial.id))!.days, initial.days);
  const latestDetail = await call(`/api/conversations/${conversationId}`, undefined, 'GET');
  assert.equal(latestDetail.data.latestTrip.id, restored.data.trip.id);
  assert.equal(latestDetail.data.messages.filter((m: any) => m.role === 'user').length, 1);
  console.log('PASS 历史复制为新版本、恢复重试、会话锚点与免费操作');

  broken = true;
  const interrupted = await fetch(`${base}/api/conversations/${conversationId}/messages/stream`, { method: 'POST', headers, body: JSON.stringify({ ...firstInput, requestId: uid(), tripId: restored.data.trip.id, updatedAt: restored.data.trip.updatedAt }) });
  assert.match(await interrupted.text(), /"type":"error"/);
  broken = false;
  const afterFailure = await call(`/api/conversations/${conversationId}`, undefined, 'GET');
  assert.equal(afterFailure.data.messages.filter((m: any) => m.role === 'user').length, 1);
  console.log('PASS 上游中断只保留屏幕部分内容，失败不落消息或扣额');

  const detached = await createTrip('detail-user', source);
  const detachedNext = await createTrip('detail-user', source, detached.id);
  const concurrentInput = { operationId: uid(), expectedTripId: detachedNext.id, updatedAt: detachedNext.updatedAt };
  const concurrent = await Promise.allSettled([restoreTrip('detail-user', detached.id, concurrentInput), restoreTrip('detail-user', detached.id, { ...concurrentInput, operationId: uid() })]);
  assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await listTripVersions('detail-user', detached.id))!.versions.length, 3);
  const faultId = uid();
  await pool.query(`CREATE FUNCTION reject_detail_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${faultId}' THEN RAISE EXCEPTION 'injected operation failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER reject_detail_operation BEFORE INSERT ON detail_operations FOR EACH ROW EXECUTE FUNCTION reject_detail_operation()');
  const beforeFault = await listTripVersions('detail-user', initial.id);
  const failedRestore = await call(`/api/trips/${initial.id}/restore`, { operationId: faultId, expectedTripId: restored.data.trip.id, updatedAt: restored.data.trip.updatedAt });
  assert.equal(failedRestore.status, 500);
  assert.deepEqual(await listTripVersions('detail-user', initial.id), beforeFault);
  assert.equal((await call(`/api/conversations/${conversationId}`, undefined, 'GET')).data.messages.length, afterFailure.data.messages.length);
  console.log('PASS 存量迁移幂等、无会话恢复、并发恢复拒绝覆盖、操作写入失败整体回滚');

  // 自由文本改稿：mock 回放 get_trip + delete_activity，一个新版本 + edit_result 事件。
  const editSource = await createTrip('detail-user', source);
  const editConversation = (await ensureTripConversation('detail-user', editSource.id)).conversationId;
  steps = [
    { tool: 'get_trip', args: {} },
    { tool: 'delete_activity', args: { dayIndex: 1, activityId: editSource.days[0]!.activities[1]!.id } },
  ];
  finalReply = '将删除第 1 天的第二个活动。';
  const editInput = { requestId: uid(), tripId: editSource.id, updatedAt: editSource.updatedAt, text: '删除第 1 天的第二个活动' };
  const editResponse = await fetch(`${base}/api/conversations/${editConversation}/messages/stream`, { method: 'POST', headers, body: JSON.stringify(editInput) });
  const editFrames = (await editResponse.text()).split('\n\n').filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5)));
  assert.ok(editFrames.some((e) => e.type === 'edit_result'));
  const editResult = editFrames.at(-1).result;
  assert.equal(editResult.editResult.version, 2);
  assert.equal((await getTrip('detail-user', editResult.editResult.tripId))!.days[0]!.activities.length, 1);
  assert.equal((await getTrip('detail-user', editSource.id))!.days[0]!.activities.length, 2);
  const editRetry = await fetch(`${base}/api/conversations/${editConversation}/messages/stream`, { method: 'POST', headers, body: JSON.stringify(editInput) });
  assert.match(await editRetry.text(), /"type":"done"/);
  assert.equal((await listTripVersions('detail-user', editSource.id))!.versions.length, 2);
  console.log('PASS 自由文本局部改稿（真实工具回放）、edit_result 事件与新版本幂等');

  // 明确重新生成：update_brief 补齐节奏 + generate_trip，回合内委派后台任务；重试返回同一任务。
  steps = [
    { tool: 'update_brief', args: { pace: 'moderate', startDate: '2026-11-01' } },
    { tool: 'generate_trip', args: {} },
  ];
  finalReply = '将重新生成行程。';
  const regenerateInput = { requestId: uid(), tripId: editResult.editResult.tripId, updatedAt: (await getTrip('detail-user', editResult.editResult.tripId))!.updatedAt, text: '重新生成这趟行程' };
  const regenerated = await fetch(`${base}/api/conversations/${editConversation}/messages/stream`, { method: 'POST', headers, body: JSON.stringify(regenerateInput) });
  const regenerateFrames = (await regenerated.text()).split('\n\n').filter((f) => f.startsWith('data:')).map((f) => JSON.parse(f.slice(5)));
  const regenerateResult = regenerateFrames.at(-1).result;
  assert.ok(regenerateResult?.startedGenerationJobId, JSON.stringify(regenerateFrames));
  const { getJob, cancelJob } = await import('../apps/server/src/generation/jobManager');
  const job = getJob(regenerateResult.startedGenerationJobId, 'detail-user')!;
  job.abort.abort(); cancelJob(job);
  const regenerateRetry = await fetch(`${base}/api/conversations/${editConversation}/messages/stream`, { method: 'POST', headers, body: JSON.stringify(regenerateInput) });
  assert.match(await regenerateRetry.text(), new RegExp(regenerateResult.startedGenerationJobId));
  console.log('PASS update_brief + generate_trip 回放启动任务，重试返回同一任务');

  // 追加天数：mock 回放 add_day + add_activity（地点名全局唯一，草稿会拒绝同名重复）。
  let restaurantSeq = 0;
  const appendDays = (count: number) => {
    steps = [
      ...Array.from({ length: count }, () => ({ tool: 'add_day', args: { title: '新增漫游日' } })),
      ...Array.from({ length: count }, (_, index) => ({ tool: 'add_activity', args: { dayIndex: 3 + index, name: `测试餐馆${++restaurantSeq}店`, category: '美食', description: '新增日期的用餐安排' } })),
    ];
  };
  const extendSource = await createTrip('detail-user', { ...source, startDate: '2026-12-31' });
  const extendConversation = (await ensureTripConversation('detail-user', extendSource.id)).conversationId;
  const streamExtension = async (trip: typeof source, text: string, requestId = uid(), suggestion?: string) => {
    const input = { requestId, tripId: trip.id, updatedAt: trip.updatedAt, text, ...(suggestion ? { suggestion } : {}) };
    const response = await fetch(`${base}/api/conversations/${extendConversation}/messages/stream`, { method: 'POST', headers, body: JSON.stringify(input) });
    const frames = (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data:')).map((frame) => JSON.parse(frame.slice(5)));
    return frames;
  };
  appendDays(1);
  finalReply = '追加一天行程。';
  const extensionId = uid();
  const extensionFrames = await streamExtension(extendSource, '再加一天行程', extensionId);
  assert.equal(extensionFrames.at(-1).type, 'done', JSON.stringify(extensionFrames));
  const extensionResult = extensionFrames.at(-1).result;
  let extended = (await getTrip('detail-user', extensionResult.editResult.tripId))!;
  assert.equal(extended.days.length, 3);
  assert.ok(extended.days[2]!.activities.some((a) => a.name === '测试餐馆1店'), '新天的活动来自 add_activity 回放');
  assert.ok(extensionFrames.filter((frame) => frame.type === 'progress').length >= 4, '每个工具都有开始/结束进度');
  // 前两天保持原内容（动线重算可能补 legs，剥离后比较活动与标题）。
  assert.deepEqual(extended.days.slice(0, 2).map((day) => ({ ...day, legs: [] })), extendSource.days.map((day) => ({ ...day, legs: [] })));
  assert.equal(extensionResult.brief.data.endDate, '2027-01-02', 'Brief 日期随新增天数同步');
  assert.match(extensionResult.replyMessage.content, /已保存为 v2/);
  const extensionRequests = modelRequests;
  const extensionRetry = await streamExtension(extendSource, '再加一天行程', extensionId);
  assert.equal(extensionRetry.at(-1).result.editResult.tripId, extended.id);
  assert.equal(modelRequests, extensionRequests, '幂等重试不重调模型');
  appendDays(2);
  finalReply = '追加两天行程。';
  const multiFrames = await streamExtension(extended, '再延长两天');
  assert.equal(multiFrames.at(-1).type, 'done', JSON.stringify(multiFrames));
  extended = (await getTrip('detail-user', multiFrames.at(-1).result.editResult.tripId))!;
  assert.equal(extended.days.length, 5);
  const names = extended.days.flatMap((d) => d.activities.map((a) => a.name));
  assert.equal(new Set(names).size, names.length, '同名活动被草稿拒绝，不会重复入行程');
  assert.equal(multiFrames.at(-1).result.brief.data.endDate, '2027-01-04');
  const extensionChain = (await listTripVersions('detail-user', extendSource.id))!;
  assert.match(extensionChain.versions.at(-1)!.summary!, /新增第 5 天/);
  // 超限：加 11 天只落 10 天（上限 15），被拒的 add_day 不影响整轮提交。
  appendDays(11);
  finalReply = '追加超限日期。';
  const overflowFrames = await streamExtension(extended, '再延长十一天');
  assert.equal(overflowFrames.at(-1).type, 'done', JSON.stringify(overflowFrames));
  extended = (await getTrip('detail-user', overflowFrames.at(-1).result.editResult.tripId))!;
  assert.equal(extended.days.length, 15, '天数在 15 天上限截断');
  assert.equal(overflowFrames.at(-1).result.brief.data.days, 15);
  assert.equal(overflowFrames.at(-1).result.brief.data.endDate, '2027-01-14');
  assert.equal((await listTripVersions('detail-user', extendSource.id))!.versions.length, 4);
  const beforeExtensionFault = (await call(`/api/conversations/${extendConversation}`, undefined, 'GET')).data;
  steps = [{ tool: 'add_day', args: { title: '超限的一天' } }];
  finalReply = '追加一天。';
  const failedExtension = await streamExtension(extended, '再加一天', faultId);
  assert.equal(failedExtension.at(-1).type, 'error');
  assert.deepEqual((await call(`/api/conversations/${extendConversation}`, undefined, 'GET')).data, beforeExtensionFault);
  assert.equal((await listTripVersions('detail-user', extendSource.id))!.versions.length, 4);
  steps = [];
  finalReply = '多一天能去哪，先给建议。';
  const readOnlyExtension = await streamExtension(extended, '多一天能去哪？先给建议', uid(), 'follow_up');
  assert.equal(readOnlyExtension.at(-1).result.editResult, undefined);
  const beforeBroken = (await call(`/api/conversations/${extendConversation}`, undefined, 'GET')).data;
  broken = true;
  steps = [{ tool: 'add_day', args: { title: '断流的一天' } }];
  finalReply = '追加一天。';
  const failedStream = await streamExtension(extended, '再加一天，中途断流测试');
  assert.equal(failedStream.at(-1).type, 'error');
  assert.deepEqual((await call(`/api/conversations/${extendConversation}`, undefined, 'GET')).data, beforeBroken);
  broken = false;
  // 中途停止：mock 挂起工具响应，stop 接口 abort 服务端回合，不落半成品。
  hang = true;
  steps = [{ tool: 'add_day', args: { title: '停止测试的一天' } }];
  finalReply = '追加一天。';
  const cancelId = uid(); const beforeCancel = modelRequests;
  const cancelledExtension = streamExtension(extended, '再加一天，中途停止测试', cancelId);
  for (let i = 0; i < 200 && modelRequests <= beforeCancel; i++) await sleep(20);
  assert.ok(modelRequests > beforeCancel);
  const stoppedResponse = await call(`/api/conversations/${extendConversation}/operations/${cancelId}/stop`, {});
  assert.equal(stoppedResponse.status, 200, JSON.stringify(stoppedResponse));
  releaseHang!(); hang = false;
  assert.equal((await cancelledExtension).at(-1).type, 'error');
  assert.deepEqual((await call(`/api/conversations/${extendConversation}`, undefined, 'GET')).data, beforeBroken);
  // 按需联网：web_search 回放 → 引用持久化到回答附件。
  const currentWebCalls = webRequests;
  steps = [{ tool: 'web_search', args: { query: '北京 公园 开放 预约' } }];
  finalReply = '已经联网核对开放信息。';
  const webAnswer = await streamExtension(extended, '联网查一下现在这些公园的开放和预约信息');
  assert.equal(webAnswer.at(-1).type, 'done', JSON.stringify(webAnswer));
  assert.ok(webRequests > currentWebCalls);
  assert.ok(webAnswer.at(-1).result.replyMessage.attachment.references.some((r: any) => r.url === 'https://example.com/official-hours'));
  console.log('PASS 新增一天/多天、上限截断、超限/断流/停止不落半成品、幂等、只读建议、按需联网与真实引用');

  const extendRestored = await call(`/api/trips/${extendSource.id}/restore`, { operationId: uid(), expectedTripId: extended.id, updatedAt: extended.updatedAt });
  assert.equal(extendRestored.status, 200);
  assert.equal(extendRestored.data.trip.days.length, 2);
  const restoredBrief = (await call(`/api/conversations/${extendConversation}`, undefined, 'GET')).data.conversation.brief.data;
  assert.equal(restoredBrief.days, 2); assert.equal(restoredBrief.endDate, '2027-01-01');
  console.log('PASS 恢复到旧版本后天数与 Brief 同步');

  const legacySource = await createTrip('detail-user', source);
  const legacyConversation = (await ensureTripConversation('detail-user', legacySource.id)).conversationId;
  const streamLegacy = async (trip: { id: string; updatedAt: number }, text: string) => {
    const response = await fetch(`${base}/api/conversations/${legacyConversation}/messages/stream`, { method: 'POST', headers, body: JSON.stringify({ requestId: uid(), tripId: trip.id, updatedAt: trip.updatedAt, text }) });
    const frames = (await response.text()).split('\n\n').filter((frame) => frame.startsWith('data:')).map((frame) => JSON.parse(frame.slice(5)));
    return { status: response.status, frames, data: frames.at(-1)?.result ?? {} };
  };
  steps = [
    { tool: 'add_day', args: { title: '新增第 3 天漫游' } },
    { tool: 'add_activity', args: { dayIndex: 3, name: `测试餐馆${++restaurantSeq}店`, category: '美食', description: '新增日期的用餐安排' } },
  ];
  finalReply = '新增日期';
  const legacyResult = await streamLegacy(legacySource, '再加一天行程');
  assert.equal(legacyResult.status, 200, JSON.stringify(legacyResult.frames));
  const legacyTrip = (await getTrip('detail-user', legacyResult.data.editResult.tripId))!;
  assert.deepEqual(legacyTrip.days.slice(0, 2).map((day) => ({ ...day, legs: [] })), legacySource.days.map((day) => ({ ...day, legs: [] })));
  steps = [{ tool: 'add_day', args: { title: '自由休息' } }];
  finalReply = '增加休息日';
  const restResult = await streamLegacy(legacyTrip, '再加一天空白休息日，不安排活动');
  assert.equal(restResult.status, 200, JSON.stringify(restResult.frames));
  const restTrip = (await getTrip('detail-user', restResult.data.editResult.tripId))!;
  assert.equal(restTrip.days.length, 4); assert.equal(restTrip.days[3]!.activities.length, 0);
  console.log('PASS 旧会话加天与空白休息日：add_day 回放落版本');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addCookies([{ name: 'tw_session', value: session.token, url: base }]);
  const page = await context.newPage();
  const errors: string[] = []; page.on('pageerror', (err) => errors.push(err.message));
  await mkdir('data/detail-chat-verification', { recursive: true });
  // 复现无初始关联消息时，首条修改回答被 relatedTripId 过滤掉的问题。
  const firstEditTrip = await createTrip('detail-user', source);
  const firstEditConversation = (await ensureTripConversation('detail-user', firstEditTrip.id)).conversationId;
  await pool.query(`INSERT INTO generations(id,user_id,trip_id,conversation_id,status,created_at) VALUES ($1,$2,$3,$4,'done',now())`, [uid(), 'detail-user', firstEditTrip.id, firstEditConversation]);
  await pool.query('DELETE FROM chat_messages WHERE conversation_id=$1', [firstEditConversation]);
  steps = [{ tool: 'delete_activity', args: { dayIndex: 1, activityId: firstEditTrip.days[0]!.activities[0]!.id } }];
  finalReply = '删除第一个活动';
  await page.goto(`${base}/trips/${firstEditTrip.id}`);
  await page.getByLabel('输入你的行程想法').fill('删除第 1 天的第一个活动');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回答', exact: true }).waitFor({ state: 'hidden' });
  // 「已保存为 vN」只进完整 content；界面按 parts 渲染，落版本标记用改动徽章断言。
  await page.locator('.chat-msg-assistant').filter({ hasText: 'v2 · 1 项' }).waitFor();
  await page.reload();
  await page.locator('.chat-msg-assistant').filter({ hasText: 'v2 · 1 项' }).waitFor();
  await page.screenshot({ path: 'data/detail-chat-verification/first-edit-persisted.png', fullPage: true });
  console.log('PASS 首条修改回答不被关联标记截断，刷新后仍可见');

  // HITL：ask_user 回放 → 问题卡 dock；刷新恢复 pending；回答后同一回合继续。
  const qaTrip = await createTrip('detail-user', source);
  const qaConversation = (await ensureTripConversation('detail-user', qaTrip.id)).conversationId;
  await page.goto(`${base}/trips/${qaTrip.id}`);
  await page.locator('.chat-welcome').waitFor();
  assert.equal(await page.locator('.chat-welcome .chat-suggestions button').count(), 3);
  assert.equal(await page.locator('.chat-input .chat-suggestions').count(), 0);
  await page.screenshot({ path: 'data/detail-chat-verification/initial.png', fullPage: true });
  steps = [{
    tool: 'ask_user',
    args: { questions: [{ id: 'day', question: '你想先调整哪一天的节奏？', header: '选择范围', options: [{ label: '先调整第 1 天' }, { label: '先调整第 2 天' }, { label: '先看看整体建议' }] }] },
  }];
  finalReply = '可以先减少连续步行。';
  await page.getByLabel('输入你的行程想法').fill('想把行程安排得轻松一些');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const answers = page.getByRole('group', { name: '你想先调整哪一天的节奏？', exact: true });
  await answers.waitFor();
  assert.equal(await answers.getByRole('button').count(), 3);
  await page.reload();
  await answers.waitFor();
  await answers.getByRole('button', { name: '先调整第 2 天', exact: true }).click();
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await page.getByRole('button', { name: '停止回答', exact: true }).waitFor({ state: 'hidden' });
  await page.locator('.chat-msg-user').filter({ hasText: '先调整第 2 天' }).waitFor();
  const qaDetail = (await call(`/api/conversations/${qaConversation}`, undefined, 'GET')).data;
  assert.equal(qaDetail.messages.filter((m: any) => m.role === 'user' && m.content === '想把行程安排得轻松一些').length, 1);
  const qaQuestions = qaDetail.messages.flatMap((m: any) => m.attachment?.questions ?? []);
  assert.deepEqual(qaQuestions.at(-1)?.selected, ['先调整第 2 天']);
  assert.equal((await listTripVersions('detail-user', qaTrip.id))!.versions.length, 1, '问答不修改行程');
  assert.equal(await page.locator('.chat-welcome .chat-suggestions').count(), 0);
  await page.screenshot({ path: 'data/detail-chat-verification/question-answers.png', fullPage: true });
  console.log('PASS 初始化建议属于对话流，ask_user 问题卡持久化、刷新恢复、回答后同一回合完成、只读问答不建版本');

  await page.goto(`${base}/trips/${extendRestored.data.trip.id}`);
  steps = [
    { tool: 'add_day', args: { title: '新增第 3 天漫游' } },
    { tool: 'add_activity', args: { dayIndex: 3, name: `测试餐馆${++restaurantSeq}店`, category: '美食', description: '新增日期的用餐安排' } },
  ];
  finalReply = '再追加一天行程。';
  const extensionUrl = page.url();
  await page.getByLabel('输入你的行程想法').fill('再加一天，推荐美食，安排轻松一些');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.locator('[data-agent-activity]').first().waitFor();
  await page.screenshot({ path: 'data/detail-chat-verification/progress-running.png', fullPage: true });
  await page.waitForURL((url) => url.href !== extensionUrl);
  await page.getByRole('button', { name: '停止回答', exact: true }).waitFor({ state: 'hidden' });
  await page.getByText('已完成', { exact: false }).first().waitFor();
  await page.screenshot({ path: 'data/detail-chat-verification/progress-completed.png', fullPage: true });
  await page.getByRole('button', { name: '第3天', exact: true }).click();
  await page.locator('.activity-entry').filter({ hasText: '测试餐馆' }).first().waitFor();
  await page.reload();
  await page.getByRole('button', { name: '第3天', exact: true }).click();
  await page.locator('.activity-entry').filter({ hasText: '测试餐馆' }).first().waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  // 移动端默认展开对话面板（aiPanelOpen 初始为 true），无需切换
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'data/detail-chat-verification/progress-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  console.log('PASS 浏览器处理过程实时长出、完成收起、刷新回看、新增天数导航与手机无溢出');

  await page.goto(`${base}/trips/${restored.data.trip.id}`);
  await page.getByLabel('输入你的行程想法').waitFor();
  steps = [];
  finalReply = '这段回答正在实时到达。可以结合当前日期查看沿途的餐厅，具体店铺见下方卡片。';
  await page.getByLabel('输入你的行程想法').fill('推荐第 1 天路线附近的美食');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回答', exact: true }).waitFor();
  await page.getByRole('button', { name: '停止回答', exact: true }).click();
  await page.getByRole('button', { name: '恢复编辑', exact: true }).waitFor({ timeout: 20000 }).catch(async (error) => {
    console.log('DEBUG no 恢复编辑; page errors =', JSON.stringify(errors));
    await page.screenshot({ path: 'data/detail-chat-verification/debug-stop.png', fullPage: true });
    throw error;
  });
  await page.getByRole('button', { name: '恢复编辑', exact: true }).click();
  for (let i = 0; i < 50 && !/第 1 天/.test(await page.getByLabel('输入你的行程想法').inputValue()); i++) await sleep(100);
  assert.match(await page.getByLabel('输入你的行程想法').inputValue(), /第 1 天/);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByRole('button', { name: '停止回答', exact: true }).waitFor({ state: 'hidden' });
  // 卡片夹具：给这条回答补一张候选（离线无高德，候选由夹具驱动），验证前端一键加入链路。
  await injectFoodCandidate(conversationId, restored.data.trip.id, '测试餐馆6店', restored.data.trip.days[0]!.id, 1, '景点1-1');
  await page.reload();
  const positionCard = page.locator('.food-card').last();
  await positionCard.getByRole('button', { name: '调整位置', exact: true }).click();
  const positionChoices = positionCard.locator('.food-position-choices');
  assert.equal(await positionChoices.locator('input, select').count(), 0);
  await positionChoices.getByRole('button', { name: /^第 2 天 · / }).click();
  await positionChoices.getByRole('button', { name: '晚餐', exact: true }).click();
  assert.ok(await positionChoices.getByRole('group').getByRole('button').count() <= 3);
  await page.screenshot({ path: 'data/detail-chat-verification/position-answers.png', fullPage: true });
  await positionChoices.getByRole('button', { name: '取消添加', exact: true }).click();
  const beforeUiAdd = page.url();
  await page.getByRole('button', { name: '加入第 1 天 · 午餐', exact: true }).last().click();
  await page.waitForURL((url) => url.href !== beforeUiAdd);
  await page.locator('.activity-entry').filter({ hasText: '测试餐馆' }).waitFor();
  await positionCard.getByText('已加入第 1 天', { exact: false }).waitFor();
  await mkdir('data/detail-chat-verification', { recursive: true });
  await page.screenshot({ path: 'data/detail-chat-verification/desktop-chat.png', fullPage: true });
  await page.getByRole('button', { name: /历史版本/ }).click();
  const history = page.getByRole('dialog', { name: '历史版本' });
  // 回到 v4（加卡片前的一版）：真回退删掉 v5，餐馆随内容消失，链上仍保留可「查看」的更早版本。
  await history.locator('article').filter({ has: page.locator('strong', { hasText: /^v4/ }) }).getByRole('button', { name: '回到', exact: true }).click();
  await history.getByRole('button', { name: '回到此版本', exact: true }).click();
  await history.waitFor({ state: 'hidden' });
  await page.waitForURL(`${base}/trips/${restored.data.trip.id}`);
  for (let i = 0; i < 50 && await page.locator('.activity-entry').filter({ hasText: '测试餐馆' }).count() > 0; i++) await sleep(100);
  assert.equal(await page.locator('.activity-entry').filter({ hasText: '测试餐馆' }).count(), 0);
  console.log('PASS 浏览器卡片一键加入、其他候选重校验、历史恢复为新版本');

  const draftUrl = page.url();
  const draftId = new URL(draftUrl).pathname.split('/').at(-1)!;
  await page.getByLabel('当天更多操作', { exact: true }).click();
  await page.getByRole('button', { name: '修改当日主题', exact: true }).click();
  const rename = page.getByRole('dialog', { name: '修改当日主题' });
  await rename.getByRole('textbox').fill('必须保留的未保存草稿');
  let rejectSave = true;
  let saveStarted = false;
  let releaseSave: (() => void) | undefined;
  const delayedSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  await page.route(`**/api/trips/${draftId}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    saveStarted = true;
    if (rejectSave) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(apiFailure(503, '测试保存失败，草稿仍在')) });
    await delayedSave;
    await route.continue();
  });
  await rename.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: /历史版本/ }).click();
  const draftHistory = page.getByRole('dialog', { name: '历史版本' });
  const viewOld = draftHistory.locator('article').filter({ has: page.locator('strong', { hasText: /^v1/ }) }).getByRole('button', { name: '查看', exact: true });
  await viewOld.click({ timeout: 20000 }).catch(async (error) => {
    console.log('DEBUG viewOld click failed');
    await page.screenshot({ path: 'data/detail-chat-verification/debug-viewold.png', fullPage: true });
    throw error;
  });
  await draftHistory.getByRole('alert').filter({ hasText: '测试保存失败' }).waitFor();
  assert.equal(page.url(), draftUrl);
  assert.equal(await page.getByRole('heading', { name: '必须保留的未保存草稿' }).count(), 1);
  assert.notEqual((await getTrip('detail-user', draftId))!.days[0]!.title, '必须保留的未保存草稿');
  const viewTargetId = (await listTripVersions('detail-user', draftId))!.versions.at(-1)!.id;
  rejectSave = false; saveStarted = false;
  await viewOld.click();
  for (let i = 0; i < 40 && !saveStarted; i++) await sleep(25);
  assert.equal(saveStarted, true);
  assert.equal(page.url(), draftUrl, '保存完成前不允许切换版本');
  releaseSave!();
  await page.waitForURL(`${base}/trips/${viewTargetId}`);
  await draftHistory.waitFor({ state: 'hidden' });
  const savedDraftChain = (await listTripVersions('detail-user', draftId))!;
  const savedDraft = (await getTrip('detail-user', savedDraftChain.versions.at(-1)!.id))!;
  assert.equal(savedDraft.days[0]!.title, '必须保留的未保存草稿');
  assert.notEqual((await getTrip('detail-user', draftId))!.days[0]!.title, '必须保留的未保存草稿', '原版本冻结');
  await page.unroute(`**/api/trips/${draftId}`);
  console.log('PASS 浏览器保存失败保留草稿和当前页，重试先保存再切版本');
  await page.goto(`${base}/trips/${savedDraft.id}`);
  await page.getByRole('button', { name: '第2天', exact: true }).click();
  await page.getByLabel('输入你的行程想法').fill('暂不发送的输入草稿');
  let releaseDraftSave: (() => void) | undefined;
  const draftGate = new Promise<void>((resolve) => { releaseDraftSave = resolve; });
  let observeDraftSave: (() => void) | undefined;
  const draftStarted = new Promise<void>((resolve) => { observeDraftSave = resolve; });
  await page.route(`**/api/trips/${savedDraft.id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    observeDraftSave!(); await draftGate; await route.continue();
  });
  const changeDayTitle = async (title: string) => {
    await page.getByLabel('当天更多操作', { exact: true }).click();
    await page.getByRole('button', { name: '修改当日主题', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '修改当日主题' });
    await dialog.getByRole('textbox').fill(title);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
  };
  await changeDayTitle('先保存的主题');
  await draftStarted;
  await changeDayTitle('保存等待期间继续修改的主题');
  releaseDraftSave!();
  let finalDraft = savedDraft;
  for (let attempt = 0; attempt < 100; attempt++) {
    const chain = (await listTripVersions('detail-user', savedDraft.id))!;
    finalDraft = (await getTrip('detail-user', chain.versions.at(-1)!.id))!;
    if (finalDraft.days[1]!.title === '保存等待期间继续修改的主题') break;
    await sleep(50);
  }
  assert.equal(finalDraft.days[1]!.title, '保存等待期间继续修改的主题');
  await page.waitForURL(`${base}/trips/${finalDraft.id}`);
  assert.equal(await page.getByLabel('输入你的行程想法').inputValue(), '暂不发送的输入草稿');
  // 新版日期切换用选中态样式而不是 aria-pressed；选中效果由后续「第 2 天」标题断言覆盖。
  await page.getByRole('button', { name: '第2天', exact: true }).click();
  assert.equal((await listTripVersions('detail-user', finalDraft.id))!.versions.length, savedDraftChain.versions.length + 2);
  assert.notEqual((await getTrip('detail-user', savedDraft.id))!.days[1]!.title, finalDraft.days[1]!.title);
  await page.unroute(`**/api/trips/${savedDraft.id}`);
  await page.reload();
  await page.getByRole('button', { name: '第2天', exact: true }).click();
  await page.getByRole('heading', { name: '保存等待期间继续修改的主题', exact: true }).waitFor();
  console.log('PASS 连续编辑排队保存为两个版本，日期和输入草稿保留，刷新后最新内容仍存在');
  await page.getByRole('button', { name: /历史版本/ }).click();
  const dialog = page.getByRole('dialog', { name: '历史版本' }); await dialog.waitFor();
  await page.screenshot({ path: 'data/detail-chat-verification/desktop-history.png', fullPage: true });
  assert.equal(await dialog.locator('article[aria-current=true]').count(), 1);
  const oldRow = dialog.locator('article').filter({ has: page.locator('strong', { hasText: /^v1/ }) });
  if (!page.url().endsWith(initial.id)) await oldRow.getByRole('button', { name: '查看', exact: true }).click();
  else await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByText('正在查看历史版本 v1', { exact: false }).waitFor();
  await page.reload(); await page.getByText('正在查看历史版本 v1', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('输入你的行程想法').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '＋ 添加活动', exact: true }).count(), 0);
  await mkdir('data/detail-chat-verification', { recursive: true });
  await page.screenshot({ path: 'data/detail-chat-verification/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: /历史版本/ }).click();
  await page.screenshot({ path: 'data/detail-chat-verification/mobile-history.png', fullPage: true });
  await page.getByRole('dialog', { name: '历史版本' }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}/trips/${finalDraft.id}`);
  await page.getByRole('button', { name: '第1天', exact: true }).click();
  let releaseLeavingSave: (() => void) | undefined;
  const leavingGate = new Promise<void>((resolve) => { releaseLeavingSave = resolve; });
  let observeLeavingSave: (() => void) | undefined;
  const leavingStarted = new Promise<void>((resolve) => { observeLeavingSave = resolve; });
  await page.route(`**/api/trips/${finalDraft.id}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    observeLeavingSave!(); await leavingGate; await route.continue();
  });
  await changeDayTitle('离开页面前保存的主题');
  await leavingStarted;
  await page.getByRole('link', { name: '返回行程列表', exact: true }).click();
  await page.waitForURL(`${base}/trips`);
  // 等编辑器页真正卸载后再放行 PUT：验证「迟到」的保存回执不会把用户拉回详情页。
  await sleep(500);
  const leavingResponse = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith(`/api/trips/${finalDraft.id}`));
  releaseLeavingSave!();
  await leavingResponse;
  await sleep(500);
  assert.equal(new URL(page.url()).pathname, '/trips', '离开后迟到的保存回执不能把用户拉回详情页');
  assert.deepEqual(errors, []);
  console.log('PASS 浏览器真实停止与草稿恢复、历史刷新只读、375px 无溢出、离开后的保存不抢回页面');
  await browser.close(); browser = undefined;
  if (process.argv.includes('--serve')) { console.log(`PREVIEW ${base}/test-login`); await new Promise<void>((resolve) => process.once('SIGINT', resolve)); }
} finally {
  await browser?.close(); await app.close(); await new Promise<void>((resolve) => llm.close(() => resolve()));
  globalThis.fetch = originalFetch; await pool.end();
  releaseHang!();
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`); await admin.end();
}
