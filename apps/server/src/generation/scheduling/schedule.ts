// 确定性排程核心（09-21 落地 / 09-22 重构）：纯函数、零 IO、零外呼。
//
// **不产出时间轴**（09-22 D5）：拿不到可信的游玩时长，排出来的「几点到几点」全是假数据，
// 而且真实高德 leg 会在后处理阶段把这条假时间轴一路推爆（实测第 2 天被推到 22:45）。
// 现在只决定三件事：入选哪些点、每个点在哪天、当天内的顺路顺序。
//
// 分组算法：**先成链再切段**（route-first, cluster-second）
//   1. 全局最近邻把入选点连成一条巡游链，用于相近地点分组
//   2. 按容量切段，段内有界搜索满足先后约束的顺序，减少回折并缩短路程
//   3. 段按权重降序分配 Day1..k（D1：分数高的排靠前的天）
//
// 分数只决定「入选 + 分到哪天」，不插手段内顺序 —— 否则会把高分点插到不顺路的位置，
// 通勤成本又回来了（景山→故宫 41min 那种段就是这么来的）。
//
// ┌─ 排程算法 5 步概览（对应下面 buildSchedule 的代码块）──────────────┐
// │ 1. 入选：候选按 score 降序，但装填单位是「停留分量」不是「个数」──           │
// │    六个小点合计分量 14，一天装不下，会被拆成两天。                       │
// │ 2. 成链：全局最近邻把入选点连成一条巡游链（从一个点出发，每次接最近的）──────│
// │    └ 关联对（如「故宫—景山」）距离打 5 折，让强相关的两点在链上相邻 → 同天。│
// │ 3. 切段：按每日分量上限（moderate=8）把链切成段，一段就是一天。            │
// │ 4. 分天：段按「段内最高分」降序 → Day1..k；                            │
// │    再用一个状压 DP 把段与闭馆日做最优匹配（最小化「去了闭馆的」）。          │
// │ 5. 插餐：午餐插段中、晚餐放段尾，要求 2km 内且绕行 ≤2km，否则降级成区域名。 │
// └──────────────────────────────────────────────────────────────────────┘
import type { PoiCategory, TripPace } from '@tripweaver/shared';
import { dateForDayIndex, isClosedOnDate } from '@tripweaver/shared';
import { optimizeRouteOrder } from './routeOrder';
import { repairScheduleDates, type DateRepairResult } from './dateRepair';

export interface SchedulablePoi {
  id: string;
  name: string;
  /** 候选类目：attraction 参与排程；food 仅作为餐次锚点；hotel 不排成活动；other 仅用于空天占位 */
  category: PoiCategory | 'other';
  /** 坐标可缺省：无坐标候选不参与成链，按分数轮流补位（既有设计里坐标由 geoPipeline 事后解析） */
  lat?: number;
  lng?: number;
  /** 入选与分天权重（社区推荐分 + 提及次数的归一化合成），越大越优先 */
  score: number;
  /** 停留分量（1~3，见 visitWeight.ts）：没有可靠游玩时长，用相对量级守住「一天排不排得下」 */
  weight: number;
  /** 营业时间原文：景点与餐次候选的闭馆日检测用 */
  openTime?: string;
  /** payload.themes 的首个标签，用于每天主题 */
  theme?: string;
  /** 知识库的 8 活动类目（文化/自然/…），主题缺失时的回退标签 */
  kbCategory?: string;
}

export interface ScheduledStop {
  poi: SchedulablePoi;
  /** 确定性插入的餐次标记（锚点是真实美食候选，语义是「这一餐」） */
  meal?: 'lunch' | 'dinner';
  /** 无合适餐厅时引用真实景点的周边区域，不能冒充已核实门店。 */
  areaAnchorName?: string;
}

export interface ScheduledDay {
  dayIndex: number;
  /** 当天主题（成员 themes 众数 → 知识库类目 → 空天占位） */
  title: string;
  stops: ScheduledStop[];
}

