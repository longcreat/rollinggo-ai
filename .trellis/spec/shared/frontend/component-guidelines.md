# Component Guidelines

## Applicability

React components are N/A inside `@tripweaver/shared`. The package supplies domain contracts, constants, and pure utilities that components consume; it must not export JSX, component props tied to a screen, React contexts, CSS, or rendering helpers.

This separation is visible between `packages/shared/src/types.ts` and component consumers such as `apps/web/src/components/editor/ActivityCard.tsx`, `apps/web/src/components/editor/BudgetPanel.tsx`, and `apps/web/src/components/PoiCard.tsx`.

## Component-Facing Contract Rules

- Share a type only when it represents a domain or cross-boundary protocol, not merely a local component prop shape.
- Share closed option values through readonly constants, then derive their union types; editor components read the derived unions from `@tripweaver/shared` rather than redeclaring them.
- Keep formatting, labels, dialogs, event handlers, accessibility behavior, and fallback UI in the web application.
- Prefer pure shared calculations when server and UI genuinely need identical results. `computeBudgetSummary` is defined in `packages/shared/src/budget.ts` and consumed by `apps/web/src/components/editor/BudgetPanel.tsx` and `apps/server/src/services/tripService.ts`.

## Boundary Caveat

A component receiving a value typed as `Trip` has compile-time assistance, not proof that network, import, or persisted data matched `TripSchema`. Validate at the data boundary rather than scattering casts through render code. Relevant boundaries include `apps/web/src/api/client.ts`, `apps/web/src/lib/export.ts`, and `apps/web/src/pages/PlannerPage.tsx`.

## Anti-Patterns

- Adding React or JSX to `packages/shared`.
- Moving a one-screen `Props` interface into shared.
- Exporting UI labels or CSS class names as domain constants.
- Casting select or network values to a shared union without checking membership when the value is untrusted.
