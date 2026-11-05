# RAG Retrieval Guidelines

Scope: the verified-place knowledge path — `canonical_places` / `research_evidence`
retrieval, its prompt injection points, the embedding client, and the offline scripts that fill
those tables. The storage-selection rationale (pgvector over a dedicated vector database) lives
in `docs/TECHNICAL_ARCHITECTURE.md` §4.3; the runtime chain in §4.4.

## Retrieval Is Optional Enrichment, Never a Gate

Retrieval must never block, fail, or stretch generation toward its 10-minute job timeout. Every
layer degrades silently:

| Failure | Behavior |
| --- | --- |
| pgvector extension missing | startup migration skips the `embedding` columns; startup warns only |
| `EMBEDDING_*` unset | `hasEmbedding()` is false; vector layer skipped |
| embedding HTTP failure | that batch becomes `null`; other batches continue |
| missing `embedding` column during backfill | script logs and skips that table, exit 0 |
| any `retrieveContext` exception | `console.warn` + return `[]` |

Consequences to preserve: `retrieveContext` returns an empty result on failure. The research
model can then use existing external-source/model-knowledge fallback; no planner model exists.
The system prefetch has its own timing event, but retrieval failures never become job errors.

## Scenario: SQL-first Research (2026-10-02)

### 1. Scope / Trigger

Apply to `placeRetrieval.ts`, `retrievalRanking.ts`, `researchContext.ts`, research tools/prompts,
the embedding clients, and knowledge-table migrations. The user approved this change after a
read-only audit found the old top 8 monopolized by Tiantan entrances/photo spots and discarded
vector calls. This supersedes the historical concatenation-only ranking contract.

### 2. Signatures and contracts

- `createPlaceRetriever({query, embed})` accepts read-only dependencies without importing the
  migrating `db/client`. `retrieveContext` wires it to the application pool and `embedQuery`.
- `RetrieveOptions` includes `city`, `category`, `preferences`, `limit` (1–48), `browse`,
  `vector: 'auto' | 'off' | 'force'`, and `signal`. Empty names return `[]` unless city-scoped
  system browsing is explicitly enabled. All SQL uses parameters and `verified = TRUE`;
  both keyword and vector paths apply the same city/category filters. LIKE metacharacters escape.
- SQL supplies at most 256 keyword/browse rows. Exact name/alias hits lead; structured category
  mappings supplement missing themes. Ranking groups explicit stable entity IDs and favors exact
  matches, quality, main sights and modest spatial diversity. Name keys only normalize NFKC,
  whitespace and case; suffixes, shared aliases and parent/child substrings never prove identity.
  See [place-identity.md](place-identity.md) for the authoritative identity contract.
- `prepareResearchContext(form, retrieve, signal)` browses attractions with zero vector requests,
  at `ceil(days * paceDensity * 1.4)`, clamped to 8–36. Food preference adds up to 12 food candidates;
  hotels are excluded. These are choices for the model, not automatically selected activities.
- `renderRetrievedPlaces` includes canonical IDs, names, categories and up to 3 evidence items.
  Evidence keeps direct/weak/risk_only labels and prompt excerpts of at most 80 chars. Source URLs
  remain in the task catalog and are automatically attached on insertion, not copied by the model.
- `search_verified_places(keyword, category?, semantic?)` supplements missing information.
  Auto mode skips vectors when deduplicated keyword results fill the limit. `semantic=true`
  requests force mode for complex preferences. Semantic similarity never proves hard conditions.
- `embedQuery` uses the site configuration only: one HTTP attempt, 2500ms timeout, caller abort,
  finite 1024-dimensional values, successful-query cache (10min, 256 entries), no retry/throttle.
  `embedTexts` remains the offline batch client; its 300ms delay is BETWEEN batches only.
- Evidence is fetched with `LATERAL ... LIMIT 3` per member ID and capped to 3 after same-entity
  merging, ordered by kind, strength, freshness. Both schema/migration define
  `idx_research_evidence_place(place_id, fetched_at DESC)`.
- Evidence strength is decided at import time by `services/evidenceStrength.ts`, not by the
  migration's kind backfill: upstream's value wins, `xhs_reservation` / `xhs_price` without a
  `sourceUrl` drop to `weak` (they come from booking-platform screenshots and lists, not from
  notes), and other kinds fall back to `xhs_reason`→weak / `xhs_warning`→risk_only / else direct.
  A sourceless reservation line must never be the only thing that justifies “需预约”.
- `normalizeReservation` (`generation/researchQuality.ts`) downgrades a note whose `提前 N 天`
  figures do not overlap — e.g.「天坛公园提前7天；天坛公园提前1天00:00预约」— to `unknown` plus
  「预约资料存在冲突，请通过官方渠道确认后安排。」。Ranges such as「提前3-7天」count as one
  interval, so a normal range plus a value inside it is not a conflict. Never paste two sources'
  lead times into one note without normalising them first.
- `add_candidate(placeId?, name, ...)` validates an ID against this task's retrieved catalog,
  exact/known alias name, city and category. It reuses coordinates, opening/reservation fields
  and evidence without another XHS lookup. Candidate insertion remains sequential for safe dedup.
- Library coordinates are authoritative: for a resolved entity `add_candidate` overwrites the
  same-named search-result entry in `outcome.locations` directly. Do NOT route that write through
  `rememberResearchLocation` — its ambiguity check reads the mismatch as two same-named search
  results, deletes the whole key and takes the search coordinates with it, disabling the layer-2
  distance bypass. `placeLookup.test.ts` locks the override (it fails on the old call).
- `submit_research(candidates?: {placeId, intro}[], summary?)` is the normal known-place path:
  validate all IDs/city/verified/category, nonblank intros and total capacity before inserting.
  Each known place goes through the same sequential enrichment and candidate SSE path; deduplicate
  by canonicalPlaceId, including already inserted entries. Empty pools cannot terminate successfully.
  `normalizeReservation(status, note)` validates both structured and model-supplied policies:
  conflicts (e.g. `required` + `无需预约`), uncertain text, name-only or missing notes become
  `unknown` with an explicit confirmation reminder. Consistent explicit `none`/`required` survive;
  official reservation seeds override after validation and retain their first source link.
  Weak/risk-only evidence is never parsed into a confirmed reservation policy. This does not
  repair canonical database rows or assert that unconflicted source data is currently correct.
  `cleanResearchIntro` preserves complete introduction sentences within the 200-character limit;
  upstream purification verifies their content and sources, while structured reservation policies
  are validated separately. Source links remain available.
  Invalid batches remain repairable; cancellation stops further insertion and final submission.
  External/model-knowledge candidates retain `add_candidate` followed by submission. Summary is
  optional; it records unmet requirements/source limitations, not a second route-planning pass.

### 3. Runtime boundaries

Retrieval remains optional, city-scoped enrichment. Cache entries contain only site-generated query vectors; no BYOK configuration enters this path.

### 4. Validation and errors

| Condition | Behavior |
| --- | --- |
| No SQL rows / unknown city | Model receives the fallback instruction and can use existing sources |
| Vector unavailable, malformed or timed out | Retain SQL candidates; no online retry |
| Caller abort | No new vector calls or candidate publication; orchestrator owns cancellation |
| Wrong placeId/name/city/category | Reject candidate (or entire submitted batch) without mutating the pool |
| Batch exceeds pool capacity / blank intro | Reject before any enrichment or candidate publication |
| Repeated ID/name / retry of inserted batch | Reuse existing entries, no duplicate candidate events |
| Shared generic alias / different city | Keep separate entities, never mix evidence |

### 5. Good / Base / Bad

Good: SQL prefetch gives the first research request a diverse candidate set; it selects using
`placeId` and writes intros directly. Base: empty library uses existing fallback. Bad: closing
vector retrieval entirely despite absent themes, rerunning the same search before writing known
candidates, or treating all phase-duration sums as wall clock.

### 6. Tests required

