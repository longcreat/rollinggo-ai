# Quality and Verification Guidelines

## Required Patterns

- Use `FastifyPluginAsyncTypebox` and TypeBox schemas for changed request inputs.
- Reuse shared schemas/types for cross-package API contracts.
- Use `requireAuth`, then scope resource lookups and mutations by `request.user!.id`.
- Keep HTTP concerns in routes and reusable application/database work in services, except
  for the documented authentication route exception.
- Keep `db/schema.ts` and `db/migrate.ts` synchronized.
- Give outbound requests appropriate timeout, security, cache, rate, limit, degradation,
  and accounting behavior.

## Forbidden Patterns

- Unvalidated request input casts in new code.
- User-owned resource queries without a `userId` predicate.
- Logging secrets or returning them in API responses.
- Updating only Drizzle schema or only startup migration SQL.
- Outbound `fetch` without an explicit timeout or abort signal.
- Throwing optional research-source failures into generation.
- Calling source call-attempt counters confirmed network-call counters.
- Assuming in-memory jobs, caches, or queues coordinate across replicas.
- Seeding env for isolated scripts with `||=` after loading `.env` (dotenv wins and the
  fallback silently never applies — assign unconditionally).

## Command Matrix

There is no standalone server `typecheck`, `test`, or `lint` script in
`apps/server/package.json`. Use repository-root commands and targeted scripts.

| Change area | Command | Notes |
| --- | --- | --- |
| Any TypeScript contract/server change | `npm run typecheck` | Checks shared, server, and web. |
| Generation logic, prompts, geocoding, and feasibility | `node --import tsx --test apps/server/src/__tests__/*.test.ts` | Includes isolated mock-provider and draft-revision regressions. Requires `MASTER_KEY` (see below). |
| RAG retrieval / place identity SQL, aliases, vector fallback | `node --import tsx scripts/verify-sql-first.mts [--flow\|--full]` | Disposable PostgreSQL; `--flow` adds chat/geo/scheduling/export suites. `--full` excludes `independentPhotoIdentity.test.ts` — it asserts its own `place_identity_test_<ts>` DB contract and runs via `node --import tsx scripts/verify-place-identity.mts`. |
| Web production bundle/static serving | `npm run build` | Builds `apps/web/dist`. |
| Authentication modes/OAuth bootstrap | `node scripts/verify-auth-modes.mjs` | Isolated server scenarios. |
| Ownership, cookies, SSRF, secrets | `node scripts/verify-security.mjs` | Dev and production instances. |
| Generation API, migration, SSE, quota, BYOK | `node scripts/verify-c2.mjs` | Mock LLM and dedicated PostgreSQL test database. |
| Generation failure/transaction/terminal SSE boundaries | `node --import tsx scripts/verify-generation-flow.mts` | Dedicated PostgreSQL database; mock LLM, SQL fault injection and lock-controlled cancellation. |
| Current production generation browser flow | `node scripts/verify-generation-browser.mjs` | Build first; current homepage, editor, refresh, cancellation/retry; random PostgreSQL test database. |
| Native SSE reconnect and hook recovery | `node apps/web/tests/generation-recovery-browser.mjs` | Vite at 18811; native EventSource against local fixture at 18810. |
| Core browser trip flow | `node scripts/verify-m1.mjs` | Expects a suitable app at `BASE`. |
| Export/import production flow | `node scripts/verify-d1.mjs` | Requires `npm run build` first. |
| Golden-set eval (offline snapshot replay) | `npm run eval` | Deterministic checks; gate = zero hard violations. |
| Golden-set eval (live generation) | `npm run eval:live` | Explicit local `EVAL_PG_ADMIN_URL` + `SITE_LLM_*`; isolated DB, writes new `eval/runs/<id>/`. |
| Eval harness/checker tests | `npm run eval:test` | Offline failure/status/baseline/comparison regressions; no credentials. |
| Current supported product journey | `EVAL_PG_ADMIN_URL=... npm run eval:flow` | Owned PG databases + mocks; current input/research/schedule/geo/persistence, preferences, routes/weather, homepage/recovery and detail/history browsers. Individual logs; all stages required for complete PASS. |
| Eval live isolation and collection | `npm run eval:verify` | Explicit local `EVAL_PG_ADMIN_URL`; mock model/geography, checks collection and DB cleanup. |
| Frozen knowledge export/import | `npm run eval:knowledge:verify -- --self-test` | Explicit local `EVAL_PG_ADMIN_URL`; synthetic source, privacy/filtering/roundtrip/vector guards and cleanup. |
| Prepared frozen knowledge | `npm run eval:knowledge:verify -- --snapshot <dir>` | Imports into disposable DB; checks row hashes, city retrieval and vectors without model/map calls. |
| Docker release artifact | `cp .env.example .env && docker compose config && docker compose build app` | CI/build host only; validates configuration and image build without starting services or using real credentials. |

