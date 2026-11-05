# 评估体系架构设计

> 前置结论：**项目已有一套运行中的评估体系**（`eval/` workspace，9/9 PASS），本设计不重建，只做缺口补齐与规范化。

## 1. 现状盘点

### 1.1 组件与数据流

```
eval/golden/cases.ts ──9 个固定 GenerateForm 用例（多城×天数×出行方式×预算组合）
        │
        ├─ npm run eval       ── 离线：重放 eval/snapshots/*.json ──┐
        └─ npm run eval:live  ── 真实 LLM+高德生成 → 落快照 ────────┤
                                                                  ▼
                                        eval/checks.ts（纯函数，四类指标）
                                                                  ▼
                                        eval/reports/*.json + gate exit code
```

| 组件 | 文件 | 职责 |
|---|---|---|
| harness | `eval/run.ts` | CLI、live/offline 双模、环境隔离（独立 eval.db + 随机 MASTER_KEY） |
| 检查器 | `eval/checks.ts` | 可行性违规 / 结构完整性 / 地理质量门槛 / 预算一致性 |
| 评测集 | `eval/golden/cases.ts` | 9 例，每例带设计意图 note |
| 快照 | `eval/snapshots/*.json` | live 生成结果落盘，离线重放的输入 |
| 报告 | `eval/reports/*.json` | 60+ 份历史报告，含 gate 判定 |

### 1.2 Gate 口径

全部用例同时满足：`hard violation = 0` ∧ 结构问题 = 0 ∧ geo 可信（locatedRatio ≥ 0.8，estimatedRatio ≤ 0.4）∧ 无跳过 → PASS（exit 0）。

### 1.3 已内化的经验教训

- **防空心通过**（07-16）：坐标可信度不达标整体判 FAIL，不允许 0 违规的空行程 PASS
- **环境隔离**（07-16）：库与主密钥无条件覆盖为 eval 专属值；缺 AMAP_KEY fail-loud
- **检查器纯函数化**：与可行性引擎同铁律，离线重放与在线生成共用一份
- **金集复用**：9 城 POI 同时是 RAG 种子（`seed-canonical-places.ts`，`source='goldset'`），`restore-goldset.ts` 可修复误改

## 2. 缺口分析

| 维度 | 现状 | 缺口 |
|---|---|---|
| 最终 Trip 可行性 | ✅ simulateTrip hard/soft | — |
| 最终 Trip 结构 | ✅ schema/天数/时间格式 | — |
| 地理质量 | ✅ 覆盖率/估算率/离群点 | — |
| 预算一致性 | ✅ 偏离度（观测，不卡 gate） | — |
| **研究阶段质量** | ❌ 只查最终 Trip | 候选池真实性、幻觉地点率、来源覆盖不可见 |
| **RAG 检索质量** | ❌ | 检索命中率、检索结果被采用率（09-20 RAG-first 上线后急需） |
| **性能/成本** | ⚠️ gen-timing 任务在测，独立于 eval | 未进报告，无法跨版本对比 |
| **回归对比** | ❌ 有快照有报告，无对比工具 | 换模型/prompt 后只能靠人肉读 JSON |
| **主观质量** | ❌ | 无 LLM-as-judge（信号噪、成本高，默认不做） |
| **CI 集成** | ⚠️ 有 exit code | 未确认是否接入流水线 |

## 3. 目标架构：四层评估

```
L3 线上观测    生产 JobStatus/耗时/token 采样聚合（未来，量级到了再做）
L2 Live 端到端 eval:live ── smoke 3 例（快）/ full 9+N 例（定期）── 快照 schema v2
L1 离线回归    npm run eval（现有）+ 新检查器 ── CI 零成本可跑
L0 纯函数单测  feasibility 等 167 单测（现有）
```

设计原则（沿用现有铁律）：

1. **检查器全部纯函数**，输入快照输出 CaseResult，离线/在线共用
2. **中间产物零侵入采集**：不改为评估改产线代码。`eval:live` 已 `subscribe(job, 0)` 订阅事件流——`candidate` 事件携带候选池 POI，直接在 harness 里收集，无需动 orchestrator
3. **新维度先进报告做观测指标，跑稳后再决定是否进 gate**（防误伤，与预算一致性同款策略）

## 4. 快照 Schema v2（扩容，向后兼容）

```jsonc
{
  "caseId": "...", "generatedAt": 0, "model": "...",
  "form": { }, "trip": { },                    // v1 已有
  "research": {                                // v2 新增：从 SSE 事件流收集
    "candidates": [ /* candidate 事件的 poi 列表 */ ],
    "poolSize": 0, "categoryCounts": { }
  },
  "timing": {                                  // v2 新增：阶段耗时（复用 gen-timing 事件）
    "researchMs": 0, "planMs": 0, "reviewMs": 0, "totalMs": 0
  }
}
```

