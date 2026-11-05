# 我的行程列表：滚动分页加载（每批 20 条）

状态：planning。用户已确认走**后端真分页**（筛选、排序、计数一并下沉到服务端）。

## 需求

- 「我的行程」列表默认展示 20 条，滚动到底部自动追加下一批。
- 搜索关键词、目的地筛选、排序仍然可用，切换筛选后回到第一批。
- 结果计数（「找到 N 份行程」）显示的是筛选后的总数，不是已加载条数。

## 现状与问题

- `apps/server/src/services/tripService.ts:67` 的 `listTrips(userId)` 全量查询 + 在 JS 里按 `rootId` 取最新版本，返回 `TripListItem[]`。
- `apps/web/src/api/hooks.ts:131` `useTrips()` 一次拉全量；`TripListPage.tsx` 在 `useMemo` 里做关键词/目的地筛选与三种排序，并把全量渲染进网格。
- 当前 52 条一次性渲染，后端 `MAX_TRIPS_PER_USER = 100`（行数上限，含版本链），列表还会继续增长。

## 接口设计

`GET /api/trips?offset=0&limit=20&q=&city=&sort=updated|created|name`

- `limit` 默认 20、上限 50；`offset` 默认 0、负数按 0 处理。
- `q` 同时匹配 title 与 destination，子串包含（大小写不敏感）。`%`、`_`、`\` 需转义后走 `ilike '%…%'`。
- `city` 精确匹配 destination；空字符串表示不筛选。
- `sort` 三选一，与现有前端三种排序同名；非法值回落 `updated`。
- 响应改为对象：`{ items: TripListItem[]; total: number; destinations: string[] }`
  - `total` = 应用同一筛选后的行程条数。
  - `destinations` = 该用户全部行程的目的地去重升序（不受筛选影响），供「目的地」下拉使用；单用户 ≤100 行，每次请求都算是可接受的成本。

## SQL 设计（PostgreSQL）

关键点：**筛选必须作用在「每条版本链的最新行」之上**。`WHERE` 在 `DISTINCT ON` 之前求值，所以不能把筛选写进同一个 `distinct on` 查询，否则旧版本命中会让列表回退显示旧内容。

```sql
-- 内层：每个 root_id 取最新版本（只按 user_id 过滤）
select distinct on (root_id) * from trips
where user_id = $1
order by root_id, version desc

-- 外层：筛选 + 排序 + 分页
select * from (<内层>) latest
where (destination = $city) and (title ilike $q or destination ilike $q)
order by updated_at desc, title asc
limit $limit offset $offset

