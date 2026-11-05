# Directory Structure

## Runtime and Build Shape

`apps/web` is a Vite React single-page application. Vite serves `/api` through the local server proxy, and `strictPort` keeps the development callback port stable. The package has `dev`, `build`, and `preview` scripts; repository-level TypeScript checking is defined at the workspace root.

Evidence: `apps/web/package.json`, `apps/web/vite.config.ts`, `package.json`.

The application composition is intentionally shallow:

1. `apps/web/index.html` provides `#root`.
2. `apps/web/src/main.tsx` mounts React Strict Mode and imports Leaflet, packaged fonts and the single Tailwind stylesheet.
3. `apps/web/src/App.tsx` creates the single `QueryClient`, provides it, and renders `RouterProvider`.
4. `apps/web/src/router.tsx` owns route declarations and the authentication gate.

Do not scatter providers or route declarations across feature files unless a concrete scaling problem requires it.

## Source Responsibilities

| Path | Responsibility |
| --- | --- |
| `src/pages/` | Route-level screens and orchestration |
| `src/components/` | Reusable application components and browser UI adapters |
| `src/components/editor/` | Trip editor panels, cards, dialogs, and map behavior |
| `src/api/client.ts` | Shared HTTP request and `ApiError` transport behavior |
| `src/api/hooks.ts` | React Query keys, queries, mutations, and cache updates |
| `src/store/editorStore.ts` | Zustand editing draft, revision counter, and editor-only filter state |
| `src/lib/` | Focused browser/domain display helpers such as export, colors, and POI labels |
| `src/styles/` | Single Tailwind entry (`tailwind.css`): semantic tokens, base defaults, font faces and keyframes; page styles live in JSX |

Keep route orchestration in pages, server-state behavior in API hooks, and reusable browser mechanics in components or `lib`. Examples include `apps/web/src/pages/TripEditorPage.tsx`, `apps/web/src/api/hooks.ts`, and `apps/web/src/lib/export.ts`.

## Router Structure and Authentication

`AppLayout` contains the public homepage and a nested `RequireAuth` branch. `/login` and `/register` redirect to the homepage with the same native authentication dialog in login or registration mode:

- `/` renders the covered-city selection home page.
- `/trips` renders the trip list.
- `/trips/new` renders the structured new-trip form (`?city=` 必填，未覆盖城市会被弹回首页) and generation flow.
- `/trips/:id` renders the editor (含内嵌对话面板，行程有关联会话时出现).
- `/generations/:jobId` renders the authenticated generation view.
- Unknown paths redirect to `/`.

`useMe` probes with `auth: 'public'`: with no session, `GET /api/auth/me` returns HTTP 200 and a `null` guest snapshot — never 401, so the browser console stays clean. `auth: 'public'` is kept so an abnormal gateway 401 cannot trigger global expiration. `RequireAuth` waits for this query and sends guests to the homepage login dialog, preserving pathname/search/hash in route state. Non-401 failures render service-unavailable UI. `LoginDialogProvider` owns the dialog above account-keyed providers so authentication cannot unmount its success callback. Login/registration switches use local dialog state, preserving the homepage and return target. Closing keeps the mounted homepage draft; a complete draft resumes through `/trips/new` after password login or registration. Registration retains confirmation, invitation and closed-registration validation.

The planning button uses the same required-field readiness for guests and authenticated users; missing destination or pace disables it before any login prompt. Guests hide account menus and disable usage, account preferences and generation restoration queries. On logout or protected API 401, publish `keys.me = null` before removing other queries; `QueryClient.clear()` alone leaves mounted observers displaying stale account state. Keep protected API expiration handling in `App.tsx`. Verify these contracts with `node apps/web/tests/login-dialog-browser.mjs`.

Evidence: `apps/web/src/router.tsx`, `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/components/AppLayout.tsx`.

When adding a route, decide explicitly whether it is public or authenticated, place it in the correct router branch, and provide route-level loading/error behavior if it fetches data. Do not add a second ad hoc auth redirect inside ordinary pages unless the page handles an operation-specific expired-session message.

## Shared Contracts

The web package resolves `@tripweaver/shared` directly to `packages/shared/src/index.ts`. Domain types, constants, schemas, and shared calculations should come from that package rather than being duplicated in the web tree.

Evidence: `apps/web/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/types.ts`.
