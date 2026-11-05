# 研究证据强度分级：direct / weak / risk_only 注入 prompt 措辞约束

## 背景

借鉴 Yuntu 的证据授权分级：同一条证据进入 prompt 后，模型只能按证据强度封顶措辞——direct 级可当事实陈述，weak 级只能弱表达，risk_only 级只能写成条件性风险提醒。现状 `renderRagContext` 只有 kind（避坑/预约/价格/口碑）平铺，模型措辞靠自觉，一条网友口碑容易被放大成事实承诺。

## 决策（已与用户确认）

1. **强度来源**：`research_evidence` 表新增 `strength` 列，迁移时按 kind 确定性回填；未来 xhs-travel-pipeline 可精细打标覆盖默认值。
2. **作用范围**：分级同时作为 **RAG 召回/筛选证据时的评判标准**（排序与注入优先级）和 prompt 措辞约束。调研阶段 `search_verified_places` 工具不在本次范围。

## 强度映射（迁移回填默认值）

| kind | strength | 措辞规则 |
|---|---|---|
| `xhs_reservation` | `direct` | 可在 description 当事实写清预约渠道/提前天数 |
| `xhs_price` | `direct` | 可写价格，但须带「以实际为准」类时效提示 |
| `xhs_warning` | `risk_only` | 只能写成条件性风险提醒（「旺季可能…建议…」） |
| `xhs_reason`（及其他） | `weak` | 只能用「整体/相对/适合/可以」弱表达，禁止当事实 |

## 改动范围

1. `apps/server/src/db/migrate.ts`：`ALTER TABLE research_evidence ADD COLUMN IF NOT EXISTS strength TEXT NOT NULL DEFAULT ''` + 按 kind 回填 UPDATE（仅 strength = '' 的行，幂等）。
2. `apps/server/src/db/schema.ts`：`researchEvidence` 加 `strength` 字段。
3. `apps/server/src/generation/retrieveContext.ts`：`EvidenceItem` 加 `strength`；`fetchEvidence` SELECT 带出 strength，排序在 kind 优先级之后按 strength 优先（direct > risk_only > weak）。
4. `apps/server/src/generation/prompts.ts`：`renderRagContext` 每条证据渲染强度标签；分节头部加分级措辞规则（direct 可陈述 / weak 弱表达 / risk_only 条件提醒）；`ACTIVITY_REQUIREMENTS` 或 planner 段加一条「按情报强度措辞，强度不足的不得写成确定事实」。
5. 测试：`prompts.test.ts` 补 renderRagContext 分级渲染用例。

## 约束

- 金集可复现性：ragContext 为空时 `renderRagContext` 返回 `''` 的行为逐字不变。
- 迁移幂等：`IF NOT EXISTS` + 只回填空 strength 行，重复执行无副作用。
- 外部管线兼容：strength 有默认回填，xhs-travel-pipeline 不改也能工作；其未来写入非空 strength 时直接生效。

## 验收

- 迁移重复执行幂等；存量行按 kind 映射回填。
- 含 RAG 情报的 planner user prompt 中，每条证据带强度标签，分节头部含措辞规则。
- `pnpm --filter @tripweaver/server test` 通过。
