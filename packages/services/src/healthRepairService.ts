// 体检 Pass 2：确定性执行用户 accept 的建议。纪律照 longHaulFixer——
// 每步执行后重验可行性，hard 违规数不严格递减即回滚该步；任何异常整批回滚。
// 不用 LLM：建议里的 dayIndex/activityId 来自 Pass 1a 的精确定位，执行是纯数据操作。
import { simulateTrip, type HealthDecision, type HealthFinding, type Trip } from '@tripweaver/shared';
import { scheduleDays } from './itinerary/schedule';

export interface HealthRepairOutcome {
  trip: Trip;
  /** 成功执行的建议摘要（给 result.applied 与 changeSummary） */
  applied: string[];
  /** 未执行（skip / self_handle / 执行失败回滚）的数量 */
  skipped: number;
}

function hardCount(trip: Trip): number {
  return simulateTrip(trip).violations.filter((v) => v.severity === 'hard').length;
}

function cloneTrip(trip: Trip): Trip {
  return {
    ...trip,
    days: trip.days.map((day) => ({
      ...day,
      activities: day.activities.map((a) => ({ ...a })),
      legs: (day.legs ?? []).map((l) => ({ ...l })),
    })),
  };
}

/** 执行单个建议（对 draft 原地修改）：返回受影响天的 dayIndex（未应用返回 null） */
function applySuggestion(draft: Trip, finding: HealthFinding): number[] | null {
  const { kind, activityId, toDayIndex } = finding.suggestion;
  if (kind === 'none') return null;

  const sourceDay = draft.days.find((d) => d.dayIndex === finding.dayIndex);
  if (!sourceDay) return null;
  const index = sourceDay.activities.findIndex((a) => a.id === activityId);
  if (index < 0) return null;

  if (kind === 'delete_activity') {
    const [removed] = sourceDay.activities.splice(index, 1);
    // 清掉关联的 leg（端点已不存在的）
    sourceDay.legs = (sourceDay.legs ?? []).filter((l) => l.fromActivityId !== activityId && l.toActivityId !== activityId);
    return removed ? [sourceDay.dayIndex] : null;
  }

  if (kind === 'move_activity' && toDayIndex) {
    const targetDay = draft.days.find((d) => d.dayIndex === toDayIndex);
    if (!targetDay) return null;
    const [moved] = sourceDay.activities.splice(index, 1);
    if (!moved) return null;
    // 时间戳清空：挪到别的天后原时刻大概率不再成立，交给 scheduleDays 按真实通勤重排
    moved.startTime = '';
    moved.endTime = '';
    targetDay.activities.push(moved);
    sourceDay.legs = (sourceDay.legs ?? []).filter((l) => l.fromActivityId !== activityId && l.toActivityId !== activityId);
    return [sourceDay.dayIndex, targetDay.dayIndex];
  }

  return null;
}

/**
 * 消费全部决策：accept 的逐条执行，每步验证 hard 严格递减否则回滚该步。
 * self_handle/skip/comment 不动行程。返回 null = 没有任何有效 accept（无需新版本）。
 */
export async function applyHealthDecisions(
  trip: Trip,
  findings: HealthFinding[],
  decisions: HealthDecision[],
  signal: AbortSignal,
): Promise<HealthRepairOutcome | null> {
  signal.throwIfAborted();
  const byId = new Map(findings.map((f) => [f.id, f]));
  const accepts = decisions.filter((d) => d.action === 'accept' || d.action === 'accept_all');
  if (!accepts.length) return null;

  const draft = cloneTrip(trip);
  const baseline = hardCount(draft);
  const applied: string[] = [];
  let current = baseline;
  let skipped = decisions.length - accepts.length;

  for (const decision of accepts) {
    signal.throwIfAborted();
    const finding = byId.get(decision.findingId);
    if (!finding) { skipped += 1; continue; }

    // 快照用于回滚单步
    const before = cloneTrip(draft);
    const affectedDays = applySuggestion(draft, finding);
    if (!affectedDays) { skipped += 1; continue; }

    // 挪动/删除后当天时刻已失效（被挪活动无时刻）：按真实通勤与餐窗重排受影响天，
    // 再验可行性 —— 保证落库的新版本没有无时刻的裸活动。体检场景没有用户节奏，统一 moderate。
    scheduleDays(
      draft.days.filter((day) => affectedDays.includes(day.dayIndex)),
      'moderate',
    );

    // 跳过空天防护：删空一天会让 dayIndex 断档（days 数组还在但活动空）——保留空天由前端展示处理
    const after = hardCount(draft);
    if (after < current) {
      current = after;
      applied.push(finding.suggestion.summary);
    } else {
      // 回滚该步：hard 未减少（或增加）
      restore(draft, before);
      skipped += 1;
    }
  }

  if (!applied.length) return null;
  signal.throwIfAborted();
  return { trip: draft, applied, skipped };
}

/** 原地还原（draft 引用不变，内容换回 before） */
function restore(target: Trip, before: Trip): void {
  Object.assign(target, cloneTrip(before));
}
