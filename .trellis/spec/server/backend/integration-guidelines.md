# External Integration Guidelines

> 2026-11-05：图片链路已收敛为「只用高德 POI 图片」。Pexels / Pixabay / Unsplash / Wikimedia 适配器、
> 人工选片、视觉审核队列、photoStore 与 Openverse 采集脚本均已删除。取图顺序与配额见下方
> [Attraction Cover Sources](#attraction-cover-sources-amap-poi-photos-only-2026-11-05)，
> 选片/署名口径见 [preference-photo-pipeline](./preference-photo-pipeline.md)。
> 重新接入外部图库必须先改本节，否则 `amapOnlyImages.test.ts` 会失败。

## Scenario: Amap POI 2.0 business fields (v5, 2026-11-05)

- **v5 的商业信息字段组叫 `business`，不是 `biz_ext`。** `biz_ext` 是 v3（`extensions=all`）的字段名；
  `v5/place/text` 收到 `show_fields=biz_ext` 会**静默忽略**，pois 里既没有 `biz_ext` 也没有 `business`
  （实测 2026-11-05，infocode=10000，status=1，看起来一切正常）。因此字段「缺失」时先看
  `show_fields`，不要先怀疑账号权限。
- **个人认证 Key 同样能拿到 `rating` / `cost` / `opentime_week` / `tel` / `alias` / `keytag` / `rectag`。**
  高德文档没有对这些字段设认证门槛；实测同一把个人 Key 对故宫返回 `rating=4.9`、`tel=4009501925`、
  完整旺季/淡季/周一闭馆说明，对餐厅返回 `cost=133.00`。历史的「个人认证不返回」注释是错的，已改正。
- `rating` / `cost` **只有餐饮、酒店、景点、影院类 POI 返回**（文档明示）；其他类目空串是正常结果，
  不是解析失败。`tag`（特色菜）目前只在美食 POI 返回。
- 营业时间按 `opentime_week` → `opentime_today` → v3 `open_time` 依次回退，保留原始文本不做格式化——
  景区的一条 `opentime_week` 可能包含旺季/淡季/停止检票/节假日说明，压成 `08:30-17:00` 会丢信息。
- 图片 URL 高德 http/https 混用：适配器统一改写为 https 并去重（页面是 https，非安全 URL 会被
  mixed content 拦掉）。`photos[].url` 里有 `aos-comment.amap.com` 的点评图，仍是高德域、可热链。
- **CUQPS：个人 Key 每秒并发有限。** 实测 1 秒内第 6 次 `place/text` 返回
  `status=0 / infocode=10021 / CUQPS_HAS_EXCEEDED_THE_LIMIT`。两条纪律：(1) 所有 Web 服务调用
  （place/geocode/route/图片）共用 `geocoder.ts` 的 350ms 串行队列，**不要给某个适配器单独开更快的队列**；
  (2) `amapRequest` 对 10021 退避 800ms 重试一次并重新预扣配额（账实一致），其他 infocode 直接抛出。
- 生成侧消费：`search_pois` 把 `评分/人均/营业/电话` 一并写进工具结果，`openTimeByName` 仍按同名回填
  活动 `openTime`；`人均` 用 `¥133` 形式（去掉高德返回的 `.00` 尾零）。Agent 的 `search_places`
  输出 `rating/cost/tel`，让「人均多少、要不要预约、电话多少」可以直接答。
- Tests: `amapPoiSource.test.ts`（business 解析、opentime 回退、http→https 去重、请求参数断言、
  10021 重试一次且二次失败抛出）、`amapRequest.test.ts`（额度、日志脱敏、跨天预扣）、
  `agentToolPayloads.test.ts`（人均/电话传给模型）。

## Scenario: AI trip sharing images

### 1. Scope / Trigger

Explicit generation from the itinerary export dialog; never prefetch paid images.

### 2. Signatures

- `POST /api/trips/:id/share-image`, `TripShareImageRequestSchema {trip}` → `TripShareImageResponseSchema {url,mimeType}`; `GET /api/trips/:id/share-image?style=` returns the stored poster for the current trip content or 404.
- `generateShareImage(providers, prompt)` handles OpenAI Images-compatible transport for an ordered relay list and returns image bytes; `createTripShareImageService(store, generate?)` owns admission (in-flight coalescing plus per-user/global limits) and delegates persistence to `SharePosterStore`: `services/sharePosterStore.ts` writes `data/media/share-posters/<sha256-of-bytes>.<ext>` and upserts `trip_share_images` keyed by `(trip_id, style)`; `buildTripSharePrompt(trip, style)` is the only prompt builder and splits a shared skeleton from a per-style sentence.
- `buildTripSharePrompt(trip)` is a pure server-owned prompt builder.

### 3. Contracts

- `IMAGE_API_BASE_URL=https://xjbh.lol/v1`, `IMAGE_MODEL=gpt-image2.5`, independent `IMAGE_API_KEY`; names are user-specified third-party identifiers, not silently normalized to official model names. Up to three relays are declared flat: station 1 uses the bare names, stations 2/3 append `_2` / `_3`. `readImageProviders` (in `env.ts`, not `integrations/` — `ssrfGuard` imports `env`, so the parser there would create an import cycle) stops at the first missing `IMAGE_API_BASE_URL_n`, skips stations without a key, inherits `IMAGE_MODEL` when `IMAGE_MODEL_n` is empty, and warns once about over-limit suffixes.
- POST `/images/generations` with model/prompt/n=1/size=1024x1536. Accept base64 or safe HTTPS image URL, do not follow redirects or forward API authorization to image URLs. Reuse SSRF validation.
- Prompt includes only destination, title and up to six non-lodging activity names per day. Exclude private notes, dates, coordinates, lodging, descriptions and links; distinguish itinerary data from instructions. Two styles share one skeleton and differ only in the style sentence: `journal` (travel-journal illustration) and `ink` (Chinese ink wash). `TripShareImageRequestSchema.style` is optional and defaults to `journal`, so older clients keep their behaviour; the style is part of the storage key `(trip_id, style)`, and the request style travels to the provider unchanged.
- Authenticate and check trip ownership before provider work; snapshot ID must match route. Draft snapshots are allowed to avoid autosave races. Request body ≤1 MiB, upstream JSON ≤15 MiB, decoded PNG/JPEG/WebP ≤10 MiB, whole-chain budget180s shared across relays (each attempt gets the remaining time).
- `TripShareImageRequestSchema.regenerate?: boolean` defaults to false and is forwarded to `service.generate(userId, trip, style, regenerate)`. Only explicit regeneration bypasses an already stored poster; success replaces it and failure retains the previous one. Look up the identical pending job before the store so regeneration and ordinary requests coalesce. Reopening the dialog uses `GET /api/trips/:id/share-image?style=` (`service.find`); it returns 404 when nothing is stored or when the trip content no longer matches the stored prompt hash, so a changed itinerary never replays an outdated poster. Do not bypass ownership, schema validation, per-user/process concurrency or HTTP rate limits.
- Stored posters live in `data/media/share-posters` (indexed by `trip_share_images`, primary key `trip_id + style`, so one poster per trip and style and the replaced file is deleted). A stored poster with a matching prompt hash is returned without calling the model and survives restarts, which is why no in-process result cache remains. Pending identical requests still coalesce; one active job/user and two/process. Docker mounts `data/media` read-only, so `data/media/share-posters` needs its own writable mount. No retry against the SAME relay (avoids duplicate billing), but a retryable failure falls through to the next configured relay in order: network error, timeout, HTTP5xx, 429, 401/403, missing/unparsable image, oversized image, unsafe returned URL. HTTP4xx other than 401/403/429 and an invalid local `baseUrl` (SSRF allowlist, credentials, query) fail immediately — they are request-side errors. Only the last real error surfaces; no monthly accounting, durable jobs or multi-instance locking implied.

### 4. Validation & Error Matrix

- 401 unauthenticated; 404 missing/non-owned; 400 invalid schema or mismatched ID; 429 busy; 503 missing key; sanitized502 upstream/format/size/timeout errors.
- Check image magic bytes before storing bytes. Never send upstream bodies, keys, prompt, returned URLs or raw fetch exceptions to logs/errors.
- Invalid `regenerate` values fail request validation with 400. An explicit regeneration error leaves the previous downloadable result intact; the frontend displays the error and offers retry.

### 5. Good/Base/Bad Cases

- Good: explicit generate uses given model, authenticates owner, reuses cached image on reopen.
- Good: explicit regenerate creates fresh artwork while reopen and style selection never trigger paid calls. Bad: a button labelled “重新生成” unconditionally reads the old completed cache.
- Base: missing key produces a recoverable503 and no upstream call.
- Bad: use site LLM credentials automatically, fetch provider URL with authorization, or create a paid image on opening the menu.

### 6. Tests Required

- `tripShareImage.test.ts`: prompt exclusions/order, style sentence swap with an unchanged skeleton, style in the cache key, exact protocol, base64/URL parsing, safe failures, concurrency/cache and retry lock cleanup, relay-list parsing (indexed suffixes, non-contiguous stop, missing key, overflow warn), fallback order, no-fallback on HTTP4xx, last-error surfacing.
- `generate-share-style-samples.mts`: real paid generation of the two `apps/web/public/share-styles/*.png` thumbnails; manual only, never in CI.
- `verify-trip-share-image.mts`: real ownership/session/API validation against disposable PG with mocked upstream.
- `trip-share-image-browser.mjs`: explicit start, loading, close/reopen, retry, preview, download, mobile bounds.
- Regeneration regression: service test covers bypass/replacement, pending coalescing and failed-refresh cache retention; `verify-trip-share-image.mts` checks the HTTP flag reaches the provider and invalid flag values fail validation; browser tests assert true only for explicit regeneration/retry and preserve the old image on failure.

### 7. Wrong vs Correct

- Wrong: render screenshots with html-to-image or directly call provider from browser with its secret.
- Correct: authenticated server image endpoint with minimized prompt, sanitized raster data response and shared UI preview.

## Scenario: Amap service admission and monthly-derived defaults

### 1. Scope / Trigger

Every server-side Amap external call, including generation, editor routes and POI photos.

### 2. Signatures

- `amapRequest(service: AmapService, params: URLSearchParams, timeout?: number)` is the only Amap fetch boundary.
- `createAmapQuotaLedger(pool, limits, now?).acquire(service)` returns `{allowed,service,day,used,limit,resetAt}`.
- `amap_service_usage(day TEXT, service TEXT, calls INTEGER CHECK(calls >= 0))`, primary key `(day,service)`.
- `readAmapServiceBudgets(source)` validates configuration without importing DB/env.

### 3. Contracts

- Services: geocode, place, walk, cycle, drive, transit; POI lookup and photos share place.
- Official personal defaults from https://lbs.amap.com/upgrade (2026-09-29): LBS shares 150000/month; search 5000/month. Divide by 31, then split LBS equally into five: 967 each, place 161. These are system budgets, not fetched account balances.
- `AMAP_LBS_MONTHLY_BUDGET` and `AMAP_SEARCH_MONTHLY_BUDGET` may override totals. `AMAP_<SERVICE>_DAILY_BUDGET` overrides individual caps; LBS sum and search cap cannot exceed their monthly total / 31. Legacy `AMAP_DAILY_BUDGET` only lowers unset service defaults.
- Atomic INSERT/ON CONFLICT increments before fetch; failed attempts stay charged. All keys share counters conservatively. UTC+8 midnight resets the day, independent of host timezone. Recheck the day after reservation before fetch.
- Cache hits bypass admission; task caps and serial queue still apply. `remaining()` is advisory, never a combined admission gate.
- First migration seeds each service with recent legacy aggregate usage, conservatively including the previous day; subsequent migrations never reseed. Old task counts remain telemetry only.
- No account balance lookup, historical monthly subtraction, or cross-process QPS limiter is implied. See `docs/AMAP_QUOTAS.md` for quota scope and rollout caveats.

### 4. Validation & Error Matrix

- Zero disables a service; non-integer, negative, out-of-range or overallocated group budgets fail startup.
- Exhaustion → `local_budget_exhausted`, no fetch. DB outage → `budget_store_error`, no fetch.
- Upstream failures remain charged and emit categorized diagnostics; adapters degrade to null/unavailable.
- Log `[amap-call]` with service, outcome, used/limit and sanitized infocode/info; never key, raw URL, address or coordinates.

### 5. Good/Base/Bad Cases

- Good: 50 concurrent attempts against limit 5 admit exactly 5; exhausted walk leaves drive available.
- Base: default five LBS caps × 31 ≤ 150000; place cap × 31 ≤ 5000.
- Bad: assign 150000/month separately to each LBS endpoint, or debit only when a generation completes.

### 6. Tests Required

- `amapRequest.test.ts`: configuration/group limits, UTC+8 boundary, zero fetch on denial/DB failure, service routing, failed-attempt charge, log redaction, midnight reacquisition.
- Adapter suites mock `amapQuotaGate` explicitly to avoid DB imports.
- `scripts/verify-route-options.mts`: real PostgreSQL concurrency, restart, independent/zero limits, midnight, first legacy seed and migration idempotency; mocked upstream only.

### 7. Wrong vs Correct

- Wrong: `fetch('https://restapi.amap.com/...')` directly from an adapter, or use a generation aggregate to authorize requests.
- Correct: successful cache lookup first, then shared queue → `amapRequest(service, params)` → atomic durable admission → fetch.

## Scenario: Editor Route Options

### 1. Scope / Trigger

Editing one adjacent activity pair's transport mode, independently of generation jobs.

### 2. Signatures

- `POST /api/trips/:id/route-options`: `RouteOptionsRequestSchema` → `RouteOptionsResponseSchema`.
- `editor_geo_usage(day TEXT, source TEXT, calls INTEGER)`, composite primary key `(day, source)`; schema and startup migration must match.
- `reserveEditorGeoBudget('tianditu', count)` returns an async finalizer or null; Amap uses the service ledger below.

### 3. Contracts

- Authenticate and check trip ownership before external work. Inputs are two validated draft activity snapshots and destination, allowing unsaved edits; querying never saves the trip.
- Reuse `resolveGeoProvider`; optional `mode` requests a single available/unavailable entry; omitting it returns all four. Never substitute heuristic estimates in selectable options. `refresh: true` bypasses the editor result cache for explicit retries.
- Convert legacy WGS84 inputs to GCJ02. Amap transit resolves endpoint adcodes, then calls routing. Missing city or provider result is unavailable with retry text.
- One active cache-miss request per user; route rate limit is 60/minute to support per-mode prefetch. Task attempt cap includes missing modes plus four possible Amap geocode attempts; only Tianditu uses the editor reservation/finalizer.
- Cache each result by user ID, provider kind, credential revision, destination, endpoint identities and coordinates/system. Available results live five minutes, unavailable results 30 seconds, bounded to 1200 entries. Result-cache hits consume no quota; Amap lower adapter cache hits also consume no daily quota. Credential revision is metadata, never key material.
- Amap route adapter successful cache TTL is five minutes (formerly 24 hours). Driving explicitly uses `strategy=32` (Amap recommended); transit keeps default `0`; adopt the first provider-ranked result. Official reference: `https://lbs.amap.com/api/webservice/guide/api/newroute`.
- Amap uses durable service counters for all paths; Tianditu retains editor reservations plus approximate generation usage.
- Amap transit geometry joins walking steps and the first bus alternative in segment order; absent geometry remains absent. Do not invent durations when provider duration is missing.

### 4. Validation & Error Matrix

- Missing session → 401; missing or other owner's trip → identical 404; invalid coordinate input → 400.
- Busy user or insufficient Tianditu budget → 429; exhausted Amap service budget → unavailable option without an outbound request.
- No credential, unsupported mode, missing coordinates/city or failed route → unavailable option; other options survive.
- Amap admission DB failure logs `budget_store_error`, blocks fetch and degrades that option; route ownership/persistence DB errors remain API errors.

### 5. Good/Base/Bad Cases

- Good: one route becomes drive with its real duration and polyline; other pairs remain untouched.
- Base: Tianditu supports drive/transit while walk/cycle are unavailable.
- Bad: inserting editor calls as fake generations, silently exhausting budget, or labeling a heuristic as Amap.

### 6. Tests Required

- `routeOptions.test.ts`: partial failure, source labels, missing coordinates/city, WGS84 and unsupported modes.
- `amapRoute.test.ts`: transit geometry and missing-duration rejection.
- `node --import tsx scripts/verify-route-options.mts`: dedicated PostgreSQL port 18797, disposable DB; asserts migrations, ownership, validation, service quota atomicity, persistence, free cache hits, credential/coordinate invalidation and TTL expiry. Upstream fetch is mocked.

### 7. Wrong vs Correct

- Wrong: check remaining budget then independently issue uncounted editor queries.
- Correct: atomically reserve, increment accepted attempts through the provider callback, refund the unused reservation in `finally`.

## Adapter Shape and Null Implementations

Optional research providers expose narrow interfaces with a `kind` discriminator, a normal
operation, and `selfCheck()`. Each provider has a Null implementation that returns empty
results and a structured disabled status. Missing optional keys must not prevent server
startup or generation.

Factory functions return a stable site-level provider or its Null equivalent. The
orchestrator can also force a Null provider when the site's remaining daily budget is below
the per-task reservation.

Representative paths: `apps/server/src/integrations/amap/poiSource.ts`,
`apps/server/src/integrations/websearch/searchSource.ts`,
`apps/server/src/generation/orchestrator.ts`.

## Timeouts, Queueing, and Cache

- Every provider `fetch` has an explicit timeout. Current Amap requests use 10 seconds and
  web search uses 15 seconds.
- Metered/rate-limited providers use `createSerialQueue` for one-at-a-time calls with a
  minimum interval. A failure must not poison the queue tail.
- Repeated searches use bounded in-memory `TtlCache` instances. Current research source
  caches retain up to 300 keys for 24 hours.
- Cache and queue state are process-local; they do not coordinate across replicas and are
  cleared on restart.
- Metered health checks are memoized at the route boundary for 60 seconds.

Representative paths: `apps/server/src/lib/serialQueue.ts`,
`apps/server/src/lib/ttlCache.ts`, `apps/server/src/routes/settings.ts`.

## Per-Task and Site Limits

Task wrappers cap one generation at `AMAP_MAX_PER_TASK` (8) and
`SEARCH_MAX_PER_TASK` (10). Null providers do not increment task statistics. Once the cap is
reached, the wrapper returns an empty result and does not invoke the provider.

Site budgets come from centralized environment configuration. Amap uses the durable
per-service admission ledger below; `generations.amap_calls` is task attempt telemetry only.
Search and Tianditu retain their 60-second aggregate cache and running-job approximation.
Tianditu checks geocode + route task caps before enabling its pipeline. Amap never disables
the whole pipeline based on aggregate remaining budget: each service decides before fetch.

Representative paths: `apps/server/src/services/quotaService.ts`,
`apps/server/src/generation/orchestrator.ts`, `apps/server/src/generation/geoPipeline.ts`,
`apps/server/src/db/schema.ts`.

## Tiered Estimators with Truthful Source Labeling

When real provider data has a cheaper deterministic fallback (route duration → haversine
heuristic; amap geocode → Nominatim+conversion), model the tiers explicitly and label every
persisted value with its origin (`source: 'amap' | 'heuristic'`, `coordSource`,
`coordSystem`). Consumers (feasibility checks, UI, evals) must be able to see the confidence
level; never present heuristic values as provider data. Degrade silently tier-by-tier — the
generation workflow must never fail because a tier is unavailable.

The heuristic speed model itself is a piecewise contract (`LEG_SPEED_MODEL` in
`packages/shared/src/constants.ts`, consumed by `estimateTransit` in `legs.ts`): distances at
or below the 20km breakpoint use urban speeds (transit 20km/h, drive 30km/h — byte-identical
to the pre-07-18 formula), the excess uses long-haul speeds (transit 45km/h, drive 70km/h,
modeling suburban rail/expressway). Walk never splits. The function must stay continuous and
monotonic across the breakpoint (unit-tested). Calibrate any retune against the golden set:
an intercity segment like 市区→八达岭 (~85km detour) must land in 120-200min, and urban
segments (≤20km) must not change at all — urban drift regresses every city case at once.

Representative paths: `apps/server/src/generation/legEstimator.ts`,
`apps/server/src/integrations/amap/route.ts`, `apps/server/src/integrations/amap/geocoder.ts`,
`apps/server/src/integrations/tianditu/route.ts`, `apps/server/src/integrations/tianditu/geo.ts`,
`packages/shared/src/legs.ts`, `packages/shared/src/constants.ts`.

## Task-Level Circuit Breaker for Cascading Provider Failure

**Scope/Trigger**: any metered provider called serially many times per task (route planning:
up to 30 calls × 10s timeout each) where sustained failure would burn the whole-job time
budget (10min) on doomed retries.

**Contract** (`createRouteBreaker` in `apps/server/src/integrations/amap/route.ts`,
`ROUTE_BREAKER_THRESHOLD = 5`):

- Consecutive *real-attempt* failures (timeout / network / HTTP !ok / status!=1 / no plan)
  reaching the threshold open the breaker for the REST OF THE TASK; subsequent calls skip the
  provider entirely and take the deterministic fallback (`source:'heuristic'`).
- Any success (including a cache hit) resets the consecutive counter.
- Skipped calls (breaker open / missing adcode / budget-rejected) count NEITHER as failures
  NOR against the per-task cap — no request was made.
- Breaker state is per-generation-session memory (created with the geo session), never
  persisted, never cross-task: the next job gives the provider a fresh chance.
- Exactly one `console.warn` at the open transition (prefix `[amap-route]`), stating reason
  and count.

**Why (validated 2026-07-18)**: removing the old 24h negative cache gave failed segments a
retry chance (correct), but under a proxy-black-holed AMAP every retry burned 10.35s serially
— revision rounds + the deterministic fixer re-request failed segments, worst case ~5.2min of
route black hole, and live beijing died at the 10min whole-job timeout (`cancelled`). The
breaker caps sustained-failure cost at ~52s (5×10.35s) while keeping per-pair retries alive
when the provider is healthy.

**Wrong**: negative-caching failures for 24h (pins a transient outage onto a coordinate pair
for a day; revision rounds can never recover real routes). **Correct**: no negative cache +
task-level breaker (fast-fail during sustained outage, full retry freedom across tasks).

**Tests** (`apps/server/src/__tests__/amapRoute.test.ts`): threshold trip stops real requests
and spends no quota with exactly one warn; mid-streak success resets the counter; budget-
rejected and missing-adcode paths count as neither failure nor attempt.

## Geo Result Sanity Firewall (accept-or-reject, never "fix")

**Scope/Trigger**: any externally geocoded coordinate (AMAP or Nominatim fallback) before it
is adopted into the draft. A WRONG coordinate is far more damaging than a MISSING one:
missing only lowers `located` (geo gate catches it); wrong coordinates fabricate absurd legs
(observed live: 上海「人民广场」→嘉兴 108km made every day 17.5h overpacked; chengdu POIs
resolved 372-1962km away produced a 2246min leg). Nominatim's global fuzzy matching on short
Chinese POI names is the dominant source of these mismatches when AMAP is degraded.

**Contract** (`apps/server/src/generation/geoSanity.ts`, wired at the single exit of
`geocodeAll` in `geoPipeline.ts` — results are STAGED, validated, then adopted):

- Task-local research POI coordinates follow this same exit, including their adcodes. A
  rejected reused point gets the ordinary lookup chain and another validation; never bypass
  the firewall because the data came from `search_pois`. Unchanged estimated points skipped
  by incremental resolution do not enter the median reference pool. See the
  [P0 generation contract](./generation-guidelines.md#scenario-research-place-reuse-and-local-planner-revisions-p0).
- Reference point resolution: ① city-level geocode of `form.destination`
  (`resolveCityPlace`, memoized, one call shared with the transit adcode fallback);
  ② cross-check against the median center of already-resolved activity coordinates
  (≥ `MIN_LOCATED_POIS` = 3); if both exist and disagree by more than
  `REFERENCE_CONFLICT_KM` (60km), the city geocode itself is deemed drifted and the median
  center takes over (observed live: Nominatim returns the municipal GEOMETRIC center for
  大市域 cities — 重庆's is ~138km from 解放碑, which got the CORRECT downtown lodging
  coordinate rejected until the cross-check landed); ③ neither available → skip validation
  entirely (never block generation on the firewall itself; whole check wrapped in try/catch).
- Thresholds by kind: activities `GEOCODE_SANITY_MAX_KM` = 200km (must tolerate genuine
  far-suburb anchors: 八达岭 60km, 崂山/兵马俑 35km); lodging `LODGING_SANITY_MAX_KM` = 50km
  (a lodging anchor is semantically an in-city area; a wrong one is amplified ×2 legs ×every
  day).
- Rejection = treat as geocode failure (activity stays uncoordinated, lodging stays
  name-only → existing `anchor_missing` soft + no sentinel legs). NEVER attempt to "correct"
  a coordinate. One `[geo-sanity]` warn per rejection with name, coordinate, distance,
  threshold.

**Wrong**: adopting whatever the provider chain returns because "geocode succeeded".
**Correct**: staged adoption behind distance sanity against a self-validated reference point.

**Tests** (`apps/server/src/__tests__/geoSanity.test.ts`): cross-province mismatch rejected /
far-suburb anchor passes / lodging 108km rejected while same-distance activity passes /
reference conflict → median takeover un-rejects a correct downtown lodging / <3 located
points skips validation.

## Truthful Call-Attempt Accounting

Current `stats.calls` means an accepted non-Null task-wrapper call attempt. The wrapper
increments before the underlying source performs its internal cache lookup and before any
network or parsing failure is handled. Therefore:

- a Null-source call counts as zero;
- a call rejected by the task limit counts as zero;
- a cache hit still counts as one;
- adopting an already-counted research coordinate in `geocodeAll` makes no new geocoding
  attempt, so it adds zero to geo counters; the original research attempt remains counted;
- a provider attempt that returns an empty result or degrades after failure counts as one;
- the value is not a guaranteed count of successful HTTP requests.

Persist and describe these fields as source call attempts unless the implementation is
redesigned to expose separate cache-hit and network-attempt counters. Do not repeat the old,
inaccurate claim that cache hits are free in current accounting.

Representative paths: `apps/server/src/integrations/amap/poiSource.ts`,
`apps/server/src/integrations/websearch/searchSource.ts`,
`apps/server/src/generation/orchestrator.ts`.

## Failure and Result Semantics

Normal search operations catch provider/network/parse failures and return empty arrays so
the generation workflow can continue with model knowledge. `gotResults` is separate from
`calls`; only a non-empty result marks a source as actually used in trip metadata and the
terminal event. `selfCheck()` may perform a real metered request and must return status rather
than throw through the settings route.

## Scenario: Swappable Map Provider (Amap / Tianditu)

### 1. Scope / Trigger

- Trigger: adding a second geographic provider, or touching anything that decides which provider
  supplies POI search, route planning, or geocoding. Changed API payload, DB column, and env keys.
  **Revised 09-25 (second decision): the two vendors are COMPLEMENTARY, not a single-switch choice.**
  Tianditu owns POI search; Amap owns route planning + geocoding (with Tianditu as the fallback when
  `AMAP_KEY` is absent). `MAP_PROVIDER` was removed.
- Goal: each capability resolves its own vendor without the upper layers or the frontend noticing,
  and no capability may silently consume the other vendor's daily budget.

### 2. Signatures

- Env (`apps/server/src/env.ts`): `AMAP_KEY`, `TIANDITU_KEY`, `TIANDITU_DAILY_BUDGET` (default 150),
  `AMAP_DAILY_BUDGET`. **`MAP_PROVIDER` no longer exists** — do not reintroduce a site-level
  either/or switch; the capabilities are complementary and each key independently enables its chain.
  Both keys are expected to be configured. Missing `AMAP_KEY` → route/geocode fall to Tianditu;
  missing `TIANDITU_KEY` → POI search returns empty (no Amap fallback).
- Facade (`apps/server/src/integrations/geoProvider.ts`) — the ONLY module upper layers may import:
  ```ts
  resolveGeoProvider(userId: string): Promise<GeoProvider>   // route + geocoding chain
  resolvePoiSourceForUser(): ResolvedPoiSource                // POI search, ALWAYS Tianditu
  poiBudgetRemaining(): Promise<number>                       // Tianditu daily budget
  createNullGeoProvider(): GeoProvider

  interface GeoProvider {
    readonly kind: 'amap' | 'tianditu' | 'null';
    readonly enabled: boolean;                       // false = no usable credential
    geocodeActivity(name, city, tryAcquire): Promise<GeocodedPlace | null>;
    createRouteBreaker(): RouteBreaker;               // per generation task
    budgetRemaining(): Promise<number>;              // route/geocode chain budget
  }
  ```
  `createPoiSource` is NOT on `GeoProvider` — POI search is not part of this chain.
  `GeoSession.providerKind()` reports which vendor the route/geocode chain actually used, so the
  usage columns can be attributed per chain instead of guessed from one switch.
- Shared contracts (`apps/server/src/integrations/geoContracts.ts`): `GeoPoint`, `GeocodedPoint`,
  `GeocodedPlace`, `GeocodeOrigin` (`'amap-poi' | 'amap-geocode' | 'tianditu' | 'nominatim'`),
  `RouteEstimate`, `RouteOpts`, `RouteBreaker`, `SourcedPoi`, `PoiKind`, `PoiSource`.
- DB: `generations.tianditu_calls INTEGER NOT NULL DEFAULT 0` — must exist in BOTH
  `db/schema.ts` and `db/migrate.ts` (create-table column + `ADD COLUMN IF NOT EXISTS`).
- Shared constants: `LEG_SOURCES` and `DATA_SOURCE_KINDS` each gained `'tianditu'`. Persisted leg
  `source` and trip `dataSources` must carry the real vendor, never a stand-in.
- Settings API: `GET /api/settings/sources-status` returns `{ provider, geo, websearch }`
  (was `{ amap, websearch }`).

### 3. Contracts

- **Coordinate contract is GCJ-02 everywhere above the adapters.** Tianditu uses CGCS2000
  (≈WGS-84): outbound calls run `gcj02ToWgs84`, inbound values run `wgs84ToGcj02`, and the
  conversion stays entirely inside `integrations/tianditu/*`. `GeocodedPlace` / `RouteEstimate`
  are already GCJ-02, so no caller changes when the provider switches.
- **Asymmetric fallback by capability — do not unify it.** Route planning + geocoding are
  **Amap-first** (personal key → site key → Tianditu → Null). POI search is **Tianditu-only**: its
  unavailability (no `tk`, no 地名搜索 permission, request failure) yields an empty result set and
  the research agent falls back to model knowledge — it must NOT fall back to Amap, because Amap's
  `v5/place/text` is shared with the geocoding primary path and would re-squeeze the quota that this
  split just freed.
- **The two budget gates are separate and must stay separate.** `provider.budgetRemaining()` gates
  `geoPipeline`'s per-task reservation (route + geocoding); `poiBudgetRemaining()` (always Tianditu)
  gates the orchestrator's POI-source injection. One shared check would let an exhausted Tianditu
  search budget disable Amap route planning.
  Defaulting (variable unset) is derived from key presence: `AMAP_KEY` → amap, else `TIANDITU_KEY`
  → tianditu, else Null. Existing deployments behave byte-identically.
- **Route-mode coverage differs by vendor, and Tianditu's endpoints/params are NOT what secondary
  sources claim — cross-check the official doc pages AND probe endpoint existence.** The doc pages are
  server-rendered (`/server/drive.html`, `/server/bus.html`, `/server/search.html`); probing with a
  length-valid but unusable `tk` tells existence apart (a real endpoint answers `403 301001 非法key`,
  an absent one `404` + HTML). Result: only `/geocoder`, `/drive`, `/transit`, and `/v2/search` exist;
  `/walk`, `/bus`, `/search`, `/transfer`, `/busline`, and every `/v2/{drive,walk,bus,transit}` return
  404. Therefore:
  - `drive` = `/drive` + `style=0`, postStr `{orig,dest,style}`
  - `transit` = `/transit` with **`type=busline`** and postStr `{startposition,endposition,linetype}`
    (lowercase keys as in the working official example, NOT the doc table's camelCase) — and **no city
    parameter**: Tianditu infers it from coordinates, so `RouteOpts` is unused on this chain.
  - `walk` and `cycle` have no usable endpoint at all → pre-request skip → heuristic (see the
    walking bullet below). Note `style=3` is NOT walking despite the doc claiming it.
  `ROUTE_ENDPOINTS` is the single table for this, and the breaker's `skip` derives from it so the two
  cannot disagree. Do NOT trust blogs/tutorials: they uniformly document `/walk` and `/bus`.
- **Response shape and units differ per endpoint, and only live measurement settles them.** Measured
  with a real `tk` (09-25): `/drive` returns **XML** (`<distance>` in **km**, `<duration>` in
  **seconds**, `<routelatlon>` as the whole polyline), `/transit` returns **JSON** (`segmentDistance`
  in **metres**, `segmentTime` in **minutes**). The docs omit every unit; guessing seconds for
  `segmentTime` produces 804 km/h. Every parsed estimate still passes an implied-speed gate
  (`1`–`150` km/h) — out-of-range means a wrong unit assumption, so it returns null instead of writing
  a 60×-off duration into the itinerary.
- **Tianditu has no walking route planning — `style=3` is a driving shortcut, not a pedestrian mode.**
  Measured with a real `tk`: `style` 0/1/2 return **identical** results, and `style=3` is a
  shorter-but-slower **driving** route (0.9 km in 97 s = 33 km/h; 17.3 km in 27 min = 38 km/h; true
  walking is 11 min and 4 h). Wiring `walk` to it handed walking legs driving durations — 10× under on
  a 15 km leg — and those values PASSED the speed gate, so the bad numbers reached the timeline. That
  is strictly worse than heuristic, so `walk` was removed from `ROUTE_ENDPOINTS`. Generalization:
  a vendor silently substituting a different transport mode is the worst failure shape, because no
  plausibility gate can catch it. Verify the mode, not just the numbers.
- **Tianditu transit's JSON nesting is a trap; verify it layer by layer.** `results[]` → `lines[]` is
  **up to 5 mutually exclusive complete itineraries** (doc: 「数组中每个对象为一条由起点到终点的公交规划线路」),
  so exactly one is taken — summing all five yields 53 km in 4 min. Within one line, `segments[]` are
  serial, but `segmentLine[]` within one segment are **parallel alternatives** (measured: 特12外 and
  44外 side by side) — taking all of them doubles that leg's duration. Negative values mark an unusable
  segment (measured: the preferred metro itinerary is entirely negative), so a plan with no usable
  amounts falls through to the next one. No polyline is produced: joining transfer sub-routes would
  draw a fake straight line across the city.
- **Tianditu POI search derives its own `mapBound`.** `queryType=1` (普通搜索) REQUIRES `mapBound`
  (measured: omitting it returns `infocode 2003 缺少参数：mapBound`), but callers only supply a city
  name. The adapter geocodes the region once through the same `tk` and takes ±0.5° around the
  centre, cached per region for 24 h. Consequence to keep in mind: one extra geocoder request per
  new region per process, which is NOT counted in `generations.tianditu_calls` — the persisted
  counter remains "accepted `searchPois` attempts", not a strict HTTP-request count (see
  Truthful Call-Attempt Accounting). Region resolution failure returns `[]` without issuing the
  search request.
- **Tianditu transit parses one itinerary, not every itinerary.** JSON only (measured); the XML-shape
  fallback was removed once a real `tk` proved the format.
- **Provider-aware labels.** Leg `source`, trip `dataSources`, the timeline banner, the usage line,
  and the settings self-check card must all name the vendor that actually ran.
- Frontend map tiles are NOT part of the switch: Leaflet renders Amap tiles, which share the
  GCJ-02 frame with stored coordinates. Pointing the basemap at Tianditu (WGS-84) would offset
  every marker by ~500 m.

### 4. Validation & Error Matrix

- `AMAP_KEY` empty → one `console.warn` at import; the route/geocode chain falls to Tianditu, then
  Null. `TIANDITU_KEY` empty → one warn; POI search returns `[]` and **no Amap fallback** happens.
  There is no `MAP_PROVIDER`.
- Tianditu geocoder `status !== '0'` (it is a STRING), HTTP failure, or unparsable location →
  fall through to Nominatim with `origin: 'nominatim'`.
- Tianditu devolves errors through BOTH the HTTP status and a JSON body, and the codes are NOT
  interchangeable — surface the body (use `describeHttpFailure` in
  `integrations/tianditu/http.ts`), never a bare `HTTP <status>`: `400 + 308011` = a parameter or
  **`tk` length** is non-compliant; `400 + infocode 2003` = a required parameter is missing
  (`mapBound`); `403 + 301001 非法key` = valid-length but unusable key; `418` = CloudWAF HTML block
  page (typically an empty `tk`). Ordering matters for diagnosis: the key is validated BEFORE the
  parameters, so a placeholder key can never reveal a parameter problem.
- Tianditu search `status.infocode !== 1000` (e.g. permission not granted) → `searchPois` returns
  `[]`; `selfCheck()` reports `ok:false` with the vendor message. Missing `pois` field → `[]`, ok.
- Drive/walk XML lacking `<distance>`/`<duration>`, or bus segments summing to ≤ 0 → null → heuristic.
- Implied speed outside 1–150 km/h → null → heuristic (never a repaired number).
- Breaker `skip` predicate is true (walking/cycling — no usable endpoint, budget refused, breaker open) →
  null, zero failures, zero quota consumed.
- 5 consecutive real route failures → breaker opens for the rest of the task, exactly one warn.
- Daily budget below the per-task reservation → Null provider for the whole task (no calls).

### 5. Good / Base / Bad Cases

- Good: both keys configured — POI search hits Tianditu (`tianditu_calls` grows), route planning +
  geocoding hit Amap (`amap_calls` grows), stored coordinates stay GCJ-02, and the settings card
  reads 「地点搜索（天地图）」＋「路线与地理编码 … 当前走高德」.
- Base: `AMAP_KEY` present, no `TIANDITU_KEY` — route/geocode behave exactly as before; POI search
  returns empty and research falls back to the knowledge base + model knowledge.
- Bad: routing the POI source through Amap as a fallback (re-squeezes the shared `v5/place/text`
  quota this split exists to protect); one shared budget check for both chains; attributing Tianditu
  calls to `amap_calls`; giving Tianditu transit an adcode (it takes none);
  emitting a Tianditu `drive` estimate for a `cycle` request; trusting the raw `<distance>` unit;
  putting `walk` back on `/drive?style=3` (driving durations that pass the speed gate).

### 6. Tests Required

- `apps/server/src/__tests__/geo.test.ts`: `gcj02ToWgs84` inverse — known vector within 1e-5 and
  forward/inverse round-trip within 1e-6 across five cities; out-of-China passthrough.
- `apps/server/src/__tests__/tianditu.test.ts` (all mock-fetch, no real `tk`): WGS→GCJ inbound
  conversion; `ds` is a JSON string with the city prefix; geocoder failure → Nominatim; null key and
  refused `tryAcquire` skip the vendor; drive km/s → m/min with per-point polyline conversion;
  `transit` maps to `/transit?type=busline` with `startposition`/`endposition`/`linetype`, picks a
  single itinerary out of `lines[]`, takes only the first usable `segmentLine[]` alternative, reads
  `segmentTime` as **minutes**; `walk` and `cycle` both return null with zero requests; speed-gate
  rejection; missing-XML null;
  24 h cache hit; bus positive-only summing / all-negative → null / no polyline;
  breaker skips walking and cycling without counting failures; 5 failures trip with the `[tianditu-route]` prefix;
  POI field gaps left empty, `mapBound` present and centred on the geocoded region, region resolution
  failure → `[]` with no search request, `infocode` failure → `[]` + `ok:false`, missing `pois` → ok,
  HTTP failure message carries the vendor body, `resolveTiandituPoiSource(null).kind === 'null'`.
- `apps/server/src/__tests__/amapRoute.test.ts`: the same breaker contract via
  `createAmapRouteBreaker(apiKey)` — threshold trip, mid-streak success reset, skip paths.
- `scripts/verify-c2.mjs`: the migration assertion must list `tianditu_calls`, and the Null-source
  row must still record zero calls in BOTH provider columns.
- `scripts/verify-amap-settings-browser.mjs` / `verify-websearch-settings-browser.mjs`: their
  `sources-status` mocks must serve the `{ provider, geo, websearch }` shape.

### 7. Wrong vs Correct

#### Wrong

```ts
// Upper layer reaching into one vendor, and letting a structural gap look like an outage.
import { geocodeActivity } from '../integrations/amap/geocoder';

if (mode === 'transit' && (!city1 || !city2)) return heuristicLeg();   // Tianditu can never pass this

const route = await routeEstimate(apiKey, from, to, mode);
leg.source = 'amap';                                                    // lie when Tianditu ran
```

## Attraction Cover Sources (Amap POI photos only, 2026-11-05)

**Scope/Trigger**: an `attraction` candidate reaches `add_candidate`, or the cover order / URL
acceptance / quota rules change. There is exactly **one** source: Amap POI `photos`.

**Why the consolidation**: manual curation produces almost nothing today, and stock libraries
(Pexels / Pixabay / Unsplash / Commons) measured low hit rates for Chinese attractions and frequently
returned a generic or wrong-subject photo. Every Amap POI carries several official photos, they are
reachable from mainland China and tied to the exact place. All non-Amap adapters, the visual-review
queue, the curated/selected libraries and their scripts/tests were deleted in 11-05. Do not
reintroduce them without a new spec.

**Contract** (`resolveCover` in `apps/server/src/generation/tools/researchTools.ts`,
`createAmapPoiPhotoLookup` in `apps/server/src/integrations/amap/poiPhotos.ts`,
`createStoredPlaceLookups` in `apps/server/src/generation/storedPlaceLookups.ts`, wired in
`generation/orchestrator.ts`):

- Order, cheapest first: (1) **`search_pois` bypass** — photos already returned by the same Amap
  search call, zero extra quota, ≤3; (2) **stored** `canonical_places.payload.amapPhoto` written back
  by an earlier hit; (3) **live** `v5/place/text` with `show_fields=photos`.
- Only `attraction` is queried. Food and hotel never are; the frontend falls back to the category icon.
- Result shape: `coverUrl = photos[0]`, `photos` = the same URLs in order (deduped, ≤3). No
  `coverAttribution`: Amap images are external hotlinks and must not be credited to a photographer.
- Name gate: equal to / ends with / normalized key segments in order («杭州西湖风景名胜区» ends with
  «西湖»; «西溪国家湿地公园» matches «西溪湿地»). `endsWith` (not `includes`) so «西湖区××» cannot
  pass as «西湖». Names shorter than 2 normalized characters never match.
- Type gate: the first segment of `type` must be one of
  `['风景名胜', '体育休闲服务', '科教文化服务', '购物服务']`; a missing type is rejected. «龙井村(公交站)»
  and «宋城路» must not become scenic covers.
- URL gate: https only; `http://` is rewritten to `https://` (Amap mixes schemes and an http image on
  an https page is blocked as mixed content). Relative `/media/...` paths are no longer accepted.
- Quota: `v5/place/text` is 「基础搜索服务」 (personal 5,000/month). Live lookups are capped by
  `AMAP_PHOTO_MAX_PER_TASK` (env default 40), share the `amapQueue`, cache hits and confirmed
  misses for 24 h, and pass through the persistent `place` daily budget. `calls` counts real requests
  and is added to `generation.amap_calls`.
- A live hit is written back to `canonical_places.payload.amapPhoto` (full https URL) via
  `saveAmapPhoto(city, name, url)`; failures only warn. Negative results are NOT written back — a
  miss must stay retryable.
- Any failure (missing key, timeout, non-2xx, budget exhausted, no match) degrades to "no image",
  never throws into generation. The frontend shows the category icon / 「暂无实景照片」 placeholder.
- Read path (`GET /api/trips/:id` → `enrichTripPhotos`) only fills **attractions with no cover and no
  photos** from the stored `payload.amapPhoto`. It makes no external call, writes nothing back, and
  keeps the existing trip object (including `updatedAt`) untouched.

**Tests**: `amapPoiPhotos.test.ts` (name/type gates, multi-photo ordering + dedupe, http→https,
cache/negative cache, `status≠1` retry, per-generation cap), `placeLookup.test.ts` (bypass → stored →
live order, multi-photo snapshots, failure tolerance), `tripPhotos.test.ts` (fill only empty
attractions, dedupe, no write-back), `storedPlaceLookups.test.ts` (one city load shared by photo and
coordinate lookups).