`node --import tsx scripts/verify-sql-first.mts` tests real SQL against a disposable database,
ranking, alias/city isolation, evidence ordering/reuse, vector fallback/cancellation and title
termination. `--full` runs all server tests EXCEPT `independentPhotoIdentity.test.ts`, which asserts
its own `DATABASE_URL` matches `place_identity_test_<timestamp>`; that file runs alone via
`node --import tsx scripts/verify-place-identity.mts`. Tests kept in the shared runner must carry
their own fixtures and hold in an empty database: inject `verifiedPlaces` instead of relying on the
real application library, and assert open-hours shape with a pattern rather than a hard-coded slot. `benchmark-place-retrieval.mts` is a read-only SQL
probe with external vectors disabled; never report its vector-requesting cases as full RAG latency.
`npm run eval:retrieval` is its quality-measuring counterpart — see *Retrieval Quality Baseline* below.
`researchSubmission.test.ts` verifies batch atomic validation, evidence/photos/seed reuse and
cancellation; `verify-c2.mjs` verifies initial candidate injection, one-request known-place
research with per-candidate SSE, legacy fallback, and one-request titles; generation-flow
verification protects cancellation and transactions. Historical model timings remain historical.

### 7. Wrong vs Correct

```ts
// Wrong: full SQL output still pays for discarded vectors.
const merged = [...sqlHits, ...await vectorRecall()].slice(0, limit);
// Correct: online semantic supplementation is conditional and cancellable.
if (sqlHits.length < limit || semanticRequested) await embedQuery(query, signal);
```

## Scenario: Offline Knowledge Ingestion

### 1. Scope / Trigger

Apply when adding or rerunning a script that fills `canonical_places` / `research_evidence`, or
when changing the meaning of `source` / `verified` for those tables.

### 2. Signatures

- `apps/server/scripts/seed-canonical-places.ts` — golden-set snapshots → `source='goldset'`,
  `verified=true`; ids derived from city+name, so reruns skip existing rows
- `apps/server/scripts/seed-xhs-places.ts` — community library export → `source='xhs'`;
  `--purge` deletes only rows this source owns
- `apps/server/scripts/seed-xhs-relations.ts` — community POI association pairs
  (`import/xhs-place-relations-{city}.json`) → `place_relation`; imports `strength='direct'` only,
  upserts on `(city, from_name, to_name)`
  for legacy cities. Files with `relationIdentity` use the complete, source-versioned
  `place_relation_snapshots` graph instead; see [place-identity.md §19](./place-identity.md).
  Once a city adopts that contract, old name-only files are rejected. Place imports advancing
  the source snapshot invalidate the old graph and its `data_import` record until a matching
  relations file arrives. Graph consumers use current entity IDs/revisions and the latest
  place export's available IDs, including when older verified rows remain in the library.
- `apps/server/scripts/lib/exportFiles.ts` — shared export scanner: `scanExports(dir)` /
  `latestExports(files)` / `readExport(path)`; version identity is `sha256(file bytes)[:32]`
- `apps/server/scripts/check-data-freshness.ts` — read-only diff of the newest on-disk exports
  against `data_import`; exits 1 when anything is pending
- `data_import(source, city, content_hash, file_path, row_count, imported_at)` — PK `(source, city)`,
  `source` is `xhs_places` | `xhs_relations`
- `apps/server/scripts/embed-backfill.ts` — idempotent embedding backfill (`WHERE embedding IS
  NULL`); `--tables places` limits it to `canonical_places`
- `apps/server/scripts/restore-goldset.ts` — repairs rows whose `source`/`payload` were clobbered

### 3. Contracts

- There is no online write path. The generation pipeline READS these tables (the `add_candidate`
  enrichment reads community rows for reservation policy and source links); all writes come from
  operator-run offline scripts.
- Scripts must be idempotent and rerunnable, and a rerun of one source must never touch rows
  owned by another. The community importer updates only `WHERE canonical_places.source = 'xhs'`,
  because the same real place can exist as a `goldset` row with the same id.
- **The `goldset` merge must not silently out-rank incoming values.** That branch merges with
  `EXCLUDED.payload || canonical_places.payload`, and jsonb `||` lets the RIGHT operand win — so
  every key present in both sides is frozen at its first-imported value. `recommendScore` /
  `mentionCount` are what this bites. The trailing `CASE` must therefore write the incoming values
  in its `ELSE` branch; returning `'{}'` there assumes the new value already won, and it does not.
  Symptom when broken: 故宫博物院 sat at `17.33 / 6` while upstream had `137.64 / 55`, so scheduling
  dropped it at rank 11 of a 3-day Beijing itinerary. Only `goldset` rows are affected — community
  rows take the other branch, which has no such re-merge.
- **The seeder's default input must not be a hard-coded single file.** `import/` accumulates several
  exports per city under inconsistent names (`xhs-places.json` / `xhs-places-beijing.json` /
  `xhs-places-北京.json`), so a hard-coded default silently imports a stale version. The contract is
  newest `generatedAt` per `(source, city)` via `latestExports`; passing an explicit path imports
  exactly that file.
- **Version identity is the content hash, not `generatedAt`.** The relations export carries no
  `generatedAt`, so `sha256(file bytes)[:32]` is the only identifier that works for both kinds; a
  missing `generatedAt` falls back to the file's mtime date for display only.
- **Every import writes one `data_import` row inside the SAME transaction as the data.** A record
  written separately could claim a version the rows do not match, which is worse than no record.
  `check-data-freshness.ts` compares `content_hash` and is read-only — it must stay out of the
  generation hot path.
- A city present on disk but absent from `data_import` is "never imported", not "no data". This is
  how 重庆's 604-row export stayed invisible while the DB held only its 19 golden-set rows.
- Re-importing rewrites `embedding` (typically to `NULL`) for the rows it touches, so
  `embed-backfill.ts` must be rerun after every import.
- `verified` means "adopted into the project's curated pool", not "crawled". Retrieval filters on
  `verified = TRUE`, so an unverified import is invisible to generation by design.
- Backfill treats a missing `EMBEDDING_*` config or a missing `embedding` column as a normal
  skip with exit code 0.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Importer rerun without `--purge` | upsert; existing ids updated, no duplicates |
| Imported row collides with a golden-set id | golden-set row keeps its identity fields, but `recommendScore` / `mentionCount` take the **higher** of the two |
| `import/` holds several exports for one city | newest `generatedAt` wins; older files stay on disk as history |
| Community score for a seeded place rises upstream but the row keeps the old value | the `goldset` merge order is inverted — see the Contracts entry above |
| `import/` holds several exports for one city | `latestExports` keeps the newest `generatedAt`; older files stay on disk as history |
| relations export has no `generatedAt` | falls back to file mtime for display; the content hash is still the version identity |
| `data_import` disagrees with the rows actually present | rerun the seeders — the record is written in the same transaction as the data, so a mismatch means a write happened outside the seeder |
| a city exists on disk but not in `data_import` | reported as “从未导入”; it is not a “no data” case |
| `EMBEDDING_*` unset during backfill | notice printed, exit 0, no partial state |
| Some embedding batches fail | those rows keep `NULL`; a rerun retries exactly them |

### 5. Good / Base / Bad Cases

- Good: import the community library, rerun `embed-backfill.ts`, then confirm counts with
  `test-rag-data-check.mts` before deploying.
- Base: rerun the golden-set seeder on an unchanged snapshot — zero inserts, no duplicate rows.
- Bad: an importer that overwrites another source's `source`/`payload` on id collision (this
  happened once; `restore-goldset.ts` exists because of it).

### 6. Tests Required

- `npx tsx apps/server/test-rag-data-check.mts` after every import: the `goldset` count must be
  unchanged, `verified` rows must cover the golden-set cities, and embedding coverage must match
  the last backfill.
- `npx tsx apps/server/scripts/check-data-freshness.ts` after every import: must print
  “全部与磁盘最新导出一致” and exit 0. Before importing, it must report the pending cities.
- `apps/server/src/__tests__/exportFiles.test.ts` — recognises only the two export kinds, keeps
  exactly one entry per `(source, city)` at the newest `generatedAt`, empty input → empty output.
