# Type Safety

## TypeBox Schema-First Contracts

Use TypeBox when a shared shape needs a runtime representation. Define each schema in `packages/shared/src/schemas.ts`, then derive its TypeScript type in `packages/shared/src/types.ts`:

```ts
export const TripSchema = Type.Object({ /* fields */ });
export type Trip = Static<typeof TripSchema>;
```

This pattern is used for `Trip`, `Activity`, `GenerateForm`, authentication bodies, and settings. Server consumers register schemas in routes such as `apps/server/src/routes/trips.ts`, `apps/server/src/routes/auth.ts`, and `apps/server/src/routes/settings.ts`; web consumers import the derived types in `apps/web/src/pages/PlannerPage.tsx` and `apps/web/src/store/editorStore.ts`.

Do not write a second interface for a schema-backed shape. Protocol-only types without a runtime schema may remain interfaces or unions in `packages/shared/src/types.ts`, but document that they provide compile-time checking only.

## Constants and Literal Unions

Define a closed value set once as a readonly tuple:

```ts
export const BUDGET_LEVELS = ['economic', 'comfortable', 'luxury'] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];
```

The repository follows this pattern for categories, budget levels, coordinate sources, reservation states, and data source kinds in `packages/shared/src/constants.ts` and `packages/shared/src/types.ts`. The same constants feed TypeBox unions in `packages/shared/src/schemas.ts` and UI choices in `apps/web/src/components/editor/TripMetaDialog.tsx`.

## Runtime Validation Caveat

`Static<typeof Schema>` is erased at runtime. A schema also does nothing until Fastify, TypeBox Value APIs, a compiled validator, or another consumer executes it. Therefore:

- Fastify validates only the request or response locations whose schemas are actually registered.
- `JSON.parse(...) as GenerationEvent` is not event validation (`apps/web/src/pages/PlannerPage.tsx`).
- A typed API client result is not proof of server conformance (`apps/web/src/api/client.ts`).
- Imported or persisted JSON must be validated where trust is required (`apps/web/src/lib/export.ts`, `apps/server/src/services/tripService.ts`).

## Controlled Type Assertions

Assertions are permitted only at narrow library boundaries after the runtime invariant is established. The `StringEnum` helper in `packages/shared/src/schemas.ts` constructs a union from every member of a readonly tuple and uses a localized double assertion because TypeBox and TypeScript cannot preserve the mapped tuple type automatically.

Do not copy that pattern into normal domain code. For unknown input, validate or narrow first. Select values and third-party JSON in `apps/server/src/integrations/amap/poiSource.ts` and `apps/server/src/integrations/websearch/searchSource.ts` are boundary cases, not permission for unchecked assertions.

## Import Safety

Import public values and types from `@tripweaver/shared`. The package export map and root barrel are `packages/shared/package.json` and `packages/shared/src/index.ts`. Deep imports are unsupported and create coupling to internal file layout.

## Anti-Patterns

- `interface Trip` alongside `TripSchema`.
- A handwritten `type BudgetLevel = ...` disconnected from `BUDGET_LEVELS`.
- `as Trip` immediately after parsing unknown JSON.
- Broad `as unknown as` outside a documented library interoperability point.
- Type-only contracts being described as runtime validators.
- Deep imports that bypass the root barrel.
