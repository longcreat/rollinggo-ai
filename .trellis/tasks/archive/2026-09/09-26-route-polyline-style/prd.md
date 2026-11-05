# 地图路线改双层折线 + 按天淡化 + POI 名称标签（对齐圆周旅迹）

## Goal

把 `apps/web` 两套地图渲染的行程路线与 POI 标注，对齐圆周旅迹（`pitravel.cn`）行程详情地图的观感：

1. 一条路线画**底衬 + 主线**两层；
2. 按天筛选时，其他天**仍然画出来但整体淡化**（而不是被过滤掉）；
3. POI 旁边显示**活动名称**，名称互相压住时按规则隐藏。

纯视觉与地图交互改动，不新增任何业务数据或服务端接口。

## Background

- 现状：`AmapCanvas` 与 `LeafletCanvas` 各画一根 3px 半透明折线；`MapView` 按 `dayFilter`
  直接把其他天从数据里**删掉**；marker 是 28px 编号 `.marker-pin`，没有名称。
- 参考对象：圆周旅迹的行程详情地图。实测其每条路线成对添加 Polyline（底衬取当天色 `× 0.8`、
  更粗、无方向箭头；主线取主色、更细、开 `showDir`），并按 zIndex 分档
  （当天 60/61，其他天 10/11，跨天 5/6）；POI 名称走一套
  「量 rect → 按优先级贪心占位 → 相交即隐藏」的避让逻辑。
- 采集方法与全部实测数据见 `research/pitravel-route-style.md`（含底衬色算法核对、调色板、
  以及本地留存 chunk 与线上 build 的版本漂移对照）。

## 已定决策（用户拍板）

1. **双层折线 + 方向箭头**已实现（R1–R4）。不复刻：跨天连接线（本项目数据层没有这条腿）、
   日期胶囊（要先汇总当天里程）、拥堵聚合、圆周旅迹的圆点 POI 样式（与本项目编号 pin 是两种取向）。
2. **两套渲染同步改**，不能只有高德变双层线。
3. **路线一律实线**：估算段不再用虚线区分（用户确认）。`LegSegment.dashed` 随之成为孤儿字段，删除。
4. **按天筛选改为淡化**：选中某天时其他天仍绘制，整体降到 `opacity 0.2` / zIndex 10·11 档。
   其他天的 marker 也一并淡化（圆周旅迹是整天的 marker 一起淡化）。
5. **只改路线实线，保留 pin 的虚线边框**：`.marker-estimated` 的 `border-style: dashed`
   是「坐标为估算」的独立信号，与路线虚实无关，本次不动。
6. **POI 名称做完整避让**（用户选「名字 + 碰撞隐藏」）。

## Requirements

- **R1 双层折线**（已完成）：每段画两条 —— 底衬 `dimColor(color)` / 7px / z 60，
  主线 `color` / 5px / z 61 / `showDir: true`。
- **R2 底衬色**（已完成）：`dimColor(hex, t = 0.2)` = RGB 各乘 `1 - t` 后 `Math.round`；
  落在 `lib/colors.ts`，非 `#RRGGBB` 输入原样返回（避免算出 `rgb(NaN,NaN,NaN)` 画出不可见线）。
- **R3 两套渲染不漂移**（已完成）：笔画宽度与两档 zIndex / opacity 收在 `lib/routeStyle.ts`，
  两个 canvas 都引用，禁止各自硬编码。
- **R4 方向箭头**（已完成）：高德侧主线 `showDir: true`。Leaflet 无等价物 —— 见「已知不对称」。
- **R5 路线一律实线**：删除 `LegSegment.dashed`（连同 `mapData` 里的产出逻辑与两个 canvas 的
  `dashArray` / `strokeDasharray` 分支）。无 polyline 的段仍然两点直连，只是不再换线型。
- **R6 按天淡化**：
  - `mapData` 的 `DayLines` / `MapPoint` 各增一个 `dimmed: boolean`；
    `collectDayLines(days, highlightDay)` / `collectPoints(days, highlightDay)`
    在 `highlightDay !== null` 时把其他天标成 `dimmed`。
  - `MapView` 不再过滤天数，改为把全部天喂给画布，`dayFilter` 只作为 `highlightDay` 传下去。
  - 画布按 `dimmed` 选档：淡化档 `opacity 0.2` / z 10·11，正常档 `opacity 0.75` / z 60·61。
  - marker 淡化通过 `.map-marker--dimmed` 类（`opacity: 0.3`）。
  - `setFitView` / `fitBounds` 的目标是**当前查看范围**：总览时全部天，选了某天时只有那天
    （对齐圆周旅迹）。这与圆周旅迹一致，且靠淡化层仍能看到其他天在哪个方向。
- **R11 地图容器的高度约束**：`.editor-page` 必须 `height: calc(100vh - 56px)`。
  原来它只有 `min-height: 0`，父链 `.app-layout` 也只有 `min-height: 100vh` ——
  于是左栏内容一长，`editor-body` / `editor-map` / `map-pane` / `.amap-host` 就跟着一起长，
  实测能到 **1597px 而视口只有 1271px**。后果是 `setFitView` 按一个比屏幕还高的容器去算视野，
  框出来的范围有约 1/3 落在屏幕外 —— 主观上就是「点总览/某天后定位不对」。
  `calc(100vh - 56px)` 用的是本仓库已有的页头高约定（见 `.chat-page.is-chat`）。
