# Evaluation Execution Contract

## 1. Scope / Trigger

Applies to `eval/`, its npm commands and `.github/workflows/{ci,eval-live}.yml`.
This is the operational harness; offline final-Trip replay does not execute the current generator.

## 2. Signatures

- `npm run eval -- [--suite smoke|full|matrix|notes] [--city city] [--case id] [--snapshots dir] [--baseline report-or-dir] [--out dir]`
- `npm run eval:live -- [--suite smoke|full|matrix|notes] [--city city] [--case id] [--knowledge golden|empty|frozen] [--knowledge-snapshot dir] [--skip-vectors] [--allow-no-geo] [--timeout-ms n]`
- `npm run eval:knowledge:export -- --name new-version [--cities 北京,上海] [--without-vectors] [--out root]`
- `npm run eval:knowledge:verify -- --snapshot dir [--skip-vectors]`; `npm run eval:knowledge:verify -- --self-test`
- `loadKnowledge(mode, { snapshot?, skipVectors?, cities? })`; `seedFrozen(pool, snapshot, skipVectors)`
- `npm run eval:retrieval [--out <dir>]` — literal-layer retrieval quality, standalone (see [RAG retrieval guidelines](./rag-guidelines.md))
- `npm run eval:diff -- <baseline> <candidate> [output-dir]`
- `npm run eval:accept -- <reviewed-run> <new-name>`
- `npm run eval:test`; `EVAL_PG_ADMIN_URL=... npm run eval:verify`
- `EVAL_PG_ADMIN_URL=... npm run eval:flow [--no-browser|--list]`: current product-flow verification, separate `flow-report.json/md` and per-stage logs.
- `npm run eval:verify -- --research-response tool|text-first|text-only` (local mock submission scenarios)

## 3. Contracts

