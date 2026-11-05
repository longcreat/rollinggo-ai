# 地理链路 GCJ-02 化 + 通勤段实体 + 行程/概览合并 + 地图重做 + OTA 场景降级

## Goal

当前生成的行程「不可真用」：坐标不准（Nominatim 中国 POI 覆盖弱，且 geocode_place 工具刻意只查每天 2~3 个地点，其余活动无坐标）、活动间无通勤方式/时长信息、地图无真实路线、概览与行程割裂。本任务把地理数据链路整体切换到高德 GCJ-02 生态（坐标/瓦片/路径规划），引入 leg 通勤段实体，合并概览进行程视图，重做地图页，并把 OTA 强相关场景降级为「后勤锚点」——为后续可行性引擎（时空模拟器）提供可信数据底座。

## What I already know

**来自竞品分析与产品讨论（2026-07-11/12，用户已确认方向）：**
- 定位：中立纯规划工具（无预订闭环），差异化 = 可行性保证 + 行中修订，不做攻略解析
- 坐标系一次换血、绝不混用：POI/瓦片/路线全走 GCJ-02
- 行程与概览合并：活动卡片内嵌封面图/简介/预约/来源；未入选候选收进「备选」抽屉（未来行中重排素材库）
- 相邻活动间展示通勤方式 + 时长；地图页只标行程活动 + 真实路线 polyline
- OTA 场景裁决：餐饮保留（节奏锚点）；酒店降级为住宿锚点（砍推荐/比价）；预算降精度（保留档位输入 + 粗略区间输出，砍逐项精确聚合）

**来自代码勘察：**
- `packages/shared/src/schemas.ts`：Activity 有 lat/lng（必填 number）+ coordSource 枚举 + cost；TripDay 仅 activities 数组，**无 leg 实体**；ResearchPoi（概览候选）有 coverUrl/intro/reservation/sourceLinks
- `apps/server/src/integrations/geocode.ts`：Nominatim 串行 1.1s + 24h 缓存，失败回 null
- `apps/server/src/generation/tools/geoTools.ts`：geocode_place 工具提示「只查每天 2~3 个重要地点，次要留空」→ 大部分活动无真坐标（本次要改为全量精确坐标）
- `apps/server/src/integrations/amap/poiSource.ts`：POI 2.0 适配器**刻意不返回 location**（v0.4 决策，本次反转）
- 前端：`components/editor/MapView.tsx`（Leaflet+OSM）、`OverviewPanel.tsx`、`BudgetPanel.tsx`、`PoiCard.tsx`；页面 TripEditorPage / PlannerPage
- 配额纪律既有骨架：串行限速 + 24h TTL + 任务级上限 + 全站日额度（AMAP_DAILY_BUDGET）

## Assumptions (temporary)

- WGS-84→GCJ-02 正向换算用公开算法（确定性），旧行程展示时动态转换即可，无需 DB 迁移（待确认）
- 高德 Web 服务：地理编码 API / 路径规划 2.0（步行/公交/驾车）在免费额度内可覆盖单任务需求（待核对配额数字）
- Leaflet + 高德栅格瓦片可行，不必引入高德 JS SDK（react-leaflet 栈不动）

## Decision (ADR-lite)

**Context**：地理链路整体换血涉及任务边界、旧数据、通勤模式判定、住宿锚点、预算口径五个决策点（2026-07-12 与用户逐条敲定）。

1. **任务拆分**：父任务 + 3 子任务（ST1 地理数据层 → ST2 前端合并+地图 → ST3 OTA 降级），按依赖顺序推进，各自独立验收。
2. **旧行程迁移**：不迁移 DB。Activity 增 `coordSystem`（缺省视为 wgs84），展示/计算时 WGS84→GCJ02 正向动态换算（确定性算法）。
3. **通勤方式**：GenerateForm 新增「出行方式」基调字段（transit/drive/walk 优先），每段按距离启发式定 mode（<1.5km 步行，否则按基调），高德路径规划 API 取真实耗时，无 Key/超额降级直线×速度系数。
4. **住宿锚点**：Trip 级默认锚点 + day 级覆盖，可缺省（缺省用当天首尾活动作锚点并在 UI 提示）；Agent 可建议区域、不推荐具体酒店。
5. **预算口径**：Activity.cost 降为可选粗估；汇总改「人均约 ¥X–Y/天（不含大交通与住宿）」区间 + 免责说明；BudgetPanel 简化为区间条，去掉精确求和与 overBudget 判定；旧数据 cost 照读。

**Consequences**：v0.4「不取高德坐标」决策正式反转，需新 ADR 说明理由（Nominatim 中国覆盖不可用、坐标系混用不可行）与协议 3.5 缓解措施；GenerateForm/Trip schema 破坏性演进需处理导入导出版本兼容。

## Requirements (evolving)

- R1 坐标：高德地理编码/POI location 取 GCJ-02；Activity 增 `coordSystem`（gcj02，旧数据视为 wgs84）；**全部活动**须有坐标（geocode_place 改为全量使用，amap 优先 → Nominatim+转换 降级 → estimated 标注）
- R2 通勤段：新增 leg 实体 `{ mode: walk|transit|drive, durationMin, distanceM, source: amap|heuristic, polyline? }`，挂相邻活动间；时间线渲染「🚶15min」；高德路径规划 API 一级 + 直线×速度系数降级
- R3 行程/概览合并：活动卡片内嵌 ResearchPoi 信息（热链图不转存红线不变）；备选抽屉；OverviewPanel 独立页退役
- R4 地图页：高德栅格瓦片 + 仅行程活动标记（序号+名）+ leg polyline 按天分色/切换
- R5 OTA 降级：住宿锚点（非推荐）；预算区间化；餐饮保留为锚点活动
- R6 配额：路径规划调用纳入任务级上限与日额度闸门；新 ADR 记录 v0.4 坐标决策的反转与理由

## Acceptance Criteria (evolving)

- [ ] 生成的行程中 100% 活动有坐标，coordSource 如实标注
- [ ] 相邻活动间有 leg（mode/duration/distance/source），前端时间线可见
- [ ] 地图页：高德底图 + 行程活动标记 + 真实路线 polyline，旧 WGS-84 行程显示无偏移
- [ ] 高德不可用时全链路降级不断服（Nominatim/启发式），来源如实标注
- [ ] 新 ADR 文档落盘（坐标系决策反转）

## Definition of Done

- 单测覆盖坐标转换与 leg 启发式估算；typecheck/build 绿
- docs/TECHNICAL_ARCHITECTURE.md 同步 v0.5
- 旧行程 JSON 导入/导出兼容（TripExport version 处理）

## Out of Scope (explicit)

- 可行性引擎本体（时空模拟器/违规报告）——后续任务，本任务只铺数据底座
- 对话式修订 agent（L1/L2）
- 酒店推荐/比价、逐项精确预算聚合（明确移除而非实现）
- 攻略解析（小红书/抖音）

## Technical Notes

- 高德协议 3.5 缓解：只存活动点坐标+时长距离数值，不批量囤 POI，24h TTL 缓存纪律保留
- WGS84→GCJ02 为官方正向算法（确定性）；GCJ02→WGS84 反演仅在需要时用迭代近似
- geocode_place 工具语义变更：拼接目的地消歧逻辑保留，改走 amap 地理编码优先
- 已勘察文件：schemas.ts / geocode.ts / geoTools.ts / poiSource.ts / editor 组件族
