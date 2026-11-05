# State Management

## Choose the Smallest State Owner

Use state according to its lifetime and authority:

| State kind | Owner |
| --- | --- |
| Input drafts, open/closed flags, active visual tabs, transient errors | Component `useState` |
| Route identity, login callback errors, redirect destination | React Router URL params, search params, location state |
| Server resources and mutation status | React Query |
| Shared editor draft plus editor-only filter | Zustand editor store |
| Refresh recovery for an in-progress generation job | `sessionStorage` |
| Live generation timeline | AppLayout 的 GenerationProvider 持有可重放 SSE 状态，独立生成页消费 |
| Account notifications / current running job | React Query，按账号缓存与服务端持久通知/任务查询 |

Evidence: `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/PlannerPage.tsx`, `apps/web/src/pages/TripEditorPage.tsx`.

There is currently no `localStorage` usage in `apps/web`. Add it only for intentionally durable, non-sensitive browser preferences that should survive browser restarts. Do not use it for auth, authoritative trips, API keys, or server cache. Version and guard any persisted value because storage contents are untrusted and may outlive code changes.

## React Query Is Server State

全局导航、独立生成路由、通知未读及离开编辑器保存的执行约定见 [导航与生成通知](../../server/backend/generation-notifications.md)。生成完成不在全局回调导航；仅可见的对应生成页自动进入详情。

React Query owns authenticated user data, settings, usage, trip collections, and trip details. Components should consume hooks rather than copying fetched server data into another global store by default. Mutation cache effects belong beside the mutation in `api/hooks.ts`. Generation restoration is a narrow exception: its snapshot is fetched as a one-shot command and used immediately to decide whether to reconnect, navigate, or clear recovery state.

Evidence: `apps/web/src/api/hooks.ts`, `apps/web/src/components/AppLayout.tsx`, `apps/web/src/pages/TripListPage.tsx`.

The editor is a deliberate exception because it needs a mutable cross-component working draft. The server remains the durable source of truth; the Zustand store is an editing copy, not a second persistence layer.

## Editor Draft, Revision, and Autosave

详情初次 `load` 默认 `dayFilter=null` 显示「行程总览」总览；显式天数选择、对话结果定位和自动保存回执保持当前选择。`api/weather.ts` 独立查询 `GET /api/trips/:id/weather`，进入详情必查、30 分钟刷新；不写 Zustand 草稿、不触发保存、不创建版本。生成时可选 `Trip.weather` 仅用作请求期间的快照回退，匹配目的地和日期、经过新鲜度检查后才展示。`TripOverview` 提供每日路线/天气与派生建议，`DaySection` 显示昼夜天气，总览不提供手动刷新入口（进入详情必查、30 分钟自动刷新）。见 [天气完整契约](../../server/backend/trip-weather.md)。

Route selection uses `routePairKey(trip, dayId, fromId)` (trip/destination/day plus both endpoint IDs, names, coordinates and coordinate systems). `selectRoute(dayId, key, leg)` rejects changed or non-adjacent pairs before incrementing revision, replaces only that pair and preserves other legs. A coordinate edit drops incident legs. `RouteOptionsForPair` remounts on key changes and guards unmounted promise continuations; options use shared runtime validation. Query responses write the draft only for explicit manual selection or a pending move-triggered recommendation.

Moves create transient `routeReplans` only for newly adjacent pairs; unchanged pairs retain choices. `AutoRoutePlanner` lives above day filtering so hidden source/target days are also handled. It shares the menu cache/serial queue, waits for all modes to settle, and selects a real walk <=1000m, otherwise shortest duration, then distance, then walk/cycle/transit/drive order. Partial failures allow remaining real routes; no real result or missing coordinates yields a visible retry state. Retry creates a fresh job ID and refreshes results. Loading does not schedule recommendations.

Every replan has a unique request ID in addition to its endpoint fingerprint: checking only endpoints would accept an old response after an A→B→A reorder. All edits prune invalid fingerprints; load/clear reset jobs. Manual selection cancels the job before awaiting its query. `finishRouteReplan(id, leg?, error?)` accepts only a still-pending ID and delegates to `selectRoute`; success updates revision/autosave and map geometry. Replan status itself never increments revision. Tests: `editorStore.test.ts`, `recommendedRoute.test.ts`, and `route-options-browser.mjs` (sorting, retry, hidden destination, save/reload).

`api/routeOptions.ts` observes four separate React Query entries per pair/user. Mounted current-day cards prefetch after a 350ms settling delay; successful results are fresh for five minutes, unavailable results for 30 seconds, retained for 30 minutes in memory and cleared by logout. Saving settings invalidates them. Opening a menu does not start an all-mode blocking request.

`RouteQueryQueue` sends only one request at a time across cards. Choosing a mode promotes its queued request and automatically applies the successful recommendation; a selection sequence counter rejects superseded choices. Abort signals skip queued work after unmount/day changes. Already-sent work is allowed to finish before the next request, matching the server concurrency gate. HTTP 429 starts a 30s frontend cooldown; cached valid options remain usable. Manual refresh retries options without changing the saved route by itself.

Route disclosures share editor colours, rounded panels and gradient selection. Escape restores focus to the summary; pointer-outside dismisses. A null `relatedTarget` from a button becoming disabled must not dismiss the panel mid-refresh.

The route menu shows “重试” only after a query/selection error; normal prefetch and successful results have no refresh button or footer. Retry sets local `refreshing` immediately and keeps the button disabled with a spinner, `aria-busy` and “查询中…” until all four queries settle (including failures), then hides it on success. Use `Promise.allSettled` so one rejection does not end the loading indicator early. The label uses `aria-live`, and reduced-motion preferences disable spinner rotation.

