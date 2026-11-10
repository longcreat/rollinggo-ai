// 排程所需的地点事实补全：候选池 ResearchPoi 只带 name/category/intro，
// 排程要的停留时长 / 细粒度类型 / 主题 / 推荐分 都在 canonical_places.payload 里。
// 一次读取同城已核实目录，按显式实体身份合并；名称仅用于精确主名/别名索引。
// 查询失败降级为空 Map，不阻断生成。
import { pool } from '@tripweaver/core/db/client';
import { placeNameKey } from '@tripweaver/shared';
import { canonicalPlaceId, createPlaceIdentityIndex, placeNames, type IdentityPlace } from '@tripweaver/core/lib/placeIdentity';
import { normalizePlaceKey } from '@tripweaver/core/lib/placeKey';
import { readImageGallery, type StoredImage } from '@tripweaver/core/lib/imageGallery';
import { filterIdentityImages } from '@tripweaver/services/placeImagePolicy';

// 归一键已下沉到 lib/placeKey（09-27）；这里 re-export 保持既有导入路径不变
export { normalizePlaceKey };

export interface PlaceFacts {
  canonicalPlaceId?: string;
  name: string;
  /** canonical_places.category：8 活动类目，作为停留时长的二级兜底 */
  category: string;
  /** canonical_places.source：goldset | xhs | amap | manual —— 选点权重要用它给金集加分 */
  source: string;
  /** payload.typicalVisitMinutes：上游抽到的真实停留时长 */
  visitMinutes?: number;
  /** payload.xhsPlaceType：细粒度地点类型 */
  placeType?: string;
  /** canonical_places 的坐标（GCJ-02，1494/1494 全覆盖）；调研阶段没抓到坐标时的排程兜底 */
  lng?: number;
  lat?: number;
  /** payload.adcode：行政区划码，transit 路径规划需要 */
  adcode?: string;
  /** payload.themes：社区主题标签，用于生成每天主题 */
  themes: string[];
  /** 缺失保持未知；合并取已知值的 max，真实 0 不等于未知。 */
  recommendScore?: number;
  /** 缺失保持未知；同一来源的别名不可重复计数，取已知最大值。 */
  mentionCount?: number;
  /** 从 research_evidence 文本挖出的闭馆表述（如「周一闭馆」，截 60 字）：候选无高德 openTime 时的闭馆检测兜底（09-23） */
  closureText?: string;
  /** payload.openHours 渲染出的开闭馆文本（09-27，如「09:00-17:00；周一闭馆」）。
   *  上游给的是结构化数据（closedWeekdays 是明确的星期数字），排程能精确避让 —— 优先于自由文本的 closureText。 */
  openTime?: string;
  /** payload.aliases：已确认的同城同义名称，用于身份精确解析。 */
  aliases: string[];
  /** payload.coverImage：库内封面（09-27），形如 `xhs/杭州/{placeId}/00.webp` 的相对 key。
   *  11-05 起展示图统一走高德 POI，此字段只保留导入治理与历史数据，不再作为候选封面来源。 */
  coverImage?: string;
  imageGallery?: StoredImage[];
  /** payload.amapPhoto：高德 POI 图片命中后的回写（09-27）。存完整 https URL，
   *  下次直接用不再消耗稀缺的搜索配额（个人 5,000/月）。 */
  amapPhoto?: string;
}

interface FactRow extends IdentityPlace {
  name: string;
  category: string;
  source: string;
  lng: number | null;
  lat: number | null;
}

// normalizePlaceKey（09-23）定义在 lib/placeKey.ts，上方已 re-export

