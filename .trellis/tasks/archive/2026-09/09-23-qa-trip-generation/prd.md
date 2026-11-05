# 问答式行程生成交互升级

## Goal

把「新建行程」从 8 字段表单改为**对话 + 可编辑确认卡**：用户用自然语言描述需求，AI 逐步追问补齐必要信息，底部常驻一张可编辑的行程确认卡；信息齐备后用户确认才启动正式生成。
生成后用户可在同一对话里继续提修改意见，产出**新版本行程**，旧版本保留可对比回退。

目的是降低首次使用门槛、让个性化需求（偏好、同行人、避雷项）能被真正表达出来，而不是塞进一个「补充要求」输入框。

---

## Requirements

### R1 对话式入口（替换表单页）

* `/trips/new` 变为对话页，`PlannerPage.tsx` 被替换（不保留表单兜底入口）
* 界面由三部分组成：消息流 / 底部常驻确认卡 / 输入区
* 用户首条消息即可是一句话（如「11月去成都玩3天，带2岁小孩」），无需理解字段含义

### R2 对话理解与 Brief 增量更新

* 新增服务端接口：发送一条消息 → LLM 产出 `DialogueDecision`
* 单次调用同时返回：`reply`（给用户的话）、`briefPatch`（结构化增量）、`missingFields`
* Brief 采用增量 patch 语义，支持删除与恢复单条约束
* 必填字段仅 4 项：**目的地 / 开始日期 / 结束日期（或天数）/ 旅行侧重点**
* 服务端下发 `inputSchema`，前端据此选控件（`enum` → 按钮组，无 `enum` → 文本框）

### R3 约束模型

* 约束带 `category`（11 枚举）+ `polarity`（`prefer` / `avoid` / `require` / `fact`）+ `evidenceSequence`（可追溯来源消息）
* 四种 polarity 有各自的徽章文案与「本次排除」交互

### R4 确认卡

* 仅当 Brief 齐备（`ready`）时在消息流中渲染确认卡；收集阶段靠对话，不重复弹卡
* 卡片底部常驻（sticky），每个字段可点开直接编辑
* 字段编辑后立即回写 Brief，并追加一条 AI 确认回复
* 缺字段时卡片上直接给出可点选控件

### R5 生成与配额

* 卡片上「开始生成」调现有 `POST /api/generations`，复用现有 SSE 时间线与进度组件
* 对话轮次**不消耗** `GEN_DAILY_LIMIT`（只有实际生成计入）
* 新增 `CHAT_DAILY_LIMIT`（默认 40），按用户每日对话轮数计数（事实来源：`chat_messages` 当日 `role='user'` 行数）；达上限阻断发送并给出可操作提示（引导「确认并生成」）
* **失败的一轮不计数也不落库**：用户消息与 AI 回复成批写入，理解失败时整轮丢弃 —— 与生成链路「失败不计配额」一致

### R6 持久化

* 新增 `conversations` / `chat_messages` / `planning_briefs` 三张表
* `generations` 增加 `conversationId` / `kind`（`generation` | `revision`）/ `targetTripId`
* 刷新或换设备后可恢复对话历史与未提交的 Brief

### R7 对话内修改行程（修订）

* 用户对已有行程提修改意见 → 产出 `kind=revision` 的生成任务
* 修订**不覆盖**原行程，产出新版本

### R8 版本链

* `trips` 增加 `rootId` / `version` / `parentId`
* `/trips` 列表只显示每条版本链的最新版
* 行程详情页可切换版本对比
* 对话里给出「已生成 v2，旧版 v1 保留 [对比]」的可见反馈

---

## Acceptance Criteria

