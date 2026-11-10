import { uid, type Activity, type TransitLeg } from '@tripweaver/shared';
import { MEAL_RULES, isMeal, toMinutes, type MealKind } from '@tripweaver/services/itinerary/mealRules';

export type { MealCandidate, MealKind } from '@tripweaver/services/itinerary/mealRules';
export { isMeal, mealWindow } from '@tripweaver/services/itinerary/mealRules';

/** Deterministic meal insertion keeps a small transfer/settling buffer on both sides. */
export const MEAL_TRANSIT_BUFFER_MIN = 15;

/** 确定性补餐锚点的 id 前缀：餐次充实据此识别「占位餐」并替换成真实餐厅，不影响用户可见文案。 */
export const MEAL_ANCHOR_ID_PREFIX = 'meal-anchor-';

interface DraftDayLike {
  activities: Activity[];
  legs?: TransitLeg[];
}

/** 美食导向判定：只有用户偏好里显式选了「美食」才要求每天午晚餐（09-21 决策 D3/D6）。
 *  对齐 Yuntu 的 trip_is_food_focused，但只用显式偏好，不做关键词模糊匹配。 */
export function isFoodFocused(preferences: readonly string[] | undefined): boolean {
  return (preferences ?? []).includes('美食');
}

export function missingMeals(days: readonly DraftDayLike[]): Array<{ dayIndex: number; kind: MealKind }> {
  const missing: Array<{ dayIndex: number; kind: MealKind }> = [];
  days.forEach((day, index) => {
    for (const kind of ['lunch', 'dinner'] as const) {
      if (!day.activities.some((activity) => isMeal(activity, kind))) {
        missing.push({ dayIndex: index + 1, kind });
      }
    }
  });
  return missing;
}

export function mealCoverageProblems(days: readonly DraftDayLike[], options: { foodFocused: boolean }): string[] {
  // 非美食导向（09-21 D3/D6）：行程本就不要求午晚餐，餐次不是完整性问题
  if (!options.foodFocused) return [];
  return missingMeals(days).map(({ dayIndex, kind }) => {
    const { label } = MEAL_RULES[kind];
    return `第 ${dayIndex} 天缺少${label}（需安排就餐区域、菜系或代表菜，并预留明确时段）`;
  });
}

function interval(activity: Activity): readonly [number, number] | null {
  const start = activity.startTime ? toMinutes(activity.startTime) : null;
  const end = toMinutes(activity.endTime);
  return start !== null && end !== null && end > start ? [start, end] : null;
}

function chooseSlot(activities: readonly Activity[], kind: MealKind): readonly [string, string] | undefined {
  const blocked = activities.map(interval).filter((value): value is readonly [number, number] => value !== null);
  return MEAL_RULES[kind].slots.find(([startText, endText]) => {
    const start = toMinutes(startText)!;
    const end = toMinutes(endText)!;
    return blocked.every(
      ([blockedStart, blockedEnd]) =>
        blockedEnd + MEAL_TRANSIT_BUFFER_MIN <= start || blockedStart >= end + MEAL_TRANSIT_BUFFER_MIN,
    );
  });
}

function closestAnchor(activities: readonly Activity[], startTime: string): Activity | undefined {
  const target = toMinutes(startTime) ?? 0;
  const candidates = activities.filter((activity) => !MEAL_RULES.lunch.explicit.test(activity.name) && !MEAL_RULES.dinner.explicit.test(activity.name));
  const withCoords = candidates.filter((activity) => activity.lat !== 0 || activity.lng !== 0);
  const pool = withCoords.length ? withCoords : candidates;
  return [...pool].sort((a, b) => {
    const aStart = toMinutes(a.startTime);
    const bStart = toMinutes(b.startTime);
    return Math.abs((aStart ?? target) - target) - Math.abs((bStart ?? target) - target);
  })[0];
}

export interface MealRepair {
  dayIndex: number;
  kind: MealKind;
  activityName: string;
  action: 'inserted' | 'integrated';
}

/**
 * Last-resort deterministic repair. Normal generations are fixed by submit_plan first;
 * this protects persistence if a later reviewer edit removes the final lunch or dinner.
 */
export function ensureMealCoverage(days: DraftDayLike[], destination: string): MealRepair[] {
  const repairs: MealRepair[] = [];
  for (const { dayIndex, kind } of missingMeals(days)) {
    const day = days[dayIndex - 1]!;
    const rule = MEAL_RULES[kind];
    const slot = chooseSlot(day.activities, kind);
    if (!slot) {
      // 只有整段盖住用餐窗口的长活动（如远郊一日游）才做成「含午餐安排」；
      // 景点只是横跨窗口边缘时不整合——那会把「博物馆」改名成含午餐，重排时刻后文案还对不上。
      const overlapping = day.activities.find((activity) => {
        const span = interval(activity);
        return span !== null && span[0] <= rule.windowStart && span[1] >= rule.windowEnd;
      });
      if (overlapping) {
        const area = `「${overlapping.name}」所在片区`;
        overlapping.name = `${overlapping.name}（含${rule.label}安排）`.slice(0, 100);
        const reminder = `在${area}安排${destination}当地菜系或代表菜；具体门店、价格、评价、营业与排队情况请到大众点评或美团确认。`;
        overlapping.description = [overlapping.description, reminder].filter(Boolean).join(' ').slice(0, 500);
        repairs.push({ dayIndex, kind, activityName: overlapping.name, action: 'integrated' });
        continue;
      }
    }
    const [startTime, endTime] = slot ?? rule.slots[0]!;
    const anchor = closestAnchor(day.activities, startTime);
    const area = anchor ? `「${anchor.name}」周边` : `${destination}市区顺路片区`;
    const activityName = `${rule.label}｜${area} · 当地风味`.slice(0, 100);
    const hasAnchorCoord = Boolean(anchor && (anchor.lat !== 0 || anchor.lng !== 0));
    const activity: Activity = {
      id: `${MEAL_ANCHOR_ID_PREFIX}${uid()}`,
      name: activityName,
      startTime,
      endTime,
      description: `在${area}选择${destination}当地菜系或代表菜；具体门店、价格、评价、营业与排队情况请到大众点评或美团确认。`,
      lat: hasAnchorCoord ? anchor!.lat : 0,
      lng: hasAnchorCoord ? anchor!.lng : 0,
      coordSource: 'estimated',
      category: '美食',
      sourceNotes: [],
    };
    const start = toMinutes(startTime)!;
    const insertAt = day.activities.findIndex((candidate) => {
      const candidateStart = toMinutes(candidate.startTime);
      return candidateStart !== null && candidateStart > start;
    });
    if (insertAt < 0) day.activities.push(activity);
    else day.activities.splice(insertAt, 0, activity);
    delete day.legs;
    repairs.push({ dayIndex, kind, activityName, action: 'inserted' });
  }
  return repairs;
}
