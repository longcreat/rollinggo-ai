# Component Guidelines

## Function Components and Composition

Use named function components and React hooks. Route pages orchestrate data and navigation; focused child components render reusable UI or editor behavior. Avoid class components and avoid moving a feature into a generic abstraction before at least one real reuse or complexity need exists.

Evidence: `apps/web/src/pages/TripEditorPage.tsx`, `apps/web/src/components/GenerationTimeline.tsx`, `apps/web/src/components/editor/ActivityCard.tsx`.

Prefer composition over large configurable components. Existing examples include `TripEditorPage` composing editor panels and dialogs, `GenerationTimeline` composing `PoiCard`, and dialogs composing the shared `Modal`.

## Practical Props Typing

Use the least ceremonial readable form:

- Use a named `interface Props` when a component has several fields, domain comments, or the shape benefits from a reusable name.
- Use an inline object type for a small, local prop surface.
- Use shared domain types from `@tripweaver/shared`; do not recreate `Trip`, `TripDay`, `Activity`, or protocol unions locally.
- Model optional props with `?` and state variants with literal unions or discriminated unions.

Both styles are established and valid. `ActivityCard` and `DaySection` use named interfaces, while `Modal`, `ExportMenu`, and `MapView` use compact inline prop types. Do not impose an inaccurate rule that every component must use `interface Props`.

Evidence: `apps/web/src/components/editor/ActivityCard.tsx`, `apps/web/src/components/Modal.tsx`, `apps/web/src/components/editor/MapView.tsx`.

## Forms and User Actions

Forms are controlled with local `useState`, native labels, and `FormEvent` submit handlers. Keep transient drafts local unless multiple distant components must edit the same domain draft. Parse and clamp numeric input at the submit or commit boundary rather than storing partially parsed domain numbers while the user types.

Evidence: `apps/web/src/pages/RegisterPage.tsx`, `apps/web/src/components/SettingsDialog.tsx`, `apps/web/src/components/editor/TripMetaDialog.tsx`.

Mutation buttons should disable or change labels while pending when duplicate submission would be harmful. Display actionable errors near the operation. Native `window.prompt`, `window.confirm`, and `alert` are currently used for small one-shot list/editor commands; they are acceptable as narrow legacy-style adapters, not as the default for complex workflows.

Evidence: `apps/web/src/pages/TripListPage.tsx`, `apps/web/src/components/editor/DaySection.tsx`, `apps/web/src/components/editor/ActivityCard.tsx`.

## Styling

All application pages and components use **Tailwind CSS 4 utilities in JSX**, including existing authentication, collection, editor, generation, home and shared UI. The 2026-09-29 product decision removes the legacy-page exception. Do not recreate `global.css`, `print.css`, map-specific CSS, a runtime class-name translator, or CSS selector rules as an alternative styling system.

`apps/web/src/styles/tailwind.css` is the single application stylesheet. It contains Tailwind imports, `@theme` colour tokens, `@layer base` browser defaults/print visibility, font-face declarations and animation keyframes. Keep preflight disabled; base defaults sit below utilities, so headings and controls can be styled directly in JSX. Leaflet's vendor stylesheet and packaged font CSS remain vendor dependencies.

Use standard utilities where available, semantic colour tokens (`bg-brand`, `text-ink-muted`) and arbitrary values/properties for exact design measurements. Existing migration tokens preserve the original palette; reuse or consolidate them rather than adding hard-coded colours. Native state, responsive, descendant and print behavior belongs in Tailwind variants. Use complete literal class names, never construct utility names from runtime fragments. An attribute selector should use single quotes inside a JavaScript string, e.g. `[&[data-tone='1']]:bg-canvas`; escaped double quotes can prevent Tailwind source detection.

Retain semantic hook names only when selectors, map collision code or browser tests require them; they are not backed by a second stylesheet. Before combining utility groups, remove conflicting properties rather than relying on their order in `className` (Tailwind generates stylesheet order independently). Conditional modifiers need explicit state variants or mutually exclusive utility groups.

Inline styles stay deliberate for data-dependent or library-facing values, such as day and category colours, progress widths, background-image URLs, and Leaflet marker HTML. Stable layout and appearance belong in a class.

### Handwriting and glyph coverage

