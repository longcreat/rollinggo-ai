# 详情对话流与版本恢复

## 1. Scope / Trigger

详情页 POST 正文流、真实美食候选、确定性添加、历史查看和恢复共用此契约。
前端为 `ChatPanel` / `HistoryPanel` / `useEditorSave`，服务端为 `detailChatService`、
`tripHistoryService`、`detailOperationService`；共享定义在 `detailChat.ts` / `chat.ts`。
旧 `POST /messages` 保留兼容；详情页使用流式端点。

## 2. Signatures

| API | 请求 / 结果 |
| --- | --- |
| `POST /api/conversations/:id/messages/stream` | `DetailChatRequest` → SSE `ChatStreamEvent` |
| `GET /api/conversations/:id/operations/:operationId` | `{ result: unknown \| null }`，前端按结果 Schema 校验 |
| `POST /api/conversations/:id/operations/:operationId/stop` | 中止在途轮次；返回已有持久化结果 |
| `POST /api/conversations/:id/food` | `AddFoodRequest` → `TripOperationResult` |
| `POST /api/trips/:id/restore` | 路径为历史来源；`TripOperationRequest` → `TripOperationResult` |
| `POST /api/trips/:id/conversation` | 显式为最新行程补建会话；重复调用返回原会话 |
| `PUT /api/trips/:id` | 完整 `Trip`（含旧 `updatedAt`）→ 新版本 `Trip`；原版本冻结，无变化返回原版本 |

数据库双更新：`trips.change_summary TEXT`、`chat_messages.attachment JSONB` 可空；
`detail_operations(user_id, id, fingerprint, result JSONB, created_at)` 以 `(user_id, id)` 为主键。
迁移须覆盖带旧行的存量数据库且可重复运行。没有新环境变量，沿用站点/BYOK模型、地点和网页适配器。

## 3. Contracts

- `DetailChatRequest`：`requestId`（8～100 字符）、`tripId`、已保存 `updatedAt`、
  `text`（1～1000 字符）、可选 `dayId` / `suggestion`。服务端核验所有权、会话、最新版、时间戳和日期。
- 事件为 `accepted / progress / answer_delta / recommendations / edit_result / done / error`，
  带 `requestId` 和从 1 递增的 `sequence`，终态唯一。客户端去重、检查缺帧并拒绝无终态 EOF。
  正文只来自无工具 runner 的 `text_delta`，绕过会缓冲完整响应的重试层。
  折叠区来自真实步骤摘要，不暴露工具参数或内部推理。
- 附件包含来源行程/日期、摘要、最多三张候选和三条建议。候选包含稳定 `poiKey`、
  真实坐标/来源、关联日期，可选 `meal`、位置和营业信息。网页参考不凭标题变成可添加 POI。
  过程摘要最多 20 条，每条 300 字；处理时展开、完成后折叠，刷新后可回看。
  可选 `references: SourceNote[]` 最多 8 条，去重并只接受无凭据的 HTTP(S) URL；前端使用
  `noopener noreferrer` 链接，旧附件无此字段仍有效。
- `retrieveDetailKnowledge` 使用当前问题、最近用户问题、地点和偏好构造检索。
  SQL 地点/主题与独立 `semanticQuery` 以 `vector: force` 融合，同城同类、verified 和实体归并约束不变。
  归并不同来源的同一实体时保留最小向量距离。诊断区分向量已执行、不可用和失败；不得把降级说成向量成功。
  美食查询复用同轮检索和来源会话，坐标按 GCJ-02 消费。正式新行程仍默认 SQL-first 预取，不跟随详情强制向量。
- 最新开放/预约/票价等时效问题、明确联网或库内资料不足时按需搜索；用户明确不联网时禁止调用。
  问答只把库内简介、开放/预约、证据强度和网页摘要作为数据。网页不能升级为带坐标的可添加餐厅。
  `createDetailSources` 在一轮中共享缓存、最多 2 次网页与 4 次地点搜索，使用编辑器日额度预留；
  地点操作按既有天地图最多两次底层调用计费。取消后退未尝试部分，已尝试即计费，账本失败阻止落库。
  `AbortSignal` 贯穿网页和天地图搜索/城市定位，取消结果不缓存；整轮流式端点 5 分钟截止，停止不发布半成品。
