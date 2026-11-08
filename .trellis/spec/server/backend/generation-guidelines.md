# Generation Jobs and SSE Guidelines

## Boundary and Lifecycle

### Title handwriting coverage contract

1. **Scope**: newly written itinerary/day titles in the writer's `update_titles` tool; do not rewrite real place names, activities, imports or stored trips to satisfy a font.
2. **Signatures**: shared `missingTitleCharacters(titles: readonly string[]): string[]`; `python scripts/generate-title-font-coverage.py [--check]` regenerates/verifies the server `titleFont.generated.ts` hash manifest and shared `handwriting.generated.ts` from deployed `apps/web/public/fonts/handwriting/*.woff2` Unicode cmap tables (exclude glyph ID 0). Server and web consume the same coverage through `@tripweaver/shared`; the server's `titleFont.ts` is a compatibility re-export. The generator requires `fonttools[woff]`; production uses only generated TypeScript data.
3. **Contract**: check all submitted titles by Unicode code point before any draft mutation. Return distinct missing characters in `details.missingCharacters`, `details.isError=true`, and readable tool feedback. Writer should rephrase faithfully, with at most two correction attempts requested by the prompt. Retain existing default-title fallback if writing fails; this is not a guarantee that historical/default titles use only covered characters.
4. **Validation/errors**: any missing character → reject the entire title batch without mutation; complete coverage → existing `draft.updateTitles` validation/write behavior; changed font files → coverage-source hash test fails until regeneration. Never substitute `document.fonts.check()` or CSS unicode-range declarations for parsing actual font cmap data.
5. **Cases**: selected Youran Handwriting (演示悠然小楷) includes “苑麓雍颐榭锣祈簋”, so “中轴宫苑漫步” and “南麓泉塔听溪谷” pass. “古罍听风” still fails because “罍” is absent. Do not fabricate a new place name to satisfy a font. Historical/default/manual titles retain their text; frontend whole-text fallback handles unsupported letters without rewriting them.
6. **Tests**: `titleFont.test.ts` checks file set/SHA-256, Unicode/deduplication, trip or day missing glyph rejection, no partial writes and unchanged activities after corrected submission. Run the generator with `--check` after editing it or font assets.
7. **Wrong vs correct**: merely telling the model to use common characters is insufficient; parse actual shipped fonts, validate tool arguments, and return actionable missing-character feedback before writing.

`apps/server/src/routes/generations.ts` owns HTTP admission, quota/conflict responses, job
snapshots, SSE transport, and cancellation requests. `apps/server/src/generation/orchestrator.ts`
is the single generation entry point and owns the research, planning, review, persistence,
usage recording, and terminal outcome sequence.

The route starts `runGeneration` without awaiting it and immediately returns 202 with a job
ID. Always attach a rejection handler that logs an otherwise unhandled detached failure.
The orchestrator must catch normal workflow failures and converge the job to exactly one of
`done`, `error`, or `cancelled`.

All asynchronous initialization belongs inside that catch boundary. Start with null adapters and
zero usage counters so even setup failure can terminate and audit safely. Failure/cancellation
publishes the terminal state before attempting its best-effort audit; success publishes only after
the trip and success audit commit together. Terminal helpers are idempotent, and late nonterminal
events from parallel enhancement work are discarded.

Representative paths: `apps/server/src/routes/generations.ts`,
`apps/server/src/generation/orchestrator.ts`, `apps/server/src/generation/liveRun.ts`.

## Scenario: Research Tool Submission Completion (2026-10-04)

### 1. Scope / Trigger

Research agent completion and the shared phase runner. Real eval observed a model outputting
12 candidates in a JSON code fence with stopReason=stop, without invoking submit_research;
the empty pool previously reached scheduling and produced only free-time/meal placeholders.

### 2. Signatures

- `RunAgentOptions.completion?: { isComplete(): boolean; reminder: string; errorMessage: string }`
- `runResearchPhase` requires a nonempty pool and the summary set by successful submit_research.
- `summarizeUpstreamError(message)` retains HTTP status while removing gateway HTML bodies.

### 3. Contracts

- After normal agent idle without successful submission, issue at most one corrective prompt
  on the same Agent. Preserve catalog, tool results, inserted candidates and cumulative usage.
- Never parse assistant prose/code fences as a tool submission. Existing tool schema and
  catalog/city/ID validation remain authoritative.
- Upstream errors, cancellation and exhausted total turn budget do not trigger correction.
  If correction still fails the completion predicate, return an explicit phase error.
- Orchestrator observes that error before scheduling/persistence. Optional retrieval failure
  still permits external/model-knowledge candidate fallback through the existing tools.
- Phases without a completion requirement retain their current behavior. HTTP retry policy
  and single-job timeout remain unchanged; HTML errors become concise status diagnostics.

### 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| First response submits successfully | no correction request |
| Plain text or JSON instead of successful submission | one reminder with existing context |
| Still no successful submission | phase error; no placeholder-only saved trip |
| Cancelled / model error / total turns exhausted | preserve reason; no extra request |
| HTTP 504 HTML page | status and gateway summary; no HTML body in retry/final error |

### 5. Good / Base / Bad Cases

Good: model corrects a prose response by invoking the validated submission tool.
Base: valid one-call submission stays one call.
Bad: any stopReason=stop is treated as successful research, or code parses prose into the pool.

### 6. Tests Required

`agentCompletion.test.ts`: actual local HTTP model protocol, text→tool correction, repeated
text rejection, retained context/usage, normal tools, ordinary text phases, errors, abort and
turn limits. `llmRetry.test.ts`: existing retry semantics and sanitized HTML status.
`eval:verify -- --research-response text-first|text-only`: real research phase and isolated DB,
recovery or explicit error before planning, event diagnostics and cleanup.

### 7. Wrong vs Correct

Wrong: `await agent.prompt(...); return research;` regardless of successful submission.

Correct: validate the successful tool-controlled completion predicate, offer one bounded
correction, then return a clear error when it remains false.

## Task Model

生成由用户级 SQLite 上的 durable task 执行；`generations` 表是任务视图（开始写 `running`，
结束原地更新摘要/告警/用量），进程内的 Job 只承载实时投影与订阅。每个用户同一时刻只允许一个
运行中任务，终态任务在内存保留 30 分钟用于实时订阅；持久行长期保留，重启后仍可读。

单进程假设仍然存在（SQLite 与 Harness 独占），但不再依赖内存事件缓冲：

- 重启后由 durable task resume 重建实时 Job；已结束任务由持久行恢复；
- another replica cannot read, cancel, or stream a job created elsewhere;
- per-user running-job exclusion is not cluster-wide;
- the event ring is recovery convenience, not durable event storage.

Do not deploy multiple active replicas without replacing these maps with shared durable job,
lock, and pub/sub infrastructure or accepting broken semantics.

## Ownership and Cancellation

Every snapshot, SSE subscription, and cancellation lookup passes both `jobId` and the
authenticated `userId` to `getJob`; missing and non-owned jobs return the same 404.

Cancellation calls the job's `AbortController`. The orchestrator observes the signal,
publishes `job_cancelled`, records a `cancelled` generation row, and does not consume the
successful-generation quota. Publish the authoritative in-memory terminal state before a
later audit write can fail.

The `job_cancelled` event carries `reason: 'user' | 'timeout'` so the client can tell a
manual cancel from the whole-job timeout. The cancel route calls `cancelLiveRun()` (which
sets `run.cancelReason = 'user'`), while the orchestrator's timeout timer sets it to
`'timeout'`. The field is optional in the shared type so legacy buffered events replay
cleanly, and missing `reason` renders as a user cancel on the client. Task truth lives in the
`generations` row, so a cancel after restart goes through `harness.abortTask(durableTaskId)`.

Representative paths: `apps/server/src/routes/generations.ts`,
`apps/server/src/generation/liveRun.ts`, `apps/server/src/generation/taskStore.ts`,
`apps/server/src/services/quotaService.ts`.

## SSE Contract

The generation stream now carries **projection frames**, not raw events:

- Use `text/event-stream`, disable transformation/buffering, and keep the connection alive.
- First frame is a `snapshot` when the client omits `fromSeq` (or its watermark is ahead/behind
  the window); otherwise replay the `delta` frames after the watermark, then subscribe live.
- Each frame carries a monotonically increasing `seq`; clients persist it and resubscribe with
  `fromSeq` after a gap or reconnect.
- Send heartbeat comments every 25 seconds.
- End the stream when the live run is terminal. When the live layer has expired, synthesize a
  terminal snapshot from the persisted task row instead of returning 404.
- On connection close or write failure, unsubscribe and clear the heartbeat without affecting
  generation.
- `subscribe` replays synchronously. Initialize the unsubscribe variable before subscribing, then
  dispose the returned subscription if replay already closed the response. Terminal replay must
  never register a live listener, and a terminal cursor with no remaining events still ends the stream.

## Scenario: Terminal State and Atomic Persistence (09-29)

### 1. Scope / Trigger

Changes to initialization, cancellation, `createTrip`, audit writes, or SSE terminal cleanup.

### 2. Signatures

- `runGeneration(run: LiveRun, form, cfg, logger?, options): Promise<GenerationRunSummary>`
- `createTrip(userId, source, revisionOf?, writer = db)`; writer exposes `select` and `insert`.
- `emitLive(run, event)`: one terminal transition per run; `finalizeGenerationTask(ref, status, …)`
  writes the same terminal state to the `generations` row.
- `subscribeLiveProjection(run, fromSeq, listener)`: synchronous snapshot/delta resume, then live frames.

### 3. Contracts

- Check AbortSignal on entry and after asynchronous initialization. Agent runner also checks entry.
- Persist trip and `generations(status='done', tripId)` in the same `db.transaction` writer.
- Cancellation observed inside the transaction throws and rolls back both writes. COMMIT is the
  success boundary: an abort after commit must not turn the saved result into a cancelled job.
- For failure/cancellation, finalize the task row before the audit write. Audit failure logs safe
  job/status metadata and cannot leave a running row (the DB partial unique index is the gate) or
  a detached rejection.
- Unexpected internal failures return a generic user message; never expose raw SQL or credentials.

### 4. Validation & Error Matrix

| Condition | Outcome |
| --- | --- |
| Initialization and error audit both fail | one `job_error`, released lock, safe error log |
| Abort during initialization | one `job_cancelled`, released lock |
| Success audit SQL fails | transaction rollback, no trip or success quota |
| Abort while persistence waits | after the operation settles, rollback and cancellation |
| COMMIT completed before abort observed | one `job_done`, saved trip and matching audit |
| Terminal SSE replay / terminal cursor | response ends, no listener or heartbeat retained |

