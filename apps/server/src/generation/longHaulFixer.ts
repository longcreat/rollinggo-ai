// 确定性修复器（远郊编排层3 兜底）：feasibility 报出 hard 违规且命中「远郊日混排」模式时，
// 由代码把混排的市区活动挪到别的天并重验证 —— 不再指望规划/审校 LLM 自觉遵守长途点情报。
// 位置：orchestrator 每轮 geoPipeline+feasibility 之后、审校 Agent 之前（修订轮同样生效）。
//
// 模式识别（保守，只处理明确模式；用已编排活动的真实坐标，不依赖层2 的名字关联旁路）：
// - 长途点 = 距全行程活动坐标中位中心估算单程通勤 ≥ LONG_HAUL_THRESHOLDS.exclusiveMin（强独占级）；
// - 混排市区活动 = 与最近长途点估算通勤 > NEAR_STOPOVER_MAX_MIN（非景区近邻/顺路）
//   且比到长途点更靠近中位中心（明显属于市区簇）；
// - 只动「当天同时存在长途点 + 混排市区活动 + qualifying hard 违规」的天。
//
// 保守铁律：只挪不删；每步挪动验证不过即回滚；整日 hard 无严格递减即整日回滚（D3 防死循环）——
// 绝不「修出更烂的行程」。任何意外异常回滚到入场状态并按「未修复」返回（生成不失败原则）。
import {
  FEASIBILITY_THRESHOLDS,
  LONG_HAUL_THRESHOLDS,
  effectiveLegMode,
  estimateTransit,
  haversineMeters,
  type Activity,
  type DayReport,
  type FeasibilityReport,
  type LegMode,
} from '@tripweaver/shared';
import { MIN_LOCATED_POIS, medianCenter } from './longHaul';
import type { DraftTrip } from './draft';

/** 草稿天形状（DraftTrip.mutableDays 的元素）：修复器与单测共用 */
export type DraftDay = ReturnType<DraftTrip['mutableDays']>[number];

/** 景区近邻判定：与长途点估算通勤 ≤45 分钟视为同景区/回程顺路点，保留在远郊日 */
export const NEAR_STOPOVER_MAX_MIN = 45;
/** 时间槽晚间边界：被挪活动的结束时间不得晚于 23:00，压线则顺延下一候选天 */
export const EVENING_LIMIT_MIN = 23 * 60;
/** 时间槽取整粒度：起始时间向后取整到 :00/:30 */
const SLOT_ROUND_MIN = 30;
/** 防死循环上限（D3）：单个远郊日最多挪出 3 个活动 */
export const MAX_MOVES_PER_DAY = 3;
/** 防死循环上限（D3）：单次生成内「挪动+验证」尝试总数 ≤8（含被回滚的尝试） */
export const MAX_TOTAL_ATTEMPTS = 8;

export interface LongHaulFixContext {
  /** 行程出行方式基调（长途/近邻判定与时间槽估算共用同一速度模型） */
  mode: LegMode;
  /** 受影响天的通勤段重算（dayIndexes 从 1 开始）：生产侧注入 geoPipeline.computeLegs 定向重算
   *  （自带 AMAP→启发式降级与额度控制）；单测注入纯启发式实现 */
  recomputeLegs: (dayIndexes: readonly number[]) => Promise<void>;
  /** 进度通道（复用 thought 事件），缺省静默 */
  onProgress?: (text: string) => void;
  /** 任务取消信号：中止时回滚全部改动并上抛，终态由调用方收敛 */
  signal?: AbortSignal;
}

/** 已采纳的单次挪动记录：note 为用户可见说明；activityId/toDayIndex 供落库前校验注记仍为真（verifiedFixNotes） */
export interface AppliedFixMove {
  activityId: string;
  toDayIndex: number;
  /** 自动调整说明（人话）：经 verifiedFixNotes 校验后并入 trip.meta.reviewNotes 持久化，用户可见——可信透明要求 */
  note: string;
}

export interface LongHaulFixResult {
  /** 采纳的挪动记录；修订轮可能推翻挪动，落库前须经 verifiedFixNotes 过滤后再并入 reviewNotes */
  applied: AppliedFixMove[];
}

interface Coord {
  lat: number;
  lng: number;
}

