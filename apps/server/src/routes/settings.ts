/**
 * 设置路由（`/api/settings`）：LLM 配置、旅行偏好、数据源自检、前端运行时配置。
 *
 * 这里的「config」回应的是前端 MapView 需要的只读信息（高德 JS Key），
 * 与 `auth/config`（注册模式、GitHub 开关）是两个不同的东西。
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Value } from '@sinclair/typebox/value';
import { SettingsPutSchema, TravelPreferencesSchema } from '@tripweaver/shared';
import { getTravelPreferences, saveTravelPreferences } from '@tripweaver/services/travelPreferencesService';
import { requireAuth } from '../auth/guard';
import { getSettingsView, upsertSettings } from '@tripweaver/core/settingsService';
import { resolveGeoProvider, resolvePoiSourceForUser } from '@tripweaver/integrations/geoProvider';
import { resolveSearchSourceForUser } from '@tripweaver/integrations/websearch/searchSource';
import { env, type MapProvider } from '@tripweaver/core/env';
import type { SourceStatus } from '@tripweaver/integrations/sourceStatus';

// 自检结果 60s 记忆化：按用户与凭据 revision 隔离，缓存中不保存凭据或数据源实例。
const STATUS_TTL_MS = 60_000;
interface SourceStatusMemo {
  at: number;
  poiCredentialRevision: string;
  searchCredentialRevision: string;
  value: { poi: SourceStatus; websearch: SourceStatus };
}

const statusMemoByUser = new Map<string, SourceStatusMemo>();

export interface SourcesStatusView {
  /** POI 搜索链：**固定天地图**，与 Key 自动决策无关（配额分工，见 env.ts 注释） */
  searchProvider: MapProvider;
  /** 路线规划 + 地理编码链：高德优先，缺 AMAP_KEY 时降级天地图；'null' = 无凭据 */
  routeProvider: MapProvider | 'null';
  /** POI 搜索源自检（原字段名 `geo`，内容一直是 POI 源 —— 改名消除与 routeProvider 的混淆） */
  poi: SourceStatus;
  websearch: SourceStatus;
}

/**
 * 调研数据源自检：真实打一次外部接口（POI 搜索源 + 搜索源），结果按用户缓存 60s。
 *
 * 缓存键不只靠 userId：还比当前凭据 revision（settings 改动后 revision 变化 → 立即重新探测），
 * 并且缓存里只存探测结论，不存凭据本身或数据源实例。
 */
export async function probeSourcesForUser(userId: string): Promise<SourcesStatusView> {
  const resolvedPoiSource = await resolvePoiSourceForUser(userId);
  const resolvedSearchSource = await resolveSearchSourceForUser(userId);
  const providers = { searchProvider: 'amap' as const, routeProvider: (await resolveGeoProvider(userId)).kind };
  const memo = statusMemoByUser.get(userId);
  if (
    memo &&
    memo.poiCredentialRevision === resolvedPoiSource.credentialRevision &&
    memo.searchCredentialRevision === resolvedSearchSource.credentialRevision &&
    Date.now() - memo.at <= STATUS_TTL_MS
  ) {
    return { ...providers, ...memo.value };
  }

  const [poi, websearch] = await Promise.all([
    resolvedPoiSource.source.selfCheck(),
    resolvedSearchSource.source.selfCheck(),
  ]);
  const value = { poi, websearch };
  statusMemoByUser.set(userId, {
    at: Date.now(),
    poiCredentialRevision: resolvedPoiSource.credentialRevision,
    searchCredentialRevision: resolvedSearchSource.credentialRevision,
    value,
  });
  return { ...providers, ...value };
}

export const settingsRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.addHook('preHandler', requireAuth);

  app.get('/', async (request) => getSettingsView(request.user!.id));

  app.get('/travel-preferences', { schema: { response: { 200: TravelPreferencesSchema } } },
    async (request) => getTravelPreferences(request.user!.id));

  app.put('/travel-preferences', {
    schema: { body: TravelPreferencesSchema, response: { 200: TravelPreferencesSchema } },
    // 整包替换必须拒绝非法原值，避免 AJV 将 null 转为空字符串后覆盖已保存备注。
    validatorCompiler: () => (body: unknown) => Value.Check(TravelPreferencesSchema, body)
      ? { value: body } : { error: new Error('偏好设置格式不正确') },
  }, async (request) => saveTravelPreferences(request.user!.id, request.body));

  app.put('/', { schema: { body: SettingsPutSchema } }, async (request) => {
    return upsertSettings(request.user!.id, request.body);
  });

  // 调研数据源自检（真实探测，60s 记忆化；未配置时由 Null 源回报降级说明）
  app.get('/sources-status', async (request) => probeSourcesForUser(request.user!.id));

  /**
   * 前端运行时配置（09-26）：目前只回高德 JS API 的 Key 与安全密钥，供 MapView 决定用哪套渲染。
   * 放在这里而不是新建 config 路由：这个模块已经是「前端运行时需要的只读信息」的家
   * （sources-status 同类），且自带 requireAuth。
   *
   * ⚠️ 这两个值**有意下发给浏览器** —— JS API 的 Key 必须在客户端可用，无法隐藏；
   * 安全性由高德的「域名白名单」保证，不靠保密。所以既不要当秘密，也不要打进日志。
   * 未配置时回空串，前端据此静默降级到 Leaflet。
   */
  app.get('/config', async () => ({
    amapJsKey: env.amapJsKey,
    amapJsSecurityCode: env.amapJsSecurityCode,
  }));
};
