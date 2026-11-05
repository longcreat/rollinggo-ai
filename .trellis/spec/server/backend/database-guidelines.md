# Database Guidelines

## Stack and Startup

The server uses PostgreSQL (Neon) with Drizzle ORM (`drizzle-orm/pg-core`; migrated 09-18,
superseding the old better-sqlite3 stack). `apps/server/src/db/client.ts` resolves
`env.databaseUrl`, creates the pg Pool, runs migrations, and exports the Drizzle client.
Importing the client during bootstrap performs this setup.

Migrations are idempotent startup SQL in `apps/server/src/db/migrate.ts`
(`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS`), executed in one transaction.
The pgvector extension is optional: when unavailable, embedding columns are skipped and
vector search degrades to null. Keep database work async; the pg driver is asynchronous.

## Schema and Migration Dual-Update Contract

Every database shape change must update both files in the same change:

1. `apps/server/src/db/schema.ts` defines the typed Drizzle model used by application code.
2. `apps/server/src/db/migrate.ts` defines idempotent startup SQL for fresh databases and
   `ensureColumn`/index operations for existing databases.

This project intentionally does not use a drizzle-kit migration history. A change only in
`schema.ts` typechecks but fails on upgraded databases; a change only in `migrate.ts` leaves
Drizzle types inaccurate. `scripts/verify-c2.mjs` creates a legacy `generations` table and
checks that startup migration adds current audit columns.

**Ordering rule for columns added later**: an index on a column that did not exist originally must be
created *after* the `ADD COLUMN IF NOT EXISTS` statements, never inside the `STATEMENTS` array. The
array runs first, so on an existing database `CREATE INDEX ... ON trips(root_id)` fails with
`column "root_id" does not exist` before the column is ever added. The same applies to backfills:
add the column, `UPDATE ... WHERE col IS NULL`, then `ALTER COLUMN col SET NOT NULL`, in that order.
`verify-c2.mjs` seeds a legacy row rather than an empty table, because `SET NOT NULL` cannot fail on
an empty table and would therefore hide a broken backfill.

## Naming and Storage Representation

- Drizzle properties use camelCase; PostgreSQL columns use snake_case.
- Identifiers are text IDs produced by the shared `uid()` helper.
- Timestamps are `TIMESTAMPTZ` columns written with `new Date()`.
- `trips.data` is the full JSON `Trip` source of truth; list columns are derived indexes and
  must be recomputed from the document on writes.

Representative paths: `apps/server/src/db/schema.ts`,
`apps/server/src/services/tripService.ts`, `packages/shared/src/schemas.ts`.

## Query and Ownership Patterns

- Include `userId` in protected read, update, and delete predicates.
- Return `null`/`false` for missing or non-owned resources so routes use the same 404.
- Use Drizzle query helpers rather than SQL string concatenation.
- Migration batches run inside a single PG transaction (BEGIN/COMMIT in `runMigrations`).

Representative paths: `apps/server/src/services/tripService.ts`,
`apps/server/src/services/quotaService.ts`, `apps/server/src/generation/jobManager.ts`.

### Generation transaction writer

`createTrip(userId, source, revisionOf?, writer = db)` accepts `TripWriter = Pick<typeof db, 'select' | 'insert' | 'update'>`.
All count/lineage reads and the insert use this writer. A caller coordinating a larger transaction
must pass its `tx`; a hidden global `db` query would escape the transaction.
Generation saves the trip and its `generations.status = 'done'` audit row inside one
`db.transaction`, then publishes `job_done` after COMMIT. An audit failure rolls back the trip.
Cancellation observed before the callback returns rolls back both writes; a committed result stays
successful. Error/cancel audit rows are best-effort writes after the in-memory terminal transition.
See the terminal/persistence scenario in `generation-guidelines.md` and
`node --import tsx scripts/verify-generation-flow.mts` for real PostgreSQL fault injection.

版本创建和原地保存共用 `users` 行锁。`assertLatestTrip` 在事务内拒绝旧版本和过期 `updatedAt`；
`updateTrip` 的时间戳至少增加 1ms。详情操作需原子写入 `detail_operations`，消息/Brief 服务接受
同一 writer，禁止另开事务逃逸。迁移、幂等和恢复规则见 [详情对话流与版本恢复](./detail-chat-history.md)。

行程身份是 `rootId`（一条行程 + 它的全部历史版本）。`deleteTrip(userId, 任一版本 id)` 在同一事务内
先持 `users` 行锁再删除该 `rootId` 下的全部版本行，所以删除不可逆且范围是整条链；未命中或越权
返回 `false`，由路由统一映射 404。删除不级联清理 `trip_share_images` 行与 `data/media/share-posters/`
磁盘成品，这两类残留按个人使用量级暂不处理。单用户行程数量不设上限（`MAX_TRIPS_PER_USER` 已于
10-11 移除，原因是版本链让它变成行数判据并误伤对话修订）。

## Common Mistakes

- Updating only one half of the schema/migration contract.
- Treating derived trip list columns as authoritative instead of `trips.data`.
- Accepting client-controlled `id`, `createdAt`, or ownership fields.
- Omitting `userId` from a mutation predicate.
