# 注册邮箱验证码校验

## 背景

当前邮箱密码注册（`apps/server/src/routes/auth.ts:55`）只要邀请码（或 open 模式无门槛）即可建号并直接签发会话，邮箱真实性无任何校验。任何人可用任意邮箱地址注册，导致：

- 邮箱归属无法证明，后续找回密码 / 通知投递失去可信基础
- open 模式下可批量刷号占用配额

## 目标

`registrationMode = open` 时，邮箱密码注册必须先通过邮箱验证码；同时补齐「忘记密码」链路，用同一套验证码设施重置密码。

## 范围

### 做

1. **验证码发信通道**：Resend API（`https://api.resend.com/emails`），新增集成 `apps/server/src/integrations/resend.ts`
2. **验证码存储**：新表 `email_verification_codes`
3. **发送接口**：`POST /api/auth/email-code`，body `{ email, purpose }`，purpose ∈ `register` | `reset`
4. **注册接口改造**：`POST /api/auth/register` 在 open 模式下必填 `code`
5. **找回密码接口**：`POST /api/auth/password-reset`，body `{ email, code, password }`
6. **前端**：注册页 open 模式显示验证码输入 + 获取验证码按钮（60s 倒计时）；登录页加「忘记密码」入口与新页面
7. **环境变量**：`RESEND_API_KEY`、`MAIL_FROM`，覆盖本地 `.env`、`.env.example`、线上 `/opt/trip-weaver/.env`

### 不做

- invite / closed 模式不加验证码（invite 已有邀请码门槛，closed 不开放注册）
- GitHub OAuth 注册不变（邮箱由 GitHub verified 保证）
- 登录不加验证码
- 不做邮件模板系统，正文写死在集成里

## 关键设计

### 数据表

```sql
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  purpose       text NOT NULL,          -- register | reset
  code_hash     text NOT NULL,          -- bcrypt，不存明文
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL
);
CREATE INDEX ... ON email_verification_codes (email, purpose, created_at DESC);
```

同一 `(email, purpose)` 只认最新一条未消费记录；消费后置 `consumed_at`，不可复用。

### 验证码参数

| 项 | 值 |
|---|---|
| 位数 | 6 位数字（`randomInt(0, 1000000)` 补零） |
| 有效期 | 10 分钟 |
| 重发间隔 | 60 秒（同邮箱同 purpose，查最近一条 created_at） |
| 同邮箱每小时上限 | 5 次 |
| 校验失败上限 | 5 次（达到即作废该条，需重新获取） |

### 安全

- 验证码存 bcrypt 哈希，日志与响应不回显
- 发码接口限流：IP 每小时 10 次（复用 `@fastify/rate-limit`），另加同邮箱频控
- `purpose=register` 若邮箱已注册，返回与成功一致的响应，不泄露账号存在性（避免枚举）
- `purpose=reset` 若邮箱不存在，同样静默成功
- 重置成功后销毁该用户全部会话（`sessions` 表按 user_id 删除）

### 环境变量

| 变量 | 说明 |
|---|---|
| `RESEND_API_KEY` | Resend API Key；缺失时发码接口返回 503，注册在 open 模式下不可用并给出明确文案 |
| `MAIL_FROM` | 发件人，如 `Trip Weaver <noreply@example.com>`，域名须在 Resend 验证 |

## 验收标准

1. open 模式下不带验证码注册 → 400，文案提示需要验证码
2. `POST /api/auth/email-code` 返回 200，Resend 收到请求；重复请求 60 秒内 → 429
3. 正确验证码注册成功并签发会话；错误验证码 → 400；过期验证码 → 400
4. 同一验证码第二次使用 → 400（已消费）
5. invite 模式注册流程不出现验证码字段，行为与现在一致
6. `POST /api/auth/password-reset` 正确验证码 + 新密码 → 可用新密码登录，旧会话失效
7. 前端注册页 open 模式显示验证码输入与倒计时按钮；invite 模式不显示
8. 登录页「忘记密码」可进入重置流程并成功改密
9. `pnpm -r typecheck` + 相关单测通过

## 验证记录（2026-10-18）

真实环境（本地 server + 真实 Resend 发信 + 真实收件邮箱 ylvanelch24@sakiiko.com）：

| # | 结果 | 证据 |
|---|---|---|
| 1 | 通过 | 无 key 时 503；有 key 后缺码 400「请输入邮箱验证码」 |
| 2 | 通过 | `POST /email-code` 200，Resend 后台出现该邮件（from `noreply@notify.sakiiko.com`） |
| 3 | 通过 | 用真实收到的码注册 → 201 建号，新密码登录 200 |
| 4 | 通过 | 同一码二次提交 → 400；数据库 `consumed_at` 已置位 |
| 5 | 通过 | 临时端口起 `REGISTRATION_MODE=invite` 实例：无邀请码 403、错邀请码 403、正确邀请码 201 且不需要验证码；`purpose=register` 请求码 403；前端注册卡片只有邀请码字段，无邮箱验证码 |
| 6 | 通过 | 重置 200 → 旧密码 401、新密码 200；会话数从 2 降为 1（重置后重新登录的那条） |
| 7 | 通过 | 拦截 config 返回 `emailCodeEnabled: true` 后截图确认字段与倒计时按钮渲染 |
| 8 | 通过 | 登录弹窗有「忘记密码？」，重置页渲染正常 |
| 9 | 通过 | `npm run typecheck` 四个包全绿 |

一次性验证脚本（已删除）覆盖的消费语义 10/10 通过：正确码消费、同码不可重用、错码失败、错码不占位、用途隔离双向、过期码、试错用尽、只认最新一条。

### 发信子域名

`notify.sakiiko.com`（不用 `mail.sakiiko.com` —— 那个子域已被临时邮箱服务占用）。Cloudflare DNS 已加 4 条记录并由 Resend 验证通过：

| 类型 | 名称 | 值 |
|---|---|---|
| TXT | `resend._domainkey.notify.sakiiko.com` | DKIM 公钥 |
| MX (10) | `send.notify.sakiiko.com` | `feedback-smtp.ap-northeast-1.amazonses.com` |
| TXT | `send.notify.sakiiko.com` | `v=spf1 include:amazonses.com ~all` |
| CNAME | `rsend.notify.sakiiko.com` | `send.forge.rmta.net` |

### 上线记录

- 工作提交 `6a8976b` push 后 CI docker 构建成功（1m32s），服务器 `docker compose pull && up -d` 完成重建
- 线上 `/api/auth/config` 返回 `emailCodeEnabled: true`，发件人 `noreply@notify.sakiiko.com`
- 线上真实发信验证：Resend 记录 `delivered`，线上库 `email_verification_codes` 有对应未消费记录

### 后续可选

- 线上仍是 `REGISTRATION_MODE=open`，invite 模式只在本地临时实例回归过；若以后切 invite，需再跑一次注册回归

## 待用户提供

- Resend 账号与 API Key
- 已验证发件域名与 `MAIL_FROM` 具体值
