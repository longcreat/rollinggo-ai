# MimirQ 调研：对本项目 RAG 的可迁移部分

对象：[skygazer42/MimirQ](https://github.com/skygazer42/MimirQ) — 中文优先的企业 RAG 知识库，Python / Apache-2.0 / 544 stars，最新提交 2026-10-07。自述「可观察、可替换、可回归的企业 RAG 基础设施」，覆盖 30 个解析后端、86 种切块策略、13 类重排器、固定 800 题实测。

检索栈为**四通道**：`vector`（Milvus/Chroma）+ `bm25`（内存语料）+ `lexical_db`（Postgres FTS + pg_trgm）+ `sparse`（SPLADE-style，默认关闭）。

## 1. 多通道融合策略 —— 直接对应本项目的 auto 模式缺陷

`RETRIEVAL_FUSION_STRATEGY`，可被请求级 `rag_config.fusion_strategy` 覆盖：

| 策略 | 机制 |
| --- | --- |
| `linear`（默认） | min-max 归一化后 `alpha * vector + (1-alpha) * keyword`；keyword 取 `max(bm25, lexical_db, sparse)` |
| `rrf` | `sum(1/(k + rank_channel))`；分数尺度不可比时用 |
| `budgeted_rrf` | RRF 分 + **每通道 top-k 前缀配额**，前缀内按融合分排序、其余追加 |
| `weighted` | 显式权重 `score = w_vector*vector + w_bm25*bm25 + ...`，权重归一化到和为 1；缺失/非法回退 `linear` |

请求级可覆盖：`fusion_strategy` / `fusion_budgets` / `fusion_min_scores` / `fusion_weights`。

`budgeted_rrf` 默认配额启发式：vector ≈ 50% of `top_k`，剩下 keyword 配额在 bm25 / lexical 间均分，sparse 默认 0（需显式给）。

**设计前提（原文）**：「原始分数跨通道不可比，所以融合必须**显式、确定、可观测**。」

**本项目对照** —— `apps/server/src/generation/placeRetrieval.ts`：

```ts
// force 模式：真融合（rankPlaces 重排合并后的候选）
rankPlaces([...rows, ...hits], ...)
// auto 模式：向量补位，不是融合
[...selected, ...向量新增的].slice(0, limit)
```

auto 模式下向量结果**永远排在字面结果之后**。字面召回数 ≥ `limit`（默认 8）时，向量通道完全进不来 —— 不是没找到，是没给位置。**缺的正是配额。**

## 2. 可观测契约 —— 对应本项目 diagnostics 零消费

每次检索返回 `query_debug.channels.*`，每通道带候选数与 provider 状态。provider capability contract：

- `requested_provider` / `requested_provider_normalized` / `effective_provider`
- `provider_supported` / `model_required` / `model_configured`
- `status`：`ready` | `fallback` | `disabled`
- `reason`：`none` | `provider_invalid` | `splade_model_missing` | `sparse_disabled` | `scope_empty` | `no_candidates` | `index_load_error` | `index_build_failed` | `exception`
- `outcome`：`ok` | `empty` | `skipped` | `error`

调试口诀（原文）：「这些字段足够定位**『召回没进来』还是『进来了但被重排压下去』**。」

**本项目对照**：`RetrievalDiagnostics` 已有 `keywordHits` / `vector` / `vectorHits`，但生产代码零消费（`detailKnowledge.ts`、`researchAddedDays.ts` 只拿 `vector === 'used'` 渲染一句 progress 文案）。**没有 reason 枚举**，所以「向量没生效」的三种原因（没配额 / embedding 失败 / 未配 KEY）无法区分。

## 3. 消融矩阵 + 回归门禁

`scripts/retrieval_ablation.py`：base + 显式 `variants` + `grid`，每个 variant 的 `rag_params` 覆盖 base（flat merge），全部 variant 复用同一组 case_ids。

- 强制 `metrics: []` —— retrieval-only，不依赖 RAGAS/LLM
- **未知 `rag_params` key 被忽略并在日志提示**，避免「以为生效但其实没生效」
- 确定性顺序：`variants` 按文件顺序，`grid` 按 JSON key 顺序展开笛卡尔积（最后一个 key 变化最快）

`scripts/regression_gate.py`：`--metrics ""` 即 retrieval-only gate，指标 Recall / Hit / MRR / NDCG / abstain_rate。阈值文件在仓库内（`ci/answer_quality_thresholds.v1.json`）。run detail 带 `retrieval_config_hash`，用于对比不同检索配置。

**评测成熟度模型**（`docs/guides/evaluation_maturity_model.md`）五条不可谈判原则：

1. Measure before tuning —— 没有可比的 before/after 不合并「质量改进」
2. 会 block merge 的评测必须确定性
3. 产物默认 PII-safe（哈希/计数/脱敏，不含原始 query 与正文）
4. **Slice-first** —— 全局平均会掩盖回归，必须看分片 delta
5. 记录所有被比较对象的版本：dataset / pipeline config / retrieval config / reranker config / judge model / threshold file

成熟度阶梯：L0 手工抽查 → L1 可复现 golden questions → **L2 确定性 retrieval-only CI gate（merge-blocking）** → L3 答案级评测（定时、预算、diff-first）。

**本项目对照**：上一个任务刚建 `eval:retrieval`（L1 水平：可复现、确定性、按 city 分片），但只有单变体（向量恒关），没有 variant 对比，没有配置指纹。

## 4. `lexical_db` 通道：Postgres FTS + pg_trgm

定位（原文）：「catch the kinds of exact-ish queries that vector retrieval often misses」—— 版本号 `v1.2.3`、数字格式 `1,234`、路径 `/api/v1/rag/retrieve`、标识符、精确短语。

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS ix_document_chunks_content_fts_active
  ON document_chunks USING GIN (to_tsvector('simple', content)) WHERE disabled_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_document_chunks_content_trgm_active
  ON document_chunks USING GIN (content gin_trgm_ops) WHERE disabled_at IS NULL;
```

配置：`LEXICAL_DB_ENABLED` / `LEXICAL_DB_TRGM_ENABLED` / `LEXICAL_DB_TRGM_MIN_QUERY_CHARS` / `LEXICAL_DB_FTS_CONFIG` / `LEXICAL_DB_MAX_CANDIDATES`；keyword 模式下还有 `RETRIEVAL_KEYWORD_BM25_SECONDARY_ENABLED` 决定 lexical 与 BM25 的主次。

**本项目对照**：同在 PostgreSQL。字面通道的 SQL 是 `name = ANY($1) OR name LIKE ANY($2)`，`escapeLike` 把 `%` `_` 转义后**完全没有模式匹配能力**（`apps/server/src/__tests__/placeRetrieval.test.ts` 的 `['%'] → []` 用例），只支持精确与前缀。错别字、中段匹配、非前缀部分匹配全部落空。

## 5. 稀疏检索的真相 —— 印证既有结论

- `SPARSE_RETRIEVAL_ENABLED` 默认 `false`；`SPARSE_RETRIEVAL_PROVIDER`：`deterministic` | `splade`
- deterministic provider 靠**人工同义词表**：`SPARSE_RETRIEVAL_SYNONYMS="kubernetes:k8s,postgresql:postgres"`，**映射对称**（两边互相扩展）
- SPLADE provider 必须显式配模型（`SPARSE_SPLADE_MODEL_NAME` 空值会导致初始化失败），默认关闭
- 原文：「sparse 的价值通常体现在**召回**（降低 false negative），而不是直接替代精排」；适用场景为 acronym/缩写、embedding 训练分布外的领域同义词

**对本项目的含义**：同义词表就是别名表。本项目 5181 个地点中仅 267 个（5.2%）有真别名，稀疏通道同样填不上这个洞 —— 与既有结论一致。但它给出一个折中：**查询侧别名扩展**（`enable_query_alias_expansion` / `query_alias_max_queries`），只需维护一份术语映射，不必给每个实体逐个登记别名。

## 6. 明确不适用

| MimirQ 能力 | 不适用的原因 |
| --- | --- |
| 30 个解析后端（MinerU/Docling/DeepDoc/…） | 本项目检索结构化地点实体，无文档解析环节 |
| 86 种切块策略 | 无 chunk 概念，`canonical_places` 是整行实体 |
| GraphRAG / 知识图谱 | `place_relation` 已是轻量同现图，够用 |
| RAGAS / LLM judge / claim verifier | 本项目评测须确定性可回归；judge 会引入不可复现方差 |
| ColBERT / LTR（13 类重排器） | 面向文档 chunk 精排；本项目 `rankPlaces` 是 8 条规则硬编码加权 |
| PII-safe / 多租户 / OIDC / SCIM / ACL 继承 | 单用户产品，无多租户面 |

## 7. 来源

README + `docs/guides/` 下 `retrieval_fusion.md`、`sparse_retrieval.md`、`lexical_fallback.md`、`retrieval_debugging.md`、`retrieval_ablation.md`、`regression_gate.md`、`evaluation_maturity_model.md`。均为只读 `gh api` 获取，未在本地安装其代码。
