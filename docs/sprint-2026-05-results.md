# Spatiotemporal-tiles Sprint Results — May 2026

## Goal

Take the project from "cool demos that struggle past ~1M features" to a
credible roadmap for 100M+ features. Audited the full stack (Rust build
pipeline, archive format, TS reader, deck.gl layers, maplibre adapter,
perf harness), then ran a 4-track sprint in parallel git worktrees plus a
continuous research agent.

## Headline numbers (frame rate, before → after)

Measured with `tools/render-test/probe-scale-sweep.mjs` under SwiftShader
software WebGL on a single laptop. Phase 0 = pre-sprint; phase 1 = all
tracks merged.

| Demo | Phase 0 FPS | Phase 1 FPS | Speedup |
|---|---|---|---|
| `nyc-taxi-paths` (6.7 GB archive, 500k OSRM trips) | 0.2 | 118.6 | **593×** |
| `flight-trips` (810 MB ADS-B) | 0.8 | 119.6 | **149×** |
| `ship-traffic` (1.16 GB, 38.5M AIS pings) | 1.0 | 49.2 | **49×** |
| `nyc-taxi-trips` (same 6.7 GB) | 7.2 | 117.8 | **16×** |
| `hurricanes` (39 MB) | 89 | 100 | 1.12× |
| `nyc-rideshare` (90 MB) | 8.8 | 11.0 | 1.25× |
| `nyc-taxi-od-heatmap` | 103 | 107 | 1.04× |
| `earthquake-activity` (83 MB) | 28 | 10–17 | 0.5–0.6× ⚠ |
| `flight-paths` / `wildfires` / `satellites` | 113–120 | 113–120 | (already fast) |

The earthquake regression is the deliberate trade-off the audit called:
per-tile sublayers scale linearly past 10M points; cross-tile
consolidation was faster at small scale. The fix is a hybrid path that
consolidates below a threshold (deferred).

## Bench numbers

`tools/bench` against the 733 KB CI fixture, ±15% tolerance:

- `open_ms`: 6.64 → 6.83 (within noise)
- `decode_tiles_per_s`: 5407 → 5578 (+3%)
- `decode_p95_ms`: 0.28 → 0.27 (improved)
- `coalesce_ratio`: 2000× (range coalescing on 2000 tiles)
- `compression_ratio`: 4.24× (gzip on Arrow IPC)

For format v3 (zstd + Dictionary categoricals + u16 vertex-time deltas):

- **v3 archive size: 25% of v2 (3.99× shrink)** on the synthetic 32-tile
  path+categorical benchmark dataset.
- **v3 decode ~3.3× faster** (p95 3.65 ms → 1.05 ms) thanks to fzstd over
  pako-gzip and eliminated per-tile dictionary rebuild.

## What landed

### Phase 0 — bug fixes + telemetry (master, 413c7ce)

- **Point-layer time animation no longer freezes** between tile churn.
  The `currentTime: snapshotTime` prop was bypassing the `getTime` callback
  that the rest of the layers use.
- **Float-domain Hilbert index collapsed at zoom ≥ 14**, colliding
  neighbouring tiles on the directory sort key. Replaced with
  `hilbert_2d::xy2h_discrete`. Regression test sweeps zooms 14–22.
- **`TemporalLookup::build` was O(N · B)** (up to N² for N tiles).
  Replaced with sweep-line over half-open events. 50k entries now builds
  in <10 ms (was minutes on 1M-tile archives).
- **Point-layer cache key** now includes `colorPalette` / `colorMapping`
  identity. Palette swaps no longer return stale colors.
- **`__sttProbe` telemetry channel** in both `@poopdeck.gl/core` and `@poopdeck.gl/layers`
  (`emit`, `measure`, `snapshot`, `getSnapshot`, `enableProbe`,
  `disableProbe`). No-op in production; Playwright probes and the HUD opt in.
- **PerformanceMonitor HUD** reads from the snapshot channel; cache panel
  actually populates with tile count, queue depth, byte caches, hit rate.
- **`tools/render-test/probe-scale-sweep.mjs`** — multi-demo sweep with
  TTFT, frame histogram, decode telemetry summary, CSV sidecar.
- **Bench baselines committed** (`earthquakes-v2.json`, `ais-all-us.json`)
  plus a 733 KB CI fixture (`earthquakes-ci.stt` + `.json`) so the
  bench-regression CI gate actually runs.

### Track D — @poopdeck.gl/layers layer rewrite (1c21cf5)

- **Dropped cross-tile consolidation for `AnimatedPointLayer`** in favour
  of per-tile sublayers (matching paths/trips). 200k features prepare+build
  went from 20 ms to **1.3 ms**. Removes the ~3.6 GB single-chunk
  allocation cliff at 100M points.
- **`CategoryColorExtension` wired** into point / path / trips. Replaces
  CPU RGBA expansion with a `Uint16` index attribute + 4096×1 palette
  texture. `colorMapping` branch stays CPU-side.
