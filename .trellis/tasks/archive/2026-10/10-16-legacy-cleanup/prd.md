# 清理遗留代码、数据与过时文档

## 背景

项目经历了几轮大改（SQLite→PostgreSQL+pgvector、本地媒体→S3/R2、LLM 编排→确定性排程、预算面板下线），
迁移过程中留下三类债务：本地无用产物、仓库里的一次性脚本/僵尸代码、与实现脱节的文档表述。

本任务只做**删除类清理**，不做重构、不引入新功能。

## 已确认的范围（用户决策 2026-10-16）

| 项 | 决策 |
| --- | --- |
| `data/media` + `data/photo-store`（325MB，S3 回滚点） | **保留** |
| 16 个 `test-*.mts` 探针脚本 | **全部删除** |
| `budget.ts` + `BudgetSummary` + `budget.test.ts` | **删除** |
| 线上库 `place_identity_imports`（2.6GB） | **本轮不处理** |

## 排查中修正的三处误判（重要）

初版清单里列错的三项，清理时**不要**动手：

1. `apps/server/scripts/migrate-media-to-s3.mts` —— **不是**遗留脚本。README 明确把它当长期运维工具：
   无参数为预演、`--apply` 上传、`--report` 看用量，且迁移幂等，新增文件需重复执行。**保留**。
2. `apps/web/src/components/editor/LeafletCanvas.tsx` —— **不是**死代码。它是地图的既定降级路径
   （`MapView.tsx` 顶部注释：未配高德 JS Key / SDK 加载失败 / 8s 超时都静默回落 Leaflet）。**保留**。
3. `data/`、`verify-shots/`、`*.db`、`.env.tmp`、`import/` —— 均已在 `.gitignore` 中，
   删除它们是**纯本地磁盘回收，不产生任何 git 改动**。

> 误判原因：首轮用 `Select-String -Path apps/web/src/**` 做引用检索，PowerShell 该写法不递归，导致漏检。
> 后续所有引用检索必须用 `Get-ChildItem -Recurse | Select-String`。

## 清理批次

### 批次 A：本地测试产物（无 git 影响，可逆性＝不可逆但无版本价值）

删除内容：

- `apps/server/data/` 下全部 `*.db` / `*.db-shm` / `*.db-wal`
  （含 `tripweaver.db` 及 5 套 `verify-generation-timing-*.db`，共 2.9MB）
- `apps/server/.env.tmp`（51 行，是根 `.env.example` 181 行的旧版残留；`apps/server/.env.example` 并不存在）
- 根 `data/` 下**纯测试产物**目录（不含 media / photo-store）：
  `photo-pilot`、`task-closeout`、`detail-chat-live-profile`、`place-identity-pg`、`trip-advice-pg`、
  `detail-chat-pg`、`export-dialog-ui-pg`、`home-mobile-verification`、`chat-input-focus`、
  `detail-chat-verification`、`detail-chat-live`、`pgvector-build`、`travel-preferences-review`、
  `detail-chat-qa-history`、`qa-photo-policy-1001-01`、`backups`
- 根 `data/` 下散落文件：`*.log`、`pgvector-0.8.2.zip`、`tripweaver.db`
- `verify-shots/` 全目录（22.7MB）

预期回收：约 **960MB**

**保留**：`data/media`（307MB）、`data/photo-store`（18MB）

### 批次 B：一次性迁移脚本（tracked，需提交）

- `apps/server/scripts/migrate-sqlite-to-pg.ts` —— 全仓库无任何引用，SQLite 已彻底淘汰。

### 批次 C：根目录调试探针（16 个 tracked 文件）

`apps/server/` 根：`test-beijing-rag.mts`、`test-coord-system-check.mts`、`test-gen-timing.mts`、
`test-geo-latency.mts`、`test-kb-shape.mts`、`test-llm-log-check.mts`、`test-llm-output-probe.mts`、
`test-name-check.mts`、`test-pg-latency.mts`、`test-rag-latency.mts`、`test-rag-strength.mts`、
`test-rank-probe.mts`、`test-reasoning-effort.mts`、`test-schedule-preview.mts`、`test-source-probe.mts`

`apps/web/` 根：`test-timeline-llm.mts`

判定依据：这些是排查 RAG 召回、接口延迟、模型输出时的一次性探针，未纳入 Vitest（`src/__tests__/`）
也未纳入 `eval/`，且散落在应用根目录而非 `scripts/`。

### 批次 D：违反环境约束的 Python 脚本（已撤销）

- `apps/server/scripts/install-curated-photos.py` —— **不删**。

首轮判定错误。复查发现：该脚本被 `apps/server/src/data/photography/README.md` 正式文档化为
「精选媒体校验 / 恢复」的标准工具（`--city beijing` 校验、`--download` 需 Pillow 恢复缺失原图），
它也是已保留的 `data/media` 回滚点唯一的重建途径；且本机实际装有 Python 3.13 与 Pillow 12.2.0，
脚本可正常执行。AGENTS.md 里「无 Python 环境」的前提不成立，不能据此判它为遗留。

### 批次 E：僵尸预算代码（tracked）

删 `computeBudgetSummary` 一整条链路，改动点：

