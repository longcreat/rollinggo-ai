// 高德 POI 搜索适配器（2026-11-05 起为唯一 PoiSource 实现，天地图已下线）。
//
// 字段能力（相比天地图的提升）：
// · 官方图片 photos[].url —— 调研封面图直接可用。
// · 商业信息在 **v5 是 `business`**（评分/人均/营业时间/电话/别名/特色标签），个人认证 Key
//   同样返回；`biz_ext` 是 v3 的字段名，v5 传了会被静默忽略（2026-11 实测：传 biz_ext 时
//   pois 里根本没有该键）。历史数据/旧夹具仍可能带 biz_ext，解析保留兼容。
// · rating/cost 只有餐饮、酒店、景点、影院类 POI 才返回，其余类目空串是正常的。
// · 召回由关键词主导：实测 types=分类码 会把非纯景点（如「宽窄巷子」=特色商业街）
//   全部过滤掉，因此 category 参数不参与请求，类目由关键词语义承载。
//
// 配额闸门走 amapQuotaLedger 的 place 服务（AMAP_PLACE_DAILY_BUDGET，默认 5000/31/天），
// 在 amapRequest 内部原子预扣、失败不退款——与 editor_geo_usage 是两本账。
// 缓存命中不发请求也不扣配额；单轮次数上限与去重由 DetailSources 的 call() 承担。
//
// QPS：个人认证 Key 有 CUQPS 限制，实测 1 秒内第 6 次 place/text 即返回
// status=0 / infocode=10021（CUQPS_HAS_EXCEEDED_THE_LIMIT）。因此与 geocode/route/图片
// 共用同一把 350ms 串行队列，而不是各自的 100ms 队列——分开排队会在多来源并发时超限。
import { amapQueue } from './geocoder';
import { TtlCache } from '../../lib/ttlCache';
import type { PoiCategory } from '@tripweaver/shared';
import type { PoiSource, SourcedPoi } from '../geoContracts';
import type { SourceStatus } from '../sourceStatus';
import { amapRequest } from './request';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 目的地高度重合 → 24h 缓存；命中不扣配额
const MAX_RESULTS = 10;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** "lng,lat"（GCJ-02，高德原生坐标系，无需换算）→ GeoPoint */
function parseLocation(raw: unknown): SourcedPoi['location'] {
  const text = str(raw);
  const match = /^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return null;
  return { lng: Number(match[1]), lat: Number(match[2]) };
}

/**
 * 商业信息取值：v5 是 `business`，v3 遗留/旧缓存是 `biz_ext`。
 * 两者都是对象（高德个别字段会包成字符串，那种直接当没有）。
 */
function businessInfo(poi: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['business', 'biz_ext'] as const) {
    const raw = poi[key];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  }
  return {};
}

/** 高德 type 是分号分隔的多级分类「餐饮服务;中餐厅;川菜」→ 取最细一级 */
function finestType(poi: Record<string, unknown>): string {
  const parts = str(poi.type).split(';').map((part) => part.trim()).filter(Boolean);
  return (parts.at(-1) ?? '').slice(0, 40);
}

/** 高德 poi → 中立形状；字段比天地图全（评分/人均/营业时间/电话/图片） */
export function mapPoi(poi: Record<string, unknown>): SourcedPoi | null {
  const name = str(poi.name).trim();
  if (!name) return null;
  const ext = businessInfo(poi);
  const photos = Array.isArray(poi.photos) ? poi.photos : [];
  return {
    name: name.slice(0, 100),
    type: finestType(poi),
    address: str(poi.address).slice(0, 60),
    rating: str(ext.rating).slice(0, 10),
    cost: str(ext.cost).slice(0, 20),
    // 优先周维度描述（含分时段/节假日），没有才退回今日时间；v3 的 open_time 兜底。
    opentime: (str(ext.opentime_week) || str(ext.opentime_today) || str(ext.open_time)).slice(0, 120),
    tel: str(ext.tel).slice(0, 60),
    // 高德图片 http/https 混用：页面是 https，非安全 URL 会被 mixed content 拦掉；同一张图可能重复出现。
    photoUrls: [...new Set(photos
      .map((photo) => str((photo as Record<string, unknown>)?.url).replace(/^http:\/\//, 'https://'))
      .filter((url) => /^https:\/\//.test(url)))].slice(0, 3),
    location: parseLocation(poi.location),
    adcode: str(poi.adcode).slice(0, 10),
  };
}

export class AmapPoiSource implements PoiSource {
  readonly kind = 'amap' as const;
  private cache = new TtlCache<SourcedPoi[]>(CACHE_TTL_MS, 300);

  constructor(private key: string) {}

  async searchPois(category: PoiCategory, keyword: string, region: string, signal?: AbortSignal): Promise<SourcedPoi[]> {
    signal?.throwIfAborted();
    void category;   // 与天地图版一致：类目由关键词语义承载（types 过滤会误杀非纯景点）
    const cacheKey = `${region.trim().toLowerCase()}|${keyword.trim().toLowerCase()}`;
    const known = this.cache.get(cacheKey);
    if (known) return known;
    const params = new URLSearchParams({
      key: this.key,
      keywords: keyword,
      region: region,
      city_limit: 'true',
      show_fields: 'business,photos',
      page_size: String(MAX_RESULTS),
    });
    // 入共享队列：高德个人认证 Key 有 CUQPS 限制，所有 Web 服务调用必须统一排队
    const body = await amapQueue(() => amapRequest('place', params, 10_000, signal));
    signal?.throwIfAborted();
    const pois = Array.isArray(body.pois) ? (body.pois as Record<string, unknown>[]) : [];
    const mapped = pois.map(mapPoi).filter((poi): poi is SourcedPoi => poi !== null);
    this.cache.set(cacheKey, mapped);
    return mapped;
  }

  async selfCheck(): Promise<SourceStatus> {
    try {
      const params = new URLSearchParams({ key: this.key, keywords: '公园', region: '北京市', city_limit: 'true', page_size: '1' });
      const body = await amapQueue(() => amapRequest('place', params, 8_000));
      const count = Array.isArray(body.pois) ? (body.pois as unknown[]).length : 0;
      return { configured: true, checked: true, ok: count > 0, message: count > 0 ? '高德地点搜索正常' : '高德返回了空结果（可能 Key 未开通 POI 权限）' };
    } catch (error) {
      return { configured: true, checked: true, ok: false, message: error instanceof Error ? error.message : '高德地点搜索异常' };
    }
  }
}
