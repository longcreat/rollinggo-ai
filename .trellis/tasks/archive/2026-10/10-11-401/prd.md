# 未登录探测接口 401 控制台噪音治理

## Goal

未登录用户打开任意页面时，浏览器控制台固定出现 `GET /api/auth/me → 401 Unauthorized` 红色报错。这条记录来自浏览器对 4xx 响应的默认行为，前端已有 `catch` 也无法抑制。

将 `GET /api/auth/me` 改为「未登录返回 `200 + data:null`」，让控制台干净，同时不改变登录态判定语义（guest / 已登录分支不变）。

## What I already know（实测证据）

用 Playwright 无头 Chromium（未登录）访问 `http://localhost:5173/`、`/login`、`/plan`，捕获 console / pageerror / 网络失败，结果：

- console 唯一 error：`Failed to load resource: the server responded with a status of 401 (Unauthorized)`
- 对应请求：`GET /api/auth/me` → 401，三个路由各一次
- 无 pageerror，无其他 4xx/5xx

代码链路：

| 环节 | 位置 | 现状 |
| --- | --- | --- |
| 前端探测 | `apps/web/src/api/hooks.ts:76-89` `useMe()` | `api.get('/api/auth/me', { auth: 'public' })`，catch 401 → `null` |
| 服务端鉴权 | `apps/server/src/auth/guard.ts:11` `requireAuth` | 无有效会话 → `reply.code(401)` |
| 路由 | `apps/server/src/routes/auth.ts:156` `app.get('/me', { preHandler: requireAuth })` | 直接返回 `request.user` |
| 响应包装 | `apps/server/src/http/apiResponse.ts:7` `onSend` | 2xx → `{code:0,message:'成功',data:value}`；`value === null` 直接可用 |

其他事实：

- `useMe` 传 `auth: 'public'`，事件监听器**不会**收到它的 401（`client.ts` 的 `unauthorizedListeners` 只对非 public 请求触发）
- `apps/web/tests/generation-recovery-browser.mjs` 的 mock 用通配 fallback 401，**没有**显式 mock `/api/auth/me`（其 route 只覆盖 `/api/generations*`）
- 本机没有 `trellis-implement` / `trellis-check` 子代理（`.pi/agents` 不存在，用户级 agents 仅 `vision.md`），Phase 2 由主会话直接实现

## Requirements

- **R1** 服务端 `GET /api/auth/me` 无有效会话时返回 HTTP 200，响应体 `{code:0, message:'成功', data:null}`
- **R2** 已登录时行为不变（HTTP 200 + `{id, email}`）
- **R3** 前端 `useMe` 直接返回 `MeView | null`，删除 401 catch 分支（服务端不再返回 401，该分支成为本次改动产生的孤儿代码）
- **R4** `useMe` 保留 `auth: 'public'`：网关/代理层异常 401（HTML 响应）不得触发全局登出
- **R5** 把 4 处浏览器测试里「未登录 `/api/auth/me`」的 mock 从 401 改为 200 + `data:null`：
  - `apps/web/tests/login-dialog-browser.mjs:29`
  - `apps/web/tests/home-mobile-browser.mjs:47`
  - `apps/web/tests/travel-preferences-browser.mjs:30`
  - `apps/web/tests/shared-ui-browser.mjs:17`
- **R6** 同步更新描述该契约的文档

## Acceptance Criteria

- [x] `curl http://localhost:8787/api/auth/me`（无 cookie）→ HTTP 200，`{"code":0,"message":"成功","data":null}`
- [x] 带有效会话 cookie → HTTP 200，`data:{id,email}`
- [x] Playwright 抓取：未登录访问 `/`、`/login`、`/trips`，console 无 error
- [x] 未登录访问 `/trips` 仍跳转登录（guest 判定不回归）
- [x] R5 列出的 4 个浏览器测试通过
- [x] `npm run typecheck` 通过

## 验收实测（2026-10-18）

代码已在 `fac7f34`（服务端）与 `5001116`（前端 useMe + 测试夹具）入库，本次补跑验收并修复两个早已漂移的浏览器测试。

| AC | 实测结果 |
|---|---|
| 无 cookie | `HTTP/1.1 200 OK` + `{"code":0,"message":"成功","data":null}` |
| 带 cookie | `200` + `data:{id:"4ac7acd4…",email:"b@test.dev"}`（库内造 session） |
| 三页 console | `/`、`/login`、`/trips` 均 `console error = 0`、`/api` 4xx+ = 0 |
| `/trips` 未登录 | 落地 `/` 且登录弹窗 `dialog[open]` 打开（产品已改为弹窗登录，不再有独立 `/login` 页） |
| 4 个浏览器测试 | 全 PASS（修了 2 个，见下） |
| typecheck | 四包零错误 |

### 修复的两个漂移测试

**`shared-ui-browser.mjs`**（两处产品变更导致）：

