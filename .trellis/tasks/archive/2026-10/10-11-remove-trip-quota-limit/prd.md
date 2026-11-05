# 移除单用户行程数量上限

## Goal

对话内修订行程时出现 409「行程数量已达上限（100 条），请先清理历史行程」，导致整轮对话回滚。根因是 `MAX_TRIPS_PER_USER` 计数口径在 09-23 版本链上线后从「行程数」漂移成「表行数（含全部历史版本）」，名实不符。用户决定移除该上限：个人自用场景下历史版本量可控，不值得为它保留一个会误伤正常使用的判据。同时把「删除行程」修成按版本链级联，避免限额移除后「删了行程、历史版本仍在库里」成为新的困惑。

## Requirements

* 移除 `createTrip` 中的行数判据与 409 抛错分支（`apps/server/src/services/tripService.ts:147-150`）
* 移除 `MAX_TRIPS_PER_USER` 常量定义（`packages/shared/src/constants.ts:12`）及其 import（`tripService.ts:5`）
* 在常量原位留一行注释记录「为什么不再限制」，避免后续会话当作遗漏而重新加回
* `deleteTrip` 改为按 `rootId` 级联删除整条版本链；传链上任意版本 id 都删整条链
* `deleteTrip` 与 `createTrip` 共用 `users` 行锁（`lockTripWriter`），消除「删除整链」与「并发创建新版本」的竞态
* 新增单测锁定：① 累计超过 100 行时 `createTrip` 不再抛 409；② 传历史版本 id 删除会清空整条链；③ 越权与他人的链不受影响
* 改写 `.trellis/spec/server/backend/place-identity.md:109` 中依赖该限额的论据

## Acceptance Criteria

* [x] 单用户在 `trips` 表累计超过 100 行时，`createTrip` 不再抛 409 —— 由单测「超 100 行仍可创建」断言
* [x] 对话内修订行程不再出现「行程数量已达上限」错误 —— 该 409 分支与文案已从 `tripService.ts` 删除
* [x] `deleteTrip(userId, 任意版本id)` 后该 `rootId` 下 0 行 —— 单测用 version=3 的中间版本 id 删除后断言 0 行
* [x] `deleteTrip` 删他人行程返回 `false`，路由仍 404 —— 单测断言 false；`routes/trips.ts:138` 未改动
* [x] 同一用户的其他版本链不受删除影响 —— 单测断言另一条链仍为 1 行
* [x] 无代码引用 `MAX_TRIPS_PER_USER`（`constants.ts:12` 的溯源注释仍提及原名，grep 的唯一命中就是它）
* [x] `npm run typecheck` 通过（shared + server + web + eval）
* [x] 新增单测通过（2/2；全量 server 套件 654/654，`--test-concurrency=1`）

## Definition of Done

* `npm run typecheck` 绿色
* 新增单测在一次性测试库上通过
* `.trellis/spec/server/backend/place-identity.md:109` 已改写
* 无遗留死代码（无用 import、无引用常量）

## Technical Approach

改 3 个文件、新增 1 个测试文件：

1. `packages/shared/src/constants.ts` — 删除常量，原位留一行说明性注释（常量区已有同类注释风格）
2. `apps/server/src/services/tripService.ts` —
   * 删除 import 成员、删除 `count(*)` 判据与 409 分支
   * `deleteTrip` 改为事务内 `lockTripWriter` → 查 `rootId` → 按 `(userId, rootId)` 删除
3. `.trellis/spec/server/backend/place-identity.md:109` — 测试账号纪律的理由改为「避免跨场景数据互相污染」
4. `apps/server/src/__tests__/tripDeleteHistory.test.ts` — 新增；沿用 `placeAvailabilityImport.test.ts` 的真实 PG 夹具风格（`pool.connect` + 直接 INSERT `users` / `trips`）

不需要改数据库 schema 或迁移：`idx_trips_root (root_id, version DESC)` 已覆盖级联删除的 `WHERE root_id` 条件。

## Decision (ADR-lite)

**Context**：`MAX_TRIPS_PER_USER = 100` 在首次提交 `233f6ee`（M1+M2，一行 = 一条行程）引入，用于兜住当时无分页的列表接口（一次全取 + JS 归并）。09-23 `c516655` 引入版本链后，一行语义变为「一个版本快照」，`count(*)` 随之变成行数上限，但常量名、错误文案、判据三处都未同步。10-03 分页任务的 PRD 已把它记为「行数上限，含版本链」并明确决定不改。用户本次决定移除限额，并顺带修掉 `deleteTrip` 只删单行的行为。

**Decision**：
1. 移除限额，不做计数口径修正（`count(distinct root_id)`）
2. `deleteTrip` 级联整条版本链，传任一版本 id 即视为删除该行程

