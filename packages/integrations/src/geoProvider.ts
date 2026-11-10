// 地图服务商门面（2026-11-05 起高德单轨）：天地图已下线。
//   · 路线规划 + 地理编码 + POI 搜索 → 全部高德；高德凭据缺失时各自降级为 Null。
// 高德内部按服务分别记账（amap_service_usage：geocode/place/walk/…），互不挤占。
// 坐标系契约不变：门面进出的坐标**一律 GCJ-02**。
import { env, type MapProvider } from '@rollinggo-trip/core/env';
import { resolveAmapCredential } from '@rollinggo-trip/core/settingsService';
import { amapBudgetRemaining, amapPlaceBudgetRemaining } from '@rollinggo-trip/core/quotaService';
import { geocodeFallbackGcj02 } from './geocode';
import { geocodeActivity as amapGeocodeActivity } from './amap/geocoder';
import { createAmapRouteBreaker } from './amap/route';
import { AmapPoiSource } from './amap/poiSource';
import { getNullPoiSource } from './nullPoiSource';
import { createRouteBreaker } from './routeBreaker';
import type { GeocodedPlace, PoiSource, RouteBreaker } from './geoContracts';

/** 路线规划 + 地理编码的服务商实例（POI 源不在其中，见 resolvePoiSourceForUser） */
export interface GeoProvider {
  readonly cacheIdentity?: string; // Credential revision only, never key material.
  readonly kind: MapProvider | 'null';
  /** 是否绑定了可用的真实凭据。false 时上层整条 provider 链路跳过，只留 Nominatim → 启发式两级。 */
  readonly enabled: boolean;
  /** 活动坐标解析链（provider 级 → Nominatim → null）；@param tryAcquire 任务级额度记账回调 */
  geocodeActivity(name: string, city: string, tryAcquire: () => boolean): Promise<GeocodedPlace | null>;
  /** 每个生成任务建一个实例：熔断状态随任务生灭；凭据绑定在实例内 */
  createRouteBreaker(): RouteBreaker;
  /** 该服务商的当日剩余额度（供任务级预留量闸门；Null provider 恒为 0） */
  budgetRemaining(): Promise<number>;
}

/** 无凭据可用的降级 provider：provider 级整级跳过，保留 Nominatim → 启发式（与存量行为一致） */
export function createNullGeoProvider(): GeoProvider {
  return {
    kind: 'null',
    enabled: false,
    geocodeActivity: async (name, city) => {
      const fallback = await geocodeFallbackGcj02(name, city);
      return fallback ? { ...fallback, origin: 'nominatim' } : null;
    },
    // 前置拦截恒真：任何调用都在扣额度之前被挡下，不计失败也不消耗额度
    createRouteBreaker: () => createRouteBreaker({ estimate: async () => null, skip: () => true, label: '[no-provider]' }),
    budgetRemaining: async () => 0,
  };
}

function createAmapProvider(apiKey: string): GeoProvider {
  return {
    kind: 'amap',
    enabled: true,
    geocodeActivity: (name, city, tryAcquire) => amapGeocodeActivity(apiKey, name, city, tryAcquire),
    createRouteBreaker: () => createAmapRouteBreaker(apiKey),
    budgetRemaining: amapBudgetRemaining,
  };
}

/**
 * 路线规划 + 地理编码：高德单轨（个人 Key → 站点 Key），缺失即 Null。
 * 日额度闸门不在这里：需要按任务级预留量判断，由调用方（geoPipeline）叠加。
 */
export async function resolveGeoProvider(userId: string): Promise<GeoProvider> {
  const credential = await resolveAmapCredential(userId);
  if (credential) return { ...createAmapProvider(credential.apiKey), cacheIdentity: credential.revision };
  return createNullGeoProvider();
}

export interface ResolvedPoiSource {
  source: PoiSource;
  credentialRevision: string;
  credentialOrigin: 'personal' | 'site' | 'none';
}

/**
 * POI 源解析（设置页自检与生成链路共用，保证「看到的」就是「跑起来的」）。
 * 高德单轨：个人 Key → 站点 Key，都缺失时返回 Null 源 → 空结果 + 模型知识。
 * 配额在 AmapPoiSource 内部走 amapQuotaLedger 的 place 服务（AMAP_PLACE_DAILY_BUDGET），
 * 与路线/地理编码（LBS 共享额度）分开记账，互不挤占。
 */
export async function resolvePoiSourceForUser(userId: string): Promise<ResolvedPoiSource> {
  const credential = await resolveAmapCredential(userId);
  if (!credential) return {
    source: getNullPoiSource(),
    credentialRevision: 'amap:none',
    credentialOrigin: 'none',
  };
  return {
    source: new AmapPoiSource(credential.apiKey),
    credentialRevision: `amap:${credential.origin}:${credential.revision}`,
    credentialOrigin: credential.origin,
  };
}

/**
 * POI 源（高德 place 服务）的当日剩余额度 —— 供 orchestrator 的 POI 源闸门使用。
 * 与 `provider.budgetRemaining()`（路线/地理编码那条链）分开：place 与 LBS 分别记账。
 */
export function poiBudgetRemaining(): Promise<number> {
  return amapPlaceBudgetRemaining();
}
