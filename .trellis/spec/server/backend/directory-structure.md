# Directory Structure and Module Boundaries

## Runtime Layout

`apps/server/src/index.ts` is the composition root. It creates Fastify, installs plugins,
registers route modules, installs the global error handler, serves the production web
bundle, and starts the listener.

```text
apps/server/src/
  auth/          password, invite, session, guard, and GitHub OAuth primitives
  crypto/        encrypted secret storage helpers
  data/          source-controlled static data imported by server code
  db/            SQLite client, Drizzle schema, and idempotent startup migration
  generation/    background job state, orchestrator, agents, prompts, and tools
  integrations/  outbound providers, source status, geocoding, and SSRF checks
  lib/           narrow runtime helpers such as proxy setup, serial queues, and TTL cache
  routes/        Fastify HTTP plugins and transport concerns
  services/      reusable database-backed application operations
  env.ts         centralized environment parsing and startup validation
  index.ts       process bootstrap and route registration
```

Representative paths: `apps/server/src/index.ts`, `apps/server/src/routes/trips.ts`,
`apps/server/src/generation/orchestrator.ts`.

## Naming

- TypeScript module files use camelCase: `tripService.ts`, `jobManager.ts`,
  `searchSource.ts`, and `serialQueue.ts`.
- Directories use lowercase domain names: `routes`, `services`, `generation`, and
  `integrations/websearch`.
- Route plugins are plural domain names and exported as `<domain>Routes`.
- Service functions are verb phrases such as `createTrip`, `resolveLlmConfig`, and
  `amapBudgetRemaining`.

Representative paths: `apps/server/src/services/tripService.ts`,
`apps/server/src/generation/jobManager.ts`, `apps/server/src/integrations/websearch/searchSource.ts`.

## Route and Service Boundary

Route modules own HTTP concerns: TypeBox request schemas, authentication hooks, status
codes, cookies, redirects, SSE framing, and mapping missing resources to responses.
Services own reusable queries and application behavior. Pass explicit scalar context,
especially `userId`, rather than passing Fastify request objects into services.

The current authentication route is the intentional exception. `apps/server/src/routes/auth.ts`
contains registration, login, OAuth account linking, and direct Drizzle writes because those
flows are tightly coupled to cookies, rate limits, redirects, and authentication primitives.
Do not copy that exception into ordinary resource routes; use the pattern in
`apps/server/src/routes/trips.ts` plus `apps/server/src/services/tripService.ts`, or
`apps/server/src/routes/settings.ts` plus `apps/server/src/services/settingsService.ts`.

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

## Source Assets and Runtime Data

Imported static assets belong under `apps/server/src/data`; runtime SQLite files belong
under `apps/server/data`. Because broad `data/` ignore rules can also hide source assets,
check new source data with `git check-ignore -v <path>`.

Representative paths: `apps/server/src/data/reservationSeeds.ts`,
`apps/server/src/generation/tools/researchTools.ts`, `apps/server/src/db/client.ts`.
