// 一轮 Agent 的跨工具状态：工具只写这里，turn 在回答结束后统一组装附件、Brief 与生成请求。
// 参考 openclaw 的 turn state 与 dsh 的 session 事件：工具副作用不直接落库，回合边界统一提交。
import type { FoodCandidate, PlanningBriefPatch } from '@tripweaver/shared';

export interface AgentQuestionRecord {
  question: string;
  options: string[];
  selected: string[];
  custom?: string;
}

/** excludedFoodKeys 的 FIFO 上限：约等于单日对话上限 × 每轮 3 张卡片，足够去重又保住候选池。 */
const EXCLUDED_FOOD_KEYS_MAX = 60;

/**
 * 有界排除集（FIFO）：excludedFoodKeys 会从历史消息累积（createAgentTurnState 的初始入参）并跨回合增长，
 * 不设上限时最终会把美食检索池排空（所有已知餐厅都被排除，永远返回 0 候选）。
 * 取舍：超限淘汰最早的 key —— 旧餐厅允许再次被推荐，好过候选池耗尽。
 */
class BoundedKeySet extends Set<string> {
  constructor(initial: Iterable<string> = []) {
    super();
    for (const value of initial) this.add(value);
  }

  override add(value: string): this {
    super.add(value);
    while (this.size > EXCLUDED_FOOD_KEYS_MAX) {
      const oldest = this.values().next().value;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return this;
  }
}

export interface AgentTurnState {
  /** 本回合 search_food 产出的可添加餐厅（UI 卡片） */
  foodCandidates: FoodCandidate[];
  /** 本回合美食检索的提示（无结果、饮食要求等） */
  foodNotes: string[];
  /** 已展示/已添加过的餐厅，避免重复推荐 */
  excludedFoodKeys: Set<string>;
  /** 本回合 HITL 问答记录（持久化到消息附件，刷新后仍可回看） */
  questions: AgentQuestionRecord[];
  /** 用户未在时限内回答（工具已结束本轮） */
  questionExpired?: boolean;
  /** 主 Agent 通过 update_brief 提交的 Brief 增量 */
  briefPatch?: Record<string, unknown>;
  /** generate_trip 委派的后台生成任务 id */
  startedGenerationJobId?: string;
}

export function createAgentTurnState(excludedFoodKeys: Iterable<string> = []): AgentTurnState {
  return {
    foodCandidates: [],
    foodNotes: [],
    excludedFoodKeys: new BoundedKeySet(excludedFoodKeys),
    questions: [],
  };
}

/**
 * 把一次 update_brief 的参数合并进本回合已累积的 Brief 增量（而不是覆盖）：
 * 一轮里模型可能多次调用（先改日期、再补约束），标量字段仅当本次有定义才覆盖；
 * addConstraints / removeConstraintIds 数组拼接去重 —— 约束按「类目+口径+文本」去重，
 * 与 brief.ts applyConstraints 的去重口径一致；删除 id 用 Set 去重。
 */
export function mergeBriefPatch(
  current: Record<string, unknown> | undefined,
  patch: PlanningBriefPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === 'addConstraints' || key === 'removeConstraintIds') {
      const merged = [...(Array.isArray(next[key]) ? next[key] as unknown[] : []), ...(value as unknown[])];
      next[key] = key === 'removeConstraintIds'
        ? [...new Set(merged)]
        : merged.filter((item, index) =>
          merged.findIndex((other) => constraintDraftKey(other) === constraintDraftKey(item)) === index);
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** 约束草稿的去重键：同键视为同一约束（不同 polarity 仍算不同约束）。 */
function constraintDraftKey(item: unknown): string {
  if (typeof item !== 'object' || item === null) return JSON.stringify(item);
  const record = item as Record<string, unknown>;
  return [record.category, record.polarity, typeof record.valueText === 'string' ? record.valueText.trim() : ''].join('｜');
}
