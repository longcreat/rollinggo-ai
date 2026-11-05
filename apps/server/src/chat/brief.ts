// Brief 变更逻辑：纯函数，不读库、不调 LLM —— 便于单测，也便于在路由层复用。
//
// 设计约束（PRD R2）：全是增量 patch 语义。模型没提到的字段一律不动，
// 「没提到」与「清空」是两件事；本期只支持删除单条约束，不支持清空字段。
//
// 输入是 LLM 的原始输出（unknown），不是类型化对象：模型可能给出越界、重复、空值或超长内容，
// 一律按「忽略/截断该字段」处理。对话理解是增强路径，不该因为模型胡说就丢掉整个会话。
import {
  CONSTRAINT_CATEGORIES,
  CONSTRAINT_POLARITIES,
  MAX_TRIP_CONSTRAINTS,
  MAX_TRIP_DAYS,
  PREFERENCE_OPTIONS,
  TRANSPORT_MODES,
  PACE_OPTIONS,
  requiredBriefFields,
  dateForDayIndex,
  uid,
  type BriefStatus,
  type PlanningBriefData,
  type TripConstraint,
  type Trip,
} from '@tripweaver/shared';
import { asRecord, readStringArray } from './models';

/** 各文本字段的长度上限，与 shared 的 schema 同源；模型给超长值时截断而不是丢弃 */
const TEXT_LIMITS = {
  destination: 40,
  startDate: 10,
  endDate: 10,
  lodging: 60,
  extraNotes: 200,
} as const;

const MAX_PARTY_SIZE = 20;
const MAX_PREFERENCES = 7;
const MAX_ADD_CONSTRAINTS = 5;

function oneOf<T extends readonly string[]>(values: T, value: unknown): T[number] | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T[number]) : undefined;
}

function readNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** 归一化从 DB 读到的 Brief 数据：旧行/历史产物可能缺 constraints 数组 */
export function normalizeBriefData(raw: unknown): PlanningBriefData {
  const data = asRecord(raw) as Partial<PlanningBriefData>;
  return { ...data, constraints: Array.isArray(data.constraints) ? data.constraints : [] };
}

/** collecting → ready：够不够生成由 shared 的 requiredBriefFields 说了算，不在这里重复规则 */
export function briefStatus(data: PlanningBriefData, current?: BriefStatus): BriefStatus {
  if (current === 'submitted' || current === 'discarded') return current;
  return requiredBriefFields(data).length === 0 ? 'ready' : 'collecting';
}

/** 修改/恢复后的日期以实际行程为准，避免旧 endDate 把新增天数覆盖回去。 */
export function syncBriefTripDates(data: PlanningBriefData, trip: Trip): PlanningBriefData {
  const next = { ...data, startDate: trip.startDate, days: Math.max(1, trip.days.length) };
  const endDate = dateForDayIndex(trip.startDate, next.days);
  if (endDate) next.endDate = endDate;
  else delete next.endDate;
  return next;
}

function constraintKey(category: string, valueText: string): string {
  return `${category}｜${valueText.trim().toLowerCase()}`;
}

function applyConstraints(
  current: TripConstraint[],
  raw: Record<string, unknown>,
  evidenceSequence: number,
): TripConstraint[] {
  const removed = new Set(readStringArray(raw, 'removeConstraintIds'));
  const kept = current.filter((c) => !removed.has(c.id));
  const seen = new Set(kept.map((c) => constraintKey(c.category, c.valueText)));

  const drafts = Array.isArray(raw.addConstraints) ? raw.addConstraints.slice(0, MAX_ADD_CONSTRAINTS) : [];
  for (const draft of drafts) {
    if (kept.length >= MAX_TRIP_CONSTRAINTS) break;
    const item = asRecord(draft);
    const category = oneOf(CONSTRAINT_CATEGORIES, item.category);
    const polarity = oneOf(CONSTRAINT_POLARITIES, item.polarity);
    const valueText = typeof item.valueText === 'string' ? item.valueText.trim() : '';
    if (!category || !polarity || !valueText) continue;
    const key = constraintKey(category, valueText);
    if (seen.has(key)) continue;   // 同一约束重复抽取：保留原 id，便于前端稳定 diff
    seen.add(key);
    kept.push({ id: uid(), category, valueText: valueText.slice(0, 500), polarity, evidenceSequence });
  }
  return kept;
}

/** 把模型输出落到 Brief 上。未提到的字段保持原值。 */
export function applyDialogueDecision(
  current: PlanningBriefData,
  raw: unknown,
  evidenceSequence: number,
): PlanningBriefData {
  const input = asRecord(raw);
  // 只读问答即使夹带合法字段或约束，也不能改变下一次生成使用的条件。
  if (input.intent === 'travel_qa') return { ...current, constraints: [...current.constraints] };
  const next: PlanningBriefData = {
    ...current,
    constraints: applyConstraints(current.constraints, input, evidenceSequence),
  };

  for (const key of ['destination', 'startDate', 'endDate', 'lodging', 'extraNotes'] as const) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // 显式空备注表示取消全部自由文本要求；字段缺省仍保持原值。
    if (trimmed || key === 'extraNotes') next[key] = trimmed.slice(0, TEXT_LIMITS[key]);
  }

  const pace = oneOf(PACE_OPTIONS, input.pace);
  if (pace) next.pace = pace;

  const transportMode = oneOf(TRANSPORT_MODES, input.transportMode);
  if (transportMode) next.transportMode = transportMode;

  const days = readNumber(input, 'days');
  if (days !== undefined && days >= 1) next.days = Math.min(MAX_TRIP_DAYS, days);

  const partySize = readNumber(input, 'partySize');
  if (partySize !== undefined && partySize >= 1) next.partySize = Math.min(MAX_PARTY_SIZE, partySize);

  if (Array.isArray(input.preferences)) {
    const preferences = input.preferences
      .map((p) => oneOf(PREFERENCE_OPTIONS, p))
      .filter((p): p is (typeof PREFERENCE_OPTIONS)[number] => Boolean(p));
    next.preferences = [...new Set(preferences)].slice(0, MAX_PREFERENCES);
  }

  // 明确起止日期永远压过天数：先说了「3 天」后来又给了具体日期时，不能让过期的 days 反压回去
  if (next.startDate && next.endDate) delete next.days;

  return next;
}
