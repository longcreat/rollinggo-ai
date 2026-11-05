# 前端地图改用高德 JS API 渲染（Leaflet 降级）

## Goal

把 `apps/web` 的地图渲染改为「**高德 JS API 优先 + Leaflet 降级**」，让编辑器地图能**隐藏/弱化未编入行程的 POI 文字**，使行程内容在视觉上凸显。

## Background

- 现方案：`apps/web/src/components/editor/MapView.tsx` 用 `react-leaflet` 拉高德栅格瓦片
  `https://webrd0{s}.is.autonavi.com/appmaptile?...style=8`。
- 该瓦片把 POI 文字**烘焙进 PNG**，没有 URL 参数可关闭（实测 `style=` 仅 `6`/`7`/`8` 可用，其它值返回空瓦片）。
- 已试并回滚：CSS `filter` 弱化 `.leaflet-tile-pane`（commit `b7e85c9`，revert 于 `1d5a59b`），效果不达预期。
- 高德 JS API v2.0 是官方开放路径：`AMap.Map` 的 **`features`** 参数可指定显示哪些图层元素
  （`bg` 底图 / `road` 道路 / `building` 建筑 / **`point` 兴趣点与文字标注**）——不传 `point` 即无 POI 文字。
  这是栅格瓦片做不到、且**比 `customMapStyle` 更轻**的做法。
- 前置调研：`archive/2026-09/07-21-map-rendering-amap-jsapi-study` —— **只留了 PRD、没有产出报告**，
  故本 task 同时承担调研与实施。该 PRD 结论中的「不进入实施流程」已被本次决策取代。

## 已定决策（用户拍板 09-26）

1. **首要目标**：隐藏/弱化**未编入行程**的 POI 文字（不是要换底图风格，也不是要新功能）。
2. **接受部署门槛**：JS API Key 绑域名白名单 + 安全密钥必然明文暴露在前端；**README 写清申请步骤**。
   代价是「零配置自部署」这条卖点要修订。
3. **两套并存**：高德 JS API 优先，Leaflet 作降级。

## Requirements

- **R1 渲染能力对齐**：高德实现须覆盖现 Leaflet 的全部能力 —— 编号 marker（自绘 HTML）、
  `Polyline`（实线 / 虚线降级 path 缺失时的两点直连）、popup（含「编辑」按钮与来源外链）、
  `fitBounds` 等价视野控制、移动端页签切换时的 `resize`。
- **R2 POI 文字处理**：默认 `features: ['bg', 'road', 'building']`（去掉 `point`）。
  是否保留路名由 `road` 决定，需目视确认观感。
- **R3 降级**：触发条件与降级时的用户可见反馈待定（见下）。
- **R4 配置注入**：JS API Key 与 `securityJsCode` 的注入方式待定（见下）。
- **R5 零回归**：`dayFilter` 按天筛选、`coordSource==='estimated'` 的标记样式、
  `coordSystem==='wgs84'` 旧数据的正向偏移（`displayPos`）行为不变。

## 已定实现细节（用户确认「按默认做」09-26）

1. **降级触发条件**：Key 未配置 **或** SDK 加载失败/超时（**8 秒**）→ 一律降级到 Leaflet。
   降级**静默**（底图变化肉眼可见，不需要额外提示条），但留一行 `console.warn` 供排查。
2. **Key 与安全密钥注入**：**运行期从新增的 `GET /api/config` 取**（服务端从 env 读）。
   比构建期注入好：自部署者只改 `.env`、不用重新构建，Key 也不进 bundle。
   注意 `window._AMapSecurityConfig` 必须在 loader 加载**之前**设置，所以要先 `await fetch('/api/config')`。
3. **文字处理程度**：**直接不传 `point`**，完全去掉 POI 文字（保留底图 / 路网 / 建筑）。
   若之后想要「只保留一级地标」，再上 `customMapStyle`（成本更高，先不做）。
4. **并行冲突**：见「风险与约束」。

## 风险与约束

- ⚠️ **与并行前端重构冲突**：当前工作区有另一会话正在大改 `apps/web`（新增 `HomePage` / `NewTripPage`、
  删除 `ChatPage` / `BriefCard` / `ConversationPicker`、改 `router.tsx` / `AppLayout.tsx` / `global.css`）。
  本 task 要动 `MapView.tsx` + `global.css`，**重叠面很大** → 建议等那次重构落地后再开工。
- 双套渲染 = 双套测试（`scripts/verify-c3.mjs` 有地图相关断言），维护成本翻倍。
- **坐标系不变**：两套底图都在 GCJ-02 帧内（Leaflet 用高德栅格瓦片、JS API 原生 GCJ-02），
  `displayPos` 的正向偏移逻辑无需改动。**不要**把瓦片换成天地图（WGS-84，会偏移约 500m）。
- 前端 Key 无法隐藏，只能靠域名白名单限权；README 必须写明这一点，避免自部署者把 Key 当成秘密。

## Technical Approach（草案）

1. **加载**：官方 `@amap/amap-jsapi-loader`（异步，不进主 bundle）；加载前设
   `window._AMapSecurityConfig = { securityJsCode }`。
2. **地图**：`new AMap.Map(el, { features: ['bg', 'road', 'building'], viewMode: '2D' })`。
3. **覆盖物**：`AMap.Marker({ content: '<div class="marker-pin">N</div>', offset: new AMap.Pixel(-14, -14) })`
   （复用现有 `.marker-pin` / `.marker-estimated` CSS）；
   `AMap.Polyline({ strokeStyle: 'dashed', strokeDasharray: [6, 6] })`；
   `AMap.InfoWindow({ content: html, offset })`。
4. **视野**：`map.setFitView(markers, false, [40, 40])`，容器从隐藏变可见时先 `map.resize()`。
5. **降级**：把「数据 → 渲染」的边界保持为纯函数（现有 `collectPoints` / `collectLegSegments` 已是），
   新增 `AmapCanvas.tsx` 与保留 `LeafletCanvas.tsx`，由 `MapView.tsx` 决定挂哪个。
6. **验收**：`scripts/verify-c3.mjs` 的地图断言在两种实现下都通过；新增一条「未配 Key 时降级到 Leaflet」的断言。

## Out of Scope

- 切换瓦片源、坐标系变更、任何后端与 schema 改动。
- 行程数据结构、leg 计算、地图交互（点 marker 编辑）之外的 UI。
- `customMapStyle` 主题（除非待定项 3 决定要保留一级地标）。
