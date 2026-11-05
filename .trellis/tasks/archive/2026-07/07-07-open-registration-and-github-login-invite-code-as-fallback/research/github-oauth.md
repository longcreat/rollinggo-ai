# Research: GitHub OAuth 登录集成（Fastify 5 + TS，最小依赖）

- **Query**: GitHub OAuth login integration for a minimal-dependency Fastify 5 + TypeScript server
- **Scope**: mixed（外部官方文档为主 + 本仓库代码映射）
- **Date**: 2026-07-07

## 1. Web Application Flow 精确机制（2026 现状）

### 1.1 授权跳转 `GET https://github.com/login/oauth/authorize`
| 参数 | 必填性 | 说明 |
|---|---|---|
| `client_id` | 必填 | OAuth App 的 Client ID |
| `redirect_uri` | 强烈推荐 | 授权后回跳地址，须满足与注册 callback 的匹配规则（见 1.4） |
| `scope` | 视场景 | 空格分隔；**不传时**：新用户得到空 scope，老用户自动沿用其已授权过的全部 scope（跳过授权页）——纯登录也应显式传 scope，避免意外继承 |
| `state` | 强烈推荐 | "不可猜测的随机串，用于防 CSRF"（官方原文），回调时原样带回 |
| `allow_signup` | 可选 | 是否允许未注册用户在流程中注册 GitHub，默认 `true` |
| `login` / `prompt=select_account` | 可选 | 预填账号 / 强制弹出账号选择器 |
| `code_challenge` + `code_challenge_method=S256` | 强烈推荐 | **PKCE 现已支持**（github.com/GHEC 已启用，仅 S256；较新的变化，见 docs 仓库 feature flag `pkce_support`，github/docs-content#18773） |

[GitHub Docs, 2026, https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps]

### 1.2 换取 token `POST https://github.com/login/oauth/access_token`
- 请求（form 或 JSON body）：`client_id`、`client_secret`、`code`、`redirect_uri`（强烈推荐，官方称"用于与签发 code 时的 URI 比对，防攻击"）、（PKCE 时）`code_verifier`。
- **必须带 `Accept: application/json`**，否则响应是 form-encoded 字符串。成功响应：
  `{ "access_token": "gho_…", "scope": "…", "token_type": "bearer" }`
- `code` **10 分钟过期、单次使用**（官方原文："The temporary code will expire after 10 minutes"）。

### 1.3 错误形态（两类，位置不同）
- **授权阶段错误 → 以 query 参数回跳到 callback**：`?error=access_denied&error_description=…&error_uri=…&state=…`（用户点拒绝）；另有 `redirect_uri_mismatch`、`application_suspended`。[GitHub Docs, 2026, https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-authorization-request-errors]
- **换 token 阶段错误 → 响应 body 内 JSON**：`bad_verification_code`（code 错误/过期/已用）、`incorrect_client_credentials`、`redirect_uri_mismatch`、`unverified_user_email`（用户主邮箱未验证时 GitHub 直接拒发 token）。[GitHub Docs, 2026, https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors]
- ⚠️ 单一来源提示：社区普遍报告该端点出错时 HTTP 状态码仍可能是 200（官方文档未标注状态码）。**实现时不要只看状态码，必须检查 body 是否含 `error` 字段**。

### 1.4 redirect_uri 匹配规则与 token 寿命
- 匹配规则：host（不含子域）与**端口必须精确匹配**，path 须为注册 callback 的子目录；`localhost` 不享受端口豁免。loopback 字面量（`127.0.0.1`/`::1`）为例外：**端口可任意**（RFC 8252 §7.3 也建议用 `127.0.0.1` 而非 `localhost`）。
- token 寿命：OAuth App 的 `gho_` token **默认永不过期**；吊销途径：用户手动撤销、1 年未使用自动吊销、泄漏到公开仓库被自动吊销、同一 user/app/scope 组合超过 10 个 token 时最旧的被吊销。[GitHub Docs, 2026, https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation]

## 2. 获取用户身份

