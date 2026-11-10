# 当前功能与评估对应（2026-10-04）

以当前首页、`briefToGenerateForm`、`runGeneration` 与详情 API 为依据。预算、强制酒店推荐、生成具体起止时刻均不是当前功能要求。历史字段和旧测试名称不能充当功能清单。

| 当前功能 | 实际执行的验证 | 检查重点 |
| --- | --- | --- |
| 首页目的地/日期/人数/节奏/偏好/交通/备注 → Brief → GenerateForm | chatBrief / chatBriefApply 单测，generation-browser | 必填与日期范围、参数转换、单次提交、Brief 留档、请求中的 pace/preferences |
| 账号偏好与最近一次选择 | verify-travel-preferences，generation-browser | 默认与旧记录补齐、非法输入、账号隔离、已保存选择不再要求重选 |
| SQL/向量检索、候选提交与简介来源 | verify-sql-first --flow | 地点身份、同城/验证状态、食品筛选、取消、不伪造来源、候选去重、SQL 优先与向量降级 |
| 调研未按工具协议提交 | agentCompletion / llmRetry，eval:verify 三场景 | 同上下文一次纠正，仍不提交则在排程前失败；错误与取消保持终态 |
| 系统排程 | scheduling / mealLocality / placeFacts / placeRelations / openHours / longHaul | 三种节奏容量、1–15 天、闭馆匹配、远郊独占、关联/先后关系、缺候选降级、美食双餐与附近区域 |
| 标题写作 | titleFont / prompts，live execution | 只改标题、成功收口、字形与天数校验；文案失败沿用默认标题/候选简介 |
| 坐标、路线及最终修复 | geoPipeline / legs / routeOrder / routeCoherence / longHaulFixer，live execution | 用户交通基调、缓存与降级、餐次位置、先后约束、换天/重排后清旧腿、失败回滚 |
| 最终产物与保存 | currentFlow，verify-generation-flow | 输入保留、天序/唯一 ID、偏好双餐、可选住宿、路段当前引用、概览与候选一致、行程/成功审计同时读回 |
| 生成异常、取消、刷新恢复 | verify-generation-flow，generation-browser | 初始化失败、事务期间取消回滚、COMMIT 后成功、版本链、终态 SSE、同一任务刷新恢复、不重复扣额 |
| 详情路线方式切换 | verify-route-options | 权限、有效选项、缓存、选中保存/读回、服务额度独立与降级；这是服务调用额度，不是旅行预算 |
| 行程天气 | verify-trip-weather | JWT mock、日期范围、地点匹配、缓存、刷新、服务不可用；普通 live 关闭天气，不声称已经测到 |
| 已审核照片复用与文件导出 | reviewedPhotos / researchSubmission / exportFiles | 来源、审核、重复视角、复用候选图、文件结构；独立采图后台的真实外部质量不在此集合中 |
| 详情对话、编辑与历史恢复 | verify-detail-chat（API + 生产浏览器） | 增量 SSE、候选建议与添加、局部改稿、增天调研、停止/失败不写半成品、保存并发、幂等、只读历史、恢复为新版本、移动端 |

`npm run eval:flow` 将上表对应的维护中脚本组合为可运行清单，并保留逐环节日志。步骤出现未通过不能被其他步骤的 PASS 抵消；`--no-browser` 明确是部分验证。

另有三种证据边界：

- `npm run eval`：历史最终快照，不执行当前生产链路；旧快照无 execution 时不评价未采集的当前步骤。
- `npm run eval:flow`：当前代码与产品契约，真实本机数据库、受控外部响应；不证明真实模型/网络服务质量。
- `npm run eval:live -- --knowledge frozen ...`：真实模型/地图和固定知识版本，附当前生成执行记录；仍不等于首页、详情等界面已验收。

真实知识副本完整性与向量恢复用 `eval:knowledge:verify`。真实分店身份、营业信息时效、路线实际耗时优劣需要对应来源或真实 live 证据，不靠名称命中率推断。
