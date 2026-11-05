export function uid(): string {
  return globalThis.crypto.randomUUID();
}

// 服务器时区的「今日零点 / 次日零点」时间戳
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfTomorrow(now = Date.now()): number {
  return startOfToday(now) + 24 * 60 * 60 * 1000;
}
