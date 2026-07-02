# Documentation coverage audit (2026-07)

> **STATUS (2026-07-01): EXECUTED.** Every file under `docs/api`, `docs/architecture`,
> `docs/spec`, `docs/intro`, `docs/guides`, `docs/README.md`, and the top-level
> `README.md` was read directly and checked against the current source tree
> (`packages/*/src`, `crates/*/src`). `docs/roadmap/**` is out of scope — it's an
> explicit decision-record area (see [`README.md`](./README.md)) and is allowed to
> carry dates/rationale/history by design. Every item in this punch list (all
> "Update" entries and all "New docs needed" entries, P0/P1/P2) has since been
> applied and independently re-verified against source, including the four
> residual gaps a first re-verify pass caught (the `docs/README.md` CLI-tools
> list missing `stt-serve`, a one-clause `data-generation.md` mention expanded
> into a real subsection, the `stt-serve-protocol.md` `name`-field
> presence/uniqueness claim, and `capabilities-doc.ts`/`gen-capabilities-doc.mjs`
> still emitting the retired "a meta-test regenerates + diffs it" claim into
> newly-generated output even after the committed doc's prose was fixed). That
> claim held for this doc's own punch list, not for docs correctness in
> general: the [full-ecosystem audit](./full-ecosystem-audit-2026-07.md) §2/§7
> later caught items this pass missed or left broken — three post-reorg source
> links (`animated-point-layer.md`, `heatmap-time-layer.md`,
> `quadbin-summary-layer.md`), the `stt-maplibre.md` fade/`softTimeWindow`
> defaults, and wrong line/column/trip-heads prop-table defaults — since
> corrected in that follow-up. This doc is now a historical record of what was
> found and fixed, not an open task list — see [`README.md`](./README.md) for
> where it's filed.

## Executive summary

Doc coverage is generally sound where it exists — every "accurate" verdict below
was checked prop-by-prop or field-by-field against source, not skimmed. The
problems cluster into two headline categories. First, **mechanical staleness**:
about a dozen `docs/api/*.md` files still link to pre-reorg source paths from the
2026-06 `packages/layers/src` flat→bucketed move, three files link to the pre-extraction
`packages/layers` location of what's now `@poopdeck.gl/playback`, and a handful of
props added after a doc was written (categorical `colorMapping`, elevation, AV-box
outline/label/velocity sublayers, `lodMode`) never made it into the prop tables.
One doc (`docs/api/stt-react.md`) is worse than stale — its quick-start example
calls a hook method (`handleTilesetReady`/`handleBufferChange`) that no longer
exists and would throw at runtime. Second, and larger: **net-new undocumented
surface area**. The brand-new `@poopdeck.gl/cesium` backend (a full renderer with
a public API, shipped in this diff) has *zero* `docs/api` coverage — it appears
only in the auto-generated capabilities matrix and roadmap prose. The shared
`packages/core` render kernel (geo/, render/, capabilities) that all four backends
now consume is documented once, correctly, in `docs/architecture/system-overview.md`,
but is invisible from `docs/README.md`'s index and has no dedicated API reference.
`crates/stt-serve` (a whole shipped serving mode) and `stt-build`'s `--postgres`/
`--duckdb` direct-database input path are real and already used by one guide
(`docs/guides/python.md`) but are absent from the architecture doc, the top-level
README's repo tree, and — worse — directly contradicted by a second guide
(`docs/guides/data-generation.md` still says "GeoParquet only"). Process-narrative
language (the thing this audit was specifically watching for) is a minor,
contained problem: three sentences across two files (`bundled-flowmap-layer.md`,
`flowmap-layer.md`, `sidecar-assets.md`) read as decision-history rather than
present-tense spec, plus one internally-inconsistent invented-history claim in
`manifest.schema.json`'s gzip description. No doc describes a fully removed
feature as if it still exists (the closest is `scene.schema.json`/`sidecar-assets.md`
describing a conditional `georef` field that the one reference producer never
actually omits — a spec/implementation mismatch, not a narrative problem).

## Delete

No files reviewed are fully obsolete or superseded. Every `docs/api`,
`docs/architecture`, `docs/spec`, `docs/intro`, and `docs/guides` file documents
something that still exists in the current codebase; issues found are staleness,
gaps, and narrative tone, not dead pages. (`docs/roadmap/` already had its own
consolidation pass on 2026-07-01, folding retired records into the surviving
ones — see that directory's `README.md`.)

## Update

### P0 — factually wrong / would mislead a reader into broken code

- **`docs/api/animated-point-layer.md`** — the "3D props" section claims
  `elevationProperty`/`elevationScale` "are no-ops." This is false:
  `buildTileData` in `packages/layers/src/layers/core/animated-point-layer.ts`
  resolves the named numeric column and bakes `z = column[i] * elevationScale`
  into the position buffer for both the per-tile and cumulative-slab paths, and
  the source's own docstring documents this. Only `use3D` is actually a hint
  with no effect. Fix the claim, and while in the file add the missing `splat`
  prop (soft-gaussian rendering via `SplatExtension` — real, current, entirely
  undocumented here).
- **`docs/api/stt-react.md`** — the `usePlayback()` quick-start example and the
  `PlaybackState` reference table document `handleTilesetReady`/`handleBufferChange`
  callbacks that do not exist anywhere in `packages/react` (zero grep hits). The
  real, current API (`packages/react/src/hooks/use-playback.ts`) exposes a
  `registry: SourceRegistry` object with `registerSource(id, tileset, {required, weight})`
  / `unregisterSource(id)` / `onBufferChange(id, runway)`, from the multi-source-
  coordination work, and is how the showcase app actually wires layers today. A
  reader following this doc verbatim gets a runtime error. Rewrite that section
  around `registry`.
- **`docs/architecture/system-overview.md` and `README.md` (repo-structure tree),
  `docs/guides/data-generation.md`, `docs/README.md`** — `crates/stt-serve` (the
  axum/tokio dynamic per-request tile server, real and committed, already
  referenced by `docs/guides/python.md`) has no architecture-level or spec-level
  home. Add it to `system-overview.md`'s Rust-toolchain section and to the
  top-level `README.md`'s `crates/` tree (the `packages/` half of that same tree
  was already updated for cesium/three/playback/react in this diff; the Rust
  side was missed).
- **`docs/guides/data-generation.md`** directly contradicts **`docs/guides/python.md`**:
  the former states flatly "`stt-build` accepts **GeoParquet only**," while the
  latter correctly documents the `--postgres`/`--duckdb`/`--table`/`--sql`/
  `--geom-column` direct-database input path (`crates/stt-build/src/duckdb_input.rs`,
  `postgres_input.rs`). Fix `data-generation.md` to acknowledge the DB path (or
  point at `python.md`), and add the same capability to `system-overview.md`'s
  stt-build description, which still frames step 1 as "reads a GeoParquet file."

### P1 — real, current features missing from otherwise-accurate docs

- **~12 `docs/api/*.md` "## Source" links are stale** (mechanical, same root
  cause — the 2026-06 `packages/layers/src` flat→bucketed reorg into
  `layers/{core,trips,summary,internal}/`, `extensions/`, `lib/`): affects
  `animated-arc-layer.md`, `animated-column-layer.md`, `animated-icon-layer.md`,
  `animated-line-layer.md`, `animated-path-layer.md`, `animated-polygon-layer.md`,
  `animated-trips-layer.md`, `h3-summary-layer.md`, `quadbin-summary-layer.md`
  (two links: layer + `quadbin-cell.ts` → `lib/quadbin-cell.ts`),
  `category-color-extension.md`, `time-filter-extension.md`,
  `spatiotemporal-layer.md`. Separately, **`stt-player.md`** and
  **`time-controller.md`** link to `packages/layers/src/...` but both classes now
  live in `packages/playback/src/...` since the 2026-06 extraction (each doc's own
  import example already says `@poopdeck.gl/playback`, contradicting its own
  Source footer). All are one-line path fixes.
- **`docs/api/animated-bounding-box-layer.md`** — Properties table omits roughly
  half of `_AnimatedBoundingBoxLayerProps`: `trackIdProperty`, `filled`,
  `stroked`, `strokeWidth`, `strokeWidthMinPixels`, `showLabels`, `labelProperty`,
  `showVelocity`, `speedProperty`, `velocityScale`, `velocityMinSpeed`,
  `velocityColor`, `velocityWidthMinPixels` — a fully-implemented streetscape.gl-
  style 12-edge outline/label/velocity-arrow sublayer system (`edges`/`labels`/
  `velocity` sublayer ids) that the source docstring describes at length but the
  doc never mentions.
- **`docs/api/animated-path-layer.md`** — omits `colorMapping`/
  `colorMappingDefault` and the whole per-feature elevation "space-time relief"
  system (`elevationProperty`, `elevationMapping`, `elevationScale`,
  `elevationOpacityRange`/`elevationOpacityNear`/`elevationOpacityFar`) used to
  stack iso-contour rings into 3D terraced relief with top-down translucency
  grading.
- **`docs/api/flow-corridor-layer.md`** — Properties table only lists inherited
  AnimatedTripsLayer props; omits FlowCorridorLayer's own `signedFlow`,
  `chevronPerTripLight`, `chevronAggregateWindowMs`, `chevronInstantDomain`,
  `chevronInstantDecayMs`, `chevronDirectionWindowMs`, all actively used by the
  bixi-streets-flow demo. Should also cross-link `FlowStrokeLayer` and
  `ChevronFlowExtension` once those get pages (see New docs, below).
- **`docs/api/spatiotemporal-layer.md`** and **`docs/api/spatiotemporal-tileset.md`**
  — both are missing the shipped `lodMode?: 'parent-fallback' | 'additive'`
  option (layer prop threads straight to the tileset; tileset's own constructor
  option belongs next to the already-documented sibling `refinementStrategy`).
  Same feature, two files, same fix.
- **`docs/api/cli-reference.md`** (`stt-serve` section) — `--pool-size` (DuckDB
  r2d2 pool size, default 8, a real clap flag) is undocumented; `--heatmap-weight`/
  `--heatmap-class` are fully implemented (startup SQL aggregate, exposed as
  `heatmapDomain` in `GET /metadata.json`) but the flag-surface summary omits
  them entirely.
- **`docs/README.md`** — unchanged in this diff even though `system-overview.md`,
  `deckgl-integration.md`, and `README.md` were all edited for the four-backend
  architecture. Its "System Overview" blurb still says "deck.gl and MapLibre"
  (omits Three.js and Cesium), and its "API Reference" section has only a
  "deck.gl Layers" subsection and a "MapLibre adapter" link — no Three or Cesium
  subsection or page exists to link to yet (see New docs).
- **`docs/spec/backend-capabilities.md`** (and the docstring in
  `packages/core/src/render/capabilities-doc.ts`) claims "a meta-test regenerates
  + diffs it so the table cannot rot." No such test exists: neither
  `.github/workflows/*.yml` nor any `package.json` script references
  `backend-capabilities.md` or `scripts/gen-capabilities-doc.mjs`, and
  `capabilities-doc.test.ts` only unit-tests the render function's output shape
  against synthetic descriptors, never the committed file. The table content is
  currently correct (regenerating it byte-for-byte reproduces zero git diff), but
  the claimed enforcement doesn't exist — either wire up the meta-test for real or
  soften the claim.
- **`docs/spec/scene.schema.json`** and **`docs/spec/sidecar-assets.md`** — both
  describe `scene.json.georef` as conditionally present ("present iff
  georeferenced, absent for anchored-local frames"; `sidecar-assets.md` §6 even
  states producers "MUST include georef ... and omit it for anchored-local
  ones"). `scripts/data-generation/av_common.py`'s `write_scene_json` — the sole
  producer, used unconditionally by every extractor including `waymo_extract.py`
  (the repo's one genuinely anchored-local source) — takes `origin_lat`/
  `origin_lon` as required params and always writes `georef`; the alternative
  `frame` field is never emitted by anything. This is a MUST-level normative
  contract the reference producer doesn't implement. Either fix the producer to
  actually omit `georef` for anchored-local scenes, or rewrite both docs to
  describe what actually happens (`georef` always present; frame-trust is
  currently a per-dataset, hardcoded frontend fact, not a wire signal).
- **`docs/architecture/data-format.md`** — as the doc positioned as the
  normative Arrow/GeoArrow tile-payload spec, it documents the vector-group
  `FixedSizeList` column and `vertex_time` delta quantization but omits three
  other already-shipped, wire-format-affecting encoder features: coordinate
  quantization (`--quantize-coords` → Int32 + `stt:quant` affine), numeric
  attribute quantization (`--quantize-attr`/`--quantize-attrs-auto` →
  UInt16/Int32 + `stt:qa` affine), and point-elevation fold
  (`--point-elevation-column` → `FixedSizeList<_,3>`). `cli-reference.md`
  documents the flags but never the resulting metadata keys/Arrow types, which
  belongs in the normative spec doc for a third-party reader implementer.

### P2 — smaller gaps, weak phrasing, low-severity inconsistencies

- **Process-narrative cleanup** (the specific thing this audit was watching for
  in live docs — small and contained):
  - `docs/api/bundled-flowmap-layer.md`: "(We prototyped force-directed bundling
    first, but its pairwise spring/electrostatic forces are O(E²) and look
    kinky; KDEEB is both smoother and GPU-native.)" — explicit decision-history;
    remove or move to a roadmap doc.
  - `docs/api/flowmap-layer.md`: "...or pass `--no-cluster` to fall back to the
    legacy volume-based `min_zoom` LOD..." — weak before/after "legacy" framing;
    reword to describe current behavior only.
  - `docs/spec/sidecar-assets.md` §1: "Three needs fall outside a single packed
    dataset and motivated this profile — each previously handled by ad-hoc code
    with no written contract" and "...a case the core spec's CRS pinning (§3.4)
    did not previously cover" — both read as change-narrative; state the
    requirement directly.
- **`docs/spec/manifest.schema.json`** — the `compression` field's description
  invents a "legacy single-file `.stt` v2" gzip era that contradicts the Rust
  source of truth in three places (`types.rs`, `compression.rs`,
  `archive.rs`'s `compression_from_byte` comment all say gzip was never
  shipped) and contradicts `stt-packed-format.md` §9, which calls the
  single-file container "v4," not "v2." Also unrelated: this schema's `$id` uses
  `spatiotemporal-tiles.dev` while `scene.schema.json` uses `poopdeck.gl` —
  likely an `@stt`→`@poopdeck.gl` rescope leftover, low severity.
- **`docs/architecture/data-format.md`**'s magic/version table one-line
  descriptions for retired v1–v3 ("gzip + BLAKE3-64 dedup" etc.) should be
  reconciled with the manifest-schema fix above so the three docs
  (`data-format.md`, `manifest.schema.json`, `stt-packed-format.md`) tell one
  consistent version-history story.
- **`docs/architecture/system-overview.md`** opening sentence ("a TypeScript
  client that streams tiles from that dataset into deck.gl") still reads
  deck.gl-only even though the rest of the same doc (mermaid diagram, render-
  kernel subsection) already correctly covers all four backends — a one-sentence
  intro lag, not a missing-doc issue.
- **`docs/api/animated-polygon-layer.md`**: missing `colorMapping`/
  `colorMappingDefault` from the Data Accessors table (per-tile GPU-palette-
  projection technique, has its own source docstring).
- **`docs/api/flowmap-layer.md`**: missing `nodeRadiusUnits?: 'meters' |
  'pixels'` from the Properties table.
- **`docs/api/animated-column-layer.md`**: missing the `getLineColor`/
  `getLineWidth` alias rows (source declares both; doc lists only the legacy
  names, unlike sibling docs).
- **`docs/api/animated-trip-heads-layer.md`**: "How it works" step 3 link text
  says "FlowCorridorLayer" but the href points at the AnimatedTripsLayer page,
  not the real `docs/api/flow-corridor-layer.md`.
- **`docs/api/cli-reference.md`**: bixi subcommand one-line summary omits
  `--merged-paths`, `--directional`, `--flow-graph` (all real, back live/recent
  demos); lower priority since the doc explicitly disclaims subcommand-level
  exhaustiveness.
- **`docs/api/binary-features.md`**: "Reading one feature back" section omits
  that `getFeatureProperties()` also decodes `vectorProps` per feature.

## New docs needed

### P0

- **`docs/api/stt-cesium.md`** (topic: `@poopdeck.gl/cesium` — the newest
  renderer backend). Why: `packages/cesium` is a complete, `userFacing=true`
  backend (`cesiumBackend` descriptor, `CesiumPointLayer`,
  `viewStateToCesiumView`/`cesiumViewToViewState`, `applyViewStateToCamera`,
  `attachCesiumClock`, `timeFilterAlphaGlsl`, all exported from `src/index.ts`)
  with a `grep -ril cesium docs/api/` of zero. Coverage today is only scattered
  narrative (one `system-overview.md` subsection, the auto-generated
  `backend-capabilities.md` matrix, roadmap prose, one-line `README.md`
  mentions) — no how-to/reference page analogous to `docs/api/stt-maplibre.md`
  exists for `CesiumPointLayer`'s constructor/options, `setTiles`/`setTime`/
  `pick`/`dispose`, or the camera/clock bridge functions. This is the single
  largest gap in the whole audit: an entire shipped renderer with zero API docs.
- **`crates/stt-serve` gets an architecture/spec home** — extend
  `docs/architecture/system-overview.md`'s Rust-toolchain section (or add a
  short `docs/spec/stt-serve-protocol.md`) covering the route shapes, the
  204-empty-tile behavior, the `x-stt-gen-micros` header, and the
  `heatmapDomain` metadata field. Why: `stt-serve` is real, committed, and
  already referenced from `docs/guides/python.md`, but has zero
  architecture/spec coverage anywhere — not just a stale line, a whole
  undocumented serving mode.

### P1

- **`docs/api/backend-descriptor.md`** (or fold into `docs/spec/backend-capabilities.md`'s
  intro) — the `BackendDescriptor` pattern (`packages/{layers,maplibre,three,cesium}/src/backend-descriptor.ts`,
  each with its own `backend-descriptor.test.ts` structurally enforcing the
  contract) feeds the auto-generated capabilities matrix but is explained
  nowhere in `docs/api/` — only in the ANALYSIS-ONLY
  `renderer-abstraction-2026-06.md` roadmap doc. A short page explaining what a
  descriptor is, how to read the generated matrix, and pointing at the four
  concrete files would close this for all four renderers in one page.
- **`docs/api/flow-stroke-layer.md`** — `FlowStrokeLayer`
  (`packages/layers/src/layers/trips/flow-stroke-layer.ts`, `userFacing=true`,
  props `widthExponent`/`minFlow`/`offsetWidths`) powers the in-progress
  bixi-corridors demo, is exported from the package barrel, and has zero doc
  coverage or cross-link from `flow-corridor-layer.md`.
- **`docs/api/chevron-flow-extension.md`** — `ChevronFlowExtension`
  (`packages/layers/src/extensions/chevron-flow-extension.ts`, `userFacing=true`)
  is a fragment-shader `LayerExtension` for marching directional chevrons,
  built for the bixi-streets-flow demo, exported publicly, undocumented
  anywhere. Sibling extensions (`time-filter-extension.md`,
  `category-color-extension.md`) both have dedicated pages; this one doesn't.
- **`docs/api/splat-layer.md`** — `SplatLayer`
  (`packages/layers/src/layers/core/splat-layer.ts`, `userFacing=true`) is
  oriented-Gaussian-surfel rendering, the deck-side analogue of Three's
  `SurfelLayer` and the AV cockpit's "Surfel" mode, with no `docs/api` page.
- **A `packages/core` render-kernel API reference** (topic: the framework-free
  kernel — `time-filter`, `style`, `geometry`, `geo`, `picking`,
  `tileset-adapter`, `shader-codegen`, `capabilities` subpaths — that deck/
  three/maplibre/cesium all consume). Why: this is documented correctly once,
  in `docs/architecture/system-overview.md`'s "render kernel" subsection, but
  has no `docs/api` reference page and is invisible from `docs/README.md`'s
  index — a reader looking for "what does `@poopdeck.gl/core` export besides
  the tileset" has nowhere to go.

### P2

- **`docs/api/splat-extension.md`** (or fold into `animated-point-layer.md`'s
  prop docs) — `SplatExtension`
  (`packages/layers/src/extensions/splat-extension.ts`, `userFacing=true`)
  powers `AnimatedPointLayer`'s `splat` prop and has zero `docs/api` coverage
  (only a roadmap mention in `three-renderer-parity.md`).

## Suggested execution order

1. **Batch the mechanical path fixes first** — the ~12 stale `## Source` links
   (2026-06 layers reorg) plus the 2 playback-extraction links
   (`stt-player.md`, `time-controller.md`) are pure find/replace, zero judgment
   calls, and remove the largest single count of findings in one pass.
2. **Fix the two P0 factual-error docs next** (`animated-point-layer.md`'s
   elevation claim, `stt-react.md`'s `handleTilesetReady` example) — these are
   the only findings that actively mislead a reader into broken code, and both
   fixes are localized to one section each.
3. **Resolve the `stt-build` GeoParquet-only contradiction** between
   `data-generation.md` and `python.md`, and add `stt-serve` +
   `--postgres`/`--duckdb` to `system-overview.md` and the top-level
   `README.md` tree — these three docs currently disagree with each other and
   with the code, which is worse than any of them being merely incomplete.
4. **Do the process-narrative strip** (`bundled-flowmap-layer.md`,
   `flowmap-layer.md`, `sidecar-assets.md` §1) — small, mechanical, no code
   context needed.
5. **Decide the `georef` question** (`scene.schema.json` +
   `sidecar-assets.md` §6 vs. `av_common.py`) — this needs a real decision
   (fix the producer, or rewrite the spec to match reality) before either doc
   can be called accurate; don't paper over it with wording alone.
6. **Write the Cesium and render-kernel docs last** — both need someone who
   understands the package deeply (a new renderer's public API surface, and a
   shared kernel four backends depend on); rushing these risks producing
   another doc that's wrong on day one. The smaller extension/layer pages
   (`flow-stroke-layer.md`, `chevron-flow-extension.md`, `splat-layer.md`,
   `splat-extension.md`, `backend-descriptor.md`) are lower-risk and can be
   picked up opportunistically alongside or after.
