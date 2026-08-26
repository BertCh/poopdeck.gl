# @poopdeck.gl/core

## 0.7.0

### Minor Changes

- [`2ec0e4d`](https://github.com/BertCh/spatiotemporal-tiles/commit/2ec0e4ddf23c7eaa66a5fb060ccc508a95d45d77) Thanks [@BertCh](https://github.com/BertCh)! - **Onboarding fixes: a column inventory that is actually populated, a transport
  bar that works on a dark map, a precision warning that stops crying wolf, and a
  Node floor the browser packages do not need.**

  From a walk of the documented install-to-first-map path against the published
  packages and the hosted datasets.

  ### `@poopdeck.gl/core`
  - **`ArchiveMetadata.layers[].properties` is populated.** It is a typed, public,
    documented field that was hard-coded to `[]` on every archive ever opened, so a
    browser client's only route to its own column names was hand-decoding
    `manifest.schemas[].data` (base64 Arrow IPC) or installing the Rust CLIs. It is
    now derived at open from the manifest's own embedded schema templates — no tile
    fetch, no extra request — with each column classified as a string, a number or
    a boolean, plus `geometryTypes` off the CORE template's `stt:geometry` tag and
    measured `minValue`/`maxValue` when the builder recorded style hints. Fails
    soft in every direction: an unparseable template or an exotic column type drops
    that one item and leaves the rest of the metadata intact.
  - **The Float32 precision guard is scaled to the window being animated.**
    `assertRelTimeInRange` warned on a fixed 2^24 ms magnitude — an absolute
    constant of ~4.7 hours — so a dataset with a wider `timeWindow` tripped it by
    construction. The quickstart printed it on its first render, and so did the
    live showcase, both telling the reader to check a time offset that was correct.
    It now measures the actual f32 quantization step at the resolved magnitude
    against two floors: one 60 fps frame, and a fraction of the animated span. A
    genuinely mismatched `timeOffset` still reports. `assertRelTimeInRange` takes an
    optional trailing `spanMs`; `f32QuantumAt` and `RESERVED_TILE_COLUMNS` are newly
    exported.
  - `engines.node` relaxed from `>=24.0.0` to `>=20` (see below).

  ### `@poopdeck.gl/layers`
  - **`onMetadataLoad` is available on every layer**, not just the two summary
    layers. It fires once per archive init with the decoded metadata — the shortest
    path to "which column names does this dataset accept?":
    `onMetadataLoad: (meta) => console.table(meta.layers[0].properties)`.
    `H3SummaryLayer` and `QuadbinSummaryLayer` inherit it and no longer declare
    their own; behaviour there is unchanged.

  ### `@poopdeck.gl/react`
  - **The stylesheet ships a dark palette.** `styles.css` defined one light "paper"
    palette on bare `:root` with no dark variant, so the transport bar rendered
    near-black labels and a white scrubber track over the dark map every consumer
    floats it on. The same eight tokens now switch under
    `prefers-color-scheme: dark`, and `data-stt-theme="light" | "dark"` on any
    ancestor pins a mode — the case a dark map inside a light page needs. Setting
    the tokens yourself still wins over both.
  - **`PlaybackControlsProps.timeRange` is optional.** `usePlayback` echoes its
    `timeRange` option back so that `<PlaybackControls {...playback} />` "just
    works"; it worked at runtime and did not typecheck, because the echo is
    optional and the prop was required. Omitted, the bar falls back to the
    degenerate `[currentTime, currentTime]` range.

  ### All six browser packages

  `engines.node` moves from `>=24.0.0` back to `>=20`. The repository's own dev
  toolchain genuinely needs Node 24, but these packages' `dist` never executes
  under Node at all — and a floor above both the maintenance and active LTS lines
  hard-fails any consumer or CI running `engine-strict=true`, for nothing.
  `@poopdeck.gl/mcp`, which ships a `bin` and really does run under Node, stays at
  `>=24`.

- [`4f4cd71`](https://github.com/BertCh/spatiotemporal-tiles/commit/4f4cd713a2866d4d58b68d95c2133366fa1152f4) Thanks [@BertCh](https://github.com/BertCh)! - **`BufferSource.isInert()`: a torn-down source can leave the governor instead of
  deadlocking playback.**

  `PlaybackGovernor` gates the clock on `min(runway)` over its REQUIRED sources.
  A `SpatioTemporalTileset` that has been `finalize()`d clears its tile registry
  but keeps its coverage index, so it keeps answering "nothing buffered, never
  complete" for the rest of the session — which the min-gate reads as a laggard
  that will catch up eventually. One stale entry pins the clock at zero forever.

  That is not hypothetical: a renderer that swaps datasets under a layer whose id
  changes with them (`<id>` → `<id>-surfel`) finalizes the old tileset with no
  callback the app can hang an `unregisterSource` off, and because the variants
  share one time range, the range-change reset that would have cleared the
  registry correctly never fires. Measured on the AV cockpit's LIDAR render-mode
  switch: 2 → 4 → 6 → 8 registered sources, the first one gating, playback dead
  after the first switch.

  - **`@poopdeck.gl/core`** — `SpatioTemporalTileset.isInert()` returns `true`
    once finalized. One-way; a finalized tileset is never revived.
  - **`@poopdeck.gl/playback`** — `BufferSource.isInert?()` is a new OPTIONAL
    member of the readiness contract, and `PlaybackGovernor` drops every source
    reporting it at the top of each evaluation (and on gate entry, which
    evaluates once directly). Sources without the method are never inert, so
    existing implementations are unaffected.

  This is a safety net for the registration contract, not a replacement: a
  renderer swapping datasets should still unregister the ids it retires.

- [`bfba49c`](https://github.com/BertCh/spatiotemporal-tiles/commit/bfba49c9e5abcd4d1ab301c61fe18b4788d7f18c) Thanks [@BertCh](https://github.com/BertCh)! - **The three non-deck backends render every frozen `LayerKind`.** three, maplibre
  and cesium each close the last of their gaps in one pass, and now cover all 23
  kinds — two more than deck, which still has no `ego` layer and degrades
  `isoLines` to `path`.

  Before this, "alternate renderer" meant "the movement family, and then you go
  back to deck". The gaps were not exotic: cesium had no polygon, no column and no
  summary tiers; maplibre could not draw a `path`; three fell back to `point` for
  anything heatmap-shaped. Every one of those was a demo that offered a renderer
  toggle and then drew nothing recognisable.

  ### New layers
  - **`@poopdeck.gl/cesium`** (+17) — a PRIVATE workspace package, frozen at
    0.5.0 and source-only, so it carries no version bump of its own: `STTPolygonLayer`, `STTColumnLayer`,
    `STTIconLayer`, `STTTextLayer`, `STTMeshLayer`, `STTBoundingBoxLayer`,
    `STTSurfelLayer`, `STTPointCloudLayer`, `STTHeatmapLayer`, `STTHexbinLayer`,
    `STTH3SummaryLayer`, `STTQuadbinSummaryLayer`, `STTFlowmapLayer`,
    `STTFlowCorridorLayer`, `STTFlowStrokeLayer`, `STTIsoLayer`, `STTEgoLayer`.
  - **`@poopdeck.gl/maplibre`** (+8): `STTPathLayer`, `STTTextLayer`,
    `STTMeshLayer`, `STTBoundingBoxLayer`, `STTSurfelLayer`,
    `STTPointCloudLayer`, `STTIsoLayer`, `STTEgoLayer`.
  - **`@poopdeck.gl/three`** (+6): `STTHeatmapLayer`, `STTHexbinLayer`,
    `STTTextLayer`, `STTMeshLayer`, `STTPointCloudLayer` (the new phong-lit one —
    see the separate breaking-rename entry), `STTFlowStrokeLayer`.

  ### Capabilities

  `liveBundling`, `userExtensions` and `timeAsHeight` are now true on all four
  backends; `cameraRoll` on all three non-deck ones (deck's `MapView` has no roll
  axis). Two flags stay honestly false and are not gaps to close later:

  - **cesium `gpuHeatmap`** — CesiumJS gives a primitive author no
    render-to-texture splat pipeline, so `STTHeatmapLayer` accumulates its density
    field on the CPU and uploads a raster. It renders the same image; it is not a
    GPU heatmap, and claiming the flag would be a lie a consumer could budget
    against.
  - **three `interleavedBasemap`** — structural, not unbuilt. TSL compiles to the
    renderer's own node graph; there is no seam to hand a foreign GL context.

  ### `@poopdeck.gl/core` — `./edge-bundling`

  KDEEB edge bundling (Hurter/Ersoy/Telea 2012; CUBu) is hoisted out of
  `@poopdeck.gl/layers` into a new `@poopdeck.gl/core/edge-bundling` subpath, so
  all four backends run **one** `bundleEdges` rather than four transcriptions of
  the same splat → advect → resample → smooth → anneal schedule. A bundle is a
  function of the edge SET alone — not the playhead, not the camera — which is
  what makes sharing it correct rather than merely convenient. deck keeps its GPU
  ping-pong (it already owns a luma `Device`, so the splat is free there) and
  agrees with the shared kernel on the schedule and the constants.

  `@poopdeck.gl/layers` re-exports the moved symbols from their old path, so
  nothing breaks; the copies are gone.

## 0.6.0

### Minor Changes

- d5163aa: Packed `formatVersion: 3` — tiles are addressed by variant, not just by `(z,x,y,t)`

  A raw tile and a summary (H3/Quadbin) tile could occupy the same
  `(zoom, x, y, time-bucket)` address, because that address had no room to say
  _which product_ it named. The two collided in the directory and in every client
  cache keyed on it. v3 adds the missing axis:
  - **`manifest.variants` is a required registry.** Every directory entry's
    `variant_id` resolves to exactly one entry in it. Variant 0 is always `raw`;
    the canonical summary variant is 1.
  - **Directory codec v6** carries `variant_id` per entry, and object magic moves
    to version byte 3.
  - **Sparse archives now pick the single-frame directory automatically** and
    archives with ≥ 8,192 entries page by default, instead of the previous fixed
    choice.

  **Readers open v2; writers only emit v3.** The window is deliberately
  asymmetric and read-only: a published archive is a durable artifact and several
  have no reproducible source, so a read-side cutover would strand them rather
  than migrate them. A v2 manifest has no `variants` key, which is not missing
  information — it _is_ the implicit raw-only registry, and its directory decodes
  every entry to variant 0. v1 is refused. There is no transcode path in either
  direction, and v2 forks in the container only, never below the layer frame.
  Both reference implementations pin the window as
  `MIN_PACKED_FORMAT_VERSION ..= PACKED_FORMAT_VERSION`.

  **Tile keys carry the variant.** The canonical key is now
  `z/x/y/t#<variant>` (plus the existing `@<bucketMs>` suffix on a temporal-LOD
  tile), and `parseTileKey` reports `variantId` back. This string is embedded in
  the OPFS cache key, so **the first load after upgrading is cold** — previously
  cached tiles are orphaned, not corrupted. If you built keys by hand anywhere,
  switch to `tileKey`/`parseTileKey`: a hand-spelled `z/x/y/t` now aliases a
  summary tile onto its raw twin, which is the collision this release exists to
  remove.

  **What you have to do.** Nothing, to keep reading what you already publish. To
  publish _new_ archives, rebuild with the 0.6.0 `stt-build` — the output is v3.

- 2c020da: Packed format v1 is gone

  Through 0.5.x the reader accepted the transitional 0.3.x layout
  (`formatVersion: 1` — no object magic, the old layer frame, no manifest
  `schemas` table) alongside the current one. That path existed only to keep
  already-published archives readable while they were migrated. They have been,
  so it is removed.

  **What this means for you**
  - A `formatVersion: 1` archive no longer opens. `STTArchive` fails at open with
    `unsupported formatVersion 1` rather than half-decoding it. Rebuild the
    archive with current `stt-build`.
  - The published `manifest.schema.json` describes the version this release
    writes. See the `formatVersion: 3` entry for the read window that replaced
    this one — v2 stayed readable, v1 did not.
  - `stt-serve` now emits the current layer frame (self-contained, schema inline)
    and advertises `formatVersion` on `/metadata.json`, so a client can tell what
    it is being served before it fetches a tile.

  Everything a current archive does is unchanged — this only removes the ability
  to read the retired one.

  **Also removed**
  - `ArchiveOptions.verifyChecksums`. Blob CRC-32C verification is now
    unconditional; the escape hatch existed for the rollout and cost far less
    than the zstd decode it guards.
  - The shared request scheduler's `enabled` flag and the per-archive fallback
    runner it selected. Every archive routes through the process-shared
    scheduler; `configureSharedScheduler({ maxRequests })` still re-tunes the
    global budget.
  - `ArchiveOptions.cache` and `ArchiveOptions.maxCacheSize`, which nothing read.
  - `@poopdeck.gl/cesium`'s `Cesium*Layer` aliases (use the `STT*` spellings).
    That package is unpublished/experimental, so it carries no version of its own.

- d5163aa: Size targets, dataset-global encoding decisions, and a client that prices its own work

  The optimizer treated each tile as its own universe and the client guessed at
  what it could afford. Both are now answered from evidence. Full record:
  `docs/roadmap/optimization-conformance-2026-08.md`.

  **`stt-build --target-size <SIZE>`.** Ask for an archive size and the builder
  solves for the knobs that reach it — zoom clamp, temporal bucket, quantization
  — reporting what it chose and why. It never reaches a target by thinning:
  the no-default-thinning rule is a constraint on the solver, not a suggestion,
  so a target that can only be met by dropping features is refused with the
  shortfall stated rather than silently met.

  **Two-pass builds decide from the dataset, not from one tile's rows.** Numeric
  affines and the dictionary-vs-`Utf8` verdict are now pinned across the whole
  dataset, so a column cannot ship `UInt16` in one tile and `Float64` in the next
  — the drift that made `stt-validate` report structural churn on correct
  archives. The dictionary hoist that follows moves a shared category list out of
  every tile's tail and into the manifest schema template (measured −12.2% wire
  on a 380,007-feature build), and the reader shares one array instance across
  tiles that resolve to the same template rather than rebuilding it per tile.
  Hoisting is capped (1,024 categories / 4,096 category-bytes) so a
  high-cardinality free-text column stays `Utf8` instead of pinning a large list
  into every resident tile.

  **Tile selection is frustum-based.** Under pitch the old bounds-rectangle
  selection asked for tiles no camera could see. Measured across a 432-camera
  pitch × bearing matrix, the reduction is 16.9–21.6× at pitch 70 and 32.9–41.4×
  at pitch 85. Below pitch ~65 the two agree closely (1.3–3.1×), which is the
  honest shape of the win — it is a steep-camera lever.

  **The client prices its own work.** A cost oracle estimates decode and upload
  cost per tile so budgets are spent against measured bytes and measured time
  instead of tile counts, and the playback governor's scheduling is fair across
  sources rather than first-come.

  **Archives can now prove their own content.** `stt-build --content-fingerprint`
  folds a fingerprint over decoded features; `stt-validate --expect-fingerprint`
  checks a rebuild against it. This is what catches the failure structural
  validation cannot see — 106 archives once passed validation with silently
  scrambled coordinates. Note the boundary: the fingerprint is folded by the same
  binary that writes the tiles, so it is a tiler check, not a source-parse check;
  only `--expect-fingerprint` against a previously-built archive crosses that
  line.

  Also new: `--bounds-mode` (attest `metadata.bounds` over real vertices instead
  of centroids) and `--feature-id-scope`.

- a7b57dc: Tile payloads are re-encoded — rebuild and republish every archive

  Six wire changes land as **one** churn event, on purpose: content addresses are
  blake3 of the bytes, so batching them means the fleet re-uploads once instead of
  six times. Each change either rides a `manifest.capabilities` declaration or is
  strictly additive, so none of them needed an envelope bump of its own — they
  were authored against `formatVersion: 2` and left the object layout and
  addressing rules untouched. (The envelope did move in this same release, for an
  unrelated reason: see the `formatVersion: 3` entry, which adds the variant
  axis. Both land in one re-upload.)

  **What you have to do.** Rebuild each archive with the 0.6.0 `stt-build` and
  re-upload it. Every pack hash changes even for archives already on
  `formatVersion: 2`, so this is a full re-upload rather than a delta — use
  `--no-prune` and let the retention window pass before deleting the old objects.

  **Reader/writer compatibility.** A default 0.6.0 archive declares the new
  `time-delta` capability, and a 0.5.x reader refuses any capability outside its
  own set **at open** — "dataset requires capabilities this reader does not
  implement" — rather than misdecoding the re-typed columns. So the failure is
  loud in the direction that matters: an old client will not silently read
  millisecond offsets as absolute Unix times. A
  0.6.0 reader opens every 0.5.x archive unchanged. `stt-build --no-compact-times`
  suppresses the capability if you need to serve readers you do not control.

  **The six changes**
  - **Arrow IPC buffer alignment 64 → 8 bytes** (unconditional). 8 is what the
    Arrow IPC spec requires; 64 is a SIMD _recommendation_ arrow-rs defaults to.
    Refunds a fixed 445–1300 B per tile blob — −4.0% uncompressed on
    110-feature event tiles, and it halves one-feature property sections.
  - **Compact feature times** (`TILE_META.st`/`.et`, capability `time-delta`,
    **on by default**). `start_time` becomes a `UInt32` offset from the tile's
    `t0`, `end_time` a `UInt32` duration — or is dropped entirely when every
    feature is instantaneous. −13.1% uncompressed on an all-instantaneous corpus.
    This is a decode/memory lever, **not** a wire lever: sorted absolute `Int64`
    compresses better, so packed bytes go _up_ ~3% on that corpus. It buys
    uncompressed size and removes a `Number(BigInt)` per feature on the JS side.
    Kill switch: `--no-compact-times`.
  - **`vertex_time` as `List<UInt32>`** (unconditional) — −14.25% uncompressed on
    a 20-hour track corpus, same compressed-vs-uncompressed trade as above.
  - **`part_offsets`** (additive column, emitted only for multi-part layers) —
    per-feature ring boundaries, so a MultiPolygon's parts survive the round trip.
    +7.40 B/feature where emitted, zero bytes on single-part datasets.
  - **`--quantize-vertex-values`** (opt-in, capability `vertex-value-quant`).
    Stores `vertex_value` / `vertex_value_matrix` as `UInt16` under a per-column
    affine — **exactly half** those columns' bytes, which is −48.2% of _all_
    uncompressed tile bytes on a corridor dataset. Off by default because it is
    genuinely lossy.
  - **Exact-integer attribute quantization** (fixes `--quantize-attrs-auto`;
    `attr-quant` is unchanged). An integer column now round-trips exactly instead
    of being mapped onto a fractional `span/65535` step. This was silently
    decoding OSM node ids ~84k off. Columns whose magnitude exceeds `i32::MAX`
    refuse quantization and stay `Float64`; the test is on magnitude, not on
    span, so the same column cannot ship `UInt16` in one tile and `Float64` in
    the next.

  **Two builder bugs fixed in the same pass**
  - MultiPolygon parts were earcut as one ring list, i.e. parts 2..n were bridged
    as holes of part 1 — wrong on every multi-part feature in the probe corpus.
    The trigger is not exotic: the tiler emits a MultiPolygon whenever clipping
    cuts one source polygon into pieces inside a tile. Single-part polygons are
    byte-identical before and after.
  - Unreadable geometry was replaced with fabricated placeholders (a single-point
    "line", a one-vertex "ring"). It is now dropped and counted, so
    `metadata.feature_count` for affected sources goes **down** — and becomes
    honest.

  `stt-serve` keeps compact times **opt-in** (`--compact-times`): a served tile
  carries no manifest, so a client cannot refuse a capability it has never been
  told about. Rationale and full measurements:
  `docs/roadmap/stt-packed-format-decisions.md` §10.

- d5163aa: Removed: `emitGLSL300` (and Cesium's `timeFilterAlphaGlsl` wrapper)

  `@poopdeck.gl/core/shader-codegen` no longer exports `emitGLSL300`, and
  `@poopdeck.gl/cesium` no longer exports `timeFilterAlphaGlsl`. Neither was in
  any render path: no shipped shader was ever generated from the expression AST,
  and the Cesium GPU-`Appearance` path the wrapper anticipated was never wired —
  every Cesium layer CPU-filters through `timeFilterAlpha`. `emitGLSL100` had
  already gone the same way, for the same reason.

  **Not removed, and the reason the module still exists:** `ALPHA_EXPR` and
  `evalExpr`. They are the **second oracle** — a branchless, independently
  derived statement of the same alpha math that each backend's hand-written
  shader is pinned to by a conformance test. Conformance compares the alpha
  _value_, not the shader _text_, so the emitter was never what made it work.

  `docs/spec/render-spec.json` now declares an empty `emitters` list, and a
  contract test asserts both removed names stay absent — so an emitter cannot
  quietly return without something that compiles its output.

  **If you were calling it** (unlikely — the Cesium package is unpublished and
  core's emitter had no other caller): the op-set is frozen and tiny
  (`uniform`, `attr`, `const`, `add`, `sub`, `mul`, `div`, `min`, `max`, `step`,
  `clamp01`, `select`), so walking `ALPHA_EXPR[mode]` to a string is a short
  function. Emit `select` as a ternary to keep the divide-by-zero fade guard
  lazy.

- 2a58eb4: One `STT` prefix for every layer class, so nothing shadows deck.gl

  deck.gl is the primary backend, so a real app imports `@deck.gl/*` and
  `@poopdeck.gl/*` into the same module constantly. Any name exported by both is
  therefore unwritable: TypeScript rejects the duplicate identifier, and in plain
  JS whichever import evaluates last wins. Through 0.5.x we shipped twelve such
  names. They are renamed, and **the old spellings are gone** — this is a clean
  break rather than a deprecation window, taken while the project is still
  pre-1.0. Update any import of a name in the table below to its new spelling.

  **What collided, and what it is now**

  | Package               | 0.5.x                 | 0.6.0                    | Collided with         |
  | --------------------- | --------------------- | ------------------------ | --------------------- |
  | `@poopdeck.gl/three`  | `ArcLayer`            | `STTArcLayer`            | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `IconLayer`           | `STTIconLayer`           | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `ColumnLayer`         | `STTColumnLayer`         | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `PolygonLayer`        | `STTPolygonLayer`        | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `PointCloudLayer`     | `STTPointCloudLayer`     | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `TripsLayer`          | `STTTripsLayer`          | `@deck.gl/geo-layers` |
  | `@poopdeck.gl/layers` | `DataFilterExtension` | `STTDataFilterExtension` | `@deck.gl/extensions` |
  | `@poopdeck.gl/core`   | `Layer`               | `STTTileLayer`           | `@deck.gl/core`       |
  | `@poopdeck.gl/core`   | `Position`            | `STTPosition`            | `@deck.gl/core`       |

  `DataFilterExtension` was the sharpest of these: deck's class and ours are
  _different implementations with different contracts_ (deck runs a JS
  `getFilterValue` accessor per row; ours binds a baked binary column named by
  `filterProperty`) — and `@poopdeck.gl/layers` imports both, because the heatmap
  and hexagon composites drive deck's stock extension over CPU rows. Same name,
  two classes, one package.

  `Layer` was the most in the way: `@deck.gl/core`'s `Layer` is the base class
  every deck layer extends, and every consumer inside this repo had already been
  forced to write `import { Layer as TileLayer } from '@poopdeck.gl/core'`.

  **Also renamed, for consistency rather than collision**

  `@poopdeck.gl/maplibre` already prefixed all fifteen of its layer classes with
  `STT`. `@poopdeck.gl/three` and `@poopdeck.gl/cesium` now match, so one layer
  kind has one spelling on every backend and the import path — not a redundant
  word inside the symbol — tells you which renderer you are on:
  - `@poopdeck.gl/three`: the remaining fourteen layer classes (`SurfelLayer` →
    `STTSurfelLayer`, `WideLineLayer` → `STTWideLineLayer`, `FlowmapLayer` →
    `STTFlowmapLayer`, and so on) plus every `*LayerOptions` type. Four of these
    (`FlowmapLayer`, `FlowCorridorLayer`, `H3SummaryLayer`, `QuadbinSummaryLayer`)
    had also been shadowing `@poopdeck.gl/layers`.
  - `@poopdeck.gl/cesium` (unpublished/experimental): `CesiumPointLayer` →
    `STTPointLayer`, and the same for path / arc / trips / tripHeads /
    batched-polyline.

  **Deliberately NOT renamed**
  - `@poopdeck.gl/layers`' `Animated*` layer family (`AnimatedPointLayer`,
    `AnimatedArcLayer`, …). The prefix already means "the time-animated variant of
    deck's X", it is already unique, and mirroring deck's vocabulary is the point.
  - `CollisionFilterExtension` in `@poopdeck.gl/layers`. It re-exports deck's own
    class unchanged, so both packages hand you the identical object — nothing to
    shadow. A test asserts that identity so the exemption cannot rot.
  - `Cesium*` camera/clock bridges (`CesiumView`, `attachCesiumClock`, …), which
    are named after CesiumJS concepts, not STT layer kinds.

  **Breaking changes**

  Every 0.5.x spelling in the table above has been removed; import the `STT*`
  name instead. A test (`deck-name-collisions.test.ts`) asserts none of them can
  be reintroduced and re-shadow deck.

  Also non-additive: `STTDataFilterExtension.extensionName` is now
  `'STTDataFilterExtension'` (was `'DataFilterExtension'`), and the renamed
  classes report their new names via `constructor.name`. Only code that compares
  those strings is affected.

## 0.4.0

### Minor Changes

- Packed formatVersion 2 reader: manifest-embedded schema templates
  (blake3-validated at open, distributed to decode workers on every spawn),
  layer-frame v2 with sectioned payloads + TILE_META, splice guards that
  fail loudly instead of silently emptying tiles. v1 archives decode
  byte-for-byte as before.
- Integrity: CRC-32C verification of every fetched blob (default on,
  `verifyChecksums: false` to disable) with poisoned-cache eviction and
  per-tile isolation; pure-TS blake3.
- `manifest.capabilities` must-understand gate: datasets declaring unknown
  capabilities are refused loudly at open.
- `retainArrowIpc: 'auto'` (default) drops raw IPC bytes only for
  coordinate-quantized layers; `toGeoArrowTable()` keeps working wherever
  its output is valid GeoArrow.
- Temporal-LOD addressing: `TileId.bucketMs` disambiguates pyramid tiers
  from base tiles across every cache key.
- Scrub-LOD hooks: `scrubLod` tileset option (spatial zoom-drop and/or
  temporal-pyramid routing while scrubbing; default off).
- Honest cache accounting: `estimateTileSize` deduplicates aliased buffers —
  zero-copy datasets now genuinely fill `maxCacheByteSize` where they
  previously plateaued around half.

## 0.3.0

### Minor Changes

- Reader-side style hints. Add `parseStyleHints` and `suggestedDomainFor`, plus
  the `StyleHints` / `PropertyStyleHint` types, so an archive can carry render
  defaults (color domains, property roles) that the layers consume.

## 0.2.0

## 0.1.1

### Patch Changes

- Correct the published READMEs: the 0.1.0 tarballs still carried the
  pre-release "Not yet published to npm — consume it from the monorepo"
  banners. Install sections now lead with the real `npm install` commands.
