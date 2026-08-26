# @poopdeck.gl/playback

## 0.7.0

### Minor Changes

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

### Patch Changes

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

## 0.6.0

### Minor Changes

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

## 0.4.0

### Minor Changes

- `PlaybackGovernor.isScrubbing` + `scrubstart`/`scrubend` events, and the
  optional `BufferSource.setInteractive(bool)` broadcast (drives scrub-LOD
  in the tileset). The interactive bit is asserted on source add and cleared
  on remove/replace/dispose.

## 0.3.0

## 0.2.0

## 0.1.1

### Patch Changes

- Correct the published READMEs: the 0.1.0 tarballs still carried the
  pre-release "Not yet published to npm — consume it from the monorepo"
  banners. Install sections now lead with the real `npm install` commands.
