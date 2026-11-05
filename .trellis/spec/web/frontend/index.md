# Web Frontend Guidelines

These guidelines describe the conventions that are actually present in `apps/web`. They are evidence-based defaults, not absolute rules. When an existing feature has a deliberate exception, preserve the intent and keep the exception narrow.

## Guides

| Guide | Scope |
| --- | --- |
| [Directory Structure](./directory-structure.md) | Vite entry points, provider setup, router nesting, pages, components, API, store, libraries, and styles |
| [Component Guidelines](./component-guidelines.md) | Function components, props, forms, CSS, native dialog usage, accessibility, and async rendering |
| [Hook Guidelines](./hook-guidelines.md) | React Query, API calls, browser adapters, effects, subscriptions, timers, and cleanup |
| [State Management](./state-management.md) | Local, URL, session, SSE, React Query, and Zustand state ownership |
| [Type Safety](./type-safety.md) | Strict TypeScript, shared contracts, assertions, and untrusted input boundaries |
| [Quality Guidelines](./quality-guidelines.md) | Verification reality, required checks, graceful degradation, and anti-patterns |

## Pre-Development Checklist

- [ ] Read [Directory Structure](./directory-structure.md) before adding a route, page, provider, API module, store, or style file.
- [ ] Read [Component Guidelines](./component-guidelines.md) before changing JSX, forms, dialogs, icon controls, or visual styling. All pages use Tailwind utilities in JSX with tokens/base defaults/fonts/keyframes in the single `tailwind.css` entry. There is no legacy-page exception.
- [ ] Read [Hook Guidelines](./hook-guidelines.md) and [State Management](./state-management.md) before adding fetching, mutations, autosave, persistence, timers, subscriptions, or browser APIs.
- [ ] Read [Type Safety](./type-safety.md) before changing API payloads, imports, SSE events, URL state, or shared domain data.
- [ ] Search `apps/web/src` and `packages/shared/src` for an existing component, hook, key, adapter, schema, constant, or type before creating another.
- [ ] Decide which owner fits each new state value: component state, URL, `sessionStorage`, React Query, SSE-derived state, or the editor Zustand store.
- [ ] Identify loading, error, empty, disabled, and optional-service degradation behavior before implementation.
- [ ] Keep the intended edit scope small; do not introduce a framework, dependency, state layer, CSS system, or abstraction without a concrete need.

## Quality Check Checklist

- [ ] Run `npm run typecheck` from the repository root; the base config enables `strict`, `noUncheckedIndexedAccess`, and `noFallthroughCasesInSwitch`.
- [ ] Run `npm run build -w apps/web` (or root `npm run build`) for changes that affect the web bundle, routes, imports, or Vite behavior.
- [ ] Manually exercise the smallest affected flow and run relevant checked-in browser regressions from `apps/web/tests/`.
- [ ] Verify authenticated route loading, 401 redirect behavior, and non-401 service-error behavior when routing or auth changes.
- [ ] Verify every changed async view has intentional loading, error, empty, retry/recovery, and disabled-action behavior as applicable.
- [ ] Verify effects release timers, listeners, `EventSource` instances, object URLs, and other browser resources.
- [ ] Verify icon-only buttons have an accessible name, form controls have labels, dialogs close predictably, and keyboard interaction still works.
- [ ] Verify untrusted JSON, SSE payloads, URL/session data, and imported files are validated or narrowly guarded before entering trusted domain state.
- [ ] Review the diff for unrelated formatting churn, new unchecked assertions, duplicated query keys, direct cache mutation mistakes, and accidental code changes outside the requested scope.

## Primary Evidence

- Application composition: `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/router.tsx`
- Data and state: `apps/web/src/api/hooks.ts`, `apps/web/src/store/editorStore.ts`, `apps/web/src/pages/PlannerPage.tsx`
- Shared contracts: `packages/shared/src/schemas.ts`, `packages/shared/src/types.ts`, `packages/shared/src/constants.ts`
