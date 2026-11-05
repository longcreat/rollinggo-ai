# PRD：PostgreSQL 迁移 + RAG 入口地基

- 任务：`09-18-postgres-migration-rag-foundation`
- 创建：2026-09-18 / aimer
- 优先级：P2（但时机敏感——须在 M0-C 生产部署前完成）
- 关联调研：`.trellis/tasks/07-19-release-candidate-e2e-deployment/research/2026-09-17-tripstar-yuntu-competitor-analysis.md`

## 背景

当前持久层为 better-sqlite3 + Drizzle（同步 API），5 张表、~545 行数据访问代码，无裸 SQL 拼接。为支持多实例部署、JSONB 查询能力与后续 RAG（向量检索），迁移至 PostgreSQL 16。Yuntu 调研（启发 #4）验证了「已验证地点池作为一等公民」的价值，本次一并落地。

## 目标（In Scope）

1. **方言切换**：`drizzle-orm/better-sqlite3` → `drizzle-orm/node-postgres`（pg Pool）
   - `schema.ts`：`sqliteTable` → `pgTable`
   - 时间戳 `integer` → `timestamp({ withTimezone: true })`
   - 布尔伪列（`byok_enabled` 等 0/1 integer）→ `boolean`
   - `trips.data` TEXT → `jsonb`
2. **调用点 async 化**：services/routes/auth 中所有同步 drizzle 调用加 await（约 50 处，类型系统兜底）
3. **migrate.ts 平移**：保留「启动时幂等 DDL」风格（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`），不引入 drizzle-kit 迁移链
4. **数据迁移脚本**：一次性 SQLite → PG 导出/灌库脚本（users / sessions / user_settings / trips / generations）
5. **RAG 地基（只建表，不实现检索）**：
   - `CREATE EXTENSION IF NOT EXISTS vector`（pgvector 占位）
   - `canonical_places` 表：已验证地点池（city/name/category/lng/lat/source/verified/payload jsonb），承接金集 9 城 POI 资产化
   - `research_evidence` 表：调研语料（place_id 可空外键/kind/content/source_url/fetched_at）
   - **不加 embedding 列**——embedding 模型/维度未定，避免维度锁死；RAG 接入时 ALTER
6. **生成管线入口约定**：orchestrator 在「调研」与「起草」之间留 `retrieveContext(placeIds)` 调用点，当前返回空数组，不写抽象接口
7. **部署配套**：docker-compose 增 `postgres:16` 服务；`.env` 改 `DATABASE_URL`；文档说明本地无 Docker 时的替代（本地 PG 或 Neon/Supabase）
8. **金集 POI 回填脚本**：把金集 9 城验证 POI 灌入 canonical_places（verified=true, source='goldset'）

## 非目标（Out of Scope）

- 任何向量检索 / embedding 生成 / chunking 逻辑（M2 再说）
- Repository 抽象层 / 双数据库支持（YAGNI）
- drizzle-kit 完整迁移链
- 在线双写迁移（开发期数据量小，导出灌库即可）

## 验收标准

- [ ] `pnpm dev` 启动后连接 `DATABASE_URL` 指向的 PG，全部表（含 2 张新表）幂等建好
- [ ] 现有 API 回归通过：auth 登录/登出、settings 读写、trip CRUD、generation 配额计数
- [ ] 旧 SQLite 数据完整迁入（行数一致 + 抽样比对 trips.data JSON）
- [ ] `SELECT * FROM canonical_places WHERE verified` 返回金集 9 城 POI
- [ ] orchestrator 中 `retrieveContext` 调用点存在且返回空数组，生成流程不受影响
- [ ] docker-compose up 一键起 PG + server

## 风险

| 风险 | 缓解 |
|---|---|
| 同步→异步漏改 | drizzle pg 驱动类型强制 Promise，tsc 全量报错兜底 |
| 本地无 Docker（已知环境坑） | DATABASE_URL 支持外部实例；compose 仅部署用 |
| JSONB 迁移后 data 列查询行为差异 | 现状无 SQL 层 JSON 查询（应用层解析），风险低 |

## 工作量

约 1.5–2 天（方言切换 0.5d + 迁移脚本 0.5d + 新表与回填 0.5d + 部署验证并入 07-19）。
