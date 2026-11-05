# beijing hard: 远郊 anchor 日编排与修订策略

## Goal

金集 eval 当前 8/9 PASS，唯一钉子户是 beijing hard ×3。卡点为"远郊 anchor 日"的编排：
含远郊 anchor（如离市中心很远的必去 POI）的行程日，现有编排/修订策略无法产出可通过
门槛的结果。本任务目标：设计并落地针对远郊 anchor 日的编排/修订策略，使金集 hard=0
清零（9/9 PASS），为 M0-C 公网部署解除阻塞。

## What I already know

* M0-B eval harness 已落地（commit 9f807e0），含 trustworthy geo gate。
* 首批 keyed live golden 快照已提交（commit 756ee7b）：9 条 case，8 PASS。
* 上会话路线图给出的两个候选策略方向：
  1. 远郊日独占 —— 编排时让远郊 anchor 独占一天（或严格限制同日搭配）；
  2. 审校对 `transit_infeasible` 的定向重排 —— 修订环节检测到通勤不可行时，
     针对性把冲突 POI 换天/重排。
* 项目定位：可信规划器（开源/BYOK/中立/抗幻觉），编排质量是核心卖点。
* 环境约束：系统代理接管、Nominatim 直连死路（geo 数据来源受限）、无 Docker。

### 侦察结论 ①：失败点精确定位（已复现）

* **"beijing hard ×3" = 单条 case `beijing-5d-family` 的 3 个 hard violation，
  全部集中在第 3 天（八达岭长城日）**（`eval/golden/cases.ts:19-23`，
  报告 `eval/reports/2026-07-17T01-27-36-632Z.json:66-87`）。
* Day 3 时间线（快照 `eval/snapshots/beijing-5d-family.json:300-390`）：
  八达岭 09:00–15:00 →（85.6km 回市区）南来顺饭庄 18:00–19:30 →
  鸟巢夜景 20:00–21:00。
* 违规 1 `transit_infeasible`：长城→南来顺 267min > gap 180min（超 87min）。
* 违规 2 `transit_infeasible`：南来顺→鸟巢 68min > gap 30min（超 38min）。
* 违规 3 `overpacked` hard：全天 1164min > 840min 上限
  （活动 510min + 通勤 654min；`feasibility.ts:202-212`，阈值 `hardDayTotalMin=14*60`）。
* 通勤来源：4 条 leg 全部 `source:"heuristic"`（AMAP route 失败降级），
  估算 = haversine×1.4 ÷ 20km/h + 10min（`packages/shared/src/legs.ts:22-31`）。
  但违规 2/3 与估算精度无关，真实公交也救不回来。
* geo gate / structural / budget 全绿——纯粹是可行性引擎 hard violation。
* 复现方式：`npm run eval -- --case beijing-5d-family`（离线重放，零成本）。
* **对照组**：`xian-2d-culture` 兵马俑同为远郊 anchor 却 PASS →
  远郊本身无罪，罪在"远郊日再塞市区晚餐+夜景"的编排组合。

### 侦察结论 ②：修订链路现状（违规为何存活到交付）

* 代码里**没有"远郊 anchor"一等概念**；"anchor" 仅指住宿锚点
  （`LODGing_SENTINEL`，`packages/shared/src/legs.ts:6`）。无任何远郊/独占日编排规则。
* planner `submit_plan` 硬门槛自愈上限 `MAX_HARD_BLOCKS=3`
  （`apps/server/src/generation/tools/draftTools.ts:134`），3 次挡回仍有 hard 就放行。
* 审校 `MAX_REVIEW_ROUNDS=2`（`apps/server/src/generation/orchestrator.ts:48`）。
  reviewer **确实发现了问题**且 revisionRequest 方向正确
  （"八达岭结束后在回程沿途（清河/奥体）安排晚餐"，快照 reviewNotes[1]），
  但修订只靠 LLM 文字转述回炉，两轮均未修好。
* 轮次用尽后按"生成不失败"原则降级交付，hard violation 原样写入
  `trip.meta.reviewNotes`（`feasibility.ts:342-350`）。
* **结论：修订环节对 `transit_infeasible` 无代码级定向策略（换天/独占/沿途替换），
  纯靠 LLM 自觉，而 LLM 两轮都没自觉。**