- `npx tsx apps/server/scripts/verify-xhs-service.ts` exercises the read helpers
  (`findXhsPlace` / `findXhsEvidence` / `findXhsPlacesByCategory` / `xhsPlaceStats`) against the
  imported data.

### 7. Wrong vs Correct

```sql
-- Wrong: clobbers golden-set rows that share an id with the imported library.
INSERT INTO canonical_places ... ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source;

-- Correct: only update rows this source already owns.
INSERT INTO canonical_places ... ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source
WHERE canonical_places.source = EXCLUDED.source;
```

```sql
-- Wrong: the ELSE assumes the incoming score already won, but jsonb `||` gives the RIGHT side
-- priority — so `EXCLUDED.payload || canonical.payload` leaves the OLD score in place and the
-- incoming file's score is discarded forever.
payload = EXCLUDED.payload || canonical_places.payload
       || CASE WHEN canon_score >= excl_score THEN jsonb_build_object('recommendScore', canon) ELSE '{}'::jsonb END

-- Correct: write the incoming score explicitly when it is the higher one.
payload = EXCLUDED.payload || canonical_places.payload
       || CASE WHEN canon_score >= excl_score THEN jsonb_build_object('recommendScore', canon)
               ELSE jsonb_build_object('recommendScore', EXCLUDED.payload->'recommendScore') END
```

Representative paths: `apps/server/scripts/`, `apps/server/test-rag-data-check.mts`.

## Scenario: Upstream Community Enrichment (openHours / aliases / place_relation)

### 1. Scope / Trigger

Apply when changing how the community pipeline's derived data is consumed: `payload.openHours`,
`payload.aliases` on `canonical_places`, or the `place_relation` table; also when changing
`generation/scheduling/placeFacts.ts`, `generation/scheduling/placeRelations.ts`,
`generation/scheduling/buildDraft.ts` (scheduling inputs), `scripts/seed-xhs-relations.ts`, or the
`place_relation` DDL in `db/schema.ts` / `db/migrate.ts`.

### 2. Signatures

- `place_relation(id TEXT PK, city TEXT, from_name TEXT, to_name TEXT, strength TEXT,
  note_count INTEGER, created_at TIMESTAMPTZ)` — UNIQUE `(city, from_name, to_name)`; the pair is
  UNDIRECTED, stored once with `from_name < to_name`
- `seed-xhs-relations.ts [path.json ...]` — default scans `import/xhs-place-relations-{city}.json`
  for 北京/成都/广州/杭州/厦门
- `loadPlaceRelations(city: string): Promise<PlaceRelations>` where
  `PlaceRelations = ReadonlyMap<normalizedKey, readonly normalizedKey[]>`
- `resolveRelatedPairs(relations, candidateNames): Set<string>` — candidate-pool names, not keys
- `relatedPairKey(a: string, b: string): string` in `scheduling/schedule.ts`
- `ScheduleOptions.relatedPairs?: ReadonlySet<string>`
- `renderOpenHours(raw: unknown): string | undefined` in `scheduling/placeFacts.ts`
- `PlaceFacts.openTime?: string`, `PlaceFacts.aliases: string[]`

### 3. Contracts

- The association pair is UNDIRECTED by upstream contract («顺序由消费端决定»). Consume it as a
  same-day clustering signal only. Never emit `orderConstraints` from it — ordering seeds stay in
  `data/routeOrderSeeds.json`.
- `strength` is upstream's evidence tier: `direct` (≥2 notes) / `weak` (single note). Only `direct`
  is imported; `weak` may just be an arrow in a post's layout.
- The discount is applied ONLY in `buildChain`'s nearest-neighbour comparison (`distanceKm × 0.5`).
  It never changes coordinates, coordinates-derived legs, `orderSegment`, day assignment, or the
  feasibility simulation.
- Name alignment: both sides of `resolveRelatedPairs` go through `normalizePlaceKey`. The returned
  pair key uses the candidate pool's ORIGINAL name (untrimmed) because `buildChain` compares against
  `poi.name` verbatim — trimming here silently disables every discount.
- `openTime` precedence in `buildDraft`: `facts.openTime` (structured, carries `closedWeekdays`) >
  `poi.openTime` (Amap raw text) > `facts.closureText` (regex-mined evidence fallback).
- `payload.aliases` extends the `loadPlaceFacts` grouping keys: group key = primary
  `normalizePlaceKey(name)` plus `normalizePlaceKey(alias)` for every alias. Any key hitting a row
  serves that row's facts; `mergeFacts` then unions `aliases` across members.
- `renderOpenHours` renders `closedWeekdays` (ints, 0=Sunday, matching `Date.getDay()`) into the
  same free-text shape `isClosedOnDate` already parses, so `packages/shared/src/openHours.ts` needs
  no signature change and the feasibility engine picks it up for free.
- Upstream `openHours.version=2` carries `subject`, `scope='place'`, `status='attributed'|'unknown'`,
  accepted `attributions` and rejected `review` (original sentence/raw text, source link and reason).
  Only attributed main-place fields render. Unknown/component records yield no opening promise;
  v2 rows are excluded from legacy `research_evidence` closure-text mining, so a rejected museum
  clause cannot reappear as a street closure through the fallback. Existing v1 rows remain compatible.
- All three are optional enrichment. Missing → scheduling output byte-identical to before.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `place_relation` empty for the city | `loadPlaceRelations` returns an empty Map; scheduling unchanged |
| `place_relation` query throws | `console.warn('[placeRelations] ...')` + empty Map; job continues |
| relation JSON file missing | `seed-xhs-relations.ts` warns and skips that city |
| all relation files missing | seed exits 1 with the upstream command hint |
| seed rerun | `ON CONFLICT (city, from_name, to_name) DO UPDATE`; row count stable |
| `payload.openHours` absent | `renderOpenHours` → `undefined`; falls back to `poi.openTime` / `closureText` |
| `closedWeekdays` out-of-range or non-numeric | filtered out; no remaining content → `undefined` |
| v2 unknown or component scope | `undefined`, no legacy evidence closure fallback |
| `payload.aliases` absent for a city | grouping keys degrade to the pre-09-27 single key |
| a relation pair has only one side in the candidate pool | pair dropped; no discount |

### 5. Good / Base / Bad Cases

- Good: 北京 imports 79 `direct` pairs; a pool containing 故宫 + 景山 keeps them on the same day,
  and 香山双清别墅's `closedWeekdays:[1]` keeps it off a Monday.
- Base: a city with no enrichment data schedules exactly as before the change — no discount, no
  structured hours, a single grouping key.
- Bad: turning an undirected pair into a `before`/`after` constraint (fabricates a direction the
  upstream data never asserted); letting a failed `place_relation` query abort generation.

### 6. Tests Required

- `apps/server/src/__tests__/placeRelations.test.ts` — bidirectional key registration, candidate
  cross-match against alias forms, single-sided pairs dropped, empty pool, empty city.
- `apps/server/src/__tests__/placeFacts.test.ts` — `renderOpenHours` output and all `undefined`
  cases; `payload.aliases` reaching a row the primary key cannot match (双清别墅 → 香山双清别墅);
  `openHours` landing in `facts.openTime`.
- `apps/server/src/__tests__/scheduling.test.ts` — a `relatedPairs` hit pulls two points into the
  same day; absent/empty `relatedPairs` reproduces the baseline chain exactly.
- Assertion points: `buildSchedule(...).days[i].stops` names and day assignment — not internals.
- Local DB integration tests skip (not fail) when the enrichment data was never imported.

### 7. Wrong vs Correct

```typescript
// Wrong: undirected data turned into a directional constraint.
const relations = await loadPlaceRelations(city);
orderConstraints: [...relations.keys()].map(...)   // fabricates a 先后 the upstream never claimed

// Correct: same-day clustering only — a distance discount inside the chain builder.
relatedPairs: resolveRelatedPairs(relations, input.pool.map((p) => p.name)),
// … buildChain compares distanceKm × RELATED_DISCOUNT for pairs in that set.
```

Representative paths: `apps/server/src/generation/scheduling/placeRelations.ts`,
`apps/server/src/generation/scheduling/placeFacts.ts`,
`apps/server/src/generation/scheduling/buildDraft.ts`, `apps/server/src/db/migrate.ts`,
`apps/server/scripts/seed-xhs-relations.ts`.

