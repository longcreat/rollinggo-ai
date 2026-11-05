# Logging Guidelines

## Applicability

Logging infrastructure is N/A inside `@tripweaver/shared`. The package has no request context, logger dependency, or ownership of operational policy. Fastify/Pino rules belong to `apps/server`, and UI telemetry rules belong to `apps/web`.

This boundary is consistent with the side-effect-light modules `packages/shared/src/budget.ts`, `packages/shared/src/constants.ts`, and `packages/shared/src/utils.ts`.

## Shared Package Rule

- Do not import Fastify loggers, Pino, browser analytics, or application configuration.
- Do not call `console.log`, `console.warn`, or `console.error` from shared domain utilities.
- Return values or throw framework-neutral errors and let the consumer add operational context.
- Never place secrets, request bodies, API keys, session data, or user-specific diagnostics in shared constants or sample data.

Server consumers can log around shared calls where request and job context exists, for example in `apps/server/src/services/tripService.ts`, `apps/server/src/generation/orchestrator.ts`, or `apps/server/src/integrations/websearch/searchSource.ts`.

## Anti-Patterns

- Passing a Fastify logger into every shared utility.
- Logging from `computeBudgetSummary` or `uid`.
- Making a shared result depend on whether logging is configured.
- Swallowing an exception after logging it in the package.