### 2.1 `GET https://api.github.com/user`
- Header：`Authorization: Bearer <token>` + **`User-Agent` 必填**（缺失直接拒绝，无效值 403；建议用应用名如 `tripweaver`）。[GitHub Docs, 2026, https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#user-agent]
- 关键字段（经 OpenAPI 规范核实）：`id`（**integer int64，永不变更，官方明确要求以它作为用户主键，绝不用 login/email 做键**——login 可改名可回收）、`login`、`name`（可空）、`avatar_url`、`email`（**nullable**：仅返回公开资料邮箱，未设置公开邮箱即 `null`）。[GitHub OpenAPI, 2026, https://github.com/github/rest-api-description]（schema `private-user`）
- 任意有效 token（含空 scope）都可调用此端点读公开资料；`user` scope 只是额外解锁私有资料字段。

### 2.2 `GET https://api.github.com/user/emails`
- **需要 `user:email` scope**（classic token）。返回数组：`{ email, primary: boolean, verified: boolean, visibility }`。
- 取邮箱逻辑：`emails.find(e => e.primary && e.verified)`；若无 verified 邮箱则拒绝完成登录（见 §4）。[GitHub Docs, 2026, https://docs.github.com/en/rest/users/emails]

### 2.3 scope 推荐
- 纯登录最小集：**`user:email` 单个即可**（`/user` 拿 id/login/avatar 不需要 scope，`/user/emails` 拿可靠邮箱需要它）。
- `read:user user:email` 是社区惯例组合，`read:user` 只多解锁私有资料字段，对登录无实际增益。
- 空 scope 不可行：本仓库 `users.email` 为 `NOT NULL UNIQUE`（`apps/server/src/db/schema.ts`），必须拿到可靠邮箱做账号关联。
- 注意 scope 归一化：请求 `user` 会吞并 `user:email`（`user` 含读写 profile，权限过大，不要用）。[GitHub Docs, 2026, https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps]

## 3. OAuth App vs GitHub App（登录场景）

- GitHub 官方总体口径是"优先考虑 GitHub App"（细粒度权限、短寿命 token、webhook 集中），但这些优势服务于**访问仓库资源/自动化**场景。[GitHub Docs, 2026, https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps]
- 对"只做 Sign in with GitHub、拿到身份即丢 token"的小型自托管 OSS：
  - **OAuth App 更简单**：注册仅需 名称 + Homepage URL + 1 个 callback URL；无私钥/JWT/安装(installation)概念。
  - GitHub App 的收益（8 小时过期 `ghu_` token + refresh token、细粒度权限）对"用完即弃 token"无意义，反而引入更多注册与配置成本；其唯一相关优势是**支持最多 10 个 callback URL**（OAuth App 只允许 1 个，见 §6）。[GitHub Docs, 2026, https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url]
- **结论：本项目选 OAuth App**。自托管部署者按 README 自行注册一个 OAuth App 也最容易操作。

## 4. 手写实现安全清单

1. **state 防 CSRF**：每次登录用 CSPRNG 生成 ≥112 bit（本仓库惯例可直接 `randomBytes(32).toString('hex')`），写入短时效 cookie（`httpOnly` + `sameSite=lax` + `secure`(prod) + `path=/` + `maxAge≈600s`），回调时**先检查 query 中 state 存在、再与 cookie 严格比对**（常见错误是漏查"不存在"分支），用后立即清除 cookie。[Copenhagen Book, 2024, https://thecopenhagenbook.com/oauth]；GitHub 官方将 state 描述为防 CSRF 的不可猜测随机串。
2. **PKCE（可选加固）**：现已支持 S256；confidential client 有 state + client_secret 已达标，PKCE 为锦上添花（`node:crypto` 约 15 行）。
3. **redirect_uri**：注册精确 callback；authorize 与 token 交换**两处都显式传同一 `redirect_uri`**。
4. **不落库 access token**：仅用一次拉取身份后丢弃。GitHub 每 user/app/scope 限 10 个 token、超出吊销最旧——反正不复用，无影响；也免去 token 加密存储义务。[GitHub Docs, 2026, best-practices-for-creating-an-oauth-app]
5. **账号关联只信 verified 邮箱**：以 `primary && verified` 的邮箱做与既有密码账号的合并依据；GitHub 主邮箱未验证时甚至拒发 token（`unverified_user_email`），但 `/user/emails` 列表内仍可能含未验证条目，必须过滤。已知攻击类：以未验证邮箱声明他人邮箱 → OAuth 登录接管既有账号（"nOAuth" 即此类，[Descope, 2023, https://www.descope.com/blog/post/noauth]；账号预劫持系统研究见 [MSRC, 2022, https://msrc.microsoft.com/blog/2022/05/pre-hijacking-attacks/]，后者标题未二次核实，单一来源标注）。同时以 GitHub 数字 `id` 作永久键（如 `users.githubId` 列），login/email 均可变。
6. **会话固定**：登录成功必须签发**全新** session（OWASP："Renew the Session ID After Any Privilege Level Change"）。本仓库 `createSession(userId)` 每次生成新随机 token，天然满足；沿用 `auth.ts` 的 `COOKIE_OPTS` 即可。[OWASP, Session Management Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html]
7. **登录后跳转防开放重定向**：post-login redirect 只接受以单个 `/` 开头的相对路径（拒绝 `//`、`http(s)://`、反斜杠变体），或干脆固定跳 `/`。[Copenhagen Book, 2024, https://thecopenhagenbook.com/open-redirect]
8. **每次登录重新校验身份**：官方要求每次拿到新 token 后重新拉 `/user` 确认当前登录者（用户可能换号授权）。
9. **限流**：两个路由都挂 `@fastify/rate-limit` 路由级配置（仿 `auth.ts` 的 `config.rateLimit` 写法）。

## 5. 集成方案对比

| 方案 | 新增依赖 | 省掉什么 | 剩下仍要手写 |
|---|---|---|---|
| **A. 手写 ~80 行**（2 个路由 + undici `fetch`） | 0（undici 已在依赖中） | — | 全部（但总量小：state cookie ~10 行、跳转 ~10 行、换 token ~20 行、拉身份 ~20 行、关联+建会话 ~20 行） |
| B. `@fastify/oauth2` v8.2.0（2026-02-09 发布，Fastify 官方组织，活跃） | `@fastify/oauth2` + 传递依赖 `simple-oauth2`、`fastify-plugin` | 自动 state cookie（httpOnly/lax，默认名 `oauth2-redirect-state`）、`GITHUB_CONFIGURATION` 预置、PKCE、token 交换封装 | 拉 `/user`、`/user/emails`、verified 过滤、账号关联、签发 session（**难点一个都没省**） |
| C. `arctic` v3.7.0（2025-05-21 发布） | `arctic` + `@oslojs/{crypto,encoding,jwt}` | `createAuthorizationURL`/`validateAuthorizationCode` 的 URL 拼装与错误类型化 | 路由、state cookie 存取、身份拉取、关联、session 全部自己写 |

[npm, 2026, https://www.npmjs.com/package/@fastify/oauth2]；[npm, 2025, https://www.npmjs.com/package/arctic]；[fastify/fastify-oauth2 README, 2026, https://github.com/fastify/fastify-oauth2]；[Arctic docs, 2025, https://arcticjs.dev/providers/github]

**推荐：方案 A（手写）**。理由：本仓库哲学是 bcryptjs + 自研 session 的最小依赖路线；单一 provider（GitHub）下库的多 provider 抽象是纯开销；B/C 只封装了最简单的 30%（拼 URL + 换 token），而真正的复杂度（verified 邮箱关联、防接管、session 签发）在任何方案里都要自己写；手写代码全部可审计，无供应链面扩大。B 的唯一显著加分（自动 state cookie）用 ~10 行即可复刻。

## 6. 开发环境 callback 实践

- **OAuth App 只允许一个 callback URL**（官方明确 "OAuth Apps cannot have multiple callback URLs, unlike GitHub Apps"）→ **标准做法：为 dev 单独注册一个 OAuth App**（README 指引部署者各自注册），dev/prod 两套 `GITHUB_CLIENT_ID/SECRET` 走 env（仿 `env.ts` 中 `inviteCode`/`xhsMcpUrl` 的"空值即关闭该功能"模式）。[GitHub Docs, 2026, https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app]
- dev callback 建议注册 `http://localhost:5173/api/auth/github/callback`（vite 把 `/api` 代理到 3001）：浏览器全程停留在 5173 origin，`sameSite=lax` cookie 在顶层 GET 重定向下正常携带，且相对路径跳转与 prod（server 同源伺服 SPA）行为一致。GitHub 允许 http 的开发回调（文档示例本身即 http）。
- 备选：直接注册 `http://localhost:3001/...`。cookie 按 RFC 6265 不区分端口（host 均为 localhost），技术上也可行，但登录后需要跨端口跳回 5173，URL 处理易出错，不如 vite 代理方案。
- 注意：`localhost` callback 的**端口必须精确匹配**注册值；只有 loopback 字面量 `127.0.0.1`/`::1` 才允许任意端口（见 §1.4）。若想避免 vite 端口漂移问题（本机曾出现 5173 被占顺延），在 `vite.config` 固定 `server.port: 5173, strictPort: true`。
- 出站请求提示：`apps/server/src/lib/proxy.ts` 已设置 undici `EnvHttpProxyAgent` 全局 dispatcher，github.com/api.github.com 的出站 fetch 会自动走系统代理环境变量——本机代理环境下反而是优势，无需额外处理。

## 7. 本仓库落点（内部检索结果）

| 文件 | 相关性 |
|---|---|
| `apps/server/src/auth/session.ts` | `createSession(userId)` 直接复用；登录成功后 `reply.setCookie(SESSION_COOKIE, token, COOKIE_OPTS)` |
| `apps/server/src/routes/auth.ts` | 路由/限流/`COOKIE_OPTS` 模板；新增 `GET /auth/github` 与 `GET /auth/github/callback` 可放同文件 |
| `apps/server/src/db/schema.ts` | ⚠️ `users.passwordHash NOT NULL`、`users.email NOT NULL UNIQUE`——接入 OAuth 需让 `passwordHash` 可空（或加 `githubId` 列 + email 关联策略），是本次改动的主要 schema 决策点 |
| `apps/server/src/env.ts` | 新增 `githubClientId`/`githubClientSecret`（空 = 功能关闭）符合现有模式 |

## Caveats / 单一来源标注

- token 端点出错仍返回 HTTP 200：社区经验，官方未写状态码 → 按"检查 body.error"实现即可规避。
- MSRC pre-hijacking 文章仅核实 URL 可达、未核实正文；nOAuth（Descope）标题已核实。
- PKCE 对 OAuth App 的支持为近期变更（docs feature flag `pkce_support` 仅 fpt/ghec），GHES 旧版可能不支持——自托管 GHES 场景不在本项目范围。
