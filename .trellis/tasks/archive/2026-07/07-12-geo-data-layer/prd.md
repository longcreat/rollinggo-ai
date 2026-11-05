# ST1 地理数据层：高德地理编码/路径规划适配器 + coordSystem/leg schema + 生成全量坐标

> 父任务：`07-12-switch-geo-stack-to-amap-gcj02-with-transit-legs-and-itinerary-overview-merge`（决策背景见父 prd.md 的 Decision 章节）

## Goal

把地理数据链路从「Nominatim WGS-84 + 每天仅 2~3 个坐标」切换为「高德 GCJ-02 + 全量精确坐标 + 活动间通勤段（leg）」，为可行性引擎与前端地图重做（ST2）提供数据底座。本子任务**只做 shared schema + 服务端**，不动前端。

## Requirements

### R1 坐标系与转换（packages/shared）

- 新增 `packages/shared/src/geo.ts`：`wgs84ToGcj02(lat, lng)`（官方正向偏移算法，确定性）+ `haversineMeters(a, b)`。中国境外坐标不偏移（算法自带 outOfChina 判断）。
- constants 新增：`COORD_SYSTEMS = ['wgs84','gcj02']`、`LEG_MODES = ['walk','transit','drive']`、`LEG_SOURCES = ['amap','heuristic']`。
- `ActivitySchema` 新增 `coordSystem: Type.Optional(StringEnum(COORD_SYSTEMS))` —— **缺省 = wgs84（旧数据）**，新生成一律写 `gcj02`。
- 新增 `TransitLegSchema`：`{ fromActivityId, toActivityId, mode: LEG_MODES, durationMin: number, distanceM: number, source: LEG_SOURCES, polyline?: string(maxLength 4000, 「lng,lat;lng,lat…」抽稀后串) }`。
- `TripDaySchema` 新增 `legs: Type.Optional(Type.Array(TransitLegSchema))`。以 from/to activityId 关联（活动重排/删除后失配的 leg 视为过期丢弃，由消费方过滤）。
- 全部为**可选字段**，TripExport version 维持 2（增量兼容），旧行程 JSON 原样可读。

### R2 高德地理编码适配器（apps/server/src/integrations/amap/）

- `poiSource.ts` 反转 v0.4 决策：`searchPois` 返回值**新增 `location: {lat,lng}`（GCJ-02）与 `adcode`**（v5 place/text 的 `pois[].location`「lng,lat」串解析）。
- 新增 `geocoder.ts`：`amapGeocode(name, city)` → `{ lat, lng, adcode } | null`，走 v3 地理编码 `GET https://restapi.amap.com/v3/geocode/geo?address=<city+name>&city=<city>&key=`。
- **解析链**（geocodeActivity）：高德 POI text 搜索（名称+目的地）→ 高德 v3 geocode → Nominatim + `wgs84ToGcj02` 转换 → 全失败回 null（coordSource=estimated 由上层标注）。链路每级如实标注来源。
- Key 解析沿用现有「个人加密 Key → 站点 AMAP_KEY → Null 源」动态解析模式（见 poiSource 现有实现），不入全局单例。

### R3 路径规划适配器（integrations/amap/route.ts）

- `routeEstimate(origin, dest, mode, opts)` → `{ durationMin, distanceM, polyline? } | null`：
  - walk：`GET /v5/direction/walking`；drive：`/v5/direction/driving`；transit：`/v5/direction/transit/integrated`（需 city1/city2 = adcode，从 geocode 结果携带；缺 adcode 时 transit 直接走启发式降级）。
  - `show_fields=polyline` 取路线折线，抽稀（如每 N 点取 1）后拼串，超 4000 字符截断丢弃 polyline 仅留时长距离。
- 纪律沿用四道闸模式：串行限速（350ms，可与 POI 共队列）+ 24h TTL 缓存（键=起终点坐标取整5位+mode）+ 任务级上限 `ROUTE_MAX_PER_TASK = 30`（超出走启发式）+ 计入 `amap_calls` 与 `AMAP_DAILY_BUDGET` 全站日额度。
- **启发式降级** `generation/legEstimator.ts`：haversine × 绕行系数 1.4；速度 walk 4.5km/h、transit 20km/h+10min 换乘开销、drive 30km/h+5min；`source='heuristic'`。任何高德失败/超额/无 Key 均静默降级，**生成流程永不因此失败**。

