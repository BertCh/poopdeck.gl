# STT v4 — Cloud-Native Spatiotemporal Tiles

**A comprehensive roadmap.** Format-evolution-first, clean-slate (no back-compat burden — everything regenerates), in service of **open-source adoption**.

> **One-line positioning:** *Cloud-native spatiotemporal tiles — the PMTiles/COG pattern, extended to time.* You know tiles. Now they have time.

This document is grounded in (a) a full map of the current codebase and (b) a primary-source SoTA survey (PMTiles v3, MVT, TileJSON 3.0, OGC API–Tiles/WebMercatorQuad, GeoParquet `covering`, COG, GeoArrow, Arrow IPC, Vortex, FlatGeobuf, ZSTD dictionaries, tippecanoe, H3/S2/A5, MobilityDB, OGC API Moving Features, MF-JSON, deck.gl/kepler, Zarr, TD-TR). Citations to the codebase use `path` + symbol; SoTA patterns are named inline.

---

## 0. Strategic frame

The thesis from the field's own modern primitives — OGC API Moving Features `subTrajectory(datetime=[t0/t1])`, MobilityDB `atPeriod`, Zarr time-chunking, deck.gl `filterRange` — is **"address time as a streaming `[t0,t1)` range, not a slice."** No adopted vector-tile format (MVT, PMTiles) has a native time axis. That niche is **unoccupied**, and STT is structurally ~80% of the way into it already.

Three decisions taken:
- **Lead with format evolution.** The directory, adaptive temporal chunking, shared dictionary, and space-time ordering are the "big wins."
- **Break freely → v4 is a clean slate.** Nothing is deployed; all datasets regenerate via `stt-generate`. We design the *right* format, not an additive one. Correctness fixes (temporal clipping, property typing) fold **into** v4, not bolted onto v3.
- **Goal = open-source adoption.** Every format decision is also an adoption decision: stay familiar at the edges (XYZ, TileJSON, GeoArrow, S3/range-requests), spend the entire novelty budget on **time in the pyramid**, and ship the drop-in surface (maplibre/deck/GDAL/inspector) that the ecosystem already expects.

---

## 1. Baseline: what STT is today

### 1.1 Already excellent (keep & formalize)
| Capability | Where | Note |
|---|---|---|
| Standard OSM/Web-Mercator XYZ grid | `crates/stt-core/src/projection.rs` | top-left origin; *identical envelope* to every web map. **This is the approachability moat — market it.** |
| Interleaved **GeoArrow** geometry + `OGC:CRS84` metadata | `crates/stt-core/src/arrow_tile.rs` | `geoarrow.point/linestring/polygon`, `FixedSizeList` coords — the zero-copy, GPU-direct layout. Already correct. |
| Per-vertex time as **u16 deltas** (`origin_ms`,`step_ms`) | `arrow_tile.rs` | sophisticated; falls back to `List<Int64>`. Keep. |
| Per-tile **f32-safe epoch offset** (`timeOffset`) | `packages/deck.gl/src/time-filter-extension.ts`, tile decoder | exactly the fix the deck.gl/kepler SoTA flags (raw epoch-ms loses precision in f32 shaders). Keep & spec it. |
| Pre-tessellated polygon triangles (MLT-style) | `arrow_tile.rs` (`triangles`) | client skips earcut. Keep. |
| Range-coalesced fetch + 3-tier cache (mem LRU / OPFS / frame) | `packages/core/src/archive.ts` | 32 KB coalesce gap; priority/prefetch queues, `maxRequests:12` in `spatiotemporal-tileset.ts`. Solid. |
| Rich GPU temporal layers (window/trail/wake/cumulative/heatmap) | `packages/deck.gl/src/time-filter-extension.ts` | per-tile sublayers + `PreparedTile` cache. Strong. |
| Scaffolding for temporal LOD, summary tier (H3/Quadbin), heatmap domain | `crates/stt-core/src/metadata.rs` | partial; formalize in v4. |

