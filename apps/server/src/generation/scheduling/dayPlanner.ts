// 一天的时距排布：给已选好的点位分配到达/离开时刻，并检查通勤与闭馆。
//
// 只做「给定顺序 + 给定通勤时长」的时间推演，不选点、不算距离：
// 通勤时长由调用方注入（高德路径规划或启发式），模型永远不自己做算术。
// 返回 issues 而不抛错：排不下/闭馆是方案问题，由上层决定修补或重新组线。
import { closedWeekdays, dayDate, weekdayOf, type PlanPace } from '../planner/validator';
import { isMeal, mealWindow } from '../mealPlanning';

export interface PlanDayStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  openTime?: string;
}

export interface PlanDayInput {
  dayIndex: number;
  /** 行程起始日期；空串表示日期未知，跳过闭馆检查。 */
  startDate: string;
  /** 当天第一个活动的到达时刻，"HH:mm"。 */
  startAt: string;
  pace: PlanPace;
  stops: readonly PlanDayStop[];
  /** 相邻两点通勤分钟数；null 表示路线不可得，按步行估算兜底。 */
  travelMinutes(from: PlanDayStop, to: PlanDayStop): Promise<number | null>;
}

export interface TimedStop {
  id: string;
  name: string;
  arrive: string;
  leave: string;
  travelMin: number;
}

export interface PlanDayResult {
  timed: TimedStop[];
  endAt: string;
  totalTravelMin: number;
  issues: string[];
}

/** 默认停留时长（分钟）：景点按节奏，餐食固定 45–60。 */
const DWELL_MIN: Record<PlanPace, number> = { relaxed: 90, moderate: 75, tight: 60 };
const MEAL_DWELL_MIN = 60;
const DAY_END_LIMIT = 21 * 60 + 30;
const MAX_TRAVEL_MIN = 120;

export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatClock(totalMinutes: number): string {
  const clamped = Math.max(0, Math.round(totalMinutes));
  return `${String(Math.floor(clamped / 60) % 24).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

export function dwellMinutes(stop: PlanDayStop, pace: PlanPace): number {
  return stop.category === '美食' ? MEAL_DWELL_MIN : (DWELL_MIN[pace] ?? 75);
}

/** 步行兜底：按 4.5km/h 估算，最小 5 分钟。 */
export function walkingMinutes(from: PlanDayStop, to: PlanDayStop): number {
  const meters = Math.hypot((to.lat - from.lat) * 111_320, (to.lng - from.lng) * 111_320 * Math.cos((from.lat * Math.PI) / 180));
  return Math.max(5, Math.round((meters / 1000 / 4.5) * 60));
}

export async function planDay(input: PlanDayInput): Promise<PlanDayResult> {
  const issues: string[] = [];
  const start = parseClock(input.startAt) ?? 9 * 60;
  const date = dayDate(input.startDate, input.dayIndex);
  const weekday = weekdayOf(date);
  const timed: TimedStop[] = [];
  let clock = start;
  let totalTravelMin = 0;

  for (const [index, stop] of input.stops.entries()) {
    let travelMin = 0;
    if (index > 0) {
      const previous = input.stops[index - 1]!;
      const resolved = await input.travelMinutes(previous, stop);
      travelMin = resolved === null ? walkingMinutes(previous, stop) : Math.max(0, Math.round(resolved));
      if (resolved === null) issues.push(`${previous.name} → ${stop.name} 没有可用路线，按步行估算 ${travelMin} 分钟`);
      if (travelMin > MAX_TRAVEL_MIN) issues.push(`${previous.name} → ${stop.name} 通勤 ${travelMin} 分钟，过长`);
      clock += travelMin;
      totalTravelMin += travelMin;
    }
    const arrive = clock;
    const dwell = dwellMinutes(stop, input.pace);
    clock += dwell;
    timed.push({ id: stop.id, name: stop.name, arrive: formatClock(arrive), leave: formatClock(clock), travelMin });

    if (weekday !== null && closedWeekdays(stop.openTime).includes(weekday)) {
      issues.push(`${stop.name} 在${weekdayLabel(weekday)}闭馆，当天到店会扑空`);
    }
  }

  if (clock > DAY_END_LIMIT) issues.push(`当天结束时刻 ${formatClock(clock)}，晚于 21:30，行程过满`);
  return { timed, endAt: formatClock(clock), totalTravelMin, issues };
}

function weekdayLabel(weekday: number): string {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] ?? '';
}

/**
 * 用真实通勤段回填活动时刻：规划 Agent 的 plan_day 先用启发式时长排过一版，
 * 坐标与路线落库前会重算 legs；这里按最终 legs 再顺延一次，避免「到达时刻早于真实通勤」。
 * 只改 startTime/endTime，不动顺序、距离与其它字段。
 */
export function applyDraftTimings(
  days: readonly {
    activities: readonly { id: string; name: string; category?: string; lat?: number; lng?: number; startTime: string; endTime: string }[];
    legs?: readonly { fromActivityId: string; toActivityId: string; durationMin: number }[];
  }[],
  pace: PlanPace,
): void {
  for (const day of days) {
    const activities = day.activities;
    if (!activities.length) continue;
    const legMinutes = (fromId: string, toId: string) => day.legs?.find((leg) => leg.fromActivityId === fromId && leg.toActivityId === toId)?.durationMin;
    let clock = parseClock(activities[0]!.startTime) ?? 9 * 60;
    for (const [index, activity] of activities.entries()) {
      if (index > 0) {
        const previous = activities[index - 1]!;
        const actual = legMinutes(previous.id, activity.id);
        const travel = actual !== undefined && actual >= 0
          ? Math.round(actual)
          : previous.lat !== undefined && previous.lng !== undefined && activity.lat !== undefined && activity.lng !== undefined
            ? walkingMinutes({ id: previous.id, name: '', lat: previous.lat, lng: previous.lng }, { id: activity.id, name: '', lat: activity.lat, lng: activity.lng })
            : 0;
        clock += travel;
      }
      // 餐次时间窗：顺延到开饭时间，宁可白天留白，也不要 16:00 吃晚饭。
      // 只有餐次会这样处理；景点仍严格按「上一站离开 + 真实通勤」顺延。
      if (isMeal(activity, 'lunch')) clock = Math.max(clock, mealWindow('lunch').start);
      else if (isMeal(activity, 'dinner')) clock = Math.max(clock, mealWindow('dinner').start);
      const dwell = activity.category === '美食' ? MEAL_DWELL_MIN : (DWELL_MIN[pace] ?? 75);
      const mutable = activity as { startTime: string; endTime: string };
      mutable.startTime = formatClock(clock);
      clock += dwell;
      mutable.endTime = formatClock(clock);
    }
  }
}
