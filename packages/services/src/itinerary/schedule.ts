// 行程时间轴的唯一实现：给定「有序活动 + 通勤段」，派生每个活动的 startTime/endTime。
//
// 不变量（生成与详情编辑共用）：
//   - 顺序由结构操作决定（add/move/reorder）；时刻只能由本模块写出。
//   - 模型不能直接写 startTime/endTime，只能表达停留时长与先后关系。
//   - 没有真实 legs 时用步行估算；提交前重算 legs 后再跑一次，得到最终时刻。
import type { TripPace } from '@rollinggo-trip/shared';
import { isMeal, mealWindow } from './mealRules';

export interface ScheduleActivity {
  id: string;
  name: string;
  category?: string;
  lat?: number;
  lng?: number;
  startTime: string;
  endTime: string;
  /** 显式停留时长（分钟）；缺省按类目与节奏推导。 */
  durationMin?: number;
}

export interface ScheduleLeg {
  fromActivityId: string;
  toActivityId: string;
  durationMin: number;
}

export interface ScheduleDay {
  activities: ScheduleActivity[];
  legs?: readonly ScheduleLeg[];
}

export interface ScheduleDayOptions {
  pace: TripPace;
  /** 当天首个活动的开始时刻；缺省沿用当前首活动时刻，再缺省 09:00。 */
  startAt?: string;
  /** 编辑现有行程：保留已有 start/end 表示的停留时长；生成时不保留（沿用类目默认）。 */
  preserveDurations?: boolean;
}

const DWELL_MIN: Record<TripPace, number> = { relaxed: 90, moderate: 75, tight: 60 };
const MEAL_DWELL_MIN = 60;

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

export function dwellMinutes(
  activity: { name?: string; category?: string; durationMin?: number },
  pace: TripPace,
): number {
  if (activity.durationMin !== undefined && Number.isFinite(activity.durationMin) && activity.durationMin > 0) {
    return Math.round(activity.durationMin);
  }
  return activity.category === '美食' ? MEAL_DWELL_MIN : (DWELL_MIN[pace] ?? DWELL_MIN.moderate);
}

/** 步行兜底：按 4.5km/h 估算，最小 5 分钟。 */
export function walkingMinutes(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const meters = Math.hypot(
    (to.lat - from.lat) * 111_320,
    (to.lng - from.lng) * 111_320 * Math.cos((from.lat * Math.PI) / 180),
  );
  return Math.max(5, Math.round((meters / 1000 / 4.5) * 60));
}

function existingDuration(activity: ScheduleActivity): number | undefined {
  const start = parseClock(activity.startTime);
  const end = parseClock(activity.endTime);
  return start !== null && end !== null && end > start ? end - start : undefined;
}

/**
 * 重排一天的时刻：顺序不动，只按 legs + 停留时长顺延。
 * 餐次按「到达时刻」判定窗口，避免重排后仍沿用旧时刻误判午餐/晚餐。
 */
export function scheduleDay(day: ScheduleDay, options: ScheduleDayOptions): void {
  const { activities } = day;
  if (!activities.length) return;
  const anchor = options.startAt ? parseClock(options.startAt) : parseClock(activities[0]!.startTime);
  let clock = anchor ?? 9 * 60;

  for (const [index, activity] of activities.entries()) {
    if (index > 0) {
      const previous = activities[index - 1]!;
      const leg = day.legs?.find(
        (item) => item.fromActivityId === previous.id && item.toActivityId === activity.id,
      );
      const travel = leg !== undefined && leg.durationMin >= 0
        ? Math.round(leg.durationMin)
        : previous.lat !== undefined && previous.lng !== undefined
          && activity.lat !== undefined && activity.lng !== undefined
          && (previous.lat !== 0 || previous.lng !== 0) && (activity.lat !== 0 || activity.lng !== 0)
          ? walkingMinutes({ lat: previous.lat, lng: previous.lng }, { lat: activity.lat, lng: activity.lng })
          : 0;
      clock += travel;
    }

    // 走到这里才有时刻：用「到达时刻」判定餐次，而不是旧 startTime。
    const arrival = formatClock(clock);
    if (isMeal({ ...activity, startTime: arrival }, 'lunch')) {
      clock = Math.max(clock, mealWindow('lunch').start);
    } else if (isMeal({ ...activity, startTime: arrival }, 'dinner')) {
      clock = Math.max(clock, mealWindow('dinner').start);
    }

    const preserved = options.preserveDurations === true && activity.durationMin === undefined
      ? existingDuration(activity)
      : undefined;
    const dwell = dwellMinutes({ ...activity, ...(preserved !== undefined ? { durationMin: preserved } : {}) }, options.pace);
    activity.startTime = formatClock(clock);
    clock += dwell;
    activity.endTime = formatClock(clock);
  }
}

export function scheduleDays(
  days: readonly ScheduleDay[],
  pace: TripPace,
  options: Omit<ScheduleDayOptions, 'pace'> = {},
): void {
  for (const day of days) scheduleDay(day, { ...options, pace });
}