### R4 生成链路改造（generation/）

- **设计铁律：机械工作移出 LLM 循环**。编排 Agent 不再负责逐点查坐标——orchestrator 在审校完成后、落库前新增**确定性后处理 pass**：
  1. `geocodeAll(draft)`：对所有无坐标/estimated 活动跑 R2 解析链（串行队列内），写回坐标 + coordSystem='gcj02' + coordSource 如实标注；
  2. `computeLegs(draft, baseMode)`：对每天相邻活动对生成 leg（mode 按距离启发：<1.5km walk，否则用 baseMode，MVP 无表单字段时 baseMode='transit'）；优先 routeEstimate，降级 legEstimator。
- `geoTools.geocode_place` 保留供编排 Agent 消歧重点地点，但内部改走 R2 解析链（返回 GCJ-02），prompt 中删除「只查 2~3 个地点」限制、改为「无把握的地点可查询，其余交给系统统一解析」。
- 后处理期间通过现有 sink 发 `thought` 事件（如「正在解析坐标与通勤 (12/18)」），**不新增 SSE 事件类型**（前端改造属 ST2）。
- `prompts.ts` 同步：活动坐标不再要求模型编造/留空的措辞更新。

### R5 文档与 ADR

- `docs/TECHNICAL_ARCHITECTURE.md` 增补 v0.5 修订记录：坐标决策反转（Nominatim 中国 POI 覆盖不可用、坐标系混用不可行）+ 协议 3.5 缓解措施（只存活动坐标与时长距离数值、不批量囤 POI、24h TTL、热链不转存不变）。

## Acceptance Criteria

- [ ] `packages/shared`：geo.ts 单测通过（已知基准点转换误差 < 1e-4 度；境外点不偏移）；schema 新字段 typecheck 通过且旧 Trip JSON 校验兼容
- [ ] 生成一次行程（可用 mock/脚本驱动）后：100% 活动有坐标、coordSystem='gcj02'、coordSource 如实标注；每天相邻活动间均有 leg（mode/durationMin/distanceM/source）
- [ ] 高德 Key 缺失/超额时：坐标走 Nominatim+转换、leg 走启发式，生成不失败，source 标注 heuristic
- [ ] routeEstimate 单测（mock fetch）：三种 mode 解析、polyline 抽稀与超长丢弃、缓存命中
- [ ] 任务级 ROUTE 上限与日额度闸门生效（超限降级而非报错）
- [ ] 三包 `tsc --noEmit` + build 绿

## Definition of Done

- 单测：geo 转换 / legEstimator / route 解析 / geocode 解析链降级顺序
- `.env.example` 无需新增变量（复用 AMAP_KEY/AMAP_DAILY_BUDGET）——如实现中确需新增须在 PRD 补记
- TECHNICAL_ARCHITECTURE.md v0.5 修订落盘

## Out of Scope

- 前端一切改动（地图/时间线/合并视图 → ST2）
- GenerateForm 出行方式字段（→ ST3；本任务 baseMode 常量 'transit'）
- 住宿锚点、预算区间（→ ST3）
- 可行性引擎（时空模拟/违规报告 → 后续任务）

## Technical Notes

- 现状勘察：`geocode.ts`（Nominatim 串行 1.1s+24h 缓存）、`geoTools.ts`（geocode_place 限 2~3 点/天）、`poiSource.ts`（刻意不返回 location，本次反转）、`ActivitySchema`（lat/lng 必填 + coordSource 枚举）
- 高德 v5 place/text 返回 `pois[].location`（"lng,lat" 字符串）与 `pois[].adcode`；v3 geocode 返回 `geocodes[].location` 与 `adcode`
- 序列化注意：leg polyline 是行程 JSON 一部分，注意 trips.data 体积（每天 ≤ 活动数-1 条 leg，polyline 抽稀）
- 转换算法参考：标准 GCJ-02 偏移公式（transformLat/transformLng + outOfChina），实现于 shared 以便 ST2 前端复用
