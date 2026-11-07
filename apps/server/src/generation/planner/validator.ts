// 方案验收：把「稀薄、跨区、重复坐标、杂项」变成可量化指标。
//
// 这里只做纯计算，不读数据库、不发请求；生成链路用它验收，eval 用同一份实现，
// 避免「线上判定」和「评测口径」两套标准。阈值按节奏给默认值，调用方可覆盖。
import { haversineMeters, type Trip } from '@tripweaver/shared';
import { DEFAULT_SUB_POI_POLICY } from '../../services/geofenceImport';

export type PlanPace = 'relaxed' | 'moderate' | 'tight';

/** 「自由安排｜城市」这类占位项不算景点。 */
export const PLACEHOLDER_NAME = /^自由安排[｜|]/;

export interface PlanMetrics {
  /** 每天的可编排景点数（不含美食/住宿/交通/占位项）。 */
  stopsPerDay: Record<number, number>;
  /** 每天相邻活动（有坐标）的直线距离，单位 km。 */
  hopKm: number[];
  /** 同一天内坐标落在同一 11m 网格的对数。 */
  dupCoordPairs: number;
  /** 设施/占位项占全部活动的比例。 */
  junkRatio: number;
  /** 相邻活动距离 < 20m 的比例（缺坐标或重复坐标都会造成 0 段）。 */
  zeroLegShare: number;
  /** 坐标缺失（0,0 或越界）的活动数。 */
  missingCoordStops: number;
  /** 每天离当日中心最远的距离，km。 */
  daySpanKm: number[];
  /** 能解析出闭馆日且与当天星期冲突的活动数。 */
  closureViolations: number;
}

export interface PlanPolicy {
  minStops: number;
  maxStops: number;
  /** 段距中位数上限（km）。 */
  p50HopKm: number;
  /** 段距 90 分位上限（km）。 */
  p90HopKm: number;
  maxDupCoordPairs: number;
  maxJunkRatio: number;
  maxZeroLegShare: number;
  /** 单日点位离当日中心的最远距离（km）。 */
  maxDaySpanKm: number;
}

export const PLAN_POLICY: Record<PlanPace, PlanPolicy> = {
  relaxed: { minStops: 4, maxStops: 6, p50HopKm: 2.5, p90HopKm: 8, maxDupCoordPairs: 0, maxJunkRatio: 0.02, maxZeroLegShare: 0.1, maxDaySpanKm: 12 },
  moderate: { minStops: 6, maxStops: 8, p50HopKm: 2.5, p90HopKm: 8, maxDupCoordPairs: 0, maxJunkRatio: 0.02, maxZeroLegShare: 0.1, maxDaySpanKm: 12 },
  tight: { minStops: 8, maxStops: 10, p50HopKm: 3, p90HopKm: 10, maxDupCoordPairs: 0, maxJunkRatio: 0.02, maxZeroLegShare: 0.1, maxDaySpanKm: 15 },
};

export type PlanViolationCode = 'sparse' | 'overpacked' | 'far-hop' | 'dup-coord' | 'junk' | 'zero-leg' | 'day-span' | 'closure';

export interface PlanViolation {
  code: PlanViolationCode;
  severity: 'hard' | 'soft';
  dayIndex?: number;
  detail: string;
}

const JUNK_NAME = DEFAULT_SUB_POI_POLICY.nameBlacklist;

function validPoint(activity: { lat: number; lng: number }): boolean {
  return Number.isFinite(activity.lat) && Number.isFinite(activity.lng)
    && Math.abs(activity.lat) <= 90 && Math.abs(activity.lng) <= 180
    && !(activity.lat === 0 && activity.lng === 0);
}

function coordKey(activity: { lat: number; lng: number }): string {
  return `${activity.lng.toFixed(4)}|${activity.lat.toFixed(4)}`;
}

export function isStoppable(activity: { name: string; category: string }): boolean {
  if (PLACEHOLDER_NAME.test(activity.name)) return false;
  if (JUNK_NAME.test(activity.name)) return false;
  if (activity.category === '美食' || activity.category === '住宿' || activity.category === '交通') return false;
  return true;
}

export function weekdayOf(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const value = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return Number.isFinite(value) ? value : null;
}

const WEEKDAY_TEXT: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

/** 从高德营业时间原文里提取闭馆星期；解析不了就返回空数组（宁可漏判，不误判）。 */
export function closedWeekdays(openTime: string | undefined): number[] {
  if (!openTime) return [];
  const text = openTime.replace(/\s+/g, '');
  if (/无休|全年开放|每天开放/.test(text)) return [];
  const days = new Set<number>();
  for (const match of text.matchAll(/(?:周|星期)([一二三四五六日天])闭馆/g)) {
    const value = WEEKDAY_TEXT[match[1]!];
    if (value !== undefined) days.add(value);
  }
  return [...days];
}

