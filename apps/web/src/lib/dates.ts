// ISO 日期小工具（09-26）：NewTripPage 与首页胶囊共用。

/** 今天起第 N 天的 ISO 日期（0 = 今天） */
export function isoDateAfter(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return toISO(d);
}

/** ISO 日期加 N 天 */
export function addDays(iso: string, n: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** 含首尾的天数（同日 = 1 天） */
export function daysBetween(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** "2026-09-27" → "09/27" */
export function shortDate(iso: string): string {
  return iso.slice(5).replace('-', '/');
}

/** 合法 ISO 日期（YYYY-MM-DD）校验 */
export function isISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return !Number.isNaN(parseISO(s).getTime());
}

function parseISO(iso: string): Date {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