* [ ] 用户仅输入一句话即可推进流程，不需要先理解有哪些字段
* [ ] 缺字段时出现可点选控件，不出现「请填写 xxx」式的纯文本要求
* [ ] 必填字段只有 4 项，其余缺省也能生成
* [ ] 确认卡上每个字段可编辑，编辑后 Brief 与 AI 回复同步更新
* [ ] 除确认卡外，聊天流中不插入额外的重复卡片（不刷屏）
* [ ] 约束的 4 种 polarity 在卡片上有区分明显的文案
* [ ] 对话轮数达到 `CHAT_DAILY_LIMIT` 时阻断发送并给出可操作提示
* [ ] 对话不消耗 `GEN_DAILY_LIMIT`
* [ ] 刷新页面后对话历史与未提交的 Brief 均可恢复
* [ ] 对话内修改行程产出新版本，旧版本可访问、可对比
* [ ] `/trips` 列表不出现同一版本链的多条记录
* [ ] SSE 断线重连、刷新恢复、取消、配额耗尽等既有路径不回归

## Definition of Done

* `npm run typecheck` 通过（覆盖 shared / server / web / eval 四个 tsconfig）
* 服务端新增逻辑有单测（沿用 `apps/server/src/__tests__/` 风格，现有 28 个测试文件）
* `npm run build` 通过
* 数据库 migration 幂等，可重复执行
* 既有 SSE / 恢复 / 取消 / 配额路径全部不回归
* 新增接口有错误处理与日志（遵循 `.trellis/spec/server/backend/`）

---

## Technical Approach

### 分层

```
packages/shared
  src/chat.ts            ← Conversation / ChatMessage / PlanningBrief / TripConstraint
                            DialogueDecision / IntakeSchema（TypeBox schema + Static<> 派生类型）

apps/server
  src/db/schema.ts       ← 3 张新表 + generations 加 3 列 + trips 加 3 列
  src/db/migrate.ts      ← 对应 migration
  src/chat/models.ts     ← TypeBox schema（对应 FloatTrip 的 DialogueDecision）
  src/chat/prompts.ts    ← system prompt
  src/chat/understanding.ts  ← LLM 调用，产出 DialogueDecision
  src/chat/brief.ts      ← requiredBriefFields + requiredInputInterrupt（已落在 shared：requiredBriefFields / briefIntake）
  src/routes/conversations.ts ← 会话 CRUD + 发消息 + 改 Brief
  src/routes/generations.ts   ← 增加 conversationId / kind / targetTripId 入参
  src/services/chatQuotaService.ts ← 日对话轮数计数

apps/web
  src/pages/ChatPage.tsx        ← 替换 /trips/new（对话 + 确认卡 + 生成进度）
  src/components/chat/          ← MessageBubble / IntakeControls / BriefCard / ChatInput
  src/components/GenerationRunPanel.tsx ← 从原 PlannerPage 抽出的生成进度视图
  src/hooks/useGenerationRun.ts ← 从原 PlannerPage 抽出的 SSE / 恢复 / 取消
  src/lib/chatDerive.ts         ← 对话视图纯函数（无 store：服务端状态归 React Query）
  src/api/hooks.ts              ← 新增 query / mutation
  src/pages/TripEditorPage.tsx  ← 版本切换 UI
  src/pages/TripListPage.tsx    ← 只显示最新版
```

**不建 `chatStore`（对原计划的修正）**：消息与 Brief 都是服务端状态，React Query 已是唯一持有者；
再复制一份到 zustand 会踩 `.trellis/spec/web/frontend/state-management.md` 明确列出的反模式。
对照 `applyEvent` 得到的实际收敛物是「纯派生函数 + React Query 缓存失效」。

### 核心接口

```
GET    /api/conversations                   会话列表（含关注度徽章状态）
POST   /api/conversations                   新建会话
GET    /api/conversations/:id               详情（消息 + Brief + 关联行程）
POST   /api/conversations/:id/messages      发消息 → { reply, brief, missingFields, intake }
PATCH  /api/conversations/:id/brief         直接改 Brief 字段（确认卡编辑）
DELETE /api/conversations/:id

POST   /api/generations                     增加 conversationId / kind / targetTripId
```

### 关键设计约束

* **对话不生成行程。** 对话只做三件事：抽取参数、回答旅行问答、更新 Brief。只有 Brief 齐备且用户确认才创建生成任务（FloatTrip 的核心边界）。
* **Brief 是快照，不是状态。** 生成任务只在 Brief 快照上跑，避免边聊边生成导致反复推翻。
* **复用 SSE 链路。** 现有 `EventSource` + `lastEventId=0` 全量重放语义已经是正确的重放模型，不需要重造。
* **前端 reducer 与 React 解耦。** 对话状态转换写成纯函数，便于单测。

