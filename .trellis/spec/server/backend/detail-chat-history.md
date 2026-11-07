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
- 事件为 `accepted / progress / answer_delta / question / question_answered / question_expired /
  recommendations / edit_result / done / error`，带 `requestId` 和从 1 递增的 `sequence`，终态唯一。
  客户端去重、检查缺帧并拒绝无终态 EOF。正文只来自无工具 runner 的 `text_delta`，绕过会缓冲完整响应的重试层。
  `progress` 同时带旧字段 `text` 和可选结构化 `step`（id/name/label/status/startedAt/durationMs），
  前端按 `step.id` upsert；只暴露工具动作标签，不暴露参数、结果或内部推理。
- 附件包含来源行程/日期、摘要和最多三张候选。候选包含稳定 `poiKey`、
  真实坐标/来源、关联日期，可选 `meal`、位置和营业信息。网页参考不凭标题变成可添加 POI。
  附件保留必填 `summary`（最多 20 条、每条 300 字）作为旧客户端与旧历史的回退；新回合同时写
  可选 `steps`（最多 24 条）与 `elapsedMs`。`steps` 按 `callId` 去重，连续同名完成步骤在展示层合并；
  `summary` 只由步骤标签派生。主渲染模型是可选 `parts`（最多 40 段）：`text` 与 `steps` 按真实事件顺序排列，
  正文出现即关闭上一工具段，工具出现即关闭上一正文段；实时与历史共用同一份顺序。旧消息无 `parts` 时
  回退到「过程在上、正文在下」。`relatedTripId` 也标在真实修改回答上：ChatPanel 截去生成前消息时
  不能跳过带 attachment 的首条修改回答。
  运行中展开当前步骤，完成后收成一行摘要，停止/中断保持展开；
  用户手动展开后本轮不再自动收起，刷新后仍可回看。旧消息无 `steps` 时逐条按已完成步骤回退，不追溯耗时。
  `ask_user` 会开启新的 generation：流式正文按当前 generation 的完整快照下发（`answer_delta.replace`），
  前端替换而不是累加增量；落库正文从本轮 committed assistant entries 按顺序回放。问题卡属于输入框上方的
  dock（同 opencode session question dock），不在消息流中，因此输出内容始终在问题卡之前。
  历史里问答记录按真实位置回放：`ask_user` 收到答案时在该回合 `parts` 追加 `{type:'question', index}`，
  问答卡片渲染在工具段之后、后续正文之前；旧消息没有该标记时锚到含 `ask_user` 的工具段之后，找不到才退回末尾。
  问答卡片复用用户消息气泡样式（深色、右对齐、85% 最大宽度），不新增卡片样式。
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
- 详情页 Agent 通路（2026-11-06 起为唯一链路）**同一用户同时只允许一个回合**：Harness、工具注册表与模型槽位
  都是每用户共享的（工具按名字整组替换、模型每轮覆盖），并发会让 A 行程的问题拿到 B 行程的工具闭包。
  第二个请求在改写共享槽位之前返回 409 `AGENT_BUSY`（前端事件 `code: 'busy'`），不排队、不消耗对话额度、
  不写历史；回合结束、异常、用户停止或 5 分钟超时都会释放锁，停止会中断 durable 运行而不是只断 SSE。
  锁是进程内的，前提是单实例部署（与 `startDetailTurn` 一致），多副本需要换成分布式锁。
- Agent 工具输出**不按字数截断**：`web_search` 返回上游 summary 原文与全部命中，`search_places` 不裁条数；
  `get_trip` / `get_day` 的行程快照返回描述全文、费用、开放时间、通勤段、住宿与用户偏好，只剔除与问答无关的
  机器字段（polyline、坐标来源、来源链接）。
  上下文增长交给 pi-durable 的 compaction（默认 `enabled`，reserve 16384 / keepRecent 20000 / background 32768），
  而不是在工具层丢数据。参考 opencode `tool-output.ts`（2000 行 / 50KiB，超限时**保存全文**再给文件引用）与
  pi `truncate.ts`（同样上限、不切断半行）：两者都是「有损展示、无损存储」。我们没有文件读取工具，
  所以选择「不截断 + 压缩」而不是「截断 + 落盘」。上游 `searchSource` 也不再对 summary 做字符裁剪。
