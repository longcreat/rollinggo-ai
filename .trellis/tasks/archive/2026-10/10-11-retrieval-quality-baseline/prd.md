# 检索质量基线评测器

## Goal

让「RAG 检索质量」从不可度量变成可度量、可重复、可比较：建立一套零外部调用成本的离线评测，输出字面层覆盖面与召回率基线，供后续改动（补别名、补主题、调排序）前后对比。

## What I already know

来自 2026-10-11 的只读探针（详见 `research/retrieval-baseline-findings.md`）：

- 5181 个 active verified 地点中，**只有 267 个（5.2%）有真别名**；`payload.aliases` 字段填充率 98.5% 是假指标（数组里只有主名自己）
- **已登记别名的召回是 100%**（Recall@1 = Recall@8 = 100%，189 条抽样，9 城）——瓶颈不在排序，在覆盖
- `payload.themes` 覆盖仅 **30.5%**；`THEMES ?| terms` 与 `rankPlaces` 的 `+45` 对七成地点空转
- 证据覆盖 77%~94%，但 **青岛、苏州为 0%**
- 同城同名不同实体 **0 组**，点名无歧义
- `onDiagnostics` 的 `keywordHits` / `vectorHits` 已采集但**生产零消费**（只用于 progress 文案）

来自既有 spec：

- `rag-guidelines.md`：检索是「optional enrichment, never a gate」；`benchmark-place-retrieval.mts` 是只读 SQL 探针、向量关闭，**不得**把它的向量请求当作完整 RAG 延迟
- `evaluation.md`：候选采用率**不是**地点准确率；覆盖统计**不是**召回轨迹；输入/检查器/知识 hash 变化即不可比；真实 provider 调用需要任务授权，mock 证据不等于真实 provider 证据

## Assumptions (temporary)

- 评测主体沿用只读、无外部调用的路径，可进 CI 零成本运行
- 标注集先自动生成（真别名 + goldset 主名），人工自然语言 query 作为第二批
- 指标先做观测，不设 gate（与项目既有口径一致）

## Open Questions

（已全部收敛，见 `## Decision (ADR-lite)`）

## Requirements (evolving)

- **新建** `scripts/retrieval-quality-baseline.mts`：只读连接业务库，`embed` 恒返回 `null`（向量层全程关闭）
- 输出两块数据：
  1. **字面层覆盖面** —— 真别名率、主题覆盖率、证据覆盖率（按城市）、同城同名冲突数
  2. **召回指标** —— 真别名 + goldset 主名的 Recall@1 / Recall@8，附未命中清单（query / 期望 / 实得）
- **全量跑，不抽样**：真别名 267 条、goldset 116 条全部执行；去掉 `ORDER BY random()`，两次运行结果必须逐字段一致
- 聚合与计算逻辑抽成纯函数，可在无数据库环境下单测
- 注册 `npm run eval:retrieval`（沿用用户已确认的命令名）
- 报告输出：stdout 人读摘要 + `--out <dir>` 写 `report.json`

## Acceptance Criteria (evolving)

- [ ] `npm run eval:retrieval` 一条命令跑完，输出人读摘要与 JSON 报告
- [ ] 报告含真别名率、主题覆盖率、按城市证据覆盖率、同城同名冲突数、Recall@1/@8、未命中清单
- [ ] 同一知识库连续两次运行，`report.json` 逐字段相等（无抽样随机性）
- [ ] 零外部调用：不调 LLM / embedding / 地图；`embed` 恒为 `null`
- [ ] 只读：`default_transaction_read_only=on`，不导入 `db/client`、不跑迁移、不写业务库
- [ ] 纯函数单测（覆盖率与 Recall 计算）随既有测试在 CI 通过
- [ ] `npm run typecheck` 通过

## Definition of Done (team quality bar)

- Tests added/updated (unit/integration where appropriate)
- Lint / typecheck / CI green
- Docs/notes updated if behavior changes
- Rollout/rollback considered if risky

## Decision (ADR-lite)

**Context**：检索质量目前不可度量，且既有设施都不适合直接承载。

**Decision**：

1. **新建独立脚本，不改造既有设施。**
   - 不并入 `scripts/benchmark-place-retrieval.mts`：那是**性能**探针（测 `retrievalMs` 与 `vectorRequested`），质量断言塞进去会让职责混杂
   - 不接进 `eval/` harness：harness 的契约是「快照驱动的纯函数检查器」（`evaluation.md` §3），而本评测必须连数据库取全库覆盖，输入模型不兼容
2. **全量执行，不抽样。** 真别名仅 267 条、goldset 116 条，全跑没有随机性，结果天然可重复；原先探针的 `ORDER BY random()` 会让两次运行不可比。
3. **真实数据跑不进 CI。** CI 没有 5181 行的真实知识库，`eval/knowledge-snapshots/` 又被 Git 忽略（`eval/README.md`）。可进 CI 的是**纯函数单测**（覆盖率与 Recall 的计算逻辑），不是数据库实跑。

**Consequences**：

- 指标口径与 `eval/` 报告体系分离，需要在 spec 里写清两者边界，避免把本报告误读成完整 RAG 评测
- 人工自然语言标注集与向量对比留给后续任务，脚本设计需预留传入自定义 query 集合的入口
- 无 gate：本项目口径是新维度先进报告做观测（`evaluation.md` §3）

## Out of Scope (explicit)

- 不实现稀疏检索（BM25 / tsvector / pg_trgm）——本次只做度量，不做改造
- 不修改生产检索逻辑（`placeRetrieval.ts` / `retrievalRanking.ts`）
- 不补别名或主题数据（数据治理是后续独立任务）
- 不设 gate 阈值（先建立基线）
- 不做「报告 vs 历史基线」的 diff 工具（先积累基线，按需再加）
- 不在 CI 中连真实知识库实跑
- 不评测 LLM 生成质量、不含真实向量参与的召回对比

## Technical Notes

- 探针入口：`scripts/benchmark-place-retrieval.mts`
- 检索实现：`apps/server/src/generation/placeRetrieval.ts`、`apps/server/src/generation/retrievalRanking.ts`
- 配置：`apps/server/.env` 的 `DATABASE_URL`（只读连接）
- 既有评测设施：`eval/`（harness / checks / diff / frozen knowledge），见 `research/retrieval-baseline-findings.md` §5
- 相关 spec：`.trellis/spec/server/backend/rag-guidelines.md`、`.trellis/spec/server/backend/evaluation.md`
- 无 Python：不使用 Python 脚本，评测器用 TS（`tsx` 已在 devDependencies）
