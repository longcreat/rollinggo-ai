// 编辑结果契约（09-24）：对话写工具与消息落库共用的单条操作应用结果。
//
// 边界：LLM 侧的四操作 schema（ItineraryEditOp）已随旧按需编辑链（chat/editOps.ts）删除，
// 现在的对话编辑由 chat/agent 的写工具直接执行并产出 EditOpOutcome。
import { Type, type Static } from '@sinclair/typebox';
import { EDIT_OP_KINDS } from './constants';
import { StringEnum } from './typebox';

// ---------- 应用结果（对话回复与消息落库共用） ----------

/** 单条操作的应用结果：applied 进入行程，rejected 只回话不落库 */
export const EditOpOutcomeSchema = Type.Object({
  kind: StringEnum(EDIT_OP_KINDS),
  applied: Type.Boolean(),
  /** 给人看的简述（「第 2 天：四川博物院 → 成都美术馆」）；拒绝时是原因 */
  summary: Type.String({ maxLength: 200 }),
});

export type EditOpOutcome = Static<typeof EditOpOutcomeSchema>;
