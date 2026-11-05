# 行程生成耗时观测与性能优化

## Goal

让用户和开发者能明确看到一次行程生成的时间花在调研、编排、审校、工具调用和地理后处理中的哪些环节，并在不降低行程质量、不突破外部 API 限流的前提下缩短可安全优化的等待时间。

需求范围已于 2026-07-22 经用户确认。

## What I already know

* 当前生成链路为调研 -> 编排 -> 地理解析/可行性检查 -> 审校，最多执行两轮编排和两轮审校。
* 前端已有基于 SSE 事件重放的 `GenerationTimeline`，展示阶段、工具、思考和用量，但事件不含时间戳或耗时。
* 后端 `runGeneration`、`runPhaseAgent` 和地理后处理均没有结构化耗时统计。
* 地理编码、路径规划、高德 POI 和 Web 搜索受串行队列及最小调用间隔约束；不能通过直接放开并发绕过外部 API 限流。
* `geoPipeline` 会逐活动定位、逐通勤段计算，并可能在修订、自动修复和落库前重复执行；成功的高德路线跨轮缓存，失败的启发式路线有意允许后续重试。
* 当前工作区的生成编排相关文件已有用户未提交改动，实施时必须在这些改动上增量工作。

## Assumptions (temporary)

* 耗时信息既要在生成页面实时可见，也要在服务端日志中便于定位线上慢任务。
* 首版优化应保持调研、编排和审校的业务语义，不以减少质量检查换取速度。
* 性能数据只记录任务/阶段/工具名称、耗时和计数，不记录 prompt、API Key 或用户敏感输入。

## Open Questions

* 无。

## Requirements (evolving)

* 为生成事件提供可重放、可测试的服务端时间信息，刷新页面后耗时显示仍一致。
* 在生成时间线显示任务总耗时、每个阶段耗时、已完成工具耗时和运行中累计耗时。
* 将非 Agent 的地理解析、通勤估算、自动修复等后处理显示为可识别的任务，而不是混入笼统的“思考过程”。
* 任务终态输出结构化耗时汇总日志，能按 job、阶段和任务定位慢点。
* 兼容旧事件或缺失时间字段，前端不得因此崩溃。
* 优化不得绕过高德/Web 搜索的串行队列、任务额度和熔断器。
* 采用“耗时观测 + 无损优化”：保留全部调研、编排、审校和确定性质量检查，不通过减少模型阶段换取速度。
* 耗时仅在当前生成任务中展示；沿用现有内存事件重放与 30 分钟终态保留，不写入 Trip 或新增性能历史表。

## Acceptance Criteria (evolving)

* [x] 生成过程中，用户能看到当前总耗时和当前阶段累计耗时。
* [x] 阶段/工具结束后显示稳定的耗时，刷新并重放 SSE 后结果不变化。
* [x] 坐标解析、通勤估算等后处理有独立耗时项。
* [x] done/error/cancelled 均产生不含敏感数据的结构化耗时日志。
* [x] 共享事件协议、服务端事件产生和前端时间线重建均有针对性测试。
* [x] 现有生成行为、取消、SSE 重放、额度和外部 API 限流语义保持不变。
* [x] 互不依赖的模型构建与外部数据源初始化并行执行，任一路径报错仍沿用现有失败/降级语义。
* [x] 地理编码最多两路流水化执行，允许高德与 Nominatim 两条独立限流链重叠等待；各提供方既有串行队列、最小间隔、额度与结果顺序保持不变。
* [x] 审校后的全量通勤重算保持不变，确保增删、换序或坐标变化后不持久化失效路线。
* [x] lint、typecheck 和相关测试通过。

## Definition of Done

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Research Notes

### Feasible approaches

**Approach A: 仅增加耗时观测**

* 优点：风险最低，可先获得真实瓶颈数据。
* 缺点：本次不直接缩短耗时。

**Approach B: 耗时观测 + 无损优化（推荐）**

* 增加端到端计时，同时合并重复的本地工作、并行互不依赖的初始化，并避免可证明无收益的重复等待。
* 保留所有 LLM 阶段、外部 API 限流、额度与质量门槛。
* 优点：能立即改善部分延迟，并为后续优化建立基线；行为风险可控。
* 缺点：若主要瓶颈是模型推理，首版降幅可能有限。

**Approach C: 耗时观测 + 激进优化**

