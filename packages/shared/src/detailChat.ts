import { Type, type Static } from '@sinclair/typebox';
import { StringEnum } from './typebox';
import { SourceNoteSchema, TripSchema } from './schemas';

export const CHAT_SUGGESTIONS = ['food', 'explore', 'pace', 'more_food', 'light_food', 'dinner'] as const;
export const CHAT_SUGGESTION_KINDS = [...CHAT_SUGGESTIONS, 'follow_up'] as const;
export const ChatFollowUpSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 30, pattern: '\\S' }),
  text: Type.String({ minLength: 1, maxLength: 300, pattern: '\\S' }),
  kind: StringEnum(CHAT_SUGGESTION_KINDS),
}, { additionalProperties: false });
export type ChatFollowUp = Static<typeof ChatFollowUpSchema>;
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
export const ChatAttachmentSchema = Type.Object({
  tripId: Type.String(), dayId: Type.Optional(Type.String()),
  notice: Type.Optional(Type.String({ maxLength: 500 })),
  summary: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 }),
  references: Type.Optional(Type.Array(SourceNoteSchema, { maxItems: 8 })),
  candidates: Type.Array(FoodCandidateSchema, { maxItems: 3 }),
  suggestions: Type.Array(Type.Union([StringEnum(CHAT_SUGGESTIONS), ChatFollowUpSchema]), { maxItems: 3 }),
  clarification: Type.Optional(Type.Object({
    question: Type.String({ minLength: 1, maxLength: 300 }),
    options: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 2, maxItems: 3 }),
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
