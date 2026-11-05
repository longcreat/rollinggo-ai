# P0 implementation boundaries

## Existing evidence

- `generation/tools/researchTools.ts` captures search result coordinates in `ResearchOutcome.locations`, but drops `adcode` and uses that map only for long-haul intelligence.
- `generation/geoPipeline.ts` resolves `activity.name` again. All adopted external coordinates must still pass `rejectFarGeocodes`; source references must not bypass staging or validation.
- `generation/prompts.ts` produces meal display names such as `午餐｜片区 · 菜系`, while geocoding currently consumes that whole name.
- The planner receives the same creation system prompt on revision rounds. That prompt asks for `set_trip_skeleton`, while the revision user prompt asks to preserve the existing draft. `DraftTrip.setSkeleton` clears activities.
- `DraftTrip.moveActivityToDay` already preserves activity IDs and can back a revision-only tool.
- Reviewer mutations can change names or coordinates; final route computation must not persist coordinates or legs belonging to a previous location.
- Prior local evaluation replay passed 9 historical snapshots, but those snapshots do not cover the current meal contract and most lack real route data. They are compatibility checks, not a sufficient live quality benchmark.

## Chosen scope and reuse

Keep location associations within one generation task. Extend existing draft/research/geo boundaries rather than changing database or browser APIs. Reuse the existing coordinate firewall, route memo, quota wrappers, cancellation checks, meal validation and final feasibility engine.

Test both the useful path (same source data, fewer geocoding calls) and conservative fallbacks (ambiguous names, invalid references, wrong-city points, changed locations). Use mock providers and an isolated database; do not read or transmit local credentials.

## Relevant specifications

- `.trellis/spec/server/backend/generation-guidelines.md`
- `.trellis/spec/server/backend/integration-guidelines.md`
- `.trellis/spec/server/backend/quality-guidelines.md`
- `.trellis/spec/guides/code-reuse-thinking-guide.md`
- `.trellis/spec/guides/cross-layer-thinking-guide.md`
