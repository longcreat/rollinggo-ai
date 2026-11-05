// 小红书社区地点库查询（数据由 xhs-travel-pipeline 导入 canonical_places + research_evidence）
//
// 设计对齐现有源骨架：TTL 缓存 + 任何故障不抛错（回 null/空数组）+ 不依赖外部服务（纯 SQL）。
// 与 reservationSeeds 的分工：
//   reservationSeeds = 全国热门预约景点（静态种子表，官方渠道链接）
//   xhsPlaceService  = 单城社区口碑（PG，含图片 OCR 的价格/预约/营业时间 + 避坑 + 原笔记链接）
import { pool } from '../db/client';
import { createPlaceIdentityIndex } from '../lib/placeIdentity';

const XHS_SOURCE = 'xhs';
const CACHE_TTL_MS = 10 * 60 * 1000; // 单次生成内数据不变，10 分钟足够

export interface XhsPlacePayload extends Record<string, unknown> {
  content?: unknown;
  xhsPlaceType?: string;
  themes?: string[];
  address?: string;
  adcode?: string;
  mentionCount?: number;
  recommendScore?: number;
  typicalVisitMinutes?: number;
  price?: string;
  hours?: string;
  reservation?: string;
  reservationNote?: string;
  tips?: string[];
  topReasons?: string[];
}

export interface XhsPlace {
  id: string;
  name: string;
  category: string;
  lat: number | null;
  lng: number | null;
  payload: XhsPlacePayload;
}

export interface XhsEvidence {
  kind: string;
  content: string;
  sourceUrl: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const placeCache = new Map<string, CacheEntry<XhsPlace | null>>();
const evidenceCache = new Map<string, CacheEntry<XhsEvidence[]>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    map.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  if (map.size > 500) map.clear(); // 简单容量保护
  map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * 按同城已确认的名称/别名解析；歧义与未命中返回空，不能按子串借用事实。
 * 任何异常回 null，不抛错到上层。
 */
export async function findXhsPlace(name: string, city?: string): Promise<XhsPlace | null> {
  const trimmed = name.trim();
  if (!trimmed || !city?.trim()) return null;
  const key = `${city ?? ''}|${trimmed}`;
  const cached = cacheGet(placeCache, key);
  if (cached !== undefined) return cached;

  try {
    const { rows } = await pool.query<{
      id: string;
      city: string;
      name: string;
      category: string;
      lat: number | null;
      lng: number | null;
      payload: XhsPlacePayload | null;
    }>(
      `SELECT id, city, name, category, lat, lng, payload
         FROM canonical_places
        WHERE source = $2
          AND payload->>'canonicalRedirectTo' IS NULL
          AND city = $1`,
      [city, XHS_SOURCE],
    );
    const resolution = createPlaceIdentityIndex(rows).resolve(city, trimmed);
    const row = resolution.status === 'resolved' ? resolution.place : undefined;
    const result: XhsPlace | null = row
      ? {
          id: row.id,
          name: row.name,
          category: row.category,
          lat: row.lat,
          lng: row.lng,
          payload: row.payload ?? {},
        }
      : null;
    cacheSet(placeCache, key, result);
    return result;
  } catch {
    return null; // 库不可用时不阻断生成
  }
}

/** 取该地点的社区语料（推荐理由/避坑/价格/预约），按 kind 过滤 */
export async function findXhsEvidence(
  placeId: string,
  kinds: string[] = [],
  limit = 6,
): Promise<XhsEvidence[]> {
  const key = `${placeId}|${kinds.join(',')}|${limit}`;
  const cached = cacheGet(evidenceCache, key);
  if (cached !== undefined) return cached;

  try {
    const params: unknown[] = [placeId, limit];
    let kindFilter = '';
    if (kinds.length) {
      params.push(kinds);
      kindFilter = ` AND kind = ANY($3::text[])`;
    }
    const { rows } = await pool.query<{ kind: string; content: string; source_url: string }>(
      `SELECT kind, content, source_url
         FROM research_evidence
        WHERE place_id = $1${kindFilter}
        ORDER BY kind, fetched_at DESC
        LIMIT $2`,
      params,
    );
    const result: XhsEvidence[] = rows.map((r) => ({
      kind: r.kind,
      content: r.content,
      sourceUrl: r.source_url,
    }));
    cacheSet(evidenceCache, key, result);
    return result;
  } catch {
    return [];
  }
}

/** 按分类检索社区地点（如「自然」→ 自然风光类），推荐分降序 */
export async function findXhsPlacesByCategory(
  city: string,
  category: string,
  limit = 10,
): Promise<XhsPlace[]> {
  try {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      category: string;
      lat: number | null;
      lng: number | null;
      payload: XhsPlacePayload | null;
    }>(
      `SELECT id, name, category, lat, lng, payload
         FROM canonical_places
        WHERE source = $3
          AND payload->>'canonicalRedirectTo' IS NULL
          AND $1 LIKE '%' || city || '%'
          AND category = $2
        ORDER BY COALESCE((payload->>'recommendScore')::numeric, 0) DESC
        LIMIT $4`,
      [city, category, XHS_SOURCE, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      lat: r.lat,
      lng: r.lng,
      payload: r.payload ?? {},
    }));
  } catch {
    return [];
  }
}

/** 库状态（设置页/诊断）：城市与地点数 */
export async function xhsPlaceStats(): Promise<{ cities: { city: string; n: number }[]; evidence: number }> {
  try {
    const places = await pool.query<{ city: string; n: number }>(
      `SELECT city, count(*)::int AS n FROM canonical_places WHERE source = $1 AND payload->>'canonicalRedirectTo' IS NULL GROUP BY city ORDER BY n DESC`,
      [XHS_SOURCE],
    );
    const ev = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM research_evidence`);
    return { cities: places.rows, evidence: ev.rows[0]?.n ?? 0 };
  } catch {
    return { cities: [], evidence: 0 };
  }
}