1. 登录改弹窗后，页头与弹窗里各有一个「登录」按钮，`getByRole('button', { name: '登录', exact: true })` 命中 2 个 → 改为在 `dialog[open]` / `getByRole('dialog', { name })` 内 scope；弹窗里切注册是 `button` 而非 `link`
2. 注册表单新增 required 的「邮箱验证码」字段，留空时原生校验拦住 submit，应用层提示不出现 → 提交前先填 6 位验证码；`getByLabel('邮箱')` 非 exact 会同时命中「邮箱验证码」→ 加 `exact: true`

删除了一段过期断言（`设置` 弹窗的 aria-labelledby / 宽度 / ESC / 焦点恢复）：`SettingsDialog` 当前全仓只有定义、无任何引用（死代码），该弹窗根本打不开；Modal 的同组断言已由 `login-dialog-browser.mjs` 覆盖（其 PASS 输出含 `dialog error/close/focus`）。移动端不溢出断言保留。

**`login-dialog-browser.mjs`**（两处）：

1. 密码不一致断言前补填验证码（否则原生校验拦住，永远看不到「两次输入的密码不一致」）
2. 注册成功路径同样补填验证码（否则注册请求发不出去，等不到跳转 `/trips?filter=all#top`）

> 根因都属于 `10-18-email-verification-register` 加验证码时未同步测试，与本任务的 `/me` 改造无关。

## Definition of Done

- 测试更新（上述 4 个 mock + 必要时补 `/api/auth/me` 显式 mock）
- `npm run typecheck` 全绿
- 契约文档更新（见 R6）
- 无遗留孤儿代码

## Technical Approach

服务端：

1. `apps/server/src/auth/guard.ts` 抽出 `resolveUser(request): Promise<{id;email} | null>`，内部读取 `SESSION_COOKIE` + `validateSession`；`requireAuth` 复用它，保持原 401 行为
2. `apps/server/src/routes/auth.ts` 的 `/me` 去掉 `preHandler: requireAuth`，改为 `return resolveUser(request)`；`null` 由 `onSend` 包装成 `data:null`（已确认无需改包装逻辑）

前端：

3. `apps/web/src/api/hooks.ts` 的 `useMe` 简化为
   `queryFn: ({ signal }) => api.get<MeView | null>('/api/auth/me', { auth: 'public', signal })`
   删除 `try/catch` 与 `ApiError` 判断；`ApiError` 仍被其他 hooks 使用，import 保留

测试：

4. 按 R5 改 mock；`generation-recovery-browser.mjs` 若因通配 fallback 仍返回 401 而影响断言，补一条 `/api/auth/me` → 200 + null

文档：

5. 更新 `.trellis/spec/web/frontend/directory-structure.md`、`.trellis/spec/web/frontend/hook-guidelines.md`、`.trellis/spec/server/backend/security-guidelines.md`、`docs/TECHNICAL_ARCHITECTURE.md`

## 范围扩展：第二处同类噪音（2026-10-11 追加）

排查中发现另一处控制台报错，同属「预期外的 console 输出未消除」：

- **位置**：`apps/web/src/components/NotificationCenter.tsx:54`
- **代码**：`useQuery({ queryKey: keys.trip(routeTripId), enabled: false })`，漏了 `queryFn`
- **引入**：`a50e2d7 feat(web): 顶部导航、全局生成与站内通知`（既有代码，非本次改动）
- **触发**：登录后（`AppLayout.tsx:56` 的 `{userId && <NotificationCenter …/>}`），未登录不渲染
- **证据**：登录态首页一次加载 8 条 `[["trips",""]]: No queryFn was passed as an option…`
- **根因**：v5.101 的 dev 检查只看 `defaultedOptions.queryFn` 是否存在，与 `enabled` 无关（`node_modules/@tanstack/react-query/build/modern/useBaseQuery.js:39`）

修法：补 `queryFn: skipToken`。v5 的 `defaultQueryOptions` 对该值直接设 `enabled = false`（`query-core/build/modern/queryClient.js`），与现状完全等价，缓存订阅与 `.data` 不受影响。

- **R7** 该 query 补 `queryFn: skipToken`
- **验收**：登录态首页 `console.error = 0`；`node --import tsx apps/web/tests/navigation-notifications-browser.mjs` 全 PASS（覆盖依赖 `displayedTrip.data` 读缓存的通知自动已读）

## Out of Scope

- 其他受保护接口的 401（`/api/trips`、`/api/settings` 等真实需要登录，保留）
- `apps/web/src/router.tsx` 中 `RequireAuth` 的 `me.error.status === 401` 分支 —— 改动前就已是死代码（`useMe` 从不因 401 进入 error 态），属既有死代码，本次只记录不删除
- 新增「统一未登录探测接口」之类的抽象

## Technical Notes

- 服务端契约参考：`.trellis/tasks/archive/2026-10/10-03-api-response-contract`（HTTP 状态与 `code` 一致）
- 实测脚本方式：Playwright（项目 devDependency）无头 Chromium + `page.on('console'|'pageerror'|'requestfailed'|'response')`
- 本地 dev 服务：vite `5173`（proxy `/api`、`/media` → `8787`），server `8787`
