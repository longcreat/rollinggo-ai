// 行程体检（行前精细化）契约：Finding（发现）→ 决策卡 → Decision（处置）→ 重排。
//
// 设计参考出发鸭 Preparing（docs/GODUCK_INTERACTION_RESEARCH.md §四），但规则面收敛在
// feasibility.ts 已有的 5 类违规 + 远郊混排，不新造规则。Pass 1 是纯确定性（零 LLM），
// Pass 2 重排同样确定性：每个 accept 动作执行后重验可行性，hard 不递减即回滚该步。
import { Type, type Static } from '@sinclair/typebox';
import type { Violation } from './feasibility';
import { StringEnum } from './typebox';

// ---------- Finding：体检产出的一条结构化发现 ----------

/** 决策卡动作（照出发鸭四动作，comment 作为可选补充字段） */
export const HEALTH_ACTIONS = ['accept', 'self_handle', 'skip', 'accept_all'] as const;
export type HealthAction = (typeof HEALTH_ACTIONS)[number];

/** 建议的类型：决定 Pass 2 执行哪种确定性操作（Pass 1a 只产 move/delete，其余占位类型不保留） */
export const HEALTH_SUGGESTION_KINDS = ['move_activity', 'delete_activity', 'none'] as const;
export type HealthSuggestionKind = (typeof HEALTH_SUGGESTION_KINDS)[number];

export const HealthFindingSchema = Type.Object({
  id: Type.String(),
  /** 来源违规（feasibility Violation 或远郊混排），保留 code/severity 供前端分级 */
  code: Type.String(),
  severity: StringEnum(['hard', 'soft'] as const),
  dayIndex: Type.Integer({ minimum: 1 }),
  activityId: Type.Optional(Type.String()),
  /** 面向人的说明（复用 Violation.message） */
  message: Type.String({ maxLength: 300 }),
  /** 低置信标注（直线估算等） */
  detail: Type.Optional(Type.String({ maxLength: 200 })),
  /** 确定性建议：kind + 参数。none = 只提示不给动作（软性违规） */
  suggestion: Type.Object({
    kind: StringEnum(HEALTH_SUGGESTION_KINDS),
    /** move_activity: 目标天 dayIndex；delete_activity: 被删活动 id */
    toDayIndex: Type.Optional(Type.Integer({ minimum: 1 })),
    activityId: Type.Optional(Type.String()),
    /** 建议的一句话说明（卡片上「建议：」后的话） */
    summary: Type.String({ maxLength: 200 }),
  }),
  /** 实时核验补充（verify 接口回填）：预约渠道/最新营业时间等，标注核验时间 */
  verification: Type.Optional(Type.Object({
    text: Type.String({ maxLength: 400 }),
    checkedAt: Type.Integer(),
  })),
});

export type HealthFinding = Static<typeof HealthFindingSchema>;

// ---------- 决策 ----------

export const HealthDecisionSchema = Type.Object({
  findingId: Type.String(),
  action: StringEnum(HEALTH_ACTIONS),
  comment: Type.Optional(Type.String({ maxLength: 200 })),
});

export type HealthDecision = Static<typeof HealthDecisionSchema>;

// ---------- 体检会话 ----------

export const HEALTH_CHECK_STATUSES = ['pending', 'completed', 'expired'] as const;
export type HealthCheckStatus = (typeof HEALTH_CHECK_STATUSES)[number];

/** POST /api/trips/:id/health-check 的返回 */
export const HealthCheckViewSchema = Type.Object({
  id: Type.String(),
  tripId: Type.String(),
  tripVersion: Type.Integer({ minimum: 1 }),
  status: StringEnum(HEALTH_CHECK_STATUSES),
  findings: Type.Array(HealthFindingSchema),
  createdAt: Type.Integer(),
  resolvedAt: Type.Optional(Type.Integer()),
  /** 处置完成后：新版本号与修改摘要 */
  result: Type.Optional(Type.Object({
    version: Type.Integer({ minimum: 1 }),
    tripId: Type.String(),
    applied: Type.Array(Type.String({ maxLength: 200 })),
    skipped: Type.Integer({ minimum: 0 }),
  })),
});

