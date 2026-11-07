/**
 * 行程资源路由（`/api/trips`）：列表/详情/重命名/删除/版本链/天气/路线方案/分享海报/恢复。
 *
 * 约定：
 * - 所有 handler 都以 `userId` 作为查询谓词，**没有单独的权限校验层** —— 拿别人的 id 进来
 *   只会得到 404，靠这一点隔离越权，新加接口必须沿用。
 * - 读取类接口会给景点补图（`enrichTripPhotos`），**不写库**，只在响应里补。
 * - 分享海报与路线方案限流单独收紧：前者是重活（生成图片），后者打外部 API（高德配额）。
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { RenameTripSchema, RouteOptionsRequestSchema, RouteOptionsResponseSchema, TripExportSchema, TripSchema, TRIP_LIST_PAGE_SIZE, TRIP_LIST_PAGE_SIZE_MAX } from '@tripweaver/shared';
import { getRouteOptions } from '../services/routeOptionsService';
import { TripShareImageRequestSchema, TripShareImageQuerySchema, TripShareImageResponseSchema, TripShareImageGeneratedResponseSchema } from '@tripweaver/shared';
import { recordShareImageNotification } from '../services/notificationService';
import { createTripShareImageService } from '../services/tripShareImageService';
import { sharePosterStore } from '../services/sharePosterStore';
import { requireAuth } from '../auth/guard';
import { createTrip, deleteTrip, getTrip, listTripsPage, listTripVersions, renameTrip, updateTrip } from '../services/tripService';
import { findConversationForTrip } from '../services/conversationService';
import { TripOperationRequestSchema, TripRewindRequestSchema } from '@tripweaver/shared';
import { enrichTripPhotos } from '../services/tripPhotoService';
import { createStoredAmapPhotoLookup } from '../generation/storedPlaceLookups';
import { ensureTripConversation, restoreTrip, rewindTrip } from '../services/tripHistoryService';
import { TripWeatherSchema } from '@tripweaver/shared';
import { getTripWeather } from '../services/tripWeatherService';
import {
  createHealthCheck, getHealthCheck, getTripVersion, latestHealthCheck, resolveHealthCheck,
} from '../services/healthCheckService';
import { verifyFinding } from '../services/healthVerifyService';
import { HealthCheckViewSchema, HealthDecisionsRequestSchema } from '@tripweaver/shared';

const IdParams = Type.Object({ id: Type.String() });


// 行程列表分页（10-03）：筛选/排序/计数都在服务端；Fastify 默认 coerce，query 里的字符串会转成 integer
const TripListQuerySchema = Type.Object({
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: TRIP_LIST_PAGE_SIZE_MAX })),
  q: Type.Optional(Type.String({ maxLength: 100 })),
  city: Type.Optional(Type.String({ maxLength: 100 })),
  sort: Type.Optional(Type.Union([Type.Literal('updated'), Type.Literal('created'), Type.Literal('name')])),
});

export const tripRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // 每个应用实例共用并发闸门；通知故障不丢弃已经落盘的成品。
  const shareImages = createTripShareImageService(sharePosterStore, undefined, async (userId, trip, style) => {
    try { return await recordShareImageNotification(userId, trip, style); }
    catch { app.log.error({ tripId: trip.id }, 'share image notification write failed'); return undefined; }
  });
  app.addHook('preHandler', requireAuth);

  // ---------- 行程体检（行前精细化，2026-11-06） ----------
  // 创建体检（Pass 1a 确定性审计，<100ms）：同版本 pending 体检幂等复用
  app.post('/:id/health-check', { schema: { params: IdParams } }, async (request, reply) => {
    const userId = request.user!.id;
    const trip = await getTrip(userId, request.params.id);
    if (!trip) return reply.code(404).send({ error: '行程不存在' });
    const version = await getTripVersion(userId, trip.id);
    if (version === null) return reply.code(404).send({ error: '行程不存在' });
    return createHealthCheck(userId, trip, version);
  });

  // 最近一次体检（前端徽章：hard 数）
  app.get('/:id/health-check/latest', { schema: { params: IdParams } }, async (request, reply) => {
    const view = await latestHealthCheck(request.user!.id, request.params.id);
    if (!view) return reply.code(404).send({ error: '尚未体检' });
    return view;
  });

  // 单条核验（H2）：预约政策 + 最新营业时间 + 天气窗口
  app.post('/:id/health-check/:checkId/findings/:findingId/verify', {
    schema: { params: Type.Object({ id: Type.String({ maxLength: 100 }), checkId: Type.String({ maxLength: 100 }), findingId: Type.String({ maxLength: 100 }) }) },
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const userId = request.user!.id;
    const check = await getHealthCheck(userId, request.params.checkId);
    if (!check || check.tripId !== request.params.id) return reply.code(404).send({ error: '体检会话不存在' });
    const finding = check.findings.find((f) => f.id === request.params.findingId);
    if (!finding) return reply.code(404).send({ error: '发现项不存在' });
    const trip = await getTrip(userId, request.params.id);
    if (!trip) return reply.code(404).send({ error: '行程不存在' });
    const verification = await verifyFinding({ userId, trip, finding });
    // 把核验结果写回 findings（落库，刷新不丢）
    const updated = check.findings.map((f) => f.id === finding.id ? { ...f, verification } : f);
    const { db } = await import('../db/client');
    const { tripHealthChecks } = await import('../db/schema');
    const { eq, and } = await import('drizzle-orm');
    await db.update(tripHealthChecks).set({ findings: updated })
      .where(and(eq(tripHealthChecks.id, check.id), eq(tripHealthChecks.userId, userId)));
    return { ...check, findings: updated };
  });

  // 提交处置（Pass 2 确定性重排 → 新版本）
  app.post('/:id/health-check/:checkId/decisions', {
    schema: { params: Type.Object({ id: Type.String({ maxLength: 100 }), checkId: Type.String({ maxLength: 100 }) }), body: HealthDecisionsRequestSchema },
  }, async (request, reply) => {
    const userId = request.user!.id;
    const trip = await getTrip(userId, request.params.id);
    if (!trip) return reply.code(404).send({ error: '行程不存在' });
    try {
      return await resolveHealthCheck({
        userId, checkId: request.params.checkId, trip,
        decisions: request.body.decisions, updatedAt: request.body.updatedAt,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 409) return reply.code(409).send({ error: (error as Error).message });
      if (status === 404) return reply.code(404).send({ error: (error as Error).message });
      throw error;
    }
  });

  app.get('/:id/weather', {
    schema: { params: IdParams, response: { 200: TripWeatherSchema, 404: Type.Object({ error: Type.String() }) } },
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const trip = await getTrip(request.user!.id, request.params.id);
    if (!trip) return reply.code(404).send({ error: '行程不存在' });
    return reply.header('Cache-Control', 'no-store').send(await getTripWeather(trip));
  });

  app.get('/', { schema: { querystring: TripListQuerySchema } }, async (request) => listTripsPage(request.user!.id, {
    offset: request.query.offset ?? 0,
    limit: request.query.limit ?? TRIP_LIST_PAGE_SIZE,
    q: request.query.q,
    city: request.query.city,
    sort: request.query.sort,
  }));
  app.post('/:id/conversation', { schema: { params: IdParams } }, async (request) => ensureTripConversation(request.user!.id, request.params.id));
  app.post('/:id/restore', { schema: { params: IdParams, body: TripOperationRequestSchema } }, async (request) =>
    restoreTrip(request.user!.id, request.params.id, request.body));
  app.post('/:id/rewind', { schema: { params: IdParams, body: TripRewindRequestSchema } }, async (request) =>
    rewindTrip(request.user!.id, request.params.id, request.body));

  // 打开弹窗直接回显已生成的成品；行程内容变更后 prompt hash 不匹配，按「尚无成品」处理
  app.get('/:id/share-image', {
    schema: { params: IdParams, querystring: TripShareImageQuerySchema, response: { 200: TripShareImageResponseSchema, 404: Type.Object({ error: Type.String() }) } },
  }, async (request, reply) => {
    const trip = await getTrip(request.user!.id, request.params.id);
    if (!trip) return reply.code(404).send({ error: '行程不存在' });
    const image = await shareImages.find(request.user!.id, trip, request.query.style ?? 'journal');
    if (!image) return reply.code(404).send({ error: '该行程尚无已生成的海报' });
    return reply.header('Cache-Control', 'no-store').send(image);
  });

  app.post('/:id/share-image', {
    schema: { params: IdParams, body: TripShareImageRequestSchema, response: { 200: TripShareImageGeneratedResponseSchema, 400: Type.Object({ error: Type.String() }), 404: Type.Object({ error: Type.String() }) } },
    bodyLimit: 1024 * 1024,
    config: { rateLimit: { max: 6, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!(await getTrip(request.user!.id, request.params.id))) return reply.code(404).send({ error: '行程不存在' });
    if (request.body.trip.id !== request.params.id) return reply.code(400).send({ error: '行程标识不一致' });
    const started = Date.now();
    try {
      const image = await shareImages.generate(request.user!.id, request.body.trip, request.body.style, request.body.regenerate);
      request.log.info({ outcome: 'success', durationMs: Date.now() - started }, '[trip-share-image]');
      return reply.header('Cache-Control', 'no-store').send(image);
    } catch (error) {
      request.log.warn({ outcome: 'failed', durationMs: Date.now() - started }, '[trip-share-image]');
      throw error;
    }
  });

  app.post('/:id/route-options', {
    schema: { params: IdParams, body: RouteOptionsRequestSchema, response: { 200: RouteOptionsResponseSchema, 404: Type.Object({ error: Type.String() }) } },
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    if (!(await getTrip(request.user!.id, request.params.id))) return reply.code(404).send({ error: '行程不存在' });
    return getRouteOptions(request.user!.id, request.body);
  });

  // JSON 导入 → 新建一条历史行程
  app.post('/', { schema: { body: TripExportSchema } }, async (request, reply) => {
    const trip = await createTrip(request.user!.id, request.body.trip);
    return reply.code(201).send(trip);
  });

  app.get('/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const trip = await getTrip(request.user!.id, request.params.id);
    if (!trip) return reply.code(404).send({ error: '行程不存在' });
    // 图片只补库内已回写的高德 POI 图（读路径零外呼）；缺失时前端回落类目占位。
    const amapPhoto = createStoredAmapPhotoLookup(trip.destination);
    const enriched = await enrichTripPhotos(trip, async name => {
      const url = await amapPhoto(name);
      return url ? { coverUrl: url, photos: [{ url }] } : null;
    });
    const missing = (value: typeof trip) => (value.overview ?? []).filter(p => p.category === 'attraction' && !p.coverUrl && !p.photos?.length).length;
    request.log.info({ tripId: trip.id, missingBefore: missing(trip), missingAfter: missing(enriched) }, '[trip-photos]');
    return enriched;
  });

  // 版本链：详情页版本切换用（含历史版本，按 version 升序）
  app.get('/:id/versions', { schema: { params: IdParams } }, async (request, reply) => {
    const chain = await listTripVersions(request.user!.id, request.params.id);
    if (!chain) return reply.code(404).send({ error: '行程不存在' });
    return chain;
  });

  // 编辑器内嵌对话（09-24 R2）：行程 → 来源会话反查；无关联会话（导入/旧数据）返回 conversationId=null
  app.get('/:id/conversation', { schema: { params: IdParams } }, async (request, reply) => {
    if (!(await getTrip(request.user!.id, request.params.id))) return reply.code(404).send({ error: '行程不存在' });
    const conversationId = await findConversationForTrip(request.user!.id, request.params.id);
    return { conversationId };
  });

  app.put('/:id', { schema: { params: IdParams, body: TripSchema } }, async (request, reply) => {
    const trip = await updateTrip(request.user!.id, request.params.id, request.body);
    if (!trip) return reply.code(404).send({ error: '行程不存在' });
    return trip;
  });

  app.patch('/:id/title', { schema: { params: IdParams, body: RenameTripSchema } }, async (request, reply) => {
    const ok = await renameTrip(request.user!.id, request.params.id, request.body.title);
    if (!ok) return reply.code(404).send({ error: '行程不存在' });
    return { ok: true };
  });

  app.delete('/:id', { schema: { params: IdParams } }, async (request, reply) => {
    const ok = await deleteTrip(request.user!.id, request.params.id);
    if (!ok) return reply.code(404).send({ error: '行程不存在' });
    return { ok: true };
  });
};