Run the smallest relevant script. Do not run credential-bearing real-provider checks without
explicit approval. Verification scripts should inject environment values rather than depend
on `apps/server/.env`.

**Unit-test prerequisite**: `apps/server/src/env.ts` validates `MASTER_KEY` at import time, so
any suite that transitively imports it (e.g. `placeLookup.test.ts`) aborts the whole run with
`[env] MASTER_KEY 缺失或格式错误` when the variable is absent. Set it to any 32-byte hex value
before running the suite — the value is never used by these tests, it only has to parse:

```bash
MASTER_KEY=$(printf 'a%.0s' {1..64}) node --import tsx --test apps/server/src/__tests__/*.test.ts
```

Without it the suite reports one "failing test" that is an environment problem, not a code
regression — check for this before investigating a failure in that file.

Database-backed suites also need `DATABASE_URL` pointing at a dedicated, disposable test database.
Run the full server suite with `--test-concurrency=1` because its startup migrations share that
database. Never aim it at application data. The new generation verification scripts default to
local PostgreSQL port 18797; override `VERIFY_GENERATION_ADMIN_URL` to use another test server.
`verify-c3.mjs` still targets the removed city-card/form UI; its broader legacy assertions are not
current acceptance evidence. Use the current generation browser script for this workflow.

## Review Checklist

- Shared contract and route schema agree.
- Status codes and error shapes preserve client behavior.
- Authentication and ownership are both present.
- Database upgrade behavior works for existing files, not only fresh databases.
- Secrets do not appear in responses, logs, fixtures, or database plaintext.
- Background work reaches one terminal status and cancellation remains authoritative.
- Relevant validation completed, or blockers are recorded.

## Scenario: Docker Compose Release Validation

### 1. Scope / Trigger

- Trigger when `Dockerfile`, `docker-compose.yml`, build scripts, workspace manifests, or production environment wiring changes.

### 2. Signatures

- Configuration check: `docker compose config`
- Image build: `docker compose build app`

### 3. Contracts

- Copy `.env.example` to a temporary `.env` on the CI runner before Compose validation.
- The validation must build the `app` service from the repository `Dockerfile`.
- Validation must not require production secrets, start services, publish images, or mutate persistent data.

### 4. Validation & Error Matrix

- Invalid Compose interpolation or service configuration -> `docker compose config` exits non-zero.
- Dockerfile, lockfile, workspace, type-check, or bundle failure -> `docker compose build app` exits non-zero.
- Missing optional provider credentials -> configuration and image build still succeed; runtime provider calls are out of scope.

### 5. Good/Base/Bad Cases

- Good: CI runs type-check/build, validates Compose, and builds `app` from a clean checkout.
- Base: `.env.example` contains empty optional credentials and the image still builds.
- Bad: CI starts Caddy/app, uses a developer `.env`, or treats a locally cached image as proof of reproducibility.

### 6. Tests Required

- Assert the workflow retains `npm ci`, `npm run typecheck`, and `npm run build`.
- Assert `docker compose config` passes from a clean checkout with `.env.example` copied to `.env`.
- Assert `docker compose build app` completes on the GitHub Actions runner.

### 7. Wrong vs Correct

#### Wrong

```yaml
- run: docker compose up -d
```

This introduces runtime ports, certificates, state, and secret requirements into a build gate.

#### Correct

```yaml
- run: cp .env.example .env && docker compose config
- run: docker compose build app
```
