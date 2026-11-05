// 日期重排只处理已入选景点；不删点、不引入新点，失败结果不能落库。
//
// ┌─ 这个文件解决什么问题 ─────────────────────────────────┐
// │ 国内景点普遍有闭馆日（博物馆周一闭馆、节假日特殊安排、预约制限流），  │
// │ 按分数排出来的分组很可能把某个景点放到它关门的那天。              │
// │ 这里在「已排好的分天结果」上做局部搜索：交换、拆分、合并整段，     │
// │ 让每个景点都落在它开放的那天。                                  │
// └───────────────────────────────────────────────────────┘
//
// ┌─ 三个安全阀（为什么它不会把行程改乱）──────────────────────────┐
// │ 1. 不删不增：只重排已入选的点，不会为了避开闭馆日而偷掉景点          │
// │    （真避不开时返回 closureConflicts，调用方阻止落库）。            │
// │ 2. 路线不能变差：改动后的几何长度不得超过原路线 +2km 或 +10%，     │
// │    避免为了修复一个闭馆日而把整条路线拉成折返跑。                │
// │ 3. 搜索有上限：30000 次尝试 / 256 状态 / 16 前沿，超限如实回报      │
// │    reason（search_exhausted / search_limit），不假装成功。          │
// └───────────────────────────────────────────────────────┘
//
// bundles()：把有先后约束的点（如「先故宫后景山」）打包成不可拆单元，
// 避免修复时把它们的顺序打乱。
import { dateForDayIndex, findHoliday, isClosedOnDate } from '@tripweaver/shared';
import type { ClosureConflict, SchedulablePoi, ScheduleOptions } from './schedule';
import { optimizeRouteOrder, routeDistanceMeters } from './routeOrder';

export const DATE_REPAIR_LIMITS = {
  attempts: 30000,
  states: 256,
  frontier: 16,
  // 实际路网仍由后续 geo 计算。几何回归不超过原路线总长的 10% 或 2km。
  extraDistanceMeters: 2000,
  extraDistanceRatio: 0.1,
} as const;

export interface DateRepairResult {
  days: SchedulablePoi[][];
  conflicts: ClosureConflict[];
  attempts: number;
  reason?: 'no_open_day' | 'search_exhausted' | 'search_limit';
}

export function scheduleClosureConflicts(
  days: readonly (readonly { name: string; openTime?: string }[])[], startDate?: string,
): ClosureConflict[] {
  return days.flatMap((members, i) => {
    const date = dateForDayIndex(startDate, i + 1);
    const names = members.filter((p) => isClosedOnDate(p.openTime, date)).map((p) => p.name);
    return names.length && date ? [{ names, date, holiday: findHoliday(date)?.name ?? null }] : [];
  });
}

/** 将同天先后组合视为不可拆单元；其他地点仍可单点或双单元交换。 */
function bundles(points: readonly SchedulablePoi[], constraints: NonNullable<ScheduleOptions['orderConstraints']>): SchedulablePoi[][] {
  const groups = points.map((p) => [p]);
  for (const { before, after } of constraints) {
    const a = groups.findIndex((g) => g.some((p) => p.name === before));
    const b = groups.findIndex((g) => g.some((p) => p.name === after));
    if (a < 0 || b < 0 || a === b) continue;
    groups[a]!.push(...groups[b]!);
    groups.splice(b, 1);
  }
  return groups;
}

function selections(groups: readonly SchedulablePoi[][]): SchedulablePoi[][] {
  return groups.flatMap((group, i) => [group, ...groups.slice(i + 1).map((other) => [...group, ...other])]);
}

/** 修复路径的拓扑排序也保留无坐标先后关系；几何排序只在约束允许范围内优化。 */
function order(points: readonly SchedulablePoi[], constraints: NonNullable<ScheduleOptions['orderConstraints']>): SchedulablePoi[] | undefined {
  const remaining = [...points];
  const result: SchedulablePoi[] = [];
  while (remaining.length) {
    const i = remaining.findIndex((p) => !constraints.some((c) => c.after === p.name && c.before !== c.after && remaining.some((q) => q.name === c.before)));
    if (i < 0) return undefined;
    result.push(remaining.splice(i, 1)[0]!);
  }
  return optimizeRouteOrder(result, { constraints });
}