### 5. Good/Base/Bad Cases

- Good: a SQL trigger rejects success auditing and no trip survives.
- Base: normal generation saves a trip and one successful audit, including revision lineage.
- Bad: global `db` escapes the transaction, audit failure precedes lock release, or post-commit
  cancellation claims that an already saved trip was cancelled.

### 6. Tests Required

`apps/server/src/__tests__/generationTask.test.ts` verifies idempotent terminal transitions and
late-event suppression in the live layer.
`scripts/verify-generation-flow.mts` injects setup/audit failures, locks PostgreSQL during saving,
checks rollback and lineage, and reads actual HTTP SSE streams to EOF. Use a disposable database.

### 7. Wrong vs Correct

Wrong: `await createTrip(...); await record('done', id); emitLive(job_done)`.
Correct: pass the same `tx` to `createTrip`, success auditing, and `finalizeGenerationTask` inside
`db.transaction`, then call `emitLive(job_done)` after commit. For failure, emit the terminal
event first and catch the task-row/audit writes separately.

Event payloads are shared contracts in `packages/shared/src/types.ts`. Preserve compatibility
fields until coordinated shared/web removal. Current `xhsEnabled`, `xhsCalls`, and `usedXhs`
are historical fields with documented compatibility meanings.

Task parameters the client must echo back live on `job_start` (`destination`, and `days` since
09-27), not on a separate event: the refresh/recovery path (`/trips/new?city=…` + replayed SSE)
has no dates in the URL, so the generation title can only learn the real day count from the
event stream. Keep new title-relevant parameters optional and let the web fall back to its
URL-derived draft, so replayed legacy events still render.

For the web side of this contract see `.trellis/spec/web/frontend/component-guidelines.md`
(generation panel) — the title prefers `TimelineModel.destination` / `TimelineModel.days` and
treats the props as fallback only.

Eval harness collection semantics (eval snapshot v2): `usage` events are cumulative — the
last one carries final totals. `phase_end.durationMs` must be keyed `<phase>#<round>` (plan
and review can span multiple rounds). `candidate` events carry `ResearchPoi` without
coordinates (Amap protocol 3.5), and persisted trips strip `placeName`/`poiId` — pool
adoption metrics therefore match by name, extracting meal lookup names
(`午餐｜春熙路 · 川菜` -> `春熙路`, the same rule geoPipeline uses). New metric dimensions
enter reports as observational fields first and only join the gate after proving stable.

Representative paths: `apps/server/src/routes/generations.ts`,
`apps/server/src/generation/liveRun.ts`, `packages/shared/src/types.ts`.

## Scenario: Replay-Stable Generation Timing

### 1. Scope / Trigger

Apply this contract when adding generation performance diagnostics, changing SSE lifecycle
events, or rendering elapsed time in the generation timeline. Timing is task-local operational
data: it is visible during the in-memory job lifetime and in server logs, but is not persisted
into `Trip` or a performance-history table.

### 2. Signatures

- Every `GenerationEvent` may carry `at?: number` (Unix milliseconds).
- `phase_end`, `tool_end`, and terminal events may carry `durationMs?: number`.
- `GenerationPerformance(run.createdAt)` records phase keys (`research:1`, `plan:1`, etc.)
  and aggregates tool/task keys by count, total, and maximum duration.
- `runGeneration(run, form, cfg, logger?)` accepts the Fastify/Pino logger from the route.

### 3. Contracts

- `liveRun.emitLive` fills a missing `at` on every emitted event. Producers may supply an
  earlier authoritative time, such as `job_start.at = run.createdAt`.
- The server computes completed durations once. The web client uses those fixed values after
  completion and uses its local clock only to animate an item that is still running.
- Deterministic post-passes reuse `tool_start` / `tool_end` with stable non-sensitive tool keys;
  do not add a second progress event family.
- Terminal logs contain only `jobId`, status, total/phase/task milliseconds, token counts, and
  provider call-attempt counts. Never log destination, form data, prompts, tool args, provider
  responses, credentials, or settings objects.
- Timing fields stay optional so old buffered/manual recovery events remain readable.

### 4. Validation & Error Matrix

- Old event has no `at` / `durationMs` -> render the existing timeline without that duration.
- End event has no explicit duration but both endpoint timestamps exist -> derive a non-negative
  duration from the timestamps.
- Task ends as `error` or `cancelled` with active work -> terminal log includes active phase/task
  elapsed time; the SSE terminal event still carries fixed total duration.
- Optional deterministic pass throws -> emit an errored timed tool item, then preserve the
  pass's existing degrade-or-cancel behavior.
- Browser refresh -> replayed completed durations must be identical to the pre-refresh values.

### 5. Good / Base / Bad Cases

- Good: a running route pass increments once per second, then freezes at the server-provided
  duration; the terminal log identifies it as the slowest task without exposing inputs.
- Base: a legacy event stream has no timing fields and looks exactly as it did before timing was
  added.
- Bad: the web client stamps receipt time and recomputes completed durations after replay, or the
  server logs the full form/tool arguments to explain a slow task.

### 6. Tests Required

- Unit-test phase/task aggregation with an injected deterministic clock, including active work.
- Unit-test `liveRun.emitLive` timestamp filling and terminal duration for a non-success outcome.
- Unit-test timeline reconstruction for explicit timing and legacy missing fields.
- Run `npm run typecheck`, all server tests, `npm run build -w apps/web`, and
  `node scripts/verify-c2.mjs` to cover the shared union, SSE replay, cancellation, and full flow.

### 7. Wrong vs Correct

```typescript
// Wrong: receipt time changes after reconnect and leaks arguments into diagnostics.
const startedAt = Date.now();
console.info({ form, args, durationMs: Date.now() - startedAt });

// Correct: server lifecycle events are authoritative and logs use stable classifications only.
emit(job, { type: 'tool_end', toolCallId, tool, durationMs, at, /* existing safe fields */ });
logger.info({ jobId: job.id, status, phases, tasks, usage }, 'generation timing summary');
```

## Deterministic Post-Pass (Mechanical Work Out of the LLM Loop)

Bulk mechanical work with deterministic rules — batch geocoding, transit-leg computation —
must NOT be delegated to agent tool loops (burns turns, unreliable on weak models). Run it as
a code-level pass in the orchestrator.

**Timing**: after deterministic scheduling, geoPipeline and the title writer run concurrently.
Geo results feed feasibility and the long-haul repair pass. Final geo/legs refresh and cross-day
optimization run before persistence. `geocodeAll` skips already-`geocoded` activities, and
`computeLegs` reuses a session-level `legMemo` (endpoint IDs + rounded coordinates) so unchanged
pairs do not spend the route cap twice. Task-wide geocode/route caps apply across all passes.

- Progress goes through the existing `thought` sink events (e.g. `正在解析坐标与通勤 (12/18)`);
  do not invent new SSE event types for internal passes.
- Degradation inside the pass must never fail the job; skip items truthfully instead of
  fabricating data.
- The pass skips coordinates already resolved from research or the knowledge base
  (`coordSource==='geocoded'`); the title writer does not receive geo tools.

Representative paths: `apps/server/src/generation/geoPipeline.ts`,
`apps/server/src/generation/orchestrator.ts`.

### Feasibility Engine

Itinerary feasibility is computed by pure code, not judged by the LLM. `simulateDay` /
`simulateTrip` in `packages/shared/src/feasibility.ts` are IO-free pure functions (no server,
DOM, or network imports) so the same engine serves server generation, future eval harnesses,
and the web client. They take a `Trip`/`TripDay` and return
`FeasibilityReport { dayReports, violations }` where each `Violation` has
`code`, `severity: 'hard'|'soft'`, `dayIndex`, optional `activityId`, `message`, and optional
`detail`.

Violation codes and severities (thresholds live in the named `FEASIBILITY_THRESHOLDS`
constant, tuned to commonsense defaults, adjustable in one place):

- `transit_infeasible` (hard): a leg's duration exceeds the time gap between two timed
  adjacent activities — physically cannot fit.
- `overpacked` (hard): day total (activity occupancy + transit) > 14h. Also (soft): > 8
  activities, > 15km cumulative walking, or < 10% time-window buffer.
- `backtrack` (soft): three adjacent coordinates turn back > 90° AND the back-jump > 2km.
- `anchor_missing` (soft): lodging is named but its coordinates are unresolved. Suppressed
  until resolution has been attempted (`simulateTrip` infers this from any `geocoded` activity
  or any day having legs) so the pre-geoPipeline planner gate does not emit un-actionable noise.
- `closed_on_arrival` (hard, enabled 09-22-opentime): the activity carries Amap `openTime`
  text (auto-attached by `add_candidate`, never transcribed by the model) and the text declares
  closure on the day's weekday (`isClosedOnDate` in `packages/shared/src/openHours.ts`).
  `DaySimContext.date` is the only input; `simulateTrip` derives it from `trip.startDate +
  dayIndex`. No `openTime` or no `startDate` -> the check is skipped entirely (never block on
  missing data; never fabricate open hours). The scheduling pass avoids closed days at
  segment->day assignment time (whole-segment move, preserving chain contiguity); this
  violation is the backstop when avoidance is impossible.

Degradation is truthful (never fail the job, never fabricate): an activity missing coordinates
skips that segment's transit/backtrack checks; a missing leg is estimated with `estimateTransit`
(the shared speed model, also backing `legEstimator`) and the violation `detail` is labeled
low-confidence.

The live pipeline computes feasibility after geo resolution, uses it to accept or roll back
deterministic repairs, then recomputes `draft.feasibility()` immediately before persistence.
`feasibilityReviewNotes` reports remaining hard and soft issues truthfully. These quality notes
do not replace `draft.validate()`'s structural gate (missing days or too many activities are fatal).
Legacy revision tools may still expose `check_feasibility` / `submit_plan`; the live generation
path has no LLM planner or structural reviewer loop.

**Common mistake: persisting an earlier feasibility snapshot.** Repair/grouping passes mutate
activities, so notes must use the final draft; otherwise they can describe already-fixed violations
or miss newly introduced ones. The writer only changes titles and cannot repair structure.

Representative paths: `packages/shared/src/feasibility.ts`,
`apps/server/src/generation/tools/draftTools.ts`, `apps/server/src/generation/prompts.ts`,
`apps/server/src/generation/orchestrator.ts`, `apps/server/src/__tests__/feasibility.test.ts`.