### 侦察结论 ③：编排逻辑现状（问题的架构根源）

* **编排不是确定性算法，是 LLM Agent 三阶段流水线**：调研 → 编排 → 审校（≤2 轮），
  入口 `runGeneration`（`apps/server/src/generation/orchestrator.ts:178-232`）。
* POI 分到哪天 = 规划 Agent 调 `add_activity(dayIndex)` 时自己决定
  （`draftTools.ts:42-56` → `draft.ts:98`）。**全库无任何代码级聚类/贪心/重排算法**
  （grep 确认无 reassign/rebalance/splitDay/cluster）。
* **致命缺陷：分配 dayIndex 时 Agent 手上没有坐标**——坐标是编排后 geoPipeline
  （`geoPipeline.ts:72,113`）才统一解析的。模型不知道长城距住宿 85km，
  天分配只靠 prompt 软约束（"相邻活动顺路"、"单日≤14h"，`prompts.ts:59`）。
* 地理/通勤只在**事后**作为校验闸门介入（feasibility 引擎），不参与天分配。
* **审校 Agent 工具缺口：只有 `update_activity`/`remove_activity` 就地小改
  （`reviewTools.ts:38-54`），没有"把活动挪到另一天"的工具**；结构性问题只能写
  revisionRequest 文字交回规划师全量重做，不可控。
* 天主题骨架由 `set_trip_skeleton` 定（`draft.ts:86`）；调研摘要里有"哪些地点相邻、
  适合同一天"的口头路线建议（`prompts.ts:39`），但非结构化、不带距离数字。
* 产出结构：`Trip → days[] → activities[] + legs[]`（`schemas.ts:98-116`），
  leg 含 `source('amap'|'heuristic')`。

### 侦察结论 ④：transit 估算失真是独立阻塞变量（关键！）

* `transit_infeasible` 全链路：定义 `feasibility.ts:12`，唯一产生点
  `feasibility.ts:155-174`（`durationMin > gap` 即违规），消费方 6 处
  （规划师自查/提交门槛/审校弹药/降级遗留/eval 判定），**无任何
  `if (code === 'transit_infeasible')` 定向代码路径**，全靠 LLM 读文本。
* 通勤两级数据源：AMAP route 优先，失败降级启发式
  （`geoPipeline.ts:113-190`、`legs.ts:8-31`）。
* **启发式对城际段高估 2–3 倍**：transit = haversine×1.4 ÷ 20km/h + 10min
  （市内公交速度）。八达岭段算出 264-267min，真实（S2 线/驾车）约 90-120min。
* **beijing 快照 AMAP route 对城际段全部未生效**（amap leg 占比 0%，全 heuristic），
  原因待查（adcode？quota？均为北京市域内，理论上 AMAP transit 应支持）。
* 生成侧**无 reorder / move-to-day 原子工具**（grep 确认）；前端手动编辑器有
  `moveActivity`/`moveActivityToDay`（`apps/web/src/store/editorStore.ts:119-131`）
  可作 draft 层实现范本。

### 验算：三条单一路径的账（结论：估算修正必做但不充分）

| 路径 | 违规1 (267>180) | 违规2 (68>30) | 违规3 (1164>840) | 结论 |
|---|---|---|---|---|
| 只修估算（城际~45km/h） | ✓ 解除（124min） | ✗ 仍在（市内段估算合理） | ✗ 880min 仍超 | 不充分 |
| 只做独占日（不修估算） | ✓（无市区段） | ✓ | ✗ 264+360+264=888min | 不充分 |
| 估算修正 + 独占日 | ✓ | ✓ | ✓ 123+360+124≈607min≈10.1h | **可行，且有余量带回程顺路点** |



## Decision (ADR-lite)

### D1：策略组合 = 方案 A 双保险（已定，2026-07-18）

**Context**：验算证明估算修正必做但不充分（见验算表），编排/修订策略必须至少选一层；
live eval 重生成定胜负，LLM 行为有方差。
**Decision**：估算修正（地基）+ 编排期预防（候选池距离预计算 → 结构化情报注入规划
prompt + 远郊独占日规则）+ 修订期确定性兜底（transit_infeasible/overpacked 触发
代码级换天重排，重跑验证，更差则回滚）。三层皆城市无关。
**Consequences**：工作量最大但可分层落地；每层独立有价值（估算修正惠及全部 case，
预防层提升产出质量，兜底层保 eval 稳定）；确定性修复器是新增组件，需设计保守的
重排规则避免"修出更烂的行程"。

