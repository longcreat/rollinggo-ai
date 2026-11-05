# 路由级代码分割（首屏 JS 949kB → 目标 ≤600kB）

## Goal

实测 `npm run build -w apps/web` 产出**唯一 JS chunk 949.69 kB（gzip 301.08 kB）**，Vite 直接警告超过 500 kB。根因是 `router.tsx` 静态 import 了全部 5 个页面，其中 `TripEditorPage` → `MapView` → `LeafletCanvas` → `leaflet` 把地图库拖进了首屏。

目标：让首页、行程列表、生成页的用户**不再下载编辑器和地图库**。

## 实测基线（2026-10-23 采集，改前必须记录）

```
dist/assets/index.js    949.69 kB │ gzip: 301.08 kB     ← 唯一 JS chunk
dist/assets/index.css   496.10 kB │ gzip: 154.79 kB
首屏合计                1.42 MB   │ gzip: 455.87 kB
```

```
grep 'React.lazy|lazy(|import('  apps/web/src  →  0 处
dist JS 中含 'leaflet' / 'L.Map'  →  命中
dist CSS 规则块数（'{' 计数）      →  2629
```

### 改后实测（2026-10-23 已完成）

```
dist/assets/index.js        379.01 kB │ gzip  121.48 kB      ← 首屏
 dist/assets/hooks.js        234.57 kB │ gzip   83.17 kB      ← 首屏（Vite 自动拆的共享 vendor，modulepreload）
dist/assets/index.css       469.73 kB │ gzip  144.53 kB      ← 首屏
────────────────────────────────────────────────────────
首屏 gzip 合计                                      349.18 kB   （改前 455.87，-23.4%）
首屏 JS gzip 合计                                    204.65 kB   （改前 301.08，-32.0%）

懒加载 chunk（不进首屏）：
TripEditorPage.js           257.78 kB │ gzip   77.86 kB      ← 含 leaflet
TripEditorPage.css           14.74 kB │ gzip    6.21 kB      ← leaflet.css 在这里
GenerationPage.js            28.89 kB │ gzip    ?
TripListPage.js              20.63 kB │ gzip    ?
NewTripPage.js                4.12 kB │ gzip    ?
PoiCard.js                    5.65 kB │ gzip    ?
```

产物数：JS/CSS 从 2 个 → 10 个。首屏 chunk 已不含 `leaflet` / `MapContainer` / `TileLayer`（实测无命中）。

**发现的关键事实**：`leaflet.css` 原本在 `main.tsx:4` 全局 import，所以仅 lazy 页面只能移除 JS 侧的 Leaflet。必须同时把 CSS import 移到 `LeafletCanvas.tsx`，否则地图样式仍在首屏。

## 现状证据

| 事实 | 位置 |
|---|---|
| 5 个页面全部静态 import | `apps/web/src/router.tsx:5-9` |
| `TripEditorPage` 静态 import `MapView`、`ChatPanel` 等 14 个编辑器组件 | `pages/TripEditorPage.tsx` |
| `MapView` 静态 import `LeafletCanvas` 和 `AmapCanvas` | `components/editor/MapView.tsx:9-16` |
| `LeafletCanvas` 导入 `leaflet` | `components/editor/LeafletCanvas.tsx` |
| 已有 loading 占位文案可复用 | `router.tsx:14`：`<div className="page-loading ...">加载中…</div>` |
| 路由结构：AppLayout 包全部页面，RequireAuth 包 4 个私有页 | `router.tsx:39-53` |

### 首屏必须保留的部分（不能 lazy）

- `AppLayout` + `GenerationProvider`（全站生成任务跟踪）
- `LoginDialogProvider` / `NavigationProvider` / `TravelPreferencesProvider`
- `QueryClientProvider`（`App.tsx:27`）
- `HomePage`——**首页可以不 lazy**，它是默认入口，lazy 只会多一次 RTT

## Requirements

### R1 路由级 lazy

改成 React Router 7 的 route `lazy` 属性（不是手写 `React.lazy` + `<Suspense>`），理由：

- `createBrowserRouter` 原生支持 `lazy: async () => ({ Component })`
- 导航期间自动处理 pending，不需要在每层塞 Suspense
- 可以在 `RequireAuth` 之上统一给一个 fallback

```tsx
// 目标形态（示意）
{
  element: <RequireAuth />,
  children: [
    { path: '/trips',      lazy: () => import('./pages/TripListPage').then(m => ({ Component: m.TripListPage })) },
    { path: '/trips/new',  lazy: ... },
    { path: '/generations/:jobId', lazy: ... },
    { path: '/trips/:id',  lazy: ... },   // ← 收益主要来自这一条
  ],
}
```

