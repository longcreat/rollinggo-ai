# 对话入口收敛：追问控件下线与首页参数代收

## Goal

生成入口原先有两条并行通道：首页「地图选城 + 胶囊表单」直接生成，与会话里的「对话式追问收集 Brief」→ 确认 → 生成。第二条通道的输入控件（intake）需要维护一套前后端共用的追问契约、控件渲染与消息路由，实际使用率低，且与首页通道产生两套 Brief 状态机。

本次把入口收敛到首页表单一条：**删除服务端追问控件与会话消息路由**，Brief 仍作为生成输入与行程内对话的上下文载体保留。同一批工作区改动里还夹着三处独立缺陷修复与一处分页调整，一并收口。

## 现状证据（工作区已有实现，非新增改动）

改动已在工作区完成、`npm run typecheck` 四包通过，本任务负责补建任务、写清契约与验证、按主题拆分提交。

| # | 主题 | 关键文件 | 规模 |
|---|---|---|---|
| 1 | 追问控件（intake）下线 | `packages/shared/chat.ts`、`types.ts`、`constants.ts`、`routes/conversations.ts`、`services/conversationService.ts`、`components/chat/*`、`api/hooks.ts`、`__tests__/chatBrief.test.ts`、`chatDerive.test.ts`、`.trellis/spec/server/backend/chat-guidelines.md` | +22 / -300（路由）等 |
| 2 | 生成孤儿任务误认领 | `components/GenerationProvider.tsx`、`api/hooks.ts` 的 `useCurrentGeneration` | +13 / -3 |
| 3 | 通知 toast 抑制条件与滚动分页 | `components/NotificationCenter.tsx` | +10 / -3 |
| 4 | 行程列表分页 20 → 12 | `packages/shared/src/constants.ts` | +3 / -2 |

## Requirements

### R1 追问控件下线（主题 1）

- `ChatMessageSchema` 去掉 `intake` 字段；删除 `BriefIntakeSchema`、`BriefInputSchemaSchema`、`INTAKE_ENUM_KINDS`、`SendMessageSchema`
- `ChatMessage` / `BriefIntake` / `BriefInputSchema` 类型删除
- 服务端：`POST /api/conversations/:id/messages` 路由删除；`conversationService` 不再读写 `intake` 列；`listConversations` / `deleteConversation` 删除
- DB 的 `chat_messages.intake` 列**保留**（历史消息仍带值，仅不再校验、不再渲染）；`db/schema.ts` 注释标明「遗留列」
- 前端：`IntakeControls.tsx` 删除；`MessageBubble` 简化为只渲染气泡（不再有 `intakeLive` / `onPatch` / `onText` 参数）；`ChatPanel` 同步调用点
- 前端 hooks：`useConversations`、`useDeleteConversation`、`keys.conversations` 删除
- 规格文档 `chat-guidelines.md` 同步删掉 intake 相关约定

### R2 生成孤儿任务不再误认领（主题 2）

现象：新任务启动瞬间，`current` 查询若读回上一次「旧任务仍在运行」的缓存，adopt effect 会把 `jobId` 改回旧任务，随后重放旧任务的 `job_done`，直接跳到上一次的行程详情页。

- `useCurrentGeneration(userId, enabled)` 增加开关，`GenerationProvider` 传 `!run.jobId`：已在跟踪任务时该查询禁用
- `onStarted` 里先 `qc.setQueryData(keys.currentGeneration(userId), null)` 清掉残留快照，再 invalidate
- adopt effect 增加 `if (runRef.current.jobId) return`
- `discovering` 改用 `current.isLoading`（查询被禁用时 `isPending` 恒为 true，会让加载态永不结束）
- `refetchInterval` 15s → 60s（查询只在「发现孤儿任务」时有用，生成全程应为零请求）

### R3 通知的两个行为修正（主题 3）

- toast 抑制条件去掉 `/trips/${tripId}` 判断：生成完成会自动跳到 `/trips/:id`，那是系统跳转不是用户主动查看结果，完成提醒应照弹（否则红点先亮、弹窗晚到）
- 通知列表由「查看更多」按钮改为滚动到底部附近（距底 120px）自动取下一页；底部只留「正在加载…」状态

### R4 行程列表分页 20 → 12（主题 4）

`TRIP_LIST_PAGE_SIZE` 20 → 12：首页网格 3 列，12 是 3 与 2 的公倍数，每次追加后底部都是整行。`TRIP_LIST_PAGE_SIZE_MAX = 50` 不变。

## Acceptance Criteria

- [x] `npm run typecheck` 四包通过 — 2026-10-18 实测 EXIT=0
- [x] `node --import tsx scripts/verify-sql-first.mts` 全 pass — 93/93（31s）
- [x] 全仓 `grep -r "IntakeControls\|BriefIntake\|INTAKE_ENUM_KINDS\|useConversations\|useDeleteConversation"` 无残留引用 — 仅剩两处注释说明文字
- [x] `POST /api/conversations/:id/messages` 返回 404（路由已删） — `{"code":404,"message":"Route POST:/api/conversations/…/messages not found"}`
- [x] 行程内对话（detailChat 流式）不受影响：`node --import tsx apps/web/tests/navigation-notifications-browser.mjs` 等既有浏览器测试通过
- [x] 浏览器测试 5 个全 PASS（`login-dialog`、`home-mobile`、`travel-preferences`、`shared-ui`、`navigation-notifications`）
- [ ] 按主题拆成 4 个提交，`git log` 顺序符合 `chore(task)` 三段式

### 验证过程备注

- `GET /api/conversations` 也已下线（返回 404）—— 会话列表页随对话入口一起移除，属主题 1 的一部分
- 直接 `curl -d '{...}'` 在 PowerShell 里会被引号转义破坏成非法 JSON，Fastify 在路由匹配前就回 400，容易让人误以为「路由还在」；验证 404 要用 `--data-binary @file` 或干脆不带 body

## Out of Scope

- 删除 DB 的 `chat_messages.intake` 列（历史数据保留，删列不可逆）
- 重做首页表单交互
- 通知中心的其他分页参数调整

## Technical Notes

- 首页一次收参数的表单实现早已上线（地图选城 + 目的地/日期/节奏/偏好胶囊），本任务只是把并行的对话通道拆掉
- `routes/conversations.ts` 精简后只保留「建会话 / 读会话详情」；写入路径统一走 `routes/detailChat.ts` 的流式接口（行程内对话）
- 历史消息 `intake` 数据在 DB 里保留但 `ChatMessageSchema` 不再声明该字段，TypeBox 的 `Value.Check` 对多余字段是宽容的（不校验未声明键），因此历史消息不会因残留字段被判非法