---

## Decision (ADR-lite)

### D1 交互形态：对话 + 可编辑确认卡

**Context**：问答式至少有三种形态（对话+确认卡 / 向导式 / 纯聊天），选错导致架构返工。
**Decision**：对话 + 底部常驻可编辑确认卡。
**Consequences**：兼顾对话的低门槛与表单的可见性/可复查/可编辑；生成链路不动。代价是新增对话状态管理、卡片与消息流的同步复杂度、以及「何时算填够」的判定设计。已排除向导式（无法跳步、表达不了个性化需求）与纯聊天（NN/g 五条可用性缺陷，改参数只能重跑）。

### D2 对话历史落库

**Context**：会话状态存在前端还是数据库，工作量差 1.5 天。
**Decision**：落库（`conversations` / `messages` / `planning_briefs`）。
**Consequences**：对话可跨设备回看；也是后续「长期旅行记忆」的前置条件。代价是新增表 + migration + 路由。

### D3 日对话额度独立于生成配额

**Context**：对话轮次会消耗站点 LLM 额度，但现有 `GEN_DAILY_LIMIT`（默认 3）按 `generations.status='done'` 计数，对话天然不计入。
**Decision**：新增 `CHAT_DAILY_LIMIT` 环境变量 + 按用户每日对话轮数计数。
**Consequences**：成本可控、生成配额不被误伤。代价是新增计数逻辑与表/列。

### D4 表单页不保留

**Context**：对话页出问题时是否有退路。
**Decision**：不保留，`/trips/new` 直接改为对话页。
**Consequences**：少一份维护成本，产品形态统一。风险是对话页故障时用户无替代入口——缓解手段是错误态必须给出可操作提示而非死胡同。

### D5 本次不抽 CSS 变量，新样式保持简洁

**Context**：对话页需要新样式，现有 `global.css` 是 380 行具体值堆叠。
**Decision**：本次沿用现有 CSS 风格，不抽设计 token、不重构 `global.css`。对话页新样式**保持简洁**（复用现有 `.btn` / `.card` / `.muted` 等类 + 最少的局部样式），不做精细视觉打磨。
**Consequences**：少 1–2 小时工作量，避免为即将重构的样式层做无用功。代价是对话页会沿用当前视觉水平的样式。**已明确：视觉统一重构作为独立任务后续进行**，届时对话页与其余页面一并改造。
**后续任务预留**：样式重构任务需要覆盖：`global.css` 抽 token、对话页、Login / Register / TripList / TripEditor 四个页面。

### D6 对话与行程一对多，支持对话内修订

**Context**：一个会话能产出几个行程？能否在对话里改已有行程？
**Decision**：一对多；支持对话内修订（`kind=revision`）。
**Consequences**：功能完整，贴近 FloatTrip。代价是需要 revision 链路（基于已有行程定向重跑），且与编辑器已有的修改能力重叠——需要在 UI 上明确「对话改 = 大改，编辑器改 = 微调」。

### D7 修订产出新版本，不覆盖

**Context**：修订结果原地覆盖还是新建版本。
**Decision**：版本链（`trips` 加 `rootId` / `version` / `parentId`），`/trips` 列表只显示最新版。
**Consequences**：可回退、可对比、列表干净。代价是 +1 天，且行程列表/详情页需要版本切换 UI。

---

## Out of Scope (explicit)

* 长期旅行记忆（偏好画像的跨行程沉淀、审批、忘记机制）—— 对话历史落库是它的前置条件，本次只打地基
* 移动端 / 小程序
* 多模型 provider 切换
* 消息分支 / fork / 重新生成历史
* 保留表单页作为兜底入口（已确认不需要）
* 视觉地基：不抽 CSS 变量，不重构 `global.css`；对话页新样式保持简洁（已确认，见 D5）
* 除对话页 / 行程列表 / 行程详情以外的页面视觉改版（Login / Register 等）
* 引入 UI 组件库或 CSS 框架
* 对话的实时流式输出（`reply` 一次性返回即可；生成阶段的实时进度沿用现有 SSE）

