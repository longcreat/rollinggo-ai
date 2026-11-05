# P0 verification — 2026-09-14

## Implemented scope

1. Reuse task-local research POI coordinates and adcodes through the existing geocode sanity
   firewall. Invalid, ambiguous, missing, and rejected matches retain the normal lookup chain.
2. Separate display names from lookup names with generation-only `placeName` / `poiId` hints;
   legacy meal names extract the actual area. Internal hints do not enter persisted Trip JSON.
3. Give the second planner round the current draft and a revision-specific prompt/tool set.
   Remove skeleton creation from that round; preserve activity IDs and validated unchanged data.

Location edits invalidate coordinates and affected routes. Time/description-only edits retain
them. The post-review pass resolves changed states without retrying unchanged failed queries.
Repeating the same lodging preserves resolved data; changing lodging invalidates sentinel legs.

## Reproducible provider-call comparison

Command:

```text
node --import tsx --test apps/server/src/__tests__/geoPipeline.test.ts
```

The fixture contains one city center, one museum, and two meal areas. It uses the real
GeoSession/geocoder/route adapters with fully intercepted HTTP and an isolated temporary
SQLite database. Separate destination keys prevent the baseline from warming the reuse
scenario's geocoding cache.

| Observation | No research index | Research reuse |
| --- | ---: | ---: |
| Geocoding HTTP requests (city + activities) | 4 | 1 |
| Geo geocoding attempt count | 4 | 1 |
| Activity coordinates and source labels | Same fixture result | Same fixture result |

The three reused activity lookups disappear; city-center validation remains. Research calls
and route calls are excluded from this comparison. A separate assertion checks two transit
requests use the corresponding activity adcodes (`city1` / `city2`) and remain counted.

This is a measured mock call-count reduction, not an online wall-clock speedup. End-to-end
latency still depends on provider response times, adopted-candidate coverage, model turns,
and any normal-chain fallbacks.

## Regression results

- `npm run typecheck`: passed for shared, server, web, and eval.
- `node --import tsx --test apps/server/src/__tests__/*.test.ts`: 167 tests passed.
- `node scripts/verify-c2.mjs`: passed; includes reviewer-turn exhaustion, an actual second
  planning round, one skeleton across both rounds, all six original activity IDs retained,
  requested local time/description edits persisted, both daily meals, no internal place hints
  in Trip JSON, cancellation, SSE replay, quota, BYOK, and legacy DB migration.
- `npm run eval`: 9/9 historical snapshots passed; hard=0, soft=54, no skipped cases.
  Local output: `eval/reports/2026-09-14T11-38-56-360Z.json` (ignored generated report).
- `npm run build`: passed. Existing Vite >500 kB chunk-size advisory remains.
- The final lodging-leg invalidation adjustment is additionally covered by 31 passing draft,
  geocoding, and long-haul-fixer regression tests plus a fresh typecheck.

The new geo tests also cover missing references, duplicate-name ambiguity, invalid research
coordinates, wrong-city reuse/fallback, stale adcodes after replacement, coordinate-only
invalidation, skipping unchanged failed lookups, excluding estimated reference points, and
cancellation before adoption.

## Quality boundary

No credential-bearing live-provider checks were run. Historical snapshots were not regenerated
with the revised prompts; eight of nine lack Amap route data, and these old snapshots do not
cover the current meal-completeness contract. Their green result establishes compatibility,
not live planning-quality equivalence. New meals and local revision behavior are covered by
the mocked generation and deterministic regression tests above.

Provider limits, queues, timeout values, model selection, Agent runtime, public schemas, and
database structure remain unchanged. No LangGraph dependency was added.
