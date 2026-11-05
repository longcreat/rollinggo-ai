// 规划 Brief 契约（09-23）：对话消息 / Planning Brief。追问控件（intake）已在 10-17 下线 ——
// 首页“地图选城 + 胶囊”一次收完参数，不再有服务端追问的轮次，
// 但 Brief 本身仍是生成输入与行程内对话上下文的载体。
//
// 设计边界：对话永远不直接生成行程；Brief 是「已确认的事实快照」，生成只在快照上跑。
import { Type, type Static } from '@sinclair/typebox';
import {
  BRIEF_MISSING_FIELDS,
  BRIEF_STATUSES,
  CHAT_INTENTS,
  CHAT_MESSAGE_ROLES,
  CONSTRAINT_CATEGORIES,
  CONSTRAINT_CATEGORY_LABELS,
  CONSTRAINT_POLARITIES,
  CONVERSATION_STATUSES,
  MAX_TRIP_CONSTRAINTS,
  MAX_TRIP_DAYS,
  PACE_OPTIONS,
  PREFERENCE_OPTIONS,
  TRANSPORT_MODES,
} from './constants';
import { StringEnum } from './typebox';
import { EditOpOutcomeSchema } from './editOps';
import { ChatAttachmentSchema } from './detailChat';
import type { BriefMissingField, GenerateForm, PlanningBriefData, TripConstraint } from './types';

// ---------- 约束模型 ----------

export const TripConstraintSchema = Type.Object({
  id: Type.String(),
  category: StringEnum(CONSTRAINT_CATEGORIES),
  valueText: Type.String({ minLength: 1, maxLength: 500 }),
  polarity: StringEnum(CONSTRAINT_POLARITIES),
  evidenceSequence: Type.Optional(Type.Integer({ minimum: 0 })),   // 来源消息序号，供「为什么这么安排」追溯
});

/**
 * 新增约束的输入形状（id / evidenceSequence 由服务端生成）。
 * 确认卡编辑与 LLM 抽取共用同一形状，于是两者能走同一个归一函数。
 */
export const TripConstraintDraftSchema = Type.Object({
  category: StringEnum(CONSTRAINT_CATEGORIES),
  valueText: Type.String({ minLength: 1, maxLength: 200 }),
  polarity: StringEnum(CONSTRAINT_POLARITIES),
});

// ---------- Planning Brief ----------
// data 里全部字段可选：缺省 = 尚未收集，由 requiredBriefFields 判定是否够生成。
// constraints 是「本次行程的约束」，不是跨行程的长期记忆（后者不在本期范围）。

export const PlanningBriefDataSchema = Type.Object({
  destination: Type.Optional(Type.String({ maxLength: 40 })),
  startDate: Type.Optional(Type.String({ maxLength: 10 })),        // "2026-11-05"
  endDate: Type.Optional(Type.String({ maxLength: 10 })),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TRIP_DAYS })),
  pace: Type.Optional(StringEnum(PACE_OPTIONS)),
  partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  transportMode: Type.Optional(StringEnum(TRANSPORT_MODES)),
  lodging: Type.Optional(Type.String({ maxLength: 60 })),
  extraNotes: Type.Optional(Type.String({ maxLength: 200 })),
  // 与 GenerateForm.preferences 1:1 映射（枚举同源），避免从约束猜测偏好
  preferences: Type.Optional(Type.Array(StringEnum(PREFERENCE_OPTIONS), { maxItems: 7 })),
  constraints: Type.Array(TripConstraintSchema, { maxItems: MAX_TRIP_CONSTRAINTS }),
});

// 注：原 `BriefInputSchemaSchema` / `BriefIntakeSchema`（追问控件的下发契约）已在 10-17
// 随「对话式收集 Brief」一起删除。历史消息可能仍带 intake 数据（DB 列保留），
// 不再有 schema 校验或渲染。

export const PlanningBriefViewSchema = Type.Object({
  status: StringEnum(BRIEF_STATUSES),
  data: PlanningBriefDataSchema,
  missingFields: Type.Array(StringEnum(BRIEF_MISSING_FIELDS), { maxItems: 5 }),
  updatedAt: Type.Number(),
});

// ---------- 会话与消息 ----------

export const ChatMessageSchema = Type.Object({
  id: Type.String(),
  conversationId: Type.String(),
  role: StringEnum(CHAT_MESSAGE_ROLES),
  content: Type.String({ maxLength: 4000 }),
  sequence: Type.Integer({ minimum: 0 }),
  relatedTripId: Type.Optional(Type.String()),
  attachment: Type.Optional(ChatAttachmentSchema),
  createdAt: Type.Number(),
});

