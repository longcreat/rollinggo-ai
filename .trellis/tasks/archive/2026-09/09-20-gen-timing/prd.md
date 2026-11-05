# PRD：生成管线分阶段耗时实测与瓶颈定位

- 任务：`09-20-gen-timing`
- 创建：2026-09-20 / aimer
- 优先级：P2
- 关联：`09-20-llm-context-logging`（已落库 `llm_request_logs` 快照表）

## 背景

用户反馈「行程编排阶段耗时过久」。目前只有阶段级 `durationMs`（`phase_end` 事件）和工具级 `durationMs`（`tool_end` 事件）两个可观测面，但没有任何工具把它们拼成一张「时间去哪了」的表。`generation-guidelines.md` 记录了 09-20 的实测：单个 plan turn 可输出 21k token、耗时约 3.7 分钟，`GENERATION_TIMEOUT_MINUTES` 因此从 10 提到 15 —— 说明瓶颈大概率在 LLM 输出而非外部调用，但缺乏可复现的测量手段。

## 目标（In Scope）

1. **新增只读实测脚本** `apps/server/test-gen-timing.mts`：
   - 真实 LLM 跑一次完整生成（北京 3 天，与 `test-beijing-rag.mts` 同形参）
   - 只用 `subscribe` 事件流，不改进产线代码
2. **输出三层拆分**：
   - 阶段层：每阶段墙钟 + 占比
   - 阶段内：工具占用（区间**并集**，并行工具不重复累加）vs LLM 等待
   - 调用层：单次最慢工具 Top 10、按工具汇总、每个 LLM turn 的耗时/输入输出 token/stopReason
3. **给出瓶颈结论**：编排（plan）阶段耗时里 LLM 等待占比、是否有单轮超长 turn、外部调用是否可忽略

## 非目标（Out of Scope）

- 不做优化改动（本次只测量；优化另开任务）
- 不改 `performance.ts` / 不加新 SSE 事件 / 不写指标上报
- 不写 eval 快照、不进金集（纯观察脚本）

## 验收标准

- [ ] `cd apps/server && npx tsx test-gen-timing.mts` 能跑完整流程并打印三层报告
- [ ] 报告能回答：plan 阶段总耗时、其中 LLM 等待 vs 工具占用、最慢的单个 turn
- [ ] 结论落到本目录 `research/`，含真实数字而非推测
- [ ] `npm run typecheck` 通过

## 风险

| 风险 | 缓解 |
| --- | --- |
| 真实 LLM 调用烧额度/花钱 | 单次运行；用量可从报告的 in/out token 直接读出 |
| 脚本依赖 `rag-test-user` 与 PG 中的已有数据 | 沿用 `test-beijing-rag.mts` 的同一用户与库，失败则改用现有真实 userId |
| 单次测量样本不足，结论可能受上游抖动影响 | 报告记录 `stopReason` 与错误信息；必要时复跑一次对比 |

## 工作量

约 30 分钟（脚本 15 分钟 + 真实运行 5~10 分钟 + 结论 10 分钟）。