### Long-Haul Day Discipline (M0-B: prevent + deterministically repair)

Far-suburb anchors (八达岭式) mixed with downtown activities on one day were the last hard
blocker in the golden set. Two code layers bracket the LLM (planner prompts alone were
insufficient — the planner assigns `dayIndex` before any coordinates exist):

1. **Pre-planning intel (prevention)** — during research, `search_pois` coordinates are
   captured into task-memory (`ResearchOutcome.locations`; NOT persisted, NOT on
   `ResearchPoi` schema — Amap ToS + schema minimalism). Before the planner phase,
   `classifyLongHaulPois` (`apps/server/src/generation/longHaul.ts`) computes each candidate's
   `estimateTransit` duration to the candidate pool's median center and tiers it against
   `LONG_HAUL_THRESHOLDS` (shared constants: ≥60min long-haul, ≥90min exclusive-day).
   Tiered intel is consumed by CODE, not by a prompt: `classifyLongHaulPois` feeds
   `applyDeterministicSchedule`'s `longHaul` input and the scheduling layer enforces the
   exclusive-day discipline structurally. (The old `plannerUserPrompt` injection died with the
   LLM planner in 09-21; the prompt builders were deleted in 09-25.)
2. **Deterministic fixer (repair)** — `longHaulFixer.ts` runs after geoPipeline+feasibility,
   concurrently with the title writer. Trigger: hard
   `transit_infeasible`/`overpacked` on a day that has an exclusive-tier long-haul activity
   (re-identified from REAL resolved coordinates, not the name-keyed research intel) plus
   mixed-in urban activities (>45min from the long-haul point AND closer to the trip median
   center). Action: move urban activities out (`draft.moveActivityToDay`, also used by the
   revision-only `move_activity` tool) to the lightest-load day with a derivable time slot.
   Accept per-move only if no new hard violations and no newly-dirtied day; accept the day's
   batch only if total hards STRICTLY decreased, else roll the whole day back
   (three-level `structuredClone` snapshots). Bounded: ≤3 moves/day, ≤8 attempts/task;
   multi-far-suburb days are handled per-day by the same rule, never specially. Fixer
   exceptions degrade to "not fixed" and the pipeline continues (cancellation still propagates).
- Recomputation after each move uses
  `computeLegs(draft, onProgress, signal, onlyDayIndexes)` — the targeted-day variant;
  omitting `onlyDayIndexes` preserves the full recompute.

Representative paths: `apps/server/src/generation/longHaul.ts`,
`apps/server/src/generation/longHaulFixer.ts`, `apps/server/src/generation/draft.ts`,
`apps/server/src/generation/prompts.ts`, `packages/shared/src/constants.ts`.

### Common Mistake: auto-fix notes surviving rounds they did not survive

**Symptom**: persisted `reviewNotes` said "系统自动调整：X 自第 3 天移至第 1 天" while the
final trip had X back on day 3.

**Cause**: round-1 fixer moves were recorded as prose and accumulated across rounds; the
round-2 revision planner rebuilt the day and reversed the move, but the stale note was still
folded into the final trip (found as High in the 07-18 closing check — the trip lied to the
user, breaking the truthful contract the same way the pre-review feasibility snapshot did).

**Fix / Prevention**: fixer returns structured `applied: AppliedFixMove[]`
(`activityId`/`toDayIndex`/`note`), and `verifiedFixNotes(draft, applied)` re-validates each
move against the FINAL draft right before persistence — a note is kept only if the activity
is actually on its claimed day. Reversed/deleted/rebuilt-with-new-id moves are dropped:
under-report before you ever mis-report. Any future "the system did X for you" note must
follow the same persist-time re-verification pattern.

Representative paths: `apps/server/src/generation/longHaulFixer.ts`,
`apps/server/src/generation/orchestrator.ts`,
`apps/server/src/__tests__/longHaulFixer.test.ts`.

### TransitLeg Lodging Sentinel Contract (ST3)

`TransitLeg.fromActivityId` / `toActivityId` allow the sentinel value `'lodging'` — the day's
lodging anchor. A leg lives on its `TripDay`, so the sentinel scope is naturally that day:
`{from:'lodging', to:<first activity id>}` is "depart from lodging",
`{from:<last activity id>, to:'lodging'}` is "return to lodging". The schema stays a plain
string; the contract is documented on `TransitLegSchema` and matched strictly by
`lodgingLegsForDay(day)` in `@tripweaver/shared` (stale legs after reorder/delete are silently
dropped by consumers). Lodging legs are generated by the post-pass only when the lodging
geocode succeeded; a failed geocode means no lodging legs and no job failure. Editing the
lodging name invalidates its coordinates: clear them and drop the affected days' lodging legs
(there is no client re-geocode endpoint yet).

Representative paths: `packages/shared/src/schemas.ts`, `packages/shared/src/legs.ts`,
`apps/server/src/generation/geoPipeline.ts`, `apps/web/src/store/editorStore.ts`.

## Scenario: Itinerary Time Ownership (2026-11-08)

### 1. Scope / Trigger

Any code that changes a day's activity order, dwell time, or persisted start/end times —
generation, detail-chat write tools, health repair, or a future editor surface.

### 2. Signatures

- `scheduleDay(day, { pace, startAt?, preserveDurations? })` and `scheduleDays(days, pace, …)`
  in `apps/server/src/itinerary/schedule.ts`.
- Detail write tools expose `afterActivityId` (stable insertion anchor) and `durationMin`
  (dwell), never raw `startTime`/`endTime` or zero-based `position`.

### 3. Contracts

- `scheduleDay` is the only writer of `Activity.startTime`/`endTime`. Order is structure;
  time is derived from the ordered list, `legs` (or walking fallback), dwell, and meal windows.
- A structural mutation clears the day's stale legs and immediately re-runs `scheduleDay`, so
  `get_trip`/`get_day` never expose a time line that goes backwards. Commit recomputes real
  legs (`repairChangedRoutes`) and runs `scheduleDays` once more before persisting.
- `preserveDurations` keeps each activity's existing dwell when `durationMin` is absent; it does
  not preserve gaps. Explicit free time must be an activity, not an untimed hole.
- Generation and detail editing share this module; do not fork a second timing implementation.
- A task card belongs to the message that delegated the task. Completion messages carry the
  trip result only and must not re-attach `task` or repeat the task summary.

### 4. Tests Required

`agentTripDraft.test.ts` (insertion anchor, invalid anchor, monotonic timeline, duration,
regression: tea after museum), `dayPlanner.test.ts` (real-leg retiming, meal windows), and
`completionMessage.test.ts` (one completion message, no task attachment).

## Scenario: Sub-Agent Timeline and Pages (2026-11-08)

### 1. Scope / Trigger

Generation live UI, durable phase agents, and any sub-agent transcript read surface.

### 2. Contracts

- Each durable phase agent (research / plan / writer / advice) records its
  `conversation.id` into `generations.agent_conversations` (JSONB) when created. The column is
  the durable mapping; do not rely on terminal task state (pi-durable drops `checkpoint` when a
  task is terminal) and do not add a third task table.
- The main timeline / chat shows one `旅行规划助手` node only. Expanding it renders the phase
  timeline (`research` / `plan` / `review`, status only); each phase links to
  `/agent/:jobId/agents/:stage`. `review` aggregates `writer` + `advice`. Do not expose steps,
  duration, or result summaries on the collapsed node.
- `GET /api/generations/:jobId/agents/:stage` is read-only and lazy. It normalizes durable
  conversation entries to tool steps (label/status/duration) only: never expose user/system
  prompts, thinking/reasoning, tool arguments, or raw assistant prose.
- Completion while inspecting a sub-agent page keeps that page; returning to the main timeline
  shows a `查看行程` action instead of forcing navigation. Ordinary completion on the main page
  still hands off to `/trips/:id`.

### 3. Tests Required

`agentTranscript.test.ts` (ordering, error state, no args/prose leakage), `projectionAdapter.test.ts`
(phase summary/startedAt), `liveAgentStream.test.ts` (phase grouping), and browser coverage of
main row → child URL → back, plus refresh with the live layer absent.

## Scenario: Deterministic Plan Phase and Copy-Only Writer (09-21, phase 2)

### 1. Scope / Trigger

Apply when changing `generation/scheduling/*`, the plan-phase orchestration in `orchestrator.ts`,
`WRITER_SYSTEM_PROMPT` / `writerUserPrompt`, or the writer-phase description tools. This REPLACES the
LLM planner/reviewer loop for the live pipeline.

### 2. Signatures

- `visitWeight(facts): number` in `scheduling/visitWeight.ts` — relative weight, pure, no IO
- `loadPlaceFacts(names, city): Promise<Map<string, PlaceFacts>>` in `scheduling/placeFacts.ts`
- `buildSchedule(candidates, options): { days, droppedCount, closureConflicts, dateRepair }` in `scheduling/schedule.ts` — pure
- `applyDeterministicSchedule(input): { schedule, written, withoutCoord }` in
  `scheduling/buildDraft.ts`
- `draft.setSkeleton(...)` / `draft.addActivity(...)` / `draft.setLodging(...)` /
  `draft.updateTitles(...)` — the only writers
- `WRITER_SYSTEM_PROMPT`, `writerUserPrompt(form, draftRender)` in `generation/prompts.ts`
- `update_titles(title, dayTitles[])` in `tools/draftTools.ts` — the writer-phase write path,
  backed by `draft.updateTitles`, which rewrites ONLY `title` and `days[].title`. It must NOT be
  `set_trip_skeleton`: that rebuilds `days` and discards every scheduled activity.
  `update_description(dayIndex, position, description)` remains for
  `buildDraftTools(draft, 'revision')` and other single-row callers

### 3. Contracts

- **The plan phase makes zero LLM calls and produces no time axis.** Selection, day assignment,
  and intra-day order use knowledge-base facts and spatial heuristics. Do not reintroduce an agent
  loop there; the measured cost of letting an LLM do it was 47228 output tokens / 432s, and the
  round-2 revision blew the 15-minute job timeout.
- Scheduling IS a hard dependency (unlike RAG enrichment): missing days or empty days after
  scheduling throw `GenerationFailure`. Content problems (meal coverage, cross-day repeats) are
  repaired deterministically and otherwise downgraded to notes — they must not sink a whole trip.