- 片区规划（11-06）：景区是面状区域，不能当成一个点。新增工具 `search_area_places(area, radiusM?, keywords?)`：
  先用 `search_places` 取片区中心，再走高德周边检索，按 `geofenceImport` 的同一套规则过滤
  （售票/码头/停车场/游客中心等设施点、超半径、重复坐标），坐标写入本回合点位缓存供 `add_activity` 复用。
  单轮外部检索上限提升到 8 POI / 4 联网（`CHAT_POI_BUDGET` / `CHAT_WEB_BUDGET`）。
  提示词从「发现改动先 ask_user」改为「能直接做完的先做完，再 get_trip/get_day 复核」；
  `ask_user` 只用于删活动、删天数这类真正的取舍。用户要求按片区规划时，Agent 必须先展开片区内点位，禁止只放少量相距很远的粗点。
- 详情页主 Agent 工具面（2026-11-06）：只读五件套 + `search_food` / `ask_user` / `update_brief` / `start_generation` + 9 个写工具
  `add_activity` / `update_activity` / `delete_activity` / `move_activity` / `reorder_day` /
  `add_day` / `update_day` / `delete_day` / `update_trip`，落在 `chat/agent/tripDraft.ts` 的内存草稿上，
  **不在工具调用时写库**。读工具（`get_trip` / `get_day`）一律读草稿，保证本回合的修改立刻可见，
  否则模型会重复添加同一地点。
- 提交时机：`runAgentAnswer` 在回答生成后判断 `draft.changed()`，有改动则
  `repairChangedRoutes(previous, next)` 重算受影响当天的通勤段（地图标记与折线由此更新），
  然后在 `commitOperation` 事务内 `assertLatestTrip` → `createTrip`（新版本）→ 写 `changeSummary`
  → 落消息，并返回 `editResult {tripId, version, outcomes}`。**一轮对话只产生一个版本**，
  中途失败不落半成品；版本与消息同事务，避免「页面说改了、库里没改」。
- 冲突：`assertLatestTrip` 校验 `updatedAt`，用户在其它标签页改过行程时整轮 409，草稿丢弃，
  不覆盖别人的修改（与确定性编辑链同一策略）。
- 改名即换地点：`update_activity` 改 `name` 时必须重新定位，**绝不沿用原名地点的坐标**冒充已定位——
  2026-11-05 真机冒烟里「四川博物院→成都博物馆」曾因此在地图上指向博物院。取点优先级：
  ① 本回合 `search_places` 查到的精确坐标（工具闭包内按归一化名称缓存，含包含匹配）；
  ② `createGeoSession.resolvePlace` 的模糊解析，但要求离行程其它已定位地点 ≤ 50km
  （`RENAME_MAX_KM`；实测「人民公园东门」会被解到 56km 外的同名点）；③ 都不成立 → 落
  `estimated + 0,0`、当天 legs 清空，并在工具回执里给 `warning`，由模型告知用户「位置待核实」。
  不整条拒绝改名：拒绝会让用户的要求被悄悄丢掉。
- 动线重算判定抽在 `services/routeRepairPlan.ts`（纯函数）：活动集合/顺序变化、相邻对缺 leg、
  leg 的出行方式与当前 `transportMode` 不符，三者任一都要重算。**只按 id 列表比较是错的**——
  只改名（清空 legs）或只改出行方式（全行程 legs 清空）时 id 不变，旧实现会永久跳过，
  地图动线再也补不回来（2026-11-05 修复）。
- 增删天要同步 brief：`add_day` / `delete_day` 提交时对 `conversation.brief.data` 跑
  `syncBriefTripDates`，否则后续「按当前需求重新生成」仍用旧天数。
