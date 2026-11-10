// 落库前的确定性收口：真实 legs + 餐次会让少数天越过 14h / 缓冲不足。
// 只做「移除当天最长的一个非首站景点」这种可解释的动作，随后由调用方重算 legs 与时刻。
import { parseClock } from './scheduling/dayPlanner';

export interface TrimActivity {
  id: string;
  name: string;
  category?: string;
  startTime: string;
  endTime: string;
}

export interface TrimDay {
  activities: readonly TrimActivity[];
}

export interface TrimRemoval {
  dayIndex: number;
  activityId: string;
  name: string;
  minutes: number;
}

export interface TrimPlan {
  removals: TrimRemoval[];
  dayIndexes: number[];
  notes: string[];
}

function minutesOf(value: string): number | null {
  return parseClock(value);
}

function duration(activity: TrimActivity): number {
  const start = minutesOf(activity.startTime);
  const end = minutesOf(activity.endTime);
  if (start === null || end === null) return 0;
  return end >= start ? end - start : end + 24 * 60 - start;
}

/** 当天从第一站开始到最后离开的总时长。 */
export function daySpanMinutes(day: TrimDay): number {
  if (!day.activities.length) return 0;
  const first = minutesOf(day.activities[0]!.startTime);
  const last = minutesOf(day.activities.at(-1)!.endTime);
  if (first === null || last === null) return 0;
  return last >= first ? last - first : last + 24 * 60 - first;
}

/**
 * 选择要移除的活动（纯函数）：每天最多移除 N 个「最长且非首站、优先非餐次」的活动，
 * 直到预计时长回到上限内。调用方负责重算通勤与时刻。
 */
export function planOverpackedTrim(
  days: readonly TrimDay[],
  options: { maxTotalMin: number; maxPerDay?: number; minActivities?: number } = { maxTotalMin: 12 * 60 + 30 },
): TrimPlan {
  const maxPerDay = options.maxPerDay ?? 2;
  const minActivities = options.minActivities ?? 3;
  const removals: TrimRemoval[] = [];
  const touched = new Set<number>();

  days.forEach((day, index) => {
    const dayIndex = index + 1;
    let activities = [...day.activities];
    let projected = daySpanMinutes(day);
    let removedHere = 0;
    while (projected > options.maxTotalMin && activities.length > minActivities && removedHere < maxPerDay) {
      // 首站是当天锚点；餐次尽量保留。优先移除持续时间最长的候选。
      const candidates = activities
        .map((activity, position) => ({ activity, position }))
        .filter(({ position, activity }) => position > 0 && activity.category !== '美食')
        .sort((a, b) => duration(b.activity) - duration(a.activity));
      const pick = candidates[0] ?? activities
        .map((activity, position) => ({ activity, position }))
        .filter(({ position }) => position > 0)
        .sort((a, b) => duration(b.activity) - duration(a.activity))[0];
      if (!pick) break;
      const saved = duration(pick.activity);
      if (saved <= 0) break;
      activities = activities.filter((activity) => activity.id !== pick.activity.id);
      projected -= saved;
      removedHere += 1;
      touched.add(dayIndex);
      removals.push({ dayIndex, activityId: pick.activity.id, name: pick.activity.name, minutes: saved });
    }
  });

  const notes = removals.map((removal) =>
    `已精简第${removal.dayIndex}天：移除「${removal.name}」，让当天安排回到可执行的时长内。`);
  return { removals, dayIndexes: [...touched], notes };
}

/** 把选中的活动从草稿里删掉；返回受影响的天（供重算 legs）。 */
export function applyTrimRemovals(
  days: readonly { activities: { id: string; name: string }[]; legs?: { fromActivityId: string; toActivityId: string }[] }[],
  removals: readonly TrimRemoval[],
): number[] {
  const idsByDay = new Map<number, Set<string>>();
  for (const removal of removals) {
    const set = idsByDay.get(removal.dayIndex) ?? new Set<string>();
    set.add(removal.activityId);
    idsByDay.set(removal.dayIndex, set);
  }
  const touched: number[] = [];
  for (const [dayIndex, ids] of idsByDay) {
    const day = days[dayIndex - 1];
    if (!day) continue;
    day.activities = day.activities.filter((activity) => !ids.has(activity.id));
    if (day.legs) day.legs = day.legs.filter((leg) => !ids.has(leg.fromActivityId) && !ids.has(leg.toActivityId));
    touched.push(dayIndex);
  }
  return touched;
}
