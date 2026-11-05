# 检索质量基线：只读探针实测发现

日期：2026-10-11。方法：只读 PostgreSQL 连接（`default_transaction_read_only=on`）+ 真实 `createPlaceRetriever`，`embed` 返回 `null`（向量层全程关闭）。临时脚本用完即删，工作区无残留。

## 1. 字面层真实覆盖面

样本：**5181 个 active verified 地点**（`verified = TRUE AND payload->>'canonicalRedirectTo' IS NULL`）。

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| 有 `payload.aliases` 字段 | 5104 / 5181 = **98.5%** | **假指标**：数组里唯一元素就是主名本身 |
| **有真别名**（存在 `btrim(v) <> btrim(name)` 的元素） | 267 / 5181 = **5.2%** | 真实可召回的别名池 |
| `aliases` 数组长度 > 1 | 265 | 与真别名数接近，两者基本等价 |
| 有 `payload.identity.nameKeys` | 5100 / 5181 = 98.4% | 派生字段，与主名同源 |
| 有 `payload.identity.memberNames` | 5104 | complex 组成名 |
| 有 `payload.themes` | 1582 / 5181 = **30.5%** | 主题召回/加分只对三成地点有效 |
| 有 `payload.xhsPlaceType` | 5122 | — |
| 有 `payload.recommendScore` | 5122 | — |
| 有 `payload.mentionCount` | 5122 | — |
| 有 `payload.content` | 5100 | — |
| 同城同名不同实体 | **0 组** | 身份治理干净，点名无歧义 |

**关键纠正**：不能把「有 `aliases` 字段」当成「别名覆盖率高」。实测抽查 5 个北京地点，`aliases.filter(a => a !== name)` 全部为空——字段填了主名自己，等于没有别名。

## 2. 字面层召回（真别名抽样）

方法：从「有真别名」的地点按城市随机抽 25 个，取一个非主名别名作 query，`retrieve([alias], { city, vector: 'off', limit: 8 })`，命中判定 `canonicalPlaceId(h) === canonicalPlaceId(target) || h.ids.includes(target.id)`。

| 城市 | Recall@1 | Recall@8 |
| --- | --- | --- |
| 北京 | 25/25 | 25/25 |
| 广州 | 23/23 | 23/23 |
| 杭州 | 19/19 | 19/19 |
| 厦门 | 25/25 | 25/25 |
| 重庆 | 25/25 | 25/25 |
| 西安 | 14/14 | 14/14 |
| 成都 | 18/18 | 18/18 |
| 上海 | 15/15 | 15/15 |
| 济南 | 25/25 | 25/25 |
| **合计** | **100.0%** (189) | **100.0%** (189) |

**结论**：只要别名登记了，SQL + `rankPlaces`（精确命中 +200）就能完美召回、稳排第 1 位。`Recall@1 == Recall@8` 说明命中即第一，不存在「召回了但排位差」。

⚠️ **一次测量陷阱（勿重蹈）**：首次统计时把「没有真别名」的样本也算进分母，而这类样本在循环里被 `continue` 跳过、永不累加命中，得出假的 `Recall@8 = 8%`。**分母必须是实际参与检索的样本数**，不能是抽样行数。

## 3. 证据覆盖（两跳的第二跳）

`withEvidence` 对每个入选地点查 `research_evidence`（LATERAL LIMIT 3）。覆盖情况：

| 城市 | 地点数 | 有证据 | 覆盖率 |
| --- | --- | --- | --- |
| 北京 | 1291 | 1172 | 90.8% |
| 广州 | 687 | 607 | 88.4% |
| 杭州 | 647 | 566 | 87.5% |
| 厦门 | 612 | 506 | 82.7% |
| 重庆 | 577 | 446 | 77.3% |
| 西安 | 395 | 346 | 87.6% |
| 成都 | 358 | 299 | 83.5% |
| 上海 | 229 | 216 | 94.3% |
| 济南 | 217 | 175 | 80.6% |
| 云南 | 130 | 119 | 91.5% |
| **青岛** | 21 | 0 | **0%** |
| **苏州** | 9 | 0 | **0%** |

青岛、苏州检索得到地点名，但一条证据都取不到——`withEvidence` 空手返回，模型只拿到一个名字。与 `eval/README.md` 的记录一致（「苏州、西安、青岛在源库中仍只有金集地点、没有研究证据」；西安现已补齐）。

## 4. 观察到的卫生问题（非本任务引入）

应用库中有 8 行随机城市名的测试残留：

- `金集恢复-2acccace-…`（2 行）、`金集恢复-9015a1d1-…`（2 行）
- `金集并发-78e9b07f-…`、`金集并发-434f4483-…`（各 1 行）
- `金集新增-31fa1b78-…`、`金集新增-59649ce1-…`（各 1 行）

探针为只读连接，未修改任何数据。可参考 `.trellis/spec/guides/workspace-cleanup.md`。

## 5. 现有评测设施盘点（避免重复造）

| 设施 | 路径 | 现状 |
| --- | --- | --- |
| 只读检索探针 | `scripts/benchmark-place-retrieval.mts` | 已存在：只读连接、不导入 `db/client`、`embed` 返回 null、只 `console.log`，**无断言** |
| 离线 harness | `eval/run.ts` + `checks.ts` | 只检查历史最终 `Trip`，**不执行检索** |
| 运行隔离 | `eval/isolation.ts` | 随机 `tripweaver_eval_<24hex>` 库 + 独立 `EVAL_PG_ADMIN_URL` |
| 知识冻结 | `eval/frozenKnowledge.ts` + `eval:knowledge:export/verify` | frozen 快照含真实向量，可作固定输入 |
| 版本比较 | `eval/diff.ts` + `eval:compare.ts` | 按 caseId 对齐；输入/检查器/知识 hash 变化 → 不可比 |
| 覆盖统计 | `eval/placeCoverage.ts` | 只统计「提交候选/最终行程中可识别的地点」，**明确不是检索召回轨迹** |
| 诊断采集 | `placeRetrieval.ts` 的 `onDiagnostics` | `keywordHits` / `vector` / `vectorHits` 已采集；生产仅用于 progress 文案，**hit 计数无人消费** |

`eval/README.md` 与 `.trellis/spec/server/backend/evaluation.md` 都明确写了：候选采用率 **不是**地点准确率，覆盖统计 **不是**召回轨迹，`benchmark-place-retrieval.mts` 的向量请求 **不能**当作完整 RAG 延迟。

## 6. 直接结论

- 字面层的瓶颈**不是召不准，是没人可召**：94.8% 的地点只认主名全串或前缀。
- 主题标签覆盖 30.5%，`THEMES ?| terms` 与 `rankPlaces` 的 `+45` 对七成地点空转。
- 稀疏检索（BM25/tsvector）**解决不了这个洞**：BM25 同样只匹配库里已有的词，缺的是同义表达本身。补别名的收益确定且可量化。
- 「检索质量」目前不可度量，因为诊断数据采集了但无消费方，也没有任何标注集或断言。
