// 闭馆冲突契约与检测（自 scheduling/schedule.ts 与 dateRepair.ts 下沉）：
// 排程与后处理共用同一份「哪天哪些景点闭馆」的判定与错误类型，
// orchestrator 在排程后、落库前用它做最终闸门（conflicts 非空即失败，不落库）。
import { dateForDayIndex, findHoliday, isClosedOnDate } from '@rollinggo-trip/shared';

export interface ClosureConflict {
  /** 当前日期仍闭馆的成员名 */
  names: readonly string[];
  /** 冲突日期（YYYY-MM-DD） */
  date: string;
  /** 该日期所属的法定节假日名；非节假日为 null */
  holiday: string | null;
}

/** 修复/搜索的失败原因：no_open_day 无任何开放日；search_* 有界搜索耗尽上限，如实回报不假装成功 */
export type ClosureConflictReason = 'no_open_day' | 'search_exhausted' | 'search_limit';

export class ScheduleDateConflictError extends Error {
  readonly code = 'SCHEDULE_DATE_CONFLICT';
  constructor(readonly conflicts: readonly ClosureConflict[], readonly reason: ClosureConflictReason | 'post_processing') {
    super(`当前日期无法安排全部已选景点：${conflicts.map((c) => `${c.date} ${c.names.join('、')}闭馆`).join('；')}。请调整出发日期或景点要求后重试。`);
    this.name = 'ScheduleDateConflictError';
  }
}

/** 逐天检查成员闭馆情况：只要名单里有当天闭馆的景点就报一条冲突（调用方据此阻止落库） */
export function scheduleClosureConflicts(
  days: readonly (readonly { name: string; openTime?: string }[])[], startDate?: string,
): ClosureConflict[] {
  return days.flatMap((members, i) => {
    const date = dateForDayIndex(startDate, i + 1);
    const names = members.filter((p) => isClosedOnDate(p.openTime, date)).map((p) => p.name);
    return names.length && date ? [{ names, date, holiday: findHoliday(date)?.name ?? null }] : [];
  });
}
