# Rust Toolchain Audit + SoTA Analysis + Improvement Plan (2026-06-11)

Full audit of the Rust CLI and backing crates, compared against tippecanoe / PMTiles /
COPC / MLT / GeoArrow / Zarr, with a prioritized improvement plan. Wave 0 is **shipped**
(see end). Waves 1–3 are open.

## Bottom line

The architecture is sound and fills a genuine gap. The foundation — Arrow IPC tile
payloads + GeoArrow geometry + content-addressed packs + zstd + Hilbert/Morton ordering +
a consolidated manifest — is the convergent cloud-native SoTA design: it independently
matches PMTiles v3 (content-addressed, Hilbert-ordered, range-requestable), COPC
(single-file octree + range reads), Zarr v3 sharding (offset/length index), and
MLT/GeoArrow (columnar tile payloads). The niche it targets — **time as a first-class
tiling axis for *vector* features** — has no established standard; everyone else does
"load spatial tiles, filter time client-side," which breaks exactly when the time-series
won't fit in memory. The packages make sense.

The problems are completeness, hygiene, and one missing class of feature — not
architecture.

## Crate-by-crate verdict vs. the field

| Crate | Comparator | Verdict |
|---|---|---|
| stt-build | tippecanoe (builder) | Ahead on temporal/trajectory (antimeridian-safe clip, TD-TR time-aware simplify, OSRM per-vertex timing, temporal LOD); behind on tippecanoe's core value — enforced tile-size budgets + density feature dropping/coalescing. |
| stt-core (packed format) | PMTiles v3, COPC, Zarr-v3 sharding | Defensible SoTA. Content-addressing + dedup, range-requestable directory, CRC32C + blake3 integrity, byte-reproducible builds. Strongest part of the codebase. |
| stt-core (arrow_tile payload) | MLT, GeoArrow v0.2 | Right baseline (Arrow IPC + GeoArrow ext types + ALIGNED_FRAME_FLAG). Gap: coordinates are un-quantized f64; MLT/MVT quantize to a tile-local integer grid → delta → FastPFOR ("up to 6× over MVT"). |
| stt-optimize | tippecanoe `-zg` + analysis | Real algorithms, integrated via `--auto`, but advisory-only: consumes 2/5 recs, never measures actual output, 0 tests, recommended gzip (now fixed). |
| stt-validate | pmtiles verify | Solid (header, content-address integrity, Arrow decode, feature-count + temporal-bounds consistency). Gaps: no sampling for huge archives, no schema/column-type checks. |
| stt-generate | (bespoke) | Strong shared common.rs but 40–50% duplication, no Dataset trait, run_all() wires only 3 of 12 datasets, no enforced producer schema. |

## stt-build CLI vs. tippecanoe table stakes

Present: zoom range, per-zoom simplification (Visvalingam + TD-TR), cloud-native
range-request output (best-in-class), columnar payload, summary-tier aggregation
(H3/Quadbin).

Missing / partial:
- **Enforced per-tile byte budget with drop/coalesce** — absent. No `--maximum-tile-bytes`,
  no `--drop-densest-as-needed`. `--adaptive-temporal` caps features per *temporal window*,
  not bytes per tile, and only on the time axis. **The machinery exists**: `stt-core::budget.rs`
  (`TileBudget`, `ImportanceScorer`, greedy value-per-byte enforcement) is fully built,
  fully tested, and called by nothing.
- Auto-zoom guessing — only via `--auto` (heuristic), not first-class density-derived `-zg`.
- Attribute include/exclude/filter — none; all properties pass through.
- Distance-based point clustering with accumulate functions — only server-side summary tiers.

## Verified backing-code findings (stt-core)

Strengths: packed-format integrity, byte-reproducible builds, ~1 B/entry RLE+delta+zigzag
directory (v5 per-run pack_id), ALIGNED_FRAME_FLAG zero-copy, BlobOrdering::Auto
(data-shape-aware SFC), categorical dictionary errors on >65k overflow (no silent collapse).

