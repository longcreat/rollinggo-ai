# Type Safety

## Strict TypeScript Baseline

The web package extends the repository base configuration. The effective baseline includes `strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `isolatedModules`, and `noEmit`, with bundler module resolution and the React JSX transform.

Evidence: `tsconfig.base.json`, `apps/web/tsconfig.json`, `apps/web/package.json`.

Write code that passes this configuration without weakening it. Handle possibly missing array entries and optional fields explicitly. Prefer exhaustive handling of discriminated unions; a switch over `GenerationEvent['type']` is clearer and safer than chains of unrelated property checks.

## Shared Types and Schemas

Domain contracts come from `@tripweaver/shared`. The TypeBox schemas are the runtime source of truth, and TypeScript domain types are derived from them with `Static`. Shared constants define literal unions and limits used by both server and web.

Evidence: `packages/shared/src/schemas.ts`, `packages/shared/src/types.ts`, `packages/shared/src/constants.ts`.

Import shared `Trip`, `TripExport`, `GenerateForm`, `GenerationEvent`, constants, and calculations instead of duplicating them. Frontend-only transport views such as `MeView`, `AuthConfigView`, and `SettingsView` may remain near their hooks until they become shared cross-package contracts.

Evidence: `apps/web/src/api/hooks.ts`, `apps/web/src/components/GenerationTimeline.tsx`, `apps/web/src/components/editor/BudgetPanel.tsx`.

## Assertions Must Be Controlled

Use assertions only after code has established the invariant or when a browser/library API cannot express it precisely. Keep them narrow and local.

Established examples include the known `#root` element at startup, tuple construction for Leaflet coordinates, literal-compatible form values, and a guarded `firstElementChild` cast before PNG export.

Evidence: `apps/web/src/main.tsx`, `apps/web/src/components/editor/MapView.tsx`, `apps/web/src/components/ExportMenu.tsx`.

Do not use `as` to turn unknown external data into a trusted domain object. Prefer `unknown`, runtime validation, property guards, and discriminated checks. When reading `ApiError.data`, check each field with `typeof` before using it; `PlannerPage` demonstrates this for `resetAt` and `jobId`.

## Untrusted Boundaries

The following values are untrusted at runtime even if TypeScript knows the expected target type:

- JSON returned by HTTP endpoints.
- `ApiError.data`.
- SSE `MessageEvent.data` parsed with `JSON.parse`.
- Imported JSON files.
- Route params, search params, location state, and browser storage.

Validate shared domain payloads against the exported shared schemas, or add a focused runtime guard at the adapter boundary. Only pass validated data into React Query cache, Zustand, navigation decisions, or mutations.

The generic API client validates the shared `{ code, message, data }` envelope at runtime, then casts its business `data` to `T`. This does not validate every endpoint's data schema. Complex domain data still needs its endpoint validator. The POST chat stream validates shared event schemas; the native generation stream still uses a narrow JSON parse guard. These remaining limitations are not conventions to repeat.

Evidence: `apps/web/src/api/client.ts`, `apps/web/src/pages/TripListPage.tsx`, `apps/web/src/pages/PlannerPage.tsx`.

## Error and Variant Modeling

Use literal unions for finite UI states, such as save and tab states. Use `instanceof ApiError` for transport branching, then narrow status-specific fields. Keep optional fields optional for backward compatibility; the editor intentionally hides overview UI for older trips without `overview`, and data-source labels tolerate missing metadata.

Evidence: `apps/web/src/pages/TripEditorPage.tsx`, `apps/web/src/pages/PlannerPage.tsx`, `apps/web/src/components/editor/OverviewPanel.tsx`.

## Scenario: Hide Legacy Budget Data Without Breaking Compatibility

### 1. Scope / Trigger

Apply this boundary when changing planner fields, trip metadata, activity editing, editor tabs,
map/list/print presentation, imports, or autosave. Budget and cost remain persisted legacy data,
but are not user-facing planning inputs or outputs.

### 2. Signatures

- Planner submission supplies `budgetLevel: '舒适'` and `totalBudget: 0` internally because
  `GenerateForm` still requires them.
- `updateMeta` accepts only editable visible metadata and excludes `budgetLevel` / `totalBudget`.
- Activity create/edit patches omit `cost`; `Activity.cost?` remains in the shared schema.

### 3. Contracts

- Do not render budget fields, budget tabs, cost controls, totals, or print/export cost summaries.
- Do not remove budget/cost fields from shared schemas or strip them while saving an old trip.
- Editing unrelated activity or trip metadata must preserve legacy values already present in the
  loaded object; newly created activities omit `cost`.

### 4. Validation & Error Matrix

- New planner submission -> send compatibility defaults, never expose a budget choice.
- Old trip contains budget/cost -> load and save successfully, with values preserved but hidden.
- User edits activity name/time/category -> patch only edited fields; do not synthesize `cost: 0`.
- Imported trip omits optional activity cost -> shared runtime validation still accepts it.

### 5. Good / Base / Bad Cases

- Good: planner form contains destination, dates, party, transport, lodging, and preferences only.
- Base: an old trip with `cost: 80` is edited and saved; `80` round-trips without appearing in UI.
- Bad: delete schema fields to hide UI, or overwrite old values with zero during unrelated edits.

### 6. Tests Required

- `npm run typecheck` and `npm run build -w apps/web` pass.
- Browser verification asserts no planner/meta budget fields, no editor budget/cost controls, and
  only itinerary/map mobile tabs.
- Shared schema tests cover both legacy activities with `cost` and new activities without it.

### 7. Wrong vs Correct

```typescript
// Wrong: hiding UI by changing the persisted contract or zeroing old data.
updateActivity(dayId, activityId, { ...patch, cost: 0 });

// Correct: omit cost from new/edit patches and let untouched legacy data round-trip.
updateActivity(dayId, activityId, patch);
```