/** 防御性读取：payload 是 jsonb，字段类型不由 DB 保证 */
function numberField(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

/** 星期标签（索引 = Date.getDay()：0=周日），与 packages/shared/src/openHours.ts 的 WEEKDAY_LABELS 同序 */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/**
 * payload.openHours → openTime 文本（09-27）。
 * 上游给的是结构化对象（openTime/closeTime/closedWeekdays/note），渲染成与高德 openTime 同构的
 * 自由文本后，排程的 isClosedOnDate 与 feasibility 的闭馆日检测可直接复用，不必改共享函数签名。
 * 字段缺失或类型不符 → 返回 undefined（不编造）。
 */
export function renderOpenHours(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const hours = raw as Record<string, unknown>;
  // v2 归属待审字段不是营业承诺；不能靠遗留值或 review 原文重新捏造闭馆规则。
  if (hours.version === 2 && (hours.status !== 'attributed' || hours.scope !== 'place')) return undefined;
  const open = typeof hours.openTime === 'string' ? hours.openTime.trim() : '';
  const close = typeof hours.closeTime === 'string' ? hours.closeTime.trim() : '';
  const days = Array.isArray(hours.closedWeekdays)
    ? [...new Set(hours.closedWeekdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort(
        (a, b) => a - b,
      )
    : [];
  const note = typeof hours.note === 'string' ? hours.note.trim() : '';
  const parts: string[] = [];
  if (open && close) parts.push(`${open}-${close}`);
  else if (open) parts.push(`${open} 起`);
  else if (close) parts.push(`${close} 止`);
  if (days.length) parts.push(`${days.map((d) => WEEKDAY_CN[d]!).join('、')}闭馆`);
  if (note) parts.push(note);
  return parts.length ? parts.join('；') : undefined;
}

function toFacts(row: FactRow): PlaceFacts {
  const payload = row.payload && typeof row.payload === 'object' ? (row.payload as Record<string, unknown>) : {};
  const facts: PlaceFacts = {
    canonicalPlaceId: canonicalPlaceId(row),
    name: row.name,
    category: row.category,
    source: row.source,
    themes: stringArrayField(payload, 'themes'),
    recommendScore: numberField(payload, 'recommendScore'),
    mentionCount: numberField(payload, 'mentionCount'),
    aliases: stringArrayField(payload, 'aliases'),
  };
  const visit = numberField(payload, 'typicalVisitMinutes');
  if (visit !== undefined) facts.visitMinutes = visit;
  const placeType = payload.xhsPlaceType;
  if (typeof placeType === 'string' && placeType) facts.placeType = placeType;
  // 结构化开闭馆（09-27）：上游规则挖掘产物，带明确的 closedWeekdays
  const openTime = renderOpenHours(payload.openHours);
  if (openTime) facts.openTime = openTime;
  if (typeof row.lng === 'number' && typeof row.lat === 'number') {
    facts.lng = row.lng;
    facts.lat = row.lat;
  }
  if (typeof payload.adcode === 'string' && payload.adcode) facts.adcode = payload.adcode;
  const gallery = filterIdentityImages(row, readImageGallery(payload.imageGallery));
  const cover = payload.imageIdentity === undefined ? payload.coverImage : gallery[0]?.key;
  if (typeof cover === 'string' && cover.trim()) facts.coverImage = cover.trim();
  if (gallery.length) facts.imageGallery = gallery;
  const amapPhoto = payload.amapPhoto;
  if (payload.imageIdentity === undefined && typeof amapPhoto === 'string' && amapPhoto.startsWith('https://')) facts.amapPhoto = amapPhoto;
  return facts;
}

/** source 优先级：金集 > 社区 > 高德 > 手工（合并时取最高优先来源的标签） */
const SOURCE_RANK: Record<string, number> = { goldset: 0, xhs: 1, amap: 2, manual: 3 };

/** 同实体多行合并：质量与热度取 max，themes 并集，坐标取有值行；v2 调用方只传权威主行。 */
export function mergeFacts(members: PlaceFacts[]): PlaceFacts {
  const scores = members.map((f) => f.recommendScore).filter((n): n is number => n !== undefined);
  const mentions = members.map((f) => f.mentionCount).filter((n): n is number => n !== undefined);
  const base = members.reduce((best, f) => ((SOURCE_RANK[f.source] ?? 9) < (SOURCE_RANK[best.source] ?? 9) ? f : best), members[0]!);
  const merged: PlaceFacts = {
    ...base,
    name: base.name,
    themes: [...new Set(members.flatMap((f) => f.themes))],
    recommendScore: scores.length ? Math.max(...scores) : undefined,
    mentionCount: mentions.length ? Math.max(...mentions) : undefined,
    aliases: [...new Set(members.flatMap((f) => f.aliases))],
  };
  const visits = members.map((f) => f.visitMinutes).filter((v): v is number => v !== undefined);
  if (visits.length) merged.visitMinutes = Math.max(...visits);
  const withCoords = members.find((f) => f.lng !== undefined && f.lat !== undefined);
  if (withCoords) {
    merged.lng = withCoords.lng;
    merged.lat = withCoords.lat;
  }
  const placeType = members.find((f) => f.placeType)?.placeType;
  if (placeType) merged.placeType = placeType;
  // 开闭馆事实冲突时保持未知，不能任取一个成员。
  const openTimes = [...new Set(members.map(f => f.openTime).filter(Boolean))];
  merged.openTime = openTimes.length === 1 ? openTimes[0] : undefined;
  // 只在已经确认的同实体成员中复用照片。
  const cover = members.find((f) => f.coverImage)?.coverImage;
  if (cover) merged.coverImage = cover;
  const gallery = members.find((f) => f.imageGallery?.length)?.imageGallery;
  if (gallery) {
    merged.imageGallery = gallery;
    merged.coverImage = gallery[0]!.key;
  }
  const amapPhoto = members.find((f) => f.amapPhoto)?.amapPhoto;
  if (amapPhoto) merged.amapPhoto = amapPhoto;
  return merged;
}

/**
 * 全城事实索引：按实体 ID 分组，再将无歧义的主名与别名指向主事实。
 * 返回完整索引；需要按候选原名返回子集时使用 loadPlaceFacts。
 * 查询失败返回空 Map —— 调用方按「无事实」处理（类型表兜底）。
 * city 必传：跨城市同名地点会因缺 city 过滤而串味（同 retrieveContext 的 city 语义）。
 */
export async function loadCityPlaceFacts(city: string): Promise<Map<string, PlaceFacts>> {
  if (!city.trim()) return new Map();
  try {
    const { rows } = await pool.query<FactRow>(
      `SELECT id, city, name, category, source, lng, lat, payload
       FROM canonical_places
       WHERE city = $1 AND verified = true AND payload->>'canonicalRedirectTo' IS NULL`,
      [city],
    );
    // 名称可以索引同一个实体；不同实体共享别名时不暴露不确定的事实。
    const index = createPlaceIdentityIndex(rows);
    const byId = new Map(index.groups.map(members => {
      const root = members.find(row => row.id === canonicalPlaceId(row)
        && (row.payload?.identity as Record<string, unknown> | undefined)?.version === 2);
      return [canonicalPlaceId(members[0]!), mergeFacts((root ? [root] : members).map(toFacts))];
    }));
    const mergedByKey = new Map<string, PlaceFacts>();
    for (const row of rows) for (const name of placeNames(row)) {
      const resolution = index.resolve(city, name);
      if (resolution.status === 'resolved') {
        const facts = byId.get(resolution.canonicalPlaceId);
        if (facts) mergedByKey.set(placeNameKey(name), facts);
      }
    }

    // 闭馆文本挖掘（09-23）：evidence 里的「周X闭馆/不开放/休息」表述，补高德 openTime 的覆盖缺口
    // （只覆盖 search_pois 来源）。排除「不休息」误报；挖不到就不设字段，绝不编造。
    const { rows: closureRows } = await pool.query<{ id: string; content: string }>(
      `SELECT DISTINCT ON (p.id) p.id, left(e.content, 60) AS content
       FROM research_evidence e JOIN canonical_places p ON p.id = e.place_id
       WHERE p.city = $1
         AND p.payload->>'canonicalRedirectTo' IS NULL
         AND COALESCE(p.payload->'identity'->>'kind', '') <> 'complex'
         AND (p.payload->'openHours'->>'version') IS DISTINCT FROM '2'
         AND e.content ~ '周[一二三四五六日天][^；;。]{0,8}(闭馆|不开放|休息)'
         AND e.content !~ '不休息'
       ORDER BY p.id, e.fetched_at DESC`,
      [city],
    );
    const closureByKey = new Map(closureRows.map((row) => [row.id, row.content]));

    for (const facts of mergedByKey.values()) {
      const closure = facts.canonicalPlaceId ? closureByKey.get(facts.canonicalPlaceId) : undefined;
      if (closure) facts.closureText = closure;
    }
    return mergedByKey;
  } catch (err) {
    console.warn(`[placeFacts] 地点事实补全失败，排程按类型表兜底：${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

/** 批量候选查询仍按传入名称返回；全城索引与候选子集不能混作同一个缓存。 */
export async function loadPlaceFacts(names: readonly string[], city: string): Promise<Map<string, PlaceFacts>> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!unique.length || !city.trim()) return new Map();
  const index = await loadCityPlaceFacts(city);
  const result = new Map<string, PlaceFacts>();
  for (const name of unique) {
    const facts = index.get(placeNameKey(name));
    if (facts) result.set(name, facts);
  }
  return result;
}

/**
 * 高德图片命中后的回写（09-27）：`v5/place/text` 属稀缺的「基础搜索服务」配额（个人 5,000/月），
 * 写回 `payload.amapPhoto` 后同一地点终身只消耗一次。
 * 按同城主名或已确认别名唯一解析到实体，已有值不覆盖；
 * 任何失败只 warn，绝不阻断生成（回写只是优化）。
 */
export async function saveAmapPhoto(city: string, name: string, url: string): Promise<void> {
  const key = placeNameKey(name);
  if (!key || !city.trim() || !url.startsWith('https://')) return;
  try {
    const { rows } = await pool.query<IdentityPlace>(
      `SELECT id, city, name, payload FROM canonical_places WHERE city = $1 AND payload->>'canonicalRedirectTo' IS NULL`,
      [city],
    );
    const result = createPlaceIdentityIndex(rows).resolve(city, name);
    if (result.status !== 'resolved' || result.place.payload?.amapPhoto || result.place.payload?.imageIdentity !== undefined) return;
    await pool.query(
      `UPDATE canonical_places
          SET payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('amapPhoto', $2::text)
        WHERE id = $1 AND NOT (coalesce(payload, '{}'::jsonb) ? 'amapPhoto')
          AND NOT (coalesce(payload, '{}'::jsonb) ? 'imageIdentity')`,
      [result.place.id, url],
    );
  } catch (err) {
    console.warn(
      `[placeFacts] 高德图片回写失败（不影响本次生成）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