- The selected handwriting is **演示悠然小楷 / Youran Handwriting**, used consistently in trip covers, collection accents, editor day/overview headings, generation live hints and photo captions. Font-face declarations remain in `tailwind.css`; WOFF2 assets are local and use content hashes in their filenames. Keep the original author notice in `public/fonts/handwriting/NOTICE.md`; this font uses its author's free-commercial-use statement, not OFL/MIT.
- `scripts/build-handwriting-font.py --source <TTF>` pins the reviewed source hash, retains every valid cmap code point, groups common UI/travel characters, and splits remaining characters for on-demand loading. Regenerate shared coverage and the server manifest with `scripts/generate-title-font-coverage.py`, then run `--check`.
- Dynamic handwritten text calls `lib/handwriting.ts:handwritingFallback(text)` using shared coverage. If any letter/number is missing, the entire text uses bundled Noto Serif; punctuation/emoji may use ordinary fallback without discarding handwriting. Apply this to the original complete status text before splitting typewriter characters. This also handles old/imported/manually edited text without changing stored content, real place names or editor revision.
- Do not claim that all Chinese characters are supported. Verify actual rendered fonts via CDP, not only `document.fonts.check()`. `tests/handwriting-browser.mjs` checks Beijing's old “中轴宫苑漫步”, overview/cover/photo text, mobile bounds, unsupported “罍” whole-text fallback and zero writes. `tests/handwriting.test.ts` checks display policy; server `titleFont.test.ts` checks generation rejection and asset hashes.
- Calibrate handwriting by visible ink size against the same reference text and viewport, not by reusing the previous font's CSS pixel size. Youran has a smaller ink area: day headings use 32–40px (30px on phones), photo captions use 30 design pixels (24px on phones), and active hints use 34 design pixels (28px on phones). Adjust line-height and tracking together; preserve natural glyph proportions. Check overview, collection subtitle/empty state, plain covers and the Latin `new` marker as well as the primary heading.
- Cover sizes depend on available space and name length. Illustrated names over three code points use smaller text (28px desktop / 24px phone), while plain long names wrap at their own smaller sizes. Check rotated title bounds against artwork at both phone and desktop widths; a page without horizontal overflow can still have internal overlap. Collection subtitle line breaks should preserve its two clauses on phones. Record reference/before/after samples when switching fonts.

**Traps found while building the 09-26 home page** (each one failed silently, so keep them in mind before "cleaning up" any of it):

- `text-[calc(...)]` is ambiguous (size vs colour) and Tailwind resolves it to `color:`, so it silently does nothing. Force the font-size reading with the type hint: `text-[length:calc(16*var(--ui))]`.
- Keep all browser defaults in `@layer base`; unlayered element rules would override utilities regardless of selector specificity. Page heading sizes now belong in JSX.
- If the page suddenly renders nothing or loses its stylesheet in dev, suspect a stale dev transform before touching any rule: `fetch('/src/styles/tailwind.css')` showing `__vite__css = ""`, or a router-level `SyntaxError: The requested module ... does not provide an export named ...` from an untouched file, both mean the dev server is serving an old/empty transform of a file you just wrote. Re-saving the file clears it; neither `?direct` nor a production build shows anything wrong.
- Sizing a fixed-aspect design (the 1668x943 UI mock) with the viewport: the home page defines one `--ui` ("1 design pixel") as `max(0.75px, min(0.0599vw, 0.106vh))` and writes every size as `calc(<design px> * var(--ui))`. Width-only units overflow vertically on wide screens; the `min()` keeps the scale inside both axes. Horizontal anchors stay percentages so they keep their relation to the capsule's edges.
- Absolute card fans need a separate narrow-screen layout: `GenerationRunPanel` switches to normal-flow grid cards at 900px, resets desktop title offsets and card poses, and keeps the footer after the cards. Check transformed card bounds against both the viewport and footer; `scrollWidth` alone misses clipping hidden by `overflow-hidden`. The generation panel uses the background on `AppLayout`, avoiding a second independently scaled copy with visible seams.
- Generation photos use `selectGenerationCards`: prefer the latest five candidates with a cover URL not in the panel's failed-URL set, then fill remaining slots with recent candidates. `PoiCover.onCoverError(url)` lets the panel replace a broken image with an earlier usable one; key the cover by URL so a replacement URL does not inherit failure state. Never remove candidates from the SSE model just to curate the visual fan. Captions show only `poi.name`, wrapping long names instead of appending introductions or forcing an ellipsis. Per the 09-28 product decision, the generation page has no generic photo credit row or cloud/airplane/building decorations. Curated licensed photos keep author/work/license in the payload, but per the 2026-10-02 product decision `PhotoCredit` renders only inside the enlarged photo modal; the generation fan, editor activity card and candidate drawer show no credit row. Legacy photos without attribution metadata do not gain a fabricated notice.
- `useStagedGenerationCards` separates presentation timing from SSE state: a 1200ms clock moves at most one slot toward the latest selected target, without restarting on incoming events. Stop its interval on terminal status/unmount; reduced motion bypasses pacing. A phase_end is not job completion: final route checks and persistence can follow all three phase endings. Keep the latest milestone active until the job terminal event when all phase blocks are done; before the first phase, show an active preparing state. Browser regression must cover both gaps, not only an active plan phase. Key typewriter instances by phase block and progress item identity, not text alone: consecutive same-label tool calls must replay, while elapsed-time rerenders must not. Key photo figures by POI ID and cover URL so replacement photos animate too. Typewriter spans reserve text space, expose one accessible status string and animate only the visual characters. Generation headings use `SimSun`, `Songti SC`, then bundled `Noto Serif SC Variable`; avoid treating raster-reference font guesses as confirmed font provenance.

Evidence: `apps/web/src/pages/HomePage.tsx`, `apps/web/src/components/home/HomeCapsule.tsx`, `apps/web/src/components/home/ChinaMap.tsx`, `apps/web/src/styles/tailwind.css`.

## Dialogs and Browser UI

