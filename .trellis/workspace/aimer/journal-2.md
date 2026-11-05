# Journal - aimer (Part 2)

> Continuation from `journal-1.md` (archived at ~2000 lines)
> Started: 2026-10-16

---



## Session 50: 遗留代码、本地产物与文档口径清理

**Date**: 2026-10-16
**Task**: 遗留代码、本地产物与文档口径清理
**Branch**: `master`

### Summary

清理 SQLite/本地媒体/SQLite 时代 verify 脚本遗留：删 35 文件 3123 行、本地回收 988MB，移除 better-sqlite3 依赖与已下线预算模块，架构图与 PRD 对齐确定性排程。typecheck 四包通过、verify-sql-first 90/90。

### Main Changes

### Main Changes

**本地产物清理（无 git 影响，约 988 MB / 8278 文件）**

按 `.trellis/spec/guides/workspace-cleanup.md` 的规程执行：`git status --porcelain -z -uall` + 字节级 UTF-8 解码枚举，与 `git ls-files -z` 全集求交集为空才删。清单留档在任务目录的 `cleanup-manifest.json`。

- `apps/server/data/*.db*`（含 5 套 `verify-generation-timing-*.db`）
- `apps/server/.env.tmp`
- 根 `data/` 下 16 个测试产物目录与散落 log / zip / db
- `verify-shots/`
- `data/backups`、`data/pgvector-build`

保留 `data/media`(307MB) 与 `data/photo-store`(18MB) —— README 指定的 S3 迁移回滚点。

**仓库内遗留删除（35 文件 / 3123 行）**

- `apps/server/scripts/migrate-sqlite-to-pg.ts` + 15 个根目录 `test-*.mts` 探针 + `apps/web/test-timeline-llm.mts`
- `apps/server/src/env.ts` 的 `env.databasePath`（唯一读者是被删的迁移脚本）与 `.env.example` 的 `DATABASE_PATH`
- `apps/server/package.json` 移除 `better-sqlite3` + `@types/better-sqlite3`（`npm install` 后 -35 packages）
- 9 个未迁移到 PG 的 `scripts/verify-*.mjs`
- `packages/shared/src/budget.ts` + `BudgetSummary` + `budget.test.ts`

**文档对齐**

- `docs/TECHNICAL_ARCHITECTURE.md` 架构图：②编排 Agent → ②确定性排程（纯代码）、③审校 Agent → ③审校+撰写；调研数据源「PoiSource(高德)」→「地点搜索(天地图)」
- `docs/PRD.md` 流水线表 ②③ 同步；护城河表「预算聚合」→「确定性排程」
- `README.md` 验证脚本清单删掉 3 条失效命令（**未随本任务提交，按用户决定并入 10-14-readme**）

### 判定修正记录

首轮报告有 4 处误判，均在实施中推翻，未造成损失：

1. `migrate-media-to-s3.mts` —— README 把它当长期运维工具（`--apply` / `--report`，幂等），保留
2. `LeafletCanvas.tsx` —— `MapView.tsx` 里的既定降级路径（未配 Key / SDK 失败 / 8s 超时都回落它），保留
3. `data/`、`verify-shots/`、`*.db`、`.env.tmp` —— 全在 `.gitignore` 内，删除不产生 git 改动
4. `install-curated-photos.py` —— 被 `apps/server/src/data/photography/README.md` 正式文档化为精选媒体校验/恢复工具，本机有 Python 3.13 + Pillow 12.2.0，保留

误判根因：首轮用 `Select-String -Path apps/web/src/**` 检索引用，PowerShell 该写法**不递归**，漏检了 `MapView.tsx` 的 import。后续全部改用 `Get-ChildItem -Recurse | Select-String`。

### 第二轮新发现（已处理）

12 个 `scripts/verify-*.mjs` 里有 8 个未随 SQLite→PG 迁移：

| 类别 | 脚本 | 症状 |
|---|---|---|
| 必然崩溃 | `verify-amap-settings`、`verify-websearch-settings` | import 已删除的 `integrations/amap/poiSource.ts`；读 `db/client.ts` 已不存在的 `.sqlite` 导出 |
| 静默打到真实 `DATABASE_URL` | `verify-amap-settings-browser`、`verify-websearch-settings-browser`、`verify-auth-modes`、`verify-d1`、`verify-generation-timing`、`verify-security` | 传 `DATABASE_PATH` 求隔离，但服务端已不读它 → 落到本机 dev 库 |

连同 `verify-m1.mjs` 共 9 个按用户决策全删。保留已迁移的 `verify-c2`（CI 在跑）、`verify-c3`、`verify-generation-browser`。

`apps/server/data/` 空目录**必须保留**：`.github/workflows/ci.yml:93` 的容器重启冒烟测试要在其中写 `restart-marker`。

### Testing

- `npm run typecheck` —— 四包（shared / server / web / eval）通过
- `node --import tsx scripts/verify-sql-first.mts` —— 90/90 pass
- `python ./.trellis/scripts/task.py validate .trellis/tasks/10-16-legacy-cleanup` —— implement.jsonl 9 条 / check.jsonl 5 条全部合法
- 逐提交核对 `git log --oneline -1` 确认变化，防止 `.git/index.lock` 竞态下的假成功
- 逐提交 `git show --stat` 确认无越界文件

### Status

[OK] **Completed**

### Next Steps

- `README.md` 的验证脚本修正留在工作区，并入 `10-14-readme` 提交
- 线上库 `place_identity_imports`（300 行 / 2.6GB JSONB 快照）未处理，用户决定另开任务
- 历史/策略文档保留原样：`TECHNICAL_ARCHITECTURE.md:132`（v0.5 ST3 变更记录提到已删的 `BudgetSummary`）、`COMPETITIVE_ANALYSIS.md:97/104`（把「预算聚合」当护城河）—— 改写等于改动历史


### Git Commits

