# 修复取消生成按钮无响应

## Goal

修复行程生成过程中点击“取消生成”后页面无可见响应的问题，确保取消请求能够可靠终止当前生成任务，并让界面及时进入明确的取消完成或取消失败状态。

## What I already know

- 生成页位于 `apps/web/src/pages/PlannerPage.tsx`，取消按钮由 `GenerationTimeline` 渲染。
- 点击按钮会调用 `useCancelGeneration()`，向 `/api/generations/:jobId/cancel` 发送 POST 请求。
- 服务端取消路由会调用任务的 `AbortController.abort()`；生成编排器捕获取消后记录 cancelled 状态并发送 `job_cancelled` SSE 事件。
- 前端当前仅把 mutation 的 `isPending` 显示为“取消中…”，没有处理取消请求失败，也没有在请求成功后主动核对任务状态。
- 项目已有 `scripts/verify-c2.mjs` 的取消接口检查和 `scripts/verify-c3.mjs` 的浏览器取消流程检查，可用于回归验证。

## Confirmed Decisions

- 用户所说的“点击无反应”指生成时间线中的“取消生成”按钮。
- 点击后立即显示“取消中…”，等待服务端权威终态；收到 `job_cancelled` 后展示“已取消”并允许返回表单。
- 取消请求失败时展示错误并恢复重试能力，不在前端提前伪造取消成功状态。
- 修复应优先保持现有 API 与 SSE 架构，不引入新依赖或重构整条生成流水线。

## Open Questions

- 无阻塞问题；按现有产品文案与验证脚本定义取消后的预期行为。

## Requirements

- 点击“取消生成”后必须立即给出可见反馈并防止重复提交。
- 取消请求成功后，页面必须可靠收敛到 `job_cancelled` 终态，而不是无限停留在“取消中…”。
- 取消请求失败时必须恢复按钮可操作状态并展示明确错误，不能静默失败。
- 取消完成后继续保持“不计入今日生成配额”的现有语义。
- 刷新恢复、正常完成和生成失败流程不得回归。

## Acceptance Criteria

- [ ] 运行中的任务点击“取消生成”后，按钮立即显示取消中的状态且不可重复点击。
- [ ] 服务端接受取消后，前端在合理时间内显示“已取消”。
- [ ] 用户可点击“返回表单”清理当前任务状态并重新填写。
- [ ] 取消 API 失败时，页面显示可理解的错误提示，按钮恢复可点击。
- [ ] 取消任务不消耗成功生成配额。
- [ ] 相关 TypeScript 类型检查通过。
- [ ] 现有取消接口与浏览器验证脚本通过，或记录无法运行的环境原因。

## Definition of Done

- 修复范围保持局部且复用现有 React Query、SSE 与任务状态机制。
- 必要的自动化验证已运行并通过。
- 检查前后端相关文件的 IDE diagnostics / lint diagnostics。
- 任务上下文、实现说明和验证结果完整记录。

## Out of Scope

- 将内存生成任务迁移到持久化队列。
- 修改每日配额策略。
- 重做生成时间线或其他页面视觉设计。
- 修改正常完成、失败和刷新恢复流程的产品语义。

## Technical Notes

- 重点文件：
  - `apps/web/src/pages/PlannerPage.tsx`
  - `apps/web/src/components/GenerationTimeline.tsx`
  - `apps/web/src/api/hooks.ts`
  - `apps/server/src/routes/generations.ts`
  - `apps/server/src/generation/jobManager.ts`
  - `apps/server/src/generation/orchestrator.ts`
  - `apps/server/src/generation/agents/runner.ts`
- 优先通过运行时复现确认根因；当前静态代码显示最明显的可靠性缺口是前端取消 mutation 缺少成功后的状态核对与失败反馈。
- 回归入口：`scripts/verify-c2.mjs`、`scripts/verify-c3.mjs`。
