// 行程派生数据（纯函数）：概览候选 ↔ 活动匹配、通勤段查找与展示格式化 —— 编辑器多组件共用
import type { ResearchPoi, TransitLeg, TripDay } from '@tripweaver/shared';

/** 名称归一化：统一小写、去空白与常见中英文标点，供活动与调研候选模糊匹配 */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[\s·・,，。.、\-–—()（）【】\[\]「」《》'"'"]/g, '');
}

export interface OverviewMatch {
  /** activityId → 命中的调研候选 */
  poiByActivityId: Map<string, ResearchPoi>;
  /** 未被任何活动命中的候选（进「备选」抽屉） */
  unmatched: ResearchPoi[];
}

/**
 * 包含匹配防误报护栏：短名极易误命中（如「西湖」⊂「西湖醋鱼餐厅」是错配）。
 * 要求被包含侧 ≥2 字且长度不低于另一侧的一半 —— 宁可漏配进备选抽屉，不在活动卡上展示错误信息。
 */
function containsMatch(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 2 && short.length * 2 >= long.length && long.includes(short);
}

/**
 * Activity ↔ Trip.overview 按名称匹配：归一化后精确优先，其次互相包含（带护栏）。
 * schema 无关联 id（本任务不改 schema），匹配失败仅意味着进入备选抽屉，无副作用。
 */
export function matchOverview(days: TripDay[], overview: ResearchPoi[] | undefined): OverviewMatch {
  const poiByActivityId = new Map<string, ResearchPoi>();
  if (!overview?.length) return { poiByActivityId, unmatched: [] };

  const candidates = overview
    .map((poi) => ({ poi, key: normalizeName(poi.name) }))
    .filter((c) => c.key.length > 0);
  const usedPoiIds = new Set<string>();

  for (const day of days) {
    for (const activity of day.activities) {
      const key = normalizeName(activity.name);
      if (!key) continue;
      const hit =
        candidates.find((c) => c.key === key) ??
        candidates.find((c) => containsMatch(key, c.key));
      if (hit) {
        poiByActivityId.set(activity.id, hit.poi);
        usedPoiIds.add(hit.poi.id);
      }
    }
  }
  return { poiByActivityId, unmatched: overview.filter((p) => !usedPoiIds.has(p.id)) };
}

/** 按当前相邻活动对查 leg；失配（用户已重排/删改）返回 undefined，由调用方静默跳过 */
export function legForPair(day: TripDay, fromActivityId: string, toActivityId: string): TransitLeg | undefined {
  return day.legs?.find((l) => l.fromActivityId === fromActivityId && l.toActivityId === toActivityId);
}

// 住宿锚点 leg 匹配（ST3 哨兵 id 'lodging'）：纯函数实现放 shared 以便服务端单测复用，此处转出口供编辑器组件使用
export { LODGING_SENTINEL, lodgingLegsForDay, type LodgingLegs } from '@tripweaver/shared';

export const LEG_MODE_ICON: Record<TransitLeg['mode'], string> = { walk: '🚶', cycle: '🚲', transit: '🚇', drive: '🚗' };
export const LEG_MODE_LABEL: Record<TransitLeg['mode'], string> = { walk: '步行', cycle: '骑行', transit: '公交/地铁', drive: '驾车' };

/** 距离展示：>1km 一位小数公里，否则整数米 */
export function formatLegDistance(distanceM: number): string {
  return distanceM > 1000 ? `${(distanceM / 1000).toFixed(1)} km` : `${Math.round(distanceM)} m`;
}

export function formatLegDuration(durationMin: number): string {
  return `${Math.max(1, Math.round(durationMin))} 分钟`;
}