- Meal ordering (11-07): for `美食` preferences, run `ensureMealCoverage` after geocoding and
  before `enrichMealAnchors`; the planner never picks restaurants (`plan_day` labels stops `文化`),
  so skipping this step rejects every food-focused trip. Validate only after meal repair and
  enrichment, never right after `submit_plan`.
- `scheduleDays` snaps meals into their windows (lunch ≥ 11:30, dinner ≥ 17:30); otherwise a
  day that runs late would schedule dinner at 16:00.
- Date assignment first matches whole groups, minimizing closed activities (at most `2^15`
  matching states). Remaining closures use `repairScheduleDates`: move or swap up to two
  same-day ordering bundles, retaining every selected attraction. Candidates must respect
  weight/count limits, exclusive days, same-day predecessor bundles and cross-day order.
  Search accepts only fewer closures, ranks by geometric distance then changed-day count,
  and has stable ties, 30,000 attempts / 256 expanded states / 16 frontier entries. It is a
  bounded heuristic, not proof that every feasible itinerary will be found. Route distance
  may grow by at most max(2 km, 10%); no road-network duration guarantee is implied.
- `dateRepair.reason` distinguishes `no_open_day`, `search_exhausted` and `search_limit`.
  `closureConflicts` names the still-closed attractions and dates; never count them as dropped
  or replace their day with a placeholder. `applyDeterministicSchedule` throws
  `ScheduleDateConflictError(code='SCHEDULE_DATE_CONFLICT')` BEFORE mutating the draft.
  Orchestrator uses the existing `job_error` message path, records an error audit and saves
  neither a trip nor success quota. After geo/cross-day processing, `scheduleClosureConflicts`
  checks all final attractions/meals once more before persistence (`post_processing` reason).
- Coordinates are OPTIONAL per candidate. Candidates without coordinates follow located candidates
  in score order before capacity-based chain cutting; `geoPipeline`
  resolves their coordinates afterwards (this matches the pre-existing rule that coordinates are
  never required from the planner). Never drop a candidate merely for lacking coordinates at
  scheduling time.
- `visitWeight` uses the place-type table, then the 8-category table, then weight 2. It expresses
  relative capacity, not a predicted visit duration. `relaxed/moderate/tight` set daily count and
  weight limits. Food-focused days reserve two of the 8 total activity slots before cutting.
- Located-chain start selection and segment reordering both honor all present predecessors.
  Missing endpoints/coordinates keep the documented degradation; cyclic constraints fall back
  deterministically rather than hanging. Relation distance discounts do not replace order constraints.
- Within-day order uses `scheduling/routeOrder.ts`: bounded search of at most 8 points, fewer
  feasibility backtracks first, then shorter haversine distance. A valid original order sets a
  distance ceiling (1m tolerance); mandatory predecessors take priority over that ceiling when
  the original violates them. Score/relation discounts never enter this geometric objective.
  `orderUntimedDayRoutes(draft, destination)` reruns after geocoding and final cross-day repair,
  fixes meal slots and missing/invalid coordinates, and skips days with explicit times. It
  preserves all daily members and IDs and clears stale legs; only changed days need new legs.
  Lodging round trips count when coordinates are available. This optimizes geometric order,
  not road-network travel-time optimality; mandatory orders can retain unavoidable backtracks.
- When `foodFocused`, insert lunch at the segment midpoint and dinner at its end. Empty days get
  `自由安排｜<destination>` plus lunch and dinner; without that preference they get only the
  placeholder. Missing food candidates use truthful area anchors, never fabricated venues.
- Meal selection (10-04): `selectMealStop(foods, kind, before, after, fallbackArea)` requires
  known restaurant coordinates and at least one located adjacent attraction. A restaurant must
  be within `SCHEDULE_LIMITS.mealNearbyKm` (2 km) of either neighbor; lunch adds at most
  `mealDetourKm` (2 km) over the direct before→after distance, dinner is within 2 km of the last
  attraction. Rank by that added distance, not only distance from the previous stop. These are
  geometric selection limits, not road-network duration guarantees. Rejected candidates remain
  available for a later nearby meal; never fall back to an arbitrary unlocated or distant food POI.
- Meal selection also filters `isClosedOnDate(food.openTime, date)` using the **assigned day** after
  segment/date matching, never the segment's original index. Closed foods remain in the pool for an
  open day. Missing dates retain distance-only selection. This does not verify source attribution of
  opening facts. All meals are selected only after final scheduling dates are assigned/repaired.
- Without a suitable restaurant, use `<adjacent attraction>周边` with its reference coordinates
  and `ScheduledStop.areaAnchorName`. `buildDraft` uses the actual attraction as `placeName`,
  keeps `poiId` absent and explains that a specific restaurant is unverified. Do not geocode
  the synthetic display name or move a remote meal to the city center. Only when neither
  neighbor has coordinates does the meal fall back to the destination area. Blank times stay
  blank; area-reference zero-distance legs are not proof of a zero-distance restaurant visit.
- `PlaceFacts.recommendScore` / `mentionCount` remain optional through loading and merging. Only
  known values participate in aggregation; real zero stays zero. Unknown values use neutral score
  ratios, so a gold-set landmark with no community metrics scores 65, not 15.
- `lodging` stays EMPTY when the form leaves it empty (09-22 decision): generation never derives
  an area and never names a specific hotel. `verify-c2` asserts `trip.lodging === undefined` for
  the unspecified case; only a user-supplied `form.lodging` is persisted.
- The writer phase reuses the `review` phase name on the SSE stream (frontend contract unchanged)
  and now includes title writing plus final-itinerary advice (10-05; see `trip-advice.md`).
  The title agent's tool surface is EXACTLY `update_titles` (10-02).
  The complete draft is already in the initial prompt. A successful write terminates the title agent;
  font/length/day-count errors leave the draft unchanged and allow at most two repairs (`maxTurns=3`).
  The tool cannot touch activities, order, times, or the activity copy.
  **No separate model pass writes activity descriptions (09-25, tightened 10-02)**:
  research reuses upstream `payload.content.intro` verbatim when present; the model only writes
  missing copy. Target 120–180 Chinese characters, maximum 200, with identity, background and
  concrete sights. `cleanResearchIntro` only trims whitespace and enforces complete-sentence
  length limits; it MUST NOT delete sentences by policy keywords. Source purification, factual
  qualifications and separation of transient policies belong upstream. `buildDraft.ts` copies
  the complete candidate `intro`, with the same 200-character cap.
  Dynamic reservation facts live in separately validated metadata/source links; title writing
  cannot reintroduce them. Synthetic activities with no candidate source (empty-day placeholder, meal anchor
  without a food candidate) get a code-authored truthful sentence; when a candidate source exists
  but its intro is empty, the description stays EMPTY — never fabricate. Optional `notes` are
  included in `update_titles` for compatibility, but the prompt now asks for empty notes;
  dedicated final-itinerary advice is written later. Do not expose the legacy `submit_review` tool to the writer.
- **The writer runs CONCURRENTLY with geo/repair (09-25).** It starts right after
  `draft.validate()` passes and is `await`ed after `endPhase('plan')`. Measured effect: the writer's
  42–82s (reasoning-dominated, high variance) no longer queues behind geo, and `plan`'s ~4s leaves
  the critical path. Total wall clock ≈ `research + max(plan, titles) + final advice + tail`, NOT
  `research + plan + review`. Do NOT re-serialize it: nothing in the copy path needs coordinates or
  legs. Concurrency is safe because the writer touches only `title`/`days[].title` while the fixers
  move activities between days — disjoint fields, and the fixers never delete activities.
- The normal title path takes one model request; the former three-call protocol was removed on
  10-02. Historical 09-25 title timings (711–1476 tokens / 24–28s) do not describe this new protocol.
- The writer is an enhancement path: an LLM error or turn limit degrades to the defaults already in
  the draft (code-generated `day.title`s and the candidate `intro` copy) and the job still succeeds.
- Geo resolution, actual transit legs, feasibility checks, `repairLongHaulMixedDays`, and
  `optimizeCrossDayGrouping` still run. `ensureMealCoverage` and `repairTransitTiming` no longer
  run because they depend on a time axis; meal insertion belongs to deterministic scheduling.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `loadPlaceFacts` query fails | warn, empty map, schedule falls back to the type table |
| no candidate has coordinates | retain candidates subject to capacity, resolve coordinates later |
| no attractions | truthful placeholder and, when food-focused, lunch and dinner |
| selected attractions still closed after bounded repair | explicit `job_error`; no draft mutation/save/success quota |
| candidates exceed pace/capacity | overflow dropped, reported in `phase_end` summary |
| no nearby food candidate / all would detour | adjacent attraction area reference; destination only without located neighbors |
| writer LLM error / turn limit | keep drafted copy, `job_done` unaffected |
| cancellation during scheduling | propagates as on any other phase |

### 5. Wrong vs Correct

```typescript
// Wrong: let the model invent coordinates/times or free-form the whole day.
const plannerRun = await runDurablePhaseAgent({ tools: [freeFormTool], ... });

// Correct: planner agent chooses within the tool contract；距离/时刻/闭馆由 plan_day 计算。
const plannerRun = await runDurablePhaseAgent({
  tools: [listAreas, searchAreaPlaces, webSearch, planDay, validatePlan, submitPlan],
  completion: { isComplete: () => planner.submitted, ... },
});
```

Representative paths: `apps/server/src/generation/scheduling/`,
`apps/server/src/generation/orchestrator.ts`, `apps/server/src/generation/tools/draftTools.ts`.
Meal regressions: `mealLocality.test.ts` covers added-distance selection, both distance limits,
unknown coordinates, retained candidates, closed-day rejection/open-day reuse and actual assigned
dates after segment swaps; `scheduling.test.ts` covers daily meal capacity.
`dateRepair.test.ts` covers moves/swaps, ordered bundles, unknown coordinates, holidays, 15 days,
exclusive/no-solution cases, distance ceilings and meals after repair. The generation-flow script
checks actual closed-date failure, database counts and one terminal HTTP SSE replay.
`scripts/verify-generation-flow.mts` verifies remote area names/coordinates/place hints in a
real draft under its owned PostgreSQL database. Pure meal tests must not import `buildDraft`
because its relation-loader dependency imports the application database client.
Measurement scripts: `cd apps/server && npx tsx test-gen-timing.mts`, plus `test-kb-shape.mts` for
what the knowledge base can actually support.

## Scenario: Research Place Reuse and Local Planner Revisions (P0)

### 1. Scope / Trigger

