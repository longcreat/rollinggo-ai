// 营业时间文本的闭馆日检测（09-22-opentime）：只做「哪天闭馆」，不做时间窗校验。
// 去时间轴（09-22 D5）之后没有「几点到访」可校验，时间窗约束无从谈起；
// 闭馆日只需日期，与无时间轴排程兼容。
// 解析思路参考 FloatTrip _closed_on_date：按星期标签匹配子句 + 闭馆关键词。
// 高德 opentime 是自由文本（如「09:00-17:00；周一闭馆」「周一、周二不开放」），
// 拿不准就返回 false（不校验）——缺数据时静默跳过，绝不错误拦截（truthful degradation）。
//
// **法定节假日豁免（09-27）**：场馆的「周X闭馆」普遍带「法定节假日除外」（故宫、国博、天安门城楼等），
// 落在放假区间内一律不判闭馆。数据来源与已知取舍见 holidays.ts。
import { isPublicHoliday } from './holidays';

/** 星期标签表：索引 = Date.getDay()（0=周日） */
const WEEKDAY_LABELS: readonly (readonly string[])[] = [
  ['周日', '周天', '星期日', '星期天'],
  ['周一', '星期一'],
  ['周二', '星期二'],
  ['周三', '星期三'],
  ['周四', '星期四'],
  ['周五', '星期五'],
  ['周六', '星期六'],
];

const CLOSED_KEYWORDS = /(闭馆|不开放|休息|停业)/;

/**
 * 判断 openTime 文本是否声明了 dateStr（YYYY-MM-DD）当天闭馆。
 * openTime 或 dateStr 缺失/非法 → false（无数据不校验）；dateStr 落在法定节假日 → false（豁免）。
 */
export function isClosedOnDate(openTime: string | undefined | null, dateStr: string | undefined | null): boolean {
  if (!openTime || !dateStr) return false;
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  // 法定节假日豁免（09-27）：节假日当天不按「周X闭馆」拦截
  if (isPublicHoliday(dateStr)) return false;
  const labels = WEEKDAY_LABELS[date.getDay()]!;
  return openTime
    .split(/[；;。\n]/)
    .some((clause) => labels.some((label) => clause.includes(label)) && CLOSED_KEYWORDS.test(clause));
}

/** startDate（YYYY-MM-DD 或空串）+ dayIndex（从 1 开始）→ 当天的 YYYY-MM-DD；startDate 空/非法返回 undefined */
export function dateForDayIndex(startDate: string | undefined | null, dayIndex: number): string | undefined {
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return undefined;
  const base = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(base.getTime())) return undefined;
  base.setDate(base.getDate() + (dayIndex - 1));
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  const d = String(base.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