| Hash | Message |
|------|---------|
| `6fed00d` | (see git log) |
| `a77818c` | (see git log) |
| `be00848` | (see git log) |
| `e9c5242` | (see git log) |
| `b3146ce` | (see git log) |
| `3effae2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 51: place_identity_imports 归档与截断

**Date**: 2026-10-17
**Task**: place_identity_imports 归档与截断
**Branch**: `master`

### Summary

本机 WSL dev 库该表 2636MB / 300 行已归档到 data/db-archive（1.03GB，恢复校验行数与 content_hash 全量一致）后 TRUNCATE，库 2791MB→155MB、表 24kB；线上库实测 0 行无需处理。verify-place-identity 22/22 通过。

### Main Changes

### Main Changes

**前提纠正**

原始诉求是「线上库 `place_identity_imports` 300 行占 2.6GB」。实测两边：

| | 库总大小 | 该表 |
| --- | --- | --- |
| 线上库（VPS `trip-weaver-db-1`） | 78 MB | **0 行** |
| 本机 WSL（`tripweaver-pg`） | 2791 MB | **2636 MB（占 94%）** |

线上库没有可清理内容，2.6GB 全在本机开发库。原判断把两侧混为一谈，已同步修正 memory。

**目标表构成**（截断前实测）

- 300 行，2026-10-06 ~ 10-12
- 111 行 payload > 10MB，最大 27MB，平均 8.6MB
- 14 行已回滚（payload 仅 24MB），286 行未回滚（2516MB）
- 城市：北京 26/641MB、厦门 44/524MB、济南 87/368MB、成都 32/230MB、重庆 20/221MB
- 日期：**10-09 一天 114 行 / 1213MB** 是大头

写入方 `goldsetPlaceImport.ts` / `seed-xhs-places.ts` / `seed-xhs-relations.ts`；
读取方只有 `rollback-place-identity.ts` 与测试，Web 运行时不碰。

**归档 → 校验 → 截断**

| | db 大小 | 表大小 | 行数 |
| --- | --- | --- | --- |
| 前 | 2791 MB | 2636 MB | 300 |
| 后 | **155 MB** | **24 kB** | **0** |

归档 `data/db-archive/place-identity-imports-20261016.dump`（1.03GB，`sha256 40f4001c…`），
在 `.gitignore` 的 `data/` 内不进版本库。恢复命令已写进 PRD。

### 踩坑记录

**1. 直接 dump 到 /mnt/d 会失败**

首次把 `pg_dump -Z9` 输出重定向到 D 盘，900 秒只写 784MB —— WSL `/mnt/d` 是 9p 挂载，
实测写入速率约 **0.9MB/s**。且 PowerShell 调用超时中断后，容器内 `pg_dump` 变成孤儿进程
（宿主 `pkill` 因命名空间隔离报 Operation not permitted，须 `docker exec` 进容器终止）。

改为两步后正常：先 dump 到 WSL 本地盘 `/tmp`，再整文件 `cp` 到 `/mnt/d`。
压缩参数从 `-Z9` 换成 `--compress=zstd:3`：**53 秒**完成（gzip -9 十几分钟仍未完）。

**2. `pg_restore --list` 不能验证 dump 完整性**

custom 格式的 TOC 写在文件头部，数据被截断时 `--list` 依然成功。必须实际恢复到临时库比对。

本次校验两条断言同时成立才继续：行数 300 = 300，`md5(string_agg(content_hash,…))`
源库与恢复库同为 `600c5290cb48c4113f95c84bde82da3a`。

### Testing

- 恢复校验：300 行 + content_hash 全量 md5 一致
- 结构校验：`\d place_identity_imports` 7 列齐全，`place_identity_imports_pkey` 与
  `idx_place_identity_imports_city` 两个索引都在
- 回归：`node --import tsx scripts/verify-place-identity.mts` → **22/22 pass**
  （自建 `place_identity_test_*` 库，覆盖审计写入 / 事务预演 / 幂等 / 回滚全链路）
- 临时库无残留（`tw_restore%` 匹配 0 行）
- WSL `df`：24G → 20G used

### Status

[OK] **Completed**

### Next Steps

- **Windows 侧空间未回收**：`ext4.vhdx` 仍是 28.02GB，而 WSL 内 `df` 只报 20G，差值是 vhdx 内部空洞。
  要在 Windows 看到回收需 `wsl --manage Ubuntu --set-sparse true`（或 `Optimize-VHD`），
  **要求先关闭 WSL**，而当前 WSL 内跑着 `tripweaver-pg`、`dataease`、`mysql-det` 三个容器。未执行。
- **会再长回来**：每次城市导入都写整城 JSONB 前后快照（北京 26 行就 641MB）。本轮只清存量，未改写入侧。
- **VPS 磁盘占比真因不是数据库**：`/` 29G 用 23G（80%），但 DB 只 78MB；真因是 docker
  images 6.271GB（4.861GB 可回收）与 build cache 681.4MB。用户决定本轮不处理。


### Git Commits

| Hash | Message |
|------|---------|
| `2b76ec2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

## Session 52: 注册邮箱验证码与三处 UI 修正

**Date**: 2026-10-18
**Task**: 注册邮箱验证码校验（`10-18-email-verification-register`）
**Branch**: `master`

### Summary

open 模式注册改为邮箱验证码校验，新增 `/api/auth/email-code` 与 `/api/auth/password-reset`，前端补验证码输入与「忘记密码？」入口；Resend 子域 `notify.sakiiko.com` 验证通过并已上线。顺带修三处 UI：通知图标手型光标、登录弹窗点遮罩不关闭、网页标题只保留中文。typecheck 四包通过，真实发信端到端验收通过。

### Main Changes

**验证码设施**

- `apps/server/src/auth/emailCode.ts`：生成 / 频控 / 校验 / 消费。只存 bcrypt 哈希，同一 `(email, purpose)` 只认最新未消费记录，用途隔离（注册码不能拿去重置密码）
- `apps/server/src/integrations/resend.ts`：Resend API 发信，`AbortSignal.timeout` 控制超时
- 新表 `email_verification_codes`（`migrate.ts` + `schema.ts`）
- 频控三道：同邮箱 60 秒重发间隔、同邮箱 5 次/小时、路由层 IP 10 次/小时
- 防枚举：注册码请求遇已注册邮箱、重置码请求遇不存在或 OAuth-only 账号，一律静默成功

**注册与找回密码**

- `routes/auth.ts`：`/register` 在 open 模式强制 `code`（查重放在验证码之前，已注册邮箱不白耗一个码）；新增 `/email-code` 与 `/password-reset`
- `/password-reset` 成功后删除该用户全部 `sessions`，旧会话立即失效
- `/config` 增加 `emailCodeEnabled`，前端据此禁用注册按钮并提示「邮件服务尚未配置」

**前端**

- `EmailCodeField.tsx`：验证码输入 + 60 秒倒计时按钮，注册与重置共用
- `ResetPasswordPage.tsx` + 登录弹窗新增「忘记密码？」入口（`LoginDialogProvider` 增加 `reset` 态）
- `RegisterPage`：open 模式显示验证码字段，invite 模式显示邀请码字段，二者互斥

**发信域名**

`mail.sakiiko.com` 已被临时邮箱服务占用（AAAA 100:: 走代理），改用 `notify.sakiiko.com`。Cloudflare 加 4 条记录后 Resend 验证通过：

| 类型 | 名称 | 值 |
|---|---|---|
| TXT | `resend._domainkey.notify.sakiiko.com` | DKIM 公钥 |
| MX (10) | `send.notify.sakiiko.com` | `feedback-smtp.ap-northeast-1.amazonses.com` |
| TXT | `send.notify.sakiiko.com` | `v=spf1 include:amazonses.com ~all` |
| CNAME | `rsend.notify.sakiiko.com` | `send.forge.rmta.net` |