export type HealthCheckView = Static<typeof HealthCheckViewSchema>;

/** 处置提交的 body */
export const HealthDecisionsRequestSchema = Type.Object({
  decisions: Type.Array(HealthDecisionSchema, { minItems: 1, maxItems: 30 }),
  /** 乐观锁：与创建体检时的版本一致才执行 */
  updatedAt: Type.Integer(),
});

export type HealthDecisionsRequest = Static<typeof HealthDecisionsRequestSchema>;

// ---------- 工具：违规 → 建议 ----------

/**
 * 从 feasibility Violation 提炼确定性建议（纯函数，服务端 healthCheckService 用）。
 * 返回 undefined = 该违规只提示不给动作。
 */
export interface HealthSuggestion {
  kind: HealthSuggestionKind;
  toDayIndex?: number;
  activityId?: string;
  summary: string;
}

/**
 * 软性违规（backtrack/软 overpacked）与 anchor_missing 不给确定性动作：
 * 挪动建议需要「挪后必更好」的验证，软性提示给动作反而容易误导。
 */
export function suggestionFromViolation(
  violation: Violation,
  trip: { days: { dayIndex: number; activities: { id: string; name: string }[] }[] },
): HealthSuggestion | undefined {
  const { code, severity, dayIndex, activityId } = violation;
  const day = trip.days.find((d) => d.dayIndex === dayIndex);
  if (!day) return undefined;

  if (code === 'transit_infeasible' && severity === 'hard' && activityId) {
    const target = day.activities.find((a) => a.id === activityId);
    const index = day.activities.findIndex((a) => a.id === activityId);
    // 建议：删掉「排不下的后一活动」——保留前面活动不动，用户也可选自己处理
    if (target && index > 0) {
      return {
        kind: 'delete_activity',
        activityId,
        summary: `删除「${target.name}」${day.activities.length > 2 ? '（其余安排保留）' : ''}`,
      };
    }
    return undefined;
  }

  if (code === 'closed_on_arrival' && severity === 'hard' && activityId) {
    const target = day.activities.find((a) => a.id === activityId);
    if (!target) return undefined;
    return {
      kind: 'delete_activity',
      activityId,
      summary: `删除闭馆日安排的「${target.name}」（可之后改约开放日）`,
    };
  }

  if (code === 'overpacked' && severity === 'hard') {
    // 找当天最末一个非首活动，建议挪到最空闲天
    const last = [...day.activities].reverse().find((a) => a.id !== day.activities[0]?.id);
    if (!last) return undefined;
    // 最空闲天：活动数最少且非当天的天（体检场景天数 ≥2 才有得挪）
    const others = trip.days.filter((d) => d.dayIndex !== dayIndex);
    if (!others.length) return undefined;
    const target = [...others].sort((a, b) =>
      a.activities.length - b.activities.length || a.dayIndex - b.dayIndex)[0]!;
    return {
      kind: 'move_activity',
      activityId: last.id,
      toDayIndex: target.dayIndex,
      summary: `把「${last.name}」挪到第 ${target.dayIndex} 天（当前 ${target.activities.length} 个安排，最空闲）`,
    };
  }

  return undefined;
}

/** 远郊混排（longHaul 检测的补充违规）的建议：挪市区活动到最空闲天 */
export function suggestionForLongHaulMixed(
  violation: Violation,
  trip: { days: { dayIndex: number; activities: { id: string; name: string }[] }[] },
  mixedActivityId: string,
  targetDayIndex: number,
): HealthSuggestion {
  const target = trip.days.flatMap((d) => d.activities).find((a) => a.id === mixedActivityId);
  return {
    kind: 'move_activity',
    activityId: mixedActivityId,
    toDayIndex: targetDayIndex,
    summary: `把市区的「${target?.name ?? '活动'}」挪到第 ${targetDayIndex} 天，让远郊日集中`,
  };
}
