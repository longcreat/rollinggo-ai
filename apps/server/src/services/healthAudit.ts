// 行程体检 Pass 1a（纯确定性审计）：feasibility 全量规则 + 远郊混排 → 结构化 Finding。
// 本模块零依赖（只 import shared 纯函数）——单测不需要 DB 与环境变量。
import { uid, type Trip, type HealthFinding } from '@tripweaver/shared';
import { simulateTrip, suggestionFromViolation, estimateTransit, effectiveLegMode } from '@tripweaver/shared';

// ---------- 远郊混排检测（体检场景版） ----------
// 生成链路的 classifyLongHaulPois 走 ResearchPoi 池；这里直接用行程活动坐标：
// 长途点 = 距当日活动中位中心估算单程 ≥ exclusiveMin(90min)；混排 = 同天还有距长途点 > 30min 且更靠中心的市区点。

const LONG_HAUL_EXCLUSIVE_MIN = 90;   // 与 LONG_HAUL_THRESHOLDS.exclusiveMin 一致
const NEAR_STOPOVER_MAX_MIN = 30;     // 与 longHaulFixer 的 NEAR_STOPOVER_MAX_MIN 对齐

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid! - 1]! + sorted[mid]!) / 2;
}

function hasCoord(a: { lat: number; lng: number }): boolean {
  return Number.isFinite(a.lat) && Number.isFinite(a.lng) && (a.lat !== 0 || a.lng !== 0);
}

/** 单天视角的远郊混排：返回「应挪走的市区活动 id + 建议目标天」，未命中返回 null */
function detectLongHaulMixed(trip: Trip, dayIndex: number): { mixedActivityId: string; summary: string } | null {
  const day = trip.days.find((d) => d.dayIndex === dayIndex);
  if (!day || day.activities.length < 2) return null;
  const located = day.activities.filter(hasCoord);
  if (located.length < 2) return null;

  const center = { lat: median(located.map((a) => a.lat)), lng: median(located.map((a) => a.lng)) };
  const mode = trip.transportMode ?? 'transit';

  const farFromCenter = (a: (typeof located)[number]) =>
    estimateTransit(a, center, effectiveLegMode(a, center, mode)).durationMin;

  const longHauls = located.filter((a) => farFromCenter(a) >= LONG_HAUL_EXCLUSIVE_MIN);
  if (longHauls.length === 0) return null;

  // 混排市区点：比到长途点更靠近中心，且距最近长途点 > NEAR_STOPOVER_MAX_MIN
  const urban = located.filter((a) => {
    if (longHauls.some((l) => l.id === a.id)) return false;
    const toNearestLongHaul = Math.min(...longHauls.map((l) =>
      estimateTransit(a, l, effectiveLegMode(a, l, mode)).durationMin));
    return toNearestLongHaul > NEAR_STOPOVER_MAX_MIN;
  });
  if (urban.length === 0) return null;

  // 建议目标：全行程活动数最少的其他天
  const others = trip.days.filter((d) => d.dayIndex !== dayIndex);
  if (!others.length) return null;
  const target = [...others].sort((a, b) =>
    a.activities.length - b.activities.length || a.dayIndex - b.dayIndex)[0]!;
  const victim = urban.sort((a, b) => farFromCenter(b) - farFromCenter(a))[0]!;
  return {
    mixedActivityId: victim.id,
    summary: `第 ${dayIndex} 天混入远郊点（${longHauls.map((l) => l.name).join('、')}），把市区的「${victim.name}」挪到第 ${target.dayIndex} 天`,
  };
}

// ---------- Pass 1a：审计 ----------

export interface AuditResult {
  findings: HealthFinding[];
}



/** 全量审计：feasibility（5 类）+ 远郊混排。同 code 同活动去重，hard 在前。 */
export function auditTrip(trip: Trip): AuditResult {
  const report = simulateTrip(trip);
  const findings: HealthFinding[] = [];
  const seen = new Set<string>();

  const push = (finding: HealthFinding) => {
    const key = `${finding.code}|${finding.dayIndex}|${finding.activityId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (const violation of report.violations) {
    const suggestion = suggestionFromViolation(violation, trip);
    push({
      id: uid(),
      code: violation.code,
      severity: violation.severity,
      dayIndex: violation.dayIndex,
      ...(violation.activityId ? { activityId: violation.activityId } : {}),
      message: violation.message.slice(0, 300),
      ...(violation.detail ? { detail: violation.detail.slice(0, 200) } : {}),
      suggestion: suggestion
        ? {
          kind: suggestion.kind,
          ...(suggestion.toDayIndex ? { toDayIndex: suggestion.toDayIndex } : {}),
          ...(suggestion.activityId ? { activityId: suggestion.activityId } : {}),
          summary: suggestion.summary.slice(0, 200),
        }
        : { kind: 'none', summary: violation.severity === 'hard' ? '需要人工判断处理' : '可优化提示，不影响出行' },
    });
  }

  // 远郊混排：独立于 feasibility（它不检这个）；只在有 hard 违规的天上补报
  const hardDays = new Set(report.violations.filter((v) => v.severity === 'hard').map((v) => v.dayIndex));
  for (const dayIndex of hardDays) {
    const mixed = detectLongHaulMixed(trip, dayIndex);
    if (!mixed) continue;
    const others = trip.days.filter((d) => d.dayIndex !== dayIndex);
    const target = [...others].sort((a, b) => a.activities.length - b.activities.length || a.dayIndex - b.dayIndex)[0]!;
    const suggestion = suggestionFromViolation({ code: 'overpacked', severity: 'hard', dayIndex, message: mixed.summary } as never, trip);
    push({
      id: uid(),
      code: 'longhaul_mixed',
      severity: 'hard',
      dayIndex,
      activityId: mixed.mixedActivityId,
      message: mixed.summary.slice(0, 300),
      suggestion: suggestion
        ? { ...suggestion, kind: 'move_activity', activityId: mixed.mixedActivityId, toDayIndex: target.dayIndex, summary: mixed.summary.slice(0, 200) }
        : { kind: 'move_activity', activityId: mixed.mixedActivityId, ...(target ? { toDayIndex: target.dayIndex } : {}), summary: mixed.summary.slice(0, 200) },
    });
  }

  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'hard' ? -1 : 1));
  return { findings };
}