**UI 修正**

- `NotificationCenter.tsx`：`<summary>` 补 `cursor-pointer`
- `Modal.tsx` 新增 `closeOnBackdrop`（默认 true），登录/注册/重置弹窗传 false；ESC 与 ✕ 仍可关闭
- `index.html`：标题 `织程 TripWeaver` → `织程`

**并发改动隔离**

`routes/auth.ts`、`db/schema.ts`、`shared/src/types.ts`、`api/hooks.ts` 工作区混有并发会话的未提交改动（10-17 注释任务、聊天改造）。用 `git apply --cached` 把本次的 hunk 单独写进索引后提交，他人改动原样留在工作区。

### Git Commits

| Hash | Message |
|------|---------|
| `6a8976b` | feat(server): 注册接入邮箱验证码并补找回密码 |
| `1e2cb15` | chore(task): 归档注册邮箱验证码任务 |
| `54fb6ef` | style(web): 登录注册弹窗点遮罩不关闭 |
| `54b84ba` | style(web): 网页标题只保留中文 |
| `e39ddda` | style(web): 通知图标显示手型光标 |

### Testing

- typecheck 四包全绿（提交前后各跑一次）
- 验证码消费语义单测 10/10：正确码消费、同码不可重用、错码失败、错码不占位、用途隔离双向、过期码、试错用尽、只认最新一条
- 真实 Resend 端到端：收到码 → 注册 201 → 新密码登录 200 → 重置 200 → 旧密码 401 → 新密码 200 → 重置码复用 400 → 会话数 2 降到 1
- invite 模式回归：临时端口起 `REGISTRATION_MODE=invite` 实例，无邀请码/错邀请码 403、正确邀请码 201 且不需验证码、注册码请求 403；前端注册卡片只有邀请码字段
- 线上验证：CI 构建成功 → 容器重建 → `/api/auth/config` 返回 `emailCodeEnabled: true` → 线上发信 Resend 记录 `delivered`
- Modal 遮罩：点边缘、点 backdrop 均不关闭，ESC 与 ✕ 正常关闭
- 标题：`/login` 与 `/` 的 `document.title` 均为 `织程`

### Status

[OK] **Completed**

### Next Steps

- 线上仍为 `REGISTRATION_MODE=open`；若以后切 invite，需再跑一次注册回归
- 本地工作区仍有三个文件残留并发会话的改动（`schema.ts` 的 intake 注释、`auth.ts` 的注释补全、`types.ts` 删 `BriefInputSchema`/`BriefIntake`），不归本会话处理

---

## Session 53: 通知改 SSE 推送与 Key 密文 500 修复

**Date**: 2026-10-18
**Task**: 通知推送改为 SSE 通道（`10-18-notifications-sse-stream`）
**Branch**: `master`

### Summary

通知中心原来 15 秒轮询，任务完成后红点最多晚 15 秒。改成服务端 SSE 主动推「有新通知」提示，前端收到只 invalidate 重查列表，轮询降为 60 秒兜底；事件允许丢失，DB 保持单一真相源。验收过程中顺带查出并修掉一个会把生成打成 500 的坑：LLM Key 密文解不开时异常没人接。typecheck 四包通过，verify-sql-first 93/93，真实生成端到端验过。

### Main Changes

**SSE 通道**

- `services/notificationStream.ts`：进程内 `userId → Set<listener>` 订阅表，`subscribeNotifications` / `publishNotification` / `notificationSubscriberCount`；单个监听器抛错不影响其他监听器与写入方
- `routes/notifications.ts` 新增 `GET /stream`（`requireAuth`）：`reply.hijack()` 后直写原始响应，`X-Accel-Buffering: no` 禁反代缓冲，15 秒 heartbeat，`res.on('close')` 里 `clearInterval` + `unsubscribe`
- publish 放在 service 层而非路由层，保证所有写入路径覆盖；`recordGenerationNotification` 增加 `options.publish`——事务内写入传 `false`，由调用方在 commit 之后自己 publish，否则前端会回查到空列表

**前端**

- `hooks/useNotificationStream.ts`：EventSource 订阅 `notification` 事件，收到后 invalidate `keys.notifications`；`kind === 'success'` 时同时失效行程列表与对应行程
- `NotificationCenter.tsx` 挂载时建立连接，卸载时 `close()`
- `useNotifications` 的 `refetchInterval` 15s → 60s（兜底），保留 `refetchOnWindowFocus`

**顺带修复：Key 密文损坏不再是 500**

`resolveLlmConfig` 里 `decryptSecret` 没有 try/catch，换成过 `MASTER_KEY` 或跨环境导库后密文解不开，异常一路抛到全局 errorHandler，用户侧看到「服务器内部错误」。实测 `a@test.dev` 复现：它的密文是 2026-07-06 写入的，对照 9-20 写入的账号解密正常，确认中途换过 `MASTER_KEY`。

修法与同文件里 `resolveAmapCredential` / `resolveSearchCredential` 已有的兜底对齐：解密失败打 warn + 按未配置个人 Key 处理，继续走站点 Key。补 3 条单测并加入 verify-sql-first 默认清单。

### Git Commits

| Hash | Message |
|------|---------|
| `4029f67` | fix(server): Key 密文损坏不再打成 500 |
| `ff2597d` | feat(server): 通知改为 SSE 实时推送 |
| `fe86051` | chore(task): 归档通知 SSE 推送任务 |

### Testing

- `npm run typecheck` 四包零错误；`verify-sql-first` 93/93（原 90 + 新增 3 条 settingsResolve）
- SSE 连接：库内造会话 + 节点 fetch 读流 → `200 text/event-stream`，`: connected` @1ms、`: heartbeat` @15.0s、@30.0s
- 真实生成端到端（`b@test.dev`，杭州 2 天）：`POST /api/generations` 202 → 43.4s 后完成，SSE 同一秒收到 `event: notification`；DB `created_at` 与事件到达差 <1s
- 关掉重开：断开 SSE 后新建会话 `GET /api/notifications` → 200，1 条（`readAt: null`），首屏兜底成立
- 500 修复：临时实例 8799（未动 8787）上 `a@test.dev` POST → 202（修复前 500），stderr 输出 `[settings] … 密文无法解密，已按未配置个人 Key 处理`；随后 `/cancel` 202 收尾

### Status

[OK] **Completed**

### Next Steps