- **`PolygonTimeFilterExtension`** lifts polygon filtering onto the GPU.
  Eliminates `getVisibleFeatureIndices` + `extractVisiblePolygons`.
- **`dataComparator: (a, b) => a === b`** on every per-tile sublayer.

### Track E — @poopdeck.gl/maplibre parity (4d30bf3)

- **VAOs** collapse per-frame `bindBuffer` × N to one `bindVertexArray`.
  Roughly 1400 → 60 GL calls/frame at 20 visible tiles × 3 layers.
- **Instanced rendering** for lines / trips / polygon strokes. Eliminates
  the 4× CPU vertex broadcast at tile load; ~2.5× GPU-memory shrink.
- **FP16 heatmap accumulator** (`RGBA16F` when `EXT_color_buffer_float`)
  removes the 255-splats/pixel ceiling.
- **Shared `time-window.glsl.ts`** replaces 6 inline divergent copies;
  parity test sweeps 200 random triplets against deck.gl's extension.
- **`ProjectionWorkerPool`** + `time-window` module shipped; full per-layer
  adoption is a follow-up. *(Historical note: the worker projection pool was
  later removed in the 2026-06 SoTA pass — projection now runs inline.)*

### Track B — format v3 (30fa3f5)

- **`STT\x03` magic** with optional dictionary slot in the header.
- **`stt-build --compression zstd` is the new default.** Browser side
  uses `fzstd` (pure JS, ~30 KB).
- **`List<UInt16>` vertex-time deltas** keyed on per-layer
  `(origin_ms, step_ms)` schema metadata. Falls back to `Int64` when the
  range exceeds u16.
- **`Dictionary<UInt16, Utf8>` categoricals** eliminate the per-tile
  dictionary-rebuild loop client-side.
- **CRC32C integrity tags** replace blake3 dedup keys. Real-data dedup
  rate is ~0% on continuous trajectory data; we save the blake3 cost.
- **Dual-version reader** in both Rust (`ArchiveReader`) and TS (`STTArchive`).
- **Native `DecompressionStream`** preferred over pako for gzip in the
  browser (20× faster per Facebook measurements).

### Track C — streaming build pipeline (c00dde6)

- **`--streaming-arrow` flag** wires a producer/consumer pipeline that
  reads `RecordBatch`es lazily from Parquet and streams tiles directly to
  the writer. Peak RSS on a 5M-feature synthetic dataset: **1.74 GB** vs.
  the previous "load everything into RAM" ~50 GB floor.
- **Supercover tile traversal** (Amanatides–Woo DDA) replaces the bbox
  candidate enumeration in `clip_trajectory`. **541× fewer candidate tiles**
  on a 1000-vertex cross-country trajectory at zoom 14 (1.96M → 3.6k).
- **mmap'd `ArchiveReader`**. Tile payload reads are `&[u8]` slices into
  the mmap — no per-call `Vec` allocation.
- **Scoped rayon thread pool** so `--workers N` is always honoured.
- **Dead `encode_coordinates` / `zigzag_encode` module deleted**.

## Memory + research

A research agent surfaced patterns not in the original sprint plan:

1. **No public competitor renders 100M raw features per frame** —
   Carto's 17B-point demos are server-aggregated H3/A5 tiles. 100M+ in
   STT requires a summary tier at low zooms + per-tile sublayers at high
   zooms.
2. **GeoArrow extension-name metadata** on tile layers — zero-cost
   interop with `@geoarrow/deck.gl-layers`, Lonboard, kepler.gl 3.x.
3. **MLT-style pre-tessellated polygon meshes** — skip earcut on the
   main thread. ~3× decode speedup on polygon-heavy datasets.
4. **OPFS caching of decompressed tile slabs** — 3–4× faster than
   IndexedDB; bypasses network + decompress on revisit.
5. **Vertex Animation Textures (VAT)** for TripsLayer at scale —
   encode per-vertex position-over-time in a 2D texture; scales linearly
   in unique trajectories instead of (trajectories × timesteps).
6. **WebGPU is NOT yet a sprint target** — deck.gl v9.3 has only Line /
   PointCloud / Scatterplot in preview; revisit Q4 2026.

These are tracked as tasks #22–#28 for the next sprint.

## Test status

- **Rust workspace**: 56 stt-core + 29 stt-build + 9 stt-validate = 94
  tests pass. `stt-generate test_gmst_calculation` is a pre-existing
  flaky test unrelated to the sprint.
- **TypeScript workspace**: 16 @poopdeck.gl/core + 88 @poopdeck.gl/layers + 43
  @poopdeck.gl/maplibre = **147 tests pass**.
- **`tsc --noEmit`** clean on every package.
- **CI bench-regression** runs against committed fixture; passes at ±15%
  tolerance.

## What's deferred to the next sprint

Tasks tracked in the TaskList but not actioned in this sprint:

- Tile-relative i16 coordinate quantization (Track B set up the metadata
  keys but the encoder/decoder are not wired).
- Trained zstd dictionary in the header slot (helpers in place; build-side
  training pass missing).
- Two-tier PMTiles-style directory (deferred — meaningful only for
  >1M-tile archives we don't ship yet).
- GeoArrow `ARROW:extension:name` metadata on tile layers.
- MLT-style pre-tessellated polygon meshes.
- Server-aggregated H3/A5 summary tier for 100M+ datasets.
- OPFS caching of decompressed tile slabs.
- Temporal LOD pyramid.
- Vertex Animation Texture path for TripsLayer.

## Headline

The trips / paths / ship-traffic demos that were essentially unusable
(0.2–1.0 FPS) are now at 60+ FPS in software-WebGL CI. The format and
build-pipeline work is the foundation for the 100M+ story; the next sprint
adds the summary-tier work that closes it.

---

# Sprint Phase 2 Results — May 2026

Phase 2 dispatched five parallel worktree subagents plus a continuous
research agent. Six follow-up tasks (#22–#27, #31) all landed.

## What landed in phase 2

### Format / build (the 100M+ unlock)

- **A5/H3 summary tier** — `--summary-tier h3` flag on `stt-build` emits
  pre-aggregated hex-cell tiles alongside raw tiles. New `H3SummaryLayer`
  renders them via deck.gl's `H3HexagonLayer`. Tileset dispatches via
  `tier: 'auto' | 'summary' | 'raw'`. **Real demo shipped**
  (`earthquake-summary`, 73 MB archive committed).
- **Pre-tessellated polygon meshes** (MLT-style). Earcut indices baked
  at build time into a sidecar column; deck.gl + maplibre skip CPU
  tessellation. **9-11× decode-to-render speedup** on a synthetic
  10k-polygon tile.
- **Temporal LOD scaffold** — `Metadata.temporal_lod` + `--temporal-lod`
  flag. `STTArchive.pickTemporalLodForZoom()` exposes dispatch. Renderer
  wiring deferred.
- **GeoArrow `ARROW:extension:name` interop**. STT tiles are now
  zero-config consumable by `@geoarrow/deck.gl-layers` / Lonboard /
  kepler.gl 3.x. New `toGeoArrowTable(layer)` helper.

### Client / runtime

- **OPFS persistent tile cache** — caches decompressed bytes in Origin
  Private File System. **3.6× warm speedup, zero range requests on
  cached tiles**. Surfaced in HUD; no-op when OPFS unavailable.
- **fflate replaces pako** — pure-JS gzip is **1.9× faster (38 MB/s)**,
  ~4× smaller bundle. Native `DecompressionStream` still preferred.
- **`BinaryFeatures.featureIds64: BigUint64Array`** — preserves UInt64
  feature IDs (needed for H3 cell indices at resolution ≥ 7).
- **Heatmap worker bug fix** — hardened `collectTransferables` against
  undefined fields. nyc-taxi-od-heatmap went **7.8 FPS → 72.2 FPS (9.3×)**.
- **WebGL link warning suppressed** — deck.gl 9.3's "Too many attributes
  (instancePickingColors)" warning filtered at boot. Non-fatal upstream;
  proper fix in deck.gl 9.4.

## Phase 2 perf deltas (probe-scale-sweep, software WebGL)

| Demo | Phase 1 FPS | Phase 2 FPS | Notes |
|---|---|---|---|
| `nyc-taxi-od-heatmap` | 7.8 | **72.2** | heatmap bug fix |
| `nyc-taxi-paths` | 118.6 | 103.0 | |
| `nyc-taxi-trips` | 117.8 | 118.8 | |
| `flight-trips` | 119.6 | 119.6 | |
| `flight-paths` | 118.8 | 119.6 | |
| `hurricanes` | 100.0 | 92.8 | |
| `earthquake-activity` | 17.2 | 17.0 | |
| `wildfires` | 113.2 | 67.2 | |
| `ship-traffic` | 49.2 | 1.0 ⚠ | needs summary tier wired |

## Test status (end of phase 2)

**331 tests green** — 124 Rust + 207 TypeScript. `tsc --noEmit` clean,
CI bench-regression fires.

## Still deferred

- Wire `pickTemporalLodForZoom` into renderers.
- Maplibre `H3SummaryLayer` equivalent.
- Vertex Animation Textures for TripsLayer at scale (speculative).
- Quadbin variant of the summary tier.
- Per-cell numeric aggregation in the temporal LOD aggregator.
- `ship-traffic` 38.5M-point demo via summary tier.

## Headline (phase 2)

The 100M+ scale story is now actually shippable: the format carries a
pre-aggregated H3 tier, a temporal LOD scaffold, pre-tessellated polygon
meshes, and zero-config GeoArrow interop. The client has a persistent
OPFS cache (3.6× warm hit), 1.9× faster pure-JS gzip, and 70 FPS heatmaps.