`HomePage` 保持静态 import。

**兜底**：若 React Router 7.18 的 route `lazy` 不可用或与 `RequireAuth` 嵌套冲突，退回 `React.lazy()` + 在 `<Outlet />` 外包一层 `<Suspense fallback={加载中占位}>`。两者效果等价，只是 pending 态由谁管理不同。

### 各页面的依赖链（实测）

| 页面 | 行数 | 拖入首屏的重依赖 | lazy 收益 |
|---|---|---|---|
| `HomePage` | 121 | `ChinaMap`、`HomeCapsule`、`DestinationShowcase` | 不做（默认入口） |
| `TripListPage` | 140 | 仅 ui/Button + Field + TripCover | 低 |
| `NewTripPage` | 183 | 表单 + `lib/dates` | 中 |
| `GenerationPage` | 41 | **`GenerationRunPanel`**（357 行，含时间线 + 打字机动画） | 中 |
| **`TripEditorPage`** | 212 | **`MapView` + `LeafletCanvas`(leaflet) + `ChatPanel` + `DaySection` + `AutoRoutePlanner` + `HistoryPanel` + `useEditorStore`** | **高（主要目标）** |

实测 `dist` 首屏 chunk 内命中 `leaflet` 与 `L.Map`，证明地图库确实被 `TripEditorPage` 拖进来了。

### R2 Leaflet 组件级动态加载

`MapView` 里的 `LeafletCanvas` 改为动态 import，只在**降级分支**真正渲染时加载。

- 主路径（高德 SDK 可用）的用户完全不下载 Leaflet
- 降级路径需要 async 渲染，`useAmapNamespace` 期间本来就是「默认渲染 Leaflet」，所以必须保证降级路径**不因动态加载而白屏**

**这条与 R1 有重叠**：路由级 lazy 已经把 Leaflet 从首屏挪走了。R2 的额外收益是「编辑器页面内，主路径用户也不下载 Leaflet」。可以先做 R1 验证收益，再决定 R2 是否值得（多一层 async 状态会增加降级路径的复杂度）。

### R3 记录改后体积

构建后记录新数字，写进本任务的验收记录。预期：

| 指标 | 改前 | 预期 |
|---|---|---|
| 首屏 JS gzip | 301.08 kB | ≤ 220 kB |
| 首屏 JS 原始 | 949.69 kB | ≤ 700 kB |
| 独立 chunk 数 | 1 | ≥ 4 |
| Vite >500kB 警告 | 有 | 无（或只对编辑器 chunk 有） |

## 设计约束（不能违反）

| 约束 | 原因 |
|---|---|
| `AppLayout` 及 4 个 Provider 保持静态 | 全站依赖，lazy 只会增加首屏 RTT |
| 编辑器深链 `/trips/:id` 直接访问必须正常 | lazy 后 `RequireAuth` 与 route `lazy` 的执行顺序要验证 |
| `sessionStorage` 恢复逻辑不受影响 | `GenerationProvider` 在 AppLayout 里，不在被 lazy 的页面内 |
| 不引入新的构建插件 | 用 Vite/Rollup 自带的 `manualChunks` 或 route lazy，不加 `vite-plugin-*` |
| 不改 Tailwind 配置 | CSS 体积是另一个问题，不在本任务范围 |

## 明确不做

| 不做 | 原因 |
|---|---|
| CSS 分包 / 2629 条规则收敛 | 独立任务，涉及大面积样式重构 |
| 图片换 webp + srcset | 独立任务（16.2 MB 图片是更大的问题，但要逐张处理） |
| `manualChunks` 手动分层 vendor | 路由级 lazy 已能解决首屏问题；手动分层是 vender 缓存优化，收益属于二次访问 |
| 预取（`link rel=prefetch` / route prefetch） | 先测量，有需要再说 |

## 验证方式

1. `npm run build -w apps/web`，对比首屏 JS gzip
2. 确认 `dist/assets/` 里出现独立 chunk，且 `leaflet` 不在首屏 chunk 内：
   ```powershell
   # 找到首屏 chunk（index-*.js），确认不含 leaflet
   Select-String -Path apps/web/dist/assets/index-*.js -Pattern 'leaflet' -Quiet
   ```
3. `npm run typecheck` 通过
4. 浏览器手测四条路径：
   - `/` 首页正常
   - 未登录访问 `/trips` → 跳登录 → 登录后回跳
   - 直接访问 `/trips/:id`（深链）→ 编辑器加载正常，地图（Leaflet 降级路径）正常
   - 生成中刷新 `/trips/new` → 恢复逻辑不受影响
