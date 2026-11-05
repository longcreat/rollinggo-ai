# 开放注册 + GitHub 登录，邀请码退为备选开关

## Goal

将注册从「邀请码强制」切换为「默认开放」，并新增 GitHub OAuth 登录；邀请码机制**保留为可随时切回的备选开关**（遇滥用时的紧急刹车），而非删除。存量部署升级后行为不变。

## What I already know

- 现状：`POST /api/auth/register` 强制校验邀请码（`timingSafeEqual`）；`INVITE_CODE` 为空 = 注册整体关闭（`apps/server/src/auth/invite.ts`）——语义与目标正好相反，需要重构语义而非删代码
- `RegisterBodySchema.inviteCode` 必填 `minLength: 1`（`packages/shared/src/schemas.ts:96`），server 与 web 共用
- 会话体系可直接复用：`createSession(userId)` → httpOnly cookie（`apps/server/src/auth/session.ts`）
- `users` 表：`password_hash NOT NULL`，无任何 OAuth 字段；迁移为幂等 `CREATE TABLE IF NOT EXISTS`（`apps/server/src/db/migrate.ts`），**没有加列机制**，需带守卫的 `ALTER TABLE ADD COLUMN`
- 服务端零 OAuth 依赖；项目惯例：手写最小实现（session/secretBox/proxy 均手写）+ undici fetch + 「env 空值 = 功能关闭」
- 前端 `RegisterPage` 有必填邀请码输入框（文案「凭邀请码注册」「向站长索取」）；`LoginPage` 有「用邀请码注册」链接；均需按配置条件渲染
- 出站请求经 `lib/proxy`（undici EnvHttpProxyAgent）接管，github.com API 调用在本机代理环境下反而无需额外处理
- 文档多处描述邀请码注册，需同步：`.env.example`、`README.md`、`docs/PRD.md`、`docs/TECHNICAL_ARCHITECTURE.md`
- 无测试框架，验证走 `scripts/verify-*.mjs` 脚本惯例

## Requirements (final)

1. 新增 `REGISTRATION_MODE=open|invite|closed`：
   - `open`：注册不要求邀请码（`inviteCode` 忽略）
   - `invite`：沿用现有 `checkInviteCode`（要求 `INVITE_CODE` 非空，否则启动时报错）
   - `closed`：拒绝新注册（403），存量用户登录不受影响
   - **未设置时的兼容推断**：`INVITE_CODE` 非空 → `invite`，否则 → `open`（保证存量部署升级后行为不变）
2. `RegisterBodySchema.inviteCode` 改为可选；服务端按模式决定是否校验
3. GitHub OAuth 登录（手写 web flow，OAuth App，scope 仅 `user:email`）：
   - `GET /api/auth/github`：`randomBytes(32)` state 存 10 分钟 httpOnly cookie（lax/secure-prod），302 → authorize（显式带 `redirect_uri` + `scope` + `state`）
   - `GET /api/auth/github/callback`：先查 state 存在再严格比对并清除 cookie → code 换 token（`Accept: application/json`，两处显式传同一 `redirect_uri`，**检查 body.error 而非仅状态码**）→ `GET /user`（带 `User-Agent: tripweaver`，以数字 `id` 为永久键）+ `GET /user/emails` 取 `primary && verified` 邮箱（无则拒绝）→ find-or-create/link → `createSession`（全新会话）→ 302 固定跳 `/trips`（防 open redirect）
   - 失败路径：302 → `/login?error=<code>`，前端展示文案；access token 用完即弃不落库
4. 新 env：`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`（留空 = GitHub 登录关闭）、`APP_BASE_URL`（构造回调 URL；配置了 GitHub 但缺它 → 启动报错）
5. `users` 表加 `github_id TEXT` 列（守卫式 ALTER + `CREATE UNIQUE INDEX IF NOT EXISTS`）；OAuth-only 用户 `password_hash = ''`，密码登录对 `''` 走统一 401（不泄露账号存在性）
6. **邮箱冲突策略（已拍板）**：GitHub verified primary email 与既有密码账号相同 → **自动绑定（写入 github_id）并登录**
7. 新账号创建统一受 `REGISTRATION_MODE` 约束：`invite`/`closed` 下 GitHub **新用户**被拒（302 带错误码）；已有/已绑定用户任何模式都可 GitHub 登录
8. 新增公开端点 `GET /api/auth/config` → `{ registrationMode, githubEnabled }`
9. 前端：`RegisterPage` 邀请码栏按 config 条件渲染、closed 提示；两页按 `githubEnabled` 显示「使用 GitHub 登录」（`<a href="/api/auth/github">`）；`LoginPage` 解析 `?error=` 文案；去掉硬编码「凭邀请码注册」
10. 新端点 rate limit（github 两路由 ~5/min）
11. 文档同步：`.env.example`、`README.md`（含 OAuth App 注册指引：dev 单独注册一个 App，callback `http://localhost:5173/api/auth/github/callback`）、`docs/TECHNICAL_ARCHITECTURE.md`、`docs/PRD.md`
12. `vite.config` 固定 `server.port: 5173, strictPort: true`（回调端口必须精确匹配，规避本机端口漂移）

