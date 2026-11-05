# PRD：plan 确定性排程层 + 餐宿硬门槛改为偏好驱动

- 任务：`09-21-plan-deterministic-scheduling`
- 创建：2026-09-21 / aimer
- 优先级：P2
- 对标：`D:\Project\study\Yuntu`（确定性核心 + 创造性外围）
- 前置实测：`.trellis/tasks/09-20-gen-timing/research/2026-09-20-phase-timing.md`、`09-20-gen-timing-soft-reasoning-effort/research/2026-09-20-fix-verification.md`

## 目标

1. **餐宿硬门槛改为偏好驱动**：只有偏好含「美食」才要求每天午晚餐；住宿建议不再是流程强制步骤
2. **plan 阶段引入确定性排程层**：由代码决定「哪个地点放哪天、什么顺序、几点到几点」，LLM 退到只写文案

## 为什么

实测（北京 3 天）plan 阶段 597.8s / 432s 全在 LLM，输出 47228 token 而可见文本仅 392 字符；第 1 轮压缩到 314.8s 后，修订轮又单独烧了 370s 把任务撞死在 15 分钟超时上。

结构问题（哪天、顺序、时间）本来就是确定性问题；让 LLM 用几万 token 推理它，既慢又不可复现。Yuntu 的做法是 `WORKFLOW_HARD_TIMEOUT_SECONDS = 180.0`：`route_planning.py`（10063 行）零 LLM 排程，`final_writer.py` 才用 LLM 写文案。

## 已确认的事实（仓库内证据）

### 现状锁点（第 1 项要动的）

| # | 位置 | 内容 |
| --- | --- | --- |
| 1 | `apps/server/src/generation/mealPlanning.ts` → `mealCoverageProblems` → `draft.validate()` | **硬门槛**：缺午/晚餐 → `submit_plan` 直接拒绝 |
| 2 | `apps/server/src/generation/orchestrator.ts:402` | `ensureMealCoverage` 确定性补位（审校后再跑一次） |
| 3 | `prompts.ts` `ACTIVITY_REQUIREMENTS` + `PLANNER_SYSTEM_PROMPT` 第 2 步 | 「每天必须同时包含午餐与晚餐」 |
| 4 | `prompts.ts` `REVIEWER_SYSTEM_PROMPT` 第 3/4 步 | 检查餐次 + 「不得删除某天仅有的午餐或晚餐」 |
| 5 | 测试锁死 | `prompts.test.ts:85`、`scripts/verify-c2.mjs:327`、`scripts/lib/mock-llm.mjs` |
| 6 | `prompts.ts` `PLANNER_SYSTEM_PROMPT` 第 4 步 | `set_lodging` 是流程强制步骤 |

判定条件现成：`PREFERENCE_OPTIONS` 已含 `'美食'`（`packages/shared/src/constants.ts:5`）。Yuntu 的对应实现是 `trip_is_food_focused(req)` + `detect_food_intensity(preferences)` + `enrich_blueprints_with_food`（docstring: "without changing the locked route structure"）。

### 知识库已有的排程素材（`test-kb-shape.mts` 实测）

| 字段 | 覆盖 | 用途 |
| --- | --- | --- |
| `canonical_places.lat/lng` | 1494/1494 | 空间聚类与通勤 |
| `payload.xhsPlaceType` | 1494 | 细粒度类型：attraction 875 / food 265 / photo_spot 121 / other 112 / market 42 / cafe 40 / hotel 39 |
| `canonical_places.category` | 1494 | 8 活动类目：文化 836 / 美食 352 / 自然 177 / 购物 76 / 其他 68 / 住宿 52 / 娱乐 48 / 交通 1 |
| `payload.themes` | 1494 | 每天主题短语的现成素材 |
| `payload.recommendScore` / `mentionCount` / `topReasons` | 1494 | 选点排序与 intro 素材 |
| `payload.typicalVisitMinutes` | **仅 41（北京 32/912 = 3.5%）** | **停留时长 —— 排程最关键输入，覆盖不足** |
| `payload.hours` / `price` / `tips` | 79 / 118 / 221 | 部分可用 |