- `PhotoCredit` handles Pexels, Commons, Unsplash, Pixabay and XHS explicitly. Keep provider labels and the strict HTTPS credit-host allowlist in sync (`www.xiaohongshu.com` for XHS), otherwise valid imported attribution silently disappears. XHS model-reviewed photos say “未确认授权”. When a validated photographer profile URL is present, link the name to that profile and the source label to the work. Preserve Unsplash referral parameters and each selected gallery photo's own attribution; do not label all non-Pexels photos as Commons. Render `PhotoCredit` only inside the `Modal size="photo"` viewer (2026-10-02): cards never render a credit row, so keep every photo's attribution in the payload even though the card hides it, and do not print the `changes` crop note. `apps/web/tests/photo-layout-browser.mjs` asserts zero `.photo-credit` outside the dialog and that the dialog credit follows the selected photo. API secrets and private adoption endpoints never belong in frontend state. New-source browser fixtures are mock protocol/layout verification, not evidence of live photo coverage.

- Detail activity and non-compact candidate photos use `PoiCover variant="photo"`, with the chosen C layout: a fixed-width photo column beside wider text, intrinsic aspect ratio and `object-contain`. The column is 180px on desktop and 128px at ≤600px and the photo is centred horizontally and vertically inside it; a card without a usable cover renders no photo column at all, so its text fills the row (2026-10-06 — a same-day “always reserve space” variant was reverted after review). Landscape/square photos keep `max-height` 120px desktop / 88px mobile, portrait 150px / 110px, and the trigger keeps a 44px minimum target. Read actual natural dimensions, not assumed source orientation. Full-width photos beneath text, the previous smaller image layout, and the former “44% of the row” width cap were rejected; do not reintroduce fixed-aspect cropping.
- Only the saved cover appears in the card. The shared `Button` opens `Modal size="photo"`, with cover-first deduplicated photos capped at three total, previous/next controls, thumbnails and selected-photo attribution. Browsing never changes the saved cover; reopening starts at the cover. Remove failed alternatives; a failed cover hides the photo instead of displaying an alternative under the wrong credit. Preserve old single-cover snapshots. Viewing must not autosave or send chat messages. Compact generation thumbnails retain their presentation and the shared modal's default size remains unchanged. Verify text/photo balance, gallery switching, Escape, focus restoration, image failure, mobile bounds and five image ratios with `apps/web/tests/photo-layout-browser.mjs`.

Use the shared native `Modal` adapter for application dialogs. It calls `showModal`, handles the native `cancel` event, supports backdrop click closing, and removes its listener during effect cleanup. Render dialogs conditionally so their local form state is recreated when appropriate.

- Sharing uses `ExportMenu` with the shared `Dropdown`: “分享行程” exposes only “导出 PDF” (existing `printTrip`) and “AI 生成海报”. Return focus to the persistent summary before opening the modal; the closed menu item cannot serve as the focus return target. The ≤600px trigger remains 44px and icon-only, using the inclusive media variant to match the editor toolbar.
- `ExportDialog` keeps its generation job in the module-level store (`lib/shareImageJobs.ts`), so a job survives closing the modal and leaving the trip page; reopening the dialog shows the running or finished state instead of opening itself, and the last delivered image is kept through regeneration failures. Finished posters are server-persisted, so `open` also calls `loadShareImage` (`GET /api/trips/:id/share-image?style=`): a page reload still shows the poster without regenerating, and the payload is a `/media/share-posters/<sha256>.<ext>` URL rather than a base64 data URL. `Modal size="poster"` constrains width to 480px with a scrolling body and fixed header/footer, without changing other modal sizes. Use separate style/loading/result views, no extra empty preview panel. Style selection never sends requests; changing style preserves the last downloadable result and cancelling restores its style. Trip signature changes invalidate displayed/in-flight stale results. Regeneration sends `regenerate: true`; failure retains the old image. Loading uses an indeterminate, reduced-motion-aware spinner, with no invented percentages or provider stages. Every successful generation POST, including explicit regeneration, initiates one download and a global completion notice; GET restoration never triggers delivery. Completion notices persist in the account notification center and expose a manual download action. See generation-notifications.md for account isolation, native-dialog toast placement, WeChat fallback and error handling. Regression: `trip-share-image-browser.mjs` covers menu/PDF, state transitions, payloads, focus, auto-download rules, failed/malformed responses, image fallbacks and 320px/landscape bounds.

Evidence: `apps/web/src/components/Modal.tsx`, `apps/web/src/components/SettingsDialog.tsx`, `apps/web/src/components/editor/TripMetaDialog.tsx`.

Keep direct DOM and browser APIs behind small components or `lib` helpers when they have reusable mechanics. `lib/export.ts` owns object URLs, downloads, user-agent detection, and printing; `MapView` owns `matchMedia` and Leaflet lifecycle behavior. A one-off command may stay at the page handler when extracting it would hide rather than clarify the flow.

## Async Rendering and Degradation

Async pages and dialogs must intentionally handle loading and errors. Also handle empty data, disabled actions, and recovery when those states exist. Optional data may degrade without blocking the primary flow: GitHub login appears only when enabled, usage chips render only with data, source-status checks are disabled until expanded, missing POI images fall back to a category icon, and old trips omit the optional overview UI.

Evidence: `apps/web/src/router.tsx`, `apps/web/src/components/SettingsDialog.tsx`, `apps/web/src/components/PoiCard.tsx`.

