# Shared Package Frontend-Facing Guidelines

These files describe the frontend-facing contract of `@tripweaver/shared`. They retain the Trellis frontend layer names while documenting the cross-runtime package, not React application conventions.

## Guidelines Index

| Guide | Scope |
| --- | --- |
| [Directory Structure](./directory-structure.md) | Shared package layout, barrel exports, and dependency direction |
| [Component Guidelines](./component-guidelines.md) | How UI components consume shared contracts; components are N/A inside shared |
| [Hook Guidelines](./hook-guidelines.md) | How hooks may use shared code; hooks are N/A inside shared |
| [State Management](./state-management.md) | Shared domain values and pure transformations versus app-owned state |
| [Quality Guidelines](./quality-guidelines.md) | Cross-runtime quality rules, tests, and anti-patterns |
| [Type Safety](./type-safety.md) | TypeBox schemas, derived types and unions, assertions, and runtime checks |

## Pre-Development Checklist

- [ ] Read [Type Safety](./type-safety.md) before changing a schema, type, constant, or protocol.
- [ ] Read [Directory Structure](./directory-structure.md) before adding or exporting a module.
- [ ] Read [State Management](./state-management.md) before adding a domain transformation or value used by the editor store.
- [ ] Confirm the concern belongs in cross-runtime shared code rather than a React component, hook, store, API client, or server module.
- [ ] Search representative web and server consumers, including `apps/web/src/store/editorStore.ts`, `apps/web/src/pages/PlannerPage.tsx`, and `apps/server/src/services/tripService.ts`.
- [ ] Plan root-barrel exports and use `@tripweaver/shared`; `packages/shared/package.json` does not expose deep import paths.

## Quality Check

- [ ] Schema-backed types are derived with `Static<typeof Schema>` (`packages/shared/src/schemas.ts`, `packages/shared/src/types.ts`).
- [ ] Closed values use readonly `as const` arrays and derived unions (`packages/shared/src/constants.ts`, `packages/shared/src/types.ts`).
- [ ] All supported exports flow through `packages/shared/src/index.ts`, and consumers do not deep-import package internals.
- [ ] Code is independent of React, hooks, Zustand, DOM rendering, Fastify, database drivers, and application configuration (`packages/shared/src/budget.ts`, `packages/shared/src/utils.ts`).
- [ ] Assertions are limited to justified library boundaries and are not substitutes for parsing or validation (`packages/shared/src/schemas.ts`, `apps/web/src/pages/PlannerPage.tsx`).
- [ ] JSON, SSE, form, storage, and network boundaries have explicit validation where trust cannot be assumed (`apps/web/src/lib/export.ts`, `apps/web/src/api/client.ts`, `apps/server/src/routes/trips.ts`).
- [ ] The smallest relevant type-check/build was run for affected consumers. Note that `packages/shared` currently has no focused package test script or focused local test suite (`packages/shared/package.json`, `packages/shared/tsconfig.json`).