- 删 `packages/shared/src/budget.ts`
- 删 `apps/server/src/__tests__/budget.test.ts`
- `packages/shared/src/types.ts`：删 `BudgetSummary` 接口
- `packages/shared/src/index.ts`：删 budget 相关导出

判定依据：全仓库检索 `computeBudgetSummary|BudgetSummary` 只命中自身与自身测试；
`budget.ts` 注释声称「与审校 Agent 的 `get_budget_status` 工具共用」，
但 `reviewTools.ts` 现只注册 `submit_review`，该工具已不存在；前端无任何预算渲染。

### 批次 F：文档与实现对齐（tracked）

已改：

- `docs/TECHNICAL_ARCHITECTURE.md` 架构图：`②编排 Agent ─▶ Nominatim / DraftTrip` 与
  `③审校 Agent ─▶ 预算聚合` → `②确定性排程（纯代码，不走模型）`、`③审校+撰写 ─▶ DraftTrip / 知识库证据`；
  `①调研 Agent` 的数据源由「PoiSource(高德)」改为「地点搜索(天地图)」，与实际固定走天地图一致。
- `docs/PRD.md` 流水线表 ②③ 两行同步改口径；PRD 护城河表里已下线的「预算聚合」改为「确定性排程」。

**本轮不改、留待决策（历史/策略文档，不宜改写）**：

- `docs/TECHNICAL_ARCHITECTURE.md:132`（v0.5 ST3 增量条目）仍描述已删除的 `BudgetSummary`。
  属版本变更记录，改写它等于改动历史。
- `docs/COMPETITIVE_ANALYSIS.md:97/104` 仍把「预算聚合」列为护城河能力。属竞品分析快照。

## 实施中新发现（后续轮已处理）

### 1. `scripts/verify-*.mjs` 里的 SQLite 时代残留（批次 H/I，已处理）

服务端 `apps/server/src` 已无任何 SQLite 代码，`DATABASE_PATH` 也已被彻底移除，但 12 个
`scripts/verify-*.mjs` 里有 8 个未随之迁移。用户决策：**全删**。

删除的 9 个（含 `verify-m1.mjs`）：

| 类别 | 脚本 |
| --- | --- |
| 必然崩溃（import 已删模块 + 读不存在的 `.sqlite` 导出） | `verify-amap-settings.mjs`、`verify-websearch-settings.mjs` |
| 静默打到真实 `DATABASE_URL`（dev 库） | `verify-amap-settings-browser.mjs`、`verify-websearch-settings-browser.mjs`、`verify-auth-modes.mjs`、`verify-d1.mjs`、`verify-generation-timing.mjs`、`verify-security.mjs` |
| 里程碑时代脚本 | `verify-m1.mjs` |

保留的 3 个（已迁到 PG，直接用 `DATABASE_URL` 建临时库）：`verify-c2.mjs`、`verify-c3.mjs`、
`verify-generation-browser.mjs`。CI 只跑 `verify-c2.mjs`，不受影响。

顺手移除 `apps/server/package.json` 的 `better-sqlite3` + `@types/better-sqlite3`，
`npm install` 后 lockfile 仅剩 `drizzle-orm` 的 optional peerDependencies 声明（预期保留）。

注：`apps/server/data/` 空目录**必须保留** —— `.github/workflows/ci.yml:93` 的容器重启冒烟测试
在其中写 `restart-marker`。

### 2. README 失效命令清单（已修正）

`README.md:197-201` 原推荐 `verify-security.mjs` / `verify-auth-modes.mjs` / `verify-d1.mjs`，
三者已随批次 H 删除。经用户确认后**已跨任务修正**（这三行是 `10-14-readme` 写入的）：

- 删掉 3 条失效命令
- `npm run build && node scripts/verify-c3.mjs && node scripts/verify-d1.mjs` → 去掉已删的 `verify-d1.mjs`
- 逐个复验 README 引用的 7 个 script 路径，全部存在

### 3. 未处理：线上库 `place_identity_imports`（2.6GB）

按用户决策本轮不处理。

### 批次 J：本地测试产物尾巴（第二类）

按用户决策删除 `data/backups`（11 文件）与 `data/pgvector-build`（173 文件），均已在 `.gitignore` 内。
删后 `data/` 只剩 `media` 与 `photo-store` 两个回滚点。

### 批次 H/I：删未迁移的 verify 脚本 + 移除 better-sqlite3 依赖

见文末「实施中新发现」第 1 节。

## 验证方式

1. 批次 A：删除后 `git status --porcelain` 应**无新增改动**（全部在 .gitignore 内）；
   复查 `data/` 下 `media`、`photo-store` 仍在。
2. 批次 B/C/E：`npm run typecheck` 通过；`node --import tsx scripts/verify-sql-first.mts` 中
   与 shared 相关的测试仍通过（budget 用例已随文件删除）。
3. 批次 F：`grep 编排 Agent docs/` 应无残留；README 与架构文档口径一致。
4. 全量：`npm run typecheck` + 现有回归脚本，确认没有代码仍在 import 被删模块
   （TypeScript 会直接报错，属最强保证）。

## 不做的事

- 不重构 `LeafletCanvas`，不动地图引擎选择逻辑
- 不动 `migrate-media-to-s3.mts`
- 不删本地媒体回滚点
- 不碰线上数据库
- 不处理 `.env.example` 里历史变量的兼容注释（无功能影响，非本轮范围）