export interface ScheduleOptions {
  days: number;
  /** 美食导向时每天插午餐 + 晚餐（D6：偏好含「美食」才要求） */
  foodFocused: boolean;
  /** longHaul.ts 判出的【强独占级】地点名：各自独占一天 */
  exclusiveNames?: readonly string[];
  /** 餐次锚点缺失、或空天占位时的兜底片区名（通常传目的地） */
  fallbackArea?: string;
  /** 行程开始日期（YYYY-MM-DD）：闭馆日避让的唯一日期输入；为空时不干预分天（拿不准不校验） */
  startDate?: string;
  /** 游览顺序硬约束（09-23 顺序种子表）：before 必须在 after 之前进链；两端都在入选集合才生效 */
  orderConstraints?: readonly { before: string; after: string }[];
  /** POI 无向关联对（09-27，来自 place_relation）：命中的两点成链时距离打折，使其更可能落进同一天 */
  relatedPairs?: ReadonlySet<string>;
  /** 旅行节奏（09-26）：决定每日容量上限；缺省 moderate（既有行为） */
  pace?: TripPace;
}

export interface ScheduleResult {
  days: ScheduledDay[];
  /** 因天数/容量不足未排入的候选数（D5：排不下就少排，不硬塞） */
  droppedCount: number;
  /** 未解决的闭馆冲突；结果保留所有已选景点供诊断，调用方必须阻止保存。 */
  closureConflicts: readonly ClosureConflict[];
  dateRepair: Pick<DateRepairResult, 'attempts' | 'reason'>;
}

export interface ClosureConflict {
  /** 当前日期仍闭馆的成员名 */
  names: readonly string[];
  /** 冲突日期（YYYY-MM-DD） */
  date: string;
  /** 该日期所属的法定节假日名；非节假日为 null */
  holiday: string | null;
}

export class ScheduleDateConflictError extends Error {
  readonly code = 'SCHEDULE_DATE_CONFLICT';
  constructor(readonly conflicts: readonly ClosureConflict[], readonly reason: DateRepairResult['reason'] | 'post_processing') {
    super(`当前日期无法安排全部已选景点：${conflicts.map((c) => `${c.date} ${c.names.join('、')}闭馆`).join('；')}。请调整出发日期或景点要求后重试。`);
    this.name = 'ScheduleDateConflictError';
  }
}

export const SCHEDULE_LIMITS = {
  /** 就餐点须靠近前后景点之一，且插入午餐造成的额外直线绕行不超过此值。 */
  mealNearbyKm: 2,
  mealDetourKm: 2,
  /** 单日最多活动数（既有单日 ≤8 完整性校验的上游约束，排程收紧到 6） */
  maxStopsPerDay: 6,
  /**
   * 强独占级地点最多吃掉多少比例的天数：远郊点占满一半就够，再多就没有市区行程了。
   * 3 天行程实测踩到：八达岭 + 慕田峪 各占一天 → 3 天里 2 天在长城。
   * 同类的远郊点（同为长城/同为古镇）自然被这个上限挤掉，不需要额外的相似度判定。
   */
  maxExclusiveDayRatio: 0.5,
  /**
   * 每日停留分量上限：8 = 一天 4 个普通景点，或 2 个大景区 + 1 个普通点。
   * 实测六个点挤一天（合计 12）会被拆成两天。
   */
  dayWeightLimit: 8,
  /** 空天占位活动的名称前缀（知识库无覆盖时如实占位，不编造地点） */
  emptyDayPrefix: '自由安排',
} as const;

/**
 * 节奏 → 每日容量（09-26）：轻松少排、紧凑多排；moderate 即 SCHEDULE_LIMITS 的既有默认。
 * 分量上限的换算直觉：普通点 weight≈2，relaxed 一天约 2 个点，moderate 约 4 个，tight 约 6 个；
 * tight 的 maxStopsPerDay=8 贴着下游「单日 ≤8」完整性校验，不再往上加。
 */
export const PACE_SCHEDULE_LIMITS: Record<TripPace, { maxStopsPerDay: number; dayWeightLimit: number }> = {
  relaxed: { maxStopsPerDay: 4, dayWeightLimit: 5 },
  moderate: { maxStopsPerDay: SCHEDULE_LIMITS.maxStopsPerDay, dayWeightLimit: SCHEDULE_LIMITS.dayWeightLimit },
  tight: { maxStopsPerDay: 8, dayWeightLimit: 12 },
};

