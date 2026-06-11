# Aspect-by-Aspect SoTA Review — 2026-06-10

Seven parallel investigations, one per documented aspect of the system (per `docs/README.md`),
each comparing the **actual implementation** against current (mid-2026) external state of the art
and best practices. External claims were verified against live sources (PMTiles spec, GeoArrow 0.2,
MLT, hls.js/Shaka docs, MapLibre v5 API docs, GeoParquet 1.1, planetiler architecture, caniuse/MDN).
Prior internal audits (`sota-eval-2026-06`, `deckgl-ecosystem-audit-2026-06`,
`upstream-library-study-2026-05`, `animated-paths-perf-audit-2026-05`) were read first; findings
below are marked **[NEW]** or **[KNOWN]** relative to them. Those audit files have since been
deleted — this review consolidates their still-live findings and is the single surviving record.

## Verdict at a glance

| Aspect | Standing vs SoTA | Headline |
|---|---|---|
| Packed container | **Ahead** of PMTiles on immutability/integrity | Uncompressed `.sttd` (2.1× waste); deploy prune contradicts spec |
| Tile payload | At SoTA on GeoArrow/pre-tess; **ahead** on temporal axis | IPC misalignment silently defeats zero-copy on every tile |
| Reader / loader | **Ahead** of deck.gl/Cesium baselines | No fetch timeout anywhere — stalls hang forever |
| deck.gl layers | Several **publishable differentiators** | Prior audit's priority-1 fixes still unlanded; latent alpha bug behind them |
| Playback governor | Genuinely **novel** (no external equivalent) | Tab-refocus teleports the playhead; zero QoE telemetry |
| MapLibre adapter | Solid GL engineering, **stale integration** | Missed all 2026-06 loading wins + governor (pure wiring); v5 claim is false |
| Rust toolchain | Blob ordering + validate **ahead**; input side weakest | GeoParquet `geo` footer ignored; builds not byte-reproducible |

**Cross-cutting themes**

1. **The differentiating core is real and verified.** Immutability-by-construction + blake3 CAS is
   strictly stronger than PMTiles (whose JS client needs an ETag-mismatch subsystem and still has
   open bugs). The throughput estimator is a line-for-line-correct hls.js dual-EWMA. The
   directory-exact `estimateCost`/`predictsPlaythrough` lookahead is something no shipping video
   player has. Time-as-height, VAT, and the heatmap rewrite have no upstream or ecosystem analog.
2. **A silent-corruption cluster on the producer/payload side** ([NEW], all): IPC frame
   misalignment (copy-per-buffer on every real tile), unbounded `vertex_time` quantization that
   contradicts both the docs and the no-thinning principle, pre-1970 timestamps wrapping via
   `as u64`, GeoParquet CRS metadata ignored (projected-CRS inputs build garbage silently),
   non-total pack ordering keys making rebuilds non-reproducible (breaks the immutable-pack CDN
   economics), polygon ring loss on the non-pre-tessellated path.
3. **Hardening that video players treat as table stakes is missing**: transfer timeouts,
   frame-delta clamping on tab refocus, failure-aware throughput decay, eviction/in-flight
   coupling, multi-tab OPFS safety.
4. **Parity drift is the recurring failure mode**: the MapLibre adapter and `H3SummaryLayer` both
   missed the batch-coalesce/prefetch/governor wins — in both cases the fix is wiring, not new
   code. The deck.gl prior-audit fixes sat unlanded through a feature sprint.
5. **Doc drift is now production UI.** The in-app `/docs` site serves `docs/*.md`; the API docs
   state wrong defaults, wrong limits, dead callbacks, and omit five exported classes — on the
   critical path of the stated #1 ecosystem move (npm publish).

---

## 1. Packed container format & caching model

**Baseline checked:** PMTiles v3 spec, COMTiles, Zarr v3 sharding (ZEP0002), OCI/CAS practice,
RFC 8246; zstd `Content-Encoding` now universal but `DecompressionStream('zstd')` still unshipped
(fzstd choice remains correct).

