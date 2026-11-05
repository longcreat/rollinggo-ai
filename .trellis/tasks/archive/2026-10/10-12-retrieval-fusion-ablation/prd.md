# 检索融合配额与消融评测

## Goal

把 MimirQ 调研中可迁移的三项落地到本项目检索栈：给 `auto` 模式补**通道配额**（让向量结果不再被字面结果挤掉）、让 `RetrieveOptions.onDiagnostics` 变成**可消费的诊断契约**、把上一个任务刚建的 `eval:retrieval` 从单变体升级为**消融矩阵**。目标是让「某路召回有没有价值」这件事可以量化回答，而不是靠推理。

## What I already know

来自上一个任务（`10-11-retrieval-quality-baseline`，已归档）的实测基线：

- 5181 个 active verified 地点，**只有 267 个（5.2%）有真别名**，`payload.aliases` 字段填充率 98.5% 是假指标
- 已登记别名的召回 **Recall@1 = Recall@8 = 100%**（378 条 query，9 城 + 云南 + 残留城市）
- `payload.themes` 覆盖 **30.5%**，`THEMES ?| terms` 与 `rankPlaces` 的 `+45` 对七成地点空转
- 证据覆盖 **85.9%**（4452 / 5181），青岛、苏州为 0%
- 同城同名冲突 0 组

来自代码（`apps/server/src/generation/placeRetrieval.ts`）：

```ts
// force 模式：真融合
rankPlaces([...rows, ...hits], ...)
// auto 模式：向量补位，不是融合
[...selected, ...向量新增的].slice(0, limit)
```

`auto` 是模型调 `search_places` 且不传 `semantic` 时的默认路径。字面召回数 ≥ `limit`（默认 8）时，**向量通道完全进不来**。

来自 MimirQ 调研（详见 `research/mimirq-findings.md`）：

- 融合必须「显式、确定、可观测」；`budgeted_rrf` 为每通道保留 top-k 前缀配额，默认给 vector ≈ 50%
- provider capability contract 用 `status` / `reason` / `outcome` 区分「请求了 vs 实际生效」
- 消融矩阵强制 retrieval-only，未知参数 key 必须**忽略并提示**，避免「以为生效但没生效」
- `lexical_db` 通道 = Postgres FTS + `pg_trgm`，补前缀以外的精确/模糊匹配
- 稀疏通道的 deterministic provider 靠**人工同义词表** → 同义词表即别名表，稀疏检索填不上别名缺口（结论与上一任务一致）

## Open Questions

（已收敛，见 `## Decision (ADR-lite)`）

## Requirements (evolving)

按 MimirQ 调研的优先级分层，最终范围待确认：

**P1 — `auto` 模式配额融合**
- `auto` 分支改为「每通道保留配额」而非「字面优先、向量补位」
- 参考 `budgeted_rrf` 的思路，但**不引入 RRF 公式**：本项目字面通道有 `rankPlaces` 的规则分（0–200+），向量通道是余弦距离，两者不可比也不该强行归一化
- 最小可行方案：向量命中按配额插入结果（保底 N 条），不改变字面命中之间的相对顺序
- 配额需可配置，默认值给出并写进 spec

**P2 — diagnostics 可消费**
- `RetrievalDiagnostics` 增加「向量通道为何没生效」的枚举（如 `vector: 'used' | 'skipped:filled' | 'skipped:disabled' | 'skipped:empty' | 'error'`，具体取值设计时定）
- 生产代码消费它：至少写到结构化日志，供线上排查
- 不改变对外行为（不改进度文案之外的用户可见内容）