## Acceptance Criteria

- [ ] `open`：无邀请码注册成功（201 + session cookie）
- [ ] `invite`：缺码/错码 403，对码成功；`INVITE_CODE` 为空时启动报错
- [ ] `closed`：注册 403，存量用户登录正常
- [ ] 未设置 `REGISTRATION_MODE` 且 `INVITE_CODE` 非空 → 行为与旧版一致（兼容验证）
- [ ] GitHub：新用户建号登录、老用户复登、同邮箱自动绑定；state 缺失/不匹配 → 拒绝
- [ ] `invite`/`closed` 模式下 GitHub 新用户被拒且有可读文案
- [ ] GitHub 未配置 → `config.githubEnabled=false`、前端无按钮、`/api/auth/github` 404
- [ ] OAuth-only 账号密码登录 → 统一 401 文案
- [ ] typecheck 绿 + `scripts/verify-security.mjs` 通过 + 新增三态注册 verify 断言
- [ ] 文档同步完成

## Definition of Done

- typecheck / lint 绿；verify 脚本覆盖三态注册（GitHub 真机流程留待手动，token 交换不 mock 上线）
- `.env.example` / `README.md` 更新，含存量部署升级说明（模式推断规则）
- 安全门通过：state CSRF、timing-safe、统一失败文案、无 open redirect、token 不落库、仅信 verified 邮箱

## Out of Scope (explicit)

- 邮箱验证、密码找回
- 多邀请码 / 一次性邀请码 / 管理后台
- 其他 OAuth 提供商；PKCE（confidential client 有 state + secret 已达标，留作后续加固）
- 设置页手动绑定/解绑 GitHub

## Decision (ADR-lite)

1. **模式开关放 env 而非 DB**：与「env 空值=关闭」惯例一致；切换 = 改 env 重启，零新增攻击面。
2. **手写 OAuth（~80 行）而非 @fastify/oauth2 / arctic**：库只封装最简单的 30%（拼 URL/换 token），verified 邮箱关联、防接管、session 签发任何方案都得手写；零新依赖、全部可审计（research §5）。
3. **`users.github_id` 列而非 `oauth_accounts` 表**：YAGNI，仅 GitHub；未来多 provider 再迁移。
4. **`password_hash` 保留 NOT NULL、OAuth-only 存 `''`**：避免 SQLite 表重建；沿用「空串=禁用」惯例。
5. **邮箱冲突自动绑定并登录**（用户拍板）：仅信 `primary && verified` 邮箱，防 nOAuth 类接管（research §4.5）。
6. **MVP 仅当前需求**（用户拍板）：不含邮箱验证/手动绑定页；开放注册防线 = IP 限速 + 每日配额 + 可切回 invite。
7. **OAuth App 而非 GitHub App**：登录场景 token 用完即弃，GitHub App 的短寿命 token/细粒度权限无增益（research §3）。

## Technical Notes

- 受影响文件：`apps/server/src/env.ts`、`auth/invite.ts`、`auth/github.ts`（新）、`routes/auth.ts`、`db/schema.ts`、`db/migrate.ts`、`packages/shared/src/schemas.ts`、`apps/web/src/pages/{Register,Login}Page.tsx`、`apps/web/src/api/hooks.ts`、`apps/web/vite.config.*`、`.env.example`、`README.md`、`docs/*`、`scripts/verify-*.mjs`
- token 端点出错可能仍返回 HTTP 200（社区经验）→ 必须检查 body.error
- OAuth App 只允许 1 个 callback URL → dev/prod 各注册一个 App，README 写清

## Research References

- `research/github-oauth.md` — GitHub OAuth web flow 端点/参数/错误形态、scope 最小集 `user:email`、安全清单、方案对比（推荐手写）、dev callback 实践
