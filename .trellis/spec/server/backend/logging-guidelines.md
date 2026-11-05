# Logging Guidelines

## Logger

Use the Fastify request/application logger, which is Pino-backed. The composition root sets
`debug` in development and `info` in production. Inside handlers use `request.log`; outside a
request use the Fastify instance logger passed by the caller when available.

Representative paths: `apps/server/src/index.ts`, `apps/server/src/routes/auth.ts`,
`apps/server/src/routes/generations.ts`.

## Levels and Structure

- `debug`: local diagnostic detail that is too noisy for production.
- `info`: normal lifecycle events useful to operators.
- `warn`: handled external or authentication-flow failures that deserve attention.
- `error`: unhandled 5xx failures and detached background promise failures.

Prefer structured bindings followed by a stable message. Do not use `console.log` in runtime
modules. `console.error` is acceptable only before a Fastify logger exists.

## Redaction and Sensitive Data

The current Fastify logger configuration sets only the level; it has no explicit Pino
`redact` list. Safety therefore depends on never putting secrets in log arguments. Do not
log authorization/cookie headers, session tokens or hashes, OAuth material, `MASTER_KEY`,
API keys, BYOK plaintext/ciphertext, passwords/hashes, full environment objects, or full
settings request bodies.

If request serializers or broader object logging are added, configure Pino redaction for
at least `req.headers.authorization`, `req.headers.cookie`, and known secret fields.

Representative paths: `apps/server/src/auth/session.ts`,
`apps/server/src/crypto/secretBox.ts`, `scripts/verify-security.mjs`.

## Useful Context

Log stable IDs and classifications when needed: `userId`, `jobId`, route, provider kind,
status, and an `Error` object. Avoid whole request/response bodies. Expected 4xx outcomes
generally do not need error logs.
