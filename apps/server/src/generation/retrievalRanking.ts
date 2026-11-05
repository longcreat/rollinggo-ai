// 检索结果的实体归并与规则打分（placeRetrieval 的排序层，纯函数、零 IO）。
//
// ┌─ 打分公式（rankPlaces 里的那个表达式，拆开就是这些项）──────────────┐
// │ 正向：                                                              │
// │   poiScore(...)         热度基础分（推荐分 + 提及次数归一化，见 scheduling/score.ts）│
// │   exact ? +200          字面完全匹配 —— 权重最大，保证点名搜得到         │
// │   prefix ? +65          前缀匹配（「故宫」→「故宫博物院」）              │
// │   (1-distance)*120      向量余弦距离换算（只有向量命中才带 distance）      │
// │   theme ? +45           命中用户偏好主题                                │
// │   category ? +25        命中偏好类目                                    │
// │   coord ? +8            有合法坐标（顺手照顾可排程）                      │
// │ 负向：                                                              │
// │   !exact && detail ? -100   机位/东门/停车场这类拍照点，不点名就排后面     │
// │   !exact && parent ? -45    子景点降权，避免「故宫角楼」压过「故宫」        │
// └───────────────────────────────────────────────────────────────┘
//
// ┌─ 实体归并 + 多样性（两个容易看漏的设计）─────────────────────────┐
// │ groupPlaces：按 canonicalPlaceId 把同一地点的多行归并成一个实体，      │
// │   推荐分取 max、坐标取第一个有值的。名称/别名只用于召回，不改实体身份。   │
// │ rankPlaces 尾部 while 循环：按 0.03°✕0.04° 的地理格子计数，同格子已选     │
// │   N 个就扣 min(24, N*8)。否则搜「美食」会返回某个商圈里 8 家餐厅，      │
// │   对「一天要跑多个地方」的行程毫无用处。                                │
// └───────────────────────────────────────────────────────────────┘
import type { PoiCategory } from '@tripweaver/shared';
import { normalizePlaceKey } from '../lib/placeKey';
import { canonicalPlaceId, placeNames } from '../lib/placeIdentity';
import { placeNameKey } from '@tripweaver/shared';
import { poiScore, scoreMaxima } from './scheduling/score';

export interface PlaceRow {
  id: string;
  city: string;
  name: string;
  category: string;
  verified: boolean;
  source: string;
  lat: number | null;
  lng: number | null;
  payload: Record<string, unknown> | null;
  distance?: number;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())) : [];
}

export function placeCategory(category: string): PoiCategory {
  if (category === '美食' || category === 'food') return 'food';
  if (category === '住宿' || category === 'hotel') return 'hotel';
  return 'attraction';
}

export function categoryValues(category?: PoiCategory): string[] {
  if (category === 'food') return ['美食', 'food'];
  if (category === 'hotel') return ['住宿', 'hotel'];
  if (category === 'attraction') return ['文化', '自然', '娱乐', '购物', '其他', '景点', 'attraction'];
  return [];
}

const PREFERENCE_CATEGORIES: Record<string, string[]> = {
  历史文化: ['文化'], 历史人文: ['文化'], 历史古迹: ['文化'], 自然风光: ['自然'],
  自然: ['自然'], 文化: ['文化'], 人文: ['文化'], 美食: ['美食'], 购物: ['购物'], 亲子: ['自然', '娱乐'], 夜生活: ['娱乐'],
};

