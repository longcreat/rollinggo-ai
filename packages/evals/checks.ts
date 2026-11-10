// 确定性检查（M0-B eval）：输入 Trip + GenerateForm，输出结构化 CaseResult
// 纯函数、无 IO —— 与可行性引擎同一铁律，离线快照重放与在线生成后检查共用同一份。
// 当前门槛：可行性违规 / 结构完整性 / 地理质量；预算字段仅兼容旧数据，不参与评估。
// 快照 v2 观测指标（不进 gate）：研究质量（候选池采用率）/ 阶段耗时与 token 用量
// geo 门槛动机（2026-07-16 空心通过事故）：AMAP_KEY 缺失 + Nominatim 不可达 ⇒ 全活动 0,0/estimated、
// 0 leg，可行性模拟对着空气跑出 0 违规仍 PASS —— 坐标可信度不达标必须整体判 FAIL，不得静默放行。
import { Value } from '@sinclair/typebox/value';
import {
  FEASIBILITY_THRESHOLDS,
  TripSchema,
  simulateTrip,
  type GenerateForm,
  type ResearchPoi,
  type Trip,
  type Violation,
} from '@tripweaver/shared';
import { PLAN_POLICY, measurePlan, planViolations, type PlanMetrics, type PlanViolation } from '@tripweaver/agent/generation/planner/validator';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface GeoQuality {
  activityCount: number;
  locatedRatio: number;      // 有效坐标覆盖率：(lat,lng) ≠ (0,0) 活动占全部活动比
  geocodedRatio: number;     // coordSource === 'geocoded' 占比（有坐标活动中）
  estimatedRatio: number;    // coordSource === 'estimated' 占比（有坐标活动中）：模型猜测，未经核实
  providerLegRatio: number;   // leg source ≠ 'heuristic' 占比（真实路由：amap）；无 leg 时为 0
  legCount: number;
  expectedLegPairs: number;  // 相邻活动对总数（每日 max(0, n-1) 之和；不含住宿 leg）
  outlierActivities: string[];   // 距活动坐标中位中心 > 100km 的活动名（疑似幻觉/geocode 错城）
}

export interface CaseResult {
  caseId: string;
  pass: boolean;                       // 门槛判定：hard violation = 0 且结构问题 = 0 且 geo 门槛 = 0
  hardViolations: Violation[];
  softViolations: Violation[];
  hardByCode: Record<string, number>;
  softByCode: Record<string, number>;
  structural: string[];                // 结构问题清单（空 = 通过）
  geoGate: string[];                   // 地理可信度门槛问题清单（空 = 通过）
  geo: GeoQuality;
  /** 方案质量观测（11-06）：稀薄/跨区/重复坐标；planner 成为默认后再提升为 gate。 */
  plan: { metrics: PlanMetrics; violations: PlanViolation[] };
  research?: ResearchQuality;          // 快照 v2：研究质量（观测指标，不进 gate）
  timing?: SnapshotTiming;             // 快照 v2：阶段耗时与 token 用量（观测指标）
}

function countByCode(violations: Violation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of violations) out[v.code] = (out[v.code] ?? 0) + 1;
  return out;
}

// ---------- 结构完整性 ----------

function checkStructural(trip: Trip, form: GenerateForm): string[] {
  const problems: string[] = [];
  if (!Value.Check(TripSchema, trip)) {
    const first = Value.Errors(TripSchema, trip).First();
    problems.push(`TripSchema 校验失败：${first ? `${first.path} ${first.message}` : '未知错误'}`);
  }
  if (trip.days.length !== form.days) {
    problems.push(`天数不匹配：表单 ${form.days} 天，产出 ${trip.days.length} 天`);
  }
  for (const day of trip.days) {
    const d = `第 ${day.dayIndex} 天`;
    if (day.activities.length === 0) problems.push(`${d}为空天`);
    // 密度只数景点：餐次 / 住宿 / 交通是排程项，不构成「一天过载」（与 draft.validate / plan_day 同口径）。
    const sights = day.activities.filter((a) => a.category !== '美食' && a.category !== '住宿' && a.category !== '交通').length;
    if (sights > FEASIBILITY_THRESHOLDS.softMaxActivities) {
      problems.push(`${d}景点数 ${sights} 超上限 ${FEASIBILITY_THRESHOLDS.softMaxActivities}`);
    }
    for (const a of day.activities) {
      for (const t of [a.startTime, a.endTime]) {
        if (t !== '' && !TIME_RE.test(t)) problems.push(`${d}「${a.name}」时间格式非法：${t}`);
      }
      if (TIME_RE.test(a.startTime) && TIME_RE.test(a.endTime) && a.startTime >= a.endTime) {
        problems.push(`${d}「${a.name}」结束时间不晚于开始时间（${a.startTime}–${a.endTime}）`);
      }
    }
  }
  return problems;
}

// ---------- 地理质量 ----------

const DEG = Math.PI / 180;
const EARTH_R = 6371000;
const OUTLIER_METERS = 100_000;