export function repairScheduleDates(
  original: readonly SchedulablePoi[][],
  options: ScheduleOptions,
  capacity: { maxStopsPerDay: number; dayWeightLimit: number },
): DateRepairResult {
  const dates = original.map((_, i) => dateForDayIndex(options.startDate, i + 1));
  const points = original.flat();
  const available = new Map(points.map((p) => [p.id, dates.map((date) => !isClosedOnDate(p.openTime, date))]));
  const closed = (p: SchedulablePoi, day: number) => !available.get(p.id)![day];
  const conflicts = (days: readonly SchedulablePoi[][]) => scheduleClosureConflicts(days, options.startDate);
  const initial = original.map((day) => [...day]);
  const initialConflicts = conflicts(initial);
  if (!initialConflicts.length) return { days: initial, conflicts: [], attempts: 0 };
  if (points.some((p) => available.get(p.id)!.every((value) => !value))) {
    return { days: initial, conflicts: initialConflicts, attempts: 0, reason: 'no_open_day' };
  }
  const constraints = options.orderConstraints ?? [];
  const exclusive = new Set(options.exclusiveNames);
  const origin = new Map(points.map((p) => [p.id, original.findIndex((day) => day.includes(p))]));
  const distance = (days: readonly SchedulablePoi[][]) => days.reduce((sum, day) => sum + routeDistanceMeters(day), 0);
  const baseline = distance(initial);
  const ceiling = baseline + Math.max(DATE_REPAIR_LIMITS.extraDistanceMeters, baseline * DATE_REPAIR_LIMITS.extraDistanceRatio);
  const validCapacity = (day: readonly SchedulablePoi[]) => day.length <= capacity.maxStopsPerDay
    && day.reduce((sum, p) => sum + p.weight, 0) <= capacity.dayWeightLimit
    && (!day.some((p) => exclusive.has(p.name)) || day.length === 1);
  const validOrder = (days: readonly SchedulablePoi[][]) => {
    const positions = new Map(days.flatMap((day, i) => day.map((p, j) => [p.name, i * 100 + j] as const)));
    return constraints.every(({ before, after }) => before === after || !positions.has(before) || !positions.has(after) || positions.get(before)! < positions.get(after)!);
  };
  const keyOf = (days: readonly SchedulablePoi[][]) => JSON.stringify(days.map((day) => day.map((p) => p.id).sort()));
  const rank = (days: SchedulablePoi[][]) => ({ days, key: keyOf(days),
    closed: days.reduce((sum, day, i) => sum + day.filter((p) => closed(p, i)).length, 0),
    distance: distance(days), moves: days.reduce((sum, day, i) => sum + day.filter((p) => origin.get(p.id) !== i).length, 0) });
  type State = ReturnType<typeof rank>;
  const compare = (a: State, b: State) => a.closed - b.closed || a.distance - b.distance || a.moves - b.moves || a.key.localeCompare(b.key);
  let best = rank(initial);
  let frontier = [best];
  let attempts = 0, expanded = 0;
  const seen = new Set([best.key]);
  // 每日集合的排序最多计算一次；拒绝容量/日期/跨日顺序后再做几何搜索。
  const ordered = new Map<string, SchedulablePoi[] | undefined>();
  const orderDay = (day: SchedulablePoi[]) => {
    const key = JSON.stringify(day.map((p) => p.id).sort());
    if (!ordered.has(key)) ordered.set(key, order(day, constraints));
    return ordered.get(key);
  };
  while (frontier.length && attempts < DATE_REPAIR_LIMITS.attempts && expanded < DATE_REPAIR_LIMITS.states) {
    const state = frontier.shift()!;
    expanded++;
    const next: State[] = [];
    for (let from = 0; from < state.days.length && attempts < DATE_REPAIR_LIMITS.attempts; from++) {
      const source = state.days[from]!;
      if (!source.some((p) => closed(p, from))) continue;
      const outgoing = selections(bundles(source, constraints)).filter((set) => set.some((p) => closed(p, from)));
      for (let to = 0; to < state.days.length && attempts < DATE_REPAIR_LIMITS.attempts; to++) {
        if (from === to) continue;
        const target = state.days[to]!;
        for (const move of outgoing) {
          if (move.some((p) => closed(p, to))) continue;
          for (const back of [[], ...selections(bundles(target, constraints))]) {
            if (attempts >= DATE_REPAIR_LIMITS.attempts) break;
            attempts++;
            if (back.some((p) => closed(p, from))) continue;
            const a = [...source.filter((p) => !move.includes(p)), ...back];
            const b = [...target.filter((p) => !back.includes(p)), ...move];
            // 修复不能腾空已有的一天来隐藏冲突，原本空闲日则可以接收景点。
            if (!a.length || !validCapacity(a) || !validCapacity(b)) continue;
            const candidate = state.days.map((day, i) => i === from ? a : i === to ? b : day);
            const key = keyOf(candidate);
            if (seen.has(key)) continue;
            seen.add(key);
            const sortedA = orderDay(a), sortedB = orderDay(b);
            if (!sortedA || !sortedB) continue;
            candidate[from] = sortedA; candidate[to] = sortedB;
            if (!validOrder(candidate)) continue;
            const ranked = rank(candidate);
            if (ranked.distance > ceiling || ranked.closed >= state.closed) continue;
            if (compare(ranked, best) < 0) best = ranked;
            next.push(ranked);
          }
        }
      }
    }
    if (!best.closed) return { days: best.days, conflicts: [], attempts };
    frontier = [...frontier, ...next].sort(compare).slice(0, DATE_REPAIR_LIMITS.frontier);
  }
  return { days: best.days, conflicts: conflicts(best.days), attempts,
    reason: attempts >= DATE_REPAIR_LIMITS.attempts || expanded >= DATE_REPAIR_LIMITS.states ? 'search_limit' : 'search_exhausted' };
}