### 1.2 Gaps & liabilities (v4 targets)
| Gap | Where | Impact |
|---|---|---|
| **Flat index, one row per tile** | `archive.rs` `index_schema_v3` | no RLE collapse, no planet scale, no two-level directory. The single biggest structural delta vs PMTiles. |
| **No temporal clipping** | `clip.rs` — `slice_segment_temporally` exists but is invoked **only in the LOD path** | a feature crossing a bucket edge stays whole in its *start* bucket → tiles aren't self-contained playback windows; coarse-started long trips pollute distant buckets. |
| **Property-typing keystone bug** | line/polygon writers in `stt-generate` hardcode props to `Utf8`; builder infers from Arrow physical type only (`columnar.rs`) | numeric props on lines/polys → categorical → can't drive color ramps / elevation. *This is why flights altitude renders flat.* |
| **Shared ZSTD dict slot unused & unreadable** | writer calls dictionary-less finalize; `compression.rs` has `zstd::dict::from_samples` + `compress_zstd_with_dict` ready; TS reader throws on dict (`archive.ts` ~L528, fzstd has no dict API) | the highest-leverage small-tile size win is scaffolded but not wired. |
| **No inspect / convert / serve tooling** | CLI = `stt-build/generate/optimize/validate` only | no `stt info`, `stt cat→geojson`, `stt serve`. A major adoption/trust gap. |
| **No drop-in renderers / GDAL / WASM** | — | no maplibre `addProtocol`, no deck `STTLayer` package, no OGR driver, TS-only reader. |
| **Custom, non-TileJSON metadata** | `metadata.rs` (snake_case, no `tilejson`/`tiles`/`vector_layers`) | not recognizable to web clients or STAC catalogs. |
| **Generator drift** | 12 generators in `stt-generate` | altitude-as-string, numeric-as-string (satellites/drifters), `Utc::now()` timestamp fabrication, null-island, filename drift; no shared `DatasetSpec`. |

---

## 2. The v4 format design (the spine)

### 2.1 Archive skeleton — adopt PMTiles v3's proven layout, extended with time
Replace the flat Arrow index with a **two-level directory** archive:

```
[fixed header: magic "STT" + version 4 + (offset,length) pointers]
[root directory]        ← size-capped (PMTiles uses ≤16 KB) so header+root return in ONE range request
[tile data blobs]       ← coarse/low-zoom & summary first (COG discipline: zoomed-out reads fewest bytes)
[leaf directories]      ← for planet scale
[shared ZSTD dictionary]
[metadata: TileJSON 3.0 + STAC temporal]
```

Directory mechanics to copy near-verbatim from PMTiles v3:
- **Columnar directory serialization** (all keys, then run-lengths, then lengths, then offsets) + **delta-varint** + compression. (PMTiles measured 981 MB → 91 MB directory this way.)
- **Run-Length Encoding** of directory entries. *This is the headline win for a time format:* PMTiles collapses an ocean run of 107,977 entries → 1. **Time adds a second axis of redundancy** — a tile whose contents don't change across many time buckets RLE-collapses exactly like ocean collapses across space. Static basemaps + sparse temporal layers both compress dramatically.
- **`Offset+1` / `0` contiguity sentinel** (entry offset stored as `0` when contiguous with previous) and a **clustered flag**.
- Worst case: any tile in **≤2 extra range requests** after the cached root.

