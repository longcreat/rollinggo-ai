# Error Handling

## Global HTTP Boundary

`apps/server/src/index.ts` calls `installApiResponses` from `http/apiResponse.ts` before
registering routes. It maps `SsrfError` and validation failures to 400, honors an error's
`statusCode`, logs 5xx failures, and hides internal details behind a generic response.
Do not expose stack traces, SQL details, validation internals, provider responses, tokens, or secrets.

All `/api` JSON responses use `{ code, message, data }`. Success has code 0 and preserves
HTTP 200/201/202. Errors preserve HTTP status, use an existing business code (or HTTP status),
and put extra fields such as `resetAt` / `jobId` in `data` (null when absent). The `onSend`
boundary wraps serialized JSON **after** the route's business response schema filters fields.
Routes keep their business response schemas and raw return values; do not wrap twice.
SSE frames, redirects, static assets and no-content responses retain their protocols.
Independent Fastify test fixtures must install the same boundary. See `docs/API_CONTRACT.md`.

## Route Boundary

Routes handle expected HTTP outcomes directly: 401 authentication failures, 403 policy
denials, 404 missing/non-owned resources, 409 conflicts, 429 quotas, redirects, and cookie
changes. Use the same 404 response for missing and non-owned resources.

Reserve 401 for endpoints that require authentication. A public probe whose "not signed in"
answer is normal returns HTTP 200 with `data: null` instead — see `GET /api/auth/me` and
`resolveUser` in `apps/server/src/auth/guard.ts`. Browsers log every 401 response to the
console, so a 401 here only produces noise the frontend cannot suppress.

Representative paths: `apps/server/src/routes/auth.ts`,
`apps/server/src/routes/trips.ts`, `apps/server/src/routes/generations.ts`.

## Service and Workflow Boundary

Services return `null`/`false` for expected absence and may throw an `Error` with a
`statusCode` for reusable domain rejection. The generation orchestrator owns job failure
conversion and records/emits `done`, `error`, or `cancelled`.

Representative paths: `apps/server/src/services/tripService.ts`,
`apps/server/src/services/settingsService.ts`, `apps/server/src/generation/orchestrator.ts`.

## External Integration Failures

Optional research sources are degradation boundaries. Normal network, provider, and parse
failures return an empty result rather than aborting generation. Missing keys and exhausted
site budgets select Null adapters. `selfCheck()` reports a structured unhealthy status.

Do not extend this tolerance to database corruption, programming errors, or invariant
failures. Current call statistics count accepted non-Null wrapper attempts, including cache
hits and attempts that later degrade; they are not confirmed successful network requests.

Representative paths: `apps/server/src/integrations/amap/poiSource.ts`,
`apps/server/src/integrations/websearch/searchSource.ts`,
`apps/server/src/integrations/sourceStatus.ts`.

## Error Classes

Use a named error class when callers need reliable classification or a stable code, such as
`SsrfError` and `GithubOauthError`. Use a local workflow error such as `GenerationFailure`
when the type should not escape its module. Avoid large generic error hierarchies.

Representative paths: `apps/server/src/integrations/ssrfGuard.ts`,
`apps/server/src/auth/github.ts`, `apps/server/src/generation/orchestrator.ts`.

## Common Mistakes

- Letting an optional provider exception become `job_error` instead of degrading.
- Catching all errors around persistence or invariants and returning success.
- Returning another user's resource as 403 and confirming its existence.
- Sending raw provider or validation internals to clients.
- Calling metered `selfCheck()` on every request; `apps/server/src/routes/settings.ts`
  uses a 60-second promise memo.

## Scenario: Per-user encrypted external-source credentials

### 1. Scope / Trigger

Use this contract when an authenticated user can save a credential for an optional external
research source. The current implementation is the personal Amap Web Service Key configured
through Settings. It must remain isolated from site credentials, other users, logs, and global
source instances.

### 2. Signatures

