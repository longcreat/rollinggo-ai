// 长途点距离情报（远郊编排层2 预防）：编排 Agent 分天前的确定性预计算，纯函数、无 IO、零外呼。
// 动机：规划 Agent 调 add_activity(dayIndex) 时手上没有坐标（geoPipeline 在编排后才统一解析），
// 不知道某候选距市区大部队 85km，会把远郊点与市区晚餐/夜景混排同一天。本模块在调研结束后
// 按估算通勤时长把候选池里的「长途点」标级，由 prompts 注入规划 prompt，从源头预防混排。
// 参照点 = 候选池有坐标 POI 的坐标中位中心（lat/lng 各取中位数，代表「POI 主体/市区大部队」；
// 与 eval geo gate 的离群判定同构，城市无关）。坐标来自调研阶段 search_pois 返回值的旁路捕获
// （仅任务内存短暂持有，不入候选池 schema、不随行程持久化——高德协议 3.5 仅存活动坐标点值）。
// 阈值唯一事实源：LONG_HAUL_THRESHOLDS；速度模型直接复用 estimateTransit（勿另写一套）。
import { LONG_HAUL_THRESHOLDS, estimateTransit, type LegMode, type ResearchPoi } from '@tripweaver/shared';

/** 长途点分级：exclusive 强独占级（须独占一天）/ longHaul 长途级（当天须同方向顺路） */
export type LongHaulTier = 'exclusive' | 'longHaul';

export interface LongHaulPoi {
  name: string;
  /** 到候选池中位中心的估算单程通勤时长（分钟，按行程出行方式基调） */
  durationMin: number;
  tier: LongHaulTier;
}

interface Coord {
  lat: number;
  lng: number;
}

/** 有坐标候选低于此数时整体不判定：点太少时中位中心会被离群点本身拖动而失真（同 eval geo gate 的 ≥3 下限） */
export const MIN_LOCATED_POIS = 3;

/** 一组数的中位数（偶数个取中间两值均值）；调用方保证非空 */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 坐标中位中心：lat/lng 各取中位数（中位数抗单点离群，均值不行）；空数组返回 null */
export function medianCenter(points: readonly Coord[]): Coord | null {
  if (!points.length) return null;
  return { lat: median(points.map((p) => p.lat)), lng: median(points.map((p) => p.lng)) };
}

/** 估算单程通勤时长 → 长途分级；不足长途阈值返回 null（不标记） */
export function longHaulTier(durationMin: number): LongHaulTier | null {
  if (durationMin >= LONG_HAUL_THRESHOLDS.exclusiveMin) return 'exclusive';
  if (durationMin >= LONG_HAUL_THRESHOLDS.longHaulMin) return 'longHaul';
  return null;
}

/**
 * 候选池 → 长途点情报（按通勤时长降序，最重的排最前）。
 * 防御性取舍：无坐标候选直接跳过（漏标由层3 修复器兜底），不为预计算引入额外 geocode 成本/时延；
 * 有坐标候选不足 MIN_LOCATED_POIS 时整体不判定，返回空数组。
 * fallbackCoords（09-23）：知识库坐标兜底——知识库来源候选（search_verified_places）不经 search_pois，
 * 旁路没有它的坐标，不兜底会被跳过标级（实测：八达岭因此当普通点塞进市区天，与慕田峪同时入选）。
 */
export function classifyLongHaulPois(
  pool: readonly ResearchPoi[],
  locations: ReadonlyMap<string, Coord>,
  mode: LegMode,
  fallbackCoords?: ReadonlyMap<string, Coord>,
): LongHaulPoi[] {
  const located = pool.flatMap((p) => {
    const coord = locations.get(p.name) ?? fallbackCoords?.get(p.name);
    return coord ? [{ name: p.name, coord }] : [];
  });
  if (located.length < MIN_LOCATED_POIS) return [];
  const center = medianCenter(located.map((l) => l.coord));
  if (!center) return [];
  const marks: LongHaulPoi[] = [];
  for (const { name, coord } of located) {
    const { durationMin } = estimateTransit(coord, center, mode);
    const tier = longHaulTier(durationMin);
    if (tier) marks.push({ name, durationMin, tier });
  }
  return marks.sort((a, b) => b.durationMin - a.durationMin || (a.name < b.name ? -1 : 1));
}
