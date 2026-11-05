// 可行性引擎（M0-A）：纯代码的行程时空模拟器 —— 逐日顺序推演真实时间线，产出结构化违规报告
// 纯函数、无 IO、无 server/DOM 依赖：server 生成期（planner 门槛 + reviewer 弹药）与未来评测/前端共用同一份。
// 定位：LLM proposes, solver disposes —— 可行性由代码计算，不再交给模型语感判断。
import { haversineMeters } from './geo';
import { effectiveLegMode, estimateTransit, lodgingLegsForDay } from './legs';
import { dateForDayIndex, isClosedOnDate } from './openHours';
import type { LegMode, Trip, TripDay } from './types';

// ---------- 违规分级与阈值（集中常量，spec 记录来源与调参口径） ----------

/** 违规码：closed_on_arrival 自 09-22-opentime 起启用（活动携带高德营业时间原文 + trip.startDate 非空时产出） */
export type ViolationCode =
  | 'transit_infeasible'   // 硬：单段通勤时长 > 相邻活动时间间隔，物理排不下
  | 'overpacked'           // 硬：日总时长 > 14h；软：活动数 > 8 / 步行 > 15km / 缓冲 < 10%
  | 'backtrack'            // 软：相邻三点回头角 > 90° 且回跳 > 2km
  | 'anchor_missing'       // 软：住宿锚点已指定但坐标未解析，无法计算住宿↔活动通勤
  | 'closed_on_arrival';   // 硬：活动安排在闭馆日（营业时间文本声明该星期闭馆）

export type ViolationSeverity = 'hard' | 'soft';

export interface Violation {
  code: ViolationCode;
  severity: ViolationSeverity;
  dayIndex: number;        // 从 1 开始
  activityId?: string;     // 定位到具体活动（day 级问题可空）
  message: string;         // 面向人的中文说明
  detail?: string;         // 补充（如「通勤为直线估算，低置信」）
}

/** 可行性阈值 —— 常识默认值，可调；来源见 .trellis/spec/server/backend/generation-guidelines.md */
export const FEASIBILITY_THRESHOLDS = {
  hardDayTotalMin: 14 * 60,     // 硬：日活动占用 + 通勤 > 14h → overpacked
  softMaxActivities: 8,         // 软：日活动数 > 8 → overpacked
  softWalkMeters: 15_000,       // 软：日步行累计 > 15km → overpacked
  softBufferRatio: 0.1,         // 软：日缓冲比 < 10% → overpacked（时间窗几乎排满）
  backtrackTurnCosMax: 0,       // 软：回头角 > 90° ⟺ 方向向量夹角余弦 < 0
  backtrackJumpMeters: 2_000,   // 软：且该段直线回跳 > 2km 才判折返（滤掉小抖动）
} as const;

// ---------- 单日报告 ----------

export interface DayReport {
  dayIndex: number;
  activityCount: number;
  activityMinutes: number;      // 有起止时间的活动占用合计（缺时间的活动不臆造，计 0）
  transitMinutes: number;       // 当日通勤合计（活动间 + 住宿 leg；无 leg 时按 haversine 估算）
  totalMinutes: number;         // 活动占用 + 通勤
  walkingMeters: number;        // 步行段直线距离累计
  bufferRatio: number | null;   // 缓冲比（1 - 用时/时间窗）；无法计算（缺首尾时间）为 null
  violations: Violation[];
}

export interface FeasibilityReport {
  dayReports: DayReport[];
  violations: Violation[];      // 全行程扁平清单（消费方直接用）
}

/** simulateDay 上下文：出行方式基调 + 当天有效住宿锚点 + 预留营业时间位 */
export interface DaySimContext {
  dayIndex: number;
  baseMode: LegMode;                                   // 无 leg 时 haversine 兜底的出行基调
  lodging?: { name?: string; lat?: number; lng?: number } | null;   // day 级覆盖或 Trip 级
  /** 当天的日历日期（YYYY-MM-DD，simulateTrip 由 startDate + dayIndex 推出）：闭馆日判定的唯一输入；
   *  缺省时 closed_on_arrival 整体跳过（去时间轴后无时刻可校验，只有日期维度）。 */
  date?: string;
  /** 坐标解析是否已尝试（geoPipeline 已跑）。false 时抑制 anchor_missing —— 解析前报「住宿无坐标」是噪声，
   *  planner 无从修复。缺省 true：直接 simulateDay 的单测按「已解析」语义。 */
  anchorResolutionAttempted?: boolean;
}