- 撤销/回到版本（2026-11-06）：编辑卡的「撤销这次修改」与历史面板的「回到此版本」都是 **rewind**——
  删除目标版本之后的所有版本，让目标重新成为当前版本，不复制、不新建版本，也不写“已从 vX 恢复为 vY”
  的聊天消息。只有“产生当前版本的那次修改”可撤销；旧消息/旧标签页的撤销请求会被 409 拒绝。
- 改动可见与撤销：`ChatAttachment.edit = {version, previousTripId?, outcomes}` 随消息落库，
  刷新后仍能显示「本轮改动」清单；`editResult.previousTripId` 供前端「撤销这次修改」调用
  `/api/trips/:id/restore` 回到上一版（复用版本链，不新增表）。
- 地点去重：新增时按归一化名称查全行程，命中即拒绝并提示「如确需重访请说明」；
  模型传 `allowRevisit` 才允许重复。每天活动数上限 12、总天数上限 15，与确定性编辑链共用常量。
- 写工具不负责「保存」的话术：系统提示词要求模型不出现「点击保存/正在提交」，
  保存结果由服务端在回答末尾追加「已保存为 vN，…」。
- 详情页所有消息都进主 Agent（不再有 `shouldUseAgent`、灰度开关或只读降级）；美食、结构化追问、
  Brief 更新、重新生成与改行程都是主 Agent 的工具，工具只写回合状态，回合边界统一提交。
- 主子代理（2026-11-05，`spawn_subagents`）：主代理可按槽位并行派发只读探索子代理，
  参考出发鸭 `explore_sub_<domain>_<day>`。实现要点：
  - 每个子任务在**独立 durable 子会话**里跑（`harness.createConversation` + `submit` + `wait`），
    子会话按「父会话 + 槽位 id」复用，进程内缓存；pi-durable 没有删除会话 API，不复用会让 SQLite
    随对话轮次无限增长。同一槽位串行，避免复用会话并发跑两个回合。
  - 子代理的 `modelTools` 是白名单（只读五件套），**写工具与派发工具都不可见**，因此深度恒为 1，
    不存在「子代理改行程」。子代理看到的是同一批工具闭包（同一份行程与数据源），预算也共用。
  - 子会话首轮上下文是全新的，任务提示必须自包含；子代理只回结论（≤300 字），不把原始检索结果
    塞回主代理上下文——这是引入子代理的主要收益。
  - 子代理始终注册，但只装配只读白名单；单次最多 `maxTasks=3`，子代理 `maxTurns=6`，超出的任务直接截断。
  - 工具策略（`chat/agent/toolPolicy.ts`）是唯一事实源：主 Agent 全量，子 Agent 仅
    `get_trip` / `get_day` / `search_places` / `web_search` / `get_weather`；
    创建子会话时校验，配置里出现写/交互/派生工具直接失败。
  - 失败与停止：子任务未完成时回 `ok:false` 说明原因；父回合被停止时同一 `AbortSignal` 会让
    子会话随之中断，不会留下无人接收的跑动。
- 追问建议已移除（2026-11-06）：回答完成后不再额外调用模型生成「你可能还想要」，
  `ChatAttachment` 不再写 `suggestions`，历史消息里的旧字段也不再读取。原因：这条装饰性调用
  让正文停下 1～6 秒才提交并回 `done`，用户看到明显停顿；调研的 harness（dsh/openclaw 同回合工具、
  pi 提交后 afterRun）都不阻塞回答。空会话的三条起始建议仍保留，属于初始化消息。
- Agent 执行协议（2026-11-06）：按「读现状 → 查证 → 决策 → 执行 → 复核 → 总结」循环，最多 10 轮；
  检查/优化类请求发现可执行改动时，必须用 `ask_user` 征求确认（至少「按建议改 / 只给建议」），
  用户选择执行后用写工具完成并再次 `get_trip` / `get_day` 复核。**禁止用正文问句（要不要/你希望/可以吗）
  结束回合**代替问题卡；正文先给结论，最多 3 条要点，通常不超过 300 字。
