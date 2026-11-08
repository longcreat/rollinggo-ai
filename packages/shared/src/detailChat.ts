import { Type, type Static } from '@sinclair/typebox';
import { StringEnum } from './typebox';
import { EditOpOutcomeSchema } from './editOps';
import { SourceNoteSchema, TripSchema } from './schemas';

export const CHAT_SUGGESTIONS = ['food', 'explore', 'pace', 'more_food', 'light_food', 'dinner'] as const;
export const CHAT_SUGGESTION_KINDS = [...CHAT_SUGGESTIONS, 'follow_up'] as const;
export const MEAL_KINDS = ['lunch', 'dinner', 'snack'] as const;
export const MealPositionSchema = Type.Object({
  dayId: Type.String({ minLength: 1, maxLength: 100 }),
  beforeActivityId: Type.Optional(Type.String({ maxLength: 100 })),
  meal: StringEnum(MEAL_KINDS),
});
export type MealPosition = Static<typeof MealPositionSchema>;
export const FoodCandidateSchema = Type.Object({
  id: Type.String(), poiKey: Type.String(), tripId: Type.String(),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  address: Type.String({ maxLength: 300 }),
  lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }),
  reason: Type.String({ maxLength: 500 }),
  dayId: Type.String(), dayIndex: Type.Integer({ minimum: 1 }), nearby: Type.String(),
  sources: Type.Array(SourceNoteSchema, { minItems: 1, maxItems: 5 }),
  cuisine: Type.Optional(Type.String({ maxLength: 100 })),
  openTime: Type.Optional(Type.String({ maxLength: 60 })),
  meal: Type.Optional(StringEnum(MEAL_KINDS)),
  position: Type.Optional(MealPositionSchema),
});
export type FoodCandidate = Static<typeof FoodCandidateSchema>;
// Human-in-the-Loop 问题契约（参考 dsh / opencode / openclaw 的 ask_user）：
// Agent 在工具执行中暂停，前端展示问题卡，用户通过独立接口回答后同一回合继续。
export const AgentQuestionOptionSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 200 })),
});
export const AgentQuestionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  question: Type.String({ minLength: 1, maxLength: 300 }),
  header: Type.Optional(Type.String({ maxLength: 60 })),
  options: Type.Array(AgentQuestionOptionSchema, { maxItems: 6 }),
  multiSelect: Type.Optional(Type.Boolean()),
});
export const AgentQuestionAnswerSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  selected: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 6 }),
  custom: Type.Optional(Type.String({ maxLength: 300 })),
});
export const AgentQuestionAnswersRequestSchema = Type.Object({
  answers: Type.Array(AgentQuestionAnswerSchema, { minItems: 1, maxItems: 6 }),
});
export const PendingQuestionViewSchema = Type.Object({
  id: Type.String(),
  requestId: Type.String(),
  questions: Type.Array(AgentQuestionSchema, { minItems: 1, maxItems: 3 }),
  createdAt: Type.Integer(),
  expiresAt: Type.Integer(),
});
export type AgentQuestionOption = Static<typeof AgentQuestionOptionSchema>;
export type AgentQuestion = Static<typeof AgentQuestionSchema>;
export type AgentQuestionAnswer = Static<typeof AgentQuestionAnswerSchema>;
export type AgentQuestionAnswersRequest = Static<typeof AgentQuestionAnswersRequestSchema>;
export type PendingQuestionView = Static<typeof PendingQuestionViewSchema>;

// Agent 处理过程的结构化步骤（只含工具动作，不含参数/结果/思维链）。
export const AGENT_STEP_STATUSES = ['running', 'done', 'error', 'stopped'] as const;
export const AgentStepSchema = Type.Object({
  /** 工具调用 id；SSE 内按它 upsert */
  id: Type.String({ minLength: 1, maxLength: 100 }),
  /** 稳定工具名，前端用于分组 */
  name: Type.String({ minLength: 1, maxLength: 60 }),
  /** 用户向标签，服务端 TOOL_LABEL 单一来源 */
  label: Type.String({ minLength: 1, maxLength: 40 }),
  status: StringEnum(AGENT_STEP_STATUSES),
  startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
  durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000 })),
}, { additionalProperties: false });
export type AgentStep = Static<typeof AgentStepSchema>;

// 一轮回答的有序片段：思考段、正文段、工具段与 HITL 问答按真实事件顺序排列（对齐 pi transcript / Qoder 的已处理块）。
export const AgentPartSchema = Type.Union([
  /** 真实思考段：只留时间线位置与耗时，不存原始 CoT。 */
  Type.Object({
    type: Type.Literal('thinking'),
    startedAt: Type.Integer({ minimum: 0 }),
    endedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
    chunks: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  }),
  Type.Object({ type: Type.Literal('text'), text: Type.String({ maxLength: 4000 }) }),
  Type.Object({ type: Type.Literal('steps'), steps: Type.Array(AgentStepSchema, { maxItems: 24 }) }),
  /** 指向 `ChatAttachment.questions[index]`：问答记录出现在被问到的位置，而不是统一挪到回答末尾。 */
  Type.Object({ type: Type.Literal('question'), index: Type.Integer({ minimum: 0 }) }),
]);
export type AgentPart = Static<typeof AgentPartSchema>;