---

## Implementation Plan

| PR | 内容 | 预估 |
|---|---|---|
| **PR1** | 共享契约（`packages/shared/src/chat.ts`）+ 数据库 schema / migration。无 UI，可独立验证 | 0.5 天 |
| **PR2** | 对话理解服务端：`chat/` 模块（models / prompts / understanding / brief）+ `routes/conversations.ts` + `chatQuotaService`。含 `brief.ts` 纯函数单测 | 1.5 天 |
| **PR3** | 对话页最小可用：`ChatPage` + `chatStore`（纯 reducer）+ 消息流 + 输入区 + 确认卡只读。接 PR2 接口，确认后调现有生成接口 | 1.5 天 |
| **PR4** | 确认卡可编辑 + 对话历史恢复 + 会话列表入口 | 1 天 |
| **PR5** | 修订链路（服务端）：`kind=revision` + 基于已有行程重跑 | 1.5 天 |
| **PR6** | 版本链（`trips` 三列 + 列表去重 + 详情页版本切换 + 对话内修订结果卡片） | 1 天 |

**合计约 7 天。**

依赖顺序：PR1 → PR2 → PR3 → PR4；PR5 依赖 PR2；PR6 依赖 PR5。
PR1–PR3 完成后即可端到端跑通「对话 → 确认 → 生成」，PR4–PR6 是完整度补强。

---

## Technical Notes

* 现有生成链路：`apps/web/src/pages/PlannerPage.tsx` → `api/hooks.ts` → `apps/server/src/routes/generations.ts` → `generation/jobManager.ts` → `generation/orchestrator.ts`
* SSE 事件契约定义在 `packages/shared`（`GenerationEvent`）
* 现有进度组件：`apps/web/src/components/GenerationTimeline.tsx`（164 行）+ `lib/generationTimeline.ts`（182 行）—— **实施前需确认它是否已做「内部节点 → 产品阶段」折叠**，若已做则直接复用，避免重复实现
* 数据库：PostgreSQL + drizzle-orm，唯一事实源列写在 `trips.data`（jsonb）
* 现有保存路径：`PUT /api/trips/:id` 全量覆盖保存（编辑器用）；`PATCH /api/trips/:id/title` 改名
* 配额事实来源：`apps/server/src/services/quotaService.ts`（按 `generations.status='done'` 计数）
* 对话轮数事实来源：`chat_messages` 表中当日 `role='user'` 的行数（不新增计数表）
* 站点 LLM / BYOK：`env.siteLlm` + `userSettings` 表（`byokEnabled` / `baseUrl` / `apiKeyCiphertext`）；对话理解接口应同时支持两者
* **契约技术栈**：`packages/shared` 与 server 路由 schema 统一用 **TypeBox**（`Static<typeof Schema>` 派生类型），不用 Zod；验证规范见 `.trellis/spec/shared/frontend/type-safety.md`
* **模块边界**：新增 `src/chat/` 与 `src/routes/conversations.ts` 的归属规则见 `.trellis/spec/server/backend/directory-structure.md`；对话状态归属（reducer vs React Query）见 `.trellis/spec/web/frontend/state-management.md`
* 无头浏览器可用：`playwright` 已在根 `devDependencies`，可用于端到端验证
* 参考实现的关键文件见 `research/` 三份文档末尾的文件索引

## Research References

* [`research/floattrip-conversational-flow.md`](research/floattrip-conversational-flow.md) — 对话与规划分离、Planning Brief 契约、Run 生命周期与 SSE 重放、前端 reducer 设计
* [`research/rikkahub-chat-ui-patterns.md`](research/rikkahub-chat-ui-patterns.md) — Message parts 模型、工具调用可视化、内联 ask_user 控件、语义色命名
* [`research/conversational-vs-form-migration.md`](research/conversational-vs-form-migration.md) — NN/g 对对话式可用性的批评、四种收集模式对比、字段级形态建议、迁移与视觉时序