* 在 B 基础上按条件跳过审校或收紧 Agent 最大轮次。
* 优点：潜在降幅最大。
* 缺点：可能降低复杂行程质量，需要线上基线、灰度和质量指标支撑。

## Out of Scope (initial)

* 接入 OpenTelemetry、Prometheus 或第三方 APM。
* 改变模型供应商或模型选择。
* 绕过第三方 API 限流、日额度或任务额度。
* 在缺少基线数据时直接删除调研/审校阶段。

## Decision (ADR-lite)

**Context**: 当前没有阶段级基线，直接减少模型轮次会把速度改善与质量回退绑定在一起，难以验证。

**Decision**: 采用耗时观测 + 无损优化。先让任务总耗时、阶段、工具和确定性后处理可测可见，再优化互不依赖的初始化、重复本地工作和可证明无收益的等待；保留 LLM 阶段、质量门槛、限流、额度与熔断语义。

**Consequences**: 首版风险可控且能建立后续性能基线；如果主要瓶颈来自模型推理，首版耗时降幅可能有限，后续需依据真实数据再评估条件化审校或模型策略。

## Technical Notes

* 主要入口：`apps/server/src/generation/orchestrator.ts`
* Agent 事件桥接：`apps/server/src/generation/agents/runner.ts`
* SSE 缓冲与重放：`apps/server/src/generation/jobManager.ts`
* 共享协议：`packages/shared/src/types.ts`
* 前端时间线：`apps/web/src/components/GenerationTimeline.tsx`
* 地理后处理：`apps/server/src/generation/geoPipeline.ts`
* 外部调用限流：`apps/server/src/lib/serialQueue.ts`
* 验证：`npm run typecheck`、Web production build、148 个 server tests、`verify-c2.mjs` 全部通过。
* 内置浏览器插件在本次环境不可用；改用仓库 Playwright 依赖执行 timing smoke，Vite 开发页 `http://127.0.0.1:5173` 返回 200。
* Playwright timing smoke：外部 Key/地理调用开启时总耗时 50.2s，其中 `plan` 48.5s、`geo_geocode_all` 46.1s（约占总耗时 91.8%）；调研 1.24s、审校 0.41s。
* Playwright 隔离基线（mock 提供已解析坐标、无住宿外呼）：总耗时 2.16s，`research` 0.93s、`plan` 0.82s、`review` 0.41s；390px 移动视口无横向溢出。
* 现有 `verify-c3.mjs` 仍包含已移除的旧预算按钮断言，且其生成流程依赖外部地理兜底；本任务不修改该既有脚本，后续应注入地理服务 mock 并同步预算表单断言。

## Technical Approach

* 在共享 `GenerationEvent` 的生命周期事件中加入服务端产生的毫秒时间戳；阶段和工具结束事件携带确定的 `durationMs`，避免前端刷新后重新估算出不同结果。
* 将坐标解析、通勤计算、自动修复、跨天优化等确定性后处理统一包装为可计时的任务事件，复用现有 SSE 环形缓冲和重放机制。
* `GenerationTimeline` 从事件重建阶段/工具起止时间；运行中通过轻量定时刷新显示累计耗时，终态使用服务端固定耗时。
* 任务终态输出单行结构化日志，包含 jobId、status、totalMs、各阶段/后处理耗时与调用计数，不记录目的地、prompt、工具参数或凭据。
* 并行执行互不依赖的 `buildModel` 与搜索源解析，缩短 BYOK/个人搜索配置都需安全校验时的初始化等待。
* 地理编码使用最多两个工作槽提交解析任务；高德与 Nominatim 仍分别经过原有串行队列，解析结果按活动原顺序暂存、校验和采纳。
* 按生成规范保留审校后的全量通勤重算；性能优化不得以复用可能失效的 legs 为代价。
* 对缺失新时间字段的旧事件保持兼容：仍展示原时间线，仅不显示对应耗时。

## Expansion Decisions

* 为未来 APM/历史面板保留稳定的阶段/任务名称和毫秒字段，但首版不引入第三方观测系统或数据库迁移。
* done/error/cancelled 使用同一计时收口，避免只统计成功任务而看不到超时与取消瓶颈。
* 外部 API 请求仍由现有串行队列控制；本任务不调整 QPS、超时、额度或熔断阈值。
