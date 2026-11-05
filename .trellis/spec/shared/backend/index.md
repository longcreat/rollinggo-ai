# Shared Package Backend-Facing Guidelines

These files describe the backend-facing contract of `@tripweaver/shared`. They do not define Fastify application architecture. The package is cross-runtime and is consumed by both `apps/server` and `apps/web`.

## Guidelines Index

| Guide | Scope |
| --- | --- |
| [Directory Structure](./directory-structure.md) | Package layout, public entry point, and dependency direction |
| [Database Guidelines](./database-guidelines.md) | How persistence code may consume shared contracts; database code is N/A inside shared |
| [Error Handling](./error-handling.md) | Validation boundaries and framework-independent failure behavior |
| [Quality Guidelines](./quality-guidelines.md) | Required patterns, assertions, tests, and anti-patterns |
| [Logging Guidelines](./logging-guidelines.md) | Why logging is N/A inside shared and belongs to consumers |

## Pre-Development Checklist

- 地点判等使用 `placeNameKey` / `samePlaceReference`；实体字段 `canonicalPlaceId` 与活动实例 `id` 分离，详见 [地点身份契约](../../server/backend/place-identity.md)。

- [ ] Read [Directory Structure](./directory-structure.md) before adding a file or export.
- [ ] Read [Quality Guidelines](./quality-guidelines.md) before changing schemas, constants, types, or utilities.
- [ ] Read [Error Handling](./error-handling.md) when data crosses an HTTP, JSON, storage, or third-party boundary.
- [ ] Read [Database Guidelines](./database-guidelines.md) if a contract change affects persisted trip data.
- [ ] Search server and web consumers before changing an exported name or value. Representative consumers include `apps/server/src/routes/trips.ts`, `apps/server/src/services/tripService.ts`, and `apps/web/src/pages/PlannerPage.tsx`.
- [ ] Import from `@tripweaver/shared`, not a package-internal path. The public surface is defined by `packages/shared/package.json` and `packages/shared/src/index.ts`.

## Quality Check

- [ ] Runtime contracts are TypeBox schemas and corresponding TypeScript types use `Static<typeof Schema>` where a schema exists (`packages/shared/src/schemas.ts`, `packages/shared/src/types.ts`).
- [ ] Closed value sets are readonly `as const` constants with unions derived from them (`packages/shared/src/constants.ts`, `packages/shared/src/types.ts`).
- [ ] New public symbols are exported through `packages/shared/src/index.ts`; consumers use only `@tripweaver/shared` imports.
- [ ] Runtime code remains deterministic or explicitly depends only on cross-runtime globals; it imports no Fastify, React, database, DOM, or Node-only application modules (`packages/shared/src/budget.ts`, `packages/shared/src/utils.ts`).
- [ ] Any type assertion is narrow, explained by a library boundary, and not used to replace validation (`packages/shared/src/schemas.ts`).
- [ ] Validation behavior was checked at every affected boundary; a TypeBox schema or TypeScript type does not validate arbitrary values by itself (`apps/server/src/routes/trips.ts`, `apps/web/src/pages/PlannerPage.tsx`).
- [ ] The smallest relevant type-check/build was run. Because `packages/shared` currently has no focused test script or package-local test suite, record any untested behavior and add focused tests when a change introduces non-trivial branching (`packages/shared/package.json`, `packages/shared/tsconfig.json`).
