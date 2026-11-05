# Chat and Conversational Intake Guidelines

对话在 09-26 改版后只存在于**生成完成之后**：编辑器内嵌 `ChatPanel` 负责按需修订与旅行问答。
行程创建入口是「首页城市选择 → 结构化表单」（`HomePage` + `NewTripPage`），表单提交时惰性建会话并把表单
整包 PATCH 进 Brief 快照——编辑器靠 `findConversationForTrip` 反查会话挂出对话面板。
首页只列已覆盖城市（`GET /api/destinations/covered`，verified ≥ 100）；未覆盖城市不提供生成入口
（UI 级限制，服务端不硬拦，降级生成路径保留给 API/测试）。

以下对话机制仍然有效，只是入口从「收集页」换成了「编辑器面板」。

10-02 详情页改用 POST 流式端点；正文增量、查询建议、候选添加、历史版本及保存并发规则见
[详情对话流与版本恢复](./detail-chat-history.md)。下文 confirm 自动启动描述保留给旧端点；
新详情端点还要求明确重新生成文字，建议查询始终只读。

## Boundary: chat collects, generation executes

- Chat understands one user message and returns `{ reply, briefPatch, missingFields }`. It may answer
  travel questions. It does not generate trips.
- **Auto-start on confirm (09-24 R3)**: when the model returns `intent: 'confirm'` and the Brief is
  ready, the messages route itself starts the generation (`createJob` + `runGeneration`) and returns
  `autoStartedJobId`. There is no countdown or buffer. Silent degradation: if the generation quota is
  exhausted or a job is already running, no job is started and the confirm card remains the manual fallback.
- **Coverage honesty hint (09-25 R2)**: when the Brief's destination appears or changes, the route
  checks `cityCoverage()` and, for uncovered cities, appends a fixed honest-degradation sentence to
  the assistant reply (not a separate message — message pairing must stay intact). Destinations are
  never blocked; the hint only sets expectations.
- A Brief is a snapshot: a generation task runs on the Brief as it was when the run started,
  so chatting while a run is in flight cannot retroactively change that run.

Representative paths: `apps/server/src/routes/conversations.ts`,
`apps/server/src/chat/understanding.ts`, `apps/server/src/chat/brief.ts`,
`apps/web/src/pages/ChatPage.tsx`.

## Scenario: Dialogue intent, Brief readiness, and revision

### 1. Scope / Trigger

Apply when changing the dialogue intent set, the Brief readiness rule, the追问 (intake) controls,
the chat quota, or the conversation-to-generation link.

### 2. Signatures

- `CHAT_INTENTS` — the single source of truth for the intent whitelist
  (`packages/shared/src/constants.ts`). `apps/server/src/chat/models.ts` re-exports it as
  `DIALOGUE_INTENTS`; never write a second local list.
- `requiredBriefFields(data): BriefMissingField[]` and `briefIntake(missing)` — pure, in
  `packages/shared/src/chat.ts`; used by the server (gate), the web (card state) and the prompt.
- `applyDialogueDecision(current, raw: unknown, evidenceSequence)` in `apps/server/src/chat/brief.ts`
  — pure, defensive, accepts the model's raw output.
- `briefToGenerateForm(data, { appendNotes })` — pure, in shared; the single Brief → form mapping.
- `chatTurnsToday(userId)` / `chatHasQuota(userId)` in `services/chatQuotaService.ts`.
- `createTrip(userId, source, revisionOf?)` in `services/tripService.ts`.

### 3. Contracts

- **Required fields are exactly four**: destination, start date, end date *or* day count, pace（旅行节奏：relaxed/moderate/tight；09-26 取代 tripFocus，密度随节奏走）.
  Everything else may be missing and still generate. `days` is a legal equivalent of `endDate`;
  when both a date range and `days` exist, the explicit dates win (`applyDialogueDecision` deletes the
  stale `days`).
- **`CHAT_INTENTS` must be derived, not duplicated.** A local second copy is a silent failure: tool
  argument validation rejects the unknown intent, the agent retries the same call until the turn limit,
  and the client only sees a generic 502. This actually happened with `modify_itinerary`.