### Opening-fact attribution and repair previews (2026-10-05)

- Upstream signature: `mine_open_hours(records: list[HoursEvidence], *, target, aliases=(), known_names=())`.
  Each record carries candidate target, raw text, source URL/kind and scope. A mention being filed
  under a place is not proof that every clause belongs to it. Longest named entities and child
  facilities split the text before parsing. Unknown/other subjects only enter `review`; explicit
  place-scoped sources may use subjectless text. Source links retain the document path without
  signature query parameters. The exporter reads in a repeatable-read read-only transaction.
- Good: `锦里全天开放；成都博物馆周一闭馆` keeps the street's opening signal and rejects the other
  subject's closure. Base: a named museum's Monday closure remains. Bad: regex-mining the entire
  mixed text, cropping away the subject, or treating every food place as always open.
- Tests: upstream `test_hours_attribution.py` (multiple entities, aliases, child facilities,
  subjectless uncertainty, ticket times, provenance), server `placeFacts.test.ts`, and the actual
  SQL fallback case in `verify-generation-flow.mts`.
- A data repair is a preview until explicitly accepted. Compare old/new `openHours` by stable
  ID/name; preserve all other fields, independent evidence, relation rows, images and history.
  `source='goldset'` describes the place row: its top-level `openHours.evidence` may still be an
  upstream enrichment (golden seeding writes `caseId/activity`). Review field ownership separately.
  Use a targeted patch for an opening-only repair: full imports also reconcile unrelated content,
  identities and evidence. `reconcileImportedPlaces` already replaces `openHours` on both `xhs`
  and `goldset` rows when valid identity metadata is present; the initial merge is not the whole
  import contract. Apply only accepted field changes with identity/expected-old-value checks,
  a durable pre-update backup and transactional non-hours field hashes, then export a new immutable
  knowledge version and verify it against the accepted candidate.
- Opening-only preview patches do not change current embedding inputs: places use city/name/category,
  evidence uses kind/content (`scripts/embed-backfill.ts`). Reuse vectors only while those fields
  remain byte-equivalent; verify isolated roundtrip hashes and vector queries. Adding/replacing
  evidence or changing embedding inputs requires a fresh vector decision.

## Scenario: Attraction Cover Images (payload.coverImage → /media)

### 1. Scope / Trigger

Apply when changing where an attraction's `coverUrl` comes from: the stored-cover lookup, the
`/media` static route, `MEDIA_BASE_URL`, `scripts/seed-xhs-place-images.ts`, the upstream
`export_place_images.py` manifest, or `researchTools.resolveCover`'s URL acceptance rule.

Background: the Wikimedia fallback cannot serve mainland users — `upload.wikimedia.org` and the
rest of the Wikimedia media servers are blocked in China. The order is therefore: stored library
(real photos, but only Beijing/Guangzhou/Hangzhou) → Pexels (any city, ~45–50% textual gate) → Amap
POI photos (China-reachable and tied to the exact POI, but burns the scarce search quota) → live
wiki lookup (overseas/proxied environments only).

### 2. Signatures

- Manifest `import/xhs-place-images-{city}.json`:
  `{ city, generatedAt, count, images: [{ placeId, placeName, key, width, height, bytes, score, sourceUrl }] }`
- `placeId` is the persisted `place_entity.entity_id`, shared with the places export. A city/name
  hash initializes legacy identity only; renaming never recomputes it. Old manifests resolve via
  explicit member IDs/redirects. Unresolved IDs and complex child images are skipped with a count.
  Upstream's source-row auto-increment ID must never be exported as the entity ID.
- `key` = `xhs/{city}/{placeId}/{index}.webp` — a RELATIVE key. No `/media` prefix, no host.
- Upstream producer: `xhs-travel-pipeline/scripts/export_place_images.py [--city] [--out] [--media-root]
  [--max-per-place] [--dry-run]`; `export_and_embed.ps1 -WithImages` chains it after the places import.
- Importer: `tsx apps/server/scripts/seed-xhs-place-images.ts [path.json ...]` — run AFTER
  `seed-xhs-places.ts`, because a key can only be written onto an existing row.
- `createStoredPlaceLookups(city, loadFacts = loadCityPlaceFacts)` returns `coverFor(name)`,
  `amapPhotoFor(name)`, `pointFor(name)`; the orchestrator shares this instance per generation.
- `loadCityPlaceFacts(city)` returns the complete normalized-name/alias index;
  `loadPlaceFacts(names, city)` returns only the requested names (trimmed, otherwise unchanged).
- `createStoredCoverLookup(city)` / `createStoredAmapPhotoLookup(city)` remain convenience wrappers.
- `mediaUrl(key: string, base = env.mediaBaseUrl): string | null` — same file
- `PlaceFacts.coverImage?: string` in `generation/scheduling/placeFacts.ts`
- `env.mediaBaseUrl` ← `MEDIA_BASE_URL` (default `/media`; trailing slashes stripped)
- `/media/` route: local mode serves `data/media` through fastify-static (`decorateReply: false`);
  `MEDIA_STORE=s3` mode reads the same prefix from the object store by key. Both dev and prod
  register it, and historical snapshots that already contain `/media/...` keep resolving either way.
  See *Scenario: Media Object Storage* below.

### 3. Contracts

- **Store the relative key, never a URL.** The display prefix comes from `MEDIA_BASE_URL` at read
  time, so switching from the local disk to object storage is an env-var change, not a re-import.
- Resolution order in `add_candidate` (attraction only): stored library → Pexels → Amap POI photos →
  Chinese Wikipedia → empty. Each hit short-circuits the remaining sources and their request budgets.
  The four-source contract lives in the integration guidelines under *Attraction Cover Sources*.
- URL acceptance is deliberately wider than the wiki path: `isUsableCoverUrl` accepts `http(s)://`
  OR a leading `/` (same-origin `/media/...`). The wiki result still requires `https://`.
- `mergeFacts` takes `coverImage` from any member of a normalized group — split rows (「故宫」 vs
  「故宫博物院」) share one exported image.
- Images never enter the database or the Docker image: `data/media/` is gitignored and mounted
  read-only into the container (`./data/media:/app/data/media:ro`). The DB stores keys; the host
  stores bytes; they are synced separately.
- The route is skipped when `data/media` does not exist, so a fresh clone still boots.
- Vite must proxy `/media` to the same Fastify backend as `/api`. A 200 HTML SPA fallback is
  NOT a valid media response; verify `image/webp` and browser decoding.
- Cache the full `loadCityPlaceFacts` index, never the candidate subset returned by
  `loadPlaceFacts([firstName], city)`. The latter silently loses every later name, including
  coordinates required for the Wikimedia fallback. Empty city/name does not load the index.
- Re-importing xhs places preserves independently maintained `coverImage` and `amapPhoto` fields,
  while other upstream-owned payload fields refresh normally. Image imports choose the FIRST
  valid manifest entry per place; upstream order is preference order, not last-write-wins.
- Saved trips contain a cover snapshot in `overview`; library imports do not update old trips.
  A targeted backfill must preserve other trip content, save a backup, and protect against
  concurrent edits with an owner-scoped compare-and-swap write.
- Upstream keeps `sourceUrl` (the Xiaohongshu CDN link, ~24 h signed) for provenance and takedown
  only. The file has already been copied locally; the link is never used for display.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| `payload.coverImage` absent | stored lookup → `null`; continue with Pexels, Amap, then wiki |