**Consequences**：
* 解除对话修订被 409 打断的问题，不需要先设计「版本留存策略」
* `listTripsPage` 内层 `distinct on (root_id)` 的扫描行数仍随历史版本累积增长 —— 移除判据后它是唯一随行数增长的读路径，后续若实测变慢再评估
* `listTripVersions` 不分页 + `HistoryPanel` 全量渲染，理论上可被超长版本链拖慢；已确认个人使用量级可接受，不预先优化
* 删除不可逆且范围扩大（从一行变成整条链）；当前前端无删除入口（`useDeleteTrip` 定义在 `hooks.ts:241` 但无调用点），API 层由 `scripts/verify-security.mjs` 的越权断言覆盖

## Out of Scope

* `listTripVersions` 分页 / 历史版本面板虚拟滚动
* 版本留存策略（保留最近 N 版 + 里程碑版）
* `trip_share_images` 行与 `data/media/share-posters/` 磁盘文件的孤儿清理（`SharePosterStore` 只有 `find`/`save`，加删除方法会波及接口与内存实现；见 Technical Notes 影响评估）
* 生成路径（`orchestrator.ts`）把非白名单错误统一替换成「生成失败，请稍后重试」导致真实原因被吞的问题
* `detail_operations` 幂等缓存行、`chat_messages.related_trip_id` / `generations.trip_id` / `generation_notifications.trip_id` 等指向已删行程的历史引用（前者在极端重放下会返回一个已删行程 id）

## Technical Notes

**引用点（全仓 grep `MAX_TRIPS_PER_USER`，仅 2 个源文件）**

| 位置 | 内容 |
|---|---|
| `packages/shared/src/constants.ts:12` | `export const MAX_TRIPS_PER_USER = 100;`（无注释） |
| `apps/server/src/services/tripService.ts:5` | import 成员 |
| `apps/server/src/services/tripService.ts:148-149` | `count(*)` 判据 + 409 抛错 |

前端（`apps/web`）无任何引用；无单元测试或 e2e 断言覆盖该上限，移除不需要连带修改测试。

**相关索引**（`apps/server/src/db/migrate.ts`）

* `:120 idx_trips_user ON trips(user_id, updated_at DESC)`
* `:285 idx_trips_root ON trips(root_id, version DESC)` — 级联删除 `WHERE user_id AND root_id` 可直接用它

**下游影响路径**（已核实）

* `detailChatService.ts:186` — 对话修订成功后 `createTrip(..., trip.id, tx)`，409 在此抛出，整轮 `commitOperation` 事务回滚
* `routes/detailChat.ts:58-60` — SSE error 只掩盖 `statusCode >= 500`，409 原文透传给前端
* `generation/orchestrator.ts:492` — 生成路径同样走 `createTrip`，但 catch 后 `failJob` 把真实原因替换为「生成失败，请稍后重试」

**级联删除后仍会残留的关联数据**（本次不处理，记录影响）

| 位置 | 残留内容 | 影响 |
|---|---|---|
| `trip_share_images` | 每版一行（主键 `trip_id + style`） | 孤儿行，URL 不可达；海报文件留在磁盘 |
| `data/media/share-posters/` | 内容寻址的 png/jpg/webp | 磁盘占用，个人量级可忽略 |
| `chat_messages.related_trip_id` / `generations.trip_id` / `generation_notifications.trip_id` | 指向已删行程 | 历史日志性质，保留；点击跳转的行程页会 404 |

**本机测试环境**（与文档中的 docker 说明不同）

* 本机未安装 docker（`docker` 命令不存在），不能使用 `docker compose exec db psql`
* PostgreSQL 直接跑在 Windows 上：`127.0.0.1:5432`（`postgres:postgres`，可用）、`127.0.0.1:18798`（无密码，10-06 任务的专用库）
* 无 `.env` 文件，`DATABASE_URL` 需在命令里显式注入
* 单测命令：`$env:MASTER_KEY='a'*64; $env:DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/<一次性库>'; node --import tsx --test apps/server/src/__tests__/tripDeleteHistory.test.ts`

**历史证据**

* `233f6ee` feat: 织程 TripWeaver M1+M2 —— 常量与判据首次引入
* `c516655` feat(server): 对话内修订与行程版本链（09-23）—— `createTrip` 增加 `revisionOf`，`count(*)` 语义漂移
* `.trellis/tasks/archive/2026-10/10-03-trip-list-scroll-pagination/prd.md:15,104` —— 已记录该口径问题并决定不改
* `.trellis/spec/server/backend/place-identity.md:109` —— 「同城50个以上场景共用账号会累计触发产品100条行程上限；不得提高产品限额或清除中途数据来掩盖测试污染」