- `suggestions` 兼容旧枚举和 `ChatFollowUp {label,text,kind}`，新回答只产生结构化建议。
  `label` 1～30 字，`text` 1～300 字且不能全空白，`kind` 来自 `CHAT_SUGGESTION_KINDS`，
  新增 `follow_up` 表示只读追问，所有建议类型都绕过编辑/生成判断。没有数据库结构变更。
  `generateFollowUpSuggestions` 在正文完成后输入本轮问题、完整回答、行程/日期和真实候选，
  用已有 runner 的 `suggest_follow_ups` 工具生成 2～3 条具体追问；工具 schema 和提示词均要求至少两条。
  这类轻量调用关闭可配置的 DeepSeek thinking，避免建议阶段因长推理耗尽时限。
  工具参数用 typebox v1，落库前用共享 v0.34 schema 校验、去重并排除用户刚问过的问题。
  最多等待 8 秒，超时/上游失败/无工具提交/非法输出不能留下空建议区；原始取消仍终止整轮。
  共享 `completeFollowUpSuggestions` 保留有效的 2～3 条；不足两条时基于最新回答的主题和原文片段补足两条，
  不引入新事实，不回退固定美食/玩法/节奏菜单。服务端随答案保存，前端对已有空/不足建议的最新附件复用同一函数，
  仅展示时兼容，无额外模型请求或历史写入。只在最新完成回答下显示一组，pending 隐藏；历史建议不同时显示。
  `relatedTripId` 也用于真实修改回答：ChatPanel 截去生成前消息时不能跳过带 attachment 的首条修改回答。
  有 clarification 时不另生成建议。建议和正文在同一附件/事务保存，幂等恢复不重新生成。
  添加餐厅的确定性回复使用该餐厅、日期、餐次构造相关交通/节奏问题，不额外调用模型。
- 详情理解启用 `detailMode`，有必要追问时仅返回一个 `clarification.question` 和 2～3 个
  `clarification.options`；过滤空白/重复选项后持久化在助手附件。正文流末尾若缺问题则补齐。
  点击选项仍走普通用户消息，已回答的问题保留但禁用；三条起始建议属于初始化消息，
  后续建议仅显示在最新助手回答且没有 pending 时，不放在输入框底部常驻。旧固定枚举仅
  供空对话起始菜单使用，不再显示为后续建议。点击发送存储的 text/kind 和附件 dayId；
  不用当前选中日期改写来源回答的范围。餐厅位置依次选择日期、餐次和锚点。
- 建议查询不进入编辑/生成判断；普通文本保留局部 `editOps`。
  普通文本即使出现「推荐美食」也先理解整句，修改/确认意图不能被美食关键词降成只读查询；
  显式 suggestion 的只读边界保持不变。
  `add_days {dayIndex, days:[{title,activities}]}` 在一个操作中追加整组日期；起点必须为
  原最后一天 + 1，整趟最多 `MAX_TRIP_DAYS=15` 天，每轮最多一组，每天最多
  `MAX_EDIT_ACTIVITIES_PER_DAY=12` 个活动。明确休息/留白时活动可空。
  非法日期组整组拒绝，不截断成部分成功；原有日期、活动 ID 与内容保持不变。
  共享 TypeBox v0.34 与工具 typebox v1 的操作 schema/常量必须同时更新。
  `editActivityDrafts` 同时展开普通活动和新增日期内的活动，避免漏做地点解析。
  新日期沿用现有路线修复；缺位置不伪造坐标或交通。`add_activity` 不隐式创建日期。
  新日期的模型活动仅是需求草稿：`researchAddedDays` 调用与生成共用的 `runResearchPhase`，
  使用同一套候选工具、简介/来源规则，再通过 `applyDeterministicSchedule` 排程；不调用整趟 `runGeneration`。
  旧 `/messages` 的 add_days 同样委托详情服务，复用已完成理解并原子保存，不再走草稿直接落库。
  调研排除旧景点主名/已知别名，要求库内实体或本轮真实地点搜索结果；模型不能补造来源 URL。
  明确空白日保持空白；连续非休息日分段使用实际追加日期排程。每个非休息日至少一个真实候选，
  纯占位或调研未提交不能当成功；合成餐次锚点不解析为具体店铺坐标。来源和简介随活动保存。
  新增日期成功/拒绝后的 Brief 日期都以实际行程为准，防止旧 `endDate` 抵消新增天数。
  历史恢复通过 `syncConversationTripDates(..., tx)` 在同一事务同步天数与结束日期，保留偏好/约束。
  自动重新生成要求 `intent=confirm`、明确重新生成文字、Brief 就绪、额度和并发条件允许。
