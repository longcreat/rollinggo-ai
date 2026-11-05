# 详情问答混合检索与新增日期复用

- `createPlaceRetriever` 已有 SQL + 向量 force 模式，按同城同类过滤后融合排序；复用它并增加独立语义 query 与诊断，保留新行程默认 SQL-first 行为。
- `buildResearchTools` 负责候选身份、证据强度、预约信息、介绍和来源复用；抽取 `runResearchPhase` 供 orchestrator 与新增日期共用，禁止直接调用完整 runGeneration 写第二次版本。
- `applyDeterministicSchedule` 可对仅新增日期的 DraftTrip 排程；form.startDate 偏移至旧行程结束后，旧活动按已知别名/主名排除。
- `reserveEditorGeoBudget` 用于对话外部来源计费，与原生成任务计量分别归属；网页最多 2 次、地点最多 4 次/轮，不绕过已有配额。
- 来源参考复用 SourceNote 格式新增可选附件字段，旧消息兼容。普通回复为无工具流，检索在流前准备，工具原始输出与模型推理不展示。
- 新增流程只变更新日期；兼容原 add_days payload，模型草稿仅作为请求意图，已有真实调研能力负责候选。明确空白/休息日保留。
