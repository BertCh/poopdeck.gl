# Rust Toolchain Audit + SoTA Analysis + Improvement Plan (2026-06-11)

Audit of the Rust CLI and backing crates vs. tippecanoe / PMTiles / COPC / MLT / GeoArrow /
Zarr, with a prioritized plan. **Waves 0–1 shipped** (committed `f1e4a8c`), paged directory
and `stt-validate --sample` shipped (Wave 2/3 slices). **Triaged 2026-07-01:** the
quantization re-measurement is DONE (shipped as `--quantize-coords`); every other remaining
item was deliberately counted out with its revival trigger recorded inline — nothing on this
audit is scheduled.

## Bottom line

The architecture is sound and fills a genuine gap. The foundation — Arrow IPC tile payloads
+ GeoArrow geometry + content-addressed packs + zstd + Hilbert/Morton ordering + a
consolidated manifest — is the convergent cloud-native SoTA design: it independently matches
PMTiles v3 (content-addressed, Hilbert-ordered, range-requestable), COPC (single-file octree
+ range reads), Zarr v3 sharding (offset/length index), and MLT/GeoArrow (columnar tile
payloads). The niche it targets — **time as a first-class tiling axis for *vector* features**
— has no established standard; everyone else does "load spatial tiles, filter time
client-side," which breaks exactly when the time series won't fit in memory.

The problems are completeness, hygiene, and one missing class of feature — not architecture.

## Crate-by-crate verdict vs. the field

| Crate | Comparator | Verdict |
|---|---|---|
| stt-build | tippecanoe (builder) | Ahead on temporal/trajectory (antimeridian-safe clip, TD-TR time-aware simplify, OSRM per-vertex timing, temporal LOD); the tile-size-budget gap is now closed (Wave 1). |
| stt-core (packed format) | PMTiles v3, COPC, Zarr-v3 sharding | Defensible SoTA. Content-addressing + dedup, range-requestable directory, CRC32C + blake3 integrity, byte-reproducible builds. Strongest part of the codebase. |
| stt-core (arrow_tile payload) | MLT, GeoArrow v0.2 | Right baseline (Arrow IPC + GeoArrow ext types + ALIGNED_FRAME_FLAG). Gap: coordinates are un-quantized f64; MLT/MVT quantize to a tile-local integer grid → delta → FastPFOR ("up to 6× over MVT"). |
| stt-optimize | tippecanoe `-zg` + analysis | Real algorithms, advisory-only: consumes 2/5 recs, never measures actual output. |
| stt-validate | pmtiles verify | Solid (header, content-address integrity, Arrow decode, feature-count + temporal-bounds consistency), now with `--sample` + schema checks. |
| stt-generate | (bespoke) | Strong shared common.rs but 40–50% duplication, no Dataset trait, run_all() wires only 3 of 12 datasets. |

## SoTA positioning — the genuine frontier

Defensible-SoTA bets already made: Arrow IPC payload (right for ≤1–10 MB tiles;
Parquet/Vortex/Lance overhead is tuned for 64–512 MB files), GeoArrow geometry,
content-addressed range-requestable packs, zstd, data-shape-aware SFC ordering, consolidated
manifest.

The frontier with no prior art to copy (where design scrutiny belongs):
- Temporal axis on the directory (no adopted z/x/y/t convention for vector tiles).
- Temporal budgeting (tippecanoe solves *spatial* density; nobody has a standard temporal answer).
- 3D (space+time) locality ordering (our "hilbert3 catastrophic on wide-time" finding).
- Mutability/append (cloud-native archives are immutable).
- No reference consumer (must ship builder + deck.gl layers).

**Quantization is the unexploited size lever.** Our "encodings NO-GO" result tested *transforms*
(delta/bitpack) on *un-quantized* f64 coords — it never tested **quantization** (snapping coords
to a tile-local integer grid before delta+FastPFOR). Coordinates dominate *because* they are
full f64. Quantization is lossy, so it collides with no-thinning — reconciled the way
tippecanoe/MLT do it: full precision at maxzoom, quantized only at overview zooms. Still needs
a fresh measurement (Wave 2).

## Improvement plan

### Wave 0 — Hygiene & correctness — SHIPPED (`f1e4a8c`)
Deleted dead `analyzer.rs` + `index.rs` (~804 LOC), kept `budget.rs` for Wave 1; dropped stale
gzip advice → zstd; CRS guard (warn / fail under `--strict-geometry`); once-per-process warn on
the vertex-time u16→Int64 quantization fallback.