- AC 第 4 条（关标签页后订阅表不残留）以单测替代真机：`notificationStream.test.ts` 覆盖退订语义，未验的只剩 `res.on('close')` 两行胶水
- 多副本部署会失效（进程内订阅表），届时需换 `pg_notify`，本期刻意不做
- 本地 8787 进程是 `tsx src/index.ts`（非 watch），两处修复要重启 dev server 才生效
- 工作区仍有 43 项未提交：`10-17-annotate-core-pipeline` 的注释改动混着另一条聊天改造线（`chat/`、`shared/chat.ts`、`chatDerive.ts`、删 `IntakeControls.tsx`），提交前必须切分
- 待办：`10-18-web-static-cache` 待验收；`10-11-401` 六条 AC 未跑；`10-12-cdn` 剩 5 条卡在 R2 桶与域名未配；`10-09-server-side-pdf-export` 连 prd 都没有

---

## Session 54: 静态缓存与首页背景任务复核归档

**Date**: 2026-10-18
**Task**: 线上静态资源缓存与首页背景图优化（`10-18-web-static-cache-and-home-bg`）
**Branch**: `master`

### Summary

任务代码早已分三次入库（`68914ba`、`475bbfe`、`96cf69a`），打开始时工作区已无对应改动，只剩归档。归档前按验收标准重跑了一遍可验证项：背景图体积、引用、web 构建、七类路径的 Cache-Control。

### Main Changes

无代码改动。仅补齐 prd 的复核记录并归档任务目录。

### 一个坑

静态资源托管被 `env.isProd` 包着，dev 实例请求 `/assets/*`、`/fonts/*` 会落到 SPA fallback，返回 `index.html` 内容 + `Cache-Control: public, max-age=0`。看起来像「缓存头没生效」，实际是根本没走到 fastifyStatic。复核缓存头必须用 `NODE_ENV=production` 起实例。

另：`/fonts/` 下是 `handwriting/` 与 `kinghwa/` 两个子目录，拼 URL 时不能直接用 `-Recurse` 后的裸文件名。

### 复核证据

- `home-bg.webp` 8.7KB（原 PNG 987.4KB）；`AppLayout.tsx:41`、`Modal.tsx:34` 均引用 `/home-bg.webp`
- `npm run build -w apps/web` 通过（5.10s）
- `NODE_ENV=production` 临时实例（:8799）实测：`/assets/*` 与 `/fonts/**` → `max-age=31536000, immutable`；`/brand/*`、`/share-styles/*`、`/home-bg.webp` → `max-age=604800`；`/index.html` → `max-age=0`

### Git Commits

| Hash | Message |
|------|---------|
| `41d3e84` | chore(task): 归档静态缓存与首页背景任务 |

### Status

[OK] **Completed**

### Next Steps

- 字体分片的码位一致性与短标题命中片数未重跑（需 python 字体工具，证据留在任务目录 `research/`）
- 剩余：`10-17-annotate-core-pipeline`（需切分）、`10-11-401`（六条 AC 未跑）、`10-12-cdn`（卡 R2）、`10-09-server-side-pdf-export`（无 prd）

---

## Session 55: 未登录探测接口验收与两个漂移测试

**Date**: 2026-10-18
**Task**: 未登录探测接口 401 控制台噪音治理（`10-11-401`）
**Branch**: `master`

### Summary

`/api/auth/me` 改「未登录返 200 + data:null」的代码早在 `fac7f34` / `5001116` 入库，本次补跑六条 AC 并归档。验收中发现两个浏览器测试已长期漂移（登录改弹窗、注册加验证码两次产品变更都没同步测试），修完 5 个测试全 PASS。

### 验收结果

| AC | 结果 |
|---|---|
| 无 cookie `/api/auth/me` | `200` + `{"code":0,"message":"成功","data":null}` |
| 带有效会话 | `200` + `data:{id,email}` |
| 未登录 `/`、`/login`、`/trips` | 三页 `console error = 0`，`/api` 4xx+ = 0 |
| 未登录 `/trips` | 落地 `/` + 登录弹窗打开 |
| R5 四个浏览器测试 | 全 PASS |
| typecheck | 四包零错误 |

注意：`/login` 现在不是独立页，是「Layout 上的登录弹窗 + 路由重定向到 `/`」。验证「未登录会不会跳登录」不能只看 URL，要同时断言 `dialog[open]`。

### 修复的两个漂移测试

**`shared-ui-browser.mjs`**

1. 页头与弹窗各有一个「登录」按钮，`exact` 命中 2 个 → 全部限定在 `dialog[open]` / `getByRole('dialog', { name })` 内；弹窗里切注册是 `button` 不是 `link`
2. 注册表单新增 required 的邮箱验证码，留空时原生校验拦住 submit → 提交前先填验证码；`getByLabel('邮箱')` 非 exact 会同时命中「邮箱验证码」→ 加 `exact: true`
3. 删掉「设置」弹窗那段过期断言：`SettingsDialog` 全仓只有定义、无引用（死代码），弹窗根本打不开；Modal 的 aria-labelledby / 宽度 / ESC / 焦点恢复已由 `login-dialog-browser.mjs` 覆盖，移动端不溢出断言保留

**`login-dialog-browser.mjs`**：密码不一致路径与注册成功路径都补填验证码。

根因都属于 `10-18-email-verification-register` 加验证码时没同步测试，与 `/me` 改造无关。

### Git Commits

| Hash | Message |
|------|---------|
| `c290698` | fix(web): 同步登录弹窗后的浏览器测试 |
| `b8631b7` | chore(task): 归档未登录探测接口任务 |

### Status

[OK] **Completed**

### Next Steps

- `SettingsDialog.tsx` 仍是死代码（无引用），本次只记录未删除
- 浏览器测试必须用 `node --import tsx` 跑：直接 `node xxx.mjs` 无法解析 `packages/shared/src/*.ts`，会报 `file:///…/packages/shared/src/utils` 解析失败，容易误判成产品问题

---

## Session 56: 对话入口收敛与工作区切分

**Date**: 2026-10-18
**Task**: 对话入口收敛：追问控件下线与首页参数代收（`10-19-chat-intake-retire`）
**Branch**: `master`

### Summary

工作区积了 40+ 项未提交改动，表面看是「注释任务，代码早已写完后没提交」，实际拆开是 4 件独立的事：追问控件下线、生成孤儿任务误认领、通知两个行为修正、行程列表分页 12。先给 `10-17` 提交纯注释部分，再为剩下的功能线新建 `10-19` 任务，按主题拆 4 个提交。

### Main Changes

| 主题 | 提交 | 规模 |
|---|---|---|
| 行程列表分页 20 → 12 | `8179814` | +3/-2 |
| 生成孤儿任务不再被旧快照夺回 | `31a1c5d` | +22/-5 |
| 追问控件与 `/conversations/:id/messages` 下线 | `b5e7f7c` | 13 files, +67/-742 |
| 通知弹窗不再因跳转被抑制 + 滚动分页 | `88dd0a2` | +10/-3 |

### 策略：用 checkout + edit 代替手写 partial patch

两个文件同时含两个主题（`constants.ts` 的分页与 `INTAKE_ENUM_KINDS`、`hooks.ts` 的 `useCurrentGeneration` 与 intake 删除）。