- 详情页 HITL（Human-in-the-Loop，2026-11-06）：`ask_user` 在工具 execute 内登记问题并 await，
  SSE 下发 `question`；前端 `QuestionCard` 展示问题、选项、多选与自定义答案。
  `POST /api/conversations/:id/questions/:questionId/answer` 回注答案后 Promise 在同一次 Agent run
  内 resolve，模型拿到真实 tool result 继续本轮；不会把选项拼成文末文本或另起一轮。
  同一会话同时只允许一个 pending；默认等待 120s（`HITL_QUESTION_TIMEOUT_MS` 可调），超时/取消返回 pending 并结束本轮，事件区分 `timeout` / `cancelled`。
  `GET /api/conversations/:id/questions/pending` 支持刷新恢复；SSE 断开时若有 pending 不 abort 回合。
  **超时语义（2026-11-07 定调）**：问题超时但本回合草稿已有写改动时，照常提交为一个新版本并在正文附
  「已保存为 vN」——版本历史可一键撤销，而丢弃草稿不可恢复；用户主动停止（abort）仍按「回答中断」处理，不落版本。
  硬超时闸门到点后每 1s 复查，pending 问题 settle 后最迟 1s 内触发（不再等一整段，避免 5min 拖成 ~10min）。
  问答记录写入 `ChatAttachment.questions`，刷新后仍可回看。旧 `understandMessage` 的 detailMode
  链路不再接入详情路由；旧 `clarification` 字段只作历史消息兼容。
  三条起始建议只属于初始化消息，不放在输入框底部常驻；回答之后不再追加建议。
  点击发送存储的 text/kind 和附件 dayId；不用当前选中日期改写来源回答的范围。餐厅位置依次选择日期、餐次和锚点。
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
| 同一用户已有 Agent 回合在跑 | 409 `AGENT_BUSY`，提示稍后再发；不排队、不写历史、不扣额度 |
| 缺模型配置 / 对话额度不足 | 400 `no_llm` / 429 |
| 流中上游失败、停止 | `error` 终态，部分文字仅屏幕保留 |
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
- Bad：完整回答定时逐字播放、旧版本直接作 `revisionOf`、保存失败仍切 URL、直线距离称为步行距离。
- Good：2 天行程「再加一天」保存 3 天新版本，再延长两天为 5 天；恢复最初版本时天数与 Brief 都回到 2 天。
- Bad：仅更新 Brief.days、对不存在的第 3 天执行 add_activity，或逐日截断超限请求。

## 6. Tests Required

- `node --import tsx --test apps/web/tests/detail-chat.test.ts apps/web/tests/editorStore.test.ts apps/server/src/__tests__/chatEditOps.test.ts`：
  UTF-8 分块/去重/缺终态、只读 store、回执保留草稿、餐次/营业时间/重复 POI、局部编辑。
- `detailKnowledge.test.ts`：独立语义输入、实体融合、向量降级、按需联网、禁用联网、引用协议、去重和计费。
  `detailSourceCancellation.test.ts`：真实适配器 HTTP 取消传递及缓存不受取消污染。
  `researchSubmission.test.ts`：追加调研拒绝旧实体/模型虚构地点/模型伪造引用，批次提交和取消。
- 构建后 `node --import tsx scripts/verify-detail-chat.mts`：隔离 PostgreSQL、模拟增量模型和生产前端。
  验证提前收到正文、幂等、所有权、历史冻结、迁移、并发恢复、事务回滚、改稿、重新生成入口、
  浏览器停止、添加/恢复、保存失败与延迟保存后切版本、逐步选位置、
  连续保存保留日期和输入草稿、离开页面后迟到回执不抢回导航、历史刷新只读、16px 与 375px。
  回答完成后不再出现追问建议；空会话只显示三条起始建议。
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
