# 问答式交互行程：现状评估与升级方向

## Goal

在已有「问答式生成」基础上升级四处：按需修订、编辑器内嵌对话、LLM 自主判定触发、修改入口前置。

## What I already know（代码核实，09-24）

**三个目标能力已全部存在**（09-23 落地，见 journal-1.md L489）：

| 目标 | 现状 | 位置 |
|---|---|---|
| 问答式生成 | `/trips/new` 已是对话页，表单已删 | `apps/web/src/pages/ChatPage.tsx` |
| 确认行程细节 | BriefCard 常驻确认卡，字段就地编辑，ready 后点「开始生成」 | `components/chat/BriefCard.tsx` |
| 修改行程 | 对话判定 `modify_itinerary` → RevisionCard 确认 → `kind='revision'` 重跑，版本链 rootId/version/parentId | `chat/understanding.ts`、`routes/generations.ts` |

**将被本次升级推翻的既有契约**（`.trellis/spec/server/backend/chat-guidelines.md`，实施后须同步改 spec）：

- ~~只有 ready Brief + 用户显式点击才触发 `POST /api/generations`~~ → 改为 LLM 判定信息齐备即自动触发
- ~~修订 = 整单重跑，UI 文案「对话是大改，编辑器是微调」~~ → 改为按需修改（targeted edit）

## Requirements（用户已拍板，09-24）

- **R1 按需修订**：对话中的修改请求按 targeted edit 执行，不再整单重跑。用户说「把第 2 天博物馆换成美术馆」，只动该活动，其余不动
- **R2 编辑器内嵌对话**：生成完成后自动跳转编辑页，对话窗口保留在最左侧；编辑页与对话同屏，边看图边聊
- **R3 LLM 自主触发**：取消用户显式确认环节。LLM 判定必要信息（目的地/日期或天数/行程主题）齐备即自动生成行程；修订同理，LLM 判定为修改意图即直接执行，不再有 RevisionCard 确认。兜底策略（用户拍板，09-24）：**完全自动**，LLM 判齐备即触发生成，无倒计时无缓冲；误判白扣额度的风险由用户接受
- **R4 修改入口前置**：行程编辑页可直接发起修改（R2 内嵌对话即入口）

## Open Questions

- R3 的风险控制：LLM 误判「信息齐备」会白扣一次生成额度，是否需要兜底？

## Acceptance Criteria

- [x] 对话中「换/删/加某个活动」只改动目标活动，其余行程与已排时间不变（chatEditOps 单测 + C2/C3 断言）
- [x] 生成完成后自动跳转 `/trips/:id`，左侧常驻对话栏，可继续对话修改（C3：编辑器内嵌面板 + 对话改落 v2）
- [x] 信息齐备后无需点击即触发生成（intent=confirm + Brief ready → 服务端 createJob，C2 断言 autoStartedJobId）
- [x] 修订仍记录版本链（rootId/version/parentId，C2：v1→v2→v3 链、连续修订锚定最新版）

**验证结果（09-24）**：typecheck 全绿；单测 254/257（3 个失败为既有问题，git stash 验证与本次无关）；verify-c2 全过；verify-c3 49/49。

## Out of Scope（暂）

- 跨天移动、改住宿、改预算等高级编辑操作不进对话通道（编辑器手工完成）
- R3 误判的额度补偿机制

## Technical Notes

- 证据：`apps/server/src/chat/*`、`apps/server/src/routes/conversations.ts`、`scripts/verify-c2.mjs`（C2 对话链路断言）、`scripts/verify-c3.mjs`（C3 浏览器全链路）
- R1 影响面最大：`kind='revision'` 重跑链路 → targeted edit 需要新的「行程编辑操作」通道（LLM 产出编辑操作 → 确定性应用 → 落库），与 `TripEditorPage` 的手工编辑共享操作语义
- R1 编辑操作集（用户拍板，09-24）：仅 **替换活动 / 删除活动 / 新增活动** 三件套；时间和排序由确定性调度器局部重排，不暴露跨天移动、改住宿、改预算等操作
