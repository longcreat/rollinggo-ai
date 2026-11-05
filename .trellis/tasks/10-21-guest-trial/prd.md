# 游客免注册试用一次生成

## Goal

未登录访客点「开始规划」时，不再弹登录框，而是自动建一个匿名 guest 账号、直接发起一次真实生成，能看完整行程与海报。注册或登录后，guest 期间生成的行程自动归到新账号名下。

动机：生成一次要 3-6 分钟，用户在付出这个时间成本之前看不到任何成品，转化卡在登录墙前。

## 现状证据

- 所有业务路由都挂 `requireAuth`：`conversations` / `generations` / `notifications` / `settings` / `trips` / `usage`（`apps/server/src/routes/*.ts` 的 `app.addHook('preHandler', requireAuth)`）
- `trips.userId` 与 `generations.userId` 都是 `notNull`（`apps/server/src/db/schema.ts`），绕开 userId 等于在每个下游功能里加分支
- 配额按 `userId` 统计：`quotaService.usedToday(userId)`，上限取全局 `env.genDailyLimit`
- `users.passwordHash` 为 `notNull`，OAuth-only 用户用空串表示「禁用密码登录」—— guest 沿用这个约定
- 前端首页 `HomePage.tsx:82`：`if (!me.data) { openLogin(destination); return; }`

## 已确认的决策

| 决策点 | 选择 |
|---|---|
| guest 账号创建时机 | 点「开始规划」时（不是访问即建，避免扫街流量建号） |
| 功能边界 | 生成 + 查看 + 海报；**不能**编辑行程、对话式修改 |
| 数据寿命 | 注册/登录时自动迁移；未注册的 guest 数据 7 天后清理 |

## Requirements

### R1 匿名 guest 账号

新增 `POST /api/auth/guest`：

- 已有有效会话（含 guest）→ 直接返回当前用户，不重复建号
- 无会话 → 建 `users` 行：`id = uid()`、`email = guest-<id>@guest.local`、`passwordHash = ''`、`isGuest = true`、`createdAt = now()`
- 下发会话 cookie（复用 `createSession`）
- IP 限流 `max: 3 / 1 hour`（防止批量刷号消耗 LLM）
- 开关 `GUEST_TRIAL_ENABLED`，默认 `true`；关闭时返回 403，前端回退到现在的弹登录行为

### R2 guest 配额固定 1 次

- `quotaService` 的日限改为按用户取：guest 恒为 1，普通用户仍用 `env.genDailyLimit`
- `usageView` 返回的 `dailyLimit` / `remaining` 对 guest 按 1 计算，前端进度展示自然适配
- 用满后发起生成返回 429，前端引导注册

### R3 注册/登录时迁移

`POST /api/auth/register` 与 `POST /api/auth/login` 成功后，若当前会话属于 guest：

- 在**同一事务**内把 `trips` / `generations` / `generation_notifications` / `trips` 的 `user_id` 改为新用户
- 删除 guest 的 `sessions` 与 `users` 行
- 迁移失败不能阻断登录（记 warn，guest 数据留给清理脚本）

登录路径还要考虑：新账号本身已有行程 → 直接合并没有冲突（都是 insert 过的行，改 userId 即可）。

### R4 游客态的前端表现

- 首页「开始规划」：无会话 → 先调 `/api/auth/guest`，成功后继续原有生成流程（不再弹登录）
- 顶部导航显示「游客试用 · 登录后保存」，点击打开登录弹窗
- 行程详情页对 guest 隐藏/禁用编辑与对话入口，点击时引导登录
- 海报生成与下载对 guest 开放（已有 `requireAuth` 会通过）

### R5 清理脚本

`scripts/cleanup-guests.mts`：删除 `is_guest = true` 且 `created_at < now() - 7 days` 的用户及其 `trips` / `generations` / `generation_notifications` / `sessions`。

手动执行（**不加**定时任务/常驻进程，按项目约定由运维决定何时跑）。

### R6 数据库列

`users` 加 `is_guest BOOLEAN NOT NULL DEFAULT FALSE`（`migrate.ts` 里用 `ADD COLUMN IF NOT EXISTS`，与现有补列方式一致）。

## Acceptance Criteria

- [ ] `npm run typecheck` 通过
- [ ] `node --import tsx scripts/verify-sql-first.mts` 全 pass（含新增单测）
- [ ] 单测：`POST /api/auth/guest` 无会话 → 建 guest 行 + 下发 cookie；重复调用不重复建号
- [ ] 单测：guest 发起的第 1 次生成成功，第 2 次 429
- [ ] 单测：guest 注册后 `trips.user_id` 指向新账号，guest 行与 session 被删除
- [ ] 单测：`GUEST_TRIAL_ENABLED=false` 时 `/api/auth/guest` 返回 403
- [ ] 单测：清理脚本只删 7 天前的 guest，不碰正常用户
- [ ] 浏览器测试：未登录首页点「开始规划」→ 不出现登录弹窗，进入生成流程，顶部出现「游客试用」
- [ ] 浏览器测试：游客态点编辑/对话入口 → 出现登录引导
- [ ] 现有 `login-dialog-browser.mjs` 通过

## Out of Scope

- 不做游客编辑行程、对话式修改（需放开 `conversations` 路由与 editor 预算计数）
- 不做邮件/通知（guest 没有可用于收信的邮箱）
- 不加定时清理任务
- 不改 BYOK / 设置页对 guest 的可见性

## 实施顺序

1. `users.is_guest` 列 + `POST /api/auth/guest` + 开关 → 单测
2. 配额按 guest 收敛到 1 次 → 单测
3. 注册/登录迁移逻辑（事务 + 失败不阻断） → 单测
4. 前端首页与导航的游客态 → 浏览器测试
5. 清理脚本 → 单测
