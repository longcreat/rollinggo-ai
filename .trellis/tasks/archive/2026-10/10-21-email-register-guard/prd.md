# 注册邮箱格式校验与已注册提示

## Goal

注册流程的「获取验证码」有两处体验缺陷：

1. **邮箱格式只靠浏览器原生校验**：`type="email"` 放行 `a@b`（无域名后缀）这类写法，落到后端正则才 400，界面显示「请求参数不正确」，用户不知道错在哪
2. **已注册邮箱是死路**：`/api/auth/email-code` 对已注册邮箱静默返回 `{ok:true}` 但**不发信**（原设计为防止账号枚举），前端照样提示「验证码已发送，请查收邮件」，用户永远收不到码，也没有任何提示告诉他该去登录

## 现状证据

- `packages/shared/src/schemas.ts:212` `EmailSchema`：`^[^@\s]+@[^@\s]+\.[^@\s]+$`，maxLength 100
- `apps/server/src/routes/auth.ts:74` `if (purpose === 'register' ? Boolean(existing) : ...) return reply.send({ ok: true });` —— 已注册即静默成功，注释写明是「为了不泄露账号是否存在」
- `apps/web/src/pages/RegisterPage.tsx:59` `<Input type="email" required ...>` 无应用层校验
- `apps/web/src/components/EmailCodeField.tsx:35` 只判断 `!target` 空值，非空就发请求

## Requirements

### R1 已注册时明确拒绝（用户已确认接受泄露账号存在性）

`POST /api/auth/email-code`，`purpose === 'register'` 且邮箱已存在时，改为返回 **409** + `{ error: '该邮箱已注册，请直接登录' }`，不再静默成功。

`purpose === 'reset'` 的行为**保持不变**（邮箱不存在仍静默成功）—— 那是找回密码，不能变成「哪个邮箱没注册」的探测器。

### R2 前端把 409 转成可操作提示

`EmailCodeField` 收到该错误时：

- 错误文案直接展示（`setError`）
- 额外渲染一个「去登录」按钮，点击后切到登录态（复用现有 `useLogin` / 弹窗的切换方式，与 `RegisterPage` 里「已有账号？登录」同一条路径）

### R3 应用层邮箱格式校验（前端）

在发送验证码与提交注册前，用与后端一致的正则做显式校验，给出具体中文提示：

| 情况 | 提示 |
|---|---|
| 未填 | 请先填写邮箱 |
| 缺 `@` 或域名后缀 | 邮箱格式不正确，请检查后重试 |
| 含空格 | 邮箱不能包含空格 |
| 超过 100 字符 | 邮箱过长（最多 100 字符） |

后端正则不变（沿用 `EmailSchema`）。

### R4 注册提交时的后端提示保持一致

`POST /api/auth/register` 已注册返回的 409 文案与 R1 统一为「该邮箱已注册，请直接登录」，前端同样展示「去登录」入口。

## Acceptance Criteria

- [x] `npm run typecheck` 通过 — 2026-10-21 EXIT=0
- [x] `node --import tsx scripts/verify-sql-first.mts` 全 pass（含新增 `emailRegisterGuard.test.ts`）— 104/104
- [x] 单测：`/email-code` register + 已注册 → 409 且不发信 ✓
- [x] 单测：`/email-code` reset + 未注册 → 仍 200 静默（且不发信）✓
- [x] 单测：格式非法（无 `@`、无后缀、含空格、超长）→ 400，不消耗发信额度 ✓
- [x] 单测：`/register` 对已注册邮箱返回同一句「该邮箱已注册，请直接登录」✓
- [x] 浏览器测试：已注册邮箱点「获取验证码」→ 出现提示与「去登录」按钮，点击后切到登录弹窗 ✓
- [x] 浏览器测试：填 `bad-email` → 出现「邮箱格式不正确」，且 `emailCodeRequests.length === 0`（未发请求）✓
- [x] 现有 `login-dialog-browser.mjs` 通过（不回归）✓
- [x] `home-mobile` / `shared-ui` / `travel-preferences` 浏览器测试通过 ✓

### 实跑记录

- 单测需 `RESEND_API_KEY` 存在（否则 `hasEmailDelivery()` 为 false 会直接 503），已在 `verify-sql-first.mts` 的 spawn env 里加 `RESEND_API_KEY=re_verify_fixture`，测试内部拦 `https://api.resend.com/emails` 只记录不真发
- `runMigrations()` 必须传 `pool`：`await runMigrations(pool)`，否则 `Cannot read properties of undefined (reading 'connect')`
- `users` 表没有 `updatedAt` 列，测试插入时带上会 typecheck 失败

## Out of Scope

- 不改找回密码流程的防枚举行为
- 不加图形验证码 / 行为验证
- 不改后端 `EmailSchema` 正则
- 不做邮箱可达性（MX 记录）校验

## Technical Notes

- 前后端共用同一份正则：从 `@tripweaver/shared` 导出 `EMAIL_PATTERN` 供前端复用，避免两处写法漂移
- 409 的判断在路由层（已有 `existing` 查询），不动 `emailCode.ts`
