import { Type, type Static } from '@sinclair/typebox';
import { TripShareImageResponseSchema, TripShareImageStyleSchema } from './schemas';

const sequence = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const GenerationNotificationSchema = Type.Object({
  id: Type.String(),
  sequence,
  jobId: Type.String(),
  kind: Type.Union([Type.Literal('success'), Type.Literal('error')]),
  tripId: Type.Union([Type.String(), Type.Null()]),
  title: Type.String(),
  message: Type.String(),
  createdAt: Type.Number(),
  readAt: Type.Union([Type.Number(), Type.Null()]),
  shareImageStyle: Type.Optional(TripShareImageStyleSchema),
});
export type GenerationNotification = Static<typeof GenerationNotificationSchema>;
/** POST 生图时附带本次通知；GET 回显仍只返回图片。 */
export const TripShareImageGeneratedResponseSchema = Type.Object({
  ...TripShareImageResponseSchema.properties,
  notification: Type.Optional(GenerationNotificationSchema),
});
export type TripShareImageGeneratedResponse = Static<typeof TripShareImageGeneratedResponseSchema>;
export const NotificationPageSchema = Type.Object({
  items: Type.Array(GenerationNotificationSchema),
  hasUnread: Type.Boolean(),
  readThrough: sequence,
  nextCursor: Type.Union([sequence, Type.Null()]),
});
export type NotificationPage = Static<typeof NotificationPageSchema>;
export const NotificationQuerySchema = Type.Object({
  before: Type.Optional(sequence),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
});
export const NotificationReadAllSchema = Type.Object({ through: sequence });
/** 生成过程中的软/硬问题：任务卡与主 Agent 都能如实展示，不再只拼进 reviewNotes 文本。 */
export const GenerationWarningSchema = Type.Object({
  severity: Type.Union([Type.Literal('hard'), Type.Literal('soft')]),
  code: Type.String({ maxLength: 80 }),
  dayIndex: Type.Optional(Type.Integer({ minimum: 1 })),
  message: Type.String({ maxLength: 300 }),
});
export type GenerationWarning = Static<typeof GenerationWarningSchema>;

export const GenerationJobViewSchema = Type.Object({
  jobId: Type.String(),
  status: Type.Union([Type.Literal('running'), Type.Literal('done'), Type.Literal('error'), Type.Literal('cancelled')]),
  tripId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.Number(),
  destination: Type.Optional(Type.String()),
  days: Type.Optional(Type.Number()),
  message: Type.Optional(Type.String()),
  /** 运行中任务的当前阶段与已完成步骤（来自内存投影；重启后可能缺省）。 */
  phase: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(Type.String(), { maxItems: 12 })),
  /** 终态摘要：来自持久化任务行，重启后仍可读。 */
  summary: Type.Optional(Type.String({ maxLength: 2000 })),
  reviewNotes: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 20 })),
  warnings: Type.Optional(Type.Array(GenerationWarningSchema, { maxItems: 40 })),
  dataSources: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 4 })),
  conversationId: Type.Optional(Type.String()),
  finishedAt: Type.Optional(Type.Number()),
});