- 成功消息对、Brief、可选新版本和操作结果在一个事务提交。失败/停止不写半条消息，
  对话额度依用户消息计数，因此不收费；添加/恢复只写助手操作记录，不耗 AI 次数。
  外部查询仍按来源计量。提交成功后的断线以持久化结果为准。
- `AddFoodRequest` 带 `operationId`、`expectedTripId`、`updatedAt`、`candidateId`、
  `position: { dayId, beforeActivityId?, meal }`。使用服务端保存候选，不采信客户端店铺正文。
  无时间轴不猜默认位置；已有用餐、失效锚点、明确休息日阻止添加。有时间轴时按新增交通
  和一小时用餐检查时段/已知营业时间。只更新新增相邻边，保留未变路线及住宿首末边；
  无服务时路线显式标为 `heuristic`，缺坐标不伪造路线。
- 恢复复制历史内容，新 ID/时间戳/版本号，父节点取事务内最新版；不倒退消息或重新查询历史内容。
  无会话也可恢复。`change_summary` 只显示可靠记录，旧行缺失时回退标题。
- `createTrip`、`updateTrip`、`commitOperation` 共用用户行锁；事务内重查最新版及 `updatedAt`。
  手动保存用原版本 ID 和完整快照生成 `manual-save` 指纹，操作 ID 为 `save:<fingerprint>`。
  相同快照重试返回已有结果；实际内容变化才创建新版本，比较时排除 ID 与创建/更新时间。
  相同操作标识/内容返回原结果；相同标识用于其他内容拒绝。
  单实例内存锁约束会话在途轮次，持久化幂等由数据库承担。

## 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 输入 Schema 无效 | 400，不开始流/写入 |
| 非本人、会话不关联、跨版本链 | 404，和不存在同义 |
| 历史写入、时间戳过期、位置/时段冲突 | 409，保留草稿和候选 |
| 并发轮次、操作 ID 复用不同内容 | 409，不重复副作用 |
| 缺模型配置 / 对话额度不足 | 400 `no_llm` / 429 |
| 流中上游失败、停止 | `error` 终态，部分文字仅屏幕保留 |
| 仅后续建议生成失败、超时或格式无效 | 正文正常提交，按回答内容补足两条追问；不回退固定菜单 |
| 保存失败 | 不切版本；错误可见，可重试保存 |
| 新增日期起点错误、重复追加组、总天数超出 15 | `EditOpOutcome.applied=false`，无该组日期的新版本，不部分追加 |
| 追加调研中断、未提交、候选不足以覆盖非休息日 | `error`，新版本/消息/Brief 均不写入 |
| 向量服务/pgvector 不可用 | 保留 SQL 结果并显示降级；不能宣称语义检索成功 |
| 网页/地点未配置或额度不足 | 说明资料局限，不能伪称联网成功；不绕过日额度 |
| 操作结果记录插入失败 | 整体回滚新版本与消息 |

## 5. Good / Base / Bad Cases