type Coord = { lat: number; lng: number };

/** 类型守卫保留原对象类型（不降级成 Coord），否则 filter 会把 SchedulablePoi 的信息丢光 */
function hasCoord<T extends { lat?: number; lng?: number }>(poi: T): poi is T & Coord {
  return typeof poi.lat === 'number' && typeof poi.lng === 'number' && (poi.lat !== 0 || poi.lng !== 0);
}

export function distanceKm(a: Coord, b: Coord): number {
  const dLat = (a.lat - b.lat) * 111;
  const dLng = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

/** 无向 pair key（09-27）：两端用候选池实际名，顺序无关。buildDraft 解析关联对时用同一函数。 */
export function relatedPairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * 关联对的距离折扣（09-27）：命中关联对的两点在成链时按 0.5 倍距离竞争最近邻。
 * 只影响「谁接在谁后面」，不改变坐标与通勤计算 —— 折扣让原本 10km 内才抢得过的一对，
 * 20km 内也能抢，足以把强关联的点拉到链上相邻（→ 同段 → 同天），又不至于把链拉成不顺路的形状。
 */
const RELATED_DISCOUNT = 0.5;

/**
 * 全局最近邻成链：从权重最高的点出发，每次接最近的下一个。
 * 无坐标候选不参与几何成链（不知道它在哪），按分数接在链尾 —— 它们的坐标由 geoPipeline 事后解析。
 * orderConstraints（09-23 顺序种子表）：after 的前置点还在链外时跳过 after（拓扑意识最近邻）——
 * 修「景山排在故宫前」这类出入口方向错误；前置点无坐标（stranded）时约束无法满足，退让给纯距离。
 */
function buildChain(
  points: readonly SchedulablePoi[],
  orderConstraints: readonly { before: string; after: string }[] = [],
  relatedPairs: ReadonlySet<string> = new Set(),
): SchedulablePoi[] {
  const located = points.filter(hasCoord);
  const stranded = points.filter((poi) => !hasCoord(poi));
  if (located.length <= 1) return [...located, ...stranded];

  // after 名 → before 名；只约束 located 集合内的点对（stranded 在链尾，位置不受几何控制）
  const predecessorOf = new Map<string, Set<string>>();
  const locatedNames = new Set(located.map((poi) => poi.name));
  for (const c of orderConstraints) {
    if (locatedNames.has(c.before) && locatedNames.has(c.after) && c.before !== c.after) {
      const predecessors = predecessorOf.get(c.after) ?? new Set<string>();
      predecessors.add(c.before);
      predecessorOf.set(c.after, predecessors);
    }
  }

  const starts = located.filter((poi) => !predecessorOf.has(poi.name));
  // 循环约束无法满足时保持确定性降级；正常链的起点也必须满足先后关系。
  const startPool = starts.length ? starts : located;
  const start = startPool.reduce((best, poi) => (poi.score > best.score ? poi : best), startPool[0]!);
  const remaining = new Set<SchedulablePoi>(located);
  remaining.delete(start);
  const chain: SchedulablePoi[] = [start];
  let cursor: Coord = start;
  let cursorName = start.name;
  while (remaining.size) {
    const nearestOf = (pool: Iterable<SchedulablePoi>): SchedulablePoi | null => {
      let best: SchedulablePoi | null = null;
      let bestKm = Infinity;
      for (const poi of pool) {
        if (!hasCoord(poi)) continue;
        const km = distanceKm(cursor, poi);
        // 关联对折扣（09-27）：命中的两点按打折距离竞争最近邻，在链上自然相邻 → 更可能同段（天）
        const effectiveKm = relatedPairs.has(relatedPairKey(cursorName, poi.name)) ? km * RELATED_DISCOUNT : km;
        if (effectiveKm < bestKm) {
          bestKm = effectiveKm;
          best = poi;
        }
      }
      return best;
    };
    // 先在被约束允许的集合里找最近邻；循环前置约束堵住全部候选时退让，防死循环
    const eligible = [...remaining].filter((poi) => {
      const predecessors = predecessorOf.get(poi.name);
      return !predecessors || ![...remaining].some((r) => predecessors.has(r.name));
    });
    const nearest = nearestOf(eligible) ?? nearestOf(remaining);
    if (!nearest) break;
    chain.push(nearest);
    remaining.delete(nearest);
    if (hasCoord(nearest)) {
      cursor = nearest; // located 里元素必有坐标，这里只是让类型收窄
      cursorName = nearest.name;
    }
  }
  return [...chain, ...stranded];
}

/**
 * 把链按「每日停留分量上限 + 单日个数上限」切段，再复用受先后约束的最近邻排序。
 * 按分量而不是个数切，是因为个数根本区分不了「大点」与「小点」：
 * 实测 Day1 六个点（雍和宫/恭王府/故宫/北海/景山/什刹海）合计分量 14，两天都装不下。
 */
function cutChain(
  chain: readonly SchedulablePoi[],
  limits: { maxStopsPerDay: number; dayWeightLimit: number },
  orderConstraints: ScheduleOptions['orderConstraints'],
): SchedulablePoi[][] {
  const segments: SchedulablePoi[][] = [];
  let current: SchedulablePoi[] = [];
  let currentWeight = 0;
  for (const poi of chain) {
    const full =
      current.length >= limits.maxStopsPerDay ||
      currentWeight + poi.weight > limits.dayWeightLimit;
    if (current.length && full) {
      segments.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(poi);
    currentWeight += poi.weight;
  }
  if (current.length) segments.push(current);
  return segments.map((segment) => optimizeRouteOrder(buildChain(segment, orderConstraints), { constraints: orderConstraints }));
}

function dayTitle(members: readonly SchedulablePoi[]): string {
  const count = (pick: (poi: SchedulablePoi) => string | undefined) => {
    const tally = new Map<string, number>();
    for (const poi of members) {
      const value = pick(poi);
      if (value) tally.set(value, (tally.get(value) ?? 0) + 1);
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  // 先看社区主题标签，再退知识库的 8 活动类目（09-22 修：原来读的是 attraction/food/hotel 英文枚举，
  // 永远匹配不上中文类目表，每天都退化成「自由漫步」）
  return count((poi) => poi.theme) ?? count((poi) => poi.kbCategory) ?? '自由漫步';
}

/** 只选有坐标且顺路的门店；午餐按前后两点的增量距离排序，晚餐按末点距离。 */
function takeMealAnchor(foods: Set<SchedulablePoi>, before?: SchedulablePoi, after?: SchedulablePoi, date?: string): SchedulablePoi | undefined {
  const previous = before && hasCoord(before) ? before : undefined;
  const next = after && hasCoord(after) ? after : undefined;
  if (!previous && !next) return undefined;
  let best: SchedulablePoi | undefined;
  let bestDetour = Infinity;
  for (const food of foods) {
    if (!hasCoord(food)) continue;
    if (date && isClosedOnDate(food.openTime, date)) continue;
    const fromKm = previous ? distanceKm(previous, food) : Infinity;
    const toKm = next ? distanceKm(food, next) : Infinity;
    if (Math.min(fromKm, toKm) > SCHEDULE_LIMITS.mealNearbyKm) continue;
    const detour = previous && next ? Math.max(0, fromKm + toKm - distanceKm(previous, next)) : Math.min(fromKm, toKm);
    if (detour > SCHEDULE_LIMITS.mealDetourKm) continue;
    if (detour < bestDetour) {
      bestDetour = detour;
      best = food;
    }
  }
  if (best) foods.delete(best);
  return best;
}

/** 没有顺路门店时如实标注周边区域，复用景点位置；不会为了用完候选而跨城选餐。 */
export function selectMealStop(
  foods: Set<SchedulablePoi>,
  kind: 'lunch' | 'dinner',
  before: SchedulablePoi | undefined,
  after: SchedulablePoi | undefined,
  fallbackArea: string,
  date?: string,
): ScheduledStop {
  const anchor = takeMealAnchor(foods, before, after, date);
  const near = [before, after].find((point) => point && hasCoord(point));
  const poi: SchedulablePoi = anchor ?? {
    id: `meal-${kind}-${near?.id ?? 'area'}`,
    name: near ? `${near.name}周边` : fallbackArea,
    category: 'food',
    score: 0,
    weight: 1,
    ...(near ? { lat: near.lat, lng: near.lng } : {}),
  };
  return { poi, meal: kind, ...(!anchor && near ? { areaAnchorName: near.name } : {}) };
}

function placeholderStop(destination: string): ScheduledStop {
  return {
    poi: {
      id: `placeholder-${destination}`,
      name: `${SCHEDULE_LIMITS.emptyDayPrefix}｜${destination}`,
      category: 'other',
      score: 0,
      weight: 0,
    },
  };
}

/**
 * 排程主入口：入选 → 成链 → 切段 → 段按权重分天 → 餐次插槽 → 空天占位。
 *
 * 天数与段数可能对不上：强独占级点数 > 天数时，超出部分如实丢弃（不把远端点和市区点混排，
 * 那正是层2 长途点纪律要防的事）；候选不足时当天用占位活动兜底（保住「每天至少一个活动」的门槛）。
 */
export function buildSchedule(candidates: readonly SchedulablePoi[], options: ScheduleOptions): ScheduleResult {
  const paceLimits = { ...PACE_SCHEDULE_LIMITS[options.pace ?? 'moderate'] };
  // 完整性上限包含午晚餐；在切段前预留，不能排满景点后再超额追加。
  if (options.foodFocused) paceLimits.maxStopsPerDay = Math.min(paceLimits.maxStopsPerDay, 6);
  const byScore = (a: SchedulablePoi, b: SchedulablePoi) => b.score - a.score || a.name.localeCompare(b.name);
  const attractions = candidates.filter((poi) => poi.category === 'attraction').sort(byScore);
  const foods = new Set(candidates.filter((poi) => poi.category === 'food').sort(byScore));
  const dropped = new Set<SchedulablePoi>();

  const exclusiveNames = new Set(options.exclusiveNames ?? []);
  // 远郊独占点按分数降序：高分点优先占天
  const exclusive = attractions.filter((poi) => exclusiveNames.has(poi.name)).sort(byScore);
  const rest = attractions.filter((poi) => !exclusiveNames.has(poi.name));

  // 强独占级最多占一半天数，多出来的直接丢弃 —— 降级成普通点会把它塞进市区天，
  // 正是长途点纪律要防的事（慕田峪距市区 70km，与市区点混排就是实测那份 JSON 的病）。
  const exclusiveDayCap = Math.max(1, Math.floor(options.days * SCHEDULE_LIMITS.maxExclusiveDayRatio));
  const keptExclusive = exclusive.slice(0, exclusiveDayCap);
  for (const poi of exclusive.slice(exclusiveDayCap)) dropped.add(poi);

  // 入选容量按**停留分量**，且只看剩下的天数（独占日各自只放它自己那 1 个点）。
  // 按分数降序贪心装填：装不下的（太占分量）跳过，由后面的轻点补位。
  const remainingDays = options.days - keptExclusive.length;
  const weightCapacity = Math.max(0, remainingDays * paceLimits.dayWeightLimit);
  const selected: SchedulablePoi[] = [];
  let usedWeight = 0;
  for (const poi of rest) {
    if (usedWeight + poi.weight > weightCapacity) {
      dropped.add(poi);
      continue;
    }
    selected.push(poi);
    usedWeight += poi.weight;
  }

  const segments: SchedulablePoi[][] = keptExclusive.map((poi) => [poi]);
  if (remainingDays > 0 && selected.length) {
    const restSegments = cutChain(buildChain(selected, options.orderConstraints, options.relatedPairs), paceLimits, options.orderConstraints);
    // 切出来的段多于剩余天数（分量分布不均时会发生）：多出来的整段丢弃，不硬塞
    for (const segment of restSegments.slice(remainingDays)) {
      for (const poi of segment) dropped.add(poi);
    }
    segments.push(...restSegments.slice(0, remainingDays));
  }

  // 段按权重降序 → Day1..k（D1：分数高的排靠前）。
  // 权重取**段内最高分**而非总分：总分会让「三个平庸点」压过「一个必去点」，
  // 把长城这类独占日的头牌推到 Day2。
  const weight = (segment: readonly SchedulablePoi[]) => Math.max(...segment.map((poi) => poi.score));
  segments.sort((a, b) => weight(b) - weight(a));

  // 整段匹配作为快速路径；剩余冲突再做有界跨日重组。
  const closedCountOn = (segment: readonly SchedulablePoi[], dayIndex: number): number => {
    if (!options.startDate) return 0;
    const date = dateForDayIndex(options.startDate, dayIndex + 1);
    if (!date) return 0;
    return segment.filter((poi) => isClosedOnDate(poi.openTime, date)).length;
  };

  // 全局日期匹配（最多 15 天，状态数 <= 2^15）：最少闭馆活动，不再用删段降低成本。
  // 同成本优先把高分段排在较早日期；不会让灵活段占走其他段唯一的开放日。
  const closedCounts = segments.map((segment) => Array.from({ length: options.days }, (_, i) => closedCountOn(segment, i)));
  const memo = new Map<number, { cost: number; day: number }>();
  const assign = (index: number, mask: number): number => {
    if (index === segments.length) return 0;
    const cached = memo.get(mask);
    if (cached) return cached.cost;
    let best = { cost: Infinity, day: -1 };
    for (let day = 0; day < options.days; day++) {
      if (mask & (1 << day)) continue;
      const closed = closedCounts[index]![day]!;
      const cost = closed + assign(index + 1, mask | (1 << day));
      if (cost < best.cost) best = { cost, day };
    }
    memo.set(mask, best);
    return best.cost;
  };
  assign(0, 0);
  let assignedMask = 0;
  const assigned: SchedulablePoi[][] = Array.from({ length: options.days }, () => []);
  for (const segment of segments) {
    const target = memo.get(assignedMask)!.day;
    assignedMask |= 1 << target;
    assigned[target] = segment;
  }
  const repaired = repairScheduleDates(assigned, options, paceLimits);

  const fallbackArea = options.fallbackArea?.trim() || '目的地';
  const days: ScheduledDay[] = Array.from({ length: options.days }, (_, index) => ({
    dayIndex: index + 1,
    title: '自由漫步',
    stops: [] as ScheduledStop[],
  }));

  for (const [target, segment] of repaired.days.entries()) {
    if (!segment.length) continue;
    const day = days[target]!;
    day.title = dayTitle(segment);
    const stops: ScheduledStop[] = segment.map((poi) => ({ poi }));
    if (options.foodFocused) {
      // 午餐落在段中段之后、晚餐落段尾：没有时间轴，位置只表达阅读顺序
      const date = options.startDate ? dateForDayIndex(options.startDate, target + 1) : undefined;
      const lunchAt = Math.max(1, Math.ceil(stops.length / 2));
      stops.splice(lunchAt, 0, selectMealStop(foods, 'lunch', segment[lunchAt - 1], segment[lunchAt], fallbackArea, date));
      stops.push(selectMealStop(foods, 'dinner', segment[segment.length - 1], undefined, fallbackArea, date));
    }
    day.stops = stops;
  }

  for (const day of days) {
    if (day.stops.length) continue;
    day.title = SCHEDULE_LIMITS.emptyDayPrefix;
    day.stops = [placeholderStop(fallbackArea)];
    if (options.foodFocused) {
      day.stops.push(selectMealStop(foods, 'lunch', undefined, undefined, fallbackArea));
      day.stops.push(selectMealStop(foods, 'dinner', undefined, undefined, fallbackArea));
    }
  }

  return { days, droppedCount: dropped.size, closureConflicts: repaired.conflicts,
    dateRepair: { attempts: repaired.attempts, ...(repaired.reason ? { reason: repaired.reason } : {}) } };
}