| `PEXELS_API_KEY` unset | Pexels source skipped silently; covers behave exactly as before that change |
| Amap POI `photos` empty or name mismatch | `pickPhoto` → `null` (negative-cached 24 h) → wiki |
| Amap search quota exhausted (`status≠1`) | `null`, not cached, one `[amap-photo]` warn; later candidates fall through |
| `payload.amapPhoto` already set | read from the DB — no request, never overwritten |
| `saveAmapPhoto` write fails | warn only; this generation keeps the working URL and continues |
| Pexels results carry no textual match | `pickCover` → `null` (negative-cached 24 h) → Amap → wiki |
| Pexels budget exhausted (8 per generation / 180 per hour) | `null` without a request; later candidates fall through |
| `canonical_places` query throws | `loadPlaceFacts` warns and returns an empty Map → `null`; generation continues |
| City argument empty | `createStoredCoverLookup` returns `null` without touching the DB |
| `MEDIA_BASE_URL` empty string | `str()` falls back to `/media`; URLs stay same-origin |
| `data/media` missing at boot | `/media` route not registered; nothing else changes |
| key in DB but file missing | `/media/...` → 404 → `PoiCard` `onerror` → category placeholder |
| place id not in `canonical_places` (wrong run order) | importer skips it and warns; exits 0 |
| importer rerun | `payload \|\| jsonb_build_object('coverImage', key)`; other payload keys untouched |
| first candidate has no cover / no matching row | later candidates still query the full city index |
| duplicate place entries in image manifest | first entry wins; repeated import is idempotent |
| upstream source image missing/unreadable | count as `skipped`, keep going; manifest lists only written files |

### 5. Good / Base / Bad Cases

- Good: 杭州 exports 34 covers (4.6 MB after webp q80, ~137 KB each); 33 land on existing rows; a
  generated 杭州 trip renders `/media/xhs/杭州/{placeId}/00.webp` with no wiki request.
- Base: a city with no exported images behaves exactly as before — wiki fallback, then the category
  icon.
- Bad: exporting upstream's `canonical_place.id` (auto-increment) as `placeId` — every row misses and
  the importer reports「不在库里」for the whole city.

### 6. Tests Required

- `apps/server/src/__tests__/storedCover.test.ts` — key→URL joining for `/media`, absolute CDN base,
  trailing slash, leading slash on the key, empty key → `null`, empty city → `null` without a query.
  Also cover multiple sequential/concurrent names after a first miss, shared loading across the
  three readers, aliases, city isolation, and real database full-index/subset boundaries.
- `apps/server/src/__tests__/imageImport.test.ts` — real seed scripts in a disposable database:
  retain both image fields through place re-import, refresh other payload fields, first-image
  selection and idempotence. Never run against application data.
- `apps/server/src/__tests__/exportFiles.test.ts` — `xhs-place-images-*.json` is recognized as its own
  source with `rowCount` from `images`, and is NOT swallowed by the `xhs-places*` pattern.
- `apps/server/src/__tests__/placeLookup.test.ts` — a stored `/media/...` value is accepted and no
  wiki request is made.
- `apps/server/src/__tests__/placeFacts.test.ts` — `mergeFacts` picks up `coverImage` from any member;
  the value stays a relative key. DB-backed assertions skip when no covers were imported.
- Assertion points: the resolved `poi.coverUrl` string and the recorded wiki-query list.

### 7. Wrong vs Correct

```typescript
// Wrong: absolute URL in the payload. Switching storage (or just running locally vs in prod)
// then requires a full re-import, and localhost leaks into production data.
payload.coverImage = 'http://localhost:3001/media/xhs/杭州/8f3a/00.webp';

// Correct: relative key; the prefix is applied at read time.
payload.coverImage = 'xhs/杭州/8f3a1b2c/00.webp';   // mediaUrl() → `${MEDIA_BASE_URL}/xhs/…`
```

```typescript
// Wrong: reusing the wiki-path check for a stored cover — isHttpUrl() drops the same-origin path,
// so every stored cover silently falls through to the (blocked-in-China) wiki lookup.
if (stored && isHttpUrl(stored)) return stored;

// Correct: accept same-origin absolute paths too.
if (stored && isUsableCoverUrl(stored)) return stored.slice(0, 300);
```

Representative paths: `apps/server/src/generation/storedCover.ts`,
`apps/server/src/generation/tools/researchTools.ts`, `apps/server/scripts/seed-xhs-place-images.ts`,
`apps/server/scripts/lib/exportFiles.ts`, `apps/server/src/index.ts`, `docker-compose.yml`,
`apps/server/src/integrations/pexels/cover.ts`, `apps/server/src/lib/placeKey.ts`,
`xhs-travel-pipeline/scripts/export_place_images.py`.

## Upstream content and entity repair (2026-10-02)

### 1. Scope / trigger

Community extraction, canonical export, library import, SQL/vector retrieval and itinerary copy share one entity/content contract.

### 2. Signatures

- `reconcileImportedPlaces(client, city, places)` executes inside the seed transaction.
- `purifiedIntro(payload)` reads version 1 content; `cleanResearchIntro(raw)` trims and bounds complete sentences to 200 characters.
- Upstream `canonical_place.content_profile` stores a nullable JSONB profile. Offline refinement emits a preview report before writes, and can apply/restore reports with a before-value comparison.

### 3. Contracts

`payload.content` contains `{version:1,intro,highlights:[{text,quote,sourceUrl,observedAt,strength}]}`. Longer offline profiles also carry `profileVersion:1,qualityVersion:2,method,compiledAt`. Aim for 120–180 Chinese characters where evidence permits; shorter descriptions are valid. Do not invent facts to meet a length target. Research tools prefer this intro over model-supplied copy, and scheduling copies it intact. Policies remain separate from descriptive content. Upstream heuristics validate provenance and reject known policy/marketing patterns; they do not prove factual correctness, so repair previews need source and editorial review.

The complete-intro job now searches and fetches web pages, with model knowledge supplying stable background. XHS supplies experience, warnings and other practical fields, not the encyclopedia intro. A web sentence can have `basis:'web',citations:[{quote,sourceUrl,observedAt}]` for several real excerpts. The legacy `quote/sourceUrl` is the first citation. A model-background sentence has `basis:'model_knowledge',quote:null,sourceUrl:null,strength:'unverified'`; never invent a citation. `purifiedIntroSources` expands all nested citations, validates HTTP(S) URLs and deduplicates them; no source link is synthesized for model knowledge. Export/import preserves the entire profile and downstream still copies the intro unchanged.

`identity:{version:2,entityId,revision,canonicalName,memberNames,memberIds,kind}` declares explicit city-scoped ownership. The v1 format remains import-compatible but cannot overwrite governed v2 identities. Synonyms go into `aliases`; constituent venues go into `components` with independent policy/evidence. Tiananmen uses a single planning entity, while square/tower policies retain their scope. Do not infer equivalence by distance or substring. See [place-identity.md](place-identity.md).

Import refreshes authoritative upstream content/policy fields even on golden-set rows. Old matching rows receive `canonicalRedirectTo`; retain IDs, provenance and all independently stored photo fields. Both SQL and vector retrieval, place-fact loaders and library browsing exclude redirected rows. Queries against `memberNames` still resolve to the root. Old saved trip snapshots remain unchanged.

### 4. Validation and errors

| Condition | Behavior |
| --- | --- |
| Conflicting ownership / malformed identity | Reject and roll back the entire import transaction |
| No reliable content | Model fallback; never fabricate a profile or pad text |
| Required reservation with “无需预约” | Unknown; retain evidence and ask readers to verify separately |
| Complex entity with tower closure | Keep closure on component; never assign to root |
| Repeated import | Same roots/redirects; keep photos and IDs |

### 5. Good / base / bad cases

Good: 奥森 → 奥林匹克森林公园, 天安门城楼 → 天安门, with separate tower policy. Base: missing content uses existing research fallback. Bad: treating 奥林匹克公园 as an alias of the forest park, or retaining stale golden-set policy after reimport.

### 6. Tests

`placeImportIdentity.test.ts` uses an isolated database to assert import/rerun, conflict rollback, photo preservation, alias lookup, component closure isolation and complete description propagation. `researchQuality.test.ts` explicitly verifies that downstream does not remove policy-keyword sentences.

### 7. Wrong vs correct

Wrong: truncate a sourced intro to 60 characters, then delete sentences containing “门票”; merge tower closure into a square. Correct: purify and review upstream, keep the full intro downstream, and preserve policies under their actual constituent entity.

