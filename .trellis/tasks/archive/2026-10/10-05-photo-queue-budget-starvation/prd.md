# 修复选图队列额度耗尽后新任务被无限期饿死

## Goal

后台选图队列（`photoReviewQueue`）的滚动 24h 额度一旦被打满，**从未启动过的新任务会被整体排除在调度之外，且没有任何日志**。用户表现为「行程详情页一个图都没有」，服务端也无法判断是额度、重试还是外部源故障。

本任务修正额度口径与可观测性，让新任务在额度饱和时得到可预期的排队行为，而不是静默无限期等待。

## What I already know

- 触发场景：10-04 21:07 生成的济南行程，13 个景点至今（10-05 13:00）零图片。
- 13 个审核任务全部 `state=queued / attempts=0 / lastStartedAt=0`，即从未被调度。
- 闸门在 `apps/server/src/integrations/photoReviewQueue.ts` 的 `tick()`：
  `capacity = 窗口内已启动地点数 < dailyLimit`，`capacity === false` 时把 `lastStartedAt === 0` 的任务全部过滤掉。
- `PHOTO_REVIEW_DAILY_PLACES` 经 `env.ts:123` 的 `Math.min(..., 50)` 处理，**50 是硬上限，只能调低**。
- 额度计数口径是「窗口内启动过」，不区分首次尝试与重试；而重试会写 `lastStartedAt = now()`，把任务重新推回窗口，使窗口无法自然滑出。
- 全仓 `[photo-review]` 日志只有 3 处（未配置 / 任务失败 / 队列读写失败），额度耗尽无任何输出。
- 当前积压：271 个任务中 `queued 168 / done 81 / failed 21`；按 50/天硬上限，清完积压 ≥3.4 天。
- 现有测试 `photoReviewQueue.test.ts` 已有一条「默认滚动预算允许50个地点，第51个等待窗口释放」，锁定了 50/窗口的对外语义，本次改动必须让它继续通过。

## Requirements

- 额度耗尽时，**重试**（`attempts > 0`）仍可继续调度，**新任务**（`attempts === 0`）排队等待。
- 额度计数只统计「首次尝试落在窗口内」的地点；重试不得占用额度，也不得把窗口向后推移。
- 额度耗尽时输出一条 warn（含当前计数、阈值、排队中的新任务数）；同一饱和期内只输出一次。
- 保持 `PHOTO_REVIEW_DAILY_PLACES` 作为「滚动 24h 处理地点数」的对外承诺语义不变，仍为硬上限 50。
- 不新增外部依赖；不改变 `enqueue` / `retryNow` 的对外行为。
- 现有 5 条 `photoReviewQueue.test.ts` 用例全部保持通过。

## Acceptance Criteria

- [ ] 新增用例：窗口被占满 + 某任务在窗口末期被重试，窗口滑过后**新任务仍能被选中**（当前实现下该用例失败）。
- [ ] 新增用例：重试不增加窗口占用计数。
- [ ] 新增用例：额度耗尽时 `warn` 被调用且只调用一次；容量恢复后再次耗尽会重新输出。
- [ ] 现有 5 条用例全绿。
- [ ] `npm run typecheck` 通过。

## Definition of Done

- 上述验收点全部有测试覆盖并通过
- `npm run typecheck` 与 `node --import tsx --test apps/server/src/__tests__/photoReviewQueue.test.ts` 通过
- 额度语义变化同步更新 `photoReviewPolicy.ts` / `env.ts` 的注释

## Technical Approach

改动全部落在 `apps/server/src/integrations/photoReviewQueue.ts`：

1. **计数口径**：`tick()` 内改为按「首次启动时刻」统计窗口占用，而不是「最后一次启动时刻」。
   为保证 `lastStartedAt` 仍能反映真实最后启动时间（运行租约恢复逻辑读 `updatedAt`，不受影响），新增一个**只写一次**的 `countedAt` 字段记录首次启动时刻；计数取 `countedAt ?? lastStartedAt`。
   `countedAt` 在 `JobSchema` 中为 `Type.Optional(Type.Number())`，因此现存 271 个任务文件不需要迁移、不会被 `Value.Check` 丢弃。
2. **放行条件**：`(capacity || j.lastStartedAt > now() - DAY)` 改为 `(capacity || j.attempts > 0)`，即额度耗尽时仍允许重试，但绝不放进新任务。
3. **可观测性**：`tick()` 计算完 `capacity` 后，若为 `false` 则调用 `options.warn`（含 `count/limit/待办新任务数`），用模块内布尔标记保证同一饱和期只输出一次；容量恢复时复位标记。

## Decision (ADR-lite)

**Context**：济南行程零图片的根因是额度闸门把新任务与重试一起饿死，且无任何日志。四个候选方案（A 改口径 / B 拆池 / C 行程插队 / D 只加日志）已写入 PRD 草稿评审。

**Decision**：采用**方案 A**——额度只计首次启动，重试不再占用额度、不再刷新窗口，同时补额度耗尽日志。B 的重试池会增加配置项与状态机复杂度；C 会绕过站点额度承诺并带来刷额度风险；D 只暴露问题不解决问题。

**Consequences**：
- 新任务的最坏等待时间从「可能被无限拉长」收敛为「窗口自然滑出」，且等待原因可见。
- **已知代价**：重试不再受额度约束，24h 内实际 LLM 审核调用次数可能超过 50（上界 = 窗口内新地点数 + 所有 `attempts < 3` 且退避到期的重试，当前积压规模下最坏约数百次）。这是为「重试能自己跑完」付出的成本代价。
- `countedAt` 对现存任务文件缺失，回退到 `lastStartedAt`；旧任务在窗口内仍按原口径计一次，24h 内自然滑出，不产生长期偏差。

## Out of Scope

- 提高 `PHOTO_REVIEW_DAILY_PLACES` 硬上限
- 手工精选图库（`data/photography/*.json`）的扩充
- 行程优先插队通道（方案 C）
- 视觉审核本身的质量与误拒问题
- 前端「排队中」进度提示的 UI 改动

## Technical Notes

- 关键文件：`apps/server/src/integrations/photoReviewQueue.ts`（`tick` / `enqueue` / `JobSchema`）
- 相关：`apps/server/src/env.ts:120-124`、`apps/server/src/integrations/photoReviewPolicy.ts`
- 现有测试：`apps/server/src/__tests__/photoReviewQueue.test.ts`（5 条）
- 队列支持注入 `dataRoot` / `now` / `dailyLimit` / `run`，可纯本地构造饱和场景，无需真实外部请求
- 研究证据：[`research/queue-starvation-evidence.md`](research/queue-starvation-evidence.md)