function haversine(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (bLat - aLat) * DEG;
  const dLng = (bLng - aLng) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function checkGeo(trip: Trip): GeoQuality {
  const acts = trip.days.flatMap((d) => d.activities);
  const located = acts.filter((a) => a.lat !== 0 || a.lng !== 0);
  const legs = trip.days.flatMap((d) => d.legs ?? []);
  // 离群判定：与坐标中位中心的距离 > 100km（同城行程不该出现；中位数抗单点离群）
  const outliers: string[] = [];
  if (located.length >= 3) {
    const cLat = median(located.map((a) => a.lat));
    const cLng = median(located.map((a) => a.lng));
    for (const a of located) {
      if (haversine(a.lat, a.lng, cLat, cLng) > OUTLIER_METERS) outliers.push(a.name);
    }
  }
  return {
    activityCount: acts.length,
    locatedRatio: acts.length ? located.length / acts.length : 0,
    geocodedRatio: located.length ? located.filter((a) => a.coordSource === 'geocoded').length / located.length : 0,
    estimatedRatio: located.length ? located.filter((a) => a.coordSource === 'estimated').length / located.length : 0,
    providerLegRatio: legs.length ? legs.filter((l) => l.source !== 'heuristic').length / legs.length : 0,
    legCount: legs.length,
    expectedLegPairs: trip.days.reduce((n, d) => n + Math.max(0, d.activities.length - 1), 0),
    outlierActivities: outliers,
  };
}

// ---------- 地理可信度门槛 ----------
// 只锚定坐标可信度，不锚定 leg 存在性：geoPipeline 对有坐标活动必产 leg（route 失败也降级出启发式段），
// leg 缺失只是坐标缺失的影子；而手工金集样例（manual 坐标、无 leg）靠 simulate 的 haversine 兜底，属合法形态。

export const EVAL_GEO_THRESHOLDS = {
  minLocatedRatio: 0.8,     // 有效坐标覆盖率下限
  maxEstimatedRatio: 0.4,   // 估算坐标（模型猜测）占比上限
} as const;

function checkGeoGate(geo: GeoQuality): string[] {
  const problems: string[] = [];
  if (geo.activityCount > 0 && geo.locatedRatio < EVAL_GEO_THRESHOLDS.minLocatedRatio) {
    problems.push(
      `有效坐标覆盖率 ${(geo.locatedRatio * 100).toFixed(0)}% 低于门槛 ${EVAL_GEO_THRESHOLDS.minLocatedRatio * 100}%（geocode 链路疑似未生效）`,
    );
  }
  if (geo.locatedRatio > 0 && geo.estimatedRatio > EVAL_GEO_THRESHOLDS.maxEstimatedRatio) {
    problems.push(
      `估算坐标占比 ${(geo.estimatedRatio * 100).toFixed(0)}% 超上限 ${EVAL_GEO_THRESHOLDS.maxEstimatedRatio * 100}%（坐标未经地理编码核实）`,
    );
  }
  return problems;
}

// ---------- 研究质量（快照 v2，观测指标不进 gate） ----------
// 候选 POI 无坐标（高德协议 3.5：只落名称+摘要+链接），池级地理真实性不可查；
// 被采用候选的坐标质量已由 checkGeo 在 Trip 层覆盖。此处度量「编排阶段有没有在用调研成果」。

export interface ResearchQuality {
  poolSize: number;
  categoryCounts: Record<string, number>;   // attraction / food / hotel
  activityCount: number;
  adoptedCount: number;                     // 名称命中候选池的活动数（含餐次提取名）
  adoptionRatio: number;                    // 采用率：过低 = 编排脱离调研成果自编地点
  unmatchedActivities: string[];            // 未命中活动名采样（≤10），人肉审查幻觉用
}

export interface SnapshotTiming {
  phases: Record<string, number>;           // '<phase>#<round>' → durationMs
  totalMs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

// 餐次展示名提取定位名：「午餐｜春熙路 · 川菜」→「春熙路」（与 geoPipeline 的 legacy meal extraction 同规则）
function lookupName(name: string): string {
  const bar = name.indexOf('｜');
  if (bar < 0) return name;
  const rest = name.slice(bar + 1);
  const dot = rest.indexOf(' · ');
  return (dot < 0 ? rest : rest.slice(0, dot)).trim();
}

function checkResearch(trip: Trip, candidates: ResearchPoi[]): ResearchQuality {
  const poolNames = new Set(candidates.map((c) => c.name));
  const categoryCounts: Record<string, number> = {};
  for (const c of candidates) categoryCounts[c.category] = (categoryCounts[c.category] ?? 0) + 1;
  const activities = trip.days.flatMap((d) => d.activities);
  const unmatched: string[] = [];
  let adopted = 0;
  for (const a of activities) {
    if (poolNames.has(a.name) || poolNames.has(lookupName(a.name))) adopted += 1;
    else unmatched.push(a.name);
  }
  return {
    poolSize: candidates.length,
    categoryCounts,
    activityCount: activities.length,
    adoptedCount: adopted,
    adoptionRatio: activities.length ? adopted / activities.length : 0,
    unmatchedActivities: unmatched.slice(0, 10),
  };
}

// ---------- 汇总入口 ----------

export function runChecks(
  caseId: string,
  trip: Trip,
  form: GenerateForm,
  extras?: { candidates?: ResearchPoi[]; timing?: SnapshotTiming },
): CaseResult {
  const report = simulateTrip(trip);
  const hard = report.violations.filter((v) => v.severity === 'hard');
  const soft = report.violations.filter((v) => v.severity === 'soft');
  const structural = checkStructural(trip, form);
  const geo = checkGeo(trip);
  const geoGate = checkGeoGate(geo);
  const metrics = measurePlan(trip);
  const policy = PLAN_POLICY[(form.pace ?? 'moderate') as keyof typeof PLAN_POLICY] ?? PLAN_POLICY.moderate;
  return {
    caseId,
    pass: hard.length === 0 && structural.length === 0 && geoGate.length === 0,
    hardViolations: hard,
    softViolations: soft,
    hardByCode: countByCode(hard),
    softByCode: countByCode(soft),
    structural,
    geoGate,
    geo,
    plan: { metrics, violations: planViolations(metrics, policy, trip.days.length) },
    research: extras?.candidates ? checkResearch(trip, extras.candidates) : undefined,
    timing: extras?.timing,
  };
}
