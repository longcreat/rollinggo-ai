# 建立评估体系：技术架构分析与评测集

## Goal

在盘点现有 eval 体系的基础上，完成整体评估架构设计，并扩充/规范评测集（golden set），使生成质量可度量、可回归、可对比。

## What I already know（仓库盘点结论）

### 现有评估体系（已存在，`eval/` workspace，`@tripweaver/eval`）

- **入口**：`eval/run.ts`（CLI harness）
  - `npm run eval`：离线重放 `eval/snapshots/*.json` → 确定性检查 → 报告（零成本，可进 CI）
  - `npm run eval:live`：真实 LLM + 高德全流程生成（直调 `runGeneration`，不经 HTTP），落快照后检查；`--case <id>` 单例；`--allow-no-geo` 显式降级
- **检查器**：`eval/checks.ts`（纯函数无 IO，与可行性引擎同铁律），四类指标：
  1. 可行性违规（门槛）：复用 `simulateTrip`（shared/feasibility.ts），hard/soft violation
  2. 结构完整性（门槛）：TripSchema 校验、天数匹配、空天、活动数上限、时间格式
  3. 地理质量（可信度门槛）：locatedRatio ≥ 0.8、estimatedRatio ≤ 0.4、>100km 离群点检测（防"空心通过"事故）
  4. 预算一致性（观测指标）：表单人均日预算 vs summary 区间偏离度
- **评测集**：`eval/golden/cases.ts` 9 个固定 GenerateForm 用例（多城 × 天数 × 出行方式 × 预算/住宿组合，每个带设计意图 note）；9 份快照 `eval/snapshots/`
- **门槛口径**：全部用例 hard=0 且结构=0 且 geo 可信且无跳过 → gate PASS（exit code）
- **隔离铁律**（07-16 教训）：独立 `eval/data/eval.db` + 一次性 MASTER_KEY 无条件覆盖，绝不触碰开发库；缺 AMAP_KEY fail-loud
- **复用**：金集 9 城 POI 同时作为 RAG 种子（`seed-canonical-places.ts`，`source='goldset'`）；`restore-goldset.ts` 可修复被社区库导入误改的金集记录
- **报告**：`eval/reports/*.json`（60+ 份历史报告）

### 现有体系未覆盖（缺口）

- 研究阶段质量：POI 真实性/幻觉率、证据覆盖、来源可信度（只查最终 Trip，不查中间产物）
- RAG 检索质量：召回命中率、检索结果是否被采用、RAG-first 降级链效果（09-20-research-rag-first 在做）
- 主观质量：行程合理性、多样性、文案质量（无 LLM-as-judge）
- 性能/成本：分阶段耗时、token 消耗（09-20-gen-timing 在测，未纳入 eval gate）
- 回归对比：快照 diff、跨模型/跨版本对比工具（有快照无对比工具）
- CI 集成：门槛有 exit code，但是否接入 CI 待确认

### 相关技术架构事实

- 生成管线：三阶段 Agent（调研 → 编排 → 审校）+ 纯代码可行性引擎（LLM proposes, solver disposes）
- 可行性引擎在 shared 包，IO-free，server/eval/web 三端复用（spec: generation-guidelines.md）
- RAG：pgvector + canonical_place + research_evidence，四级静默降级链（TECHNICAL_ARCHITECTURE.md §4）
- 进行中任务：09-20-gen-timing（耗时实测）、09-20-gen-timing-soft-reasoning-effort（优化）、09-20-research-rag-first（RAG 优先）

## Assumptions (temporary)

- 用户要的是"盘点 → 架构设计 → 评测集扩充"的完整链路，而非推翻现有 eval 重写
- 评测集扩充与架构设计在同一任务内交付

## Open Questions

- ~~交付物形态~~ → 用户略过问卷，按默认推荐执行：设计文档先行（已产出，见下）
- 待确认：新维度优先级（默认 P0 研究质量+性能入报告，P1 回归diff+分层，P3 不做 LLM-judge）
- 待确认：CI 接入现状（有 exit code，未确认是否已在流水线）

## Requirements (evolving)

- 输出现有评估体系盘点结论 ✅（设计文档 §1）
- 输出整体评估架构设计 ✅（设计文档 §2-§6）
- 评测集扩充/规范化（设计：§5 分层+对抗用例+期望锚点，实现待确认后动手）

## Acceptance Criteria (evolving)

- [x] 现有评估体系盘点完成
- [x] 整体架构设计文档产出：`research/eval-architecture-design.md`
- [x] 用户确认设计方向与优先级（2026-09-21「开始」）
- [x] P0 实现：快照 v2 + 研究质量检查器 + timing 入报告（typecheck ✅ / 离线 9/9 ✅ / 冒烟 ✅）
- [ ] P0 实证：eval:live 单例产出 v2 快照（需真实 Key，待用户批准）
- [ ] P1：diff 工具 + 用例分层 + 对抗用例

## Out of Scope (explicit)

- 推翻重写现有 eval harness（现有体系运行良好，9/9 PASS）

## Technical Notes

- `eval/run.ts`、`eval/checks.ts`、`eval/golden/cases.ts`、`eval/snapshots/`
- `docs/TECHNICAL_ARCHITECTURE.md` §4（RAG）、§5（多 Agent）
- `.trellis/spec/server/backend/generation-guidelines.md`（可行性引擎契约、eval 门槛口径）
- `.trellis/spec/server/backend/rag-guidelines.md`（金集与 RAG 种子的关系）
