# 地图渲染改用高德 JS API 备选方案调研

## Goal

评估把 `apps/web` 的 `react-leaflet` 地图渲染替换为「高德 JS API + customMapStyle」的可行性、成本与收益，为未来是否实施该方案提供决策依据。本任务为**调研 + 备选方案备案**，不进入实施流程，不直接动 `apps/web/src/components/editor/MapView.tsx`。

## Background

- 当前编辑器地图实现见 `apps/web/src/components/editor/MapView.tsx`，使用 `react-leaflet` 直接拉取高德栅格瓦片 `https://webrd0{s}.is.autonavi.com/appmaptile?...`。
- 该栅格瓦片端点的 `style=` 参数实测仅 `6`（卫星图）/`7`/`8`（矢量）可用；矢量样式把 POI 文字烘焙进 PNG，**没有 URL 参数可关闭文字层**。
- 用户期望编辑器地图呈现「规划展示页」风格，弱化或隐藏未编入行程的 POI 文字（例如圆明园行程下避免清华大学文字抢占视觉），让行程内容专注凸显。
- 已尝试方案 A（CSS `filter` 弱化 `.leaflet-tile-pane`）：见 commit `b7e85c9`，效果未达预期，已 `git revert` 至 `1d5a59b`。
- 已尝试方案 B（更换 `style=` 数值）：除 6/7/8 外其它数字返回空瓦片，无法达成。

## What I Already Know

- 现有 `react-leaflet` 已稳定运行在 Leaflet v1.9 上，marker / polyline / popup / MapController 与 GCJ-02 坐标系一致。
- 高德 JS API v2.0 在官方示例「自定义地图样式 → 隐藏文字标注」(`map-showlabel`) 控制文字图层显隐，是官方开放路径。
- `MapView.tsx` 的 marker 实现使用 `L.divIcon` 自绘 HTML，已具备自定义视觉优先级能力，可独立于底图重排信息层级。
- 既有 `apps/server/src/integrations/amap/route.ts`、`geocoder.ts` 已与高德后端服务集成，前端替换 SDK 不影响服务端路径规划与地理编码链路。
- 旧 `wgs84` 行程数据在 `displayPos` 中正向偏移到 GCJ-02；高德 JS API 原生 GCJ-02，无需额外转换。

## Requirements（调研产出）

- 对比 `react-leaflet` 与高德 JS API 在本项目下的能力矩阵：marker、polyline、Popup/InfoWindow、控制视野、自定义 HTML 节点、移动端页签切换 (`invalidateSize`/`fitBounds`)、按天筛选 `dayFilter` 等价能力对应关系。
- 评估迁移成本：包体大小、首屏体积、license / API Key 暴露面（前端 Key 安全策略）、与现有 `react-leaflet` 生态的兼容代价、是否需要双 SDK 过渡。
- 评估收益：能否真正隐藏 POI 文字、能否控制道路骨架保留程度、能否配套自定义地图样式（如「胶片」「极简」「暖灰」等主题）。
- 评估风险：GCJ-02 坐标系一致性、`MapController` 等价效果、移动端浏览器兼容、热重载与开发体验差异。
- 给出决策建议：是否实施、若实施应分几步走、是否保留 `react-leaflet` 作为渐进过渡层、是否需要 spec 同步。

## Acceptance Criteria（仅调研产出）

- [ ] 产出一份调研报告（建议放在 `.trellis/tasks/07-21-map-rendering-amap-jsapi-study/research/` 下），含上述能力矩阵、成本评估、收益评估、风险与决策建议。
- [ ] 报告**不要求**实施任何代码改动；如发现低风险轻量化方案可在调研结论中标注为「可选快速尝试」，但仍需另开 task 推进。

## Definition of Done

- 调研报告完成并被站长阅读确认。
- 若决策为「不实施」，本任务直接归档；若决策为「实施」，本任务作为 spine，按其建议另开实施 task（不在本任务范围内动代码）。

## Technical Approach（建议调研步骤）

1. 阅读 `MapView.tsx`、`apps/web/src/lib/colors.ts`、`apps/web/src/lib/tripDerive.ts`、`apps/web/src/store/editorStore.ts`，列出当前 react-leaflet 提供且被项目使用的全部能力。
2. 查阅高德 JS API v2.0 官方示例：`custom_style` / `set-theme-style` / `map-showlabel` / `set-map-cotent`，整理对应能力映射表。
3. 评估前端接入成本：是否需要 `@amap/amap-jsapi-loader`、Key 是否必须暴露在浏览器（如必须，确认是否设计 `apps/server` 代理转发以隐藏）、是否影响 bundle 体积。
4. 设计 PoC 草图（**仅在调研报告中文字 + 伪代码描述**，不落代码）：替换 MapView 的最小骨架需要哪些 API 调用。
5. 评估保留 `react-leaflet` 并叠加一层高德「空白矢量瓦片（隐藏文字）」的可能性——若可实现则可作为低成本中间档，避免完全替换。

## Out of Scope

- 任何对 `apps/web/src/components/editor/MapView.tsx` 或其样式的实际代码改动。
- 切换瓦片源、坐标系变更、修改 schema 或后端。
- 引入新的 npm 依赖。
- 当前 `release-candidate-e2e-deployment` 任务范围内的任何工作。

## Technical Notes

- 当前地图实现：`apps/web/src/components/editor/MapView.tsx`
- 现有 CSS：`apps/web/src/styles/global.css` 第 230 行起的「地图」段落
- 已废弃尝试：commit `b7e85c9`（方案 A CSS 滤镜），revert commit `1d5a59b`
- 高德 JS API 文档入口：`https://lbs.amap.com/api/javascript-api-v2/summary`
- 隐藏文字标注示例：`https://lbs.amap.com/api/javascript-api-v2/example/personalized-map/map-showlabel`
- 自定义样式示例：`https://lbs.amap.com/api/javascript-api-v2/example/personalized-map/custom_style`