### 2.2 The space-time key & ordering
- **Key = (zoom, spatial Hilbert cell, temporal bucket)**, with an **explicit time origin + interval** (MobilityDB's `spaceTimeTiles` model; pick a documented epoch — Unix 0 — rather than MobilityDB's 2000-01-03).
- **Ordering: spatial-Hilbert major, temporal secondary.** Rationale: the dominant access pattern is *animation* (fixed viewport, scrub time), so all time buckets of a spatial tile should be byte-contiguous → one coherent range read per scrub, and unchanged-tile-across-time RLE-collapses.
- Store **explicit `[tmin,tmax]` per directory entry** (carry today's `time_start`/`time_end`). This is what makes a `[t0,t1)`×bbox query a directory scan that selects *exactly* the touching chunks — the GeoParquet `covering` idea (per-chunk min/max as a free spatiotemporal index), applied to the directory.
- **Decision to lock in Phase 0:** spatial-major-then-time (animation-optimized, recommended) **vs** a true **4-D Hilbert over (x,y,t)** (balances pan-at-fixed-time and scrub-at-fixed-viewport). Prototype both against real query traces.

### 2.3 Adaptive temporal chunking — *the novel, publishable contribution*
Fixed 1 h buckets are the documented perf root-cause (1 h-bucket vs 60 s-window mismatch). The fix, with direct precedent in **tippecanoe's density-adaptive feature dropping** (`--drop-densest-as-needed`, `--maximum-tile-bytes ~500 KB`, `--maximum-tile-features 200k`):
- **Target-budget feedback control on the time axis.** Size each `(tile, time-window)` to a budget (e.g. ≤ N KB compressed, ≤ M features). **Dense periods → fine windows; sparse → coarse.** "One hour near a harbor ≠ one hour mid-ocean."
- Implementation: variable `[tmin,tmax]` per directory entry (§2.2 already supports it). Start with a single-pass target-bytes splitter; iterate toward equal-load.
- This is also a **Zarr lesson**: chunk = read granularity (all-or-nothing decode); "middle-range / versatile" chunking beats extremes; the optimal chunk depends on the query — so ship adaptive base chunks **plus** temporal LOD (§2.5).
- **No equivalent standard exists** for density-adaptive temporal bucketing in the trajectory-tiling literature — this is a credible open-source/spec contribution.

### 2.4 Temporal clipping + dedup contract (correctness, folded into v4)
The trajectory-crosses-boundary problem is solved in principle (SETI clip-and-duplicate; HBSTR split-at-gap):
- **Clip at temporal bucket edges *and* observation gaps**, the way `clip.rs` already clips at *spatial* tile edges (Liang–Barsky + Amanatides–Woo supercover + `interpolate_timestamp`). Wire the existing `slice_segment_temporally` into the **base** build path (today it runs only for LOD).
- Carry a **stable feature `id`** (already `UInt64` in `arrow_tile.rs`) in every fragment; **dedup on the client** (SETI's bitmap/hash). Bake this **id + STbox dedup contract into the spec** so every reader dedups identically.
- Net: each `(tile, bucket)` becomes a **self-contained playback window**; fetching tightens (no more pulling a neighbor bucket to render a window).

### 2.5 Time-aware LOD
- **Temporal LOD must use TD-TR / Synchronized Euclidean Distance simplification, not plain Douglas–Peucker.** Plain DP deletes the points that encode *when* an object was *where* → zoomed-out playback puts objects in the right place at the wrong time (a temporal-aliasing bug invisible in a screenshot). Today STT uses Visvalingam–Whyatt (spatial) for `--simplify`; add an SED-aware temporal simplifier for LOD tiers.
- Keep per-zoom temporal LOD tiers and the **per-tile epoch offset** (f32 safety) — formalize both in the spec.
- For future live/append tiles, the **Opening-Window** online simplifier is the streaming-friendly choice.

### 2.6 Payload upgrades (keep the good foundation)
- **Keep** interleaved GeoArrow + Arrow IPC + pre-tessellated triangles + u16-delta vertex times. These already match the GPU-direct SoTA (`@geoarrow/deck.gl-layers` pattern).
- **Wire the shared trained ZSTD dictionary** (highest-leverage size win, already scaffolded):
  - Writer: train one dictionary per zoom-band over a tile-corpus sample (`ZDICT_trainFromBuffer`-style; `compression.rs::from_samples` already exists), ship it once in the archive.
  - Reader: replace fzstd with a dict-capable zstd (zstd-wasm) in `packages/core` so `archive.ts` can decode (today it throws, ~L528).
  - Expected: **~10 % at 64 KB rising to ~5× at <1 KB** — biggest on sparse/high-zoom/summary tiles where per-tile overhead dominates.
- **Per-buffer ZSTD inside IPC** (LZ4/ZSTD, with the `-1` escape that leaves incompressible coordinate buffers raw) as an alternative/complement to whole-blob compression.
- **u16 dictionary overflow:** today there's a check that *errors* at 65 535 (`arrow_tile.rs`). Add a graceful **32-bit index fallback** (Arrow IPC's u16 dict overflow is otherwise fatal) so a high-cardinality categorical never fails a build.
- **Arrow IPC *file* (footer) vs stream:** evaluate switching tile payloads to the IPC *file* format (footer block offsets → seekable sub-batch reads).

### 2.7 Self-describing metadata: TileJSON 3.0 + STAC temporal
Replace the custom JSON with a **TileJSON-3.0-shaped descriptor** (`tilejson`, `tiles`, `vector_layers`, `bounds`, `center`, `minzoom`, `maxzoom`, `attribution`) **plus a `temporal` block using STAC's vocabulary**:
```jsonc
{
  "tilejson": "3.0.0",
  "tiles": ["stt://archive/{z}/{x}/{y}/{t}"],
  "vector_layers": [{ "id": "trips", "fields": {...}, "t_field": "vertex_time" }],
  "bounds": [...], "minzoom": 0, "maxzoom": 14,
  "temporal": { "interval": ["2024-06-21T00:00:00Z", null], "step": "PT1H",
                "buckets": "adaptive", "trs": "urn:ogc:data:time:iso8601" }
}
```
- STAC's exact temporal model (`interval [start,end]`, `null` = open-ended, per-layer summaries) means **STAC catalogs can index `.stt`** and web clients recognize the descriptor. Don't invent time-metadata vocabulary — adopt STAC's.
- TileJSON's "arbitrary extra keys" clause makes the `temporal` block non-breaking for existing readers.

### 2.8 Summary tier via DGG
Formalize the existing summary scaffolding (`metadata.rs` `SummaryTier`):
- Low-zoom / long-window tiles ship **DGG-binned aggregates** (count / sum / sqrt-count + time-window stats) keyed by a **64-bit cell id** (Arrow `uint64`), rendered by a GeoArrow column/polygon layer. This is tippecanoe's cluster/coalesce placeholder pattern realized via a grid.
- **Default H3** (best viz ergonomics + uniform neighbor smoothing); **A5** option when strict equal-area statistics / exact roll-ups matter (H3 nesting is approximate); S2 only for hierarchical contains-queries.

---

## 3. The adoption surface (the goal)

| Investment | What | SoTA precedent |
|---|---|---|
| **maplibre `addProtocol('stt', …)`** | ~2-line drop-in: intercept `stt://`, range-fetch + decode, return `{data: ArrayBuffer}`. Global singleton — call once before `Map`. Makes `.stt` work in any existing maplibre style. | exactly how PMTiles ships. |
| **deck.gl `STTLayer` (npm)** | package the existing temporal layers as the canonical drop-in, used via `MapboxOverlay({interleaved:true})`. This is where animation actually lives (maplibre's style spec can't do per-vertex GPU time). | deck.gl MapboxOverlay; `MVTLayer` shape. |
| **Inspector / trust CLI** | `stt info` (bounds, zoom, **time range+step**, layers, fields, tile count); `stt cat --to-geojson --time=…` (reverse of build — "see inside"); `stt serve` (Z/X/Y/T + TileJSON endpoint, CORS). Plus a **drag-and-drop web inspector with a time scrubber**. | `pmtiles show/extract/serve`, `tippecanoe-decode`. |
| **tippecanoe-shaped build ergonomics** | `-z/-Z`; **`-zg`-style auto-guess for zoom AND temporal resolution** (extend `stt-optimize`/`--auto` to infer bucket size from event spacing); one `-o` that picks container by extension; **named** thinning strategies (`--drop-densest-as-needed` + a temporal sibling). Fidelity-first defaults. | tippecanoe. |
| **GDAL/OGR driver** | read-only first (Python RFC 76 → C++/Rust), with `GDAL_DCAP_VIRTUALIO` so `/vsicurl` range reads work day one. Auto-delivers **QGIS + `ogr2ogr`**. | PMTiles@GDAL 3.8, Parquet/Arrow@3.5. **Decide:** time-as-attribute (portable, lossy for the pyramid) vs reader-required temporal pyramid. |
| **WASM reader** | compile the Rust reader to WASM → broadens reach beyond TS and underpins native/QGIS paths. | — |
| **Positioning & docs** | "cloud-native spatiotemporal tiles — PMTiles/COG, extended to time," framed as a **complement** to PMTiles/GeoParquet. Two-layer docs (beginner XYZT handle / advanced internals). Killer quickstart: `stt build` → host on S3/R2 → 2-line animated map. | the 7 recurring adoption levers: serverless, range-requests, one file, works-with-existing-tools, familiar mental model, permissive license + reference impls, great quickstart. |

---

## 4. Correctness & producer hygiene (folded into Phase 1)
- **Property-typing fix (keystone):** typed-column API for **all** geometry writers (point/line/polygon) in `stt-generate`, a shared **`DatasetSpec`** contract, and a **value-sniffing fallback** in the builder (`columnar.rs`) so numeric props on lines/polys stay numeric and can drive color/elevation.
- **Generator standardization:** shared `DatasetSpec` + self-describing manifest; fix the drift list (flights altitude, satellites/drifters numeric-as-string, `Utc::now()` fabrication, null-island filtering, filename drift) across all 12 generators.
- **Golden-file tests:** a reproducible `stt-generate all` + small committed fixtures (archives are gitignored today, so every generator fix currently requires a manual regen).

---

## 5. Phased plan

| Phase | Outcome | Key work | Effort |
|---|---|---|---|
| **0 — Spec & prototype** | The **STT v4 spec** written down (also the publishable artifact) + the risky math de-risked. | Author the spec (archive layout, space-time key/ordering, adaptive-chunk semantics, temporal-clip + dedup contract, payload, TileJSON+STAC). Prototype the **directory encoder + range math** in a test: prove header+root in 1 request and viewport+window in ≤N reads. Lock the §6 decisions. | S–M |
| **1 — v4 engine** | Writer + reader produce/consume v4; all datasets regenerated. | New archive writer (directory, RLE, contiguity sentinel, shared dict) + adaptive temporal chunking + **temporal clipping into base path** + SED-aware LOD in `stt-core`/`stt-build`. New reader in `stt-core` (Rust) + `packages/core` (TS, dict-capable zstd). **Property-typing fix + `DatasetSpec`.** Regen via `stt-generate`. Golden tests. | L |
| **2 — Runtime & proof** | Showcase runs on v4; headline wins measured. | Update `spatiotemporal-tileset.ts` + deck/maplibre adapters to the directory/range model. Benchmark vs a v3 baseline: **RLE-across-time collapse** (tile count/bytes), **adaptive bucketing** (1 h-vs-60 s fix), **shared-dict** size reduction on small tiles. | M–L |
| **3 — Adoption surface** | "2 lines → animated map" works; tools to see inside. | maplibre `addProtocol`; deck `STTLayer` npm; **inspector CLI** (`info`/`cat`/`serve`); tippecanoe-shaped ergonomics + temporal auto-guess; TileJSON+STAC descriptor exposure; docs + quickstart + positioning. | M–L |
| **4 — Ecosystem & spec** | `.stt` is in the GIS lingua franca; spec is published. | GDAL/OGR driver (`/vsicurl`) → QGIS/`ogr2ogr`; WASM reader; web drag-drop inspector; **publish the v4 spec** (STAC/OGC-aligned); reference snippets for maplibre/deck/OpenLayers; complement-PMTiles messaging. | M–L |

*Dev-process note (not a compat requirement): keep the v3 reader runnable until v4 reaches showcase parity, so demos aren't dark mid-migration — then delete it.*

---

## 6. Decisions to lock in Phase 0
1. **Space-time ordering:** spatial-Hilbert-major + time-secondary (recommended, animation-optimized) **vs** 4-D Hilbert over (x,y,t).
2. **Adaptive-bucket algorithm:** target-compressed-bytes (recommended, tippecanoe-style) **vs** equal-feature-count **vs** keep fixed-LOD tiers only.
3. **Dedup contract:** confirm stable `id` + STbox, client-side dedup (SETI). Spec it so all readers agree.
4. **Directory vs improved-flat index:** PMTiles-style two-level directory (recommended for RLE + planet scale + adoption credibility) — it's the single biggest build item.
5. **Tile payload container:** Arrow IPC *file* (seekable footer) vs current custom layer-frame stream.
6. **Vortex at rest:** time-boxed spike — evaluate as the *build-time/source/index* store (100× random-access, zero-copy Arrow), **not** the wire (wire stays Arrow IPC; Vortex is pre-1.0 on APIs and has no geometry semantics).
7. **OGR time model:** attribute-column (portable) vs reader-required temporal pyramid.
8. **Summary DGG:** H3 default vs A5 (equal-area).

---

## 7. Risks & mitigations
- **Scope (large rewrite).** → Phase-gate; Phase 0 prototype must validate the directory/range math before Phase 1 commits; keep v3 reader as a dev fallback until parity.
- **TS reader complexity (directory walking, dict zstd).** → Port carefully against the Rust reader as oracle; golden cross-impl tests.
- **Adaptive chunking complexity.** → Start single-pass target-bytes; iterate. Always `log()` what was dropped/merged (no silent truncation).
- **GeoArrow / Vortex churn.** → Keep the **wire = Arrow IPC** (mature, GPU-direct). Treat Vortex strictly as an at-rest spike.
- **OGR's non-first-class time.** → Ship the portable attribute-column path first; full pyramid via STT's own reader/WASM.

---

## 8. Immediate next steps
1. Write `docs/spec/stt-v4.md` (the format spec) — archive layout + directory + space-time key.
2. Spike the **directory encoder + range-request math** in a Rust test (prove 1-request bootstrap + ≤N-read viewport/window) and decide ordering (decision 1).
3. Spike the **shared ZSTD dictionary** end-to-end (writer trains+emits; a dict-capable TS decoder reads) on one dense dataset — it's scaffolded and gives an immediate, measurable size win.
4. Land the **property-typing + `DatasetSpec`** fix in parallel (unblocks correct demos regardless of format work).
