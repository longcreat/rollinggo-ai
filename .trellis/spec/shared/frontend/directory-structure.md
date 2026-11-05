# Directory Structure

## Scope

The retained `frontend` layer describes the public package consumed by the web application. It does not prescribe the directory layout of `apps/web`.

## Canonical Layout

```text
packages/shared/
  package.json
  tsconfig.json
  src/
    index.ts
    constants.ts
    schemas.ts
    types.ts
    budget.ts
    sample.ts
    utils.ts
```

The roles are demonstrated by `packages/shared/src/index.ts`, `packages/shared/src/schemas.ts`, and `packages/shared/src/budget.ts`.

## Public Entry Point

`packages/shared/package.json` exports only `.`. The complete supported API must therefore be re-exported from `packages/shared/src/index.ts`. Web and server code imports from `@tripweaver/shared`, as seen in `apps/web/src/components/editor/ActivityCard.tsx`, `apps/web/src/store/editorStore.ts`, and `apps/server/src/routes/trips.ts`.

Do not add or use deep imports such as `@tripweaver/shared/src/constants`. Deep imports bypass the package boundary, couple consumers to file layout, and are not declared by the current export map.

## Placement Rules

- Put runtime schemas in `schemas.ts` and their `Static`-derived types in `types.ts`.
- Put closed, shared domain values and limits in `constants.ts`.
- Put reusable, framework-independent domain calculations in focused modules such as `budget.ts`.
- Keep React components, hooks, stores, CSS, HTTP clients, and browser rendering code in `apps/web`.
- Keep Fastify, persistence, environment, integrations, and operational code in `apps/server`.

Only create another shared file for a coherent cross-runtime concern with real consumers. Re-export its public API from the root barrel and check both applications before renaming or moving existing symbols.