Apply when changing research POI capture, draft activity edits, automatic geocoding, or the
second planning round. Keep this within the existing research -> plan -> review runtime;
public Trip schemas, persistence, provider queues, timeouts, and quotas are unchanged.

### 2. Signatures

- `PlaceHint { placeName?: string; poiId?: string }` and `DraftActivity = Activity & PlaceHint`.
- `ResearchOutcome.locations: Map<string, ResearchLocation>`; a `ResearchLocation` is a
  readonly `{ lat: number; lng: number; adcode: string }` from an Amap POI result.
- `GeoSession.useResearchPlaces(pool, locations): void` binds the finished research to one
  generation session.
- `GeoSession.geocodeAll(draft, onProgress, signal?, changedOnly?: boolean): Promise<void>`.
- `DraftTrip.updateActivity(dayIndex, position, patch: Partial<DraftActivityInput>): string`.
- `buildDraftTools(draft, mode: 'plan' | 'revision' = 'plan'): AgentTool[]`.
- Revision tool: `move_activity({ fromDayIndex, activityId, toDayIndex })`, with 1-based days.
- ~~`plannerUserPrompt(form, research, revisionRequests?, longHaulIntel?, currentDraft?): string`~~
  — deleted in 09-25 together with the other LLM-planner prompt builders.

### 3. Contracts

- `search_pois` captures exact trimmed names, GCJ-02 coordinates, and adcodes privately.
  Conflicting coordinates or nonempty adcodes for the same name permanently disqualify that
  name from reuse for this research instance. Non-finite, out-of-range, and `(0, 0)` points
  cannot enter the reusable index.
- Candidate `poiId` resolves to its canonical name. An explicit conflicting `placeName`
  wins over a stale ID. Otherwise lookup uses the exact place name, including legacy meal
  extraction: `午餐｜春熙路 · 川菜` queries `春熙路` while its display name stays intact.
  Do not fuzzy-match candidate names or use a restaurant ID to represent an entire meal area.
- Reused points are staged and pass the same `rejectFarGeocodes` firewall as fresh lookups.
  A rejected research point gets one normal lookup-chain attempt in that pass and another
  validation; its research name is disabled for subsequent reuse in the session. Reference
  unavailability and validation exceptions retain the existing firewall degradation behavior.
- The median reference pool contains already-geocoded activities plus staged results. An
  unchanged failed/estimated activity skipped by `changedOnly` must not become a reference.
- Reuse makes no new provider attempt and spends no extra `geo.stats.calls`; the original
  research attempt remains counted. Ordinary fallback calls keep existing accounting,
  limits, source labels, and GCJ-02 conversion. Accepted adcodes populate route `city1/city2`.
- Renaming a place, changing a reference, or changing coordinates invalidates old coordinates
  and affected activity legs. Clear inherited conflicting hints; clear old source notes on a
  place replacement unless replacements are supplied. Re-resolution deletes the old adcode.
  A time/description-only patch preserves the ID, references, coordinates, coordinate system,
  source notes, and routes. Coordinate patches are re-resolved, not treated as verified points.
- Repeating the same normalized lodging suggestion preserves its resolved data. Changing
  lodging clears its coordinates and all lodging-sentinel legs, preserving activity legs.
- Round 1 uses creation tools and `PLANNER_SYSTEM_PROMPT`. Round 2 uses
  `PLANNER_REVISION_SYSTEM_PROMPT`, receives `draft.render()` with IDs/places/lodging, and has
  no `set_trip_skeleton`. `move_activity` appends the same activity to the target day; the
  planner adjusts its time and the post-pass recomputes routes. Unaffected content stays put.
- After the last review, `geocodeAll(..., true)` resolves new/invalidated states before final
  route recomputation. It skips unchanged failed queries, including unchanged failed lodging.
  The state key includes coordinates/source as well as the place reference, so invalidating
  coordinates without changing the name still triggers resolution. Regular planning-round
  passes retain the existing opportunity to retry unresolved items.
- `DraftTrip.toTrip()` strips internal `placeName`/`poiId`; no public schema or DB migration.
  Final meal coverage, route coherence, feasibility, SSE, and cancellation still run.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Valid unambiguous research point | Validate, then adopt without repeated geocoding. |
| No reusable exact match, ambiguous name, invalid point | Normal geocoding chain and truthful fallback. |
| Reused point fails sanity | Normal lookup, revalidate; still invalid -> keep unresolved. |
| Time or description edited | No new location query or route attempt for unchanged verified pairs. |
| Place or coordinates changed | Old location data invalidated; final review pass resolves again. |
| Move has missing activity/day or same source/target day | Error text, no draft mutation. |
| Signal aborted | Stop starting new work items; throw before adopting in-flight results. |

### 5. Good / Base / Bad Cases

- Good: research located a museum and two meal areas; the post-pass only looks up the city
  center, retains identical verified activity coordinates, and routes with each area's adcode.
- Base: a model-only candidate has no research coordinates; the usual lookup chain resolves it.
- Bad: a revision recreates the skeleton, a renamed activity keeps the old museum's coordinates,
  or a skipped estimated point makes the sanity reference drift to the wrong city.

### 6. Tests Required

- `placeLookup.test.ts`: meal queries, reference priority, ambiguity, invalid coordinates, and
  private research adcode capture without candidate-schema leakage.
- `draftRevision.test.ts`: non-location edit preservation, location/route invalidation, lodging
  idempotence, ID-preserving moves, invalid moves, and stripping internal hints on persistence.
- `geoPipeline.test.ts`: mocked HTTP counts (unseeded 4 vs reuse 1 for city + 3 places), identical
  coordinates, transit adcodes, safe fallback, failed-query skipping, reference-pool hygiene,
  coordinate-only invalidation, and cancellation. Use isolated env/SQLite and intercept all
  provider fetches, including Nominatim.
- `scripts/verify-c2.mjs`: reviewer overrun fallback plus an actual second planning round;
  assert one skeleton, all original activity IDs, both daily meals, local edits, and clean Trip JSON.
- Keep typecheck, full server tests, and offline eval green. Mock counts and historical snapshot
  replay do not establish online latency or newly generated itinerary quality.

### 7. Wrong vs Correct

```typescript
// Wrong: discard the researched location and rebuild the draft on every review round.
await geocodeActivity(apiKey, activity.name, destination, tryGeocode);
const tools = buildDraftTools(draft);

// Correct: bind task-local evidence and restrict the revision to the existing draft.
geo.useResearchPlaces(research.pool, research.locations);
const tools = buildDraftTools(draft, 'revision');
const prompt = plannerUserPrompt(form, research, requests, intel, draft.render());
await geo.geocodeAll(draft, onProgress, signal, true);
await geo.computeLegs(draft, onProgress, signal);
```

## Scenario: Final Route Coherence After Model Review

### 1. Scope / Trigger

Apply this contract after the final reviewer turn. Reviewer tools can update, remove, or reorder
activities, and model-authored day boundaries can separate nearby places while pairing each with
a distant place. Both cases make pre-review legs or grouping unsafe to persist unchanged.

### 2. Signatures

- `computeLegs(draft, onProgress, signal?, onlyDayIndexes?): Promise<void>`
- `optimizeCrossDayGrouping(draft, context): Promise<RouteCoherenceResult>`
- `repairTransitTiming(days): number[]`

### 3. Contracts

- Recompute all legs immediately after review. If this optional recompute fails, delete every
  day's legs; missing routes are truthful, stale routes are not.
- Resolve reviewer-invalidated places with `geocodeAll(..., true)` before recomputing final
  legs; otherwise a replacement activity could retain missing or stale location data.
- Cross-day grouping swaps only same-category visit blocks and keeps following meal activities
  attached to their attraction. A candidate needs a strong proximity signal in either direction:
  at most 20km from a target-day peer, at least 40km from its current-day peers, and at least
  30km closer to the target cluster.
- Rank candidates heuristically, try at most three, then targeted-recompute both affected days.
  Accept only when all required current-adjacency/lodging legs exist, total computed route time
  drops by at least 30 minutes, and hard feasibility violations do not increase.
- Snapshot the complete day array before attempts. Any rejected or failed attempt restores the
  snapshot exactly. Non-cancellation failures degrade to the original itinerary; cancellation
  propagates to the orchestrator.
- Run final meal repair after grouping, recompute days receiving inserted meals, then push
  activities forward using current legs. A shifted meal must remain fully inside its meal window.

### 4. Validation & Error Matrix

- Reviewer deletes/reorders an activity -> full recompute replaces stale endpoint ids.
- Initial or post-swap required leg is missing -> skip/reject optimization; never count it as
  zero-minute travel.
- Real route gain is under 30 minutes or hard count rises -> restore the attempt snapshot.
- Targeted recompute throws -> restore the entry snapshot and continue generation without a swap.
- `AbortSignal` is aborted -> restore state and rethrow so the job converges to `cancelled`.

### 5. Good / Base / Bad Cases

- Good: 乌兰察布's 辉腾锡勒 and 黄花沟 are grouped on one day only after the real route total
  improves by at least 30 minutes and hard violations do not increase.
- Base: no candidate passes the conservative thresholds; persist the reviewed day grouping with
  freshly recomputed legs.
- Bad: accept a swap because a missing leg was summed as zero, or retain legs that reference an
  activity removed by the reviewer.

### 6. Tests Required

- `routeCoherence.test.ts` covers the Ulanqab grouping regression, affinity in both day
  directions, per-day-valid leg ids, minimum route gain, no new hard violations, exact rollback,
  cancellation propagation, and transit-aware timing repair.
- Orchestrator integration verification must still reach `job_done` when optional geo/grouping
  work degrades, and persisted days must contain no stale leg endpoint ids.

### 7. Wrong vs Correct

```typescript
// Wrong: reviewer mutations leave stale routes, and missing post-swap legs look artificially fast.
await runReviewer(draft);
const gain = oldMinutes - sumPresentLegsOnly(draft);
persist(draft);

// Correct: resolve changed places, then rebuild routes and validate bounded grouping changes.
await geo.geocodeAll(draft, onProgress, signal, true);
await geo.computeLegs(draft, onProgress, signal);
await optimizeCrossDayGrouping(draft, { mode, recomputeLegs, signal });
ensureMealCoverage(draft.mutableDays(), destination);
repairTransitTiming(draft.mutableDays());
persist(draft);
```

## Scenario: Meal Completeness and Legacy Budget Compatibility

### 1. Scope / Trigger

