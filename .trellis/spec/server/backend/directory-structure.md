# Directory Structure and Module Boundaries

## Workspace Layout

`apps/server/src/index.ts` is the composition root. It creates Fastify, installs plugins,
registers route modules, installs the global error handler, serves the production web
bundle, and starts the listener. Domain code lives in workspace packages with a single
dependency direction: `shared ← core ← integrations ← services ← agent ← apps/server`.

```text
packages/
  shared/        pure schemas, types, and cross-runtime domain helpers
  core/          env, db, lib, crypto, data, settings/quota, provider constants
  integrations/  outbound providers: amap, qweather, websearch, embedding, image, resend
  services/      database-backed business services, brief/parse, itinerary
  agent/         chat harness, generation, tasks/tools, detailChatService
  evals/         offline snapshots and live evaluation suite
apps/
  server/src/    Fastify composition root, routes, http, auth
  server/test/   server-side node:test suite
  web/src/       React application
```

Representative paths: `apps/server/src/index.ts`, `apps/server/src/routes/trips.ts`,
`packages/agent/src/generation/orchestrator.ts`.

## Naming

- TypeScript module files use camelCase: `tripService.ts`, `liveRun.ts`,
  `searchSource.ts`, and `serialQueue.ts`.
- Directories use lowercase domain names: `routes`, `services`, `itinerary`, `generation`, and
  `integrations/websearch`.
- Route plugins are plural domain names and exported as `<domain>Routes`.
- Service functions are verb phrases such as `createTrip`, `resolveLlmConfig`, and
  `amapBudgetRemaining`.

Representative paths: `packages/services/src/tripService.ts`,
`packages/agent/src/generation/liveRun.ts`, `packages/integrations/src/websearch/searchSource.ts`.

## Route and Service Boundary

Route modules own HTTP concerns: TypeBox request schemas, authentication hooks, status
codes, cookies, redirects, SSE framing, and mapping missing resources to responses.
Services own reusable queries and application behavior. Pass explicit scalar context,
especially `userId`, rather than passing Fastify request objects into services.

The current authentication route is the intentional exception. `apps/server/src/routes/auth.ts`
contains registration, login, OAuth account linking, and direct Drizzle writes because those
flows are tightly coupled to cookies, rate limits, redirects, and authentication primitives.
Do not copy that exception into ordinary resource routes; use the pattern in
`apps/server/src/routes/trips.ts` plus `packages/services/src/tripService.ts`, or
`apps/server/src/routes/settings.ts` plus `packages/core/src/settingsService.ts`.

## Fastify and Shared Contracts

- Declare route plugins as `FastifyPluginAsyncTypebox`.
- Attach TypeBox schemas to every request input surface: `body`, `params`, and
  `querystring` (Fastify's schema key for query parameters).
- Reuse public payload schemas from `packages/shared/src/schemas.ts`; derive shared
  TypeScript types from those schemas in `packages/shared/src/types.ts`.
- Keep route-local schemas for transport-only shapes that are not shared with the web.
- Existing casts in `apps/server/src/routes/generations.ts` are migration debt, not a
  pattern for new code. Prefer `apps/server/src/routes/trips.ts` and
  `apps/server/src/routes/auth.ts`.

## Package References

- Cross-package imports use workspace subpaths such as
  `@tripweaver/core/db/client` or `@tripweaver/services/tripService`; do not reach into a
  sibling package with `../../`.
- Lower layers never import upper layers. In particular, `shared`, `core`, and
  `integrations` must not import `services` or `agent`.
- A new domain package needs `package.json` (`exports` wildcard to `./src/*.ts`) and a
  `tsconfig.json` extending the root base; add it to the root `typecheck` script.

## Source Assets and Runtime Data

Imported static assets belong under `packages/core/src/data`; runtime data and SQLite files
belong under `data/`. Because broad `data/` ignore rules can also hide source assets,
check new source data with `git check-ignore -v <path>`.

Representative paths: `packages/core/src/data/reservationSeeds.ts`,
`packages/agent/src/generation/tools/researchTools.ts`, `packages/core/src/db/client.ts`.