**手写 partial patch 不可靠**：用了 `git apply --cached --unidiff-zero` 只带行号不带上下文，结果 hunk 插到了错误位置（`let doneNotification` 落进了 return 对象里，语法错误）。

可行做法：备份工作区版本 → `git checkout HEAD -- <file>` → 用 edit 工具只应用前一个主题的改动 → 提交 → 把备份写回。第二个主题提交时整文件 add 就行，因为此时 `git diff` 自然只剩后者的改动。

另一个坑：`git commit -- <paths>` 提交的是**工作区**内容，不是索引。所以用 partial patch 暂存部分 hunk 再带 pathspec 提交，会把整文件改动全带进去。切分过的文件要不用 pathspec 的 `git commit`，事前必须确认索引里只有预期文件。

### 一个踩到的错误

`709fb0b` 用 `git commit -- apps/server/src/routes`（目录）把 `routes/conversations.ts` 的 300 行删除一并带进了「只加注释」的提交。用 `git checkout 709fb0b~1 -- <file>` + 重新提交旧版（`088107f`）还原，改造内容退回工作区。教训：目录路径提交会把该目录下所有改动全带上，提交前先 `git diff -- <dir> --stat` 确认范围。

### 验收

- `npm run typecheck` 四包 EXIT=0
- `node --import tsx scripts/verify-sql-first.mts` 93/93
- `POST /api/conversations/:id/messages` → `404 Route … not found`；`GET /api/conversations` 也 404
- 5 个浏览器测试全 PASS
- 全仓 grep 无 `IntakeControls` / `BriefIntake` / `INTAKE_ENUM_KINDS` / `useConversations` 引用（只剩两处注释说明）

### Git Commits

| Hash | Message |
|------|---------|
| `709fb0b` | docs(server): 补主链路关键注释 |
| `088107f` | fix(server): 还原误并入注释提交的会话路由改动 |
| `8179814` | chore(shared): 行程列表分页改为 12 条 |
| `31a1c5d` | fix(web): 新生成不再被旧任务快照夺回 |
| `b5e7f7c` | refactor(shared): 追问控件下线 |
| `88dd0a2` | fix(web): 通知弹窗不再因跳转被抑制 |
| `c70a318` | chore(task): 归档对话入口收敛任务 |

### Status

[OK] **Completed**

### Next Steps

- `apps/web/src/components/SettingsDialog.tsx` 仍是死代码（全仓仅剩定义），未删
- `chat_messages.intake` 列保留，注释里标的任务号写的是 10-17，实际归 10-19
- 剩余：`10-17-annotate-core-pipeline`（注释已提交，考察题未做）、`10-12-cdn`（卡 R2 桶与域名）、`10-09-server-side-pdf-export`（无 prd）
- 剩余：`10-17-annotate-core-pipeline`（需切分）、`10-12-cdn`（卡 R2）、`10-09-server-side-pdf-export`（无 prd）

---

## Session 57: 分享海报品牌带与生图错误可见性

**Date**: 2026-10-21
**Task**: 分享海报加品牌带与二维码（`10-20-share-poster-brand`）
**Branch**: `master`

### Summary

AI 生成的海报是唯一会被转发出去的产物，但图上只有模型画的「AI 创作 · 织程」角标（中文长文本模型经常画错），没有域名、没有二维码。在落盘前合成一条 144px 品牌带：左侧域名与产品标识，右侧 112px 二维码指向站点首页。

验收过程中用户报「生图报错服务器内部错误」，顺带查出两个既有缺陷：全局错误处理把所有 5xx 的 message 吞成通用文案；降级链路只记录最后一站错误，三站同时故障时分不清是「降级没跑」还是「都挂了」。

### Main Changes

| 主题 | 提交 | 要点 |
|---|---|---|
| 品牌带合成 | `1339cd1` | `sharePosterBrand.ts` + 预渲染素材 + 生成脚本 + 6 条单测；新增 sharp / qrcode |
| 服务接入 | `8cb0096` | 合成放在 `store.save` 之前；`SHARE_BRAND_ENABLED` 开关 |
| 错误透出 | `b4f7a58` | `imageError` 带 `expose`，errorHandler 对带标记的 5xx 保留 message |
| 降级日志 | `6b79e8b` | 逐站记录序号、域名、耗时、原因 |
| 测试漂移 | `8b8a8d4` | 轮询 15s→60s 后的断言更新 |

### 关键决策：品牌带为什么是预渲染 PNG

生产镜像是 `node:22-alpine`，没有中文字体，运行时用 SVG 渲染中文会出方框。做法是在开发机用 `scripts/generate-share-brand-band.mts` 画好 1024×144 PNG 提交入库，运行时只贴图 + 贴二维码，不渲染任何文字。素材 9.7KB，可重复重建。

尺寸踩了一轮：初版 96px 带高 / 72px 二维码，在手机上缩到 26px 扫不出来；改为 144px / 112px（占宽度 11%）。

### 两个既有缺陷的定位过程

用户报「服务器内部错误」，实际是上游 504。定位靠：① 日志里的 `err.statusCode: 502` + `err.message`；② 逐站 curl：`xjbh.lol` 返回 `503 no_available_account`（账号池空），`draw.songbey.com` 返回 `504`（网关超时）；③ 三站耗时 1.4+12.7+11.4 ≈ 25.5s，与响应时间吻合，证明降级链真的跑完了。

站 2 与站 3 同域（只换 key），实际只有两家上游。

### 验证

- `npm run typecheck` 四包 EXIT=0
- `verify-sql-first` 99/99（新增 `sharePosterBrand.test.ts` 进默认清单）
- `tripShareImage.test.ts` 18/18
- `apiResponse.test.ts` 3/3（新增 `/api/exposed` 用例）
- `trip-share-image-browser.mjs` PASS
- `node:22-alpine` 容器内 sharp + qrcode 合成实测 `200x240 1758B`
- 真实海报（848×1264 JPEG，10-11 产出）合成后 848×1383，journal / ink 都过

### 坑

- `node --import tsx --test apps/server/src/__tests__/xxx.test.ts` 报 `MASTER_KEY 缺失`：import 链拉到 `env.ts`，需要先 `$env:MASTER_KEY = 'a'*64`
- `console.warn` 走 stderr，`console.info` 走 stdout：查逐站日志要去 err 流
- 纯 PowerShell 内联 `curl -d '{...}'` 会被引号转义破坏，用 `--data-binary @file`

### Git Commits

| Hash | Message |
|------|---------|
| `1339cd1` | feat(server): 分享海报合成品牌带与二维码 |
| `8cb0096` | feat(server): 海报生成接入品牌带开关 |
| `b4f7a58` | fix(server): 生图失败不再吞成服务器内部错误 |
| `6b79e8b` | chore(server): 生图降级逐站写日志 |
| `8b8a8d4` | fix(web): 分享海报浏览器测试跟上轮询改动 |
| `cda6945` | chore(task): 归档分享海报品牌带任务 |

