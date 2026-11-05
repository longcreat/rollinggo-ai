// 中国法定节假日表：给「周一闭馆（法定节假日除外）」这类规则提供豁免依据。
//
// **数据来源**：国务院办公厅关于 2026 年部分节假日安排的通知（国办发明电〔2025〕7 号，2025-11-04 发布）。
// **维护节奏**：每年 11 月官方发布次年安排后更新本文件；未经确认的年份不要预先填写。
// 表里没有的年份 → `isPublicHoliday` 返回 false（不豁免），退回「只看星期」的既有行为，不会误放。
//
// **为什么只收「放假区间」，不收「调休上班日」**：场馆的开放规则按**星期**判定，不按「是否上班」。
// 调休上班的周末（如 2026-09-20 周日、2026-10-10 周六）场馆照常按周末运营，不需要特殊处理。
// 真正影响闭馆判定的只有一种情况：**本该闭馆的那天被列为法定节假日**（如 2026-10-05 周一属国庆假期，
// 故宫按惯例开放）。
//
// **已知取舍**：这里按「落在法定节假日就不判闭馆」处理，而不是要求原文写出「法定节假日除外」。
// 理由是全国博物馆/景区的周一闭馆规则普遍带这个例外，而库内证据极少显式写出它（覆盖率过低等于没做）。
// 代价是「节假日也闭馆」的少数场馆会被放过 —— 宁可漏判一次闭馆，不可把开放的节假日误判成闭馆。
export interface HolidayRange {
  /** 节日名（用于提示文案与排查，不参与判定） */
  name: string;
  /** 放假首日（YYYY-MM-DD，含） */
  from: string;
  /** 放假末日（YYYY-MM-DD，含） */
  to: string;
}

export const CN_HOLIDAYS: readonly HolidayRange[] = [
  { name: '元旦', from: '2026-01-01', to: '2026-01-03' },
  { name: '春节', from: '2026-02-15', to: '2026-02-23' },
  { name: '清明节', from: '2026-04-04', to: '2026-04-06' },
  { name: '劳动节', from: '2026-05-01', to: '2026-05-05' },
  { name: '端午节', from: '2026-06-19', to: '2026-06-21' },
  { name: '中秋节', from: '2026-09-25', to: '2026-09-27' },
  { name: '国庆节', from: '2026-10-01', to: '2026-10-07' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 命中的节假日；未命中或格式非法 → null */
export function findHoliday(dateStr: string | undefined | null): HolidayRange | null {
  if (!dateStr || !DATE_RE.test(dateStr)) return null;
  // 字符串比较即可：YYYY-MM-DD 定长零填充，字典序就是时间序
  return CN_HOLIDAYS.find((h) => dateStr >= h.from && dateStr <= h.to) ?? null;
}

/** dateStr（YYYY-MM-DD）是否落在法定节假日区间；格式非法或年份未收录 → false */
export function isPublicHoliday(dateStr: string | undefined | null): boolean {
  return findHoliday(dateStr) !== null;
}