### D2：远郊判定基准 = 估算单程通勤时长（已定，2026-07-18）

**Context**：距离预计算阶段只有坐标（haversine），判定信号可选直线距离或估算时长。
**Decision**：用修正后速度模型的估算单程通勤时长判定（如 ≥60min 标记"长途点"、
≥90min 触发强独占日规则；阈值实现时用金集 9 case 校准——兵马俑/杭州郊区须正确分类）。
**Consequences**："远"的本质是通勤久，天然自适应 transportMode（drive 40km 不远、
transit 40km 远）；与速度模型耦合，模型修正须先行。

### D3：MVP 边界 = 最小+防御（已定，2026-07-18）

**Context**：发散检查了多远郊点、前端可见性两个相邻场景。
**Decision**：核心针对 beijing 模式（单远郊 anchor 与市区混排）；多远郊点仅防御性
处理（不专门优化，保证不崩溃、不死循环，修不好回滚降级）；前端 UI 不动。
**Consequences**：金集无多远郊 case，做了也无法验证；前端"长途日标记"留给后续任务。

### D4：快照更新策略 = 先验证后全量（已定，2026-07-18）

**Context**：速度模型一改，全部 case 的 heuristic leg 都变；离线重放只能部分验证
（快照已存 leg 用存量 durationMin，仅无 leg 段走新估算兜底，`feasibility.ts:147`）。
**Decision**：第一步只 live 重生成 beijing 验证策略生效；绿了之后全量 9 case live
重生成作为新提交基线。
**Consequences**：金集内部一致（全部 leg 同一速度模型产物）；成本可控（策略有问题
时只烧 1 case 的量）。

## Technical Approach

三层改造（均城市无关、无特判）：

**层 1 地基：通勤估算修正**（`packages/shared/src/legs.ts`）
* 分段速度模型：长距离段（城际/市郊）用更高等效速度（~40-45km/h，模拟 S2/市郊
  铁路/快速路），市内段维持 20km/h；分段点与速度值实现时用金集校准。
* 排查 AMAP route 城际段未生效根因（`geoPipeline.ts:143` routeEstimate，
  adcode/quota/超时），能修则修——真实路由永远好过启发式。

**层 2 预防：编排期距离情报 + 独占日规则**（`apps/server/src/generation/`）
* 编排前新增确定性距离预计算：候选池 POI × 住宿锚点的估算通勤时长，按 D2 阈值
  标记长途点。
* 结构化情报注入规划 prompt（"八达岭：距住宿约 2h，长途点，独占一天或仅搭配回程
  沿途活动"）+ prompt 硬规则。

**层 3 兜底：确定性修复器**（geoPipeline 后、审校前）
* 触发：feasibility 报告含 transit_infeasible 或 overpacked。
* 动作：识别"远郊日混排"模式（某天含长途点 + 非顺路市区活动）→ 市区活动挪到
  负载最轻的天（draft 层新增 move-to-day 原子方法，参考前端
  `editorStore.ts:119-131`）→ 重跑 legs+feasibility 验证 → hard 减少则采纳，
  否则回滚交审校 LLM。
* 保守原则：只挪不删、只处理明确模式、验证不过就回滚——绝不"修出更烂的行程"。

## Open Questions

（全部已决——见 Decision D1-D4；实现期待办：城际速度分段点校准、AMAP route
城际未生效根因排查。）

## Requirements (final)

* R1 估算修正：transit 启发式引入分段速度模型，城际段不再按 20km/h 市内速度高估；
  排查并尽量修复 AMAP route 城际段未生效问题。
* R2 编排预防：编排前对候选池做确定性距离预计算，长途点（D2 阈值）以结构化情报
  注入规划 prompt，并附独占日硬规则。
* R3 修订兜底：新增确定性修复器（geoPipeline 后、审校前），对 transit_infeasible/
  overpacked 的"远郊日混排"模式做代码级换天重排，验证不过回滚。
* R4 泛化：三层全部城市无关，代码中无城市名/POI 名特判；阈值经金集 9 case 校准。
* R5 验证：先 live 重生成 beijing 验证，后全量 9 case 重生成为新基线（D4）。