Read-only audit: `node --import tsx apps/server/scripts/audit-xhs-images.ts --city 杭州
--trip-id <id> --out <report.json>`. Optional `--pipeline-root` defaults to the sibling pipeline
repository. It reads each project's `.env` without importing the migrating database bootstrap,
uses read-only transactions, and reports link/classification/assignment/export/import/trip
coverage without contacting external providers. Counts of images in notes mentioning a place
are only attribution candidates, not confirmed images of that place; do not sum overlapping
per-place counts as unique images.

## Ranked photography gallery contract (2026-10-01)

### 1. Scope / trigger

The upstream photography manifest now supplies an ordered gallery. This contract spans export, import, place facts, generation and saved trip snapshots.

### 2. Signatures

- `imageGroups(value: unknown): Map<string, StoredImage[]>` validates the exported `images` array.
- `readImageGallery(value: unknown): StoredImage[]` reads persisted optional data.
- `seed-xhs-place-images.ts` stores `payload.coverImage` and `payload.imageGallery` for the manifest city.
- `createStoredPlaceLookups(city).photosFor(name)` supplies stored photos to research; curated manual photos retain priority.

### 3. Contracts

`imageGallery` holds at most three `{ key, attribution?, provenance? }` entries in selected order. The first key is `coverImage`; exported `placeId` uses the persisted entity ID shared with the places export. `provenance` retains original source, author, note/image index, model review and rights. Keys are safe relative WebP paths, including immutable `xhs/photography/<placeId>/<contentHash>.webp` keys. Existing `MEDIA_BASE_URL` maps these keys to local or remote media.

Photography entries require `reviewMethod=model`, `review.status=eligible`, `review.identity=match` and an HTTPS `www.xiaohongshu.com/explore/<id>` source. Attribution uses `source=xhs`, `license=未确认授权`; model review never implies a copyright license or human approval. Place reimport must retain both cover and gallery. New generation snapshots copy ordered photos; historical trips never change merely because the library was refreshed.

### 4. Validation and errors

| Condition | Result |
| --- | --- |
| Malformed manifest, unsafe path or photography missing review/source | Reject import before database writes |
| Duplicate key / more than three entries | Deduplicate and keep first three in source order |
| Missing or invalid legacy gallery | Read as empty; use existing single cover/fallback |
| Place outside manifest city | Do not update |
| Valid source excluded by frontend URL allowlist | Bug: synchronize `PhotoCredit.safeCreditUrl` when adding providers |

### 5. Good / Base / Bad cases

- Good: two selected photos import in order with independent attribution and complete provenance.
- Base: old payload contains only `coverImage`; existing rendering remains supported.
- Bad: photography manifest says only “note mentions this place” without an eligible identity review; reject it.

### 6. Required tests

`imageGallery.test.ts`, `imageImport.test.ts` and `storedCover.test.ts` assert malformed inputs, city isolation, reimport retention, cover-first order and attribution. Actual export-to-disposable-database verification and browser gallery switching must also cover per-photo credits and zero writes while browsing.

### 7. Wrong vs correct

```typescript
// Wrong: drops alternatives and erases gallery provenance on place reimport.
payload = { ...incoming, coverImage: old.coverImage };
// Correct: retain both optional stored-image fields in the reimport merge.
payload = { ...incoming, coverImage: old.coverImage, imageGallery: old.imageGallery };
```

## Scenario: Retrieval Quality Baseline (2026-10-11)

### 1. Scope / Trigger

Apply when changing the literal-layer quality probe (`eval/retrievalQuality.ts`,
`scripts/retrieval-quality-baseline.mts`) or the metrics it reports. Motivation: retrieval quality
was unmeasurable — `RetrieveOptions.onDiagnostics` was collected but had no consumer, and neither an
annotation set nor a single assertion existed.

### 2. Signatures

- `npm run eval:retrieval [--out <dir>] [--variants <path.json>]` → `node --import tsx scripts/retrieval-quality-baseline.mts`
- `realAliases(row: PlaceCoverageRow): string[]`
- `literalCoverage(rows: readonly PlaceCoverageRow[]): LiteralCoverage`
- `recallMetrics(cases: readonly RecallCase[], depth = 8): RecallMetrics` — includes `mrr`
- `retrievalQualityReport(rows, cases, depth?)` / `renderRetrievalQuality(report, missLimit = 10)`
- `parseVariantSpecs(raw): VariantSpec[]` / `configFingerprint(config): string` /
  `renderVariantComparison(report)`
- `VariantSpec = { label, vector: 'off' | 'auto' | 'force', limit? }` — unknown keys are rejected
- `ChannelStats = { keywordHits, vectorHits, vectorSelected, embedFailures, skippedFilled }`
- `PlaceCoverageRow = { id, city, name, category, source, payload, hasEvidence }` — payload carries
  only `aliases` / `themes`, never `content`
- `RecallCase = { city, query, expectId, expectName, hitGroups, actualNames }` — `hitGroups` is one
  id set per returned entity, in result order
- `--out <dir>` writes `<dir>/report.json`; default mode = `{ coverage, recall }`, variant mode =
  `{ coverage, subsets, variants }`

### 3. Contracts

- Read-only by construction: `options: '-c default_transaction_read_only=on'`, never imports the
  migrating `db/client`, never migrates, and wires `embed: async () => null` so no vector request can
  escape. No LLM, embedding or map calls.
- **Full execution, no sampling.** Queries are every `source='goldset'` name plus each place's first
  real alias. 2026-10-11 baseline: 378 queries (111 active goldset + 267 real-alias places). A
  `ORDER BY random()` sample makes two runs incomparable — do not reintroduce it.
- **Real alias** = an element of `payload.aliases` whose trim differs from the trimmed place name. An
  `aliases` array holding only the main name is a filled field, not alias coverage: 5181 active rows
  carry the field (98.5%) but only 267 (5.2%) carry a real alias.
- **Hit test uses `canonicalPlaceId`**, never member row ids — see Wrong vs Correct.
- Reports are deterministic: no timestamp or duration is written, so `report.json` is byte-identical
  across runs on the same knowledge base.
- Boundary: this is NOT part of the `eval/` harness, gates nothing, and its default mode runs with
  vectors off. It measures the literal layer only and does not prove semantic recall.
- **`--variants` is the only mode that makes external calls.** A non-`off` variant really calls the
  site `embedQuery`; the default path imports no embedding client at all. Variant definitions are
  rejected on unknown keys — silently ignoring one makes a parameter look applied when it is not.
  The same rule applies to CLI arguments.
- **Variant mode runs two subsets.** `regression` = goldset names + first real alias (availability
  gate, already 100% literal). `literalFail` = `research_evidence.content` rows whose text does not
  contain the place name (`strpos = 0`, length ≥ 25, longest per place) — the only subset where a
  vector delta can appear, because the regression subset is already saturated.
- **Method limit:** `literalFail` measures 「笔记描述 → 找到地点」, not 「用户搜索意图 → 找到地点」.
  Real users do not copy note text, so its recall is neither an upper nor a lower bound; its only job
  is to be a reproducible「literal must fail, semantic may succeed」contrast.
- **`vectorSelected` is not a quality metric on its own.** Recalling 48 rows and returning 8 is
  `limit` truncation, not a ranking failure — the recall SQL caps at 48 and the result caps at
  `limit`. Only cross-variant comparison on the same subset carries information.

### 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| `DATABASE_URL` missing | exit 2 with the config hint; no connection attempt |
| Database unreachable or a query fails | message + exit 1; no partial report written |
| `--out` without a directory | exit 2; report not written |
| No place has a real alias | `recall.total = 0`; percentages render `—`, never 0% |
| Place redirected or unverified | excluded by the active filter, same as retrieval |
| Test-residue city (`金集新增-…`) present in the library | reported as-is; it is real database content |
| `--variants` file missing or not valid JSON | exit 1 with the parse error; no report written |
| Variant has an unknown key, duplicate `label`, or bad `vector` / `limit` | exit 1 naming the offending variant; no report written |
| Unknown CLI argument | exit 1 listing the allowed flags |
| `MASTER_KEY` missing while a vector variant loads the embedding client | the import throws before any retrieval; set the env or run with `--env-file` |

