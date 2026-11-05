# Security and Environment Guidelines

## Centralized Environment Contract

All runtime environment parsing and validation belongs in `apps/server/src/env.ts`.
Application modules import the typed `env` object or capability helpers such as
`hasSiteLlm()` and `hasGithubOauth()`; they do not read `process.env` directly.

Required configuration fails during module bootstrap. `MASTER_KEY` must be 32-byte hex;
registration mode combinations and GitHub OAuth dependencies are validated together.
Optional providers become disabled capabilities or Null adapters rather than preventing
startup.

Bootstrap adapters must set environment values explicitly. Verification scripts use spawned
process environments and temporary database paths so local `.env` values cannot silently
change a scenario. The process bootstrap also imports `apps/server/src/lib/proxy.ts` before
outbound fetches and `apps/server/src/db/client.ts` to initialize SQLite.

Representative paths: `apps/server/src/env.ts`, `apps/server/src/index.ts`,
`scripts/verify-auth-modes.mjs`.

## Authentication and Ownership

`requireAuth` validates the session cookie and attaches `{ id, email }` to the Fastify
request. Apply it as a route-group `preHandler` for protected modules, or on an individual
authentication route such as `/logout`. Public probe endpoints such as `GET /api/auth/me` use `resolveUser` instead: a missing session is normal guest state and returns HTTP 200 with `data: null`, not 401 — a 401 there only adds a browser console error.

Authentication is not authorization. Every protected resource lookup and mutation must also
filter by the authenticated `userId`. Return 404 for both missing and non-owned resources.

Representative paths: `apps/server/src/auth/guard.ts`,
`apps/server/src/routes/trips.ts`, `apps/server/src/services/tripService.ts`.

## Public Homepage City List

- Scope: visitors need destination names before authentication.
- Signature: `GET /api/destinations/covered` returns the existing `CoveredCitiesView` envelope without `requireAuth`.
- Contract: only verified coverage city names are public; no user identity, preferences, itinerary or generation details are returned. No request body or new environment settings.
- Errors: empty coverage returns `{ cities: [] }`; service failures keep the normal API error envelope. They must not be converted into authentication failures.
- Cases: anonymous/registered users receive the same city names; personal trips, settings, usage and generation endpoints still reject anonymous requests with 401.
- Verification: request the city endpoint without cookies and assert 200; request protected endpoints without cookies and assert 401; exercise guest homepage with `apps/web/tests/login-dialog-browser.mjs`.
- Wrong: remove authentication from all route groups to enable the homepage. Correct: expose only the read-only city-name endpoint.

## Sessions and Cookies

- Generate random 256-bit session tokens.
- Store only SHA-256 token hashes in SQLite.
- Use a 30-day expiry with renewal when less than 15 days remain.
- Set cookies `HttpOnly`, `SameSite=Lax`, `path=/`, and `Secure` in production.
- Destroy the server-side session on logout and clear the cookie.

Representative paths: `apps/server/src/auth/session.ts`,
`apps/server/src/routes/auth.ts`, `scripts/verify-security.mjs`.

## GitHub OAuth

- Enable OAuth only when client ID, client secret, and application base URL are all valid.
- Generate a cryptographically random state, store it in a short-lived HttpOnly cookie,
  require both values to exist, compare them, and clear the cookie on callback.
- Request only `user:email`; link accounts only with GitHub's stable numeric ID or a
  primary verified email.
- Use the access token only to retrieve identity and never persist it.
- Rate-limit entry and callback routes and return stable redirect error codes.

Representative paths: `apps/server/src/auth/github.ts`,
`apps/server/src/routes/auth.ts`, `scripts/verify-auth-modes.mjs`.

## Secret Encryption

BYOK API keys are encrypted with AES-256-GCM using `MASTER_KEY`. Store the IV, ciphertext,
and authentication tag; return only the last four characters in settings views. Never log
plaintext, ciphertext, or master-key material. Passwords use the dedicated bcrypt helpers,
not the secret-box format.

Representative paths: `apps/server/src/crypto/secretBox.ts`,
`apps/server/src/services/settingsService.ts`, `apps/server/src/auth/password.ts`.

## SSRF Defense

User-supplied LLM base URLs must pass `assertSafeBaseUrl` when saved and again immediately
before use to reduce DNS-rebinding risk. Allow only HTTP(S), resolve hostnames, reject loopback,
private, link-local, CGNAT, localhost-style names, and IPv4-mapped private addresses. The
operator-controlled `SSRF_ALLOWLIST` is the only bypass and accepts exact host or hostname
entries.

Representative paths: `apps/server/src/integrations/ssrfGuard.ts`,
`apps/server/src/services/settingsService.ts`, `apps/server/src/generation/model.ts`.
