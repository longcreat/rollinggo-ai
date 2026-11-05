import { dateForDayIndex, isClosedOnDate } from './openHours';
import { haversineMeters, wgs84ToGcj02 } from './geo';
import type { FoodCandidate, MealPosition } from './detailChat';
import type { Activity, Trip, TripDay } from './types';

export const MEAL_LABELS = { lunch: '午餐', dinner: '晚餐', snack: '加餐' } as const;
const clockMinutes = (value?: string) => value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : undefined;
const mealWindow = (meal: MealPosition['meal']) => meal === 'lunch' ? [660, 900] : meal === 'dinner' ? [1020, 1320] : [420, 1410];
export function foodAlreadyAdded(day: TripDay, candidate: FoodCandidate): Activity | undefined {
  return day.activities.find((a) => a.poiKey === candidate.poiKey || (a.category === '美食' && a.name === candidate.name && haversineMeters(a.coordSystem === 'gcj02' ? a : wgs84ToGcj02(a.lat, a.lng), candidate) < 80));
}
export function foodPositionProblem(trip: Trip, candidate: FoodCandidate, position: MealPosition): string | null {
  const day = trip.days.find((d) => d.id === position.dayId);
  if (!day) return '所选日期已不存在，请重新选择';
  if (day.activities.length >= 12) return '当天活动已满，请先调整行程';
  const index = position.beforeActivityId ? day.activities.findIndex((a) => a.id === position.beforeActivityId) : day.activities.length;
  if (index < 0) return '所选活动位置已变更，请重新选择';
  if (isClosedOnDate(candidate.openTime, dateForDayIndex(trip.startDate, day.dayIndex))) return '营业信息显示当天休息，请选择其他日期';
  const meal = MEAL_LABELS[position.meal];
  const [windowStart, windowEnd] = mealWindow(position.meal);
  if (position.meal !== 'snack' && day.activities.some((a) => {
    const time = clockMinutes(a.startTime);
    return a.category === '美食' && (a.description.includes(meal) || a.name.includes(meal)
      || (time !== undefined && time >= windowStart! && time < windowEnd!)
      || (!/午餐|晚餐|加餐/.test(a.description + a.name) && !a.startTime));
  })) return '该时段已安排用餐，请调整位置或餐次';
  const before = day.activities[index - 1];
  const after = day.activities[index];
  const end = clockMinutes(before?.endTime);
  const start = clockMinutes(after?.startTime);
  if (end !== undefined && start !== undefined && start - end < 60) return '前后活动之间不足一小时用餐，请调整位置';
  if ((end !== undefined && end + 60 > windowEnd!) || (start !== undefined && start - 60 < windowStart!)) return '所选位置不在该餐次的合理时段，请调整位置或餐次';
  return null;
}

/** 仅对已有明确时间的旧行程补齐餐饮时间；无时间轴的行程仍保存空串。 */
export function foodTimes(trip: Trip, candidate: FoodCandidate, position: MealPosition, inbound = 0, outbound = 0) {
  const day = trip.days.find((d) => d.id === position.dayId)!;
  const index = position.beforeActivityId ? day.activities.findIndex((a) => a.id === position.beforeActivityId) : day.activities.length;
  const end = clockMinutes(day.activities[index - 1]?.endTime);
  const next = clockMinutes(day.activities[index]?.startTime);
  if (end === undefined && next === undefined) return { startTime: '', endTime: '' };
  const [min, max] = mealWindow(position.meal);
  const start = Math.max(min!, end !== undefined ? end + inbound : min!);
  const finish = start + 60;
  if (finish > max! || (next !== undefined && finish + outbound > next)) throw new Error('加入用餐及交通后会与前后活动冲突，请调整位置');
  const windows = [...(candidate.openTime ?? '').matchAll(/([0-2]\d:[0-5]\d)\s*[-—~至]\s*([0-2]\d:[0-5]\d)/g)].flatMap((m) => {
    const a = clockMinutes(m[1]); const b = clockMinutes(m[2]);
    return a !== undefined && b !== undefined && a < b ? [[a, b]] : [];
  });
  if (windows.length && !windows.some(([a, b]) => start >= a! && finish <= b!)) throw new Error('用餐时间不在已知营业时段内，请调整位置');
  const clock = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return { startTime: clock(start), endTime: clock(finish) };
}
export function recommendedFoodPosition(trip: Trip, candidate: FoodCandidate): MealPosition | undefined {
  const day = trip.days.find((d) => d.id === candidate.dayId);
  if (!day) return;
  const preferred = candidate.position;
  const valid = (position: MealPosition) => {
    if (foodPositionProblem(trip, candidate, position)) return false;
    try { foodTimes(trip, candidate, position); return true; } catch { return false; }
  };
  if (preferred && valid(preferred)) return preferred;
  // 无时间轴时不从活动个数猜餐次；让用户选择明确位置。
  const meal = candidate.meal ?? preferred?.meal ?? 'lunch';
  for (let index = 0; index <= day.activities.length; index++) {
    if (clockMinutes(day.activities[index - 1]?.endTime) === undefined && clockMinutes(day.activities[index]?.startTime) === undefined) continue;
    const position: MealPosition = { dayId: day.id, ...(day.activities[index] ? { beforeActivityId: day.activities[index]!.id } : {}), meal };
    if (valid(position)) return position;
  }
}