- `contracts.ts` owns TypeBox validation for persisted snapshots, manifests and reports. Legacy snapshots remain readable; new snapshots use schemaVersion 3. Missing observations are null/unavailable, never invented zeroes.
- Live requires explicit local `/postgres` `EVAL_PG_ADMIN_URL`; URL query overrides and application database names are rejected before importing app modules. Never fall back to `DATABASE_URL` or `DATABASE_PATH`.
- Create a random `tripweaver_eval_<24 hex>` database before importing `db/client`; override `DATABASE_URL`/`MASTER_KEY`, disable implicit dotenv reload, seed the isolated user and versioned knowledge, close Pool then delete only that owned database. Preserve a failed run even when setup or cleanup fails.
- `fixtures/places.json` is fixed historical goldset data, not proof of current opening/reservation facts. `golden`, `empty` and `frozen` are explicit, separately hashed conditions. Frozen knowledge broadens candidate data; it does not expand the fixed evaluation requests. No user-data copy or automatic production export.
- Frozen exports use a raw `pg.Client` with startup read-only mode and a single `REPEATABLE READ READ ONLY` transaction. Never import application `db/client` or migrate the source. Source URL is explicitly `EVAL_SOURCE_DATABASE_URL` or application `DATABASE_URL`; shell overrides server dotenv then root dotenv. It is separate from the target admin URL.
- Export only canonical places, linked evidence (plus selected-city unlinked evidence), and place relations. Preserve stable IDs, timestamps, verification/redirect state, required payload fields and optional vectors. `KNOWLEDGE_PAYLOAD_KEYS` is the allowlist; no user tables, raw author/note payloads or media assets. Sort rows by ID and normalize timestamps. Store source fingerprint only, never source credentials.
- `frozenKnowledge.ts` owns the TypeBox file contract, content hash, ID/reference/city/payload/date/vector checks and gzip size limits. Same-name versions never overwrite. Frozen data is local/ignored under `eval/knowledge-snapshots`; each run copies its compressed input and summary into `knowledge/`.
- Frozen imports require a random eval database name and empty knowledge tables, and use one atomic parameterized transaction. Existing vectors require matching target pgvector dimensions. Explicit `--skip-vectors` drops vectors on import, disables live query embedding, and changes the effective knowledge hash; never silently downgrade. Check configured query model against the recorded snapshot model when enabled. Validate selected case cities before generation.
- Each run writes only its new `eval/runs/<id>/`: manifest, snapshots, per-case status, JSON/Markdown report, safe live event summaries. Never overwrite `eval/snapshots` or accepted baselines during evaluation.
- Live collects cumulative usage (last event), phase durations keyed `phase#round`, candidate events and terminal duration. Research must be nonempty and three phases plus token/provider counts and `execution` present. Errors retain partial event summaries. Provider counts mean accepted wrapper attempts, not bills/confirmed network requests.
- Live event artifacts retain tool names/error flags/durations and LLM phase/turn/stopReason/error-presence/HTTP-status metadata; never copy their raw args, prompts, response text or error body. Error/cancel terminal durations are retained too. Eval timeout sets cancelReason=timeout and reports the configured case limit.
- Runtime/prompt/check/dataset/knowledge hashes and HEAD/dirty identify provenance. Model settings summaries contain no credentials. Do not persist raw model requests or provider error bodies. Photos/weather are disabled and recorded as such for this suite.
- PASS requires no hard/structural/geo violations, no current-flow FAIL and all selected cases present without errors. Soft and performance stay observational. Budget is a removed feature: never calculate budget/cost scores or missing-cost warnings. Keep raw legacy fields readable and unchanged; `evaluationInput` excludes `budgetLevel`/`totalBudget` and normalizes absent pace/transport defaults for input/dataset comparison. Hash the full raw snapshot separately for integrity. Compare by caseId; changed inputs/checks/modes/knowledge or provider enablement are incomparable. Do not silently compare just the intersection or subtract missing observations as zero.
- `coverage.ts` reflects current product behavior: blank activity times are expected for ordered itineraries; unspecified date or lodging makes those checks not applicable. Only specified lodging with missing routes is a degradation. Opening/calendar checks require usable inputs. These are scope notes, not missing product features or collection ERRORs. Include coverage/input/currentFlow and reused meal rules in `checksHash`; changed contracts make old reports incomparable until rechecked.
- Per-day activity time requires all valid spans; activity-to-activity travel requires every expected adjacent leg. Zero adjacent pairs (including single-stop remote days) produce null, not zero. Lodging duration requires both departure and return legs. Activity legs never imply known accommodation round trips or total day load. Synthetic meal-area coordinates are reference points, not confirmed restaurant access distances.
- `execution` is an additive optional field in v3 snapshots for legacy readability, required for NEW live evaluations. It records safe per-tool success/error counts, plan-phase LLM responses, terminal status, trip readback, successful audit row and overview/candidate equality. It never stores raw prompts or model/tool arguments. `currentFlow.ts` checks input preservation, successful retrieval/submission/system scheduling, zero plan LLM responses, identity/day indexes, food-driven meals, optional lodging, final leg references and persistence. Missing execution in historical offline snapshots is UNAVAILABLE, never invented success.
- Required step/result violations are FAIL; title/geo/repair enhancement failures are DEGRADED; a successful retry after a tool error is completed, not failed. Non-food forms do not require meals. A route to a no-longer-adjacent activity, unknown ID or duplicate leg is FAIL; genuinely missing legs follow the current enhancement degradation. Persistence validates the exact saved trip and one matching successful audit in the owned eval database. `RunCase.flow` and `limitations` stay optional for older reports.
- `eval:flow` runs the current user journey using maintained scripts: API/Brief inputs, SQL/semantic retrieval, scheduling, transactions/SSE/recovery, preferences, route options, weather, production build, current homepage and detail editing/history. Every database script owns a disposable database; one explicit local admin URL is forwarded, never the application database. The launcher disables implicit dotenv inputs, uses an invalid application DB fallback, preloads local-only fetch into descendants, and makes TSX config absolute across child working directories. Stage failures preserve logs and continue independent stages; failed builds skip dependent browser stages. Only all stages PASS means complete. `--no-browser` yields PARTIAL rather than complete evidence. This report is not a model-quality baseline.
- Markdown identifies actual selected case count within smoke/full and mode-specific execution. Offline reports load saved Trips only; timing/token values come from those snapshots and knowledge rows=0 must not be displayed as evidence of an empty source knowledge base. PASS means current decidable gates only. Adoption ratio means scheduled names matching the candidate pool, not candidate utilization or location accuracy.
- Accept only explicitly reviewed passing runs: validate report set, recheck current snapshots and hashes, refuse overwriting existing baseline names. Frozen runs must contain a valid matching knowledge file; check both snapshot and effective vector-condition hashes, then copy it into the baseline for independent retention. Baseline selection and Git acceptance are separate; never auto-accept/commit.
- Per-run PostgreSQL counters reset on new runs; EVAL_* budgets do not enforce a shared cross-run daily cap. Live has local file mutual exclusion and bounded per-case time. CI live is workflow_dispatch only and currently offers golden/empty; frozen live is a local CLI path. CI frozen verification uses synthetic isolated data only.
- Literal-layer retrieval quality is measured by `npm run eval:retrieval`, **not** by this harness: it reads the application database read-only, gates nothing, and its report is not an `eval/runs` report — `eval:diff` cannot consume it. Its name shares the `eval:` prefix but not the harness contract. Its `--variants <path.json>` mode runs an ablation matrix over `off` / `auto` / `force` and is the only mode that calls the site embedding client; the default mode stays zero-call. Variant definitions and CLI flags reject unknown keys, mirroring this harness's「未知参数不得静默忽略」rule.

