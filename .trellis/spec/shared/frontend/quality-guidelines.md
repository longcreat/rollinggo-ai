# Quality Guidelines

## Cross-Runtime Standard

Code in `@tripweaver/shared` must remain usable by both `apps/web` and `apps/server`. Keep it independent of React, browser rendering, Fastify, persistence, environment configuration, network clients, and operational logging. Current examples are `packages/shared/src/constants.ts`, `packages/shared/src/budget.ts`, and `packages/shared/src/utils.ts`.

## Required Patterns

- Define runtime contracts once with TypeBox in `packages/shared/src/schemas.ts`.
- Derive matching types with `Static<typeof Schema>` in `packages/shared/src/types.ts`.
- Define closed values as readonly `as const` arrays in `packages/shared/src/constants.ts` and derive unions from those arrays.
- Re-export every supported public symbol from `packages/shared/src/index.ts`.
- Import only from `@tripweaver/shared` in applications. Examples include `apps/web/src/store/editorStore.ts`, `apps/web/src/components/editor/BudgetPanel.tsx`, and `apps/server/src/services/quotaService.ts`.
- Prefer pure, explicit domain utilities that can be exercised without application setup.

## Assertions and Validation

Use type assertions only when a library boundary has a real invariant that TypeScript cannot express. The TypeBox union helper in `packages/shared/src/schemas.ts` is the current justified example. Keep such assertions narrow and local.

Do not treat casts at JSON, DOM, form, database, SSE, or third-party boundaries as validation. Existing assertions in `apps/web/src/pages/PlannerPage.tsx` and `apps/server/src/integrations/amap/poiSource.ts` illustrate boundaries that require deliberate trust or checks.

## Testing

There is currently no focused package-local test suite or test script for `packages/shared`; `packages/shared/package.json` contains dependency and export metadata only. Run the smallest repository type-check/build commands covering both consumers. Add focused tests when introducing meaningful branching, compatibility behavior, or validators, especially around `packages/shared/src/budget.ts`, `packages/shared/src/sample.ts`, and `packages/shared/src/schemas.ts`.

## Anti-Patterns

- Parallel interfaces that duplicate schema-backed contracts.
- Repeated handwritten string unions or option arrays.
- Deep imports from `@tripweaver/shared/src/...`.
- React hooks, components, stores, DOM APIs, Fastify types, database clients, fetch calls, or environment reads in shared.
- `any`, broad double assertions, or casts used to hide invalid values.
- Side effects, implicit global state, or mutation in domain calculations.
- Assuming TypeBox schemas execute automatically.
- Changing a public contract without searching both application consumers.
