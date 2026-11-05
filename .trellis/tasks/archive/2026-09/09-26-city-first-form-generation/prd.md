# 首页改版：城市选择 + 结构化表单生成，对话后置为修订问答

## Goal

把行程创建入口从「对话收集」改为「城市选择 → 结构化表单 → 生成」，
降低冷启动成本、去掉收集阶段每轮对话的 LLM 消耗；对话能力保留，但只在行程生成完成后用于修订与问答。

## Requirements

* **首页 = 城市选择页**：仅列出知识库已覆盖城市（canonical_places 中 verified ≥ CITY_COVERAGE_THRESHOLD 100），用户落地先选城市
* **结构化表单**：选定城市后进入胶囊式表单（交互参考 Yuntu InputPage：4 段摘要胶囊条 + 浮动面板 + 范围日历 + 人数步进器）——日期默认明天起 3 天；必填第四项为**旅行节奏**（relaxed/moderate/tight，09-26 取代 tripFocus，景点密度随节奏走）；preferences / partySize / transportMode / lodging 可选；一个自由文本框写「补充说明」（直接进 extraNotes，不做结构化约束分类）
* **节奏贯穿生成**：GenerateForm 新增 pace；排程每日容量按节奏缩放（relaxed 4 点/分量 5，moderate 6/8，tight 8/12）；调研提示词的景点密度指引随节奏变化；偏好不含「美食」时调研不再指引美食检索，住宿检索指引整体移除（住宿本就不进编排）
* **直接生成**：表单提交即走既有 POST /api/generations 链路，全程无需对话
* **只允许已覆盖城市**：未覆盖城市不提供生成入口（下线现有「未覆盖城市降级生成」路径的用户可达入口）
* **对话后置**：生成完成后，在 TripEditorPage 内嵌对话面板，用于按需修订（editResult 版本链）与问答；生成时隐式创建 conversation 并关联该行程（latestTrip）
* **删除 /trips/new 对话收集入口**：收集流（追问控件、BriefCard 收集态、EXAMPLES 等）整体下线

## Acceptance Criteria

* [ ] 首页仅展示已覆盖城市（接口数据与 cityCoverageService 判定一致）
* [ ] 选定城市后表单可完成全部必填项并触发生成，全程零对话
* [ ] 未覆盖城市无法从 UI 发起生成；服务端对未覆盖目的地的直接调用做拦截或提示
* [ ] 生成完成进入编辑器，内嵌对话可发起修订并产生版本链 +1
* [ ] 内嵌对话可进行非修订问答
* [ ] /trips/new 路由不再可达，相关收集代码移除

## Definition of Done

* Tests added/updated（覆盖判定接口、表单→生成映射、修订链路）
* Lint / typecheck 通过；verify 脚本更新（verify-c2 中对话收集相关断言需调整）
* spec/文档同步（chat-guidelines 涉及收集流的部分）

## Technical Approach

* **服务端**：新增 `GET /api/destinations/covered`（GROUP BY city HAVING verified ≥ 100，进程内缓存复用 cityCoverageService 思路）。**会话关联零新代码**：前端在表单生成前先走既有 `POST /conversations` 建会话 + `PATCH /brief` 写入表单快照，再把 conversationId 传给 `POST /generations`——编辑器内嵌 ChatPanel 通过 `findConversationForTrip`（generations.conversationId 反查）自动出现
* **未覆盖城市只做 UI 级限制**（服务端不硬拦截）：保留既有「未覆盖降级生成」能力供 API/测试使用，verify-c2 断言不受影响。这是对原验收标准「服务端拦截或提示」的细化：提示路径已存在于对话流，表单入口直接不提供未覆盖选项
* **前端**：新首页城市图集 → 表单页 → 生成进度（复用 GenerationRunPanel / useGenerationRun）→ TripEditorPage；ChatPage 收集态剥离，改为编辑器内嵌对话面板（保留消息流、发送、editResult 跳转版本）
* **契约**：表单字段直接构造 GenerateForm；extraNotes 文本框拼接进 extraNotes，不经 LLM 抽取

## Decision (ADR-lite)

**Context**: 问答式收集对 4 个可枚举必填项无增量价值，且每轮消耗 LLM 对话额度；kakarot8 式点选入口冷启动成本更低。

**Decision**: 入口改为城市选择 + 结构化表单；自由约束退化为 extraNotes 自由文本；对话保留在生成后做修订与问答；只允许已覆盖城市生成；删除 /trips/new 收集流。

**Consequences**: 放弃结构化 TripConstraint 的入口（avoid/prefer 分类、单条删除）；未覆盖城市用户无法自助生成（覆盖面 = 产品可用边界）；编辑器内嵌对话需处理 conversation 隐式创建与关联。

## Out of Scope

* 城市图集的视觉设计精修（图片/视频素材，先占位卡片）
* 结构化约束（TripConstraint）在表单入口的保留
* 未覆盖城市的降级生成入口
* 历史对话数据的迁移/清理（入口删除后存量会话数据保留在库中）

## Technical Notes

* `apps/server/src/services/cityCoverageService.ts` — 覆盖判定与阈值（verified ≥ 100；当前约北京/成都两档）
* `packages/shared/src/chat.ts` — Brief 契约、requiredBriefFields、briefToGenerateForm（表单可复用其判定逻辑）
* `apps/web/src/pages/ChatPage.tsx` — 现有对话收集入口（收集态剥离，面板形态保留）
* `apps/web/src/router.tsx` — `/` → `/trips`，`/trips/new` → ChatPage（将删除）
* `scripts/verify-c2.mjs` — 含对话收集相关断言，需同步调整
* 参考形态：kakarot8.com（云途 YunTu）城市图集 → 点选必要信息 → 生成
