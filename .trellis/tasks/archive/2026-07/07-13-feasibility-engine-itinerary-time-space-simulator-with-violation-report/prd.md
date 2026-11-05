# 可行性引擎：行程时空模拟器 + 违规报告

> M0-A 压舱石。定位兑现：从「LLM 判断可行性」转为「代码计算可行性」（LLM proposes, solver disposes）。数据底座已由 07-12 三任务就绪：Activity 全量 GCJ-02 坐标、TripDay.legs（通勤方式/时长/距离）、lodging 锚点 + 'lodging' 哨兵 leg。

## Goal

新增纯代码的行程时空模拟器：输入 DraftTrip/Trip，逐日顺序推演真实时间线，输出结构化违规报告（transit_infeasible / closed_on_arrival / overpacked / backtrack / anchor 缺失）。一个引擎、三处复用：① planner `simulate_day` 工具 + submit_plan 可行性门槛；② reviewer 违规清单弹药；③ 未来评测确定性检查项（本任务只铺引擎，不建评测 harness）。

## What I already know（勘察）

- `generation/draft.ts`：`DraftTrip.validate()` 现只查完整性（标题/天数/空天/活动≤8）；v0.5 注释已声明"坐标由 geoPipeline 统一解析"；`toTrip` 产出含 legs/lodging/transportMode/coordSystem
- `tools/draftTools.ts`：`buildSubmitPlanTool(draft, onPass)` 是提交闸门——`validate()` 通过才 `onPass()+terminate`；工具返回文本供模型自愈（R2 模式）
- `tools/reviewTools.ts`：reviewer 有 `get_budget_status`（已改区间）+ `submit_review`；缺可行性检查工具
- `orchestrator.ts`：编排循环给 planner `[...draftTools, ...geoTools, submitPlanTool]`；geoPipeline 后处理在审校后/落库前——**注意：submit_plan 时坐标/leg 尚未解析**（geoPipeline 在整个编排审校循环之后才跑）
- shared 已有：`haversineMeters`、`TransitLeg`、`lodgingLegsForDay`、`legs.ts`；活动 `startTime/endTime`（HH:mm，可空）
- ResearchPoi 有 `reservation`（required/none/unknown）；活动本身无营业时间字段（营业时间在调研工具文本里，未落活动结构）

## Assumptions (temporary)

- 引擎放 `packages/shared`（纯函数、可被 server 生成期与未来评测/web 复用），无 IO
- 时序推演以活动 startTime 为准；缺时间的活动按"顺序+leg 时长"推算或跳过（待定）
- 营业时间数据当前不在活动结构里 → closed_on_arrival MVP 可能只能基于预约状态或需新增字段（待决策）

## Decision (ADR-lite)

**Context**：可行性引擎依赖坐标/leg，但现状 geoPipeline 在编排审校循环「之后」才解析，与 submit_plan/审校在循环「内」的时序冲突。四个决策点已与用户敲定（2026-07-13）。

1. **嵌入时序 = 前移解析**：geoPipeline 从「审校循环之后」前移到「每轮编排之后、审校之前」。新流程：planner 填写 → geoPipeline 解析坐标/leg → 引擎模拟 → 审校（拿真实违规报告）→ 修订轮重复。引擎全程用真实 leg 数据。代价：修订轮各多跑一次增量解析（24h 缓存 + GEOCODE/ROUTE 任务上限 + 日额度闸门兜底）；orchestrator 循环结构改动较大。
2. **违规分级 = hard 阻断 + 耗尽降级**：hard（transit_infeasible、overpacked 严重超载）阻断 submit_plan，问题清单回灌 planner 自愈；修订轮用尽仍有 hard → 降级为 reviewNotes 如实告知，**任务不失败**（守生成不失败原则）。soft（backtrack、缓冲不足、节奏密）只进审校清单与 reviewNotes，不阻断。
3. **closed_on_arrival 暂缓，预留接口**：本任务实现 transit_infeasible / overpacked / backtrack / anchor 缺失四类（数据齐、能真算准）。营业时间字段不引入（模型编营业时间是幻觉重灾区），但引擎签名预留 `openHours?` 可选参数位，字段引入后零成本启用。
4. **阈值 = 常识默认值**（集中常量，spec 记录，可调）：
   - hard：日活动总时长（活动占用 + 通勤）> 14h；单段通勤时长 > 相邻活动的时间间隔（排不下）。
   - soft：日步行累计 > 15km；日缓冲比 < 10%；日活动数 > 8；折返（同日相邻三点回头角 > 90° 且回跳 > 2km）。

## Requirements

- R1 引擎（`packages/shared/src/feasibility.ts`，纯函数无 IO）：`simulateDay(day, ctx)` + `simulateTrip(trip)` → `FeasibilityReport { dayReports: DayReport[], violations: Violation[] }`；`Violation { code, severity: 'hard'|'soft', dayIndex, activityId?, message, detail? }`；`code ∈ transit_infeasible|overpacked|backtrack|anchor_missing`（枚举含预留 `closed_on_arrival` 但本任务不产出）。
- R2 时序前移：orchestrator 把 geoPipeline 后处理移到每轮编排之后、审校之前；引擎在解析后运行，报告注入审校 userPrompt。
- R3 planner 接入：新增 `check_feasibility` 工具（返回当前草稿违规文本）；`submit_plan` 增可行性门槛——**仅 hard 违规阻断**（回灌问题清单自愈），soft 放行。修订轮用尽仍 hard → reviewNotes 降级，不 throw。
- R4 reviewer 接入：审校 userPrompt 附引擎违规清单；reviewer 依清单判断结构性问题（不再纯语感）。
- R5 阈值集中为具名常量（`FEASIBILITY_THRESHOLDS`），spec 记录来源与调参口径。
- R6 降级：坐标缺失活动的通勤段/折返判定标注「无法判定」跳过，不误报可行也不误报违规；leg 缺失用 haversine 兜底估算并在 detail 标注低置信。

## Acceptance Criteria

- [ ] 纯函数引擎单测：每类违规正例/反例 + 边界（无坐标跳过、无 leg 兜底、空天、单活动天）
- [ ] planner 门槛：构造一个 hard 不可行草稿 → submit_plan 被拒且返回可读问题清单；改好后放行
- [ ] soft 违规不阻断 submit_plan，但出现在审校清单与最终 reviewNotes
- [ ] 时序前移后 verify-c2 全过（含坐标/leg 在审校前已就绪的新断言）；ST1/ST3 单测不回归
- [ ] hard 违规在修订轮用尽后降级为 reviewNotes，任务仍 done（不失败）
- [ ] 三包 typecheck/build 绿

## Definition of Done

- 引擎单测覆盖每类违规；typecheck/build 绿；verify-c2 相关断言更新
- spec 沉淀引擎契约与阈值来源
- 不破坏生成不失败原则：可行性问题是"提示/门槛"，不是"抛错"

## Out of Scope

- 评测 harness / golden set（后续任务，本任务只让引擎"可被评测复用"）
- 对话式修订 agent
- 自动修复行程（引擎只报告，修复交给 LLM 自愈或用户）

## Technical Notes

- geoPipeline 在编排审校循环之后跑，是本任务最大的时序约束——引擎嵌入方案需正面处理
- 折返判定需坐标；transit 时长优先用 leg.durationMin，无 leg 用 haversine 估算
- 现有 R2 自愈模式（工具返回问题文本）是引擎接 planner 的天然范式