export const ConversationSchema = Type.Object({
  id: Type.String(),
  title: Type.String({ maxLength: 60 }),
  status: StringEnum(CONVERSATION_STATUSES),
  brief: PlanningBriefViewSchema,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});

/** 会话关联行程的版本引用（用于修订目标与版本切换） */
export const ConversationTripRefSchema = Type.Object({
  id: Type.String(),
  title: Type.String({ maxLength: 60 }),
  version: Type.Integer({ minimum: 1 }),
});

export const ConversationDetailSchema = Type.Object({
  conversation: ConversationSchema,
  messages: Type.Array(ChatMessageSchema),
  /** 本会话最近一次成功生成的行程；有它才能发起「对话内修订」（PR5） */
  latestTrip: Type.Optional(ConversationTripRefSchema),
});

// ---------- 请求 / 响应 ----------

// 注：原 `SendMessageSchema`（POST /:id/messages 的 body）随该路由下线一并删除，
// 对话入口现在只有行程内的 DetailChatRequestSchema。
export const SendMessageResultSchema = Type.Object({
  userMessage: ChatMessageSchema,
  replyMessage: ChatMessageSchema,
  brief: PlanningBriefViewSchema,
  intent: StringEnum(CHAT_INTENTS),
  /** R3（09-24）：LLM 判信息齐备即自动触发生成，携带新任务 id；缺省 = 未触发（额度尽/有任务在跑/未齐备） */
  autoStartedJobId: Type.Optional(Type.String()),
  /** R1（09-24）：按需修订结果。LLM 判定修改意图即直接执行，落版本链下一版 */
  editResult: Type.Optional(
    Type.Object({
      tripId: Type.String(),
      version: Type.Integer({ minimum: 1 }),
      outcomes: Type.Array(EditOpOutcomeSchema, { maxItems: 10 }),
    }),
  ),
});

const StreamEnvelope = { requestId: Type.String(), sequence: Type.Integer({ minimum: 1 }) };
export const ChatStreamEventSchema = Type.Union([
  Type.Object({ ...StreamEnvelope, type: Type.Literal('accepted') }),
  Type.Object({ ...StreamEnvelope, type: Type.Literal('progress'), text: Type.String() }),
  Type.Object({ ...StreamEnvelope, type: Type.Literal('answer_delta'), text: Type.String() }),
  Type.Object({ ...StreamEnvelope, type: Type.Literal('recommendations'), attachment: ChatAttachmentSchema }),
  Type.Object({ ...StreamEnvelope, type: Type.Literal('edit_result'), result: Type.Object({ tripId: Type.String(), version: Type.Integer({ minimum: 1 }), outcomes: Type.Array(EditOpOutcomeSchema, { maxItems: 10 }) }) }),
  Type.Object({ ...StreamEnvelope, type: Type.Literal('done'), result: SendMessageResultSchema }),
  Type.Object({ ...StreamEnvelope, type: Type.Literal('error'), error: Type.String(), code: Type.String() }),
]);
export type ChatStreamEvent = Static<typeof ChatStreamEventSchema>;

/**
 * Brief 增量补丁：undefined = 该字段不动（与「清空」区分开，清空不在本期范围）。
 * addConstraints 只给内容，id / 来源消息序号由服务端补；removeConstraintIds 支持删除单条约束。
 */
export const PlanningBriefPatchSchema = Type.Object({
  destination: Type.Optional(Type.String({ maxLength: 40 })),
  startDate: Type.Optional(Type.String({ maxLength: 10 })),
  endDate: Type.Optional(Type.String({ maxLength: 10 })),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TRIP_DAYS })),
  pace: Type.Optional(StringEnum(PACE_OPTIONS)),
  partySize: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  transportMode: Type.Optional(StringEnum(TRANSPORT_MODES)),
  lodging: Type.Optional(Type.String({ maxLength: 60 })),
  extraNotes: Type.Optional(Type.String({ maxLength: 200 })),
  preferences: Type.Optional(Type.Array(StringEnum(PREFERENCE_OPTIONS), { maxItems: 7 })),
  addConstraints: Type.Optional(Type.Array(TripConstraintDraftSchema, { maxItems: 30 })),
  removeConstraintIds: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
});

export const ConversationCreateSchema = Type.Object({
  title: Type.Optional(Type.String({ maxLength: 60 })),
});

