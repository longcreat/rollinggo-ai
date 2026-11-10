import {
  LODGING_SENTINEL,
  effectiveLegMode,
  estimateTransit,
  haversineMeters,
  type Activity,
  type LegMode,
  type TransitLeg,
} from '@tripweaver/shared';
import type { DraftTrip } from './draft';
import { isMeal, mealWindow } from './mealPlanning';
import { optimizeRouteOrder } from './scheduling/routeOrder';
import { routeOrderConstraints } from '../data/routeOrderSeeds';

type DraftDay = ReturnType<DraftTrip['mutableDays']>[number];

/** 补齐坐标后、计算通勤腿前再排一次。固定已有时刻的天（若未开启 forceReorderTimed）与餐次槽位，只调整日内访问顺序。 */
export function orderUntimedDayRoutes(
  draft: DraftTrip,
  destination: string,
  options: { forceReorderTimed?: boolean } = {},
): number[] {
  const changed: number[] = [];
  const lodging = draft.lodging;
  const origin = lodging && typeof lodging.lat === 'number' && typeof lodging.lng === 'number'
    ? { lat: lodging.lat, lng: lodging.lng } : undefined;
  draft.mutableDays().forEach((day, index) => {
    if (!options.forceReorderTimed && day.activities.some((a) => a.startTime || a.endTime)) return;
    const ordered = optimizeRouteOrder(day.activities, {
      constraints: routeOrderConstraints(destination, day.activities.map((a) => a.name)),
      fixedIndexes: new Set(day.activities.flatMap((a, i) => isMealActivity(a) ? [i] : [])), origin,
    });
    if (ordered.every((a, i) => a.id === day.activities[i]?.id)) return;
    day.activities.splice(0, day.activities.length, ...ordered);
    delete day.legs;
    changed.push(index + 1);
  });
  return changed;
}

const NEAR_DAY_CLUSTER_M = 20_000;
const FAR_SAME_DAY_M = 40_000;
const MIN_AFFINITY_GAIN_M = 30_000;
const MIN_ROUTE_GAIN_MIN = 30;
const MAX_SWAP_ATTEMPTS = 3;
const TIME_ROUND_MIN = 15;
const DAY_END_MIN = 23 * 60;

interface VisitBlock {
  start: number;
  end: number;
  anchor: Activity;
  activities: Activity[];
}

interface SwapCandidate {
  dayA: number;
  dayB: number;
  anchorAId: string;
  anchorBId: string;
  estimatedGainMin: number;
}

interface Coordinate {
  lat: number;
  lng: number;
}

export interface RouteCoherenceContext {
  mode: LegMode;
  recomputeLegs: (dayIndexes: readonly number[]) => Promise<void>;
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
}

