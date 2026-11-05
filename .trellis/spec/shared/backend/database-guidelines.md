# Database Guidelines

## Applicability

Database implementation is N/A inside `@tripweaver/shared`. This package must not import Drizzle, SQLite, migrations, repositories, or database row types. Those concerns belong to `apps/server`.

Relevant separation is visible between shared domain contracts in `packages/shared/src/schemas.ts` and persistence consumers such as `apps/server/src/db/schema.ts` and `apps/server/src/services/tripService.ts`.

## Persisted Contract Changes

Shared schemas can describe values that the server persists, so schema changes still require persistence impact analysis:

- Treat `TripSchema` and `TripExportSchema` as domain and interchange contracts, not as database migration definitions.
- Check existing stored JSON and optional compatibility fields before making a property required or narrowing a value set. Current compatibility examples include optional `overview` and `meta.dataSources` in `packages/shared/src/schemas.ts`, with consumption in `apps/server/src/services/tripService.ts` and `apps/web/src/pages/PlannerPage.tsx`.
- Keep storage-specific summaries and row shapes explicit when they are true cross-consumer protocol types; `TripListItem` is defined in `packages/shared/src/types.ts` and consumed by `apps/server/src/services/tripService.ts` and web API code.

## Runtime Validation Caveat

A TypeBox schema is data until a validator executes it. Reading JSON from a database and asserting `as Trip` does not prove conformance. Validate untrusted, legacy, or externally edited persisted data at the responsible server boundary when correctness depends on it. Fastify can validate route inputs when a schema is registered, but it does not automatically validate arbitrary database reads or `JSON.parse` results.

## Anti-Patterns

- Adding database clients or migration helpers to `packages/shared`.
- Modeling table columns in shared merely to avoid a server-local type.
- Treating schema evolution as automatically backward compatible with stored JSON.
- Using a type assertion to silence a mismatch between persisted data and `TripSchema`.
