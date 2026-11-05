// 对话内按需编辑契约（09-24）：LLM 产出编辑操作 → 服务端确定性应用 → 落新版本。
//
// 边界：支持替换/删除/新增活动和追加日期。跨天移动、改住宿、改预算不进对话通道，
// 由编辑器手工完成。时刻轴恒为空（D5），编辑只动活动列表顺序，不做时刻推算。
import { Type, type Static } from '@sinclair/typebox';
import { ACTIVITY_CATEGORIES, EDIT_OP_KINDS, MAX_EDIT_OPS_PER_TURN, MAX_EDIT_ACTIVITIES_PER_DAY, MAX_TRIP_DAYS } from './constants';
import { StringEnum } from './typebox';

/** 新活动的草稿形状：坐标由服务端解析后回填，模型只给名称/类目/简介 */
export const NewActivityDraftSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  category: Type.Optional(StringEnum(ACTIVITY_CATEGORIES)),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});

/**
 * 编辑操作。现有活动用 dayIndex + activityId 双锚定位：
 * activityId 由 renderCurrentTrip 渲染进 prompt，模型照抄；dayIndex 供人读与防御性校验。
 */
export const ItineraryEditOpSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('add_days'),
    /** 追加起点必须等于当前最后一天 + 1，不隐式覆盖/插入已有日期。 */
    dayIndex: Type.Integer({ minimum: 1, maximum: MAX_TRIP_DAYS }),
    days: Type.Array(Type.Object({
      title: Type.String({ minLength: 1, maxLength: 30 }),
      activities: Type.Array(NewActivityDraftSchema, { maxItems: MAX_EDIT_ACTIVITIES_PER_DAY }),
    }), { minItems: 1, maxItems: MAX_TRIP_DAYS }),
  }),
  Type.Object({
    kind: Type.Literal('replace_activity'),
    dayIndex: Type.Integer({ minimum: 1 }),
    activityId: Type.String({ minLength: 1, maxLength: 64 }),
    activity: NewActivityDraftSchema,
  }),
  Type.Object({
    kind: Type.Literal('delete_activity'),
    dayIndex: Type.Integer({ minimum: 1 }),
    activityId: Type.String({ minLength: 1, maxLength: 64 }),
  }),
  Type.Object({
    kind: Type.Literal('add_activity'),
    dayIndex: Type.Integer({ minimum: 1 }),
    /** 插入位置（0 起）；缺省 = 追加到当天末尾 */
    position: Type.Optional(Type.Integer({ minimum: 0 })),
    activity: NewActivityDraftSchema,
  }),
]);

export const ItineraryEditOpsSchema = Type.Array(ItineraryEditOpSchema, { maxItems: MAX_EDIT_OPS_PER_TURN });

// ---------- 应用结果（对话回复与消息落库共用） ----------

/** 单条操作的应用结果：applied 进入行程，rejected 只回话不落库 */
export const EditOpOutcomeSchema = Type.Object({
  kind: StringEnum(EDIT_OP_KINDS),
  applied: Type.Boolean(),
  /** 给人看的简述（「第 2 天：四川博物院 → 成都美术馆」）；拒绝时是原因 */
  summary: Type.String({ maxLength: 200 }),
});

export type NewActivityDraft = Static<typeof NewActivityDraftSchema>;
export type ItineraryEditOp = Static<typeof ItineraryEditOpSchema>;
export type EditOpOutcome = Static<typeof EditOpOutcomeSchema>;