### Status

[OK] **Completed**

### Next Steps

- 生图上游当前三家都不可用（xjbh 账号池空、songbey 网关超时），海报生成会被阻塞至上游恢复；建议找第三家不同域名做 `IMAGE_API_BASE_URL_3`
- 二维码指向站点首页，**公开行程分享页 / OG 卡片仍未做**（需分享 token + 公开只读页 + 隐私设计）
- 剩余：`10-17-annotate-core-pipeline`（注释已提交）、`10-12-cdn`（卡 R2）、`10-09-server-side-pdf-export`（无 prd）




## Session 58: 手写体分片按真实文案重排

**Date**: 2026-10-21
**Task**: 手写体分片按真实文案重排（`10-21-handwriting-chunk-layout`）
**Branch**: `master`

### Summary

用户截图发现生成页拍立得卡片标题出现「一半手写体、一半系统黑体」的混杂帧。根因不是字体缺字，而是分片布局：`build-handwriting-font.py` 只把几十个城市/景点字手工塞进 `CORE_BLOCKS`，其余按码位每 96 字一片。5 个标题共 20 个汉字要拉 16 片、约 1.1 MB，每片都是独立的 `font-display: swap` 请求，先到的字先换字体，于是逐字跳动。

### Main Changes

| 主题 | 提交 | 要点 |
|---|---|---|
| 语料导出与聚类 | `8ba4804` | 新增 `scripts/extract-handwriting-corpus.mts`：只读连库取地点名/目的地/日标题，按共现建图做凝聚聚类 |
| 分片计划 | `8ba4804` | 新增 `scripts/handwriting-chunks.json`，只存字符不落原文不落凭据 |
| 构建脚本 | `8ba4804` | `build-handwriting-font.py` 优先读分片计划，无计划时回退 `CORE_BLOCKS` |
| 产物 | `8ba4804` | 76 片 → 90 片，woff2 与 `tailwind.css` 全部重生成，覆盖率清单同步 |

### 关键结论：为什么到不了「1 片」

「公园」「博物馆」这类字只能落在一个片里，任何含它们的标题至少 2 片。把同一字形复制进多片无效——`unicode-range` 重叠时浏览器只用第一个匹配的 face。所以目标是 2~3 片而非 1 片。第一版用「公共字单独成片 + 整条文案贪心装箱」效果很差（平均 3.62 片），换成共现图凝聚聚类 + 局部搬字优化后才降到 3.03。

### 实测

| 标题 | 改造前 | 改造后 |
|---|---|---|
| 紫竹院 | 3 片 / 198 KB | 2 片 / 128 KB |
| 奥林匹克公园 | 6 片 / 366 KB | 2 片 / 126 KB |
| 首钢园 | 3 片 / 203 KB | 3 片 / 134 KB |
| 古北水镇 | 4 片 / 232 KB | 2 片 / 123 KB |
| 鲁迅博物馆 | 4 片 / 251 KB | 3 片 / 203 KB |
| 五张卡去重 | 16 片 / 1101 KB | 7 片 / 428 KB |

代价：`tailwind.css` 字体块 50 KB → 64 KB（gzip +5 KB），字体总量 5.62 MB → 5.97 MB（多出的是每片 woff2 表头开销）。

### 坑

- 语料里混进了测试遗留的合成名字（`金集并发-<uuid>`），会把 uuid 的十六进制字符一起拉进聚类；导出时要按 `[0-9a-f]{8}-...` 过滤
- 局部搬字优化第一版没有快照回滚，跑完比聚类还差（3.03 → 3.59）；必须每轮取最优快照，退步就回滚
- `git add .trellis/tasks/` 会把并发会话的未跟踪任务文件一起吞进去，归档提交只能显式指定任务目录

### 另案：Cloudflare 边缘缓存

用户问行程封面简笔画为什么没有缓存。定位结果：源站响应头是对的（`Cache-Control: public, max-age=31536000, immutable`），浏览器侧一年内不会重拉；但 CF 边缘 `cf-cache-status` 恒为 `DYNAMIC`。通过 Cloudflare MCP 建了 Cache Rule（`/assets/` + `/fonts/` → Eligible for cache，ruleset version 6），Rule Trace 确认规则**匹配**，GraphQL 分析却显示规则生效后 `/assets/*.js` 23 次仍全 dynamic。对照组：同 zone 的 `mail.sakiiko.com` 有 cache hit，说明 zone 缓存本身正常，唯一变量是 `sakiiko.com` 走了 Origin Rule 把回源端口改写成 8443。

用户选择先不动 CF 拓扑。规则保留（无害，端口拓扑改了会自动生效），`development_mode`、`cache_level`、Page Rules、Origin Rule 均未改动。

### Git Commits

| Hash | Message |
|------|---------|
| `8ba4804` | perf(web): 手写体分片按真实文案重排 |
| `0049fa4` | chore(task): 归档手写体分片重排任务 |

### Status

[OK] **Completed**

### Next Steps

- 首屏还可再压：`<link rel="preload">` 公共字片（`youran-00-*.woff2`，53 KB），或让卡片标题等 `document.fonts.load()` 就绪再切手写体，彻底消除逐片 swap 的粗细混排
- 语料变化后要重跑 `extract-handwriting-corpus.mts` → `build-handwriting-font.py` → `generate-title-font-coverage.py`，否则新地名会落到碎片片
- CF 边缘缓存仍待解：需要验证 Origin Rule 的 8443 端口改写是否阻断缓存，代价是要动 xray/nginx 端口分配

---

## Session 59: 生成进度文案改按稳定工具名映射

**Date**: 2026-10-22
**Task**: 工具文案映射表改用稳定工具名 + 穷尽性校验（`10-22-tool-copy-exhaustive`）
**Branch**: `master`

### Summary

生成进度里「正在…」的文案原来拿服务端的中文 label 当 key。任何人改一次服务端 label，查表就静默 miss，fallback 直接把内部操作名翻给用户看。这个缺陷已经在线上发生过一次：`researchTools.ts` 的 label 改成「提交调研结果」，前端 key 还是「提交调研摘要」，用户看到「正在提交调研结果…」。

改成用事件里已有的 `tool` 字段（稳定工具名）做 key，并用 `satisfies Record<ToolName, string>` 把「新增工具忘配文案」变成编译错误；未知名统一落到通用文案，永不显示 label。

### Main Changes