城市覆盖：北京 912、重庆 618，其余城市 ≤21。

**关键结论**：排程素材基本齐备，唯一缺的是停留时长的覆盖率。Yuntu 有同样的缺口，它的解法是 `build_visit_profile` 的 `basis: 'canonical' | 'type_estimate'` 双轨——有真实值用真实值，否则落 `DWELL_TIME_MINUTES` 类型表。我们照抄这个双轨即可。

## 技术方案（骨架，待确认项见 Open Questions）

### 第 1 部分：餐宿门槛偏好驱动

- 新增 `isFoodFocused(form): boolean`——`form.preferences.includes('美食')`（对齐 Yuntu 的 `trip_is_food_focused`，但只用显式偏好，不做关键词模糊匹配）
- `mealCoverageProblems(days, { foodFocused })`：非美食导向时不检查餐次
- `ensureMealCoverage` 仅在 `foodFocused` 时执行
- prompt：餐次要求包在 `foodFocused ? ... : '（本次非美食导向，不必强排午晚餐）'`
- `set_lodging` 从强制步骤降为可选
- 同步 `prompts.test.ts` / `verify-c2.mjs` / `mock-llm.mjs`

### 第 2 部分：确定性排程层

新增 `apps/server/src/generation/scheduling/`（纯函数优先，便于单测）：

1. **地点事实补全** `placeFacts.ts`：按候选名批量读 `canonical_places.payload` → `<name, { visitMinutes?, placeType?, themes, recommendScore, mentionCount, topReasons }>`
   （候选池 `ResearchPoi` 不携带这些字段，排程前补一次批量查询）
2. **停留时长** `visitMinutes(place)`：`typicalVisitMinutes` 有值用真实值（标 `canonical`）→ 否则 `xhsPlaceType` 类型表 → 否则 8 类目类型表（标 `type_estimate`）
3. **天分配** `assignDays.ts`：
   - 按 `recommendScore + mentionCount` 降序选点；按 `form.preferences` 做类目加权
   - `classifyLongHaulPois` 的【强独占级】地点各自独占一天（复用现有 `longHaul.ts`）
   - 其余景点按空间最近邻聚类到 `form.days` 天，受每日时间预算约束
   - 每天活动数自动伸缩（D5）；不足就少排
4. **日内排序与时间轴** `orderDay.ts`：最近邻排顺 + `visitMinutes` 推 `startTime/endTime`；段间用现有 `estimateLeg` 启发式（零外呼），后续由 `geoPipeline` 的真实 leg 修正
5. **餐次插槽**（仅美食导向）：在 11:00–14:30 / 17:00–21:30 窗口内插就餐片区，定位用片区名而非具体门店
6. **每天主题**：取当天地点 `payload.themes` 的众数，回退到类目名
7. **写入 DraftTrip**：`setSkeleton` + `addActivity`，坐标直接用 `research.locations`（调研阶段旁路捕获的真实坐标，零额外外呼）
8. **文案生成** `describe.ts`：**一次** LLM 调用，输入 = 排好的骨架 + 每个地点的 `intro`/`topReasons`，输出 = `activityId → description`。输出量从万级 token 降到千级

排程后仍走现有 `geoPipeline` + `simulateTrip`（两者本就是确定性）。

### 第 3 部分：审校降为文案审校

- `buildDraftTools(draft, 'description-only')`：只给 `get_draft` + `update_activity`（且只允许改 description）
- 新 `REVIEWER_COPY_SYSTEM_PROMPT`：不再有 `revisionRequests`，不再有结构修订轮
- 保留确定性后处理（`ensureMealCoverage` 仅美食导向、`repairTransitTiming`、`geo_*` 复核）

### 目标流水线

```
research（知识库 RAG，已有）
  → 确定性排程（新，零 LLM）→ DraftTrip 骨架
  → 文案生成（1 次 LLM 调用）
  → geoPipeline（坐标/通勤，已有）
  → simulateTrip 可行性（已有）
  → 文案审校（无结构修订轮）
  → 落库
```

## 已定决策（用户确认）