**P3 — 评测器消融矩阵**
- `scripts/retrieval-quality-baseline.mts` 支持多变体：同一批 query 跑 `vector:'off'` 与 `'force'`，输出各变体指标与差值
- 报告写入配置指纹（哪些参数生效），避免「以为生效但没生效」
- 未识别的变体参数必须显式报错或提示，不静默忽略
- **必须新增「字面失败子集」。** 现有 378 条 query 在字面层已是 Recall 100%（见 What I already know），在这一集上跑 `off` vs `force` 差值恒为 0，消融矩阵没有信息量。子集必须由字面召回失败的 query 构成，来源与判定如下（已用只读探针验证可行性）。

**P4 — pg_trgm 模糊通道（可选）**
- 新增 GIN `gin_trgm_ops` 索引 + 迁移
- 字面 SQL 增加 `similarity()` / `%` 算子路径，补错别字与中段匹配
- 需评测支持「模糊 query」子集才能验证收益

## Acceptance Criteria (evolving)

- [x] P1：`auto` 模式在字面满 `limit` 时，向量命中仍能进入结果（有测试锁定）——实测发现该场景不会发生（见 Decision），实际落地为「字面一无所获时按距离排序」
- [x] P1：字面命中之间的相对顺序不因改动而变化（有测试锁定）
- [x] P2：`onDiagnostics` 的向量状态区分「未请求 / 请求但空 / 请求失败 / 被配额挤掉」——实际为 `off` / `skipped:filled` / `unavailable` / `used` / `failed`，并新增 `vectorSelected`
- [x] P2：生产代码消费该状态——**消费方是评测报告**（通道统计行），不是结构化日志（见 Decision 5）
- [x] P3：一条命令跑多变体，输出各变体 Recall/MRR 与差值
- [x] P3：报告含配置指纹；未知参数不静默忽略
- [x] P3：**子集 B（字面失败）在 `vector:'off'` 下 Recall 显著低于 `vector:'force'`**——0.0% vs 28.2%
- [x] 全部：`npm run typecheck` 通过
- [x] 全部：`npm run eval:test` 通过（54/54）
- [x] 全部：`npm run eval:retrieval` 可运行且确定性不变（默认模式的 `coverage` 与 `recall` 计数与改动前一致；报告新增 `mrr` 字段与通道统计，仅变体模式才有）

## Definition of Done (team quality bar)

- Tests added/updated (unit/integration where appropriate)
- Lint / typecheck / CI green
- Docs/notes updated if behavior changes
- Rollout/rollback considered if risky

## Decision (ADR-lite)

**Context**：MimirQ 调研产出四档可迁移项（P1 配额融合 / P2 diagnostics 可消费 / P3 消融矩阵 / P4 pg_trgm 通道）。项目已有的诊断字段 `keywordHits` / `vector` / `vectorHits` 采集完整但生产零消费；`auto` 模式的向量结果会被字面结果挤掉。

**Decision**：

1. **本次只做 P1 + P2 + P3，不做 P4。** pg_trgm 需要额外造一批「模糊 query」标注集才能验证收益，验证成本最高；先把配额与度量做扎实，再考虑新通道。
2. **执行顺序 P3 → P1 → P2。** 先有消融能力（P3），才能拿出 P1 改动前后的可比数据；否则配额取多少、值不值得留向量都是盲判。
3. **P1 不引入 RRF 公式。** 本项目的字面通道分数是 `rankPlaces` 规则分（0–200+），向量是余弦距离，两者不可比；强行归一化会制造一个调参黑洞。最小方案是「向量按配额插入」，不动字面命中之间的相对顺序。
4. **P3 必须包含字面失败子集**，否则 `off` vs `force` 差值恒为 0（现有 378 条 query 字面已是 100%）。

5. **P2 不做日志注入。** `detailKnowledge` 走 `force`，永远不会出现 `skipped:filled`；为它引入 logger 注入层成本高、当下无排查需求驱动。新增的 `vectorSelected` 与 `skipped:filled` 由**评测报告的通道统计行**消费（这是真实使用，不是只写不读）。将来若需要线上排查，再按同一字段落日志。

**Consequences**：