Do not convert optional secondary-query failure into a full-page failure unless the feature cannot function safely without it. Conversely, do not silently swallow failure for primary data such as the trip being edited.

## Homepage Mobile Layout

- Below 1024px, `HomePage` starts with the planning card, followed by `DestinationShowcase`; the interactive map lives in `DestinationPicker`. The card owns `--ui: 1px` so phone controls do not inherit the desktop 0.75px scale. Scope inherited heading sizes to `lg:` to avoid shrinking headings in the picker. Keep desktop absolute map/capsule placement behind `lg:`.
- `HomeCapsule` renders the same date/pace/preferences form through `HomePanel`: desktop anchored panels, mobile `Modal size="sheet"`. Keep one draft owner, native focus return/backdrop/Escape behavior, a single calendar month on mobile, and viewport-bounded scrolling. Crossing the 1024px breakpoint closes a panel, preserving its draft.
- Mobile city selection uses `?choose=destination` with `Modal size="screen"`. Candidate selection is local until confirmation. Cancel, Escape, and browser Back preserve the original city and other drafts. Only picker entries pushed from home carry the history marker that permits `navigate(-1)`; direct query links remove just `choose` with replacement. Preserve unrelated query parameters. Loading/error/empty coverage must disable confirmation.
- `AppLayout` uses the same top capsule navigation on home, collection and other pages at every viewport width (2026-10-06). Do not restore mobile bottom tabs or their content inset. Keep both home/trips links, active-page highlighting, top safe-area padding, guarded navigation and modified-click behavior; a guest's trips link opens the login dialog with `/trips` as its destination, retaining the mounted homepage when cancelled. Verify the links do not overlap notification/account actions at 320px.
- `DestinationShowcase` intersects its preference order (北京、杭州、厦门) with the API's covered cities. Local `assets/destinations/*.webp` reuse eligible reviewed photos, verified bytes and user exclusions; `sources.json` keeps full provenance and SHA-256. Do not promote search-cache entries to reviewed assets. Missing images fall back to city illustrations, then an accessible placeholder. SVG map instances use unique gradient IDs.
- Mobile `DestinationPicker` has no search field: select through map dots, featured cards or the expandable covered-city list. Featured selection uses the existing border highlight and `aria-pressed`, without a checkmark.
- Mobile `ChinaMap` fits the complete 900×700 canvas with `xMidYMid meet` and a fixed identity transform; keep the South China Sea inset. It uses `touch-pan-y`: vertical touch gestures and wheel events scroll the page, while dragging and pinching never move or zoom the map. Do not render the map tool group below 1024px. Desktop keeps drag/zoom/reset; crossing the breakpoint restores the corresponding default view. City clicks and keyboard selection remain available.
- Regression: `node apps/web/tests/home-mobile-browser.mjs` uses isolated API fixtures for 320–1440px widths, landscape, modal bounds, date ranges, cancel/Back/Forward, query deep links, local drafts, generation payload, guest login, empty/error cities, full mobile map fit, fixed drag/pinch behavior, covered-city list selection, checkmark-free featured cards, desktop controls/breakpoint changes, image fallbacks and native touch scrolling. `HOME_TEST_URL` / `HOME_TEST_OUTPUT` override URL/output; `HOME_TEST_WIDTH` selects a single viewport. Image-failure routes must abort only image resources, allowing Vite's asset-import JavaScript through. Account isolation: `node --import tsx apps/web/tests/travel-preferences-browser.mjs`.

## Accessibility

- Associate form controls with visible labels; use semantic `button`, `a`, `details`, `summary`, `dialog`, headings, and lists.
- Every icon-only button needs an accessible name. Add `aria-label`; a `title` may supplement it but is not a sufficient keyboard/screen-reader contract by itself.
- Preserve keyboard behavior for native dialogs, forms, links, and controls.
- Mark decorative icons `aria-hidden="true"`; provide meaningful `alt` text for content images and a fallback for failed images.
- Keep disabled and loading states perceivable in text, not only color.

`Modal` already gives its close icon an `aria-label`, while several editor arrow/edit/delete icon buttons currently rely only on `title`. Treat those as existing accessibility debt, not a pattern to copy.

Evidence: `apps/web/src/components/Modal.tsx`, `apps/web/src/components/editor/ActivityCard.tsx`, `apps/web/src/components/PoiCard.tsx`.

## Map Rendering: Two Implementations Behind One Panel

`MapView` owns renderer selection; the two canvases only draw the data they are given. The data layer
(`lib/mapData.ts`) is SDK-free — it produces `MapPoint[]` / `DayLines[]` in **GCJ-02** as `{lat, lng}`
objects, deliberately **not** `[lat, lng]` tuples: Amap takes `[lng, lat]` and Leaflet takes
`[lat, lng]`, and that reversed order is a classic bug source.

- **Primary** — `AmapCanvas` (Amap JS API). Its entire reason for existing is `features`: passing
  `['bg','road','building']` and omitting **`point`** removes the POI text layer. Raster tiles bake
  that text into the PNG and offer no switch to disable it (`style=` has none; a CSS-filter attempt
  was made in `b7e85c9` and reverted in `1d5a59b`).
