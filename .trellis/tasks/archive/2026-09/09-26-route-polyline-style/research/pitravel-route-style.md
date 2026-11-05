# 圆周旅迹（pitravel.cn）地图路线画法 —— 实测记录

> 采集方式：Chrome DevTools MCP 连本机已登录 Chrome，导航到
> `https://www.pitravel.cn/plan/journey/7688315420660239855`，
> 包装 `window.AMap.Polyline` / `window.AMap.Marker` 构造器记录入参，
> 再用 `.map-view-toggle` → `.map-view-dropdown-item` 切换单日视图触发重绘。
> 采集日期：见本 task 的 task.json。

## 1. 核心结论：一条路线 = 两条 Polyline 叠出来

圆周旅迹不画单根折线，而是**底衬 + 主线**成对添加，靠 zIndex 分档：

| zIndex 档 | 底衬 | 主线 | 用途 |
|---|---|---|---|
| **60 / 61** | 7px，`rgb(c×0.8)`，`showDir:false` | 5px，当天主色，`showDir:true` | 当天路线（opacity 1） |
| **10 / 11** | 7px，`rgb(c×0.8)`，opacity 0.2 | 5px，当天主色，opacity 0.2，`showDir:true` | 其他天（暗淡） |
| **5 / 6** | 4px，`rgb(c×0.8)`，opacity 0.2 | 2px，当天主色，opacity 0.2，`showDir:true` | 跨天连接线 |

`opacity = isDimmed ? 0.2 : 1`。底衬与主线共用同一份 `extData`。

## 2. 底衬色算法（已核对）

源码 `zG(color, t)` = 取 `#RRGGBB` 的三段十六进制，各乘 `(1 - t)`，`Math.round`，输出 `rgb(...)`。

实测核对：`#33C2FF` → `rgb(41,155,204)`
（`51×0.8=40.8→41`、`194×0.8=155.2→155`、`255×0.8=204`）。

即默认 `t = 0.2`，结果比主色暗一档。

## 3. extData 实际结构（5 类实测）

```
6x  {transport:false, dayIndex:0, isDimmed:true,  baseOpacity:0.2, hoverOpacity:1}
2x  {transport:false, dayIndex:1, isDimmed:true,  baseOpacity:0.2, hoverOpacity:1}
4x  {transport:false, dayIndex:2, isDimmed:false, baseOpacity:1,   hoverOpacity:1}
2x  {transport:true,  dayIndex:1, isDimmed:true,  baseOpacity:0.2, hoverOpacity:0.4}
2x  {transport:true,  dayIndex:2, isDimmed:true,  baseOpacity:0.2, hoverOpacity:0.4}
```

`dayIndex` 从 0 起；每个 `transport:false` 的段产生 2 条 Polyline（底衬 + 主线），故段数 = 条数 / 2。

## 4. 调色板（实机确认）

当天 3 天分别为 `#33C2FF` / `#FF9B54` / `#7B74FF` —— 正是其 `Sv` 数组前 3 项，
12 色循环：`["#33C2FF","#FF9B54","#7B74FF","#7AD200","#BF72FF","#00D49E",
"#ED6EE6","#57A2FF","#FD7A6E","#698FFF","#FF72B2","#00CDE0"]`。

## 5. 其它已实测但**本次不复刻**的点

| 项 | 实测值 | 不做的原因 |
|---|---|---|
| 跨天连接线 | z 5/6 | 本项目数据层没有「相邻两天首尾点」这条腿，需先扩 leg 语义 |
| 日期胶囊 | `.day-label-marker`，`border-radius:12px`、`padding:4px 8px`、`border:2px solid white`，内容 `10.01 周四` + `9km` | 需要从 leg 汇总当天总里程，独立工作量 |
| 拥堵聚合 | `journeyMarkerCluster` (AMap.Marker, zIndex 160) | 依赖其 `poiGroupKey` 与碰撞层，本项目用编号 pin |
| POI 点样式 | 10px 圆点 + `2px solid white` + `box-shadow:0 0 3px rgba(0,0,0,.05)`，名字 `#222 / 12px / 600` | 与本项目「编号 pin」是两种产品取向，不在本次替换范围 |
| AI 推荐点 | `24×24`，背景 `#CBF3A2` / `#E9E9E9` + CDN 图标，共 41 个 | 本项目无此数据源 |

## 6. ⚠️ 版本漂移：线上 build 与本地 chunk 不一致

本地留存的 webpack chunk（`pitravel_analysis/699.js`）是**旧版**，与线上有 3 处差异。
照抄时必须**以本文件实测值为准**：

| 项 | 本地 chunk | 线上实测 |
|---|---|---|
| 跨天线宽 | `7px / 5px` | `4px / 2px` |
| 跨天 `hoverOpacity` | `0.3` | `0.4` |
| 视图下拉类名 | `.view-dropdown` / `.dropdown-item` | `.map-view-dropdown` / `.map-view-dropdown-item` |

## 7. 落到本项目的映射

| 圆周旅迹 | tripweaver 对应物 |
|---|---|
| 当天主色 | `DayLines.color`（`dayColor(dayIndex)`，已在数据层算好） |
| `isDimmed` | 无此概念。本次只做「当天」档（z 60/61），不引入降暗语义 |
| `path` | `LegSegment.positions`（`GeoPos[]`，GCJ-02） |
| `seg.dashed`（本项目独有） | 无 polyline 的估算段 → 两点直连。**必须保留** |
| `showDir` | 高德 JS API 2.0 `Polyline` 原生支持；Leaflet 无等价物 |

## 8. 双向渲染差异（本次必须处理）

- 高德：`showDir: true` 原生方向箭头 —— 零额外成本。
- Leaflet：`L.Polyline` **没有** `showDir`。要做到视觉一致只能自绘箭头 Marker（圆周旅迹的
  `eU` 就是这么干的：沿线按 `max(3, floor(长度/0.8))` 插旋转 SVG）。
  本次**不做** —— 见 prd 的「已知不对称」。