// ---------- 纯函数：就绪判定与追问构造 ----------
// 服务端（拦截生成）与前端（「开始生成」按钮可用性）共用同一规则，避免两处判定漂移。

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string | undefined): boolean {
  if (!value || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * 返回缺失/非法的必填项，顺序即追问顺序。
 * 必填只有 4 项：目的地 / 开始日期 / 结束日期（或天数）/ 旅行节奏；其余字段缺省也能生成。
 */
export function requiredBriefFields(data: PlanningBriefData): BriefMissingField[] {
  const missing: BriefMissingField[] = [];
  if (!data.destination?.trim()) missing.push('destination');

  const start = data.startDate?.trim();
  const end = data.endDate?.trim();
  const hasStart = isValidIsoDate(start);
  const hasEnd = isValidIsoDate(end);
  if (!hasStart) missing.push('startDate');
  // days 是 endDate 的合法等价表达，二者有其一即算填过
  const hasDays = typeof data.days === 'number' && data.days >= 1;
  if (!hasEnd && !hasDays) missing.push('endDate');
  if (hasStart && hasEnd && end! < start!) missing.push('dateRange');

  if (!data.pace) missing.push('pace');
  return missing;
}

/** Brief 是否已齐备（可展示确认卡并允许「开始生成」） */
export function isBriefReady(data: PlanningBriefData): boolean {
  return requiredBriefFields(data).length === 0;
}

/** 只缺一项时的追问控件；无法枚举的字段只能给文本框 */
// 注：singleFieldIntake / briefIntake / briefIntakeWithOptions 已随 intake 链路一起删除（10-17）。
// requiredBriefFields 保留 —— 首页判断「能不能开始生成」仍靠它。

// ---------- 纯函数：Brief → 生成表单 ----------
// 确认卡「开始生成」的唯一映射，前后端共用（前端构造请求体，服务端不再重复推导）。

const MAX_EXTRA_NOTES = 200;   // 与 GenerateFormSchema.extraNotes.maxLength 同源

/** 约束渲染成一句人话 —— GenerateForm 没有结构化的约束通道，只认 extraNotes 文本 */
function renderConstraint(constraint: TripConstraint): string {
  const label = CONSTRAINT_CATEGORY_LABELS[constraint.category];
  const prefix =
    constraint.polarity === 'avoid'
      ? '避开'
      : constraint.polarity === 'require'
        ? '必须满足'
        : constraint.polarity === 'prefer'
          ? '优先'
          : '';   // fact：仅背景，不加前缀
  return `${prefix}${constraint.valueText}（${label}）`;
}

/**
 * 约束排在自由文本之前：它们携带个性化需求，是这趟行程真正区别于模板的部分，
 * 超出上限时优先保住它们。截断留「…」，宁可不完整也要让调用方看出不完整。
 */
function renderExtraNotes(data: PlanningBriefData, appendNotes?: string): string {
  const parts = [
    ...(appendNotes?.trim() ? [appendNotes.trim()] : []),
    ...data.constraints.map(renderConstraint),
    ...(data.extraNotes?.trim() ? [data.extraNotes.trim()] : []),
  ];
  const kept: string[] = [];
  let length = 0;
  // 预留 1 字给截断标记
  for (const part of parts) {
    const next = kept.length === 0 ? part.length : length + part.length + 1;
    if (next > MAX_EXTRA_NOTES - 1) break;
    kept.push(part);
    length = next;
  }
  const body = kept.join('；');
  return kept.length < parts.length ? `${body}…` : body;
}

function daysFromDates(startDate: string | undefined, endDate: string | undefined): number | null {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) return null;
  const ms = Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return Math.min(MAX_TRIP_DAYS, Math.max(1, Math.round(ms / 86_400_000) + 1));
}

/**
 * Brief → GenerateForm。
 * 预算字段仍是共享契约里的兼容字段，新界面不让用户决策，固定给默认值。
 * days 优先级：显式 days > startDate/endDate 推导 > 1。
 * appendNotes：修订意见（PR5）——排在所有约束之前，因为它是本次唯一的改动指令。
 */
export function briefToGenerateForm(
  data: PlanningBriefData,
  options: { appendNotes?: string } = {},
): GenerateForm {
  const days = data.days ?? daysFromDates(data.startDate, data.endDate) ?? 1;
  const lodging = data.lodging?.trim();
  return {
    destination: data.destination?.trim() ?? '',
    days,
    startDate: data.startDate ?? '',
    budgetLevel: '舒适',
    totalBudget: 0,
    preferences: data.preferences ?? [],
    partySize: data.partySize ?? 2,
    extraNotes: renderExtraNotes(data, options.appendNotes),
    transportMode: data.transportMode ?? 'transit',
    ...(data.pace ? { pace: data.pace } : {}),
    ...(lodging ? { lodging } : {}),
  };
}