## Acceptance Criteria (final)

* [x] `npm run eval`（离线重放，新基线快照）9/9 PASS，beijing hard=0
* [x] beijing Day3 类结构（远郊 anchor 日）不再出现"远郊+市区晚餐+夜景"混排
  （live 实测：Day3 = 八达岭独占 + 前门住宿区晚餐；修复器挪走 2 个混排活动）
* [x] 其余 8 条 case 无回归（7 城 live 重生成全 PASS；chongqing 保留 07-17 旧快照，
  重放 PASS，见下"遗留"）
* [x] 代码中无城市名/景点名特判（策略为通用规则；终检 grep 复核）
* [x] 确定性修复器有单测：模式识别、换天、验证回滚三条路径（18 条 + 金标固化）
* [x] 速度模型改动有单测：市内段/城际段各自的估算值断言（11 条）

## 实施结果（2026-07-18 收口）

**三层主体**（各自经 trellis-check 质检通过）：
* 层 1 估算修正：`LEG_SPEED_MODEL` 分段速度模型（分段点 20km；transit 长途 45km/h、
  drive 长途 70km/h；≤20km 与旧公式逐字节一致）。八达岭段 264→156min。
  附带修复 AMAP 三个"一次失败永久出局"放大器（city2 错抄 adcode、24h 负缓存、
  legMemo 记降级）。
* 层 2 预防：`longHaul.ts` 距离预计算（参照点=候选池坐标中位中心）+
  `LONG_HAUL_THRESHOLDS`（60/90min）+ 调研坐标旁路（`ResearchOutcome.locations`，
  不进 schema 不持久化）+ 规划 prompt 结构化长途点情报与独占日纪律。
  beijing 八达岭标记强独占级（151min）。
* 层 3 兜底：`longHaulFixer.ts` 确定性修复器（模式识别→move-to-day→重算验证→
  hard 严格递减否则整日回滚；三级快照回滚；防死循环上限；自动调整写 reviewNotes）。
  金标：beijing 旧 Day3 混排 3 hard → 修复后 0 hard，活动零删除。

**live 验证阶段追加的 5 项修复**（D4 分步验证逼出的真缺陷）：
1. AMAP route 任务级连续失败熔断（5 次→本任务余下秒降启发式）——修 10min 超时 cancelled。
2. geocode 地理合理性校验（`geoSanity.ts`，活动 200km）——live 实拦台北/昆明/哈尔滨/
  南昌等 4+ 次异地错配。
3. lodging 专项阈值（50km）——修上海住宿被错配到嘉兴 108km 致三天 overpacked。
4. 参照点互检（60km 冲突→活动中位中心接管）——修重庆解放碑被漂移参照点冤杀。
5. 层 3 金标夹具固化（内嵌 07-17 坏形态，切断快照文件运行时依赖）。

**最终验证**：typecheck 四包绿；单测 128/128；离线 eval 9/9 PASS hard=0。

## 遗留（transferred to 后续）

* chongqing 快照未刷新（保留 07-17 旧速度模型产物，重放 PASS）：当日 AMAP geocoder
  对重庆小 POI（夜市/茶馆/商圈）持续解析失败（6 次尝试 located 37-44%），非代码缺陷。
  待 AMAP 状态恢复后 `npm run eval:live -- --case chongqing-4d-night` 单城补刷。
* AMAP route 城际段 live 命中率仍低（多数 case amap leg 0%，疑代理环境阻断），
  熔断已保时间预算；`info.md` 有 live 排查清单。
* 修订轮 planner 若推翻修复器动作，autoFixNotes 语义为"过程日志"仍真实（Low）。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* 金集快照按流程更新并提交

## Out of Scope (explicit)

* 人工抽检 3-5 城（属下一步，本任务不含）
* M0-C 公网部署（本任务只解除其前置阻塞）
* 攻略解析、预订闭环（项目定位明确不做）

## Technical Notes

* eval 相关 commit：9f807e0（harness + geo gate）、756ee7b（首批快照 8/9）、
  571f556（eval 隔离教训：禁止 ||= env seeding）
* 代码侦察已完成（结论见上 ①-④）：失败断言定位（已离线复现）、编排逻辑、
  修订链路与 transit_infeasible 全链路、估算失真验算