Apply this contract when changing planner/reviewer prompts, draft validation, final generation
post-passes, or the legacy `GenerateForm` / `Trip` budget fields. TripWeaver owns meal timing,
area, and cuisine planning; it does not claim live restaurant price, rating, opening-hours,
queue, reservation, or transaction capability.

### 2. Signatures

- `missingMeals(days): Array<{ dayIndex: number; kind: 'lunch' | 'dinner' }>`
- `isFoodFocused(preferences): boolean` — `preferences.includes('美食')`, the ONLY source of the meal mandate
- `mealCoverageProblems(days, { foodFocused }): string[]`
- `ensureMealCoverage(days, destination): MealRepair[]`
- `prompts.ts` exports ONLY `formBrief`, `RESEARCH_SYSTEM_PROMPT`, `WRITER_SYSTEM_PROMPT`, and
  `writerUserPrompt`. The conditional-meal prompt builders (`plannerSystemPrompt` /
  `plannerRevisionSystemPrompt` / `reviewerSystemPrompt`), their user-prompt counterparts,
  `renderPoolIndex` / `renderLongHaulIntel` / `renderRagContext`, and the shared
  `activityRequirements` helper were all deleted in 09-25 — meal and long-haul discipline is
  enforced by the deterministic scheduler, not by prompt wording.
- `DraftTrip.validate(): string[]` includes `mealCoverageProblems`.
- `GenerateForm.budgetLevel`, `GenerateForm.totalBudget`, `Trip.budgetLevel`,
  `Trip.totalBudget`, and `Activity.cost?` remain compatibility fields.

### 3. Contracts

- **The meal mandate is preference-driven (09-21 decision D3/D6).** Only when
  `isFoodFocused(form.preferences)` is true must every generated day contain both lunch and
  dinner; otherwise a day with no meals at all is a complete itinerary. Explicit meal names
  count; otherwise only `category === '美食'` starting in 11:00-14:30 or 17:00-21:30 counts.
- `submit_plan` rejects a draft with a day-specific missing-meal problem before review — but
  only for food-focused forms, because `mealCoverageProblems` returns `[]` otherwise. Callers
  must pass `{ foodFocused }` explicitly; there is no default, so a new call site cannot
  silently inherit the old hard gate.
- The orchestrator computes `foodFocused` ONCE at the top of `runGeneration` and threads it
  through the planner/reviewer prompts and the `ensureMealCoverage` gate. Do not re-derive it
  per phase from partial state.
- Non-food-focused forms still keep the anti-fabrication rule: if a meal activity is present
  its `description` must name the dining area/cuisine and defer live price/rating/hours to
  Dianping or Meituan. Non-food-focused forms simply are not required to invent one.
- `set_lodging` is an OPTIONAL step, not a mandatory one: the planner prompt calls it
  “住宿（可选）” and says it is not a required step. Keep the area-only / no-hotel-brand rule.
- After the final review, `ensureMealCoverage` runs again (food-focused forms only). It inserts
  slot with a 15-minute transfer buffer on both sides and invalidates that day's legs, or, when
  no slot exists, integrates the meal into an activity spanning the meal window so it does not
  create an overlap.
- Deterministic repair creates no `cost`. Its copy recommends an area, local cuisine, or
  representative dish and sends live price/review/hours/queue confirmation to Dianping or
  Meituan.
- New model tool schemas do not expose `cost`, and budget fields do not influence planner or
  reviewer decisions. Existing stored budget/cost values still parse and round-trip unchanged.

### 4. Validation & Error Matrix

- Missing lunch/dinner at `submit_plan` -> return explicit day/meal problems; do not submit.
- Reviewer removes the last meal and a slot is free -> insert the missing meal, recompute legs
  for the changed day, continue generation.
- Reviewer removes the last meal and no slot is free -> integrate into a spanning activity,
  continue without adding an overlapping activity.
- Restaurant live data is absent or stale -> keep advice generic and require external-platform
  confirmation; never invent dynamic facts.
- Legacy JSON contains budget or activity cost -> accept and preserve it; do not use it to steer
  a new generation.

### 5. Good / Base / Bad Cases

- Good: a day has `午餐｜前门片区 · 京味小吃` at 12:00 and a replaceable dinner area at 18:30.
- Base: review deletes dinner; the post-pass inserts a nearby 18:00-19:15 dinner suggestion.
- Bad: treat one generic food stop at 15:00 as both meals, or claim a restaurant's current
  rating/price/queue without a live authoritative integration.

### 6. Tests Required

- Unit-test explicit-name and time-window meal detection, per-day problem messages, insertion
  ordering, leg invalidation, no-cost output, and the no-free-slot integration fallback.
- Prompt tests assert both meals and external-platform boundaries, and assert budget/cost tools
  are absent.
- `scripts/verify-c2.mjs` must complete the full generation/SSE/persistence flow with mock days
  that include both meals.

### 7. Wrong vs Correct

```typescript
// Wrong: prompt-only completeness can be undone by review.
await runReviewer(draft);
persist(draft);

// Correct: validate before submit, then deterministically enforce after review.
draft.validate();
await runReviewer(draft);
ensureMealCoverage(draft.mutableDays(), form.destination);
persist(draft);
```

### Common Mistake: AbortSignal only checked at phase boundaries

**Symptom**: after cancellation the job stays "running" for tens of seconds while a post-pass
loop drains serial external calls (350ms–1.1s each).

**Cause**: `assertAlive(signal)` was only called between phases; loops with metered serial
calls did not observe the signal per iteration.

**Fix / Prevention**: any loop performing serial external calls (post-pass, batch jobs) must
accept `signal?: AbortSignal` and check it at the top of every iteration, then let the
orchestrator's catch converge to the authoritative `cancelled` terminal state. Found as a
High issue in task `07-12-geo-data-layer`.

## Time and Resource Limits

The orchestrator applies a 10-minute whole-job timeout through the job abort controller and
limits review to two rounds. Individual agent turns and external provider calls have their own
limits. Keep a whole-job limit even when adding narrower timeouts so a stalled phase cannot
leave a user permanently marked as running.

The review phase keeps its 12-turn per-agent bound. If that bound is exceeded, stop the reviewer,
preserve any draft mutations it already completed, add an explicit degraded-review note, and
continue through deterministic meal coverage, final feasibility notes, and persistence. Review
turn exhaustion is a quality degradation, not a reason to discard an otherwise usable plan;
after successful persistence it follows normal successful-generation quota accounting. Other
model/provider errors remain visible failures.

Validation paths: `scripts/verify-c2.mjs` covers API/SSE replay, cancellation, quota, BYOK,
and migration behavior; `scripts/verify-c3.mjs` covers the production browser flow and
refresh recovery after `npm run build`.

## Scenario: LLM Request Context Snapshots

### 1. Scope / Trigger

Apply this contract when debugging generation misbehavior (model ignoring tools, empty
responses, prompt regressions) or changing `agents/durablePhase.ts` / phase prompts. Every LLM API
request made by the three phase agents is persisted as a full context snapshot so the exact
system prompt, message history, and tool definitions can be inspected after the fact.

### 2. Signatures

- `createLlmRequestRecorder(scope: { jobId, userId, phase, round }): LlmRequestRecorder`
  in `apps/server/src/generation/llmRequestLog.ts`
- `RunAgentOptions.recorder?: LlmRequestRecorder` in `apps/server/src/generation/agents/phase.ts`
- Table `llm_request_logs`: `id, job_id, user_id, phase, round, turn, model, system_prompt,
  messages JSONB, tools JSONB, response JSONB NULL, created_at TIMESTAMPTZ`;
  indexes `(job_id)` and `(user_id, created_at DESC)`.

### 3. Contracts

- The runner wraps the agent's `streamFn` (pi-agent-core defaults to pi-ai `streamSimple`;
  see `agent.js` constructor). The wrapper inserts one row per API request with a per-phase
  `turn` counter starting at 1, then delegates to `streamSimple` unchanged.
- The same wrapper also drives the live debug view: `PhaseEventSink.onLlmRequest/onLlmResponse`
  forward SSE `llm_request` (full context) / `llm_response` (stopReason, tokens) events,
  emitted whenever a recorder OR the trace callback exists. Web rebuilds one timeline node per
  turn (`generationTimeline.ts` `LlmRequestItem`, paired by phase+turn) with expandable full
  prompt/messages/tools; replay from the event buffer restores the nodes.
- `messages`/`tools` are the normalized pi-ai context objects, stored verbatim as JSONB.
  API keys never enter the snapshot: keys flow through `getApiKey`, not the context.
- On each assistant `message_end`, the runner writes `response =
  { stopReason, usage, errorMessage, text }` back to the pending row. The assistant message
  itself also appears in the next turn's `messages` snapshot; the write-back covers the final
  turn and error stops.
- Recording is an enhancement path: insert/update failures only `console.warn` and skip the
  row; generation must never fail because logging failed.

### 4. Validation & Error Matrix

- Snapshot insert throws -> warn, return null row id, skip response write-back, continue.
- Response write-back throws -> warn, continue.
- No recorder passed -> runner behaves exactly as before (no streamFn override).
- Request errors before any assistant `message_end` -> row keeps `response = NULL`.
- `llm_response` matching no open phase block (legacy replay) -> event ignored.

### 5. Good / Base / Bad Cases

- Good: a failing plan phase shows turn=1 with `response.stopReason = 'length'` and
  `usage.output = maxTokens`, directly revealing output-budget exhaustion.
- Base: research phase logs ~10-16 rows with `messages` growing each turn as tool results
  are appended.
- Bad: swallow a generation exception because the recorder threw, or store api keys / BYOK
  material in the snapshot.

### 6. Tests Required

- Run `apps/server/test-beijing-rag.mts` (or any generation), then query
  `llm_request_logs` for the job: assert turn sequence per phase, growing message counts,
  and non-null `response` on completed turns. `test-llm-log-check.mts` prints this summary.
- `npm run typecheck` must pass; schema.ts and migrate.ts must stay in dual-update sync.

### 7. Wrong vs Correct

```typescript
// Wrong: subscribe to events and reconstruct the context from pieces.
agent.subscribe((ev) => { if (ev.type === 'turn_start') guessContext(); });

// Correct: wrap streamFn — the exact (model, context, options) tuple per API request.
const streamFn: StreamFn = async (model, context, options) => {
  await recorder.recordRequest({ turn: ++seq, model: model.id, ...context });
  return streamSimple(model, context, options);
};
```