### 5. Good / Base / Bad Cases

- Good: all 378 literal queries return the target at rank 1 while real-alias coverage stays at 5.2% —
  the report shows the bottleneck is coverage, not ranking.
- Base: a city with no real aliases contributes coverage rows but no recall queries.
- Bad: reading `Recall@8 = 100%` as “retrieval is fine”. It only says the 267 registered aliases
  resolve; 94.8% of places have no alias to resolve, and `themes` covers 30.5%.
- Good (variant mode, 2026-10-12): `literalFail` goes from 0.0% / 0.0% (`off`) to 10.2% / 28.2%
  (`force`) while `regression` stays 100% in every variant — the report proves the vector channel
  pays off without regressing the registered aliases.

### 6. Tests Required

`eval/tests/retrievalQuality.test.ts` (inside `npm run eval:test`): an `aliases` array holding only the
main name yields no real alias; whitespace and non-string entries are dropped; coverage separates
real-alias from field-fill and groups by city and same-city duplicate name; recall ranks by canonical
id sets and honours `depth`; **the denominator is the executed query count, not the sampled row
count**; `renderRetrievalQuality` shows coverage, recall and the miss list.
`apps/server/src/__tests__/placeVectorRanking.test.ts`: literal-empty results rank by vector
`distance` (not by heat score or the `detail` penalty); literal hits keep their rule-score order
with vectors appended; `auto` with a full keyword page reports `skipped:filled` and makes no
embedding call; `vectorHits` may exceed `vectorSelected` when `limit` truncates.
`eval/tests/retrievalQuality.test.ts` also covers `parseVariantSpecs` rejecting unknown keys /
duplicate labels / bad values, `configFingerprint` ignoring key order, and the per-subset delta plus
channel-stat lines in `renderVariantComparison`.

### 7. Wrong vs Correct

```typescript
// Wrong: RetrievedPlace has no `ids` — withEvidence() drops rankPlaces()'s member ids.
// This throws "hit.ids is not iterable" the moment a hit is evaluated.
const rank = hits.findIndex((hit) => hit.ids.includes(target.id));

// Correct: the canonical entity id survives same-entity merging and is the only stable hit key.
const rank = hits.findIndex((hit) => canonicalPlaceId(hit) === canonicalPlaceId(target));
```

```typescript
// Wrong: samples skipped inside the loop still counted in the denominator — reported a fake 8%.
for (const row of rows) { if (!realAliases(row).length) continue; if (hit) atDepth += 1; }
return atDepth / rows.length;

// Correct: the denominator is what actually ran.
return atDepth / cases.length;
```

## Scenario: Vector Channel Ordering (2026-10-12)

### 1. Scope / Trigger

Apply when changing how the vector channel's results are ordered or diagnosed in
`generation/placeRetrieval.ts` / `generation/retrievalRanking.ts`.

Measured on 2026-10-12 with `eval:retrieval --variants` over 489 `literalFail` queries: the vector
channel recalled the target in the top 8 for 24.0% of them under the rule-score order, but 27.3%
under a pure distance order — and 2.7% vs 11.3% at rank 1. The channel was working; the ranking was
discarding its output.

### 2. Signatures

- `groupPlaces(rows: readonly PlaceRow[]): RankedPlace[]` — entity merging, extracted from
  `rankPlaces` so both rankers share it
- `rankPlacesByDistance(rows: readonly PlaceRow[], limit: number): RankedPlace[]`
- `RetrievalDiagnostics.vector` adds `'skipped:filled'` to the existing
  `'off' | 'unavailable' | 'used' | 'failed'`
- `RetrievalDiagnostics.vectorSelected: number`

### 3. Contracts

- **When the literal layer returns nothing, do not rank by rule score.** With no `exact` / `prefix`
  hit there is no evidence signal left: `poiScore` is heat and mention volume (max 108), the
  `distance` term is inert without `exact`, and `detail` / `parent` subtractions (up to -145) fire
  on names alone. The observed effect was a target at distance rank 1 landing outside the top 8.
  `rankPlacesByDistance` sorts by `distance` ascending, `Infinity` last, then name and id.
- **The rule score stays authoritative whenever the literal layer matched anything.** This is a
  narrow branch, not a fusion-weight rewrite: no cross-channel normalization, no new weights, and
  `exact +200` / `prefix +65` are untouched. `auto` still appends; `force` still re-ranks.
- **`skipped:filled` is not a failure.** `auto` intentionally skips vectors once the deduplicated
  keyword page fills `limit`; reporting it as `off`/`failed` hides the designed path.
- Known boundary: only the literal-empty case is repaired. A query where the literal layer returns
  one weak hit still lets heat and detail penalties decide the rest of the page.

### 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Literal rows empty, vector available | `rankPlacesByDistance`; `vectorSelected = limit` |
| Literal rows empty, vector unavailable | `selected` stays empty; no fallback noise |
| Literal rows present | unchanged `rankPlaces` path in both `auto` and `force` |
| Keyword page already fills `limit` under `auto` | vectors never requested; `vector='skipped:filled'` |
| Same-entity members scattered across the vector page | merged by `groupPlaces`, `distance` kept at the minimum |
| Every candidate lacks `distance` | all sort equal; name/id decide the order |

### 5. Good / Base / Bad Cases

- Good: 「免费开放，鸿恩阁傍晚可拍秋日余晖和夜景，公园较大穿舒适鞋」returns 鸿恩寺森林公园.
- Base: a query whose literal layer already matched keeps the exact-alias ordering byte-identical.
- Bad: ranking a literal-empty page by heat score — the hottest POI wins regardless of semantic fit.

### 6. Tests Required

`apps/server/src/__tests__/placeVectorRanking.test.ts` pins all four: distance ordering when literal
is empty, rule ordering preserved when it is not, `skipped:filled` without an embedding call, and
`vectorHits > vectorSelected` under a tight `limit`. Assertion points are the returned id order and
the recorded `RetrievalDiagnostics`.

### 7. Wrong vs Correct

```typescript
// Wrong: literal found nothing, so every rule-score input is noise — yet it still decides the page.
const merged = rankPlaces([...unique.values()], terms, preferences, limit);

// Correct: narrow the behaviour change to the case that has no literal signal at all.
if (!selected.length) selected = rankPlacesByDistance([...unique.values()], limit);
else { /* unchanged rankPlaces path */ }
```

```typescript
// Wrong: collapsing a designed skip into the same bucket as a failure hides both.
if (selected.length >= limit) diagnostics.vector = 'off';

// Correct: name the three outcomes separately.
// 'skipped:filled' (design) / 'unavailable' (no client) / 'failed' (error)
```

## Scenario: Media Object Storage (MEDIA_STORE=local|s3)

### 1. Scope / Trigger

Apply when changing where image bytes or `data/photo-store` indexes are read/written:
`lib/mediaStore.ts`, `lib/dataStore.ts`, the `/media` route, image cache/write paths
(`photoStore`, `wikimedia/imageCache`, `curatedPhotos`, `services/sharePosterStore`), the photo
review pipeline, or the `MEDIA_STORE` / `MEDIA_S3_*` / `MEDIA_BASE_URL` env pairs.

### 2. Signatures

- `MediaStore` (`lib/mediaStore.ts`): `put(key, bytes, { contentType?, cacheControl? })`,
  `get(key) → Buffer | null`, `delete(key)`, `exists(key)`, `list(prefix) → { key, size }[]`.
- `createLocalMediaStore(root)` maps a key to `path.join(root, ...key.split('/'))`;
  `createS3MediaStore({ endpoint, bucket, accessKeyId, secretAccessKey, region, timeoutMs })`
  signs with `aws4fetch` and uses the global `fetch`.
- `normalizeMediaKey(key)` strips a leading slash and rejects empty/`.`/`..` segments or any
  character outside letters, digits, `_./-`.
