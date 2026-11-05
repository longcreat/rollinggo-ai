# Hook Guidelines

## API Client and React Query Boundary

Use `api/client.ts` for normal JSON HTTP transport. It applies same-origin credentials, merged JSON request headers, abort/timeout handling, and runtime validation/unwrapping of `{ code, message, data }`. Callers receive business data directly; errors are `ApiError` with `status`, `code`, `message`, and additional fields in `data`. Put reusable server-state operations in `api/hooks.ts` as React Query queries or mutations. See `docs/API_CONTRACT.md`.

`App.tsx` subscribes once to business-request 401: clear the query cache and generation recovery marker, then navigate to login preserving pathname/search/hash. Concurrent failures are deduplicated; login/register use `auth: 'public'` and reset the auth epoch on success. Do not treat 403/5xx as logout. Query retries are limited to one network/timeout/5xx retry; mutations never retry automatically. Keep business error messages in their existing views rather than adding duplicate global toasts.

Normal request timeout is 30s; long chat requests explicitly allow 180s, source probes 90s, and image generation 240s. POST SSE uses `requestStream` for headers, handshake timeout and HTTP errors; its established stream retains its own lifecycle. Native EventSource confirms failures through a snapshot request and stops reconnecting on 401/404. Avoid duplicate snapshot requests while one is pending, and ignore completions after cleanup.

Evidence: `apps/web/src/api/client.ts`, `apps/web/src/api/hooks.ts`, `apps/web/src/App.tsx`.

Direct `fetch` calls should not duplicate the client behavior. However, "every command must be a hook" is too absolute. A narrow one-shot command may call `api` directly when it is not persistent server state and does not need shared mutation status or cache behavior. The list-level full-trip export is the current example. OAuth navigation uses a normal anchor because it is a browser navigation, not an AJAX request.

Evidence: `apps/web/src/pages/TripListPage.tsx`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/RegisterPage.tsx`.

## Query Keys and Cache Updates

Define reusable query keys in the `keys` object with `as const`. Parameterized entities use key factories such as `keys.trip(id)`. Keep a query's key and fetcher together in its hook.

Choose cache behavior based on what the mutation returns:

- Use `setQueryData` when the response is the authoritative updated entity, as settings and saved trips do.
- Invalidate affected collections when list summaries may have changed.
- Invalidate both collection and detail queries when a partial command, such as rename, does not return the complete updated entity.
- Clear the cache on logout.
- Broad invalidation after login/register is an intentional auth-boundary refresh; prefer targeted invalidation for ordinary domain mutations.

Evidence: `apps/web/src/api/hooks.ts`, `apps/web/src/pages/PlannerPage.tsx`, `apps/web/src/pages/TripEditorPage.tsx`.

Respect query-specific freshness and retry policy. `useMe` reads a 200/null guest snapshot instead of a 401, auth config is long-lived, and optional source status is disabled until requested and does not retry. Do not copy global defaults blindly when the endpoint has different semantics.

React Query v5 rejects a query that has no `queryFn` regardless of `enabled` — the dev check only looks for the option itself (`useBaseQuery`). A cache-only query that must never fetch therefore passes `queryFn: skipToken`; v5's `defaultQueryOptions` then sets `enabled: false` internally, so the two are equivalent. Omitting it logs `No queryFn was passed as an option` on every render, once per mounted observer.

## Effects, Timers, and External Subscriptions

Effects are for synchronization with external systems, not for routine derived values. Use `useMemo` for expensive or identity-sensitive derivation and event handlers for user actions.

Every effect that creates a resource must return cleanup:

- Clear debounce and layout timers.
- Remove DOM and media-query listeners.
- Close `EventSource` subscriptions.
- Guard promise continuations when an async operation cannot be cancelled.
- Clear store state on page unmount when the state belongs only to that mounted editor.

Auto-growing textareas must resize after both text changes and width changes. `ChatInput` observes the textarea's width with `ResizeObserver`, skips zero-width hidden panels, clamps height to 44–120px, and disconnects on cleanup. Ignore height-only observations to avoid feedback loops. Verify a retained draft when resizing from a wide desktop to 1150px and when switching to the 375px chat tab; text below the cap should fit without internal clipping.

Evidence: `apps/web/src/pages/TripEditorPage.tsx`, `apps/web/src/pages/PlannerPage.tsx`, `apps/web/src/components/editor/MapView.tsx`.

The native dialog adapter also removes its `cancel` listener in cleanup. Export helpers revoke object URLs after triggering downloads. Preserve these resource lifetimes when changing browser-facing code.

Evidence: `apps/web/src/components/Modal.tsx`, `apps/web/src/lib/export.ts`.

## SSE and Recovery

Generation progress is an external event stream, not React Query cache state. `useGenerationRun` stores the active job id in `sessionStorage`, checks a snapshot on refresh, then connects `EventSource` with `lastEventId=0` so the timeline can be rebuilt from replayed events. Native reconnects carry `Last-Event-ID`; the server prioritizes that header and sends only the missing suffix. Preserve the existing event list and deduplicate positive safe-integer IDs within the current job/effect. A new task or mount starts at zero. Terminal events close the stream, clear session state, update relevant caches, and navigate or display recovery UI.

Evidence: `apps/web/src/hooks/useGenerationRun.ts`, `apps/server/src/routes/generations.ts`, `packages/shared/src/types.ts`.

Treat SSE data as untrusted input even when the server and client share a union type. Parse inside `try/catch`, validate or narrowly guard the event shape before appending it, and convert malformed payloads into a controlled stream error. A type assertion after `JSON.parse` is not runtime validation. `useGenerationRun.ts` now drops malformed frames with a `try/catch`; keep any new consumer at the same bar.

### Common Mistake: clearing the event list on reconnect

**Symptom**: after a short disconnect, the task title, candidates, or completed phases disappear.

**Cause**: clearing React state assumes a full server replay, while native EventSource reconnection
uses the last delivered ID. Skipping only the first `open` still loses all earlier history on reconnect.

**Fix / Prevention**: never clear from `onopen`; clear when starting/adopting/resetting a task.
Keep the event ID cursor local to the effect and ignore IDs already seen. Verify with
`node apps/web/tests/generation-recovery-browser.mjs` (Vite at 18811): the server sends IDs 1–3,
disconnects, then sends duplicate 3 and new 4; all four original events must remain exactly once.
The same test checks terminal callback/session cleanup, a new task with smaller IDs, and refresh.

### Recovery-aware route guards

`NewTripPage` must resolve a restored job or completed `tripId` before applying the homepage-entry
guard. A completed snapshot has no running `jobId`; navigate directly to its editor instead of
returning home. Skip automatic submission while restoration, an adopted job, or a completed result
exists. Error/cancel reset must also navigate to the homepage: clearing the hook alone leaves the
page's one-shot autostart flag set and strands it on “正在启动生成…”.
`scripts/verify-generation-browser.mjs` covers running refresh, completed snapshot, cancellation
retry, return navigation, and successful generation after cancellation.

## Dependency Discipline

Include all values used by an effect unless there is a deliberate lifecycle reason not to. Existing lint-suppression comments around editor loading/autosave and map point keys encode intentional behavior, but they are not a general license to omit dependencies. Prefer stable callbacks, key primitives, or a small ref when that communicates the synchronization contract more clearly.
