# Quality Guidelines

## Schema-First Contracts

Use TypeBox for values that need both a runtime schema and a TypeScript type. Define the schema once in `packages/shared/src/schemas.ts`, then derive the type with `Static<typeof Schema>` in `packages/shared/src/types.ts`. Existing examples include `TripSchema`/`Trip`, `GenerateFormSchema`/`GenerateForm`, and `SettingsPutSchema`/`SettingsPut`; consumers include `apps/server/src/routes/trips.ts` and `apps/server/src/routes/settings.ts`.

Do not create a parallel interface that can drift from an existing schema. Interfaces and unions remain appropriate for protocol shapes that currently have no runtime schema, such as generation events in `packages/shared/src/types.ts`, but callers must not mistake those types for runtime validation.

## Constants and Derived Unions

Closed domain values belong in readonly `as const` arrays in `packages/shared/src/constants.ts`. Derive unions with `(typeof VALUES)[number]` in `packages/shared/src/types.ts`, and reuse the same values when constructing schemas in `packages/shared/src/schemas.ts`. Examples include activity categories, budget levels, coordinate sources, POI categories, reservation statuses, and data source kinds.

Do not duplicate string unions, option arrays, or validators in consumers such as `apps/server/src/generation/draft.ts` or `apps/web/src/components/editor/ActivityCard.tsx`.

## Framework Independence and Purity

- Shared domain functions must work in server and browser runtimes.
- Prefer explicit inputs, deterministic outputs, and no hidden application state.
- Do not import Fastify, React, Zustand, database drivers, server environment modules, or DOM-only APIs.
- Cross-runtime globals are allowed only when both targets support them and the requirement is explicit. `uid` uses `globalThis.crypto.randomUUID()` in `packages/shared/src/utils.ts`; `computeBudgetSummary` is a pure calculation in `packages/shared/src/budget.ts`.

## Public Imports

`packages/shared/package.json` exports only the package root, and `packages/shared/src/index.ts` is the public barrel. Export new supported symbols there. Server and web consumers must import from `@tripweaver/shared`, as shown by `apps/server/src/services/quotaService.ts`, `apps/server/src/generation/orchestrator.ts`, and `apps/web/src/store/editorStore.ts`. Deep imports are unsupported.

## Controlled Assertions

Avoid assertions in ordinary domain logic. A narrow assertion is acceptable at a library typing boundary when runtime construction already establishes the invariant and TypeScript cannot express it. The generic TypeBox string-enum helper in `packages/shared/src/schemas.ts` uses `as unknown as TUnion<...>` for that reason.

Assertions at JSON, form, database, or third-party boundaries do not validate data. Prefer an actual validator or a checked narrowing before converting unknown input. Existing consumer assertions in `apps/web/src/pages/PlannerPage.tsx`, `apps/server/src/integrations/amap/poiSource.ts`, and `apps/server/src/integrations/websearch/searchSource.ts` should be treated as boundary caveats, not patterns to spread.

## Testing and Verification

`packages/shared/package.json` currently defines no focused test script, and there is no package-local focused test suite. At minimum, run the smallest available TypeScript/build checks that cover both consumers after contract changes. Add focused tests when changing non-trivial pure logic, schema compatibility, or boundary validation; `packages/shared/src/budget.ts`, `packages/shared/src/schemas.ts`, and `packages/shared/src/sample.ts` are the highest-value candidates.

## Anti-Patterns

- Duplicating a schema shape as a handwritten interface.
- Duplicating a literal union separately from its `as const` values.
- Importing `@tripweaver/shared/src/...` or reaching into the workspace by relative path.
- Adding Fastify plugins, React hooks, persistence, fetch calls, environment access, or logging to shared.
- Using `any`, broad `as unknown as`, or a cast to make invalid data compile.
- Assuming TypeBox schemas validate values merely because the values have `Static` types.
- Changing exported constants or required schema fields without checking both server and web consumers.
