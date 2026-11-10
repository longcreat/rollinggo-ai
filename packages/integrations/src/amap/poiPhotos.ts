// 高德 POI 图片（09-27，10-05 收敛为唯一图片来源）。
//
// 为什么只用它：外部图库（Pexels/Pixabay/Unsplash/Commons）在国内景点命中率低、与具体地点
// 对应关系弱，而上游导入图库只覆盖少数城市；高德 POI 自带的 photos 是唯一「国内可访问 +
// 能精确对应景点 + 每个 POI 有多张」的来源（实测「西湖」→「杭州西湖风景名胜区」+ 3 张
// store.is.autonavi.com 图片，无 Referer 校验，可直接热链）。
//
// 配额纪律（关键）：`v5/place/text` 属高德「基础搜索服务」，个人认证仅 **5,000/月**
// （对比 `v3/geocode/geo` 的「基础LBS服务」150,000/月 —— 见 geocoder.ts 的降级顺序注释）。
// 因此这里四重限流：只在 search_pois 旁路与库内回写都没图时才被调用、单次生成有上限、
// place 服务的持久化日预算、命中后由调用方回写 `canonical_places.payload.amapPhoto`
// —— 同一地点终身只花一次配额。
// `calls` 暴露任务尝试统计；真实外呼预算由 amapRequest 的持久账本计量。
import { TtlCache } from '@tripweaver/core/lib/ttlCache';
import { normalizePlaceKey } from '@tripweaver/core/lib/placeKey';
import { amapQueue } from './geocoder';
import { amapRequest } from './request';

const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 单次生成的真实调用上限。高德搜索配额稀缺（个人 5,000/月），只给最难的几个候选补图 */
const MAX_PER_TASK = 3;
/** 每个 POI 最多取几张：与 ResearchPoi.photos 的 schema 上限一致 */
const MAX_PHOTOS = 3;
const cache = new TtlCache<string[]>(CACHE_TTL_MS, 300);

export interface AmapPoiRecord {
  name?: unknown;
  type?: unknown;
  photos?: unknown;
}

/**
 * 景点类型白名单（取高德 `type` 的第一段大类）。
 * 用白名单而不是黑名单：搜「龙井村」高德会先返回「龙井村(公交站)」，搜「宋城」会返回路名 ——
 * 这类 POI 同样带 photos，不挡就会把公交站/道路的图当作景点封面。
 * 实测景点落在「风景名胜」（国家级景点/公园/寺庙）、「体育休闲服务」（体育场馆）两类。
 */
const PLACE_TYPE_PREFIXES = ['风景名胜', '体育休闲服务', '科教文化服务', '购物服务'] as const;

export interface AmapPoiPhotoQuery {
  /** 地点名，作为 keywords */
  name: string;
  /** 城市名，作为 region 消歧 */
  city: string;
}

export interface AmapPoiPhotoLookup {
  /** 返回 https 图片 URL（按 POI 返回顺序，去重后 ≤3 张）；未命中、超限或失败都是空数组 */
  photosFor(query: AmapPoiPhotoQuery): Promise<string[]>;
  /** 已发生的真实 place/text 调用数（orchestrator 计入 amapCalls） */
  readonly calls: number;
}

/** 高德图片 URL 有时是 http（实测混用）→ 统一 https，否则 https 页面会被 mixed content 拦掉 */
function httpsOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const url = raw.trim();
  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://')) return `https://${url.slice(7)}`;
  return '';
}

/**
 * 地点名切段（每 2 字一段，尾段可 1 字）。
 * 用于容忍 POI 名中间插词：「西溪湿地」→ ['西溪','湿地'] 能对上「西溪国家湿地公园」。
 */
function segmentsOf(key: string): string[] {
  if (key.length <= 3) return [key];
  const out: string[] = [];
  for (let i = 0; i < key.length; i += 2) out.push(key.slice(i, i + 2));
  return out;
}

/** 名字闸门：完全相同、或以地点名结尾，或地点名的各段按序出现（容忍中间插词） */
function nameMatches(poiName: string, wanted: string): boolean {
  // endsWith 而不是 includes：避免「西湖区××」被当成「西湖」
  if (poiName === wanted || poiName.endsWith(wanted)) return true;
  const segments = segmentsOf(wanted);
  if (segments.length < 2) return false;
  let cursor = 0;
  for (const segment of segments) {
    const at = poiName.indexOf(segment, cursor);
    if (at < 0) return false;
    cursor = at + segment.length;
  }
  return true;
}

/** 类型闸门：type 缺失或不在白名单一律拒绝（「宁可不插图」） */
function typeAllowed(raw: unknown): boolean {
  const head = typeof raw === 'string' ? raw.split(';')[0]?.trim() ?? '' : '';
  return PLACE_TYPE_PREFIXES.some((prefix) => head === prefix);
}

/**
 * 在已取回的 POI 里挑图：名字闸门 + 类型闸门都过才算命中，
 * 取该 POI 的 `photos` 前若干张（去重、≤3）；首个命中 POI 没图就继续看下一个候选。
 * 纯函数，方便单测不发请求。
 */
export function pickPhotos(pois: readonly AmapPoiRecord[], name: string, max = MAX_PHOTOS): string[] {
  const wanted = normalizePlaceKey(name);
  if (wanted.length < 2) return [];
  for (const poi of pois) {
    const poiName = typeof poi.name === 'string' ? normalizePlaceKey(poi.name) : '';
    if (!nameMatches(poiName, wanted)) continue;
    if (!typeAllowed(poi.type)) continue;
    const photos = Array.isArray(poi.photos) ? poi.photos : [];
    const urls: string[] = [];
    for (const photo of photos) {
      const url = httpsOf((photo as { url?: unknown } | null)?.url);
      if (url && !urls.includes(url)) urls.push(url);
      if (urls.length >= max) break;
    }
    if (urls.length) return urls;
  }
  return [];
}

interface LookupOutcome {
  ok: boolean;
  urls: string[];
}

/**
 * 进程级缓存 + 共享高德串行队列（与 geocode/route 同一队列，避免把个人 3 QPS 打满）。
 * 未配置 apiKey → Null 行为。requestsLeft 由单次生成持有，跨任务不共享。
 */
export function createAmapPoiPhotoLookup(apiKey: string, requestsLeft = MAX_PER_TASK): AmapPoiPhotoLookup {
  let remaining = requestsLeft;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async photosFor(query) {
      if (!apiKey) return [];
      const cacheKey = `${query.city}|${query.name}`.trim().toLowerCase();
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return cached;
      if (remaining <= 0) return [];
      remaining -= 1;
      calls += 1;
      const outcome = await amapQueue<LookupOutcome>(async () => {
        try {
          const params = new URLSearchParams({
            key: apiKey,
            keywords: query.name.slice(0, 80),
            show_fields: 'photos',
            page_size: '3',
          });
          if (query.city) {
            params.set('region', query.city.slice(0, 40));
            params.set('city_limit', 'true');
          }
          const body = await amapRequest('place', params, TIMEOUT_MS);
          const pois = Array.isArray(body.pois) ? (body.pois as AmapPoiRecord[]) : [];
          return { ok: true, urls: pickPhotos(pois, query.name) };
        } catch {
          return { ok: false, urls: [] };
        }
      });
      if (outcome.ok) cache.set(cacheKey, outcome.urls); // 含空数组：确认无图的地点 24h 内不再打
      return outcome.urls;
    },
  };
}