### Common Mistake: weak models burn the whole output budget before emitting tool calls

**Symptom**: plan phase ends with "行程草稿不完整" (0 tool calls, 0 visible text); the gateway
may surface HTTP 500 "empty response content".

**Cause**: `buildModel` sets `maxTokens`. pi-ai's `streamSimple` clamps it to
`min(model.maxTokens, 32000)` (`providers/simple-options.js`), so `model.maxTokens` is the wire
`max_tokens` ceiling. The old `8192` let a reasoning-heavy tool-calling model consume the whole
budget on hidden reasoning (`stopReason = 'length'`, no tool call). Verify with
`llm_request_logs.response.stopReason = 'length'` and `usage.output = maxTokens`.

**Fix / Prevention**: `generation/model.ts` now uses `maxTokens: 32000` (= the pi-ai clamp, so
writing `1000000` changes nothing). Do **not** expect large values to reach the wire: the gateway
may reject them anyway (a New API relay answered `field MaxTokens invalid, should be in [1, 384000]`
for `max_tokens: 1000000`). Trade-off seen live (09-20): a 32k budget let one plan turn emit
21k output tokens and take ~3.7 min, so research + plan + review together can exceed the job
timeout. Decision (09-20): keep `maxTokens: 32000` and raise the cap —
`GENERATION_TIMEOUT_MINUTES = 15` in `packages/shared/src/constants.ts` is the single source for
both `JOB_TIMEOUT_MS` and the frontend `timeout` copy. Diagnose with the snapshot table first
instead of hand-writing curl repro scripts. Found in task `09-20-llm-context-logging`.

### Common Mistake: reasoning tokens, not tool arguments, dominate a phase's wall clock

**Symptom**: the plan phase takes 7-10 minutes while every tool call is instant and the visible
assistant text is a few hundred characters. Measured live (09-20): plan 597.8s of a 793.4s job,
47228 output tokens across 14 turns, **392 characters of visible text**. Two turns alone
(144.6s + 182.4s) carried 60275 + 30105 characters of hidden `thinking`.

**Cause**: a reasoning model's `usage.output` counts hidden reasoning. Output speed is roughly
constant (~150-166 tok/s here), so turn latency ≈ thinking length ÷ output speed — the tool
arguments (14 `add_activity` = 5116 characters) are noise by comparison.

**Measure before optimizing**: `cd apps/server && npx tsx test-gen-timing.mts` prints the
phase / tool-union / LLM-wait split, and `npx tsx test-llm-output-probe.mts` breaks each turn's
output into `thinking` vs `toolCall` vs `text` characters. (`llm_request_logs.response.text`
only holds text parts, so a near-zero char count with a large `usage.output` is the tell.)
Do NOT raise `maxTokens` for this — the budget is not the constraint; reasoning volume is.
Ref: `.trellis/tasks/09-20-gen-timing/research/2026-09-20-phase-timing.md`.

### Common Mistake: a dead geocoding fallback silently costs ~22s per unresolved place

**Symptom**: `geo_geocode_all` takes 165.7s and produces zero coordinates.

**Cause**: two stacked failures. (1) `geoPipeline.init()` gates the Amap credential on daily
budget `remaining >= GEOCODE_MAX_PER_TASK + ROUTE_MAX_PER_TASK` (= 60); with
`AMAP_DAILY_BUDGET=150` mostly spent, `apiKey` becomes `null` and the whole chain skips Amap.
(2) The fallback is Nominatim, which is unreachable from some networks: `integrations/geocode.ts`
times out at 10s and returns `null`, and `geocodeActivity` calls it **twice** per place
(`${city} ${name}` then `name`), so each unresolved activity costs ~22.3s (measured
22315 / 22247 / 22257ms) — with `GEOCODE_PIPELINE_CONCURRENCY = 2`, 14 activities ≈ 166s.

**Prevention**: when a fallback provider is expected to be unreachable, fail fast rather than
wait for the timeout, and add a circuit breaker in the spirit of `createRouteBreaker`. Diagnose
with `cd apps/server && npx tsx test-geo-latency.mts` (per-level latency + the budget gate
verdict). Note the gate is a daily-budget policy knob, not a code bug: check
`AMAP_DAILY_BUDGET` against the per-task reservation before blaming the geocoder.

### Measured: what actually moves the wall clock (09-20 verification)

> Superseded in part by "Measured: the wall-clock budget after 09-25" below: the plan/review
> numbers here predate deterministic scheduling (09-21) and title-only writing (09-25). The two
> levers it documents (`reasoning_effort`, `maxTokens`) are still dead ends.

Before optimizing any generation latency, read
`.trellis/tasks/09-20-gen-timing-soft-reasoning-effort/research/2026-09-20-fix-verification.md`.
Four measured results, all on the same 北京 3-day form:

- **Nominatim fast-fail works**: 2.5s timeout + 3-failure breaker took `geo_geocode_all` from
  165.7s to **3.2s** (the dead fallback was 22.3s per unresolved place). Probes:
  `cd apps/server && npx tsx test-geo-latency.mts`.
- **A soft-violation loop is real and cheap to kill**: the `check_feasibility` reply now appends
a convergence hint when `hard === 0`. plan round 1 went 597.8s → **314.8s**, 14 turns → 6.
- **`reasoning_effort` is not a lever on this gateway**: passing `reasoning: 'medium'` does
  reach the request body (verify with `npx tsx test-reasoning-effort.mts`), but plan round-1
  output *rose* 47228 → 51646 tokens. Measure before assuming a lower effort saves time; the
  model's hidden thinking volume is what it is.
- **The revision round is the dominant cost once round 1 is fast**: plan round 2 emitted
  61243 tokens over 4 turns (~370s) and pushed the job past `GENERATION_TIMEOUT_MINUTES = 15`,
  so the terminal state was `cancelled` — worse than slow. Any plan-phase optimization must
  budget round 2, not just round 1. Also: the reviewer's soft-severity `revisionRequests` are
  what triggers that round at all.

### Historical measurement: wall-clock budget after 09-25

Read this before proposing any further latency work. Nine real runs on the same 北京 3-day form
(`cd apps/server && npx tsx test-gen-timing.mts`) produced a counter-intuitive conclusion: **the
pipeline is no longer the bottleneck — the provider's output rate is.**

**Historical per-phase budget** (after the 09-25 changes; before SQL prefetch/single-call titles):

| phase | LLM calls | output tokens | wall clock | notes |
| --- | --- | --- | --- | --- |
| `research` | 4–7 turns | 5992–9222 | **89–180s** | ~73% of its output is writing the candidate pool (intro + selection reasoning) |
| `plan` | **0** | 0 | **2.8–4.3s** | deterministic scheduling + geo + repair only |
| `review` | 3 turns | 711–1476 | **24–28s** | writes titles only; runs CONCURRENT with geo/repair |

Total wall clock across nine runs: 216 / 195 / 195 / (error) / 199 / 137 / 246 / 185 / 206s —
median ≈ 195s, with no stable sub-3-minute guarantee.

**The output rate is the real variable.** Same model, same phase, measured **31.7–80 output
tokens/second (a 2.5× spread)**. The 9th run emitted 35% FEWER tokens than the 8th and took 23s
LONGER because it hit the slow end of that spread:

| run | turn | output tokens | wall clock | rate |
| --- | --- | --- | --- | --- |
| 8 | research | 4250 | 63.9s | 66 tok/s |
| 8 | research | 2448 | 35.6s | 69 tok/s |
| 9 | research | 4612 | 145.5s | **31.7 tok/s** |

Consequence: **judge a prompt change on output token count, never on one run's wall clock.** Use
`test-gen-timing.mts` for the phase split, or query `llm_request_logs` for per-turn `usage.output`
(combined with `length(response->>'text')` to separate visible text from hidden reasoning).

**What was already removed (do not re-add):**

- LLM planning (09-21) — structure is `buildSchedule`'s job; the plan phase makes zero LLM calls.
- Per-activity copy writing (09-25) — the writer used to rewrite every `description` (5132 output
  tokens / 42–126s, high variance). Activity descriptions now reuse the research candidate `intro`
  verbatim (`buildDraft.ts`), and the writer only calls `update_titles` (711–1476 tokens / 24–28s).
- Serializing copy behind geo/repair (09-25) — the writer starts right after `draft.validate()` and
  runs concurrently.
- Candidate-pool size targets (09-25) — the prompt now asks for ~3–4 attractions per day and drops
  the fixed food/hotel quotas; research output fell 9222 → 5992 tokens.
- The empty keyword layer in `retrieveContext` (09-25) — the model sends space-separated phrases
  like `"故宫 历史文化"`, and the SQL matched the whole phrase against `name`, so it never hit
  anything. `researchTools` now splits on whitespace before calling, and `keywordRecall` also
  matches `payload.themes`.

**Measured ineffective — do not retry these:**

- **Tightening `description` length caps.** Cutting 100 → 60 characters *raised* review output
  (3327 → 4723 tokens): ~85% of a turn's output is hidden reasoning, which no character cap
  governs.
- **Batching the description tool.** `update_description` → `update_descriptions` did not change
  the turn count under the old three-step protocol. The 10-02 change removes read/submit steps
  themselves; this is different from merely batching the write tool.
- **`reasoning_effort`** and **raising `maxTokens`** — see the 09-20 section above.

Model/provider output rate remains important, but is not the only lever. The 10-02 audit found
discarded vector calls and redundant title round trips. SQL prefetch now feeds the first research
request directly; the writer normally makes one request. Compare token counts, actual request
durations and total wall-clock across multiple runs. `test-gen-timing.mts` uses phase interval
union and actual request/response timestamps, not phase-duration sums or adjacent request starts.
Request cycles include the awaited log write and retries; do not label them pure inference time.

## Scenario: Explicit DeepSeek Thinking Toggle in Generation (2026-10-02)

### 1. Scope / Trigger

The user's 10-02 Beijing trip took 208.418s from first model request to save; first-turn output
was 17,835 of 19,247 tokens despite SQL prefetch. SDK `thinkingLevel: 'off'` alone did not send
an off switch when `model.reasoning = false`. This is distinct from the ineffective historical
`reasoning_effort: medium` experiment.

### 2. Signatures

`buildModel(cfg, {disableDeepSeekThinking?: boolean})`; the generation orchestrator opts in.
Chat understanding uses the default options. No settings/API/schema changes.

### 3. Contracts