| 主题 | 提交 | 要点 |
|---|---|---|
| 文案表 | `e776c99` | 新增 `apps/web/src/lib/generationToolCopy.ts`：`TOOL_NAMES` 28 个工具名 + `TOOL_COPY`（satisfies）+ `FALLBACK_TOOL_COPY`；放在 lib 因为 Node 测试不能 import `src` 之外的浏览器编译单元 |
| 时间线 | `e776c99` | `ToolItem` 加 `tool`，删掉已无消费者的 `label` |
| 组件 | `e776c99` | `GenerationRunPanel` 取值改 `toolCopy(item.tool)`，旧 21 条中文 label 表整体删除（净 -22 行） |
| 测试 | `e776c99` | 新增 `apps/web/tests/generationToolCopy.test.ts`；`generationTimeline.test.ts` 补 `tool` 字段断言 |
| 浏览器验收 | `e776c99` | `verify-generation-browser.mjs` 采样真实生成的进度行，断言不出现任何内部 label |

### 工具清单实况

源码里实际是 **28 个**稳定 tool 名（PRD 原表凭记忆写成 22 个，还带了不存在的 `submit_draft` / `submit_copy`）：调研 Agent 5、草稿工具 11、其他 Agent 工具 3（`geocode_place` / `submit_review` / `submit_trip_advice`）、系统任务 12。已在 PRD 补「实施核对结果」。

### 验证

| 项 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build -w apps/web` | ✓ |
| 单测（3 文件） | 17/17 |
| 反证：删掉一条文案 | TS1360 + TS7053 报错；恢复后 exit 0 |
| `verify-generation-browser.mjs`（mock LLM + 临时库） | 5 项 PASS |

真实生成采样到的进度行：`正在确认各个景点的位置…`、`正在为旅程起个名字…`、`正在准备出行提示…`、`正在整理旅行灵感…`（最后一条即修复前的「正在提交调研结果…」）。

### 坑

- 未跟踪文件不能直接出现在 `git commit -- <pathspec>` 里（`error: pathspec ... did not match`），必须先 `git add -- <该路径>` 再按时显式 pathspec 提交；全程不用裸 `git commit` 就不会带上并发会话的改动
- 浏览器验收脚本里第一版断言用了 `includes(label)`，把 thought 行「解析活动坐标(12/16)」误判成泄露；改成去掉「正在」前缀与尾部省略号后精确比对
- `verify-generation-browser.mjs` 第二次 `begin()` 偶发超时（首页城市 chips 动画导致元素不 stable / detached），与本改动无关，重跑即过

### Git Commits

| Hash | Message |
|------|---------|
| `e776c99` | refactor(web): 进度文案改按稳定工具名映射 |
| `921e88d` | chore(task): 归档工具文案映射任务 |

### Status

[OK] **Completed**

### Next Steps

- 文案表可搬到 `packages/shared`，让 server 的工具定义与前端文案共用同一份名字清单，彻底消掉「手写联合类型与源码同步」这条隐患
- `done` 态文案（「已找到 12 个去处」）需要结构化 `tool_end.summary`，目前是自由文本，另开任务
- 参数化文案（「正在查找上海的好去处」）需要前端解析 `args`，收益不抵耦合，暂不做

---

## Session 60: 提交工作区遗留改动与注册守卫归档

**Date**: 2026-10-22
**Task**: 无（清理工作区）
**Branch**: `master`

### Summary

本体缓存里积了另一会话的完整改动与几个未入库的任务文档。先复跑验证确认不是半成品，再按主题拆成三项提交。

### 验证与提交

| 项 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `node --import tsx scripts/verify-sql-first.mts` | 104/104（含新增 `emailRegisterGuard.test.ts`）| 91.8s |
| `node apps/web/tests/login-dialog-browser.mjs` | PASS（dev server 已在 5173）| |

| Hash | Message |
|---|---|
| `30258f9` | fix(server): 注册发码拒绝已注册邮箱并补前端校验 |
| `17b7c58` | chore(task): 归档注册邮箱守卫任务 |
| `606d8e1` | chore(tasks): 补录三个进行中的任务文档 |
| `768bccf`（前） | chore: 记录工具文案映射改按工具名查表 |

### 坑

- PowerShell 把中文弯引号（`“”`）当成字符串定界符，写进 `git commit -m` 正文会把参数提前截断，报 `pathspec ... did not match any file(s)`；提交信息里改用直角引号或不用引号
- `.trellis/tasks/10-05-*/` 下残留 7 张截图，archive 里已有任务当时（10-09）的旧版；它们是后续复跑脚本落盘的新版（login 4 张 10-22、nav 3 张 10-19），目录里连 prd/task.json 都没有，属于归档旧路径残留。用户选择删除，`workspace-cleanup.md` 的「先与 `git ls-files` 比对再删」流程可直接用

### Status

[OK] **Completed**（工作区干净）

---

## Session 61: 路由级分包与地图按需加载

**Date**: 2026-10-23
**Task**: 路由级代码分割（`10-23-route-code-splitting`）
**Branch**: `master`

### Summary

实测 `npm run build -w apps/web` 发现全站零代码分割：唯一 JS chunk 949.69 kB / gzip 301.08 kB，Vite 直接警告超 500 kB。`router.tsx` 静态 import 全部 5 个页面，`TripEditorPage` 拖着 `MapView` → `LeafletCanvas` → `leaflet` 一起进首屏（实测 chunk 内含 `leaflet`、`L.Map`）。

先做路由级懒加载，随后按用户要求把地图渲染优先级反转（原来默认渲染 Leaflet、探测高德成功才切；改为高德优先、Leaflet 降级时按需加载）。

### Main Changes

| 主题 | 提交 | 要点 |
|---|---|---|
| 路由分包 | `1aa2f79` | 4 个私有页改 `React.lazy` + `<Suspense>`，`HomePage` 保持静态；`withSuspense` 包在 `<Outlet />` 子元素上，auth 检查先于 chunk 加载 |
| Leaflet 样式归位 | `1aa2f79` | `main.tsx` 的 `import 'leaflet/dist/leaflet.css'` 移到 `LeafletCanvas.tsx`，否则地图样式仍在首屏 |
| 渲染优先级反转 | `1aa2f79` | `MapView` 的 `amap \| null` 二值改成 `probing \| amap \| leaflet` 三态；`LeafletCanvas` 改 `lazy()` 动态引入；二次进入直读 `window.AMap` 跳过探测 |

### 关键数字

| 指标 | 改前 | 改后 |
|---|---|---|
| 首屏 JS gzip（单 chunk） | 301.08 kB | 162.37 + 39.90 = **202.27 kB** |
| 首屏合计 gzip | 455.87 kB | **346.80 kB**（-23.9%）|
| 编辑器 chunk gzip | 77.86 kB | **30.82 kB**（主路径）|
| Leaflet 独立 chunk | — | 44.45 kB JS + 6.21 kB CSS（**仅降级时下载**）|
| JS/CSS 产物数 | 2 | 12 |

**口径要说准**：首屏降 23.9% 全部来自路由分包；Leaflet 那次拆分对首屏**零影响**（它本来只随第 4 个懒加载页进入）。它真正省的是编辑器页——走高德主路径的用户少付 47 kB gzip（-60%）。

### 验证

| 项 | 结果 |
|---|---|
| `npm run typecheck`（四包） | exit 0 |
| `npm run build -w apps/web` | ✓ 8.23s，>500 kB 警告仅剩 index.js |
| 首屏 chunk 含 `leaflet` / `MapContainer` / `TileLayer` | 全部无命中 |
| 未登录手测 `/trips`、`/trips/x`、`/generations/x` | 均跳回首页、无卡死、`RequireAuth` 先于 lazy 执行 |
| 登录后编辑器地图（主路径 + 降级） | **未验证**，本机无登录态 |

### 坑

- 只改路由是半成品：`leaflet.css` 在 `main.tsx` 全局 import，JS 拆走了样式还留在首屏 CSS 里。必须同时把 CSS import 下移到 `LeafletCanvas.tsx`
- 改完 chunk 拆分策略会变：上一轮的 `hooks-*.js`（234.57 kB）这一轮变成 `index.js` + `src-*.js`，chunk 名字和体积都会变，**只看 Vite 日志里的单个文件会算错首屏**，必须用 `index.html` 的引用列表逐个算 gzip
- 未跟踪文件不能直接 `git commit -- <pathspec>`，会报 `nothing added to commit`；需要先 `git add -- <该路径>` 再带 pathspec 提交（与 Session 59 同一条）
- chrome-devtools MCP 的 navigate 60s 超时不可用，改用 playwright MCP；`browser_evaluate` 的参数是 `function`（`() => ...`）不是 `expression`
- 新任务目录如果从未被 git 跟踪，`task.py archive` 移目录后旧路径不会产生删除记录，只提交新路径即可

### Git Commits

| Hash | Message |
|---|---|
| `1aa2f79` | refactor(web): 路由级分包并按需加载地图库 |
| `19676d0` | chore(task): 归档路由分包与地图按需加载任务 |

### Status

[OK] **Completed**（工作区干净）

### Next Steps

- 待用户验证：登录后 `/trips/:id` 主路径高德正常渲染；临时清 `AMAP_JS_KEY` 后降级 Leaflet 能按需加载
- CSS 仍是大头：2629 条规则 / 144.53 kB gzip（正常同类项目 20–40 kB），根因是 1112 个 Tailwind 任意值无法复用 + 162 个逐元素提取的颜色 token（命名如 `--color-activity-card-background-6`）
- 图片 16.2 MB 是比 JS 更大的问题：单张城市 PNG 268–504 kB，未做 webp / srcset
- `index.js` 原始 508.88 kB 仍超 500 kB 阈值，进一步拆分要动 vendor 分层（`manualChunks`）


---

## Session 62: 对话面板流式渲染优化（第一步）

**Date**: 2026-10-23
**Task**: chat-panel-streaming-render（已归档）
**Branch**: `master`

### Summary

长对话卡顿的根因不是 DOM 多，而是 `ChatPanel` 顶层的 `pending` state：每次 `answer_delta` 都 `setPending`，整个面板函数重跑，`messages.map` 里的全部历史消息都重新执行（`MessageBubble` 没有 memo）。一次回答约 2000 个 delta × 200 条历史，等于几十万次组件调用。

修法是两步：`MessageBubble` 加 `memo`（props 只有 `message`），流式回答块抽成 `PendingAnswer`。delta 现在只重渲染这一块。

### Main Changes

| 主题 | 提交 | 要点 |
|---|---|---|
| 渲染优化 | `1a0d287` | `MessageBubble` 加 `memo`；新增 `chat/PendingAnswer.tsx`；`ChatPanel` 删掉迁走的 22 行与两个孤儿 import（净 −16 行） |
| 共享控件 | `90fc8f4` | 认证相关 4 个文件的 6 处原生 `<button>` 换成 `Button variant="plain"` |

### 顺带修掉的既有回归

`styles.test.mjs` 自 6a8976b（2026-10-18，注册接入邮箱验证码）起就是红的：规则禁止 `src` 下非 `ui/` 文件出现原生 `<button|input|select|textarea>`，而那次提交在 `LoginPage`（2 处）、`RegisterPage`、`ResetPasswordPage` 各放了一个行内链接样式的原生 button。上一轮我提交的 `30258f9` 又加了 2 处（`EmailCodeField`、`RegisterPage` 的去登录入口），当时只跑了 typecheck / verify-sql-first / login-dialog-browser，漏了这个测试。

教训：改动 `apps/web/src` 下的 tsx 后，`node --import tsx --test apps/web/tests/styles.test.mjs` 必须一起跑 —— 它是唯一会扫全量源码的静态规范测试。

### 验证

| 项 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build -w apps/web` | ✓ |
| `detail-chat.test.ts` | 4/4 |
| `styles.test.mjs` | 1/1（修完 6 处原生 button 后转绿） |
| `editor-browser.mjs` | PASS |
| `login-dialog-browser.mjs` | PASS |

