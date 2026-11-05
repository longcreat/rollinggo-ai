# PRD — Phase C2+C3 多 Agent 生成流水线

> 需求与架构已在正式文档定稿，本 PRD 为指针 + 差异记录，不重复正文：
> - 需求：[docs/PRD.md](../../../docs/PRD.md)（F1 智能生成、F8 配额与用量）
> - 架构：[docs/TECHNICAL_ARCHITECTURE.md](../../../docs/TECHNICAL_ARCHITECTURE.md)（§5 多 Agent、§6 小红书、§7 API、§12/§12.1 C0 核对结果与映射表）
> - 计划：[docs/DEVELOPMENT_PLAN.md](../../../docs/DEVELOPMENT_PLAN.md)（Phase C2 / C3 任务清单与验收标准）

## 范围

**C2 服务端**（apps/server/src/generation/ + routes/generations.ts）：
- `model.ts` Key 双轨（已有 settingsService.resolveLlmConfig）→ pi-ai 自定义 Model；BYOK 使用时二次 ssrfGuard ✅（已完成）
- `draft.ts` DraftTrip 内存草稿 + 完整性校验 ✅（已完成）
- `prompts.ts` 调研/编排/审校三份 system prompt
- `tools/` 四组工具（xhs/geo/draft/review）
- `agents/` 三 Agent 装配 + 公共 runner（pi-agent-core）
- `orchestrator.ts` 三阶段流水线 + ≤2 轮修订 + token/xhs 用量聚合
- `jobManager.ts` 内存任务表 + 512 条事件环形缓冲 + 取消 + Last-Event-ID 重放
- 路由：POST /api/generations（配额→429+重置时间）、GET :jobId/events（SSE）、POST :jobId/cancel、GET :jobId（刷新恢复快照）
- 任务落 `generations` 表（取消/失败不计配额）；全站小红书日额度用尽 → 注入 NullContentSource

**C3 前端**（apps/web/src/pages/PlannerPage.tsx 等）：
- 表单（含「今日剩余 N 次」）→ GenerationTimeline（三阶段/工具时间线/思考折叠/token 用量/取消）
- EventSource 断线重连 + 刷新恢复；完成跳编辑器
- 异常文案全套：配额尽 / 无 Key 指引（普通 vs 极客）/ 401 / 降级标注 / 审校遗留

## 验收（引用计划文档）

- C2：curl 建任务→SSE 三阶段→job_done 落 trips+generations；配额用尽 429；cancel 无残留不计数；BYOK 走自己端点且计次
- C3：PRD F1 五项 + F8 三项全过

## 差异与决策记录

- SSE 事件协议定义于 `packages/shared/src/types.ts`（GenerationEvent），前后端共用
- 本机无 SITE_LLM_* Key：端到端在线验收改用 `scripts/smoke-pi.mjs` + mock/真实 Key 二选一，站长部署后复验
- 全站 XHS 日额度检查：任务启动时按 generations.xhs_calls 聚合（60s 内存缓存），并发任务有界超额（≤并发数×14 次），KISS 取舍已记录