5. `node apps/web/tests/generation-recovery-browser.mjs`（若它覆盖了页面级渲染）

## 风险

1. **深链 + lazy 的时序**。`RequireAuth` 用 `useMe()` 判断登录态，lazy 的 Component 要等 `useMe` 返回后才渲染，需确认不会出现「先闪登录页再回来」。
2. **降级路径白屏**。若同时做 R2，Leaflet 动态加载期间地图区域必须有占位，不能空白（现状是「默认渲染 Leaflet」，动态加载会破坏这个前提）。
3. **chunk 命名**。dist 产物文件名带 hash，验收脚本按 `index-*.js` 匹配时要注意改后可能不再叫 `index`。

## Acceptance Criteria

- [x] 改前基线已记录（949.69 kB / gzip 301.08 kB）
- [x] 4 个私有页面改为 `React.lazy` + Suspense（`HomePage` 保持静态）
- [x] `leaflet.css` 的 import 从 `main.tsx` 移到 `LeafletCanvas.tsx`
- [x] `npm run build` 后首屏 JS gzip 204.65 kB（≤ 220 kB 目标达成）
- [x] 首屏 chunk 内不含 `leaflet`
- [x] 独立 chunk 达 10 个产物（≥ 4 目标达成）
- [x] `npx tsc --noEmit -p apps/web` 通过
- [x] 未登录路径手测：`/trips`、`/trips/x`、`/generations/x` 均正常跳首页，无卡死
- [ ] **待用户验证**：登录后直接访问 `/trips/:id`（编辑器 + 地图）与生成中刷新恢复
- [x] 改后体积数字已记录
- [x] R2 已做，且**优先级反转**（见下节）

## R2 实施记录：高德优先 + Leaflet 按需加载（2026-10-23，用户要求）

原设计是「默认渲染 Leaflet，探测高德成功才切过去」（`MapView.tsx:33` 旧注释的理由是「主视图不能空着」）。改为**高德优先**：

```
type MapRenderer = { kind: 'probing' } | { kind: 'amap'; namespace } | { kind: 'leaflet' }
```

| 阶段 | 渲染 |
|---|---|
| `probing`（配置查询 + SDK 加载） | `MapPlaceholder`：居中「地图加载中…」，不画任何地图 |
| `amap` | `AmapCanvas`（主路径） |
| `leaflet` | `<Suspense>` + 动态 import 的 `LeafletCanvas` |

**按需加载实现**：

```ts
const LeafletCanvas = lazy(() => import('./LeafletCanvas').then((m) => ({ default: m.LeafletCanvas })));
```

**二次进入优化**：初始 state 直接读 `window.AMap`，已加载过则跳过 `api.get('/api/settings/config')` 与占位帧（SDK 同一页面只注入一次）。

**降级告警分级**：未配 Key 是正常配置状态，直接降级不告警；只有接口失败、SDK 加载失败/8 秒超时、命名空间缺失才 `console.warn`。

### 改后体积（实测）

| 产物 | 原始 | gzip | 何时加载 |
|---|---|---|---|
| `index.js` | 508.88 kB | 162.37 kB | 首屏 |
| `src.js`（共享） | 103.75 kB | 39.90 kB | 首屏（modulepreload） |
| `index.css` | 469.73 kB | 144.53 kB | 首屏 |
| **首屏合计** | — | **346.80 kB** | — |
| `TripEditorPage.js` | 102.06 kB | **30.82 kB** | 进编辑器（高德主路径只需这个） |
| `LeafletCanvas.js` | 151.14 kB | **44.45 kB** | **仅降级时** |
| `LeafletCanvas.css` | 14.74 kB | 6.21 kB | **仅降级时** |

**收益的真实口径**：

- 首屏不变（455.87 → 346.80 是上一轮路由分包的功绩，Leaflet 本轮才拆走但它本来就只随第 4 个懒加载页进入）
- **编辑器页**：主路径用家从 77.86 → 30.82 kB gzip，**降 60%**；只有降级用家才额外付 50.66 kB

**代价**：探测期间多一个占位帧（原来直接画 Leaflet）。本地已配 `AMAP_JS_KEY`，正常使用不会看不到地图；只有高德不可用时才多一次 Leaflet chunk 下载。

**未验证**：本机未登录，无法进入 `/trips/:id` 实地看两条路径。需用户验证：① 主路径高德正常渲染（本地已配 Key）；② 临时清 `AMAP_JS_KEY` 后降级 Leaflet 能按需加载并正常显示。
