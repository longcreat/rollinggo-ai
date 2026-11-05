# Research: transit_infeasible 全链路 + 通勤估算失真

> 来源：2026-07-18 代码侦察。

## transit_infeasible 生命周期

**定义**：`packages/shared/src/feasibility.ts:12`（`ViolationCode` 第一项），中文标签
"通勤排不下"（`:317`），恒为 hard（全系统仅有的两个 hard 码之一，另一个 `overpacked`）。

**唯一产生点**：`feasibility.ts:155-174`（`simulateDay` 内）：
- 每对相邻活动取通勤 `durationMin`（优先已算 leg，无 leg 且两端有坐标则
  `estimateTransit` haversine 兜底 `:147`）
- `gap = nextStart - prevEnd`；`if (durationMin > gap)` → 违规（`:160`）
- 兜底估算附 `detail: '通勤时长为直线估算，低置信'`（`:171`）
- 降级铁律（`:143-152`）：任一端无坐标且无 leg → 跳过不误报

**消费方（6 处，无任何定向代码路径）**：
1. `describeFeasibility()` 文本渲染（`feasibility.ts:325-336`）
2. 规划师自查 `check_feasibility`（`draftTools.ts:113-127`）
3. 规划师提交门槛 `submit_plan`（`draftTools.ts:145-170`；`MAX_HARD_BLOCKS=3` `:134`）
4. 审校弹药（`orchestrator.ts:212` → `reviewerUserPrompt`）
5. 降级遗留 `feasibilityReviewNotes()`（`feasibility.ts:342-350` ←
   `orchestrator.ts:239-243`）
6. eval 判定（`eval/checks.ts:177-185`）

**无任何 `if (code === 'transit_infeasible')` 分支触发特定动作**——审校 prompt 只笼统说
"硬性问题优先处理"（`prompts.ts:65`），决策全交 LLM 语感。

## 通勤估算：两级数据源

1. **AMAP route 优先**：`computeLegs`（`geoPipeline.ts:113-190`）每对相邻活动先试
   `routeEstimate`（`:143`，transit 模式需起终点 adcode），失败/超额/无 Key 降级。
2. **启发式兜底**（`packages/shared/src/legs.ts:8-31`）：`haversine × 1.4 绕行系数`，
   速度 **transit 20km/h + 10min 开销**、drive 30km/h、走路 4.5km/h（`legs.ts:12-16`）。
   距离 <1.5km 强制走路（`WALK_THRESHOLD_M`）。
   可行性引擎无 leg 时用同一份 `estimateTransit`（`feasibility.ts:5,147`），保证不漂移。

## ⚠️ 关键失真：启发式对城际段高估 2–3 倍

- transit 20km/h 是市内公交速度。八达岭段（60.5km 直线 ×1.4 = 84.7km）算出
  264-267min（4.4h）；真实（S2 市郊铁路/驾车）约 90-120min。
- **beijing 快照 AMAP route 对城际段全部未生效**（Day3 amap leg 占比 0%，全 heuristic）。
  均为北京市域内（延庆区↔市区），理论上 AMAP transit 应支持——根因待实现阶段排查
  （adcode 解析？quota？超时？）。

## 验算：单一路径都不充分（PRD 决策 D1 的依据）

| 路径 | 违规1 (267>180) | 违规2 (68>30) | 违规3 (1164>840) | 结论 |
|---|---|---|---|---|
| 只修估算（城际~45km/h） | ✓ 解除(124min) | ✗ 市内段估算合理 | ✗ 880min 仍超 | 不充分 |
| 只做独占日（不修估算） | ✓ | ✓ | ✗ 264+360+264=888min | 不充分 |
| 估算修正 + 独占日 | ✓ | ✓ | ✓ ≈607min≈10.1h | **可行，有余量带回程顺路点** |

即：**独占日策略在当前速度模型下自己也会踩 overpacked 14h 线**（888 > 840）。
估算修正与编排策略缺一不可。

## 现有"远郊/独占/重排"规则：完全不存在

- grep `独占/远郊/dedicated/reorder/换天/moveActivity`：生成侧零匹配；仅前端手动编辑器
  `apps/web/src/store/editorStore.ts:119-131` 有 `moveActivity`/`moveActivityToDay`。
- `feasibility.ts` 无任何"远郊"距离阈值（只有 WALK_THRESHOLD_M 1.5km 和 backtrack 2km）。
- 修订期若做定向重排，**必须先补 move-to-day 原子能力**（`draft.ts` 加方法 →
  确定性修复器直接调用，或再包成 Agent 工具）。

## 当前终态行为（改造前基线）

检测到 → `submit_plan` 自愈 ≤3 次后放行 → 审校提 revisionRequests（beijing 快照里
审校甚至给出"回程沿途安排晚餐"的正确建议）→ 规划师重试一轮仍排不下 →
hard 降级成 reviewNotes"可行性遗留"文字 → 任务 done，坏行程落库 → eval FAIL。