### Wave 1 — Tile-builder gap (tippecanoe parity) — SHIPPED (`f1e4a8c`)
> **Product-principle:** never thin/aggregate to hit budgets. All budget/dropping features are
> OFF by default; with none set, output is byte-for-byte identical to before, and any drop is
> logged per tile (z/x/y/t). Verified.

Wired `budget.rs` into stt-build via `TileBudget::enforce_indexed`; opt-in `--maximum-tile-bytes`
/ `--maximum-tile-features`, `--drop-densest-as-needed`, attribute `--exclude`/`--include`/
`--exclude-all` (system columns always survive; guarded against dropping heatmap/summary/min-zoom
source columns); stt-optimize density sim fixed to multi-zoom + the crate's first 11 tests.
Coalesce was intentionally skipped (no clean impl).

- **First-class `-zg` density-derived auto-maxzoom — COUNTED OUT (confirmed absent 2026-07-01).**
      Grep-verified: no density-derived maxzoom code exists in `crates/stt-build`; the
      2026-06-11 "shipped" checkbox was wrong. Deliberately not implemented now: every shipped
      dataset pins its zoom range explicitly (the generators encode domain knowledge a spacing
      heuristic can't), and `stt-optimize analyze` + `stt-build --auto` already cover the
      "suggest a zoom range" workflow. Revive only if third-party `stt-build` adoption makes
      zero-config builds a priority.
- **Full measure-and-correct loop — COUNTED OUT.** Wave 1 delivered honest multi-zoom
      prediction; the closed build→measure→re-adjust loop is a rebuild-cost multiplier with no
      current consumer (budgets are opt-in and unused by the shipped fleet). Revive with the
      first real tile-budget user.

### Wave 2 — Format frontier
- [x] **Paged directory** — bounds + `[t_min,t_max]` per page (`crates/stt-core/src/directory_page.rs`,
      committed `b503e24`). Root + leaf pages reuse the v5 leaf codec, `directory.layout:"paged"`
      (directoryVersion stays 5), TS reader fetches root + only visited leaves, `stt-validate`
      bounds-cover checks, `repack-directory` migration. Eval: earthquakes-v2 dir 3.38→2.41 MB,
      root 524 B. Spec §4.1; decisions [`stt-packed.md` §3](./stt-packed.md). Open (user-run
      ops, not code): fleet re-transcode + R2 re-sync — tracked as the combined rollout gate in
      [`stt-packed.md` §3](./stt-packed.md).
- **Per-feature bbox covering column — COUNTED OUT.** The paged directory's per-page geo
      bounds already deliver the coarse pruning win; a per-feature `geoarrow.box` column pays
      per-tile bytes for a reader-side filter no current consumer runs. Revive if a client-side
      spatial-predicate use case appears.
- [x] **Coordinate-encoding measurement WITH quantization — DONE** (2026-06, shipped as opt-in
      `--quantize-coords <m>` + `--quantize-attr(s-auto)`): world-grid i32 leaf with a
      reconstruction affine (CRS-swap protects cross-tile dedup). Measured: coord-heavy
      datasets −25..47%; the osm-streets pathological case went from +57.7% (naive) to −1.8%
      (world-grid). This answers the "one experiment that could overturn encodings NO-GO" —
      quantization is the lever, transforms stay NO-GO; av-cockpit LiDAR shipped on it
      (z14 20→4.4 B/pt).

### Wave 3 — Product coherence
- [x] `stt-validate --sample N` (deterministic, integrity still over all tiles) + schema/column-type
      contract checks + producer-drift detection. SHIPPED.
- **`stt-tools` crate promotion — COUNTED OUT.** The `cargo run --example` invocations are
      documented in `cli-reference.md` §Maintenance tools and `examples/README.md`; packaging
      them is publish-time polish. Revive alongside crates.io publishing
      (see the crates-publishing plan).
- **`Dataset` trait for stt-generate — COUNTED OUT (superseded).** Absorbed into the
      preprocessing-framework design (its Recipe/`Dataset` trait IS this item, Phase 5 there);
      doing a standalone trait now would be churned by that design. Revive with that framework,
      not independently.

Sequencing (as executed): Wave 0 free cleanup ✓; Wave 1 highest product value ✓; Wave 2's one
experiment with overturn potential ran (quantization ✓ — the size lever confirmed); Wave 3 was
compounding debt and is deliberately parked.