memo 的结构性断言：临时脚本 import 组件后确认 `MessageBubble.$$typeof === Symbol.for('react.memo')`。

### 坑

- `@vitejs/plugin-react` 用 automatic JSX runtime，`node --import tsx` 直接渲染 tsx 组件会抛 `React is not defined` —— 临时脚本只能做模块级断言，不能做 SSR 渲染
- `editor-browser.mjs` 会把 `archive/2026-10/09-29-ui-consistency/research/editor-verification/results.json` 写回（saves 计数 +1）；`login-dialog-browser.mjs` 会在 `.trellis/tasks/10-05-home-login-dialog/research/` 重新生成 4 张截图。两者都是测试副产物，跑完要 `git restore` 该 json、删掉截图目录，别提交
- 并发会话持 `.git/index.lock` 时 `git restore` 也会失败（`fatal: Unable to create ... index.lock`），等几秒重试即可

### Git Commits

| Hash | Message |
|------|---------|
| `1a0d287` | refactor(web): 对话流式渲染只重渲染当前回答 |
| `90fc8f4` | fix(web): 认证表单内联按钮改用共享控件 |
| `b65ed5a` | chore(task): 归档对话流式渲染任务 |

### Status

[OK] **Completed**

### Next Steps

后续三步（按我给出的方案排序，都还没做）：

- 历史分页：`getConversationDetail` 当前无 limit 全量返回，要加 `before/limit` 游标；前端用 `useInfiniteQuery` + 上滚加载 + `scrollHeight` 差值补偿滚动位置
- 展示层：历史消息的工具步骤默认折叠、长回答「展开全文」、按天/时间插话题分隔、未读分隔线
- 虚拟滚动（>60 条才启用，`@tanstack/react-virtual` + `measureElement` 实测高度），代价是 Ctrl+F 与「跳到某条」要自己做