- Good：v5 恢复 v2 → v6 内容来自 v2，原版本保留；相同操作重试仍返回 v6。
- Good：v5 手动保存 → v6，等待期间的新编辑继续排队为 v7；v5、v6 不被后来的快照覆盖。
- Base：无时间轴的餐厅先选择餐次与活动前后位置；查询不创建版本。
- Good：回答轮渡安排后建议询问返程/码头；建议随同该回答刷新恢复，点击只是继续咨询。
- Bad：回答交通后不看正文就固定返回“美食/玩法/节奏”，或为填满三条而编造已核验事实。
- Bad：完整回答定时逐字播放、旧版本直接作 `revisionOf`、保存失败仍切 URL、直线距离称为步行距离。
- Good：2 天行程「再加一天」保存 3 天新版本，再延长两天为 5 天；恢复最初版本时天数与 Brief 都回到 2 天。
- Bad：仅更新 Brief.days、对不存在的第 3 天执行 add_activity，或逐日截断超限请求。

## 6. Tests Required

- `node --import tsx --test apps/server/src/__tests__/followUpSuggestions.test.ts`（设置测试 MASTER_KEY）：
  旧附件兼容、结构化字段/能力校验、去重、真实 runner 输入完整回答/日期、单次工具提交、失败/超时补足、原始取消上抛。
  补足基于本轮回答而非旧问题/寒暄；合法两条/三条保留，单条补齐。
- `node --import tsx --test apps/web/tests/detail-chat.test.ts apps/web/tests/editorStore.test.ts apps/server/src/__tests__/chatEditOps.test.ts`：
  UTF-8 分块/去重/缺终态、只读 store、回执保留草稿、餐次/营业时间/重复 POI、局部编辑。
- `detailKnowledge.test.ts`：独立语义输入、实体融合、向量降级、按需联网、禁用联网、引用协议、去重和计费。
  `detailSourceCancellation.test.ts`：真实适配器 HTTP 取消传递及缓存不受取消污染。
  `researchSubmission.test.ts`：追加调研拒绝旧实体/模型虚构地点/模型伪造引用，批次提交和取消。
- 构建后 `node --import tsx scripts/verify-detail-chat.mts`：隔离 PostgreSQL、模拟增量模型和生产前端。
  验证提前收到正文、幂等、所有权、历史冻结、迁移、并发恢复、事务回滚、改稿、重新生成入口、
  浏览器停止、添加/恢复、保存失败与延迟保存后切版本、追问选项刷新持久化、逐步选位置、
  连续保存保留日期和输入草稿、离开页面后迟到回执不抢回导航、历史刷新只读、16px 与 375px。
  也验证动态建议与答案同存、点击完整问题、多轮仅显示最新建议、pending 隐藏以及刷新恢复。
  无初始关联消息的首次修改仍显示完整回答与两条建议；已有空建议附件刷新即可补足，模型空输出不再使建议区消失。
  新增日期回归还覆盖一天/多天、跨年结束日期、重复请求不重调模型、15 天上限、
  新版本/消息/Brief 事务回滚、只读建议不新增、历史恢复同步天数与过程展开/折叠。
  混合 RAG 回归验证实际调研工具调用、简介/来源复用、连续追加不重复、调研失败和停止回滚，
  网页参考持久化、旧端点复用调研与明确休息日跳过调研。未装 pgvector 的隔离 PG 验证降级，
  向量融合由注入查询结果的定向测试验证，不能据此声称真实向量索引已部署。
  `VERIFY_GENERATION_ADMIN_URL` 可覆盖隔离 PG 管理连接，默认本机 18797；随机建库并清理。
  此验证不代表真实外部模型/地图/搜索供应商通过现场验收。

## 7. Wrong vs Correct

```ts
// Wrong：分别提交；重试可能产生第二版。
await createTrip(userId, source, oldId);
await appendMessages(input);

// Correct：行锁、时间戳校验和所有写入共用 tx，提交后发布 done。
await commitOperation(userId, operationId, fingerprint, async (tx) => {
  await assertLatestTrip(userId, expectedTripId, updatedAt, tx);
  const trip = await createTrip(userId, source, expectedTripId, tx);
  await appendMessages(messages, tx);
  return { trip, version };
});
```
