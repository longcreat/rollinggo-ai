// 餐次窗口是行程时间轴的一部分，不属于生成流水线。
// 生成、补餐、路线优化与详情编辑都从这里取同一份窗口规则。
export type MealKind = 'lunch' | 'dinner';

export interface MealRule {
  label: '午餐' | '晚餐';
  explicit: RegExp;
  windowStart: number;
  windowEnd: number;
  slots: readonly (readonly [string, string])[];
}

export const MEAL_RULES: Record<MealKind, MealRule> = {
  lunch: {
    label: '午餐',
    explicit: /(午餐|午饭|中餐)/,
    windowStart: 11 * 60,
    windowEnd: 14 * 60 + 30,
    slots: [
      ['12:00', '13:15'],
      ['11:30', '12:45'],
      ['12:30', '13:45'],
      ['13:00', '14:15'],
      ['13:15', '14:30'],
    ],
  },
  dinner: {
    label: '晚餐',
    explicit: /(晚餐|晚饭)/,
    windowStart: 17 * 60,
    windowEnd: 21 * 60 + 30,
    slots: [
      ['18:00', '19:15'],
      ['18:30', '19:45'],
      ['19:00', '20:15'],
      ['17:30', '18:45'],
      ['19:30', '20:45'],
      ['20:00', '21:15'],
    ],
  },
};

export function toMinutes(time: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

/** 只依赖名称/类目/开始时刻，便于排程层用更窄的结构调用。 */
export interface MealCandidate {
  name: string;
  category?: string;
  startTime?: string;
}

/** A labelled meal always counts; otherwise a food activity must start in that meal window. */
export function isMeal(activity: MealCandidate, kind: MealKind): boolean {
  const rule = MEAL_RULES[kind];
  if (rule.explicit.test(activity.name)) return true;
  if (activity.category !== '美食') return false;
  const start = activity.startTime ? toMinutes(activity.startTime) : null;
  return start !== null && start >= rule.windowStart && start <= rule.windowEnd;
}

export function mealWindow(kind: MealKind): Readonly<{ start: number; end: number }> {
  const rule = MEAL_RULES[kind];
  return { start: rule.windowStart, end: rule.windowEnd };
}
