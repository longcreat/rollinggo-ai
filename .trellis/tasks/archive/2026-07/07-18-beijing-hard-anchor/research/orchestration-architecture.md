# Research: 行程编排（生成流水线）架构现状

> 来源：2026-07-18 代码侦察。

## 核心结论

编排**不是确定性算法，是 LLM Agent 三阶段流水线**（调研→编排→审校）。POI 分到哪天
完全由规划 Agent 调 `add_activity(dayIndex)` 时自己决定，**全库无任何代码级聚类/
贪心/重排算法**（grep 确认无 reassign/rebalance/splitDay/cluster）。地理与通勤只在
编排**之后**作为校验闸门介入，不参与天分配。

**致命缺陷：分配 dayIndex 时规划 Agent 手上没有坐标**——坐标是编排后 geoPipeline
统一解析的。模型不知道长城距住宿 85km，天分配只靠 prompt 软约束。

## 核心文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/generation/orchestrator.ts` | 唯一入口 `runGeneration`，三阶段编排，plan⇆review 循环 `:178-232` |
| `apps/server/src/generation/prompts.ts` | 三份 system prompt；天分配策略全在 `PLANNER_SYSTEM_PROMPT` 自然语言里（`:42-59`） |
| `apps/server/src/generation/tools/draftTools.ts` | 规划工具：`set_trip_skeleton` / `add_activity(dayIndex)` / `check_feasibility` / `submit_plan` |
| `apps/server/src/generation/tools/reviewTools.ts` | 审校工具：`submit_review`（`:38-54`） |
| `apps/server/src/generation/draft.ts` | `DraftTrip` 内存草稿（唯一可变状态）；`addActivity` `:98`、`updateActivity` `:106-124`、`removeActivity` `:126-131`、`toTrip` `:175-209` |
| `apps/server/src/generation/geoPipeline.ts` | 确定性后处理：`geocodeAll` `:72-111` + `computeLegs` `:113-190` |
| `apps/server/src/generation/legEstimator.ts` | 通勤启发式（AMAP 失败降级） |
| `packages/shared/src/feasibility.ts` | 可行性引擎（纯函数时空模拟器） |
| `packages/shared/src/legs.ts` | 速度模型 + 住宿哨兵（`LODGING_SENTINEL='lodging'` `:6`） |
| `packages/shared/src/schemas.ts` | TypeBox schema 唯一事实源（Trip `:98-116`、Activity `:33-46`、TransitLeg `:60-68`、TripDay `:70-77`、Lodging `:49-55`） |

## 流程分步

1. **调研**（`orchestrator.ts:125-152`）：调研 Agent `search_pois`/`search_web` 写入
   候选池，产出摘要（含"哪些地点相邻、适合同一天"的口头路线建议 `prompts.ts:39`，
   **非结构化、不带距离数字**）。
2. **编排**（`orchestrator.ts:181-199`）：`set_trip_skeleton` 定天主题（`draft.ts:86`）
   → 逐天 `add_activity(dayIndex)`（Agent 无坐标盲排）→ `check_feasibility` 自查 →
   `submit_plan` 闸门（hard 阻断回灌自愈，连续 `MAX_HARD_BLOCKS=3` 次仍 hard 放行，
   `draftTools.ts:134,145-170`）。
3. **地理解析（编排后/审校前，确定性）**：`geocodeAll`（AMAP geocoder GCJ-02，失败降
   Nominatim）→ `computeLegs`（相邻活动对 + 住宿哨兵 leg；<1.5km 走路 `WALK_THRESHOLD_M`，
   AMAP route 优先失败降启发式 `source:'heuristic'`；`geoPipeline.ts:137-190`）→
   `draft.feasibility()` 真实违规报告。
4. **审校**（`orchestrator.ts:205-231`）：审校 Agent 拿代码算的可行性报告
   （`reviewerUserPrompt`，`prompts.ts:108-118`）。`MAX_REVIEW_ROUNDS=2`
   （`orchestrator.ts:48`）→ 规划师实际只有一次修订机会。
5. **降级落库**（`orchestrator.ts:234-252`）：轮次用尽仍 hard → 如实并入
   `reviewNotes`，任务仍 done（生成永不失败原则）。

## 审校 Agent 能力边界（工具缺口）

`orchestrator.ts:211` 现算工具集 = `buildDraftTools(draft)` 过滤掉
`set_trip_skeleton`/`add_activity`/`set_lodging` → 只剩：

| 修改类型 | 能否 |
|---|---|
| 改字段/时间 `update_activity` | ✅ |
| 删活动 `remove_activity` | ✅ |
| 加活动 | ❌（被过滤） |
| 同天重排顺序 | ❌ 无工具 |
| **跨天移动** | ❌ **全库无 move-to-day 工具** |

结构性问题只能写 `revisionRequests` 文字踢回规划师（prompt 明示"不要重建骨架"
`prompts.ts:72`）。规划师自己也只有 add（追加到天末）/remove，重排靠"删了重加"模拟。

**前端手动编辑器有现成范本**：`apps/web/src/store/editorStore.ts:119-131` 的
`moveActivity`（上下移）/`moveActivityToDay`（跨天）——Zustand action，生成侧用不到，
但可作 draft 层实现参考。

## anchor 概念澄清

代码里 "anchor" **仅指住宿锚点**（lodging anchor，通勤锚点非酒店推荐）：
- `LodgingSchema`（`schemas.ts:49-55`）；每天生成 `住宿→首活动`/`末活动→住宿` 哨兵 leg
  （`geoPipeline.ts:161-187`）
- `anchor_missing`（soft）= 住宿有名无坐标（`feasibility.ts:270-280`）

**"远郊 POI anchor"概念在代码里不存在**——无优先级、无标记、无独占日规则。