v1 快照读入时 `research`/`timing` 缺省为空，对应检查器自动跳过（与现有 skip 语义一致）。

## 5. 新检查器设计（按优先级）

### P0 — 研究质量检查器 `checkResearch(trip, candidates)`

> 实现修正（2026-09-21）：候选 POI 不带坐标（高德协议 3.5：只落名称+摘要+链接），池级地理真实性不可查；被采用候选的坐标质量已由 checkGeo 在 Trip 层覆盖。实际落地的指标：

- **采用率**：Trip 活动名命中候选池名称的比例（餐次名按「午餐｜春熙路 · 川菜」→「春熙路」规则提取后匹配，与 geoPipeline 同规则）；过低 = 编排阶段脱离调研成果自编地点
- **类别分布**：pool 中 attraction/food/hotel 数量分布（对应产品候选池三分类）
- **未命中采样**：未命中活动名前 10 个，人肉审查幻觉用
- 观测指标，不进 gate

### P0 — 性能指标入报告

- 从事件流采集：`phase_end` 拿分阶段耗时、`usage` 拿累计 token（末次即全量）、`job_done` 拿总耗时，写入快照 `timing`
- 观测指标，不进 gate（阈值依赖模型与网络，误伤率高）

### P1 — 回归对比工具 `eval/diff.ts`

- `npx tsx eval/diff.ts <reportA> <reportB>`：按 caseId 对齐，输出 hard/soft/geo/timing 逐项增减表
- 报告按 `model` 字段分组对比（快照已带 model）

### P1 — 评测集分层 + 按维度扩例

**数据现状（2026-09-21 实测 Neon 库）**：9 城均有 goldset 种子且向量已全量回填；北京/重庆另有 xhs 社区数据（895/599 条），其余 7 城仅 5~21 条金集种子。research_evidence 向量回填率 42%，但检索只走 `canonical_places.embedding`，evidence 向量不补（架构文档已定性为纯支出）。

**数据稀疏不是缺陷，是测试维度**：给用例打 `dataAvailability: 'rich' | 'sparse'` 标签，断言分两套——

- rich 城市（北京/重庆）：测 RAG-first 主链路，断言检索命中率与被采用率（P0 研究质量检查器提供数据）
- sparse 城市：测降级链正确性，断言检索为空时生成仍成功且 geo 门槛照过（对应 RAG 铁律「Retrieval Is Optional Enrichment, Never a Gate」）

**扩例按维度扩，不按城市均匀膨胀**（live 一例约 5~7 分钟 + API 成本）：

- 城市覆盖维度：9 城 9 例保持现状，够用
- 同城参数维度（当前完全空白）：北京/重庆各加 2 例（不同天数×偏好×预算），测编排稳定性
- 对抗维度（按缺口补 2~3 例，真实生成验证后才入集）：小城市/县城（POI 稀疏，如「潮州 2 日」）、极端参数（1 人 7 天超紧预算）、模糊目的地（「江浙沪周边」）

总量 9 → 15 例左右，配 `layer: 'smoke' | 'full'` 标签：smoke 3 例（shanghai 基线 + beijing 长行程 + chongqing 地形失真）进 CI 快速跑，full 定期跑。可选 `expectIncludes / expectExcludes` 期望锚点断言进结构检查。

### P3 — LLM-as-judge（默认不做）

信号噪、成本高、难复现。触发重评估条件：确定性指标全绿但用户投诉「行程没意思/不合理」成趋势。

## 6. 分期路线

| 期 | 内容 | 验证 |
|---|---|---|
| P0 | 快照 v2 + 研究质量检查器 + timing 入报告 | `eval:live --case shanghai-3d-transit` 产出 v2 快照，离线重放新指标可见 |
| P1 | diff 工具 + 用例分层 + 2~3 个对抗用例 | diff 两份历史报告输出对齐表；`--layer smoke` 只跑 3 例 |
| P2 | CI 接离线 eval（若未接）；报告聚合页 | CI 绿 |
| P3 | （可选）LLM-as-judge | 明确触发条件再做 |

## 7. 明确不做

- 不重建现有 harness/checks/golden（运行良好）
- 不引入外部 eval 框架（promptfoo/deepeval 等）：现有体系 200 行自控代码已覆盖核心，引入框架是净负债
- 不为评估改产线代码路径（采集走事件流旁路）