Only exact native IDs `deepseek-v4-flash` / `deepseek-v4-pro` opt in, including compatible relays
using these IDs. Set capability `reasoning: true` and `compat.thinkingFormat = 'deepseek'` so
the runner's `off` emits `thinking: {type: 'disabled'}`. Also set
`compat.requiresReasoningContentOnAssistantMessages = true`: even with thinking disabled,
tool continuation must include `reasoning_content: ''` on assistant messages. Omitting it
caused a real second-turn HTTP 400; a one-turn mock cannot detect this. Do not set `reasoning_effort`, change
the model/provider, or reduce the 32k output ceiling. Unknown/namespace-qualified IDs retain
existing behavior; do not infer native protocol from a loose substring. BYOK SSRF checks remain.

Official [DeepSeek thinking documentation](https://api-docs.deepseek.com/guides/thinking_mode)
states thinking is enabled by default and documents the explicit toggle. Local HTTP capture
proves serialization, not whether a third-party relay honors it or the resulting output quality.

### 4. Validation & Error Matrix

| Input | Outgoing behavior |
| --- | --- |
| Generation opts in, exact native V4 ID | `thinking.type = disabled`, no `reasoning_effort` |
| Default caller / other model / namespaced alias | No new provider-specific parameters |
| Relay ignores the toggle | Real-run token/timing comparison still needed; do not claim speedup |
| BYOK unsafe URL | Existing SSRF rejection before constructing model |

### 5. Good / Base / Bad Cases

Good: inspect the actual SDK HTTP body and compare multiple real runs. Base: another compatible
model is unaffected. Bad: set `reasoning:false` and claim server thinking is disabled, or lower
`maxTokens` until reasoning exhausts the budget before emitting tools.

### 6. Tests Required

`generationModel.test.ts` runs the real runner/SDK against a local mock, verifies both V4 IDs,
unknown/namespaced/default cases, lookup then submit across two requests, the empty assistant
reasoning field on continuation, no post-submit request, and retained output budget.
Run typecheck and isolated full server/C2 tests; never treat mock wall clock as live latency.

### 7. Wrong vs Correct

Wrong: `{reasoning: false}` with `thinkingLevel: 'off'` sends no DeepSeek toggle.
Correct: for the explicitly supported generation models, set the capability and DeepSeek
compatibility format, then keep the runner at `off` and assert the serialized body.

## Upstream flakiness must not kill the whole job

**Symptom**: web generation fails with `模型调用异常：400 Error from provider (Console): Upstream
request failed: Model is unavailable.` even though the same model answers simple requests.

**Cause**: relay/upstream pool flakiness (one channel lost the model) — the error is produced
upstream of this repo, and every LLM error was fatal: `assertAlive` turns any `errorMessage` into
`GenerationFailure`.

**Fix / Prevention**: 重试由 pi-durable 的 `settings.retry`（默认开启）与 pi-ai 的
`isRetryableAssistantError` 分类负责；durable 只提交完整 assistant entry，重试不会把半截消息写进
上下文。配额/计费类错误按上游分类不重试。自定义重试包装已随旧 `agents/runner.ts` 删除。

## Scenario: Closure-Day Day Assignment and Holiday Exemption (09-27)

### 1. Scope / Trigger

Apply when changing the segment→day assignment in `generation/scheduling/schedule.ts`,
`packages/shared/src/openHours.ts` (`isClosedOnDate`), `packages/shared/src/holidays.ts`
(`CN_HOLIDAYS`), or the `closureConflicts` note `orchestrator.ts` writes into `meta.reviewNotes`.

### 2. Signatures

- `isClosedOnDate(openTime: string | null | undefined, dateStr: string | null | undefined): boolean`
  — a public holiday now short-circuits to `false` BEFORE the weekday match
- `findHoliday(dateStr): HolidayRange | null` and `isPublicHoliday(dateStr): boolean` in
  `packages/shared/src/holidays.ts`
- `CN_HOLIDAYS: readonly { name: string; from: string; to: string }[]`
- `ScheduleResult.closureConflicts: readonly ClosureConflict[]` where
  `ClosureConflict = { names: readonly string[]; date: string; holiday: string | null }`

### 3. Contracts

- **Holiday data is per-year and hand-maintained.** `CN_HOLIDAYS` holds only the years published by
  国务院办公厅 (currently 2026, 国办发明电〔2025〕7 号). A year absent from the table is NOT exempt —
  `isPublicHoliday` returns false and the weekday rule applies as before. Update the file each
  November when the next year's schedule is published; never pre-fill unconfirmed years.
- **Store holiday ranges only — not the make-up workdays.** Venue opening rules key off the weekday,
  not off "is today a workday": a make-up Saturday (e.g. 2026-10-10) still runs on a weekend schedule.
  The single case needing exemption is a normally-closed day that is declared a public holiday
  (e.g. 2026-10-05, a Monday inside National Day).
- **The exemption is unconditional, not evidence-gated.** Any date inside a holiday range skips the
  closure check entirely, rather than requiring the text to say 「法定节假日除外」. Rationale: the
  Monday-closure rule carries that exception almost universally in China, while the mined evidence
  rarely spells it out (coverage too low to matter). Cost: venues that do close on holidays get waved
  through — an acceptable trade against wrongly blocking a day the venue is open.
- **Segment→day assignment is global.** Bitmask dynamic programming considers at most 15 dates
  (`2^15` states). First minimize closed attractions actually scheduled; then minimize whole dropped
  segments. Fully closed assignments drop the segment with cost 1; partial closures cost
  `closedCount * (segmentCount + 1)`. Equal-cost solutions favor high-score segments on early dates.
  A flexible segment cannot take another segment's only open date when a zero-conflict solution exists.
  A dropped segment leaves a placeholder (plus meals if requested) and a `closureConflicts` entry.
- **"Whole segment closes" ≠ "part of the segment closes".** A 4-member segment where 1 closes still
  gets assigned (3 members are visitable); only `closedCount >= segment.length` is unassignable.
- **A conflict must reach the user.** `orchestrator.ts` turns each `closureConflicts` entry into a
  `meta.reviewNotes` line. Dropping a segment silently is exactly the failure mode this prevents
  (the user would otherwise just see "a day is missing").

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `startDate` absent | no avoidance at all; segments take the earliest free day in weight order |
| date inside `CN_HOLIDAYS` | `isClosedOnDate` → false, regardless of weekday text |
| year not present in `CN_HOLIDAYS` | no exemption; weekday rule applies (conservative) |
| `dateStr` malformed | `false` / `null`, never throws |
| a zero-closure assignment exists for all selected segments | preserve all segments by globally assigning dates |
| global matching assigns a fully closed date to a segment | drop that segment, retain the day's placeholder, add one `closureConflicts` entry |
| global matching assigns a partly closed date | retain the segment; the overall assignment minimizes scheduled closed attractions before dropped segments |
| segments exceed available days during selection | excess segments are dropped before date matching, with NO `closureConflicts` entry (capacity, not closure) |

### 5. Good / Base / Bad Cases

- Good: Beijing 3-day starting 2026-09-28 (Monday). 故宫/景山/北海/什刹海 take Day2,
  天坛/国博/圆明园/颐和园 take Day3, 八达岭 (whole segment closes Monday) is dropped and the user is
  told; Day1 shows the placeholder instead of a closed attraction.
- Good: the same pool starting 2026-10-05 (Monday inside National Day) puts the 故宫 segment on Day1 —
  the exemption turns the blocked day into the best day.
- Base: no `startDate` → assignment behaves exactly as before 09-22.
- Bad: restoring the "fall back to the earliest unassigned day" branch — it re-creates a day where
  every activity is closed, and the feasibility engine only reports it after the fact.

### 6. Tests Required

- `apps/server/src/__tests__/holidays.test.ts` — all seven 2026 ranges at both boundaries; dates
  outside; non-2026 years; malformed input; the 2026-10-05 Monday exemption vs a normal Monday;
  make-up workdays do not alter weekday behavior.
- `apps/server/src/__tests__/scheduling.test.ts` — whole-segment closure yields a placeholder day +
  one `closureConflicts` entry + a `droppedCount` bump; the 八达岭 fixture no longer lands on Monday;
  partial closure still assigns.
- Assertion points: `result.days[i].stops` names, `result.droppedCount`, `result.closureConflicts`.
- Algorithm-level narrative and a worked Beijing trace live in `docs/DETERMINISTIC_SCHEDULING.md`.

### 7. Wrong vs Correct

```typescript
// Wrong: when no conflict-free day exists, take whatever day is left.
for (let i = 0; i < options.days; i++) {
  if (!assignedDays.has(i)) return i;          // may be a day where every member closes
}

// Correct: evaluate each unused date together with the optimal remaining assignment.
// Fully closed segments are dropped (cost 1); scheduled closures have higher priority.
const assignmentCost = closed === segment.length ? 1 : closed * (segments.length + 1);
const cost = assignmentCost + assign(index + 1, mask | (1 << day));
// Pick the lowest total cost; after matching, report each fully closed segment's drop.
```

Representative paths: `apps/server/src/generation/scheduling/schedule.ts`,
`packages/shared/src/holidays.ts`, `packages/shared/src/openHours.ts`,
`apps/server/src/generation/orchestrator.ts`.

## Lesson: Deterministic consumers must not require artifacts a product decision removed (2026-11-03)

`optimizeCrossDayGrouping` silently no-op'd for every trip with resolved lodging for ~6 weeks:
`actualRouteMinutes` hard-required the `lodging` sentinel legs, but geoPipeline stopped
generating lodging commute legs on 09-22 (decision D5) and `draft.setLodging` filters them.
Nothing failed — the feature just disappeared, and the two files' comments contradicted each
other until a full-review falsification pass caught it.

Rules:

- When a pipeline stage stops producing an artifact, grep for every consumer of that artifact
  (including sentinel-value matching like `fromActivityId === LODGING_SENTINEL`) in the same
  change, or the consumer must degrade gracefully by construction.
- Measurement functions used for before/after comparisons (`actualRouteMinutes` vs
  `heuristicRouteMinutes`) must share the same fallback口径: the estimate side already
  heuristic-estimates lodging legs, so the actual side falls back to `heuristicPairMinutes`
  for missing lodging legs too — constant across the comparison, so swap decisions stay sound.
- "Enhancement silently disabled" bugs are invisible to failure-oriented tests. The
  `routeCoherence.test.ts` fixture generates lodging legs itself (simulating the old
  pipeline), which is why it never caught this — when a fixture must fabricate upstream
  artifacts, add one variant that omits them.