## 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Bad CLI / unknown case | exit 2, never default to all cases |
| Missing snapshot | SKIPPED, gate fail, exit 1 |
| Malformed JSON/schema, form mismatch | ERROR, preserve input/diagnostic, continue other cases, exit 2 |
| Hard/structure/coordinate violation | FAIL, gate fail, exit 1 |
| Legacy observations missing | offline remains eligible for PASS; show unavailable |
| Live observations missing | ERROR rather than incomplete success |
| Setup/cleanup failure | complete case list + error report, exit 2 |
| Comparison incompatible/missing case | explicit INCOMPARABLE, exit 2 |
| New hard failure | REGRESSION, exit 1 |
| Failed/tampered baseline / duplicate name | reject acceptance |
| Frozen checksum/reference/city validation failure | reject before generation |
| Frozen target nonempty or outside eval name namespace | reject without importing |
| Missing/mismatched pgvector dimensions | error; explicit skip is a distinct condition |
| Enabled query model differs from recorded snapshot model | error; align model or explicitly skip |
| Baseline frozen file missing / effective hash mismatch | reject before creating baseline |

## 5. Good / Base / Bad Cases

Good: isolated current generation produces a new run; reviewer compares and explicitly accepts it.
Base: historical 9-case replay passes with missing timing clearly marked.
Bad: old snapshots pass and are described as current model quality; setting only DATABASE_PATH claims PostgreSQL isolation; live replaces baseline files before checking them.

## 6. Required Tests

`eval/tests/operational.test.ts`: failure continuation, input mismatch, hard violation, legacy vs live observability, malformed JSON preservation, CLI exit codes, comparison missing/incompatible data, baseline hash/refusal, connection preflight and redaction.

`eval/verify-live.mjs`: real local PostgreSQL with local mock model and controlled geocoding; preload denies application DB connections and public fetch; assert usage/phases/candidates, database/lock cleanup and no credential leakage. CI runs it independently of business verification.
`--research-response text-first` requires recovery through the real submission tool after one prose response; `text-only` requires explicit research failure before planning, no saved placeholder trip and exactly two research requests. Both check safe diagnostic events and database cleanup.

`eval/tests/frozenKnowledge.test.ts`: gzip roundtrip/no overwrite, checksum and payload privacy boundary, ID/reference/city validation, malformed vectors/timestamps, skip hash distinction and frozen baseline retention/rejection.

`eval/tests/coverage.test.ts`: expected blank clocks, optional date/lodging, single-stop null travel, separate lodging legs, area meals, no budget dimensions, live/offline text, selected suite scope and legacy compatibility.

`eval/tests/currentFlow.test.ts`: missing execution vs legacy replay, preserved inputs, preference-driven meals, no invented lodging, core failure vs optional degradation, restored tool success, stale/duplicate leg rejection, audit failure and legacy budget input invariance. `eval:verify` also asserts real saved audit/overview consistency and zero model planning responses.

CI runs full `eval:flow`, including Playwright with a production build. [Current feature coverage](../../../../eval/current-function-coverage.md) is the maintained map from current behavior to executable checks. A script referencing removed UI, in-place saves or old API error shapes must be updated to current contracts rather than weakening assertions or skipping it.

`eval/verify-knowledge.ts --self-test`: isolated synthetic source with private sentinels; export whitelist/city filtering/stable hash/unverified and redirect retention, nonempty target refusal, missing vector-column rejection before writes and explicit skip. `--snapshot dir`: import/re-export all row hashes, per-city retrieval, vector query, always close/drop the owned database. It uses pure migrations and explicit Pool dependencies, never application db/client.

Run `npm run typecheck`, `npm run eval:test`, `npm run eval`, and mock verification after harness/bootstrap changes. Run knowledge verification after export/import changes. Real provider invocation requires task authorization; mock evidence is not real-provider evidence.

## 7. Wrong vs Correct

Wrong: load app `.env`, set `DATABASE_PATH=eval.db`, import orchestrator.

Correct: validate explicit local admin URL, create owned PostgreSQL DB, override `DATABASE_URL` and dotenv reload before imports, seed fixed fixtures, always close/drop the owned DB.

