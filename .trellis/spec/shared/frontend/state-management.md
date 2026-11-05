# State Management

## Applicability

Application state containers are N/A inside `@tripweaver/shared`. Zustand stores, React state, query caches, persistence scheduling, and UI revisions belong to `apps/web`. Shared code defines the domain shapes and pure operations those state layers use.

Examples of the boundary are `packages/shared/src/types.ts`, `packages/shared/src/budget.ts`, and the consuming store `apps/web/src/store/editorStore.ts`.

## Shared State Contracts

- Use TypeBox schemas for state shapes that cross runtime or persistence boundaries, then derive types with `Static<typeof Schema>`.
- Use readonly `as const` values for closed domain options, with unions derived in `packages/shared/src/types.ts`.
- Keep derived state as a pure calculation when both runtimes need it. `BudgetSummary` and `computeBudgetSummary` are defined in `packages/shared/src/types.ts` and `packages/shared/src/budget.ts`, then consumed by `apps/web/src/components/editor/BudgetPanel.tsx` and `apps/server/src/services/tripService.ts`.
- Do not put store instances, subscriptions, persistence adapters, or UI actions in shared.

## Mutation and Ownership

Shared functions should not mutate caller-owned domain objects unless mutation is the explicit, documented API. Prefer returning new values or summaries. State ownership and update strategy remain with the consumer; for example, editor mutations belong in `apps/web/src/store/editorStore.ts`, while server persistence belongs in `apps/server/src/services/tripService.ts`.

## Runtime Validation

Hydrated local state, imported JSON, SSE events, and API responses are runtime data. A TypeScript annotation or assertion does not validate them. Validate at the ingestion boundary when malformed values would violate store invariants. See `apps/web/src/lib/export.ts`, `apps/web/src/pages/PlannerPage.tsx`, and `packages/shared/src/schemas.ts`.

## Anti-Patterns

- Adding Zustand or React state to shared.
- Mutating `Trip` inside a utility that appears to be a pure calculation.
- Persisting derived summaries as a second source of truth without a domain requirement.
- Casting hydrated JSON to a shared type and treating it as validated.
