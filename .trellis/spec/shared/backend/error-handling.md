# Error Handling and Validation Boundaries

## Applicability

Fastify error handlers, HTTP status codes, and reply formats are N/A inside `@tripweaver/shared`. They belong to the server application. Shared code should expose contracts and pure operations without importing Fastify request, reply, or application error types.

The separation can be seen in `packages/shared/src/schemas.ts`, `apps/server/src/routes/trips.ts`, and `apps/server/src/index.ts`.

## Contract Boundaries

- Define reusable runtime shapes with TypeBox in `packages/shared/src/schemas.ts`.
- Derive compile-time types with `Static<typeof Schema>` in `packages/shared/src/types.ts`; do not maintain a duplicate interface for the same shape.
- Let the consuming boundary decide how validation failures become HTTP errors, UI errors, or rejected imports.

Fastify route schemas such as those used by `apps/server/src/routes/auth.ts`, `apps/server/src/routes/settings.ts`, and `apps/server/src/routes/trips.ts` can cause Fastify to validate matching request data. Merely importing a schema elsewhere does not run validation.

## JSON and Event Caveats

TypeScript annotations disappear at runtime. `JSON.parse(message) as GenerationEvent` and `response.json() as SomeType` are assertions, not checks. Browser and server consumers must explicitly validate data when it is untrusted or when accepting malformed data would be unsafe. Representative boundaries include `apps/web/src/pages/PlannerPage.tsx`, `apps/web/src/lib/export.ts`, and `apps/server/src/integrations/websearch/searchSource.ts`.

## Shared Utility Failures

Prefer total, deterministic functions for domain calculations. If a shared utility can fail, use a framework-neutral result, standard error, or documented precondition. Do not encode HTTP status codes, Fastify replies, React notifications, or logging side effects in shared utilities.

`computeBudgetSummary` demonstrates a pure calculation over an already typed `Trip` in `packages/shared/src/budget.ts`; it does not claim to validate the trip first.

## Anti-Patterns

- Exporting Fastify-specific error classes from shared.
- Catching errors only to log or translate them into HTTP responses inside shared.
- Assuming a TypeBox object validates every value typed with its `Static` type.
- Replacing boundary validation with `as Trip`, `as GenerationEvent`, or `as unknown as`.
