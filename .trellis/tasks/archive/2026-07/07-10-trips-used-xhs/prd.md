# 修复 trips 缺少 used_xhs 列导致生成失败

## Goal

修复旧版 SQLite 数据库升级后 `trips` 表缺少 `used_xhs` 列的问题，确保生成完成后的行程可以正常落库，并且失败不会错误消耗今日生成配额。

## What I already know

* 用户遇到错误：`table trips has no column named used_xhs`。
* `apps/server/src/db/schema.ts` 已将 `trips.used_xhs` 定义为非空整数，默认值为 `0`。
* `apps/server/src/db/migrate.ts` 的新建表 SQL 已包含 `trips.used_xhs`，因此新数据库不受影响。
* 启动迁移已通过 `ensureColumn` 为旧版 `generations` 表补齐字段，但尚未为旧版 `trips` 表补齐 `used_xhs`。
* `apps/server/src/services/tripService.ts` 在生成或导入行程时会写入 `used_xhs`，因此旧数据库会在插入阶段失败。

## Assumptions (temporary)

* 当前线上或本地数据库是在加入 `trips.used_xhs` 之前创建的。
* 本次采用项目既有的幂等启动迁移方式，不引入 drizzle-kit 或一次性手工 SQL。

## Open Questions

* None.

## Requirements (evolving)

* 服务启动时检查存量 `trips` 表是否缺少 `used_xhs`。
* 缺少时以 `INTEGER NOT NULL DEFAULT 0` 幂等补列。
* 扩展现有 `scripts/verify-c2.mjs`，覆盖旧版 `trips` 表缺列后的启动升级与写入场景。
* 新建数据库的现有建表行为保持不变。
* 不修改现有行程 JSON、配额规则或生成业务语义。

## Acceptance Criteria (evolving)

* [x] 使用不含 `used_xhs` 的旧版 `trips` 表启动服务后，该列被自动补齐。
* [x] 迁移后可以正常创建包含 `usedXhs` 摘要字段的行程。
* [x] 重复启动不会因重复加列而失败。
* [x] `npm run typecheck` 通过。
* [x] 扩展后的 `node scripts/verify-c2.mjs` 通过。

## Definition of Done (team quality bar)

* Tests added/updated when they materially reduce migration regression risk.
* Lint / typecheck / relevant verification green.
* Schema and startup migration definitions remain synchronized.
* Rollback risk is limited to an additive SQLite column with a safe default.

## Out of Scope (explicit)

* 删除或重命名历史 `used_xhs` 字段。
* 调整生成配额、失败计费或数据源策略。
* 引入新的数据库迁移框架。

## Technical Notes

* Root cause: `apps/server/src/db/migrate.ts` lacks `ensureColumn(sqlite, 'trips', 'used_xhs', ...)` for existing databases.
* Relevant code: `apps/server/src/db/schema.ts`, `apps/server/src/db/migrate.ts`, `apps/server/src/services/tripService.ts`.
* Relevant specs: `.trellis/spec/server/backend/index.md`, `.trellis/spec/server/backend/database-guidelines.md`, `.trellis/spec/server/backend/quality-guidelines.md`.
* The project intentionally uses idempotent startup migrations with `better-sqlite3` rather than a migration history.
* Verification: `npm run typecheck` and `node scripts/verify-c2.mjs` both exited with code `0`; C2 confirmed the legacy column migration and a successful generated-trip write with `used_xhs=0`.
* Remaining low-risk coverage gap: C2 does not restart the same database twice, although `ensureColumn` statically skips columns that already exist.
