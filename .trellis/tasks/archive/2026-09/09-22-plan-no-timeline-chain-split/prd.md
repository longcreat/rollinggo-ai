# PRD：plan 去时间轴 + 通勤按模式判 + 成链切段分组

- 任务：`09-22-plan-no-timeline-chain-split`
- 创建：2026-09-22 / aimer
- 触发：`apps/server/北京3日行程.json` 实测暴露的编排问题

## 问题（实测数据）

| 天 | 活动 | 停留 | 通勤 | 合计 |
| --- | --- | --- | --- | --- |
| Day1 | 1 | 90min | 311min | 401min |
| Day2 | **7** | 675min | 402min | **1077min（17.9h）** |
| Day3 | 4 | 510min | **646min** | **1156min（19.3h）** |

硬门槛 14h（840min），两天都是 1.3~1.4 倍，照样交付。具体缺陷：

1. 首点入向通勤没进时间轴（八达岭 08:30 开始，但住宿→八达岭 163min）
2. 真实 leg 把时间轴一路推爆（Day2 结束 22:45）
3. 4 条 hard 违规（`transit_infeasible`）只写进 reviewNotes 就交付
4. 地理分组荒谬：Day3 把颐和园 + 雍和宫 + 慕田峪长城 + 故宫角楼混排，单段 212/231min
5. 慕田峪是【强独占级】却没独占一天 —— `longHaulIntel` 在坐标兜底之前算，当时它没坐标被 `classifyLongHaoPois` 跳过
6. 住宿建议变成具体酒店品牌（`北京丽晶酒店`），违反 prompt 的「只给区域名」
7. Day1 标题「自由漫步」——`dayTitle()` 读的是 `poi.category`（英文枚举），匹配不上中文 `CATEGORY_LABEL`
8. 一天 7 个活动，超过自设的 `maxStopsPerDay = 6`（`repair_long_haul` 挪进来的）

## 已定决策

| # | 议题 | 决定 |
| --- | --- | --- |
| D1 | 分数（recommendScore）作用域 | **管入选与分天**，不管当天顺序（顺序交给空间） |
| D2 | 分组算法 | **先成链再切段**（route-first, cluster-second） |
| D3 | 步行/骑行分界 | **按时长判**（判据与执行共用同一套速度模型） |
| D4 | 住宿锚点 | **留名字不留 leg**，不进时间轴也不进可行性通勤预算 |
| D5 | 时间轴 | **去掉**，只算景点↔景点通勤 |

## 第一期（已完成）—— D3 + D4

- 新增 `cycle` 到 `LEG_MODES` / `LEG_SPEED_MODEL`（13km/h + 3min 开销）
- `WALK_THRESHOLD_M`（直线 1500m）删除，改为 `effectiveLegMode(origin, dest, baseMode)`：走路 ≤15min → 否则 ≤25min 且 ≤6km 骑行 → 否则行程基调（步行基调升公交）
- Amap 适配层加 `/v5/direction/bicycling`；`prompts.ts` 与 `web/tripDerive.ts` 加骑行 label/icon
- `computeLegs` 去掉 lodging 哨兵段（只算景点↔景点）

## 第二期（待做）—— D5 + D1 + D2

- `schedule.ts` 去掉餐窗切段与时间轴：`startTime/endTime` 写空串（`ActivitySchema` 注释已写「允许空串」，schema 不用改）
- 新增 `effectiveLegMode` 无坐标时的兜底不再需要分钟预算，`availableMinutes` / `usedMinutes` 删除
- 分组重写为：全局最近邻成链 → 按「入选权重」切成 k 段 → 段按权重降序分配 Day1..k
- 长途独占级：各自单独成段（不再被后续补位污染）
- 美食导向：每段插午餐/晚餐锚点（无时间，只作为顺序列表项）
- orchestrator：`repairTransitTiming` 与 `ensureMealCoverage` 调用移除（都没有时间轴可依）

## 验收结果（2026-09-22 实测闭环）

- [x] 任意一天景点数 ≤ maxStopsPerDay：实测 4/1/4（Day2=1 为慕田峪强独占日的**设计意图**，「数量差 ≤1」不适用于独占日，以独占豁免修正该条）
- [x] 【强独占级】地点所在天不含其它远端点：慕田峪独占 Day2 ✓
- [x] 无时间轴行程正常落库、verify-c2 断言「时间留空」通过 ✓
- [x] `npm run typecheck` + 单测 207/207 + `node scripts/verify-c2.mjs` 全绿 ✓
- [x] 复跑 `test-gen-timing.mts`：总耗时 228.6s（plan 阶段 2.9s 零 LLM 调用）；无 200min+ 跨区段（最差 89min）；Day3 景山→故宫→天坛→奥林匹克有 soft 回折提示（如实进 reviewNotes）

## Out of Scope

- 游玩时长数据（上游 xhs 管道导出 `typicalVisitMinutes` 覆盖率仅 3.5%）
- 分数数据导出（上游管道尚未把 recommendScore 导出，本任务只预留权重接口）
- 营业时间/闭馆判定