- **Fallback** — `LeafletCanvas` (Amap raster tiles). Used when no JS key is configured, or when the
  SDK fails or times out (8 s, `lib/amapLoader.ts`).

Rules that keep this from becoming two divergent maps:

- Selection lives ONLY in `MapView`. Canvases never fetch config or decide anything.
- Degradation is **silent** apart from one `console.warn`. The fallback is also the initial state —
  the map renders `LeafletCanvas` while probing, so the editor is never left map-less.
- `window._AMapSecurityConfig` must be set BEFORE the SDK script loads. Setting it afterwards
  silently breaks every request, because JS API 2.0 keys require the security code.
- The JS key and security code are served by `GET /api/settings/config` and are **meant to reach the
  browser** — a JS API key cannot be hidden. Security comes from Amap's domain allowlist, not
  secrecy. Never log them; never treat them as secrets.
- **Moving a route means re-checking the caller's URL string.** This endpoint started as a planned
  standalone `/api/config` and ended up mounted under the settings group as `/api/settings/config`;
  the frontend kept requesting the old path. Typecheck cannot see a wrong URL literal, and the 404
  degrades **silently into the Leaflet fallback** — indistinguishable from "the key isn't
  configured". Treat a new endpoint as unverified until one real request has returned its expected
  body.
- InfoWindow content is an HTML string, so model-authored text (activity names, descriptions) must
  pass through `escapeHtml` before interpolation. It shows only activity summaries; no edit button
  or delegated edit handler remains.
