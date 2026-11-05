# 在设置页配置高德 API

## Goal

允许用户在前端设置页填写和更新高德 Web 服务 Key，并由服务端安全保存、脱敏展示和用于行程生成中的高德 POI 调研，减少必须修改服务器 `.env` 并重启服务的运维成本。

## What I already know

- 当前高德 Key 仅从 `apps/server/src/env.ts` 的 `AMAP_KEY` 读取。
- `apps/server/src/integrations/amap/poiSource.ts` 在模块加载时基于环境变量创建站点级单例，高德 Key 变更后无法动态生效。
- 设置页 `apps/web/src/components/SettingsDialog.tsx` 已支持用户级 LLM API Key。
- `apps/server/src/services/settingsService.ts` 使用 `MASTER_KEY` 和 AES-256-GCM 加密用户 LLM Key，只向前端返回尾号。
- `user_settings` 表目前只有 LLM BYOK 字段，需要迁移才能保存高德凭据。
- 数据源自检 `/api/settings/sources-status` 当前探测站点级高德源，并使用 60 秒全局缓存。
- 生成任务当前只按用户解析 LLM 配置，高德源仍直接使用站点级单例。

## Confirmed Decisions

- 采用用户级高德 Key：当前用户保存的 Key 仅用于自己的生成任务；未配置时回退到站点 `AMAP_KEY`；两者都没有时保持 Null 降级。
- 高德 Key 与 LLM Key 使用相同的服务端加密能力，前端永远不回传明文，只显示尾号。
- 保存后无需重启服务，后续生成和数据源自检立即使用新配置。
- MVP 支持保存、更新和清除个人高德 Key；清除后恢复使用站点默认配置。

## Open Questions

- 无阻塞问题。

## Requirements (evolving)

- 设置页提供高德 Web 服务 Key 密码输入框和已保存尾号提示。
- Key 明文不得出现在 GET 设置响应、日志或前端缓存中。
- 空输入表示保留已有 Key，避免打开设置后必须重复填写。
- 提供显式清除操作，不能用普通空输入隐式删除凭据。
- 保存后数据源状态检测和新生成任务使用最新有效配置。
- 保留 `AMAP_KEY` 环境变量作为站点默认配置和兼容路径。
- 高德不可用时继续按现有方式降级，不阻断行程生成。

## Acceptance Criteria (evolving)

- [ ] 用户可以在设置页保存高德 Web 服务 Key。
- [ ] 用户可以显式清除个人 Key，并恢复站点配置或未配置降级状态。
- [ ] 设置响应仅返回是否已配置和尾号，不返回明文或密文。
- [ ] 保存的 Key 使用 `MASTER_KEY` 加密后落库。
- [ ] 用户配置优先于站点 `AMAP_KEY`，未配置时正确回退。
- [ ] 保存后无需重启即可用于数据源自检和新生成任务。
- [ ] 无效 Key 的自检显示明确错误，但不会破坏其他设置。
- [ ] 存量数据库迁移幂等且不影响现有 LLM BYOK 设置。
- [ ] TypeScript 类型检查及相关服务端、浏览器验证通过。

## Definition of Done

- 前端、共享 schema、设置 API、加密持久化、迁移、高德源解析和生成链路保持一致。
- 增加有价值的回归覆盖，特别是加密、优先级、动态生效和用户隔离。
- 相关 IDE diagnostics、类型检查和构建通过。
- 更新配置文档，说明环境变量与用户配置的优先级。

## Out of Scope

- 前端配置高德每日全站预算。
- 管理员后台或角色权限系统。
- 前端配置 Web 搜索 Key。
- 前端展示或恢复完整 Key 明文。
- 修改高德 API 协议、POI 映射或配额统计策略。

## Technical Notes

- 预计涉及：
  - `packages/shared/src/schemas.ts`
  - `apps/server/src/db/schema.ts`
  - `apps/server/src/db/migrate.ts`
  - `apps/server/src/services/settingsService.ts`
  - `apps/server/src/routes/settings.ts`
  - `apps/server/src/integrations/amap/poiSource.ts`
  - `apps/server/src/generation/orchestrator.ts`
  - `apps/web/src/api/hooks.ts`
  - `apps/web/src/components/SettingsDialog.tsx`
- 数据流：设置表单 → `PUT /api/settings` → 加密持久化 → 用户级高德源解析 → 自检/生成任务。
- 需避免把用户 Key 注入全局单例或全局状态缓存，否则可能产生跨用户凭据泄漏。