| # | 议题 | 决定 |
| --- | --- | --- |
| D1 | LLM 在 plan 阶段的角色 | **只写文案**：代码决定哪天/顺序/几点到几点，LLM 一次调用只产出每天主题 + 每个 activity 的 description |
| D2 | 停留时长来源 | **类型表双轨**：`payload.typicalVisitMinutes` 有值用真实值，否则落类目类型表，并在数据里标注来源 |
| D3 | 非美食导向的餐宿 | **完全不排**：不排午晚餐、不强制 `set_lodging`，行程可为纯景点 |
| D4 | 审校阶段 | **只审文案**：只能改 description，取消 `revisionRequests` 结构修订轮 |
| D5 | 候选排不满天数 | **排不满就少排**：每天活动数自动伸缩，不硬凑 |
| D6 | 美食导向的门槛强度 | **算硬门槛**：偏好含「美食」时缺午/晚餐仍拦 `submit_plan` + 跑 `ensureMealCoverage` |

## 落地分期

同一任务内两期，每期可独立回退（靠 git 回滚，不引入运行时开关）：

- **第一期（餐宿偏好驱动）**：独立可测、改动小，是第二期的前置——排程层必须先知道「要不要插餐次」
- **第二期（确定性排程层）**：新增 `generation/scheduling/`，替换 plan agent loop

旧 planner agent 代码在新路径通过金集验证前不删；验证通过后一并清理（不留双路径）。

## 验收标准

### 第一期（餐宿偏好驱动）

- [ ] 非美食导向的生成，行程不含午晚餐也能 `submit_plan` 通过
- [ ] 美食导向的生成，缺午/晚餐仍被拦，且 `ensureMealCoverage` 补位
- [ ] `set_lodging` 不再是流程强制步骤
- [ ] `prompts.test.ts` / `verify-c2.mjs` / `mock-llm.mjs` 同步更新后全绿

### 第二期（确定性排程层）

- [ ] plan 阶段不再有 agent 工具循环；LLM 调用次数 = 1（文案）
- [ ] 排程层单测：天分配、日内排序、时间轴、停留时长双轨、餐次插槽（仅美食）
- [ ] `npx tsx test-gen-timing.mts` 复跑：总墙钟与 plan 阶段显著低于 503.2s（首次修复后基线）
- [ ] `npm run eval` 金集不回归
- [ ] `npm run typecheck` + 单测全绿

## Out of Scope

- 从 xhs 笔记抽「天 + 顺序」当蓝图（不可靠且需改上游）
- 改上游 xhs-travel-pipeline 的抽取 schema
- 营业时间 / 闭馆判定（我们与 Yuntu 的 `closed_on_arrival` 一样都没数据）
- 前端展示改动

## 风险

| 风险 | 缓解 |
| --- | --- |
| 停留时长 96.5% 靠类型表，排程结果可能失真 | 类型表用保守值；`simulateTrip` 仍会算出真实可行性，硬性问题由确定性修复器兜底 |
| 排程质量不如 LLM（用户体感变差） | 保留旧 planner agent 代码不删，可开关回退；先跑金集对比 |
| 破坏既有 174 个单测与 verify-c2/c3 | 餐次相关测试同步改；排程层单独单测覆盖 |
| 城市覆盖不均（北京/重庆之外 ≤21 条） | 候选不足时回退到「LLM 补点」，排程层只负责排不负责选 |

## Technical Notes

- 对标代码：`D:\Project\study\Yuntu\src\agents\route_planning.py`、`composition_blueprint.py`、`route_feasibility.py`（`DWELL_TIME_MINUTES` / `build_visit_profile` / `evaluate_day`）、`accommodation_resolver.py`
- Yuntu 采了但没用的：`pipeline/extract.py` 的 `route_order`（规划阶段从不读取）——我们**不做**这件事
- 现有可复用：`packages/shared/src/feasibility.ts`（`simulateTrip`）、`apps/server/src/generation/longHaul.ts`、`legEstimator.ts`、`geoPipeline.ts`
- 盘点脚本：`apps/server/test-kb-shape.mts`