- `PUT /api/settings` accepts optional `amapApiKey` and `clearAmapApiKey` fields through
  `SettingsPutSchema`.
- `GET /api/settings` and successful `PUT /api/settings` responses expose only personal-key
  presence, the saved last four characters, and whether a site fallback exists.
- `resolveAmapCredential(userId)` selects the current credential for a status probe or a new
  generation task.
- `user_settings` stores encrypted credential text, a last-four display value, and a revision
  used to invalidate credential-dependent status results.

### 3. Contracts

- A non-empty `amapApiKey` replaces the current user's personal key and is encrypted with
  `MASTER_KEY` before persistence.
- Omitting `amapApiKey`, or sending it as an empty string, preserves the existing key.
- `clearAmapApiKey: true` explicitly removes the personal key; saving and clearing in one
  request is rejected.
- Resolution order is personal key, then site `AMAP_KEY`, then `NullPoiSource` degradation.
- Personal credentials are an **Amap-only** track, and they apply only to the **route planning +
  geocoding** chain (`resolveGeoProvider`). POI search is always site-level Tianditu
  (`resolvePoiSourceForUser`), so a saved personal Amap key can never leak into it — and losing that
  key does not disable search. `resolveGeoProvider` is the single place applying the rule.
- Personal credentials must not be stored in module-level source singletons, status cache
  values, query keys, response payloads, or logs.
- Status memoization must include both user identity and credential revision. A settings update
  or clear must not reuse a result produced with an older credential.

### 4. Validation & Error Matrix

- `amapApiKey` and `clearAmapApiKey` both request a change -> HTTP 400 with a stable,
  non-secret explanation.
- Request exceeds the shared TypeBox limits or has an invalid field type -> Fastify validation
  error mapped to HTTP 400.
- Ciphertext cannot be decrypted -> treat as a server invariant failure; do not return the
  ciphertext, key, provider request, or stack trace.
- Amap rejects the selected key or the network probe fails -> return an unhealthy
  `SourceStatus`; generation continues through the existing optional-source degradation path.
- No personal key and no site key -> return an unconfigured status and use `NullPoiSource`.

### 5. Good / Base / Bad Cases

- Good: user saves a personal key, the response returns only its tail, the next self-check and
  generation resolve that key immediately, and another user continues using their own or the
  site credential.
- Base: user never saves a personal key; the server uses `AMAP_KEY` when present and otherwise
  degrades without failing generation.
- Bad: a global `AmapPoiSource` is replaced with one user's key or a global 60-second status
  cache is reused across users. This leaks credential behavior and creates cross-user coupling.

### 6. Tests Required

- Migration test: start with a legacy `user_settings` table, run migrations twice, and assert
  the encrypted Amap fields and revision exist without changing existing LLM settings.
- API test: save, update, preserve-on-empty, and explicitly clear a personal key; assert every
  response and captured log excludes plaintext and ciphertext.
- Isolation test: configure two users differently and assert source construction and status
  results never cross user boundaries.
- Priority test: assert personal key -> site `AMAP_KEY` -> Null resolution order.
- Cache test: update or clear the key inside the status TTL and assert the next probe uses the
  new credential revision.
- Browser test: verify password input, masked tail, save pending state, clear confirmation, and
  source-status refresh.

### 7. Wrong vs Correct

#### Wrong

```ts
let amapSource = env.amapKey ? new AmapPoiSource(env.amapKey) : nullSource;

function applyUserKey(apiKey: string) {
  amapSource = new AmapPoiSource(apiKey);
}
```

This makes one user's secret a process-wide credential and can affect every subsequent request.

#### Correct

```ts
function getPoiSourceForUser(userId: string): PoiSource {
  const credential = resolveAmapCredential(userId);
  return credential ? new AmapPoiSource(credential.apiKey) : getNullPoiSource();
}
```

Resolve credentials at the authenticated request or job boundary and keep the resulting source
scoped to that probe or generation task.
