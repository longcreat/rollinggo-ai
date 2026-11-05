# Quality Guidelines

## Current Verification Reality

`apps/web/package.json` provides `dev`, `build`, and `preview`; it does not provide `test` or `lint`. Focused Node tests for candidate selection live in `apps/web/tests/generationCards.test.ts`; run them with `node --import tsx --test apps/web/tests/generationCards.test.ts`. Keep Node tests outside `src`, which is compiled with browser-only types. Playwright is installed at the root but is not currently wired to a web test suite.

Evidence: `apps/web/package.json`, `package.json`, `tsconfig.base.json`.

Do not claim automated frontend test coverage that does not exist. For ordinary web changes, the current minimum evidence is:

1. Run `npm run typecheck` from the repository root.
2. Run `npm run build -w apps/web` when the bundle, routing, CSS imports, or Vite build could be affected.
3. Manually smoke-test the smallest affected flow in a browser.

Add focused automated tests only when the behavior is stable and regression-prone enough to justify introducing or extending the test setup. Pure transformations such as timeline reconstruction are better candidates than tests that merely restate JSX.

## Async and Failure Quality

Primary async data needs explicit loading and error rendering. Mutations need pending behavior where duplicate actions matter and a visible error or recovery path. Empty results should be distinct from loading and failure.

Optional services may degrade without blocking the core application. Existing examples include optional GitHub login, optional usage/status displays, source-status checks that run only when expanded, missing POI image fallbacks, and old trips without overview data.

Evidence: `apps/web/src/router.tsx`, `apps/web/src/pages/TripEditorPage.tsx`, `apps/web/src/components/SettingsDialog.tsx`.

Review secondary queries individually. It is acceptable for a quota chip not to render when usage data is unavailable, but it is not acceptable for an editor to silently render an empty trip after its primary query fails.

## Browser and Resource Safety

- For lazy or collapsed photo galleries, check DOM loading separately from media decoding. Calling `decode()` on hidden/offscreen nodes during loading changes can reject even when their media is valid. Verify actual image URLs with independent `Image` probes under a test timeout, then exercise visible gallery expansion and modal rendering. Keep real decode/network failures as failures; never suppress `EncodingError` globally.

- Close `EventSource` on terminal events and cleanup.
- Clear timers on rerender and unmount.
- Remove native event listeners.
- Revoke object URLs after download.
- Guard async restoration from updating an unmounted component.
- Keep external links opened in a new tab paired with `rel="noopener noreferrer"`.

Evidence: `apps/web/src/pages/PlannerPage.tsx`, `apps/web/src/components/Modal.tsx`, `apps/web/src/lib/export.ts`.

## Anti-Patterns

Avoid these unless the local code provides a deliberate, documented reason:

- Duplicating the API transport with raw `fetch` instead of `api`.
- Forcing every one-shot browser command into React Query even when no server-state lifecycle is involved.
- Creating ad hoc query-key arrays outside the shared key set when a reusable key exists.
- Copying React Query data into global state without an editing or cross-component ownership need.
- Incrementing editor revision for visual-only state, or mutating the editor draft without incrementing revision.
- Using unchecked `JSON.parse(...) as DomainType` for imports, SSE, or storage.
- Treating a non-401 auth query failure as logged-out state.
- Omitting loading/error behavior for required data or blocking a whole page on optional metadata.
- Adding stable visual styles inline; reserve inline styles for dynamic values.
- Adding icon-only controls without `aria-label`.
- Adding effects without cleanup, suppressing hook dependencies by default, or deriving render-only data through effects.
- Introducing a second CSS/state/data-fetching system without a demonstrated project need.
- Describing current autosave as offline-safe or guaranteed retry.

## Review Focus

For route changes, verify public/authenticated nesting and redirect state. For API changes, verify keys, retry policy, cache updates, and `ApiError` handling. For editor changes, verify clone/revision/autosave invariants. For import, URL, storage, HTTP, or SSE changes, verify runtime validation. For UI changes, verify keyboard access, labels, loading/error/empty states, and responsive behavior.

Evidence: `apps/web/src/router.tsx`, `apps/web/src/api/hooks.ts`, `apps/web/src/store/editorStore.ts`.

## Tailwind Migration Regression Gates

- `node --test apps/web/tests/styles.test.mjs` enforces the single application stylesheet and prevents old CSS imports returning.
- `node apps/web/tests/trip-collection-browser.mjs`: collection filters, keyboard navigation, responsive views and recovery.
- `node apps/web/tests/editor-browser.mjs` and `--amap`: export downloads/print, scrolling, editing, map controls and both renderers (Amap uses an SDK stub).
- `node apps/web/tests/generation-browser.mjs --motion`: timed card entry, typing, breathing, reduced motion, mobile clipping and footer separation. Set motion preference before mounting the fixture so reduced-motion rendering cannot prefill the staged cards.
- `node apps/web/tests/shared-ui-browser.mjs`: authentication forms, navigation, settings dialog, calendar and home layouts using API fixtures.
- `node apps/web/tests/generation-recovery-browser.mjs`: native SSE disconnect/reconnect, retained history, ID deduplication, new task cursor, and refresh (Vite at 18811).
- `node scripts/verify-generation-browser.mjs`: current homepage → production generation → editor, running/completed recovery, cancellation retry, and lock release (build first; disposable local PostgreSQL + mock LLM).
