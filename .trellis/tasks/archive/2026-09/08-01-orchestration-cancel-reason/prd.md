# 编排计划取消时显示取消原因提示

## Goal

智能生成任务被取消时,前端时间线不显示任何原因,用户无法得知是被自己取消还是因超时被系统自动取消。本任务补充取消原因,让用户在「编排计划被取消」时看到明确的提示。

## What I already know

* 取消只有两条路径,且走同一条 abort → `cancelJob` 代码路径:
  1. 用户点击「取消生成」→ `POST /:jobId/cancel` → `job.abort.abort()`
  2. 整任务超时(`JOB_TIMEOUT_MS = 10 分钟`)→ `setTimeout(() => job.abort.abort(), ...)`
* `job_cancelled` 事件载荷无 reason 字段;`job_error` 有 message
* 前端 `GenerationTimeline` 对 `job_cancelled` 终态不渲染任何提示
* 后端取消后落库 `generations.status = 'cancelled'`,不计配额(配额只数 done)

## Assumptions (temporary)

* 需要区分的取消原因:用户主动取消 vs 系统超时取消(用户已确认:区分两条路径)
* 提示文案由前端渲染,事件载荷增加 reason 字段向后兼容(旧事件无 reason)

## Open Questions

* 超时取消的文案措辞?(推荐:系统自动提示与重新生成引导)
* 是否需要在落库 `generations` 表增加 reason 列以留存审计?(可能超 MVP)

## Requirements (evolving)

* `job_cancelled` 事件增加 `reason: 'user' | 'timeout'` 字段(可选,缺省按用户取消处理)
* 前端时间线在终态为 `job_cancelled` 时渲染对应提示

## Acceptance Criteria (evolving)

* [ ] 用户主动取消:时间线显示「已取消」+ 用户取消的提示
* [ ] 超时自动取消:时间线显示「已取消」+ 超时原因提示
* [ ] 旧事件(无 reason)重放不崩溃,按缺省提示

## Definition of Done (team quality bar)

* Lint / typecheck 通过
* 相关测试(如 jobManager / timeline 测试)更新

## Out of Scope (explicit)

* generations 表落库 reason 审计列(如需再开任务)

## Technical Notes

* `packages/shared/src/types.ts` — `job_cancelled` 事件载荷
* `apps/server/src/generation/jobManager.ts` — `cancelJob(job)`
* `apps/server/src/generation/orchestrator.ts` — 超时 setTimeout 与 catch 中 `signal.aborted` 分支
* `apps/web/src/components/GenerationTimeline.tsx` — 终态渲染
* `apps/web/src/pages/PlannerPage.tsx` — onCancel 手动 append `job_cancelled` 事件
* `apps/web/src/lib/generationTimeline.ts` — buildTimeline 重建终态