export function measurePlan(trip: Pick<Trip, 'days' | 'startDate'>): PlanMetrics {
  const stopsPerDay: Record<number, number> = {};
  const hopKm: number[] = [];
  const daySpanKm: number[] = [];
  let dupCoordPairs = 0;
  let junkCount = 0;
  let activityCount = 0;
  let zeroLegs = 0;
  let hopPairs = 0;
  let missingCoordStops = 0;
  let closureViolations = 0;

  for (const day of trip.days) {
    const keyed = new Map<string, number>();
    let stops = 0;
    const located = day.activities.filter((activity) => {
      const valid = validPoint(activity);
      if (!valid) missingCoordStops += 1;
      return valid;
    });
    for (const activity of day.activities) {
      activityCount += 1;
      if (JUNK_NAME.test(activity.name) || PLACEHOLDER_NAME.test(activity.name)) junkCount += 1;
      if (isStoppable(activity)) stops += 1;
      if (!validPoint(activity)) continue;
      const key = coordKey(activity);
      const seen = keyed.get(key) ?? 0;
      dupCoordPairs += seen;
      keyed.set(key, seen + 1);
    }
    stopsPerDay[day.dayIndex] = stops;

    for (let index = 1; index < located.length; index += 1) {
      const distanceKm = haversineMeters(located[index - 1]!, located[index]!) / 1000;
      hopKm.push(round(distanceKm, 2));
      hopPairs += 1;
      if (distanceKm < 0.02) zeroLegs += 1;
    }
    if (located.length) {
      const center = {
        lat: located.reduce((sum, activity) => sum + activity.lat, 0) / located.length,
        lng: located.reduce((sum, activity) => sum + activity.lng, 0) / located.length,
      };
      daySpanKm.push(round(Math.max(...located.map((activity) => haversineMeters(center, activity) / 1000)), 2));
    }

    const weekday = weekdayOf(dayDate(trip.startDate, day.dayIndex));
    if (weekday !== null) {
      for (const activity of day.activities) {
        if (closedWeekdays(activity.openTime).includes(weekday)) closureViolations += 1;
      }
    }
  }

  return {
    stopsPerDay,
    hopKm,
    dupCoordPairs,
    junkRatio: activityCount ? round(junkCount / activityCount, 4) : 0,
    zeroLegShare: hopPairs ? round(zeroLegs / hopPairs, 4) : 0,
    missingCoordStops,
    daySpanKm,
    closureViolations,
  };
}

export function planViolations(metrics: PlanMetrics, policy: PlanPolicy, days = Object.keys(metrics.stopsPerDay).length): PlanViolation[] {
  const violations: PlanViolation[] = [];
  for (const [dayIndex, stops] of Object.entries(metrics.stopsPerDay)) {
    if (stops < policy.minStops) violations.push({ code: 'sparse', severity: 'soft', dayIndex: Number(dayIndex), detail: `第 ${dayIndex} 天只有 ${stops} 个景点，低于 ${policy.minStops}` });
    if (stops > policy.maxStops) violations.push({ code: 'overpacked', severity: 'soft', dayIndex: Number(dayIndex), detail: `第 ${dayIndex} 天 ${stops} 个景点，超过 ${policy.maxStops}` });
  }
  if (!days) violations.push({ code: 'sparse', severity: 'hard', detail: '没有生成任何一天的行程' });
  if (metrics.hopKm.length) {
    const sorted = [...metrics.hopKm].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p90 = percentile(sorted, 90);
    if (p50 > policy.p50HopKm) violations.push({ code: 'far-hop', severity: 'soft', detail: `段距中位数 ${p50}km，超过 ${policy.p50HopKm}km` });
    if (p90 > policy.p90HopKm) violations.push({ code: 'far-hop', severity: 'soft', detail: `段距 90 分位 ${p90}km，超过 ${policy.p90HopKm}km` });
  }
  if (metrics.dupCoordPairs > policy.maxDupCoordPairs) violations.push({ code: 'dup-coord', severity: 'hard', detail: `有 ${metrics.dupCoordPairs} 对活动坐标重复` });
  if (metrics.junkRatio > policy.maxJunkRatio) violations.push({ code: 'junk', severity: 'soft', detail: `设施/占位项占 ${(metrics.junkRatio * 100).toFixed(1)}%` });
  if (metrics.zeroLegShare > policy.maxZeroLegShare) violations.push({ code: 'zero-leg', severity: 'soft', detail: `零距离段占 ${(metrics.zeroLegShare * 100).toFixed(1)}%` });
  for (const [index, span] of metrics.daySpanKm.entries()) {
    if (span > policy.maxDaySpanKm) violations.push({ code: 'day-span', severity: 'soft', detail: `第 ${index + 1} 天点位跨度 ${span}km，超过 ${policy.maxDaySpanKm}km` });
  }
  if (metrics.closureViolations > 0) violations.push({ code: 'closure', severity: 'hard', detail: `有 ${metrics.closureViolations} 个活动落在闭馆日` });
  return violations;
}

/** 当月/当天的日期串；trip.startDate 为空时返回空串（星期未知，闭馆检查跳过）。 */
export function dayDate(startDate: string, dayIndex: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return '';
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Math.max(0, dayIndex - 1));
  return date.toISOString().slice(0, 10);
}

export function percentile(sorted: readonly number[], value: number): number {
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((value / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