**At/ahead of SoTA**
- Immutability-by-construction eliminates the PMTiles torn-read/ETag failure class entirely
  (pmtiles issues #24/#90/#326/#415/#427 cannot happen here). Strictly stronger, not "matching".
- Format-intrinsic integrity (`verify_packed_objects`: blake3 + lengths + pack_id ranges;
  `pack.rs:513-603`) — PMTiles v3 has *no* integrity provisions at all.
- Two-regime Cache-Control with objects-before-pointer deploy ordering (`scripts/r2-sync.sh:82-124`)
  is the textbook RFC 8246 pattern.
- Reader fetch pipeline (coalescing, bounded pool, jittered retry + per-member fallback, OPFS keyed
  on directory hash) exceeds the pmtiles JS client.

**Gaps**
- **[MEDIUM][NEW] `.sttd` is uncompressed at rest.** PMTiles compresses directories; measured
  2.1× on production dirs (flights 6.38→2.97 MB at zstd-19). Cold-start critical path, no CDN
  content-encoding rescue. `pack.rs:405-409`, `archive.ts:567-577`. Design with per-section framing
  so the planned section offsets keep partial reads.
- **[MEDIUM][NEW] Deploy prune contradicts "never purged" and can 404 live sessions.** Spec §2
  promises forever-cached packs; `r2-sync.sh:100-102` prunes on every sync while 60s-cached
  manifests and never-refreshed in-memory manifests (`archive.ts:367`) still reference old packs.
  PackWriter also never cleans `out_dir` → orphan packs synced as garbage. Needs retention-aware GC
  (keep packs referenced by last K manifests), OCI-style.
- **[MEDIUM][NEW] TS reader trusts the transport; Rust reader verifies.** No 206 Content-Range/
  length validation (`archive.ts:446-456`), crc32c read but skipped (`directory.ts:201`), directory
  length unchecked. A truncated 206 silently corrupts every member sliced from a coalesced buffer.
- **[LOW][NEW]** Cold start costs one extra serial RTT vs PMTiles (manifest→directory→tiles); an
  additive `directory.inline` for small datasets would reach parity.
- **[LOW][NEW]** Manifest/directory GETs lack the retry hardening tile ranges have (single-attempt).
- **[LOW][NEW]** `manifest.schema.json` blanket `additionalProperties:false` blocks the
  already-planned additive evolution (generation field, section offsets) — relax to
  ignore-unknown-at-envelope **before** npm publish creates external strict validators.

**Doc drift:** spec §5 zoom-boundary pack cutting not implemented; "never purged" vs prune;
`data-format.md:387` says 32 KiB coalesce gap (actual: 2 MiB); `concepts.md` predates packed format
and BlobOrdering::Auto; stale single-file-era comments in `archive.ts` (~318, ~269).

## 2. Tile payload (Arrow IPC + GeoArrow)

**Baseline checked:** GeoArrow 0.2, MLT (stable Oct 2025, now natively in MapLibre GL JS),
apache-arrow JS 21.1 (compressed-IPC read shipped Oct 2025), ALP/ALP-RD (SIGMOD 2024, in
DuckDB/Vortex), RFC 8878 dictionaries, loaders.gl BinaryFeatures.

**At/ahead of SoTA**
- GeoArrow 0.2 conformance is real and test-pinned (extension names + `OGC:CRS84` metadata,
  `arrow_tile.rs:43-56,509-524`); interleaved FixedSizeList is what lonboard consumes zero-copy.
- Pre-tessellated polygons = MLT's IndexBuffer+VertexBuffer idea, shipped before MLT went stable.
- Temporal columns (u16-delta `vertex_time` with (origin,step) metadata) are **ahead of every
  external tile format** — none carries a temporal axis at all.
- Whole-blob external zstd was the correct call for its era (arrow-js couldn't read compressed IPC
  until 21.1); dictionary-overflow bug from the prior audit confirmed fixed.
- RLE temporal directory + blake3 dedup extends the PMTiles run-length idea to time.

**Gaps**
- **[MEDIUM][NEW] Layer-frame misalignment defeats zero-copy decode.** The `[u16][u16][name][u32][ipc]`
  frame (`arrow_tile.rs:645-666`) puts the IPC stream at byte 15 for layer "default" — verified
  experimentally with the pinned apache-arrow 17: offset 0 → zero-copy views, offset 15 → **silent
  full copy of every buffer of every tile**. The architecture's zero-copy claim is currently false
  on the hot path. Fix: pad to 8-byte alignment after `ipc_len` (cheap, self-describing).
- **[MEDIUM][NEW] Dropping shared zstd dictionaries costs ~6× on small tiles — now quantified.**
  Per-tile IPC framing is ~2.1-2.5 KB regardless of feature count; 8-feature tile: 947 B plain vs
  159 B with a 16 KiB trained dict. The packed container makes the fix clean: one content-addressed
  dict object referenced from the manifest + dict-capable WASM zstd in the worker.
- **[MEDIUM][NEW] `vertex_time` quantization is unbounded; the documented i64 fallback never fires.**
  `step = ceil(span/65535)` with no ceiling (`arrow_tile.rs:399-435`): a 30-day LOD bucket
  quantizes to ±20 s silently. Docs and the code's own comment claim a lossless fallback that
  doesn't exist (the unit test admits it). Violates the no-thinning ethos. Bound the step; the
  reader fallback path already exists (`tile.ts:199-207`).
- **[MEDIUM][NEW] BinaryFeatures discards polygon ring boundaries** → holes mis-tessellate on the
  non-pre-tessellated path (`tile.ts:144-168`, `_normalize:false` unconditional at
  `animated-polygon-layer.ts:427`). loaders.gl defines `primitivePolygonIndices` precisely for this.
- **[MEDIUM][NEW] The marketed GeoArrow Table hand-off is unreachable on the default decode path** —
  the worker strips `arrowTable` before postMessage, so `toGeoArrowTable()` throws for 100% of real
  browser users. Fix: transfer the raw IPC bytes, rehydrate lazily.
- **[MEDIUM][NEW]** No float-specific lossless encoding on coordinates; ALP-RD / byte-stream-split
  are bit-exact (respect no-thinning, unlike the old f32-rebase idea) and arrow-js 21.1 newly makes
  an IPC per-buffer compression experiment feasible. Measure-first.
- **[LOW][NEW]** `vertexValues` missing from `collectTransferables` → structured-clone copied per
  tile (one-line fix); also absent from both normative docs.
- **[LOW][KNOWN]** apache-arrow pinned at ^17, four majors behind; 21.1 is the unlock for the
  compression experiment.

**Doc drift:** `data-format.md` schema table omits `vertex_value`; the lossless-fallback claim is
false; 32 KiB coalesce gap stale; `binary-features.md` omits `vertexValues` and overstates
loaders.gl alignment exactly where holes break.

## 3. Reader / tile loading

**Baseline checked:** hls.js bandwidth estimator + `fragLoadingTimeOut`, Shaka retryParameters,
Cesium RequestScheduler, deck.gl TileLayer, Fetch Priority API, OPFS sync-access-handle practice.

**At/ahead of SoTA**
- Throughput estimator is a faithful hls.js dual-EWMA (3s/9s half-lives, duration weighting,
  warm-up bias correction, min(fast,slow)) — `throughput.ts:55-123`. Few non-video projects get
  this right; deck.gl and Cesium have no estimator at all.
- The request pipeline (coalescing, whole-batch slot accounting, tier-aware supersession,
  throughput-sized prefetch slices, fetchpriority) is a superset of deck.gl's and Cesium's
  behaviors on the temporal axis. Prior-audit work verified as actually shipped.
- Buffer-model APIs (runway/cost/ETA/ranges/overview tier) have **no external equivalent** —
  byte-exact MPC-style lookahead video players cannot do. Survived code inspection.
- Worker-pool decode (least-pending dispatch, crash respawn, transferables) is at SoTA practice.

**Gaps**
- **[HIGH][NEW] No transfer timeout / stall watchdog anywhere.** hls.js defaults 20 s, Shaka ~30 s.
  A TCP-stalled response hangs forever; stalled batch members stay `isLoading`, are never
  re-requested for a paused viewport, and the governor sits in 'buffering' with a frozen ETA.
  Fix: `AbortSignal.timeout` composed into `fetchRange`, timeout treated as retryable.
- **[MEDIUM][NEW] Throughput sampled per-request under 24-way concurrency → systematic ~N×
  underestimate.** Each concurrent request sees link/N (`archive.ts:900-923` vs pool at :952-969).
  Collapses prefetch slices toward the floor, inflates ETAs, slows Auto-speed. Sample at
  batch/aggregate granularity instead.
- **[MEDIUM][NEW] Grace-period eviction can delete in-flight headers without aborting** →
  delivery to a captured header inflates `currentCacheBytes`/counts forever
  (`spatiotemporal-tileset.ts:2461-2475` no `isLoading` guard; :1669-1681). Two-line fix.
- **[MEDIUM][NEW] Per-archive pools/estimators — no global scheduler.** Two datasets = 48
  concurrent requests to one host, each estimator seeing half the link. Cesium solved this with a
  static per-server RequestScheduler.
- **[MEDIUM][NEW] OPFS cache has no multi-tab story** — last-writer-wins `index.json`, orphan
  `.bin` files eviction can never reclaim, no Web Locks, fixed 512 MB budget regardless of quota.
- **[LOW][NEW]** OPFS I/O on the main thread instead of sync handles inside the existing decode
  workers; cold-start throughput has no persisted prior (hls.js seeds a default estimate).
- **[LOW][KNOWN-adjacent]** Coverage-index rebuild materializes the viewport's full-time directory
  slice on the main thread per pan/zoom — a new multiplier on the known §3.1 directory wall.

**Doc drift:** `spatiotemporal-tileset.md` wrong defaults (maxRequests 12 vs 24, maxZoom 22 vs 14)
and omits the entire 2026-06 buffer-model surface — the worst doc/code divergence for a surface
third parties would integrate against. `stt-loader.md` documents a vestigial loaders.gl shape whose
`parse()` now unconditionally throws.

## 4. deck.gl layers + GPU extensions

**Baseline checked:** deck.gl 9.3.3 is latest (9.4 NOT released — in-code "9.4 picking" references
are bets, not facts); upstream WebGPU still WIP; DataFilterExtension / getFilterCategory /
aggregation-layers; installed @luma.gl 9.3.3 ShaderInputs semantics re-verified.

**At/ahead of SoTA**
- HeatmapLayer rewrite is a model citizen (canonical aggregation-layers + DataFilterExtension,
  consolidated cross-tile buffers, percentile-pinned domain, 30 Hz re-agg cap) — nothing in
  kepler/CARTO offers a time-scrubbing re-aggregating heatmap over remote tiles.
- Time-as-height via clip-space delta (turns unmodified layers into a space-time cube, zero-upload
  squash morph) has no upstream equivalent. Publishable differentiator.
- VatTripsLayer (trajectory textures; cost scales with active trips, not total vertices) — no
  ecosystem analog; careful GPU engineering throughout.
- f32 time-precision contract (single source of truth + tests + runtime warn) is better engineered
  than upstream's fp64-or-silent-loss answer.
- Shader-pipeline identity discipline consistently applied, including new uncommitted code.

**Gaps**
- **[HIGH][KNOWN] None of the prior audit's priority-1 fixes have landed** — getUniforms scalar
  drop (palette path still dead at runtime), polygon stepping bug, `finalizeState` super-call leak,
  addInstanced/stepMode misuse, stale cache keys — while new shader features were built on top.
- **[MEDIUM][NEW] Latent: CategoryColor's palette sample OVERWRITES the temporal alpha.** The
  extension order ([timeFilter, categoryColor]) means fixing the known getUniforms bug will
  silently break fades/wake on every GPU-categorical layer — invisible today only because the
  first bug keeps the path dead. The fix must ship as `color = vec4(p.rgb, p.a * color.a)` in the
  same changeset, plus a ShaderInputs-level regression test.
- **[MEDIUM][NEW] H3SummaryLayer bypasses the batch coalescer and drops the AbortSignal** —
  the summary tier (built for wide low-zoom views where coalescing pays most) misses the −89%
  request wins and can't cancel in-flight fetches (`h3-summary-layer.ts:451-475`).
- **[MEDIUM][NEW] API docs actively misinform and are now production UI** (256 vs 4096 palette,
  wrong defaults, never-fired `onViewportLoad`, missing timeOffset contract; no pages at all for
  VatTripsLayer / H3SummaryLayer / SphereShadeExtension / PlaybackGovernor).
- **[LOW][NEW]** One 16 KB palette texture per tile sublayer, re-uploaded per tile — should live on
  the extension-instance singleton or deck's resourceManager.
- **[LOW][KNOWN]** Version-sensitive constructs (NoPickingPathLayer regex rewrite, VAT UBO peeking,
  raw `#version 300 es` Models) vs the `>=9.3.0 <10` peer range — add a CI canary test or narrow
  the range.

## 5. Playback & time control

**Baseline checked:** hls.js ABR factors (0.95 down / 0.7 up), Shaka BufferingObserver +
stallThreshold, HTMLMediaElement readyState/buffered semantics, Conviva-style QoE metrics,
fix-your-timestep game-loop practice.

**At/ahead of SoTA**
- Governor state machine matches or exceeds the HTMLMediaElement/ExoPlayer stall contract
  (freeze-not-blank, 2× resume hysteresis, frontier clamp = `currentTime ≤ buffered.end`).
- Deterministic MPC-style lookahead (`estimateCost` exact directory byte math +
  `predictsPlaythrough`) is genuinely ahead of media SoTA.
- Degraded creep is a principled improvement over video's stall-loop failure mode, honestly
  surfaced via `isCreeping`.
- State-machine test coverage is strong; every shipped 2026-06-10 bug has a regression test.

**Gaps**
- **[HIGH][NEW] No frame-delta clamp: tab refocus teleports the playhead** — rAF suspension makes
  the first refocus frame's `elapsed` the entire background duration (`time-controller.ts:195-199`),
  and the clamp's seek exemption (`playback-governor.ts:316-321`) deliberately refuses to catch
  jumps > 1 s. No `visibilitychange` handling exists. One-line `Math.min(elapsed, 250)` + re-anchor.
- **[MEDIUM][NEW] Estimator never learns from failures/dead networks** — fed only by completed
  responses; on network death the ETA chip lies forever and `predictsPlaythrough` suppresses the
  watermark stall. Emit pessimistic samples on retry / decay on silence (hls.js/Shaka do).
- **[MEDIUM][NEW] Zero playback-QoE telemetry** — no stall count/duration/startup/creep counters;
  the exact instrument that would have caught the freeze/lurch heartbeat in CI (a stall-count
  explosion) is missing. ~30 lines on existing transitions + a Playwright assertion.
- **[MEDIUM][NEW] Loop wrap is an ungated teleport-seek** — wrong gate factor (resumeFactor×2
  instead of the WS-C2 startup gate) and a 200 ms ungated blind window, paid every loop of every
  demo on slow networks.
- **[LOW][NEW]** Auto-speed deadband is symmetric where the plan doc itself prescribes asymmetric
  (immediate downshifts, damped upshifts; also react to the 'waiting' event).
- **[MEDIUM][KNOWN, sharpened]** All six post-ship bugs lived in governor↔real-tileset/React seams
  invisible to the mocked-BufferSource unit tests. Named missing layer: a Shaka-style simulated
  playback harness (real coverage index + scripted network + stepped clock + invariants).
- **[LOW][KNOWN]** Governor/TimeController remain deck.gl-package-only; maplibre consumers get the
  pre-2026 plays-through-gaps behavior (see §6).

**Doc drift:** `time-controller.md` omits `bounce`/`tickThrottleMs` and documents the deprecated
direct-drive path; **no `docs/api/playback-governor.md` exists** for the headline differentiating
feature; plan/implementation disagree on ABR asymmetry and seek-gate sizing.

## 6. MapLibre adapter

**Baseline checked:** MapLibre GL JS 5.24 stable / 6.0 pre (WebGL2-only, ESM-only); v5
CustomLayerInterface contract change (args object + `shaderData.vertexShaderPrelude` +
`projectTile()` for globe); PR #3854 matrix semantics.

**At/ahead of SoTA**
- Single-source time-filter GLSL with a CPU oracle test is above-SoTA cross-renderer practice.
- Instanced segment-quad rendering matches deck.gl's architecture, not the naive custom-layer
  pattern (4× GPU memory win); heatmap format probing is more defensive than deck.gl's own.
- MLT-aligned pre-baked triangle consumption; dual color-convention auto-detection.

**Gaps**
- **[HIGH][NEW] Loading-path parity drift**: wires only per-tile `getTileData` — no
  `getTileDataBatch` (global coalesce, −89% requests), no `getTileByteSize`, no
  `refinementStrategy` (`base-layer.ts:799-826` vs `spatiotemporal-layer.ts:800-855`). Pure wiring;
  the doc's "same scheduler under the hood" claim is materially false today.
- **[HIGH][NEW] The v5-compat claim would render a blank map.** Docs say "any v3/v4/v5 works";
  peerDeps pin `^3 || ^4`, and v5 replaced the matrix render arg with an args object —
  `new Float32Array(Array.from(matrix))` breaks. The in-code migration comment encodes the wrong
  v5 model. Material update to the globe estimate: v5's `projectTile()` prelude injection is likely
  **cheaper** than the previously-priced ~40-touchpoint matrix branch (NDC width math must be redone).
- **[MEDIUM][NEW]** PlaybackGovernor contract not exposed (no onBufferChange/getThroughput/
  tileset accessor) — buffered bar/Auto speed/stall logic structurally unavailable; ~30 lines.
- **[MEDIUM][NEW]** `setStroked`/`setExtruded` are documented runtime toggles but no-op (or
  half-break) on cached tiles — needs cache invalidation (deck.gl gets this free via updateTriggers).
- **[MEDIUM][NEW]** Worker projection is dead code (zero `projectAsync` call sites; pool has two
  latent bugs) while earcut + per-segment expansion run synchronously inside `render()`. Wire it
  into the three heavy builders or delete the pool.
- **[MEDIUM][NEW]** Absolute Float32 mercator caps usable zoom ~z15 (≈2.4 m quantization); deck.gl
  side is immune → visual divergence exactly on dense city data. Per-tile anchor-relative
  positions fix it and survive a later projectTile port.
- **[LOW][NEW]** Heatmap pass 2 assumes the default framebuffer — breaks under terrain/globe.
- **[MEDIUM][KNOWN]** Globe/summary-tier/picking/caps parity debt per `sota-eval` §2.3.

## 7. Rust toolchain + authoring pipeline

**Baseline checked:** tippecanoe (still no GeoParquet input), planetiler (worker-per-core,
external merge sort, deterministic 64-bit sort key), GeoParquet 1.1 reader requirements,
GeoParquet 2.0 / Parquet 2.11 native geometry types, geopandas 1.x, clap 4 practice.

**At/ahead of SoTA**
- Measured 3D space-time blob ordering with an Auto heuristic derived from a build-time simulator —
  no mainstream tiler does this. PMTiles is 2D-Hilbert-only; planetiler sorts (z,x,y).
- `stt-validate` is at/above `pmtiles verify` (full payload decode + three-way count cross-check).
- `--auto` autotune with per-flag provenance via `ValueSource` exceeds tippecanoe's `-zg`.
- Loud hard-failure on unsupported flag combos; streaming peak-RSS regression test in CI.

**Gaps**
- **[HIGH][NEW] GeoParquet `geo` footer ignored entirely on input.** No CRS gate (EPSG:3857 input
  builds silent garbage), `primary_column` ignored, native geoarrow encoding supported for
  separated-struct Points only — a geopandas `geometry_encoding="geoarrow"` LineString/Polygon file
  fails with a generic error (`input.rs:409-446, 494-525, 582`). Highest silent-corruption risk for
  external adopters.
- **[MEDIUM][NEW] Pack bytes are not reproducible across identical rebuilds.** Rayon/HashMap
  iteration order + non-total `space_time_key` (ties between base and temporal-LOD tiles; 21-bit
  cube cap collisions) → run-dependent pack bytes → different blake3 names → rebuilds of unchanged
  data invalidate the immutable-pack CDN contract. One-line tiebreak + build-twice CI test.
- **[MEDIUM][KNOWN residual]** Invalid/null geometry still **tiled at Null Island** (the 2026-05
  fix only excluded them from bounds). No `--strict-geometry`.
- **[MEDIUM][NEW] Pre-1970 timestamps silently wrap via `as u64`** (`input.rs:614,627,641`) — even
  under `--strict-times`. IBTrACS-class historical data corrupts the temporal index. Reject.
- **[MEDIUM][NEW] `--time-format` is unvalidated free text** consulted once; typos and the
  documented default silently mean unix-ms. clap `ValueEnum` fixes it for free.
- **[MEDIUM][KNOWN, sharpened]** Streaming path is single-threaded AND architecturally excluded
  from summary tiers — the no-thinning principle's sanctioned mitigation is unavailable on exactly
  the >10 GB inputs that need it; both pipelines re-clip O(Z×N).
- **[LOW][KNOWN]** stt-generate shells out to a sibling binary with ~8 of ~30 flags exposed
  (standardization-audit Phases 2-5 unlanded — confirmed zero `DatasetSpec` hits).
- **[LOW][NEW]** LargeBinary geometry columns detected but unreadable (detection/extraction
  disagree).

**Doc drift:** `cli-reference.md` still describes the v3 single-file era (wrong output format,
missing `--blob-ordering`/`--pack-size` flags, pre-packed stt-validate description, missing
generate subcommands). Recommendation: generate it from clap and CI-diff.

---

## Prioritized actions

**Now (small, high-value, correctness):**
1. deck.gl: land prior-audit items 1–4 as one changeset **with** the new alpha-composition fix
   (`color = vec4(p.rgb, p.a * color.a)`) + ShaderInputs regression test.
2. Loader: `AbortSignal.timeout` in `fetchRange`; `isLoading` guard in grace-period eviction;
   batch-level throughput sampling.
3. Playback: frame-delta clamp + `visibilitychange` re-anchor; loop-wrap through seek semantics.
4. Payload: 8-byte-align IPC frames (restores zero-copy); bound `vertex_time` quantization
   (implement the documented i64 fallback); add `vertexValues` to transferables.
5. Toolchain: pack-ordering tiebreak + build-twice test; `geo` footer CRS gate; reject negative
   timestamps; `--time-format` as ValueEnum.
6. Container: zstd-compress `.sttd` (with per-section framing); retry on manifest/directory GETs;
   relax manifest schema to ignore-unknown; retention-aware deploy GC.
7. MapLibre: wire `getTileDataBatch`/byte-size/governor hooks (~40 lines); fix the v5 docs claim;
   invalidate tile caches on setStroked/setExtruded.

**Next (medium):**
- Regenerate all `docs/api/*.md` from current code before npm publish; add pages for
  VatTripsLayer, H3SummaryLayer, SphereShadeExtension, PlaybackGovernor.
- Governor QoE counters + Playwright stall-count assertions; real-tileset playback simulation
  harness.
- Shared cross-archive request scheduler + estimator (Cesium pattern); OPFS multi-tab safety.
- Manifest-level shared zstd dictionaries (measured 6× on small tiles).
- H3SummaryLayer batch path as part of the planned de-dup against SpatioTemporalLayer.
- arrow-js 21.1 bump + measure-first coordinate-encoding experiment (per-buffer ZSTD / shuffle).
- MapLibre v5 bump via `projectTile()` prelude injection; per-tile anchor-relative positions.

**Large:**
- Summary tier inside the streaming pipeline, then parallelize streaming clip+assign (resolves the
  no-thinning contradiction for 100M+ point datasets).

*Full per-aspect detail (including every evidence ref and external source URL) was produced by the
seven workflow investigations on 2026-06-10; this document is the synthesis of record.*
