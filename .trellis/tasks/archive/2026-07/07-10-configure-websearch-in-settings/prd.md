# 在设置页配置全网搜索 API

## Goal

允许用户在前端设置页保存、更新和清除个人全网搜索 API 配置，并由服务端安全加密保存，在数据源自检和后续生成任务中动态生效；未配置个人凭据时继续回退站点 `SEARCH_API_KEY` 与 `SEARCH_API_BASE_URL`，两者均不可用时保持 Null 降级。

## What I already know

- 当前全网搜索配置来自 `SEARCH_API_KEY` 和 `SEARCH_API_BASE_URL`，默认 Base URL 为 `https://api.langsearch.com`。
- `WebSearchSource` 接受 Base URL 与 API Key，并调用 `${baseUrl}/v1/web-search`。
- 当前搜索源仍是模块加载时创建的站点级单例，环境变量变化需要重启才能生效。
- 刚完成的个人高德 Key 功能已经建立了可复用模式：共享 schema、加密字段、凭据 revision、用户级解析、按用户自检缓存、动态任务源、脱敏设置视图和显式清除 UX。
- 设置页已经在同一表单中显示高德与全网搜索状态。
- Base URL 是 SSRF 边界；若允许用户配置，保存和使用时都必须复用现有 `assertSafeBaseUrl` 校验。

## Confirmed Decisions

- 与高德保持相同的用户私有作用域：个人搜索配置只用于当前用户，优先于站点配置。
- Key 使用 `MASTER_KEY` 和 AES-256-GCM 加密，API 响应仅返回存在性和尾号。
- 普通空输入保留已有凭据，显式清除才删除个人配置。
- 保存后无需重启，状态自检和新生成任务立即使用最新配置。
- 个人配置同时支持 API Key 与 Base URL，以兼容 LangSearch 和同协议服务。
- 新建个人配置时 Base URL 可默认使用 `https://api.langsearch.com`；清除个人配置时 Key 与个人 Base URL 一并清除。

## Open Questions

- 无阻塞问题。

## Requirements (evolving)

- 设置页提供全网搜索 API Key 密码输入及脱敏尾号提示。
- 设置页提供个人搜索 Base URL，保存和使用时均执行 SSRF 校验。
- 用户凭据不得出现在 API 响应、日志、前端缓存或全局搜索源单例中。
- 用户配置优先于站点配置；清除后恢复站点配置或 Null 降级。
- 数据源状态缓存必须按用户与搜索凭据 revision 隔离。
- 保存或清除后，新自检和新生成任务无需重启即可生效。
- 搜索故障继续按现有可选数据源语义降级，不阻断生成。

## Acceptance Criteria (evolving)

- [ ] 用户可以保存、更新和显式清除个人全网搜索配置。
- [ ] 设置响应不包含搜索 Key 明文或密文，只暴露必要的脱敏状态。
- [ ] 搜索 Key 使用 `MASTER_KEY` 加密入库。
- [ ] 个人配置、站点配置和 Null 源按既定优先级解析。
- [ ] 两个用户的搜索凭据、状态缓存和生成任务相互隔离。
- [ ] 保存或清除后无需重启即可动态生效。
- [ ] 个人 Base URL 保存与使用时均通过 SSRF 校验。
- [ ] 存量数据库迁移幂等且保留已有 LLM、高德设置。
- [ ] 类型检查、构建、安全检查及服务端/浏览器回归通过。

## Definition of Done

- 共享 schema、数据库、迁移、设置服务、搜索适配器、生成链路、状态探测和设置 UI 契约一致。
- 增加加密非披露、用户隔离、优先级、动态生效、清除及 SSRF 的有效回归覆盖。
- 更新 README、`.env.example` 和技术架构中的配置优先级说明。
- IDE diagnostics 与相关质量检查通过。

## Out of Scope

- 管理员修改全站搜索配置。
- 前端配置全站搜索每日预算。
- 支持与当前 `data.webPages.value` 响应协议不兼容的搜索供应商。
- 前端展示或恢复完整搜索 Key 明文。

## Technical Notes

- 预计复用个人高德配置的字段与函数组织方式，避免形成第二套凭据模型。
- 重点文件：
  - `packages/shared/src/schemas.ts`
  - `apps/server/src/db/schema.ts`
  - `apps/server/src/db/migrate.ts`
  - `apps/server/src/services/settingsService.ts`
  - `apps/server/src/routes/settings.ts`
  - `apps/server/src/integrations/websearch/searchSource.ts`
  - `apps/server/src/generation/orchestrator.ts`
  - `apps/web/src/api/hooks.ts`
  - `apps/web/src/components/SettingsDialog.tsx`
- 数据流：设置表单 → 设置 API → 加密持久化 → 用户级搜索凭据解析 → 自检/生成任务。