- 现有 378 条 query 的 100% 基线不因本次改动而变化，它仍是「已登记别名的可用性」回归门；新增子集才是向量能力的真实测试
- 别名 5.2% / 主题 30.5% 的数据覆盖问题**不在本次范围**，本次只保证「已有的东西用得上、用得对」
- 不设 gate：报告是观测工具，不是合并门禁（与项目既有口径一致）

## Out of Scope (explicit)

- 不引入 SPLADE / ColBERT / LLM judge / cross-encoder 重排（场景不匹配）
- 不做文档解析、切块、GraphRAG（本项目检索结构化地点实体）
- **不补别名与主题数据**（5.2% / 30.5% 是数据覆盖问题，属独立的数据治理任务）
- 不做「查询侧别名扩展」（需要先有术语表；本次先把配额与度量做扎实）
- 不设 CI gate 阈值（本项目知识库不在 CI，且既有口径是新维度先观测）
- 不重写 `rankPlaces` 的规则分体系

## Technical Notes

### 评测子集设计（只读探针已验证可行性）

| 子集 | 来源 | 规模 | 字面预期 | 用途 |
| --- | --- | --- | --- | --- |
| **A 回归门** | `source='goldset'` 主名 + 每个地点的首个真别名 | 378 条 | Recall 100% | 守住「已登记别名仍可用」 |
| **B 字面失败** | `research_evidence.content`（不含其地点名、长度 ≥ 25） | 探针实测：7996 条中 94.7% 不含地点名，约 152 条长度 ≥ 30（p50=16 / p90=24） | 预期 0 命中 | 测向量增量 —— 消融矩阵的唯一信息源 |
| **C 长文本描述**（可选） | `payload.content.intro`（不含主名、长度 ≥ 30） | 探针实测：872 条 | 预期 0 命中 | 扩充 B；intro 为百科体，代表性弱于 B |

子集 B 的真实样本（探针抓取，均为小红书笔记原文）：

- 「20年老店酱香冒菜，牛肉嫩滑，人均45；只卖午市需早去排队。」→ 无名冒菜
- 「海边citywalk起点，沿海步道风景优美，全程约2.5小时」→ 珍珠湾
- 「开放式里巷、宠物友好，蓝调时刻灯光超出片，适合漫步拍照下午茶」→ 亚奥万象天地

⚠️ **方法学限制（必须写进报告）**：子集 B/C 测的是「笔记描述 → 找到地点」，**不是「用户搜索意图 → 找到地点」**。真实用户不会照抄笔记文本，因此子集 B 的召回率既不能当作上界也不能当作下界。它的唯一职责是提供一个「字面必失败、语义可能成功」的可复现对照。

### 其他

- `research_evidence` 表结构：`id / place_id / city / kind / content / source_url / fetched_at / strength / embedding`；`kind` 取值 `xhs_reason`（6994）/ `xhs_warning`（633）/ `xhs_price`（246）/ `xhs_reservation`（123）

- 检索实现：`apps/server/src/generation/placeRetrieval.ts`（`auto` 分支）、`apps/server/src/generation/retrievalRanking.ts`（`rankPlaces`）
- 诊断采集点：`placeRetrieval.ts` 的 `options.onDiagnostics?.(diagnostics)`
- 诊断消费点：`apps/server/src/chat/detailKnowledge.ts`、`apps/server/src/chat/researchAddedDays.ts`
- 上一个任务的产出：`eval/retrievalQuality.ts`（纯函数）、`eval/tests/retrievalQuality.test.ts`、`scripts/retrieval-quality-baseline.mts`、`npm run eval:retrieval`
- 相关 spec：`.trellis/spec/server/backend/rag-guidelines.md`（含新增的 Retrieval Quality Baseline scenario）、`.trellis/spec/server/backend/evaluation.md`
- 调研记录：`research/mimirq-findings.md`
- 无 Python：全部用 TS + `tsx`