/** 有效坐标：非 (0,0) 原点占位（与可行性引擎同判据） */
function hasCoord(p: { lat?: number; lng?: number } | undefined | null): p is Coord {
  return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && (p.lat !== 0 || p.lng !== 0);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:mm" → 距零点分钟；非法/空回 null（与可行性引擎同判据） */
function toMinutes(hhmm: string): number | null {
  if (!TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

function toHHmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** 触发条件：qualifying hard（transit_infeasible / overpacked 硬违规）所在天集合。无 hard 不动 */
function qualifyingHardDays(report: FeasibilityReport): Set<number> {
  const days = new Set<number>();
  for (const v of report.violations) {
    if (v.severity === 'hard' && (v.code === 'transit_infeasible' || v.code === 'overpacked')) days.add(v.dayIndex);
  }
  return days;
}

/** 全行程 hard 违规总数（回滚判据用；hard 码只有 transit_infeasible/overpacked 两种） */
function countHard(report: FeasibilityReport): number {
  return report.violations.filter((v) => v.severity === 'hard').length;
}

/** 各天 hard 违规计数（「不引入新 hard 天」判据用） */
function hardCountByDay(report: FeasibilityReport): Map<number, number> {
  const byDay = new Map<number, number>();
  for (const v of report.violations) {
    if (v.severity === 'hard') byDay.set(v.dayIndex, (byDay.get(v.dayIndex) ?? 0) + 1);
  }
  return byDay;
}

/** 单步采纳判别式：总 hard 不增加，且不引入新 hard 天（原本干净的天必须保持干净）。
 *  单步只要求「不恶化」——首步清零 hard 后仍继续把剩余混排市区活动挪出（独占日纪律）；
 *  整日是否采纳由外层「hard 严格递减否则整日回滚」判据把关。 */
function acceptMove(before: Map<number, number>, after: Map<number, number>): boolean {
  const total = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  if (total(after) > total(before)) return false;
  for (const [dayIndex, n] of after) {
    if (n > 0 && !(before.get(dayIndex) ?? 0)) return false;
  }
  return true;
}

/** 整体恢复到快照：mutableDays 返回活体数组引用，原地替换内容即回滚（活动与 legs 一并还原）。
 *  恢复时再克隆一次，保证快照可重复使用不被后续修改污染 */
function restoreDays(days: DraftDay[], snapshot: DraftDay[]): void {
  days.splice(0, days.length, ...structuredClone(snapshot));
}

// ---------- 模式识别（纯函数，导出供单测） ----------

export interface MixedDayScan {
  dayIndex: number;
  /** 强独占级长途点：距全行程中位中心估算单程 ≥ exclusiveMin 的活动 */
  longHaulActivities: Activity[];
  /** 混排市区活动（挪出候选）：非长途点近邻、且明显属于市区簇 */
  urbanCandidates: Activity[];
}

/** 扫描单天是否为「远郊日混排」：无长途点返回 null；无坐标活动一律不判定（保守不动）。 */
export function scanMixedDay(day: DraftDay, dayIndex: number, center: Coord, mode: LegMode): MixedDayScan | null {
  const located = day.activities.filter((a) => hasCoord(a));
  const longHaulActivities = located.filter(
    (a) => estimateTransit(a, center, mode).durationMin >= LONG_HAUL_THRESHOLDS.exclusiveMin,
  );
  if (!longHaulActivities.length) return null;
  const urbanCandidates = located.filter((a) => {
    if (longHaulActivities.includes(a)) return false;
    const nearestLh = Math.min(...longHaulActivities.map((p) => estimateTransit(a, p, mode).durationMin));
    if (nearestLh <= NEAR_STOPOVER_MAX_MIN) return false; // 景区近邻/顺路：保留
    return estimateTransit(a, center, mode).durationMin < nearestLh; // 比到长途点更靠近中位中心 → 市区簇
  });
  return { dayIndex, longHaulActivities, urbanCandidates };
}

// ---------- 目标天选择与时间槽（纯函数，导出供单测） ----------

/** 目标天候选：其余天按「日总时长（活动+通勤）」升序（负载最轻优先，同负载天号小者优先）。
 *  排除：含强独占级长途点的天（挪过去等于再造混排）、活动数已达上限的天（结构门槛 ≤8） */
export function rankTargetDays(
  days: readonly DraftDay[],
  dayReports: readonly DayReport[],
  sourceDayIndex: number,
  center: Coord,
  mode: LegMode,
): number[] {
  const loadOf = new Map(dayReports.map((r) => [r.dayIndex, r.totalMinutes]));
  return days
    .map((day, i) => ({ day, dayIndex: i + 1 }))
    .filter(({ day, dayIndex }) => {
      if (dayIndex === sourceDayIndex) return false;
      if (day.activities.length >= FEASIBILITY_THRESHOLDS.softMaxActivities) return false;
      return !day.activities.some(
        (a) => hasCoord(a) && estimateTransit(a, center, mode).durationMin >= LONG_HAUL_THRESHOLDS.exclusiveMin,
      );
    })
    .sort((a, b) => (loadOf.get(a.dayIndex) ?? 0) - (loadOf.get(b.dayIndex) ?? 0) || a.dayIndex - b.dayIndex)
    .map(({ dayIndex }) => dayIndex);
}

/** 被挪活动在目标天末尾的可推演时间槽：
 *  目标天最晚有效结束时间 + 与末位活动的估算通勤，向后取整到 :00/:30，保持原活动时长；
 *  结束压过晚间边界（23:00）→ 返回 null（该天放不下，调用方顺延下一候选天）；
 *  时长/基准/坐标任一不可推演 → 置空时间（结构校验允许空时间，可行性引擎对无时间活动跳过 gap 判定，
 *  其通勤仍计入日总时长受 overpacked 门槛约束）——不臆造时间。 */
export function computeMoveSlot(
  targetDay: DraftDay,
  activity: Activity,
  mode: LegMode,
): { startTime: string; endTime: string } | null {
  const s = toMinutes(activity.startTime);
  const e = toMinutes(activity.endTime);
  const durationMin = s !== null && e !== null && e > s ? e - s : null;
  // 基准 = 目标天各活动最晚有效结束时间（末位活动缺时间时取全天最大值，更保守）
  let baseEnd: number | null = null;
  for (const a of targetDay.activities) {
    const t = toMinutes(a.endTime);
    if (t !== null && (baseEnd === null || t > baseEnd)) baseEnd = t;
  }
  const prev = targetDay.activities[targetDay.activities.length - 1];
  if (durationMin === null || baseEnd === null || !prev || !hasCoord(prev) || !hasCoord(activity)) {
    return { startTime: '', endTime: '' };
  }
  // 通勤估算镜像 geoPipeline 的模式选择（<1.5km 走路），保证时间槽 gap ≥ 重算后的 leg 时长
  const legMode: LegMode = effectiveLegMode(prev, activity, mode);
  const transitMin = estimateTransit(prev, activity, legMode).durationMin;
  const start = Math.ceil((baseEnd + transitMin) / SLOT_ROUND_MIN) * SLOT_ROUND_MIN;
  const end = start + durationMin;
  if (end > EVENING_LIMIT_MIN) return null;
  return { startTime: toHHmm(start), endTime: toHHmm(end) };
}

// ---------- 主入口 ----------

/**
 * 落库前的注记校验（可信透明的真话契约）：只保留「活动此刻确实在注记声称的目标天」的挪动说明。
 * 修订轮规划/审校可能推翻修复器的挪动（live beijing 实证：轮1 挪出、轮2 规划师重排放回原天，
 * 跨轮累计的注记对最终行程即为假话）——失真的「系统自动调整」比缺失更糟，宁可少报被推翻的动作。
 * 活动被删除或重建换 id 视同被推翻（id 是挪动时的稳定标识）。
 */
export function verifiedFixNotes(draft: DraftTrip, applied: readonly AppliedFixMove[]): string[] {
  const days = draft.mutableDays();
  return applied
    .filter((m) => days[m.toDayIndex - 1]?.activities.some((a) => a.id === m.activityId))
    .map((m) => m.note);
}

/**
 * 修复「远郊日混排」：逐日原子处理（多远郊日按同一规则依次来，D3 不做专门优化）。
 * 每次挪动后定向重算受影响两天的 legs 并全量重跑 feasibility；单步不恶化才保留，
 * 整日 hard 严格递减才采纳（否则整日回滚）。采纳的动作以人话写入 applied[].note（落库前
 * 经 verifiedFixNotes 校验仍为真才并入 reviewNotes）。
 */
export async function repairLongHaulMixedDays(draft: DraftTrip, ctx: LongHaulFixContext): Promise<LongHaulFixResult> {
  const days = draft.mutableDays();
  const entrySnapshot = structuredClone(days);
  const result: LongHaulFixResult = { applied: [] };
  try {
    let report = draft.feasibility();
    if (!qualifyingHardDays(report).size) return result; // 无 hard 不动

    const located = days.flatMap((d) => d.activities).filter((a) => hasCoord(a));
    if (located.length < MIN_LOCATED_POIS) return result; // 点太少中位中心失真，保守不动（同层2 下限）
    const center = medianCenter(located);
    if (!center) return result;

    // 入场检测目标日：混排模式 + qualifying hard 落在该天
    const targetDayIndexes: number[] = [];
    days.forEach((day, i) => {
      const scan = scanMixedDay(day, i + 1, center, ctx.mode);
      if (scan?.urbanCandidates.length && qualifyingHardDays(report).has(i + 1)) targetDayIndexes.push(i + 1);
    });

    let attempts = 0;
    for (const sourceDayIndex of targetDayIndexes) {
      if (attempts >= MAX_TOTAL_ATTEMPTS) break;
      // 前一日的修复可能已改变全局：动手前重扫该日，模式与 hard 任一不再成立即跳过
      report = draft.feasibility();
      const sourceDay = days[sourceDayIndex - 1];
      if (!sourceDay || !qualifyingHardDays(report).has(sourceDayIndex)) continue;
      const scan = scanMixedDay(sourceDay, sourceDayIndex, center, ctx.mode);
      if (!scan?.urbanCandidates.length) continue;

      const daySnapshot = structuredClone(days);
      const appliedBefore = result.applied.length;
      const hardBefore = countHard(report);
      ctx.onProgress?.(`检测到第 ${sourceDayIndex} 天远郊行程与市区活动混排，正在自动调整…`);

      // 单个混排活动的安置：目标天按负载升序逐个试；每次尝试 = 挪动 + 定向重算 legs + 全量重验，
      // 不达标立即回滚本次挪动。全部候选天都放不下则返回 null（该活动留在原天）。
      const tryPlace = async (candidate: Activity): Promise<AppliedFixMove | null> => {
        const current = draft.feasibility();
        const perDayBefore = hardCountByDay(current);
        const lhLabel = scan.longHaulActivities.reduce((best, p) =>
          estimateTransit(candidate, p, ctx.mode).durationMin < estimateTransit(candidate, best, ctx.mode).durationMin
            ? p
            : best,
        ).name;
        for (const targetDayIndex of rankTargetDays(days, current.dayReports, sourceDayIndex, center, ctx.mode)) {
          if (attempts >= MAX_TOTAL_ATTEMPTS) return null;
          if (ctx.signal?.aborted) throw new Error('已取消');
          const targetDay = days[targetDayIndex - 1];
          if (!targetDay) continue;
          // 防别名串写：上一候选天试探失败回滚后，scan 持有的 candidate 引用已脱离草稿，且其
          // startTime/endTime 残留上次试探写入的槽位时间——时间槽推演一律按 id 取当前草稿的活体对象
          const live = days[sourceDayIndex - 1]?.activities.find((a) => a.id === candidate.id);
          if (!live) return null; // 防御：候选已不在源天（理论不可达）
          const slot = computeMoveSlot(targetDay, live, ctx.mode);
          if (!slot) continue; // 时间槽压过晚间边界：顺延下一候选天
          attempts += 1;
          const moveSnapshot = structuredClone(days);
          if (!draft.moveActivityToDay(sourceDayIndex, live.id, targetDayIndex)) return null; // 防御：理论不可达
          live.startTime = slot.startTime;   // moveActivityToDay 按引用移动，live 即目标天末位活动
          live.endTime = slot.endTime;
          await ctx.recomputeLegs([sourceDayIndex, targetDayIndex]);
          if (acceptMove(perDayBefore, hardCountByDay(draft.feasibility()))) {
            return {
              activityId: live.id,
              toDayIndex: targetDayIndex,
              note: `系统自动调整：「${candidate.name}」自第 ${sourceDayIndex} 天移至第 ${targetDayIndex} 天，以解决「${lhLabel}」的远郊通勤冲突`,
            };
          }
          restoreDays(days, moveSnapshot); // 验证不过：回滚本次挪动，试下一候选天
        }
        return null;
      };

      let movedThisDay = 0;
      for (const candidate of scan.urbanCandidates) {
        if (movedThisDay >= MAX_MOVES_PER_DAY || attempts >= MAX_TOTAL_ATTEMPTS) break;
        const move = await tryPlace(candidate);
        if (move) {
          movedThisDay += 1;
          result.applied.push(move);
          ctx.onProgress?.(move.note);
        }
        // 放不下的活动留在原天继续试下一候选；整日是否值得保留由下方严格递减判据裁决
      }

      // 整日判据（D3 防死循环核心）：hard 未严格递减 → 本日修复完整回滚（含已试探采纳的挪动）
      if (countHard(draft.feasibility()) >= hardBefore) {
        restoreDays(days, daySnapshot);
        result.applied.length = appliedBefore;
      }
    }
    return result;
  } catch (err) {
    // 失败防御：任何意外异常回滚全部改动，按「未修复」继续走审校（生成不失败）；取消原样上抛
    restoreDays(days, entrySnapshot);
    if (ctx.signal?.aborted) throw err;
    ctx.onProgress?.('自动调整未生效，将交由审校处理');
    return { applied: [] };
  }
}