- **The model's output is untrusted.** `applyDialogueDecision` reads `unknown` and drops or clamps
  anything invalid (unknown polarity/category, out-of-range days, over-long text) instead of throwing.
  A single bad field must not cost the user the whole conversation.
- **Read-only intent cannot mutate the Brief.** `applyDialogueDecision` ignores all fields and
  constraint additions/removals for `intent='travel_qa'`, even if those patches are otherwise valid.
  Ordinary patches without an intent and legitimate update/confirm/edit decisions keep patch semantics.
- **Replacing a requirement must remove its stale source.** When an explicit update cancels or changes
  a requirement stored in `extraNotes`, the understanding prompt requires updating that text while
  retaining unrelated requirements and removing contradictory constraint IDs. An explicit empty
  `extraNotes` clears it; an omitted field preserves it. Do not append “can eat spicy food” while
  keeping “cannot eat spicy food” in the old notes. `chatBriefApply.test.ts` covers QA mutation guards,
  legal patch compatibility and empty-note cancellation; real `eval:intent` checks note updates.
- **One turn writes both messages, or writes nothing.** `appendMessages` inserts the user message and
  the assistant reply in one transaction. An understanding failure leaves no trace, and the chat quota
  (counted from `chat_messages` where `role='user'`) therefore never charges a failed turn. This mirrors
  the generation rule that failed and cancelled runs do not consume quota.
- **Chat quota is independent of generation quota.** `CHAT_DAILY_LIMIT` counts user turns; the
  generation quota counts `generations.status='done'`. `PATCH /api/conversations/:id/brief` now has one
  meaning only: the home-page snapshot write, which persists the brief the user already assembled in the
  capsule. It appends no messages, so the editor's chat opens on the welcome copy instead of a
  machine-written 「已更新：…」 pair, and it consumes no chat turn. The confirm-card edit branch (which
  did append a user message and consume a turn) was removed on 10-17 together with
  `POST /api/conversations/:id/messages`, when the home page moved to map city picking + the capsule
  intake; `useSaveBriefSnapshot` is the only front door left.
- **Brief intake happens on the home page, not in chat (10-17).** The `briefIntake` /
  `briefIntakeWithOptions` contract, `BriefIntakeSchema`, `ChatMessage.intake`, `IntakeControls` and
  `chatDerive.activeIntake` were removed together with `POST /api/conversations/:id/messages`: the home
  page now collects destination / dates / pace in the map + capsule flow and writes the whole brief in one
  snapshot (`PATCH /brief`). Do not reintroduce multi-turn intake without a product decision — the
  `chat_messages.intake` column stays only for historical rows.
- **`requiredBriefFields` is still the single readiness rule.** The home page (`NewTripPage`), the brief
  status derivation (`briefStatus`) and the auto-regeneration check in `detailChatService` all call it;
  it is the only remaining consumer of `BRIEF_MISSING_FIELDS`.
- **Revision is a targeted edit, not a re-run (09-24 R1).** The model emits `editOps`
  (replace / delete / add activity — the only three supported operations) against the current trip
  rendered into the prompt with activity ids (`renderCurrentTrip`). The route normalises them
  (`normalizeEditOps`), geocodes new activities through the same chain as generation, applies them
  deterministically (`applyItineraryEdits` in `apps/server/src/chat/editOps.ts`), and persists the
  result as the next version via `createTrip(userId, trip, revisionOf)`. No generation row is
  written and no generation quota is consumed. Cross-day moves / lodging stay out of the
  chat channel (editor-only). Budget has been removed from the product. The legacy `kind='revision'` generation path still exists for API
  compatibility but the chat UI no longer uses it.
- **Edit anchoring follows messages, not just generations.** An edit writes no `generations` row,
  so `latestConversationTrip` reads both `generations` and `chat_messages.relatedTripId` and picks
  the higher version — otherwise the next "再改一下" would anchor back to the stale pre-edit version.
- **Revision targets are ownership-checked.** Both the conversation and the target trip must belong to
  the authenticated user; `kind='revision'` without `targetTripId` is a 400, a non-owned target is a 404.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Model returns no tool call and no text | 502 `dialogue_understanding_failed`; nothing persisted, no quota used |
