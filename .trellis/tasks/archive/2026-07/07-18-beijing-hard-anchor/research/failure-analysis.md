# Research: beijing hard 失败点精确定位（已离线复现）

> 来源：2026-07-18 代码侦察。复现命令：`npm run eval -- --case beijing-5d-family`

## 核心事实

**"beijing hard ×3" = 单条 case `beijing-5d-family` 的 3 个 hard violation，全部集中在
第 3 天（八达岭长城日）。** 不是 3 条 case。

## Eval harness 组件

| 组件 | 路径 |
|---|---|
| CLI 入口 | `eval/run.ts` |
| 确定性检查（纯函数） | `eval/checks.ts` |
| 金集用例（9 条 GenerateForm） | `eval/golden/cases.ts` |
| keyed live 快照 | `eval/snapshots/<caseId>.json` |
| 报告（gitignored） | `eval/reports/<ts>.json`，最新全量 = `2026-07-17T01-27-36-632Z.json` |

- 离线重放（零成本）：`npm run eval`；单例 `npm run eval -- --case beijing-5d-family`
- live 重生成：`npm run eval:live`（需 SITE_LLM_* + AMAP_KEY，强制独立 eval.db +
  一次性 MASTER_KEY，`eval/run.ts:40-41`）
- 门槛：`pass = hardViolations=0 && structural=0 && geoGate=0`（`eval/run.ts:138`、
  `eval/checks.ts:185`）
- geo gate 阈值：locatedRatio≥0.8、estimatedRatio≤0.4（`eval/checks.ts:134-137`）

## case 输入（`eval/golden/cases.ts:19-23`）

```
destination:北京, days:5, budgetLevel:舒适, preferences:[文化,亲子], partySize:3,
transportMode:transit, totalBudget:8000, lodging:未指定, startDate:''
```

生成器自选住宿锚点 = 前门-崇文门区域（39.897, 116.398）。快照产自 model
`deepseek-v4-flash`（2026-07-17 live）。

## Day 3 时间线（快照 `eval/snapshots/beijing-5d-family.json:300-390`）

标题"长城豪情·八达岭全天"：
- 八达岭长城 09:00–15:00（40.356, 116.017）
- 南来顺饭庄 18:00–19:30（39.871, 116.354）
- 鸟巢·水立方夜景 20:00–21:00（39.993, 116.390）

4 条 leg 全为 `source:"heuristic"`（该 case 整体 amapLegRatio 仅 33%，Day3 为 0）：
- lodging→长城 264min / 84.7km
- 长城→南来顺 267min / 85.6km
- 南来顺→鸟巢 68min / 19.5km
- 鸟巢→lodging 55min / 14.9km

## 3 个失败断言（期望 vs 实际）

全部 severity=hard、dayIndex=3（报告 `eval/reports/2026-07-17T01-27-36-632Z.json:66-87`）：

1. **`transit_infeasible`**：长城→南来顺通勤 267min > gap 180min（15:00→18:00），超 87min。
   断言逻辑 `packages/shared/src/feasibility.ts:155-174`（`durationMin > gap` 即违规）。
2. **`transit_infeasible`**：南来顺→鸟巢通勤 68min > gap 30min（19:30→20:00），超 38min。
3. **`overpacked` hard**：全天 1164min > 840min（`hardDayTotalMin=14*60`，
   `feasibility.ts:31,202-212`）。构成：活动 510min + 通勤 654min（264+267+68+55，
   住宿 leg 计入总时长 `feasibility.ts:177-187`）。

geo gate / structural / budget 全绿（located=100%、estimated=0%）——纯可行性 hard violation。

## 引擎细节（易踩坑）

- 267/68min 来自共享启发式（AMAP route 失败降级）：`estimateTransit`
  （`packages/shared/src/legs.ts:22-31`）= haversine×1.4 ÷ transit 20km/h + 10min。
- 早上 lodging→长城 264min 只计入 overpacked 总时长，**不触发** transit_infeasible
  （该检查只扫相邻活动对，`feasibility.ts:131`）。
- 违规 2 与估算精度无关（市内段估算合理）；违规 3 即便真实通勤也压不回 14h 线
  （不改编排的话）。

## 对照组（关键旁证）

`xian-2d-culture`（兵马俑远郊，`cases.ts:31` note 同样点名远郊）能 PASS →
**远郊本身无罪，罪在"远郊日再塞市区晚餐+夜景"的编排组合**。

## 违规为何存活到快照（修订链路）

1. planner `submit_plan` 硬门槛自愈上限 `MAX_HARD_BLOCKS=3`
   （`apps/server/src/generation/tools/draftTools.ts:134`），3 次挡回仍 hard 就放行；
2. 审校 ≤2 轮 `MAX_REVIEW_ROUNDS=2`（`apps/server/src/generation/orchestrator.ts:48`）；
   reviewer **发现了问题**且建议方向正确（快照 `trip.meta.reviewNotes[1]`："请重新设计
   第3天行程，建议八达岭结束后在回程沿途（如清河/奥林匹克区域）安排晚餐"），但纯靠
   LLM 文字转述回炉，两轮未修好；
3. 轮次用尽按"生成不失败"原则降级：`feasibilityReviewNotes`（`feasibility.ts:342-350`）
   把 hard 原样写进 `trip.meta.reviewNotes` 交付。