- **R7 名称标签**：marker HTML 由 `.marker-pin` 升级为
  `.map-marker`（28×28 定位框）内含 `.marker-pin` + `.map-label`（绝对定位在 pin 下方，
  `white-space: nowrap`）。两套渲染共用同一个生成函数，保证 DOM 结构一致。
- **R8 名称避让**：新增 `lib/labelCollision.ts`（SDK-free）：
  - 每个 marker 的占位框 = `union(pin 的 rect, 名称的 rect)` 外扩 `LABEL_GAP`；
  - 非淡化层优先于淡化层，同层内按 DOM 顺序先到先得；
  - 与任一已占位框相交 → 该名称加 `.map-label--hidden`（`visibility: hidden`，
    保留 rect 可测，下一轮无需先复原即可重算）；
  - 低于 `LABEL_MIN_ZOOM` 时整层隐藏；
  - 尺寸为 0 的候选（marker 尚未上屏）跳过。
- **R9 避让的触发时机**：只在 `zoomend` / `moveend` 与覆盖物重建后各跑一次，
  **不做 rAF 循环**。交互结束才算一次，天然没有阈值抖动，也就不需要圆周旅迹那套迟滞。
- **R10 零回归**：不得改变 ——
  `.marker-estimated` 的虚线边框与 0.85 透明度、`displayPos` 的 wgs84 正向偏移、
  InfoWindow / Popup 内容与「编辑」按钮委托、移动端页签切换时的
  `resize` / `invalidateSize`、`map-empty` 空态文案。

## 已知不对称（必须写进代码注释）

**Leaflet 降级路径不会有方向箭头。** `showDir` 是高德 JS API 2.0 的原生能力，Leaflet 的
`L.Polyline` 没有等价物；补齐只能像圆周旅迹那样沿线插旋转 SVG Marker（间距还要随 zoom 重算，
否则缩放后箭头密度失控）。本次明确不做。同步后两套渲染的差异**只有「主线有无方向箭头」一项**。

**没有 `forceVisible` 分支。** 圆周旅迹的避让会强制显示选中 / 悬停中的 marker。
本项目的 `editorStore` 没有「当前选中活动」这一状态（只有 `trip` / `revision` / `dayFilter`），
所以 R8 里没有强制显示档。**不要**为了这一条去新增选择态 —— 那是独立特性。
等哪天真有了地图选中态，再把它接进 R8 的排序。

## 风险与约束

- 覆盖物数量变化：折线翻倍（1 → 2）、marker 不变。本项目行程规模（单日 ≤ 十余个活动、
  总量数十）下无性能顾虑。
- 名称避让依赖 DOM 测量，而 AMap 的 marker 是它自己插入的 DOM。避让逻辑只按类名
  `.map-marker` / `.map-label` 查询，不依赖 SDK 的内部结构 —— 但也因此**依赖 marker HTML
  里带上这两个类**：改 `markerHtml` 时不要顺手删类名。
- `setFitView` 目标改成非淡化层后，筛选某天时视野会收紧到该天。这是刻意的（对齐圆周旅迹），
  不是 bug。
- 两套渲染都要动，等于双份目视验证；Leaflet 侧本地不易触发（配了 `AMAP_JS_KEY` 就走高德）。

## Technical Approach

1. `lib/routeStyle.ts`：把 `opacity` / `underZIndex` / `mainZIndex` 收成 `active` / `faded`
   两档，另加淡化 marker 的透明度。
2. `lib/mapData.ts`：删 `LegSegment.dashed`；`DayLines` / `MapPoint` 加 `dimmed`；
   两个 collect 函数接 `highlightDay`。
3. `lib/labelCollision.ts`（新）：`resolveLabelCollisions(host, zoom)`，纯 DOM，无 SDK 依赖。
4. `lib/amapTypes.ts`：补 `AmapMap.on` / `off` / `getZoom`；marker HTML 结构变化不需要新类型。
5. `components/editor/MapView.tsx`：去掉 `visibleDays` 过滤，改传 `highlightDay`。
6. `components/editor/AmapCanvas.tsx`：双层 + 分档 + `.map-marker` HTML + `zoomend`/`moveend`
   监听避让 + `setFitView` 换成非淡化层。
7. `components/editor/LeafletCanvas.tsx`：同上（Leaflet 事件名相同，`divIcon` 的 HTML 复用同一函数）。
8. `styles/global.css`：在 `.marker-pin` 旁加 `.map-marker` / `.map-label` / `.map-label--hidden`
   / `.map-marker--dimmed`。

## Completion criteria

- `npm run typecheck`（仓库根）与 `npm run build -w apps/web` 通过。
- 实机核对（浏览器里包 `AMap.Polyline` 构造器）：筛选某天时，非当天线为 `opacity 0.2` +
  zIndex 10/11，当天线为 `0.75` + 60/61；不再出现 `strokeDasharray`。
- 目视：路线是实线双层；名称在 pin 下方；筛选某天时其他天变淡且仍在图上；
  名称重叠处有隐藏；缩小到 `LABEL_MIN_ZOOM` 以下名称整层消失。
- 逐条核对 R10 零回归清单。