- Route stroke geometry lives in `lib/routeStyle.ts`, not in either canvas. Every route segment is
  drawn twice — a wider dimmed underlay (`dimColor`, 7 px, z 60) then the day colour on top
  (5 px, z 61) — and the numbers only stay identical across both renderers if there is one source.
  Selecting a day no longer removes the other days from the data; `DayLines` / `MapPoint` carry a
  `dimmed` flag and the faded band (opacity 0.2, z 10/11) is what the user sees instead. The map
  fits the selected day (or all days in overview); other days stay as dimmed context outside or
  inside that viewport. Reset uses the same selected range.
  Leaflet's `Path` has neither `zIndex` (JSX order decides layering) nor `showDir`
  (Amap's direction arrows): the fallback is dual-layer but arrowless **by design**. Treat that as
  a known asymmetry, not a missed edit, when reviewing the two canvases side by side.
  Reference measurements and the source-project version drift are recorded in
  `.trellis/tasks/09-26-route-polyline-style/research/pitravel-route-style.md`.
- The marker DOM is a three-class contract owned by `lib/markerHtml.ts` and shared by both canvases:
  `.map-marker` (28×28 positioning box, also the query root for collision) wrapping `.marker-pin`
  and an absolutely positioned `.map-label`. `lib/labelCollision.ts` finds elements **only** by those
  class names, so dropping one silently disables name avoidance — and the failure mode looks like
  "we never implemented it" rather than like a breakage. Avoidance runs on `zoomend` / `moveend` plus
  once after overlays are rebuilt; it is deliberately **not** a rAF loop, which is also why it needs
  none of the reference implementation's hysteresis thresholds.
- Clicking a marker jumps the middle itinerary column to that activity instead of opening a popup: `MapView`
  takes `onSelectActivity(dayIndex, activityId)` from `TripEditorPage` (which also switches the mobile tab back
  to 行程), and both canvases call it from the marker click handler. Keep the canvas callback in a ref — putting
  it in the overlay-rebuild effect's dependencies would rebuild every polyline and marker on each parent render.
  There are no `InfoWindow` / `Leaflet.Popup` bubbles any more, so `AmapNamespace` no longer declares `InfoWindow`.
  Run `node apps/web/tests/editor-browser.mjs` (it clicks a pin that landed inside the canvas) after touching this.

## Derived Data Matching

### Common Mistake: unguarded containment matching between domain lists

**Symptom**: a short candidate name (e.g. "西湖") substring-matches an unrelated longer
activity name (e.g. "西湖醋鱼餐厅") and the UI attaches wrong metadata to the card.

**Cause**: name-based association (`a.includes(b) || b.includes(a)`) without length or
ratio guards, used when two lists share no id linkage (Activity ↔ `Trip.overview`).

**Fix / Prevention**: guard containment — contained side must be ≥2 chars and at least
half the length of the longer side (see `matchOverview` in `apps/web/src/lib/tripDerive.ts`).
Prefer precision over recall: unmatched items degrade into their fallback surface (备选
drawer) instead of showing wrong data. When the association matters long-term, add a real
id link at the producing side (generation) rather than strengthening string heuristics.

**Related**: keep name-match derivations in pure functions under `src/lib/` so they are
unit-testable and shared between panels and the map.

## Itinerary Detail Reading and Navigation (2026-09-28)

- `dayFilter` is the single owner for itinerary and map selection: `null` means overview/all days. Loading defaults to the overview (`null`); tests that need day cards must click a day tab first. View changes never increment `revision`. The left column's day tabs (`editor-day-tabs`) are the only control: the map deliberately has no day tabs of its own, so picking a day dims the other days on the map without a second, divergent selector.
- `deleteDay` preserves selection by original day ID after renumbering. If the selected day was removed, select the first remaining day; an empty trip uses `null`. Overview stays overview after mutations.
- Cards show activity order, not a timeline. Persisted legacy time fields remain in data; the full-detail dialog has been removed and new activities use empty time strings.
- The action disclosure lives in the activity card header at the top right and remains available even without an outgoing transit leg. Derive transit from `legForPair` so reorder/delete cannot leave stale travel information.
- Desktop uses three panels; at 1100px and below, use section switching. `MapView.useIsDesktop` must share that breakpoint so hidden maps do not fit a zero-size canvas.
- Both map renderers use `MapControls`. Reset fits the selected range without changing the filter. Amap overlay invalidation includes activity labels/details, not just coordinates, so editing a name also refreshes its map label.
- Regression commands: `node --import tsx --test apps/web/tests/editorStore.test.ts`, `node apps/web/tests/editor-browser.mjs`, and `node apps/web/tests/editor-browser.mjs --amap`. Browser checks intercept API calls with local fixtures; `--amap` tests the SDK contract using a stub, not a live Amap service.

### 总览布局（2026-10-04 参考图）

- `.editor-overview` 使用「行程总览」区域名称，不再显示「出行手册」「每日安排」标题；目的地/天数/人数只出现在详情顶栏。页签（总览 + 第 N 天）属于 `editor-day-nav`，不由总览渲染；备选清单入口已移除。
- 每日卡片：主题保持现有手写体，右端用 `EditorIcon forward` 箭头，路线行以 `pin` 图标起头；图标用 `items-center` 与整块路线文本垂直居中，不用 `items-start` + 顶对齐偏移（多行折行会歪）。不要再塞回 `01` 序号徽章或底部天气来源行。
- `DayWeather` 只输出「图标 + 天气 + 温度」一行，根元素是 `inline-flex`，所以既能放在总览卡日期行右端（`compact`），也能直接放进每日卡片的「第N天」那一行（非 `compact`）。白天/夜间风力、城市、数据来源与更新时间、未配置说明都不再展示；`detailed` 变体已删除，别再恢复。需要细节时看总览页的「旅行建议」与「注意事项」。
- 详情页不用 `·` 做分隔符：把条目拆成 `span`，靠容器上的 `flex flex-wrap items-center gap-2` 供间距（顶栏 `editor-trip-meta` 用已有的 `[gap:8px]`）。总览卡日期行这类 `justify-between` 容器要先包一层 flex 分组，否则拆分出来的 `span` 会被拉到两端。回归：`node apps/web/tests/trip-weather-browser.mjs` 不再断言「第 1 天 · 」与「白天 20℃」。
- 「旅行建议」「注意事项」位于所有每日行程卡上方，并排成一个 `repeat(auto-fit, minmax(200px, 1fr))` 网格，窄屏自然堆叠；纯圆点列表，每项是「粗体小标题：说明」。标题图标：旅行建议用 `bulb`（灯泡），注意事项用 `alert`；`bulb` 在 2026-10-06 加入 `EditorIcon`，别再用 `pin` 或 `sparkle` 代替。建议区底部细分隔线后接总站数提示与每日卡片；不要卡片背景，也不要回到「小标题 + 说明」两段式。
- 总览不提供手动刷新天气入口：进入详情必查、30 分钟自动刷新，因此 `TripOverview` 不收 `onRefresh` / `failed`。
- 回归：`node --import tsx apps/web/tests/trip-weather-browser.mjs`（含 390/768/1600px 溢出检查与各天气状态断言）。

### Editor export and viewport regression guard

- A `backdrop-filter` ancestor establishes a containing block for fixed children. Keep the offscreen `.print-host` and fullscreen export preview portalled to `document.body`; otherwise a long print view can inflate editor scrolling or a preview can become confined to the toolbar.
- The editor toolbar must have an explicit stacking level above the body panels. Raising only the export menu's z-index cannot escape the toolbar's stacking context.
- At ≤600px the toolbar uses a three-column grid: 44px back target, flexible two-line title, and 44px history/export icon targets. Metadata wraps below the title across the remaining columns; save errors span the next full row. The left/title wrappers use `display: contents` only on phones; remove competing ancestor display rules rather than relying on utility order. History/export hide only their text spans, retain accessible names, and use the same 22px `EditorIcon` family. Desktop keeps text. Verify long titles, menu bounds/stacking, Escape focus and history opening with `trip-share-image-browser.mjs`; version fixtures need `createdAt` for the history timeline.
- Scope viewport height/overflow to the editor AppLayout, keeping panel scrolling and print media intact. Test both document scrollHeight and panel scrolling, including a print view taller than the viewport.
- Editor primary buttons/selected states intentionally reference the homepage `--color-brand-light` / `--color-brand` tokens per user request; disabled sends use its disabled pair.
- Image export now lives in `ExportDialog`, opened directly from the editor toolbar; the dropdown menu and the JSON backup entry were removed on 2026-10-06 (`exportTripJson` is kept for the import pair). It follows the reference share-sheet layout: a two-card capability row (`AI 分享图` as the current section / `导出 PDF` still calling `window.print` until server-side PDF rendering lands), two portrait style cards (`journal` / `ink`) with an overlaid name label and a top-right check indicator, a preview area, and a sticky bottom action row so phones reach the primary button without scrolling the whole sheet. Opening alone must not call the paid API. `.print-host` stays portalled to body and the print view remains independent.
- Keep pending/result state while the modal is closed; clear stale image state after relevant draft changes and when the style changes, and isolate component state by trip ID. Returning an old request after draft edits must not show an image for the current draft.
- The dialog uses `--color-brand` for the selected card, the check indicator and the primary button — that token is the project's blue `#2f6bf3`. Do not add a second accent colour copying the reference sheet's own palette.
- `trip-share-image-browser.mjs` checks loading, close/reopen, failure retry, style-switch regeneration, preview/download, the print card, portrait thumbnails and dialog bounds at 320–1280px; editor regression covers the same dialog and print visibility.

## Shared UI Components (2026-09-29)

- `Button variant="plain"` is deliberately interaction-only: no display, spacing, border, radius, background, typography or opacity utilities. Those conflict with domain classes through Tailwind generation order (appending className does not guarantee overrides). Verify selected chips and calendar cells by computed colours and screenshots, not only aria-pressed.
- The shared Select retains native semantics, with a uniform arrow and `appearance: base-select` picker styling where supported; other browsers use their native popup. Keep arrow clearance in the utility layer (`pr-10`), since `px-3` would override component-layer padding. Picker rules live in the single tailwind.css entry.
- Home date picker uses two months on desktop and one at <=640px. Calendar grids include six weeks, hide adjacent-month cells and retain next/previous month navigation. `picker-browser.mjs` covers a six-week month, selected-chip contrast, open pickers and mobile overflow.

- Use `components/ui/Button.tsx` for all JSX buttons: `primary`, `secondary`, `ghost`, `danger`, and `plain` for domain-specific layouts (calendar cells, map filters, route choices). The default type is `button`; forms must explicitly use `type="submit"`. Native props and React 19 refs pass through. `loading` adds Spinner, disables repeated actions and sets `aria-busy`; provide visible pending text. IconButton requires an accessible label. Button-like links use `buttonClassName` without changing anchor semantics.
- Use `ui/Field.tsx` Input/Select/Textarea. Do not restyle their borders, colours, font or focus through parent selectors. Keep layout at the caller. Select retains native keyboard and OS popup behaviour; checkbox/radio/file/range keep native compact semantics.
- `Textarea appearance="panel"` is the home glass-panel control: panel tokens (`border-hairline-strong`, `bg-white/60`, `text-ink-strong`) with every size written as `calc(<design px>*var(--ui,1px))`. The `1px` fallback makes the same component use base sizes outside the scaled home page (e.g. the profile `Modal`), so one variant serves both. Home-page preference chips follow the same rule; a fixed-rem control inside the zoomed panel renders at the wrong scale. Panel field labels ("旅行节奏", "同行人数", "可规划城市…") use `text-[length:calc(12*max(1px,var(--ui,1px)))]` like the preference legends — Tailwind's `text-xs` is a fixed 12px, so at large `--ui` it drifts visibly smaller than the labels it sits next to. Its focus state is border/background only (`focus:border-brand focus:bg-brand/10 focus:outline-none`): the app otherwise falls back to the UA `outline: auto` ring, and a 2px brand outline sitting on the 1px border reads as a heavier box than every neighbouring control. Preference and transport chips use the same selected treatment and corner radius as the destination cards (`border-brand bg-brand/10 text-brand`, `rounded-[calc(12*max(1px,var(--ui,1px)))]`), not a filled brand pill.
- `Textarea appearance="embedded"` delegates its visible focus to the composer's `focus-within` ring. Do not include `textarea` in the editor page's descendant `:focus-visible` outline selector: its higher specificity overrides `focus:outline-none` and adds a square blue frame inside the rounded composer. Standard textareas retain the shared Field focus styles; send/stop buttons retain their keyboard outlines. Check computed outlines as well as mouse/keyboard and multiline/mobile screenshots.
- `ui/Dropdown.tsx` owns details/summary menu panels, external-click dismissal, focus leaving and Escape focus restoration. EditorMenu is a domain wrapper. Route options share `useDismissibleDisclosure` while retaining their asynchronous selection behaviour. Never use ARIA menu roles without implementing their keyboard model.
- `Modal` remains the only dialog shell: named by its title, native modal focus trap, viewport-bounded scroll, Escape and actual-backdrop close. Closing returns focus to the trigger (or its collapsed disclosure summary). `ui/ActionDialog` provides ConfirmDialog and PromptDialog; no window.confirm/prompt in product flows. Export image preview uses Modal too.
- Activity cards and both map renderers expose summaries, not manual activity-edit or full-detail actions. Existing activities remain reorderable/movable/deletable. Manually adding an activity was removed on 2026-10-06: the day-list `＋ 添加活动` button, `ActivityEditDialog`, and `editorStore.addActivity` / `updateActivity` are all gone — new stops come from chat or regeneration only, and the empty-day copy says so. Reservation prose is never printed on a card (2026-10-06): only the `ReservationBadge`, whose `title` still carries `reservationNote`, sits in the category row, while the itinerary-level「注意事项」keeps the booking reminder. Do not tell users to use a removed editor when coordinates are missing.
- Tests: `styles.test.mjs` prevents raw JSX controls outside ui and browser prompt/confirm; `shared-ui-browser.mjs` covers form states, dialog naming/focus, calendar and narrow viewports; editor tests cover both renderers and export.
- 通知面板条目与完成提醒（`NotificationCenter`）的点击范围只落在右侧操作按钮上（2026-10-09）：整条容器不可点击、也没有 hover 高亮，只有 `Button` 承载 `open` 与禁用态；操作按钮保留可访问名 `查看行程：<标题>` / `下载图片：<标题>` / `返回重试：<标题>`，未读时追加 `（未读）`，移动端与桌面共用同一份内容。不要因为「整条更好点」把容器改回按钮，也不要给操作文案加箭头图标。时间统一走 `notificationTime` 的四档：`刚刚` / `HH:mm` / `昨天 HH:mm` / `M/D HH:mm`（更早也要带时分）。回归：`navigation-notifications-browser.mjs` 断言四档文案、面板内点击标题不跳页、面板与 Toast 都只在操作按钮上跳转；`trip-share-image-browser.mjs` 的门户提醒下载按钮同源。

## My Trips Collection

- Spine shading uses a soft 24px gradient tinted with the cover's `currentColor`. Keep white highlights restrained (18% alpha) and fade the crease into the cover without a second white stripe; a bright crease edge makes the binding look metallic. Compare with `09-28-my-trips-redesign/research/ui-reference.png` at matching scale.

- `TripListPage` owns search, destination and sorting in URL parameters (`q`, `city`, `sort`), preserving conditions when returning from detail.
- Trip list pagination is server-side (10-03): `GET /api/trips` takes `offset`/`limit` (`TRIP_LIST_PAGE_SIZE` 20, capped by `TRIP_LIST_PAGE_SIZE_MAX` 50) plus `q`/`city`/`sort` and answers `{ items, total, destinations }`. Collapse the version chain with `distinct on (root_id)` in an inner query and filter in the outer one — a `WHERE` in the same query as `DISTINCT ON` lets an outdated version win a keyword match and return as the newest. `destinations` always lists every destination of the user, so the dropdown stays complete while only one page is loaded; `total` is the filtered count. The web side uses `useInfiniteQuery` with a sentinel `IntersectionObserver` (one batch per scroll) and reads `total`/`destinations` from the first page.
- The search input keeps a local draft during IME composition. Do not navigate or filter on unfinished pinyin; commit `q` on `compositionend`, and synchronize committed URL changes back to the draft outside composition. Browser regression uses CDP composition events and Chinese commits, including selection replacement; `fill` alone does not cover IME behavior.
- Loaded cover illustrations use an upper, slightly left-offset city title, lower-right line art, and a decorative dashed route with small location marks. Render that route only after the local image loads; missing/broken assets retain the centred text cover. The day-count badge uses consistent blue text, 8% top/right insets, and a larger capsule (34px desktop / 30px mobile). All artwork and route decoration remain `aria-hidden` and non-interactive.
- Render only list summaries; do not fetch each trip detail to fill covers or fabricate travel dates/photos. Dates are explicitly update dates.
- Cards are accessible whole-card links. `TripCover` renders pastel covers with a narrow curved spine, a crease and two short binding marks. Without an asset, destination handwriting stays centred; body text remains readable sans serif. Keep natural page scrolling and responsive columns, scoped separately from the fixed editor viewport.
- Optional cover line art is discovered at build time with `import.meta.glob('../assets/city-landmarks/*.{svg,png,webp}', { eager: true, query: '?url', import: 'default' })`. Name files after the complete city name, e.g. `北京.png`, using lowercase extensions; trim destination whitespace and a trailing `市` only. Duplicate city files resolve in SVG → PNG → WebP order. Do not substring-match multi-city trips or request guessed/external image URLs. Prefer transparent outline assets; PNG/WebP must have actual alpha transparency, since alpha masks recolour all opaque shapes, including unwanted white backgrounds. A hidden image confirms loading before rendering the decorative mask; failure retains the text cover. Sources/license records belong beside the assets; see `docs/CITY_LANDMARK_ASSETS.md`. Production additions require a rebuild. White-background PNG line art is converted in place with `npm run assets:transparent` (`scripts/to-transparent.mjs`, zero dependencies): it sets `alpha = 255 - max(R,G,B)` with RGB forced to black, skips files that already contain transparent pixels so re-running never double-processes a converted asset, and leaves non-8-bit / interlaced / non-NRGBA PNGs untouched while reporting them as failures.
- Collection has no create/import/rename/delete commands; export belongs in detail. Keep loading, empty, no-results and retry states.
- Regression: `node apps/web/tests/trip-collection-browser.mjs` checks filters, navigation, recovery, responsive layouts, SVG/PNG/WebP loading and priority, transparent PNG alpha, failure and exact-city matching with isolated fixtures. `TRIP_COLLECTION_URL` and `TRIP_COLLECTION_OUTPUT` override the default server/output. Temporary uniquely named image fixtures are created with exclusive writes and removed in `finally`; never overwrite user assets. Format assertions must accept both URL paths and Vite-inlined data URLs. Run production builds after fixture cleanup so test assets do not enter the bundle.