| Model returns text but no tool call | Treated as a plain reply with `intent: 'unclear'`; Brief unchanged |
| Chat quota exhausted | 429 `chat_quota_exhausted` with `resetAt`; nothing persisted |
| No usable LLM config | 400 `no_llm` with `hasSiteKey`, same分流 as generation |
| Brief not ready | No confirm card; missing fields drive intake controls |
| Chat page first mounted, no conversation yet | The confirmation card still renders from an empty Brief so the user can see what will be collected |
| Brief ready + `intent: 'confirm'` | Server auto-starts the generation and returns `autoStartedJobId`; quota exhausted / job running silently falls back to the manual card |
| `kind='revision'` without `targetTripId` | 400 `revision_target_missing` |
| `targetTripId` not owned | 404, identical to a missing trip |
| Understanding fails mid-turn | user + assistant messages both dropped; the turn is not counted |

### 5. Good / Base / Bad Cases

- Good: "11月去成都玩3天，带2岁小孩" fills destination/days/focus, records the companion fact as
  `polarity: 'fact'`, and asks only for the start date with a date control.
- Base: a user asks a weather question mid-collection; the reply answers it and the Brief is untouched.
- Bad: a second local intent list that silently drops `modify_itinerary`, or a per-message insert that
  leaves an orphan user message when understanding fails.

### 6. Tests Required

- `apps/server/src/__tests__/chatBrief.test.ts` — readiness rules, intake construction, constraint
  normalisation, `emit date > days` precedence.
- `apps/server/src/__tests__/chatBriefApply.test.ts` — defensive `applyDialogueDecision` and
  `briefToGenerateForm` (including notice-able truncation).
- `apps/server/src/__tests__/chatEditOps.test.ts` — edit-op normalisation and application:
  in-place replace, leg pruning, append/position clamp, per-op rejection isolation, idempotence.
- `apps/server/src/__tests__/chatDerive.test.ts` — web-side pure derivations (intake liveness, polarity
  copy, conversation summary).
- `node scripts/verify-c2.mjs` — chat CRUD, quota separation, ownership 404s, confirm auto-start,
  targeted-edit revision chain (`rootId`/`version`/`parentId`), edit anchoring across turns,
  trip-list version dedupe.
- `node scripts/verify-c3.mjs` — the same flow through the production browser bundle, including the
  editor-embedded chat panel and chat-driven edits.

### 7. Wrong vs Correct

```typescript
// Wrong: a second local intent list — the new intent silently fails tool validation.
export const DIALOGUE_INTENTS = ['update_brief', 'travel_qa', 'confirm', 'unclear'] as const;

// Correct: derive from the shared wire contract so the two cannot drift.
export const DIALOGUE_INTENTS = CHAT_INTENTS;
```

## Common Mistakes

### Two TypeBox packages coexist and are not runtime-compatible

`apps/server/src/generation/tools/*` and `apps/server/src/chat/*` must use `typebox` (v1, the
pi-agent-core ecosystem). `packages/shared` and Fastify route schemas use `@sinclair/typebox` (v0.34).
v1 emits JSON Schema (`anyOf` / `const`); `@sinclair/typebox/value`'s `Value.Check` throws
`Unknown type` on it. `typebox` v1 also has no `Static`, which is why
`apps/server/src/chat/models.ts` does not mirror the decision schema with a hand-written interface —
model output is read as `unknown` and normalised field by field instead. Verify with
`node -e "const {Type}=require('typebox'); ..."` before assuming the two interoperate.

### A map-built union collapses to one literal in TypeScript

`Type.Union(values.map((v) => Type.Literal(v)))` infers a non-tuple array, so the TypeScript type
collapses to a single literal and comparisons like `kind === 'revision'` fail to typecheck. Use an
explicit tuple literal for intersections consumed by route handlers, or the mapped-tuple `StringEnum`
helper in `packages/shared/src/typebox.ts`.

### Fastify logs to stdout, not stderr

Pino's default target is stdout. A verification script that pipes `stdout` into a no-op and only
surfaces `stderr` hides every application log, including the `warn` that explains a chat
understanding failure. `scripts/verify-c2.mjs` routes both streams through `VERBOSE`.