Wrong: live writes `eval/snapshots/<case>.json` and silently replaces the baseline.

Correct: write `eval/runs/<runId>/snapshots`; compare independent runs; accept only after explicit review with a new baseline name.

Operator commands and limits: [eval/README.md](../../../../eval/README.md).

## Real city/preference/notes campaigns (2026-10-05)

### 1. Scope / Trigger

Explicitly authorized real-model expansion beyond the historical nine requests. The current frozen version has 12 regions; Yunnan is excluded by the user, leaving 11 cities and 88 preference scenarios plus eight Beijing note scenarios.

### 2. Signatures

- `eval:campaign -- --knowledge-snapshot dir [--out new-dir]`; `--resume existing-dir`; `--list`.
- `eval:campaign:report -- campaign-dir` builds coverage and unselected-place lists from finished batches.
- `eval:campaign:review -- --campaign dir [--watch] [--group id --out new-dir]` performs attributed model review.
- `eval:intent -- --snapshot file [--repeat 1|2|3] [--case id] [--out root]` calls production understanding with synthetic messages and a saved Trip.

### 3. Contracts

`scenarios.ts` owns the expanded cases; matrix IDs have a `matrix-` prefix to avoid collisions with goldset IDs. Historical inputs remain unchanged. Report/baseline suite handling uses this same registry. Real cities/durations/preferences are fixed and must match the frozen city set except explicit exclusions. Canonical comparison strips obsolete budget values.

Each campaign batch runs a fresh child and isolated live database. One immutable plan identifies input, knowledge and production runtime hashes. Do not auto-retry/overwrite failed batches, mix changed inputs into a resumed campaign, delete a live process lock or infer termination from absent new output. Only fully finalized batches feed aggregate coverage; PENDING, SKIPPED and ERROR are never passing evidence.

`placeCoverage` maps city-scoped unique names/explicit aliases to frozen IDs. It does not merge substrings, ambiguous names or proximity. Final activities first use submitted candidate IDs; area meals remain unresolved reference areas. Coverage means identifiable places in submitted candidates/final Trips, not a complete SQL/vector recall trace or factual accuracy. Excluded cities, hotels, unverified and redirected rows carry explicit reasons.

Preference semantic review is observational. Every decidable verdict must reference an activity in its own case and cover every supplied case; missing/foreign/duplicate IDs are errors. Same-model review carries shared bias and cannot certify dietary/accessibility facts. Explicit required/avoided-place notes also have deterministic final-Trip checks.

Intent evidence uses `understandMessage` and production Brief normalization. Current detail mode and legacy understanding-module contract cases are labeled separately. Homepage notes go directly through generation; do not describe understanding-unit results as proof that homepage notes were applied by scheduling.

Intent fixtures must avoid unrelated ambiguity: an option-context addition target must be absent
from the current Trip, otherwise a legitimate duplicate-place clarification can be misclassified.
If a fixture is corrected after a real run, retain the old report, explain the correction and save
the new inputs/results separately. Never quietly turn the original failure into PASS.

### 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| Unknown suite/city/case | Reject instead of falling back to full |
| Frozen city set changes | Campaign rejects pending explicit case expansion |
| Resume code/input/knowledge differs | New campaign required |
| In-flight batch | Aggregate keeps it pending |
| Required/avoided place violated | Note case FAIL despite successful generation |
| Alias ambiguous or unmatched | Unresolved evidence; no invented coverage |
| Model review omits a case or cites foreign activity | Reject review, retain error |
| Real intent returns advice plus mutations | Check intent, operations AND normalized Brief, not just reply text |

### 5. Good / Base / Bad Cases

Good: same-city preference variants have independent real results, with all unused IDs listed. Base: regional meals are explicitly counted as regions. Bad: saying all knowledge was validated because it was imported, or calling 96 generation PASSs proof of all dietary requirements.

### 6. Required Tests

`scenarios.test.ts` checks matrix Cartesian coverage, stable unique IDs, valid current forms, note polarity and incomplete gates. `placeCoverage.test.ts` checks alias uniqueness, cross-city names, synthetic meals and exclusions. `semanticReview.test.ts` rejects omitted cases and fabricated/cross-case activity references. Real execution artifacts retain model, input and knowledge provenance.

### 7. Wrong vs Correct

Wrong: count a nearby restaurant/name substring as a verified library place and turn a missing observation into 0. Correct: retain unmatched/ambiguous rows and show candidate coverage, selected coverage and exclusions separately.