export function preferenceCategories(terms: readonly string[]): string[] {
  return [...new Set(terms.flatMap((term) => PREFERENCE_CATEGORIES[term] ?? []))];
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function scoreFacts(row: PlaceRow) {
  return { source: row.source, recommendScore: numeric(row.payload?.recommendScore), mentionCount: numeric(row.payload?.mentionCount) };
}

export interface RankedPlace {
  row: PlaceRow;
  /** 同一实体的原始行 ID；只合并同一地点的证据。 */
  ids: string[];
  aliases: string[];
}

/** 按持久身份归并同一实体的多行；名称与别名只用于召回，不改变实体身份。 */
export function groupPlaces(rows: readonly PlaceRow[]): RankedPlace[] {
  const groups: RankedPlace[] = [];
  for (const row of rows) {
    // 只按持久身份归并；名称和别名用来召回，不能临时改变实体身份。
    const entityId = canonicalPlaceId(row);
    const group = groups.find((group) => group.row.city === row.city && canonicalPlaceId(group.row) === entityId);
    if (group) {
      group.ids.push(row.id);
      group.aliases.push(...placeNames(row));
      const preferred = row.id === entityId && group.row.id !== entityId
        || (group.row.id !== entityId && row.source === 'goldset' && group.row.source !== 'goldset');
      const base = preferred ? row : group.row;
      const supplement = preferred ? group.row : row;
      const present = (value: Record<string, unknown> | null) => Object.fromEntries(Object.entries(value ?? {}).filter(([, v]) => v != null));
      const scores = [numeric(base.payload?.recommendScore), numeric(supplement.payload?.recommendScore)].filter((n): n is number => n !== undefined);
      const mentions = [numeric(base.payload?.mentionCount), numeric(supplement.payload?.mentionCount)].filter((n): n is number => n !== undefined);
      group.row = { ...base, payload: { ...present(supplement.payload), ...present(base.payload),
        themes: [...new Set([...stringList(base.payload?.themes), ...stringList(supplement.payload?.themes)])],
        ...(scores.length ? { recommendScore: Math.max(...scores) } : {}),
        ...(mentions.length ? { mentionCount: Math.max(...mentions) } : {}),
      },
        ...([base.distance, supplement.distance].some((d) => typeof d === 'number')
          ? { distance: Math.min(...[base.distance, supplement.distance].filter((d): d is number => typeof d === 'number')) } : {}),
        ...(base.lat == null || base.lng == null ? { lat: supplement.lat, lng: supplement.lng } : {}) };
    } else {
      const next = { row, ids: [row.id], aliases: placeNames(row) };
      groups.push(next);
    }
  }
  return groups;
}

/**
 * 字面一无所获时的排序：没有 exact/prefix 信号，热度分与子景点降权都是噪声，直接用向量距离。
 * 无 distance 的候选排在最后，同距离按名称与 ID 稳定排序。
 */
export function rankPlacesByDistance(rows: readonly PlaceRow[], limit: number): RankedPlace[] {
  return groupPlaces(rows)
    .sort((a, b) => (a.row.distance ?? Number.POSITIVE_INFINITY) - (b.row.distance ?? Number.POSITIVE_INFINITY)
      || a.row.name.localeCompare(b.row.name, 'zh-CN') || a.row.id.localeCompare(b.row.id))
    .slice(0, limit);
}

/** 有界 SQL 结果内归并实体与排序，不把任意包含关系当作同一地点。 */
export function rankPlaces(rows: readonly PlaceRow[], terms: readonly string[], preferences: readonly string[], limit: number): RankedPlace[] {
  const maxima = scoreMaxima(rows.map(scoreFacts));
  const exactKeys = new Set(terms.map(placeNameKey));
  const categories = preferenceCategories([...terms, ...preferences]);
  const groups = groupPlaces(rows);
  const candidates = groups.map((group) => {
    const row = group.row;
    // group.aliases 已排除 complex 子项名；组成名称只能召回父项，不能获得同义精确命中奖励。
    const exact = group.aliases.some((name) => exactKeys.has(placeNameKey(name)));
    const prefix = terms.some((term) => group.aliases.some((name) => name.startsWith(term)));
    const themes = stringList(row.payload?.themes);
    const theme = [...terms, ...preferences].some((term) => themes.includes(term));
    const detail = row.payload?.xhsPlaceType === 'photo_spot' || /(?:[东西南北]门|入口|出口|机位|倒影|转角|停车场)/.test(row.name);
    // 子景点只降权，不串用父景点事实；点名时仍优先返回。
    const parent = groups.find((other) => other !== group && normalizePlaceKey(other.row.name).length >= 2
      && normalizePlaceKey(row.name).startsWith(normalizePlaceKey(other.row.name)));
    const coord = typeof row.lat === 'number' && typeof row.lng === 'number'
      && Number.isFinite(row.lat) && Number.isFinite(row.lng) && (row.lat !== 0 || row.lng !== 0);
    return { group, score: poiScore(scoreFacts(row), maxima) + (exact ? 200 : prefix ? 65 : 0)
      + (typeof row.distance === 'number' ? (1 - Math.max(0, Math.min(1, row.distance))) * 120 : 0)
      + (theme ? 45 : 0) + (categories.includes(row.category) ? 25 : 0) + (coord ? 8 : 0)
      - (!exact && detail ? 100 : 0) - (!exact && parent ? 45 : 0),
    cell: coord ? `${row.city}|${Math.floor(row.lat! / 0.03)}|${Math.floor(row.lng! / 0.04)}` : '' };
  });
  const selected: RankedPlace[] = [];
  const cells = new Map<string, number>();
  while (candidates.length && selected.length < limit) {
    const value = (item: typeof candidates[number]) => item.score - Math.min(24, (cells.get(item.cell) ?? 0) * 8);
    candidates.sort((a, b) => value(b) - value(a) || a.group.row.name.localeCompare(b.group.row.name, 'zh-CN') || a.group.row.id.localeCompare(b.group.row.id));
    const next = candidates.shift()!;
    selected.push(next.group);
    if (next.cell) cells.set(next.cell, (cells.get(next.cell) ?? 0) + 1);
  }
  return selected;
}