-- 计数：同样的外层条件
select count(*) from (<内层>) latest where <同外层筛选>
```

`destinations`：`select distinct destination from trips where user_id = $1 order by destination`。

**已知差异（记录，不在本次修）**：前端原本用 `localeCompare('zh-CN')` 排「行程名称」，服务端用数据库默认 collation，中文排序结果可能与之前不同。三个排序都以 `title`/`id` 作为稳定的次级键。

## 前端设计

- `useTrips(filters)` 改为 `useInfiniteQuery`，`queryKey` 含筛选条件（切换筛选自动从第一页重来），`initialPageParam: 0`，`getNextPageParam` 用「已加载条数 < total」判定。
- `TripListPage` 用 `IntersectionObserver` 观察网格底部哨兵，进入视口时 `fetchNextPage()`；加载中显示占位并阻止重复触发。
- 计数、空态、`destinations` 下拉都取第一页响应里的 `total` / `destinations`。
- 服务端 3 列 / 平板 2 列 / 手机 1 列的网格与现有卡片样式不变。

## 需要同步更新的调用方与测试夹具

- `apps/web/tests/trip-collection-browser.mjs`、`handwriting-browser.mjs`、`picker-browser.mjs`、`shared-ui-browser.mjs`：`/api/trips` 的 mock 从数组改为 `{ items, total, destinations }`。
- `scripts/verify-c2.mjs`、`scripts/verify-security.mjs`：`GET /api/trips` 的响应断言从 `Array.isArray` 改为读 `items`。

## 验收条件

- [x] 列表首屏只请求并渲染 20 条；滚动到底自动加载下一批，直到加载完。
- [x] 关键词、目的地、排序三者组合后在服务端生效，切换筛选回到第一批。
- [x] 计数显示筛选后总数；无结果与请求失败的空态/重试行为不回退。
- [x] 「目的地」下拉仍列出全部目的地（不只当前已加载页）。
- [x] 版本链只显示最新版（含「旧版本命中筛选词」的边界用例）。
- [x] 已有调用方与测试夹具同步更新；typecheck、构建、相关浏览器验证通过。

## 实施记录

| 位置 | 改动 |
| --- | --- |
| `packages/shared/src/constants.ts` | 新增 `TRIP_LIST_PAGE_SIZE = 20`、`TRIP_LIST_PAGE_SIZE_MAX = 50` |
| `packages/shared/src/types.ts` | 新增 `TRIP_LIST_SORTS`/`TripListSort`/`TripListPage`（`{ items, total, destinations }`） |
| `apps/server/src/services/tripService.ts` | `listTrips` → `listTripsPage`：内层 `distinct on (root_id)` 取最新版，外层筛选 + 排序 + `limit/offset`；`total` 与 `destinations` 并行查 |
| `apps/server/src/routes/trips.ts` | `GET /` 加 querystring schema（`offset/limit/q/city/sort`），非法 `limit` 直接 400 |
| `apps/web/src/api/hooks.ts` | `useTrips(filters)` 改 `useInfiniteQuery`，queryKey 带筛选条件 |
| `apps/web/src/pages/TripListPage.tsx` | 删除前端筛选/排序 useMemo；`items` 由 pages 摊平；哨兵 `IntersectionObserver` 触发 `fetchNextPage`；计数/空态改用 `total` |
| 四个 `apps/web/tests/*-browser.mjs` | `/api/trips` mock 改为新形状；`trip-collection` 的 mock 补服务端筛选/排序/分页，并新增 25 条 fixture 的滚动用例 |
| `scripts/verify-c2.mjs`、`verify-security.mjs` | 列表响应断言改读 `items`/`total` |
| `.trellis/spec/web/frontend/component-guidelines.md` | 记录服务端分页约定与 `DISTINCT ON` 的坑 |

## 验证证据

- 真实数据（52 条）：首屏 `.collection-card` 20 张 → 滚到底 40 → 52 后停止；`?city=杭州` 后 9 张且计数「找到 9 份行程」；加载满 52 条后切 `sort=name` 回到 20 条。
- API 直测：`limit=999` → 400；`q=%` → total 0（LIKE 元字符已转义）；`offset=40` → 12 条、total 52；`q=北京` → total 31 且全部命中。
- 版本链行程在列表中只出现一次（`version` 为链上最大值）。
- `tsc --noEmit` 三个包 + `npm run build -w apps/web` 通过；`trip-collection-browser`、`handwriting-browser`、`picker-browser`、`shared-ui-browser` 全部通过。

## 遗留（既有问题，非本任务引入）

- `apps/web/tests/editor-browser.mjs:156` 等待 `.editor-body.without-chat`：当前 `TripEditorPage` 的 `editor-body` 只挂 `has-chat`，该类已不再产生。查了工作区未提交改动，`without-chat` 只剩测试与 CSS 选择器引用，属于对话面板常驻改造后的遗留。本任务只修了它因缺 `/api/trips/:id/versions` mock 而直接崩溃的部分。
- 三个浏览器测试（trip-collection、handwriting、editor）此前都缺 `/api/trips/:id/versions` mock，编辑器进入时读版本链会抛 `Cannot read properties of undefined (reading 'reduce')`。已补 mock。

## 范围外

- 不改卡片视觉、不做虚拟滚动（每批 20 条，DOM 量可控）。
- 不做按需删除/批量操作等新功能。
- 不改 `MAX_TRIPS_PER_USER` 与版本链机制。
