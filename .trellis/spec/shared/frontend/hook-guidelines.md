# Hook Guidelines

## Applicability

React hooks are N/A inside `@tripweaver/shared`. Hooks own React lifecycle, browser subscriptions, data fetching, caching, and component state; those concerns belong to `apps/web`. Shared exports must be callable from plain TypeScript in either runtime.

The intended boundary is represented by shared modules such as `packages/shared/src/budget.ts` and `packages/shared/src/utils.ts`, with React-side consumption in `apps/web/src/api/hooks.ts` and `apps/web/src/pages/PlannerPage.tsx`.

## Reusable Logic

When code appears reusable from a hook, separate only the pure domain portion:

1. Give the shared function explicit serializable inputs.
2. Return a deterministic domain result without React state, effects, query clients, or notifications.
3. Keep loading, retry, cancellation, caching, and effect behavior in the web hook.

`computeBudgetSummary` is the model: the calculation lives in `packages/shared/src/budget.ts`, while components decide when to call it in `apps/web/src/components/editor/BudgetPanel.tsx`; the server can reuse the same function in `apps/server/src/services/tripService.ts`.

## Anti-Patterns

- Exporting functions named `use...` from shared.
- Importing React, React Query, Zustand, or browser event APIs into shared.
- Hiding fetch calls or mutable caches in a shared domain utility.
- Moving a hook into shared merely because more than one component calls it.