Issues (verified against source):
- **Dead modules** (exported in lib.rs, zero consumers anywhere): `budget.rs` (372 LOC —
  keep, wire into Wave 1), `analyzer.rs` (424 LOC — delete), `index.rs` (380 LOC — delete;
  it duplicates ArchiveReader's internal TemporalLookup). ~1,176 LOC orphaned (~14% of crate).
- **Vertex-time silent quantization footgun**: arrow_tile.rs u16-delta step ceiling is a
  process-wide atomic; a wide span silently fell back to Int64 / coarse step with no signal.
- NOTE: a prior agent flagged a `panic!` at arrow_tile.rs:977 — **false positive**, it is
  inside a `#[test]`.

## SoTA positioning

Defensible-SoTA bets already made: Arrow IPC payload (right for ≤1–10 MB tiles;
Parquet/Vortex/Lance overhead is tuned for 64–512 MB files), GeoArrow geometry,
content-addressed range-requestable packs, zstd, data-shape-aware SFC ordering,
consolidated manifest.

The genuine frontier (no prior art to copy — most design scrutiny belongs here):
- Temporal axis on the directory (no adopted z/x/y/t convention for vector tiles).
- Temporal budgeting (tippecanoe solves *spatial* density; nobody has a standard temporal answer).
- 3D (space+time) locality ordering (our own "hilbert3 catastrophic on wide-time" finding).
- Mutability/append (cloud-native archives are immutable).
- No reference consumer (must ship builder + deck.gl layers).

Reconciliation with our own "encodings NO-GO" measurement: that tested *transforms*
(delta/bitpack) on *un-quantized* f64 coords. It never tested **quantization** —
snapping coords to a tile-local integer grid before delta+FastPFOR. Coordinates dominate
*because* they are full f64. Quantization is the lever we have not pulled. It is lossy, so
it collides with the no-thinning principle — reconciled the way tippecanoe/MLT do it: full
precision at maxzoom, quantized only at overview zooms. Needs a fresh measurement.

## Improvement plan

### Wave 0 — Hygiene & correctness — SHIPPED 2026-06-11
- [x] Delete dead `analyzer.rs` + `index.rs` (~804 LOC); keep `budget.rs` for Wave 1.
- [x] stt-optimize: drop stale gzip advice → zstd; mark chunk_size/confidence advisory-only.
- [x] stt-build CRS guard: warn by default / fail under `--strict-geometry` when input CRS
      is not WGS84/CRS84/EPSG:4326.
- [x] Vertex-time footgun: once-per-process `tracing::warn!` on the u16→Int64 fallback.
- [x] Tidy budget.rs unused_mut. Full workspace build + all Rust tests green.

### Wave 1 — Close the tile-builder gap (tippecanoe parity) — SHIPPED 2026-06-11 (loop item partial)
> **Product-principle tension (RESOLVED → strictly opt-in):** docs say never thin/aggregate
> to hit payload budgets (prefer zoom-range clamp; summary/raster tiers opt-in only).
> All Wave-1 budget/dropping features are OFF by default; with none set, output is
> byte-for-byte identical to before (enforced via budget fast-path + verified by tests).
> Any drop is logged per tile (z/x/y/t + dropped/total) — no silent caps.
- [x] Wired `budget.rs` into stt-build via a generic `TileBudget::enforce_indexed` adaptor
      (bridges the tiler's `TileFeature` to budget scoring without lossy conversion). Opt-in
      `--maximum-tile-bytes` / `--maximum-tile-features`, enforced post-clip/simplify pre-encode.
- [x] Opt-in `--drop-densest-as-needed` (ImportanceScorer GeometrySize; budget-without-flag
      drops least-important via Combined score, never random). Coalesce intentionally SKIPPED
      (no clean impl this round — not stubbed).
- [x] Attribute control: `--exclude` / `--include` / `--exclude-all` (system columns always
      survive; errors if >1 mode set or if it would drop a heatmap/summary/min-zoom source
      column; validated up-front before input load). Verified end-to-end: `--exclude trip_id`
      dropped 41.6 KB uncompressed across 82 tiles on a real build.
- [x] First-class `-zg`-style auto-maxzoom from real density (spacing = sqrt(area/n),
      z = log2(world_width·cos(lat)/spacing), occupancy guard as sanity clamp).
- [x] stt-optimize density sim fixed: now multi-zoom (was single max_zoom). + crate's first 11 tests.
- [ ] FULL measure-and-correct loop (build → measure actual tile bytes → re-adjust) still open —
      this round delivered the `-zg` estimate + honest multi-zoom prediction, not the closed loop.

### Wave 2 — Format frontier (COPC / GeoParquet-1.1 steal; already de-risked by our sims)
- [ ] Bounds on directory page-pointers + `[t_min, t_max]` per page (paged .sttd). Our sim:
      VIABLE, +7–19% at-rest, queries read 0.3–26% of a whole-load. Directly attacks the
      180× over-fetch + cover_t_min issues from the demo-tile audit.
      **Design resolved → focused-effort plan: [`paged-directory.md`](./paged-directory.md)**
      (wire format, reader/writer algorithms, rollout, validation, sequenced tasks).
- [ ] Per-feature bbox covering column (GeoArrow geoarrow.box) — GeoParquet-1.1 pruning lever.
- [ ] Re-run coordinate-encoding measurement WITH quantization (quantize-to-grid → delta →
      FastPFOR), zoom-aware (lossless at maxzoom). The one experiment that could overturn
      "encodings NO-GO" — it changes the variable that verdict never tested.

### Wave 3 — Product coherence
- [ ] Promote the 9 real `examples/` tools (verify-packed, pack-transcode, pack-cover,
      packed-stats, tile-stats, …) to an installable `stt-tools` crate or subcommands; move
      paging/encoding sims to a bench home; retire `repack`.
- [ ] `Dataset` trait for stt-generate to kill 40–50% duplication + enforced producer schema;
      complete `run_all()`.
- [x] `stt-validate --sample N` (deterministic, integrity still over all tiles, grand-total
      skipped-not-failed when sampled) + schema/column-type contract checks + producer-drift
      detection (distinct-schema signatures). SHIPPED 2026-06-11.

Sequencing rationale: Wave 0 is free cleanup (done). Wave 1 is highest product value and
mostly reuses code already written. Wave 2 is highest technical value, already de-risked by
our sims. Wave 3 is compounding debt, not urgent.