- `mediaCacheControl(key)` and `mediaContentType(key)` derive response metadata from the key.
- `dataStore` (`lib/dataStore.ts`) is the process instance: local over the repository `data/`
  when `MEDIA_STORE` is unset, S3 otherwise. `mediaObjectKey(value)` normalizes `xhs/…`,
  `/media/xhs/…` and a full `MEDIA_BASE_URL` URL to the object key `media/xhs/…`.
- `env.mediaStore` ← `MEDIA_STORE` (`local` default) plus `MEDIA_S3_ENDPOINT` / `MEDIA_S3_BUCKET` /
  `MEDIA_S3_ACCESS_KEY_ID` / `MEDIA_S3_SECRET_ACCESS_KEY` / `MEDIA_S3_REGION` (default `auto`).
  `s3` mode requires all four credentials at startup.

### 3. Contracts

- **The storage root is `data/`.** Media objects are keyed `media/<relative key from the DB>`;
  index objects keep their original path (e.g. `photo-store/review-jobs/<sha>.json`). The bucket
  layout therefore mirrors the disk, and migration is `aws s3 sync data/ s3://<bucket>/`.
- Both stores expose the same semantics, so the object key is the only thing callers pass around —
  module signatures take a `MediaStore` (default `dataStore`) instead of a `dataRoot` string.
- Keys stay relative. `MEDIA_BASE_URL` is applied at read time by `mediaUrl()`, so switching
  between same-origin `/media` and an R2 custom domain never re-imports the database.
- An R2 custom domain maps the bucket root, so the CDN prefix is `https://<domain>/media`
  (`/media` is part of the object key, not a route).
- `/media/*` never reaches `photo-store/`: the route only ever calls `get('media/' + key)`, so
  index objects are structurally unreachable through HTTP — no key allowlist needed. The R2 custom
  domain, however, exposes the whole bucket root: `photo-store/…` objects stay non-enumerable
  (sha256 file names) and hold no secrets, which is the accepted trade-off; do not put credentials
  or personal data under the storage root.
- Poster URLs also follow `MEDIA_BASE_URL`: `trip_share_images` stores only `fileName`, and
  `sharePosterUrl(fileName, base = env.mediaBaseUrl)` builds the URL at read time, so posters are
  served by the CDN like every other image. The same-origin `/media/share-posters/…` path keeps
  working (the Node route reads the same object), which is what the download fallback uses.
- Because posters are now optionally cross-origin, downloads must **fetch bytes and hand the browser a
  blob URL** — `a[download]` is ignored for cross-origin targets. `downloadShareImage` tries
  `MEDIA_BASE_URL` first, then the same-origin path, and returns whether a download actually started
  (the completion notification text depends on it). `<img src>` previews and the WeChat long-press-save
  guide are unaffected. The bucket needs a CORS rule: `origins: ["*"]`, `methods: ["GET","HEAD"]`
  (objects are public and the fetch sends no credentials). A response cached *before* CORS was added
  has no `Access-Control-Allow-Origin`; purge those URLs or let them expire.
- `SHARE_POSTER_URL_PATTERN` accepts both `^(?:https?://host)?/media/share-posters/<sha256>.<ext>$`
  forms, because the host is whatever `MEDIA_BASE_URL` points at. Anything else (wrong path, non-hash
  filename, query string) is rejected by `TripShareImageResponseSchema` on both ends.
- Only media belongs under the storage root. `data/media` is published by the CDN as-is, so a stray
  HTML/script file there becomes a public page on the CDN host (one such artifact was migrated and
  removed from the bucket); keep review/preview artifacts in `data/photo-pilot` or outside `data/`.
- `createLocalMediaStore` writes through `<file>.<uuid>.tmp` + rename. Concurrent writes to the **same**
  key do happen (upstream re-exports reuse `xhs/…/00.webp`), and on Windows that rename occasionally
  fails with a transient `EPERM` while another writer holds the target — retry with backoff, and only
  treat `EEXIST` as "target exists and was not replaced" (unlink first). Without the retry the local
  store throws under concurrency and the unit test flakes (~15/40 stress rounds failed before the fix).
  `MEDIA_STORE=s3` stores do not have this issue (S3 PUT overwrites atomically).
- Sizing report (no cleanup): `node --import tsx apps/server/scripts/migrate-media-to-s3.mts --report`
  prints per-prefix object counts and bytes plus the share of the R2 free tier. Nothing expires
  objects: only replaced posters are deleted, so `media/remote-photos` and the index JSONs grow
  monotonically.
- Migration: `node --import tsx apps/server/scripts/migrate-media-to-s3.mts` (dry run) and `--apply`
  (upload). Idempotent by comparing the object's **ETag (content md5, quoted by S3)** with the local
  file's md5 — index JSONs are rewritten in place and may keep the same byte length, so a
  size-only check silently keeps stale indexes. Without an ETag (multipart upload) it falls back to
  size, prints keys that exist only in the bucket (never deletes), and loads both `.env` files
  explicitly so it works from any cwd.
- **Do not use `process.exit()` after network work in Windows scripts**: it trips a libuv assertion
  (`!(handle->flags & UV_HANDLE_CLOSING)`) while undici keep-alive sockets are still open. Set
  `process.exitCode` and let the process end naturally; early guards before any I/O may still exit.
- **Failure semantics follow the integration boundary**: a missing object is `null`/`false`;
  network, auth and 5xx failures throw so the caller degrades an optional photo source instead of
  silently reporting "this place has no image".
- `xhs/…/NN.webp` is not content-addressed and is overwritten by upstream re-imports, so its
  `Cache-Control` is one day; content-addressed file names (`<sha256>.<ext>`, `xhs/photography/…`)
  are `immutable` for a year.
- Per-directory size caps are gone. The old 256 MiB `MAX_CACHE_BYTES` guard silently refused new
  images once full (production had reached 268,432,913 / 268,435,456 bytes) because content-addressed
  writes can never duplicate existing objects.

### 4. Validation & Error Matrix

- `MEDIA_STORE=s3` with any of the four credentials missing → startup error listing the variables.
- `MEDIA_STORE` outside `local|s3` → startup error.
- Key with a traversal segment, a space, a backslash or a `%` → `normalizeMediaKey` returns `null`;
  `put` throws and `get`/`mediaObjectKey` return `null` rather than guessing a path.
- Object missing → `/media/...` 404 → `PoiCard` `onerror` → category placeholder.
- `data/media` missing at boot in local mode → `/media` route not registered; nothing else changes.
- S3 404 on `get`/`list` → empty result; 403 is NOT treated as missing (it may be a policy denial).
- Migration script: a transient network failure while listing a large prefix aborts with
  `列出桶内 … 失败：fetch failed` after the built-in retries; rerunning is safe because the run is
  idempotent and read-only until `--apply`.

### 5. Good / Base / Bad Cases

- Good: `MEDIA_STORE=s3` + `MEDIA_BASE_URL=https://media.example.com/media`; new Pexels/Wikimedia
  picks and posters land in the bucket, new trips render the CDN host, historical snapshots still
  contain `/media/...` and keep working through the store-backed route.
- Base: `MEDIA_STORE` unset — byte-for-byte the previous disk behaviour, and the whole photo suite
  runs in seconds against a temp directory with `createLocalMediaStore(root)` injected.
- Bad: reading `data/media/wikimedia` back with `path.join(root, 'media', relative)` while writing
  through the store. That is the removed hedge that made the container's read-only mount look like
  "the source has no photos".

### 6. Tests Required

- `apps/server/src/__tests__/mediaStore.test.ts` — key normalization, atomic overwrite, concurrent
  writes, traversal rejection, local store roundtrip.
- `apps/server/src/__tests__/s3MediaStore.test.ts` — SigV4 request shape (`AWS4-HMAC-SHA256`,
  `auto/s3/aws4_request`), single percent-encoding of a Chinese key, 404 → null, 5xx → throw,
  `list` pagination plus ETag parsing, `mediaObjectKey` normalization. Stub `globalThis.fetch`;
  never call a real bucket.
- Photo pipeline tests inject `createLocalMediaStore(<temp dir>)`; a test that also asserts on files
  under `<temp dir>/media` or `<temp dir>/photo-store` keeps working because the local store writes
  exactly that layout.