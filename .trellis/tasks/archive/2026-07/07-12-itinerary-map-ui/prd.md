# ST2 前端：概览并入行程 + 时间线通勤段 + 高德瓦片地图与真实路线

> 父任务：`07-12-switch-geo-stack-to-amap-gcj02-with-transit-legs-and-itinerary-overview-merge`（Decision 章节）。数据底座由 ST1 提供（已完成归档）：Activity.coordSystem / TripDay.legs / packages/shared geo.ts（wgs84ToGcj02 已导出可前端复用）。

## Goal

前端消费 ST1 的新数据：行程页直接展示候选池信息与活动间通勤段，地图页换高德底图、只画行程活动与真实移动路线。**仅动 apps/web**，不改 schema、不改服务端。

## Requirements

### R1 行程/概览合并（TripEditorPage / DaySection / ActivityCard）

- ActivityCard 内嵌匹配到的 ResearchPoi 信息：封面图（热链 + onerror 隐藏兜底，沿用 PoiCard 既有处理）、intro、预约徽章（required/unknown 展示，「以官方为准」措辞沿用）、sourceLinks（`rel="noopener noreferrer"`）。
- **匹配策略**：Activity 与 Trip.overview 按名称匹配（归一化后精确 → 包含关系），schema 无关联 id（本任务不改 schema；未来由生成端写入关联 id 再演进）。
- 未匹配到任何活动的候选 → 「备选」折叠抽屉（复用 PoiCard），OverviewPanel 独立区块退役（代码删除或改造为抽屉，取最小改动）。

### R2 时间线通勤段（DaySection）

- 相邻活动之间渲染 leg 条：mode 图标（🚶/🚇/🚗 或等价文案）+ `durationMin` + `distanceM`（>1km 显示 km 一位小数）；`source==='heuristic'` 加「估算」小徽章。
- leg 按 `fromActivityId/toActivityId` 与实际相邻活动对匹配；**失配（用户已重排/删改）的 leg 静默过滤**，该间隙不显示（不显示错误数据）。编辑器内重排后不做重算（无服务端重算端点，属后续修订 agent 任务）。
- 旧行程无 legs：整段不渲染，不出占位噪音。

### R3 地图页重做（MapView）

- TileLayer 换高德栅格瓦片（autonavi webrd 子域轮询，attribution「© 高德地图」），react-leaflet 栈不变。
- 坐标统一：`coordSystem==='gcj02'` 直接绘制；缺省/wgs84（旧行程）用 shared `wgs84ToGcj02` 转换后绘制——**新旧行程都无偏移**。
- 覆盖层只画行程要素：有坐标的活动 → 序号标记（按天分色，序号=当天顺序），无坐标活动不上图；点击标记联动活动卡片（如现有 MapView 已有联动/选中逻辑则沿用）。
- 路线：leg.polyline（"lng,lat;lng,lat…"）解析为折线按天分色绘制；leg 存在但无 polyline（heuristic/transit）→ 两点间**虚线直连**（视觉表达估算）；无 leg 的间隙不画线。
- 保留/沿用现有按天筛选或高亮交互（勘察后取最小改动）；地图 fitBounds 以当前可见活动为准。

## Acceptance Criteria

- [ ] 生成一条新行程：活动卡片可见封面图/简介/预约/来源；备选抽屉展示未入选候选
- [ ] 活动间可见通勤条（方式+时长+距离），heuristic 有「估算」徽章；在编辑器中重排活动后失配 leg 消失且无报错
- [ ] 地图为高德底图；仅行程活动带序号标记；polyline 路线按天分色；heuristic 段为虚线直连
- [ ] 旧行程（wgs84/无 legs/无 overview）打开：地图标记位置正确（转换后无偏移）、无 leg/概览区块渲染噪音
- [ ] 三包 typecheck + build 绿；`npm run dev` 手动冒烟通过
- [ ] 移动端 <768px 基准不回退（活动卡片与 leg 条在窄屏可读）

## Definition of Done

- 组件遵循前端 spec（组件/状态/类型约定）；无新增依赖（不引高德 JS SDK）
- PrintView/ExportMenu 勘察确认不因新区块崩坏（leg/图片进长图为加分项非必需）

## Out of Scope

- schema/服务端任何改动（含 Activity↔overview 关联 id、leg 重算端点）
- GenerateForm 出行方式、住宿锚点、预算区间（→ ST3）
- 地图自定义淡色样式（栅格瓦片能力受限，接受默认路网样式）

## Technical Notes

- 高德瓦片 URL 模式：`https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}`（s∈1-4）
- polyline 解析注意「lng,lat」顺序 → Leaflet 需 [lat,lng]
- wgs84ToGcj02 从 `@tripweaver/shared` 导入（ST1 已导出）
- 现有组件勘察入口：`components/editor/{MapView,DaySection,ActivityCard,OverviewPanel}.tsx`、`PoiCard.tsx`、`store/editorStore.ts`