`useSaveTrip` uses the `editor-trip-save` React Query mutation scope to serialize writes: debouncing alone cannot prevent an older in-flight PUT from overwriting the latest transport selection. Browser regression: `node apps/web/tests/route-options-browser.mjs` includes a deliberately slow first save, rapid second selection, reload, stale response after move, partial failure and mobile overflow.

`useEditorStore` clones a fetched `Trip` on load. Every domain edit runs through the store's `mutate` helper, clones the current draft with `structuredClone`, applies a focused change, and increments `revision`. UI-only `dayFilter` changes do not increment revision.

`TripEditorPage` loads only when the fetched trip id changes so a React Query cache write after save does not overwrite newer local edits. It clears the store on unmount. A revision change sets the save state to saving, waits 800 ms, reads the latest draft from `useEditorStore.getState()`, and calls `useSaveTrip`. The mutation writes the saved trip to the detail cache and invalidates the list summary.

Evidence: `apps/web/src/store/editorStore.ts`, `apps/web/src/pages/TripEditorPage.tsx`, `apps/web/src/api/hooks.ts`.

Preserve these invariants:

- Loading or clearing a trip resets `revision` to zero.
- Every persisted draft mutation increments revision exactly once.
- Pure view state must not trigger autosave.
- Debounce timers are cleared on revision change and unmount.
- Autosave reads the latest store snapshot, not a stale closure.
- A successful save must not reload and replace in-progress local edits.

`useEditorSave` owns the 800ms debounce and serial saved-revision watermark. A save receipt only updates
the version ID and timestamps through `acknowledgeSave`, preserving newer local draft fields. `flush()` waits for all edited
revisions before chat, food insertion, restore, or version navigation. A failed save keeps the current URL
and draft and exposes a retry button. This is not durable offline persistence.

Manual autosave creates a new version only when content changes. Keep the save owner across its own
URL replacement, seed the new trip/version/conversation caches before navigation, and do not remount
the chat or reload the editor draft on that receipt. Retain the failed snapshot for an idempotent retry;
edits made while waiting stay queued. Route-replan keys follow the new ID and obsolete results are rejected.
On editor unmount, stop applying receipts and navigation callbacks: a completed save may remain stored,
but it must not pull the user back from the trip list. The detail-chat browser regression gates two delayed
saves, preserved day/input state, reload persistence, and navigating away before the receipt arrives.

The history drawer uses the shared native `Modal size="drawer"`, a descending timeline and independent
scroll region with fixed header/footer. Latest and currently viewed versions are separate states. At
600px and below it fills the viewport; close/Escape restore focus. Startup suggestions live inside the
welcome message only when there are no detail messages or pending answer. Follow-up suggestions render
only beside the final message when it is an assistant reply and there is no pending answer (including
stopped/error partial answers). Never fall back to an earlier reply when the latest has no suggestions;
keep historical message data, food cards and clarification choices intact.
New follow-ups are stored `{label,text,kind}` objects attached to their source reply: render `label`,
send the stored `text`/`kind` with the attachment's `dayId`, and never substitute the currently selected
day or a generic menu. Legacy enum suggestions remain readable but are hidden outside the empty-chat
startup menu. Empty/failed follow-up generation leaves the latest answer without suggestion buttons.

Historical routes are read-only in both UI and store guards; automatic route planning does not mount and
route options only display saved legs. Version loading is conservative (read-only until latest is known).
Restore copies content into a new latest version. Apply pending day/activity selection after `load`,
never race it against route changes via an arbitrary frame.

Partial answers, stopped/error state, and recoverable input live in component state; complete messages
and attachments live in React Query. The POST fetch reader validates shared events, UTF-8 chunks,
request IDs, sequence gaps and terminal state. Recovery queries the stored operation result; committed
edits cannot be reported as cancelled. Candidate state derives from current trip POI identity, not a
local `added` flag. See [server contract](../../server/backend/detail-chat-history.md).

`ChatProgress` renders only the server's bounded phase summaries (up to 12 entries, 300 characters
each), never internal model reasoning or tool arguments. While running it starts expanded and allows
manual collapse; completed messages mount collapsed and retain the full list for later expansion or
refresh. Pending components are keyed by request ID and terminal state, so retries start expanded and
stopped/error rows do not carry an active indicator. Persisted summaries end with the successful save
result; an in-flight save is not labelled successful. Both pending and historical rows share the same
16px, keyboard-accessible disclosure and reduced-motion styling. No timer simulates progress.

## URL, Session, and SSE State

账号偏好使用 AppLayout 下按 userId 隔离的 `TravelPreferencesProvider`：React Query 管理服务器快照，本地草稿支持首页与个人资料共同编辑。首页只改草稿，不写账号也不显示保存状态；生成行程成功后，由全局 GenerationProvider 调 `persist(snapshot)` 保存实际提交快照；切页保留新草稿，旧回执不能清除它，保存失败可重试原快照。导航已移除个人资料入口；旧组件保留，不再作为可达操作。只记住偏好、出行方式、200 字备注。见 [完整契约](../../server/backend/travel-preferences.md)。

Use URL state for navigation-relevant values: route ids, OAuth error codes, and the post-login return path. Treat route and search values as untrusted strings and narrow them before use.

Use `sessionStorage` only for the active generation job id because it should survive refresh in the current tab but not become permanent application data. On restoration, query the snapshot before reconnecting or navigating. Clear the key on terminal status, missing/expired jobs, cancellation recovery, and explicit reset.

SSE events rebuild the local timeline. They are append-only inputs until a terminal event, after which the stream closes and React Query collections are invalidated as needed. The derived timeline model is calculated with `useMemo` and should remain replay-safe.

Evidence: `apps/web/src/pages/PlannerPage.tsx`, `apps/web/src/components/GenerationTimeline.tsx`, `packages/shared/src/types.ts`.