export const ChatAttachmentSchema = Type.Object({
  tripId: Type.String(), dayId: Type.Optional(Type.String()),
  notice: Type.Optional(Type.String({ maxLength: 500 })),
  summary: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 }),
  /** 结构化处理过程；旧消息没有时前端用 summary 回退 */
  steps: Type.Optional(Type.Array(AgentStepSchema, { maxItems: 24 })),
  /** 正文与工具块的真实顺序；旧消息没有时前端回退到「过程在上、正文在下」 */
  parts: Type.Optional(Type.Array(AgentPartSchema, { maxItems: 40 })),
  elapsedMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
  references: Type.Optional(Type.Array(SourceNoteSchema, { maxItems: 8 })),
  candidates: Type.Array(FoodCandidateSchema, { maxItems: 3 }),
  /** 本轮 HITL 问答记录，刷新后仍可回看（Agent 工具内提问，不是文末选项）。 */
  questions: Type.Optional(Type.Array(Type.Object({
    question: Type.String({ maxLength: 300 }),
    options: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 6 }),
    selected: Type.Array(Type.String({ maxLength: 100 }), { maxItems: 6 }),
    custom: Type.Optional(Type.String({ maxLength: 300 })),
  }), { maxItems: 3 })),
  clarification: Type.Optional(Type.Object({
    question: Type.String({ minLength: 1, maxLength: 300 }),
    options: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 2, maxItems: 3 }),
  })),
  /**
   * 本轮改动摘要（11-05 P2）：持久化在消息上，刷新后仍能看到「改了什么」，
   * previousTripId 供「撤销这次修改」回到上一版。
   */
  edit: Type.Optional(Type.Object({
    version: Type.Integer({ minimum: 1 }),
    previousTripId: Type.Optional(Type.String()),
    outcomes: Type.Array(EditOpOutcomeSchema, { minItems: 1, maxItems: 10 }),
  })),
  /** 本轮委派的后台生成任务：消息里持久化 jobId，刷新后任务卡仍能读真实状态。 */
  task: Type.Optional(Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 100 }) })),
  /** 真实思考流元数据：只存规模与耗时，不存原始 CoT。 */
  thinking: Type.Optional(Type.Object({
    durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
    chunks: Type.Integer({ minimum: 0, maximum: 100_000 }),
  })),
});
export type ChatAttachment = Static<typeof ChatAttachmentSchema>;
export const DetailChatRequestSchema = Type.Object({
  requestId: Type.String({ minLength: 8, maxLength: 100 }),
  text: Type.String({ minLength: 1, maxLength: 1000 }),
  tripId: Type.String({ minLength: 1, maxLength: 100 }),
  updatedAt: Type.Number(),
  dayId: Type.Optional(Type.String({ maxLength: 100 })),
  suggestion: Type.Optional(StringEnum(CHAT_SUGGESTION_KINDS)),
});
export type DetailChatRequest = Static<typeof DetailChatRequestSchema>;

/** 行前回合（还没有行程，只有会话与 Brief）：表单入口交给主 Agent 的第一条消息。 */
export const PlanningTurnRequestSchema = Type.Object({
  requestId: Type.String({ minLength: 8, maxLength: 100 }),
  text: Type.String({ minLength: 1, maxLength: 1000 }),
  /** 表单「开始规划」：即使模型没调用 delegate_task，也要确定性启动一次。 */
  autostart: Type.Optional(Type.Boolean()),
});
export type PlanningTurnRequest = Static<typeof PlanningTurnRequestSchema>;
export const TripOperationRequestSchema = Type.Object({
  operationId: Type.String({ minLength: 8, maxLength: 100 }),
  expectedTripId: Type.String({ minLength: 1, maxLength: 100 }),
  updatedAt: Type.Number(),
});
export const AddFoodRequestSchema = Type.Composite([TripOperationRequestSchema, Type.Object({
  candidateId: Type.String({ minLength: 1, maxLength: 100 }), position: MealPositionSchema,
})]);
export type AddFoodRequest = Static<typeof AddFoodRequestSchema>;
export type TripOperationRequest = Static<typeof TripOperationRequestSchema>;
/** 回退：把 targetTripId 设为当前版本，删除它之后的版本（不做复制）。 */
export const TripRewindRequestSchema = Type.Composite([TripOperationRequestSchema, Type.Object({
  targetTripId: Type.String({ minLength: 1, maxLength: 100 }),
})]);
export type TripRewindRequest = Static<typeof TripRewindRequestSchema>;

export const TripOperationResultSchema = Type.Object({
  trip: TripSchema, version: Type.Integer({ minimum: 1 }),
  activityId: Type.Optional(Type.String()), dayId: Type.Optional(Type.String()),
  alreadyExists: Type.Optional(Type.Boolean()),
});
export type TripOperationResult = Static<typeof TripOperationResultSchema>;

export function suggestionText(kind: typeof CHAT_SUGGESTIONS[number], dayIndex?: number): string {
  const scope = dayIndex ? `第 ${dayIndex} 天路线` : '整趟行程沿途';
  const text = {
    food: `推荐${scope}附近的美食`, explore: `看看${scope}还有哪些玩法（先给建议）`,
    pace: `检查${scope}的节奏和时间是否合理（先给建议）`,
    more_food: `再推荐几家${scope}附近不同的餐厅`,
    light_food: `推荐${scope}附近适合清淡口味的美食`, dinner: `推荐${scope}附近的晚餐`,
  };
  return text[kind];
}