export interface RouteCoherenceResult {
  notes: string[];
  changedDayIndexes: number[];
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(value: string): number | null {
  if (!TIME_RE.test(value)) return null;
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

function toHHmm(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function hasCoord(point: Coordinate): boolean {
  return point.lat !== 0 || point.lng !== 0;
}

function isMealActivity(activity: Activity): boolean {
  return isMeal(activity, 'lunch') || isMeal(activity, 'dinner');
}

/** A visit block keeps the meal following an attraction attached when two days exchange visits. */
function visitBlocks(day: DraftDay): VisitBlock[] {
  const blocks: VisitBlock[] = [];
  let current: VisitBlock | null = null;
  day.activities.forEach((activity, index) => {
    if (!isMealActivity(activity)) {
      if (current) blocks.push(current);
      current = { start: index, end: index + 1, anchor: activity, activities: [activity] };
    } else if (current) {
      current.end = index + 1;
      current.activities.push(activity);
    }
  });
  if (current) blocks.push(current);
  return blocks;
}

function nearestMeters(anchor: Activity, others: readonly Activity[]): number {
  const located = others.filter((activity) => hasCoord(activity));
  return located.length ? Math.min(...located.map((activity) => haversineMeters(anchor, activity))) : Number.POSITIVE_INFINITY;
}

function hasStrongCrossDayAffinity(
  anchor: Activity,
  currentPeers: readonly Activity[],
  targetPeers: readonly Activity[],
): boolean {
  const currentNear = nearestMeters(anchor, currentPeers);
  const targetNear = nearestMeters(anchor, targetPeers);
  return (
    currentNear >= FAR_SAME_DAY_M &&
    targetNear <= NEAR_DAY_CLUSTER_M &&
    currentNear - targetNear >= MIN_AFFINITY_GAIN_M
  );
}

function heuristicPairMinutes(from: Coordinate, to: Coordinate, mode: LegMode): number {
  const pairMode: LegMode = effectiveLegMode(from, to, mode);
  return estimateTransit(from, to, pairMode).durationMin;
}

function heuristicRouteMinutes(days: readonly DraftDay[], lodging: DraftTrip['lodging'], mode: LegMode): number {
  let total = 0;
  for (const day of days) {
    for (let index = 0; index + 1 < day.activities.length; index += 1) {
      const from = day.activities[index]!;
      const to = day.activities[index + 1]!;
      if (hasCoord(from) && hasCoord(to)) total += heuristicPairMinutes(from, to, mode);
    }
    const first = day.activities[0];
    const last = day.activities.at(-1);
    if (lodging && typeof lodging.lat === 'number' && typeof lodging.lng === 'number' && (lodging.lat !== 0 || lodging.lng !== 0)) {
      const anchor = { lat: lodging.lat, lng: lodging.lng };
      if (first && hasCoord(first)) total += heuristicPairMinutes(anchor, first, mode);
      if (last && hasCoord(last)) total += heuristicPairMinutes(last, anchor, mode);
    }
  }
  return total;
}

function actualRouteMinutes(days: readonly DraftDay[], lodging: DraftTrip['lodging'], mode: LegMode): number | null {
  let total = 0;
  const anchor = lodging && typeof lodging.lat === 'number' && typeof lodging.lng === 'number' && (lodging.lat !== 0 || lodging.lng !== 0)
    ? { lat: lodging.lat, lng: lodging.lng }
    : undefined;
  for (const day of days) {
    for (let index = 0; index + 1 < day.activities.length; index += 1) {
      const from = day.activities[index]!;
      const to = day.activities[index + 1]!;
      if (!hasCoord(from) || !hasCoord(to)) continue;
      const leg = day.legs?.find((item) => item.fromActivityId === from.id && item.toActivityId === to.id);
      // 活动段缺真实 leg 是数据缺失，宁可不优化也不猜
      if (!leg) return null;
      total += leg.durationMin;
    }
    const first = day.activities[0];
    const last = day.activities.at(-1);
    // geoPipeline 自 09-22 起不再生成住宿哨兵 leg（只算景点↔景点）。缺失时退回启发式，
    // 与 heuristicRouteMinutes 的住宿口径一致 —— 否则带住宿的行程在这里必得 null，
    // optimizeCrossDayGrouping 会被整体跳过（11-03 审查实测 bug）。
    if (anchor && first && hasCoord(first)) {
      const departure = day.legs?.find(
        (leg) => leg.fromActivityId === LODGING_SENTINEL && leg.toActivityId === first.id,
      );
      total += departure?.durationMin ?? heuristicPairMinutes(anchor, first, mode);
    }
    if (anchor && last && hasCoord(last)) {
      const returning = day.legs?.find(
        (leg) => leg.fromActivityId === last.id && leg.toActivityId === LODGING_SENTINEL,
      );
      total += returning?.durationMin ?? heuristicPairMinutes(last, anchor, mode);
    }
  }
  return total;
}

function countHard(draft: DraftTrip): number {
  return draft.feasibility().violations.filter((violation) => violation.severity === 'hard').length;
}

function shiftBlockToSlot(incoming: readonly Activity[], outgoing: readonly Activity[]): void {
  const incomingStart = toMinutes(incoming[0]?.startTime ?? '');
  const outgoingStart = toMinutes(outgoing[0]?.startTime ?? '');
  if (incomingStart === null || outgoingStart === null) return;
  const delta = outgoingStart - incomingStart;
  for (const activity of incoming) {
    const start = toMinutes(activity.startTime);
    const end = toMinutes(activity.endTime);
    if (start === null || end === null || end <= start) continue;
    const shiftedStart = start + delta;
    const shiftedEnd = end + delta;
    if (shiftedStart < 0 || shiftedEnd > DAY_END_MIN) continue;
    activity.startTime = toHHmm(shiftedStart);
    activity.endTime = toHHmm(shiftedEnd);
  }
}

function replaceBlock(day: DraftDay, outgoing: VisitBlock, incoming: readonly Activity[]): void {
  day.activities.splice(outgoing.start, outgoing.end - outgoing.start, ...incoming);
}

function strictLeg(day: DraftDay, from: Activity, to: Activity): TransitLeg | undefined {
  return day.legs?.find((leg) => leg.fromActivityId === from.id && leg.toActivityId === to.id);
}

/** Push activities forward just enough to fit real legs. The whole day rolls back if it no longer fits. */
export function repairDayTiming(day: DraftDay): boolean {
  const snapshot = day.activities.map((activity) => ({ startTime: activity.startTime, endTime: activity.endTime }));
  for (let index = 1; index < day.activities.length; index += 1) {
    const previous = day.activities[index - 1]!;
    const activity = day.activities[index]!;
    const previousEnd = toMinutes(previous.endTime);
    const start = toMinutes(activity.startTime);
    const end = toMinutes(activity.endTime);
    if (previousEnd === null || start === null || end === null || end <= start) continue;
    const leg = strictLeg(day, previous, activity);
    const durationMin = leg?.durationMin ?? (hasCoord(previous) && hasCoord(activity) ? heuristicPairMinutes(previous, activity, 'transit') : 0);
    const earliest = previousEnd + durationMin;
    if (start >= earliest) continue;
    const nextStart = Math.ceil(earliest / TIME_ROUND_MIN) * TIME_ROUND_MIN;
    const nextEnd = nextStart + (end - start);
    const kind = isMeal(activity, 'lunch') ? 'lunch' : isMeal(activity, 'dinner') ? 'dinner' : null;
    if (nextEnd > DAY_END_MIN || (kind && nextEnd > mealWindow(kind).end)) {
      day.activities.forEach((item, itemIndex) => Object.assign(item, snapshot[itemIndex]));
      return false;
    }
    activity.startTime = toHHmm(nextStart);
    activity.endTime = toHHmm(nextEnd);
  }
  return true;
}

export function repairTransitTiming(days: readonly DraftDay[]): number[] {
  const changed: number[] = [];
  days.forEach((day, index) => {
    const before = day.activities.map((activity) => `${activity.startTime}-${activity.endTime}`).join('|');
    if (repairDayTiming(day)) {
      const after = day.activities.map((activity) => `${activity.startTime}-${activity.endTime}`).join('|');
      if (after !== before) changed.push(index + 1);
    }
  });
  return changed;
}

function candidatesFor(draft: DraftTrip, mode: LegMode): SwapCandidate[] {
  const days = draft.mutableDays();
  const before = heuristicRouteMinutes(days, draft.lodging, mode);
  const candidates: SwapCandidate[] = [];
  for (let dayA = 0; dayA < days.length; dayA += 1) {
    const blocksA = visitBlocks(days[dayA]!);
    for (let dayB = dayA + 1; dayB < days.length; dayB += 1) {
      const blocksB = visitBlocks(days[dayB]!);
      for (const blockA of blocksA) {
        if (!hasCoord(blockA.anchor)) continue;
        for (const blockB of blocksB) {
          if (!hasCoord(blockB.anchor) || blockA.anchor.category !== blockB.anchor.category) continue;
          const sourcePeers = blocksA.filter((block) => block !== blockA).map((block) => block.anchor);
          const targetPeers = blocksB.filter((block) => block !== blockB).map((block) => block.anchor);
          const aBelongsWithDayB = hasStrongCrossDayAffinity(blockA.anchor, sourcePeers, targetPeers);
          const bBelongsWithDayA = hasStrongCrossDayAffinity(blockB.anchor, targetPeers, sourcePeers);
          if (!aBelongsWithDayB && !bBelongsWithDayA) continue;
          const snapshot = structuredClone(days);
          const aIncoming = structuredClone(blockB.activities);
          const bIncoming = structuredClone(blockA.activities);
          shiftBlockToSlot(aIncoming, blockA.activities);
          shiftBlockToSlot(bIncoming, blockB.activities);
          replaceBlock(snapshot[dayA]!, blockA, aIncoming);
          replaceBlock(snapshot[dayB]!, blockB, bIncoming);
          const estimatedGainMin = before - heuristicRouteMinutes(snapshot, draft.lodging, mode);
          if (estimatedGainMin >= MIN_ROUTE_GAIN_MIN) {
            candidates.push({ dayA: dayA + 1, dayB: dayB + 1, anchorAId: blockA.anchor.id, anchorBId: blockB.anchor.id, estimatedGainMin });
          }
        }
      }
    }
  }
  return candidates.sort((a, b) => b.estimatedGainMin - a.estimatedGainMin).slice(0, MAX_SWAP_ATTEMPTS);
}

function restoreDays(days: DraftDay[], snapshot: DraftDay[]): void {
  days.splice(0, days.length, ...structuredClone(snapshot));
}

export async function optimizeCrossDayGrouping(draft: DraftTrip, ctx: RouteCoherenceContext): Promise<RouteCoherenceResult> {
  const days = draft.mutableDays();
  const entrySnapshot = structuredClone(days);
  if (ctx.signal?.aborted) throw new Error('已取消');
  const beforeRoute = actualRouteMinutes(days, draft.lodging, ctx.mode);
  if (beforeRoute === null) return { notes: [], changedDayIndexes: [] };
  const beforeHard = countHard(draft);
  try {
    for (const candidate of candidatesFor(draft, ctx.mode)) {
      if (ctx.signal?.aborted) throw new Error('已取消');
      const attemptSnapshot = structuredClone(days);
      const dayA = days[candidate.dayA - 1]!;
      const dayB = days[candidate.dayB - 1]!;
      const blockA = visitBlocks(dayA).find((block) => block.anchor.id === candidate.anchorAId);
      const blockB = visitBlocks(dayB).find((block) => block.anchor.id === candidate.anchorBId);
      if (!blockA || !blockB) continue;
      const nameA = blockA.anchor.name;
      const nameB = blockB.anchor.name;
      const aIncoming = blockB.activities;
      const bIncoming = blockA.activities;
      shiftBlockToSlot(aIncoming, blockA.activities);
      shiftBlockToSlot(bIncoming, blockB.activities);
      replaceBlock(dayA, blockA, aIncoming);
      replaceBlock(dayB, blockB, bIncoming);
      await ctx.recomputeLegs([candidate.dayA, candidate.dayB]);
      if (!repairDayTiming(dayA) || !repairDayTiming(dayB)) {
        restoreDays(days, attemptSnapshot);
        continue;
      }
      const afterRoute = actualRouteMinutes(days, draft.lodging, ctx.mode);
      const routeGain = afterRoute === null ? 0 : beforeRoute - afterRoute;
      if (afterRoute !== null && routeGain >= MIN_ROUTE_GAIN_MIN && countHard(draft) <= beforeHard) {
        const note = `系统自动调整：「${nameA}」与「${nameB}」交换日期，使相近地点集中并减少约 ${routeGain} 分钟通勤`;
        ctx.onProgress?.(note);
        return { notes: [note], changedDayIndexes: [candidate.dayA, candidate.dayB] };
      }
      restoreDays(days, attemptSnapshot);
    }
    return { notes: [], changedDayIndexes: [] };
  } catch (error) {
    restoreDays(days, entrySnapshot);
    if (ctx.signal?.aborted) throw error;
    ctx.onProgress?.('跨天地理优化未生效，将保留原编排');
    return { notes: [], changedDayIndexes: [] };
  }
}