// ---------- 几何/时间纯工具 ----------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEG = Math.PI / 180;
const EARTH_R = 6371000;

interface Coord {
  lat: number;
  lng: number;
}

/** 有效坐标：非空且非 (0,0) 原点占位 */
function hasCoord(p?: { lat?: number; lng?: number } | null): p is Coord {
  return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && (p.lat !== 0 || p.lng !== 0);
}

/** "HH:mm" → 距零点分钟；非法/空回 null */
function toMinutes(hhmm: string | undefined): number | null {
  if (!hhmm || !TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

/** 以 o 为原点，p 的局部平面坐标（米）；经度按纬度余弦缩放 */
function localVector(o: Coord, p: Coord): { x: number; y: number } {
  return {
    x: (p.lng - o.lng) * DEG * EARTH_R * Math.cos(o.lat * DEG),
    y: (p.lat - o.lat) * DEG * EARTH_R,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- 单日模拟 ----------

/**
 * 逐日推演一天的时空可行性。降级铁律（R6）：
 * - 活动缺坐标 → 该相邻段的通勤/折返判定跳过，不误报可行也不误报违规；
 * - 缺 leg → 用 haversine 估算并在 detail 标注低置信；
 * - 任何降级都不抛错（生成不失败原则由调用方保证，本函数天然无 IO）。
 */
export function simulateDay(day: TripDay, ctx: DaySimContext): DayReport {
  const { dayIndex, baseMode } = ctx;
  const activities = day.activities;
  const violations: Violation[] = [];

  // 活动占用：仅统计起止时间齐备且 end>start 的活动，缺时间不臆造
  let activityMinutes = 0;
  for (const a of activities) {
    const s = toMinutes(a.startTime);
    const e = toMinutes(a.endTime);
    if (s !== null && e !== null && e > s) activityMinutes += e - s;
  }

  // 相邻活动通勤：优先取已有 leg，无 leg 且两端有坐标则 haversine 估算，任一端无坐标则跳过
  const legFor = (fromId: string, toId: string) =>
    day.legs?.find((l) => l.fromActivityId === fromId && l.toActivityId === toId);

  let transitMinutes = 0;
  let walkingMeters = 0;

  for (let i = 0; i + 1 < activities.length; i++) {
    const from = activities[i]!;
    const to = activities[i + 1]!;
    const leg = legFor(from.id, to.id);
    let durationMin: number | null = null;
    let mode: LegMode = baseMode;
    let estimated = false;

    if (leg) {
      durationMin = leg.durationMin;
      mode = leg.mode;
      if (leg.mode === 'walk') walkingMeters += leg.distanceM;
    } else if (hasCoord(from) && hasCoord(to)) {
      // 无 leg 兜底：与 geoPipeline 共用 effectiveLegMode（判据与执行同一套模型），标注低置信
      mode = effectiveLegMode(from, to, baseMode);
      const est = estimateTransit(from, to, mode);
      durationMin = est.durationMin;
      estimated = true;
      if (mode === 'walk') walkingMeters += est.distanceM;
    }
    if (durationMin === null) continue;   // 无坐标且无 leg：无法判定，跳过该段
    transitMinutes += durationMin;

    // transit_infeasible（硬）：两端时间齐备时，通勤时长 > 时间间隔即物理排不下
    const prevEnd = toMinutes(from.endTime);
    const nextStart = toMinutes(to.startTime);
    if (prevEnd !== null && nextStart !== null) {
      const gap = nextStart - prevEnd;
      if (durationMin > gap) {
        const reason =
          gap < 0
            ? `两活动时间重叠 ${-gap} 分钟，还需 ${durationMin} 分钟通勤`
            : `通勤约 ${durationMin} 分钟，但两活动仅间隔 ${gap} 分钟`;
        violations.push({
          code: 'transit_infeasible',
          severity: 'hard',
          dayIndex,
          activityId: to.id,
          message: `「${from.name}」→「${to.name}」${reason}，排不下`,
          ...(estimated ? { detail: '通勤时长为直线估算，低置信' } : {}),
        });
      }
    }
  }

  // 住宿 leg 计入当日通勤与步行（geoPipeline 已写入时才有；缺失即不计，不臆造）。
  // 哨兵匹配复用 @tripweaver/shared 的 lodgingLegsForDay（与前端 DaySection/地图同一事实源，避免漂移）。
  const { departure: dep, returning: ret } = lodgingLegsForDay(day);
  if (dep) {
    transitMinutes += dep.durationMin;
    if (dep.mode === 'walk') walkingMeters += dep.distanceM;
  }
  if (ret) {
    transitMinutes += ret.durationMin;
    if (ret.mode === 'walk') walkingMeters += ret.distanceM;
  }

  const totalMinutes = activityMinutes + transitMinutes;

  // 缓冲比：仅当首活动起点与末活动终点齐备且时间窗 > 0 才可计（≥2 活动）；否则 null
  let bufferRatio: number | null = null;
  if (activities.length >= 2) {
    const windowStart = toMinutes(activities[0]!.startTime);
    const windowEnd = toMinutes(activities[activities.length - 1]!.endTime);
    if (windowStart !== null && windowEnd !== null && windowEnd > windowStart) {
      const windowMin = windowEnd - windowStart;
      bufferRatio = (windowMin - activityMinutes - transitMinutes) / windowMin;
    }
  }

  // overpacked 硬：日总时长 > 14h
  if (totalMinutes > FEASIBILITY_THRESHOLDS.hardDayTotalMin) {
    violations.push({
      code: 'overpacked',
      severity: 'hard',
      dayIndex,
      message: `当日总时长约 ${round1(totalMinutes / 60)} 小时（活动 ${round1(activityMinutes / 60)}h + 通勤 ${round1(
        transitMinutes / 60,
      )}h），超过 ${FEASIBILITY_THRESHOLDS.hardDayTotalMin / 60} 小时上限`,
    });
  }

  // overpacked 软：活动数 / 步行 / 缓冲（密度与节奏提示，不阻断）
  if (activities.length > FEASIBILITY_THRESHOLDS.softMaxActivities) {
    violations.push({
      code: 'overpacked',
      severity: 'soft',
      dayIndex,
      message: `当日安排 ${activities.length} 个活动，超过建议上限 ${FEASIBILITY_THRESHOLDS.softMaxActivities} 个，节奏偏赶`,
    });
  }
  if (walkingMeters > FEASIBILITY_THRESHOLDS.softWalkMeters) {
    violations.push({
      code: 'overpacked',
      severity: 'soft',
      dayIndex,
      message: `当日步行累计约 ${round1(walkingMeters / 1000)} km，超过 ${
        FEASIBILITY_THRESHOLDS.softWalkMeters / 1000
      } km，体力偏大`,
    });
  }
  if (bufferRatio !== null && bufferRatio < FEASIBILITY_THRESHOLDS.softBufferRatio) {
    violations.push({
      code: 'overpacked',
      severity: 'soft',
      dayIndex,
      message: `当日时间窗缓冲仅约 ${Math.round(bufferRatio * 100)}%，低于 ${Math.round(
        FEASIBILITY_THRESHOLDS.softBufferRatio * 100,
      )}%，几乎排满无弹性`,
    });
  }

  // backtrack 软：相邻三点方向反转 > 90° 且回跳 > 2km（三点均需坐标，缺坐标跳过）
  for (let i = 1; i + 1 < activities.length; i++) {
    const a = activities[i - 1]!;
    const b = activities[i]!;
    const c = activities[i + 1]!;
    if (!hasCoord(a) || !hasCoord(b) || !hasCoord(c)) continue;
    const vAB = localVector(a, b);   // a→b 方向
    const vBC = localVector(b, c);   // b→c 方向
    const magAB = Math.hypot(vAB.x, vAB.y);
    const magBC = Math.hypot(vBC.x, vBC.y);
    if (magAB === 0 || magBC === 0) continue;
    const cos = (vAB.x * vBC.x + vAB.y * vBC.y) / (magAB * magBC);
    const backJump = haversineMeters(b, c);
    if (cos < FEASIBILITY_THRESHOLDS.backtrackTurnCosMax && backJump > FEASIBILITY_THRESHOLDS.backtrackJumpMeters) {
      violations.push({
        code: 'backtrack',
        severity: 'soft',
        dayIndex,
        activityId: c.id,
        message: `「${a.name}」→「${b.name}」→「${c.name}」方向明显回折（回跳约 ${round1(
          backJump / 1000,
        )} km），顺路性差`,
      });
    }
  }

  // anchor_missing 软：住宿锚点已指定但坐标未解析（有活动才有意义）；无住宿的行程不报。
  // 仅在坐标解析已尝试后判定，避免 geoPipeline 前的 planner 门槛误报无从修复的噪声。
  const anchorAttempted = ctx.anchorResolutionAttempted ?? true;
  if (anchorAttempted && activities.length > 0 && ctx.lodging?.name && !hasCoord(ctx.lodging)) {
    violations.push({
      code: 'anchor_missing',
      severity: 'soft',
      dayIndex,
      message: `住宿锚点「${ctx.lodging.name}」未解析出坐标，无法计算住宿↔活动通勤（降级跳过，不影响其他判定）`,
    });
  }

  // closed_on_arrival 硬：活动携带营业时间原文且当天日期已知时，命中「该星期闭馆」即违规（09-22-opentime）。
  // 无 openTime / 无日期 → 跳过（拿不准不校验，绝不错误拦截）。
  if (ctx.date) {
    for (const activity of activities) {
      if (activity.openTime && isClosedOnDate(activity.openTime, ctx.date)) {
        violations.push({
          code: 'closed_on_arrival',
          severity: 'hard',
          dayIndex,
          activityId: activity.id,
          message: `「${activity.name}」安排在 ${ctx.date}，但其营业时间文本声明当天闭馆（${activity.openTime}）`,
        });
      }
    }
  }

  return {
    dayIndex,
    activityCount: activities.length,
    activityMinutes,
    transitMinutes,
    totalMinutes,
    walkingMeters: Math.round(walkingMeters),
    bufferRatio: bufferRatio === null ? null : round1(bufferRatio * 100) / 100,
    violations,
  };
}

// ---------- 全行程模拟 ----------

/** 逐日模拟整个行程；出行基调取 Trip.transportMode，住宿锚点 day 级覆盖优先 Trip 级 */
export function simulateTrip(trip: Trip): FeasibilityReport {
  const baseMode: LegMode = trip.transportMode ?? 'transit';
  // 坐标解析是否已发生：任一活动 geocoded 或任一天有 leg → geoPipeline 已跑，anchor_missing 才有意义
  const anchorResolutionAttempted = trip.days.some(
    (d) => d.activities.some((a) => a.coordSource === 'geocoded') || !!d.legs?.length,
  );
  const dayReports = trip.days.map((day) =>
    simulateDay(day, {
      dayIndex: day.dayIndex,
      baseMode,
      lodging: day.lodging ?? trip.lodging ?? null,
      anchorResolutionAttempted,
      date: dateForDayIndex(trip.startDate, day.dayIndex),
    }),
  );
  return { dayReports, violations: dayReports.flatMap((r) => r.violations) };
}

// ---------- 文本渲染（planner check_feasibility / reviewer 清单共用，纯函数） ----------

const CODE_LABEL: Record<ViolationCode, string> = {
  transit_infeasible: '通勤排不下',
  overpacked: '过载/节奏',
  backtrack: '路线回折',
  anchor_missing: '住宿锚点缺失',
  closed_on_arrival: '到达已闭馆',
};

/** 把违规报告渲染成紧凑中文清单：硬性问题在前、软性提示在后；无问题给明确结论 */
export function describeFeasibility(report: FeasibilityReport): string {
  const hard = report.violations.filter((v) => v.severity === 'hard');
  const soft = report.violations.filter((v) => v.severity === 'soft');
  if (!hard.length && !soft.length) return '可行性检查通过：未发现结构性时空冲突。';

  const line = (v: Violation) =>
    `- 第${v.dayIndex}天【${CODE_LABEL[v.code]}】${v.message}${v.detail ? `（${v.detail}）` : ''}`;
  const parts: string[] = [];
  if (hard.length) parts.push(`硬性问题（必须修正才能提交）：\n${hard.map(line).join('\n')}`);
  if (soft.length) parts.push(`可优化提示（不阻断提交）：\n${soft.map(line).join('\n')}`);
  return parts.join('\n\n');
}

/**
 * 降级为「审校遗留」提示（decision 2 守生成不失败）：修订轮用尽仍有 hard 时如实告知用户，任务不失败；
 * soft 违规也一并汇入最终 reviewNotes。纯函数：hard 在前、去重、限量，供 orchestrator 合并进 reviewNotes。
 */
export function feasibilityReviewNotes(report: FeasibilityReport, max = 4): string[] {
  const hard = report.violations.filter((v) => v.severity === 'hard');
  const soft = report.violations.filter((v) => v.severity === 'soft');
  const notes = [
    ...hard.map((v) => `可行性遗留：第${v.dayIndex}天${v.message}`),
    ...soft.map((v) => `建议优化：第${v.dayIndex}天${v.message}`),
  ];
  return [...new Set(notes)].slice(0, max);
}
