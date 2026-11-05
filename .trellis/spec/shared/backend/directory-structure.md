# Directory Structure

## Scope

The retained `backend` layer describes how backend consumers use `@tripweaver/shared`; it is not a home for `apps/server` rules. Fastify routes, services, database modules, authentication, and integrations remain outside this package.

## Canonical Package Layout

```text
packages/shared/
  package.json       # Exposes only the package root
  tsconfig.json      # Package TypeScript configuration
  src/
    index.ts         # Complete public barrel
    constants.ts     # Shared readonly domain values and limits
    schemas.ts       # TypeBox runtime contracts
    types.ts         # Schema-derived and shared protocol types
    budget.ts        # Pure domain calculation
    feasibility.ts   # Pure itinerary time-space feasibility engine (M0-A)
    geo.ts           # Pure coordinate conversion + haversine
    legs.ts          # Pure transit-leg helpers (lodging sentinel, estimateTransit)
    sample.ts        # Cross-runtime sample-domain factory
    utils.ts         # Small cross-runtime utilities
```

Evidence: `packages/shared/package.json`, `packages/shared/src/index.ts`, and `packages/shared/src/schemas.ts`.

## Public Boundary

- `package.json` exposes only `.` and points it at `src/index.ts`; therefore every supported public symbol must be re-exported by the root barrel.
- Consumers import from `@tripweaver/shared`. Do not use deep imports such as `@tripweaver/shared/src/types` or relative paths into `packages/shared`.
- Internal shared files may use relative imports because they are within the package implementation.

Examples of the intended root import are `apps/server/src/routes/auth.ts`, `apps/server/src/services/tripService.ts`, and `apps/web/src/components/editor/BudgetPanel.tsx`.

## Dependency Direction

`packages/shared` may depend on cross-runtime libraries such as TypeBox, but it must not depend on either application. Application code points inward to shared contracts; shared code never imports Fastify, React, Zustand, browser UI modules, database drivers, or server environment modules.

The current framework-independent shape is visible in `packages/shared/src/budget.ts`, `packages/shared/src/sample.ts`, and `packages/shared/src/utils.ts`.

## Adding Files

Add a file only when it groups a coherent public domain concern. Export its supported API from `src/index.ts`, keep implementation details unexported, and search both `apps/server/src` and `apps/web/src` before moving or renaming existing exports.
