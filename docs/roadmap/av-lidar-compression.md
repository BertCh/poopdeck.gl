# AV LiDAR tile compression (2026-06)

Waymo LiDAR became the size bottleneck of the AV cockpit. This is the
measurement-driven pass that cut a LiDAR point's on-the-wire cost ~4.5×, plus
the levers deliberately left on the table.

## TL;DR

Per-point wire cost at one zoom (`waymo-sf-day`, low tier, z14, post-zstd-19):

| build | bytes/point | vs baseline |
|-------|------------:|------------:|
| baseline (shipped) | **20.0** | — |
| + sequential point ids | 11.9 | −41% |
| + drop dead `intensity` | 11.3 | −44% |
| + quantize `z` (uint16) | **4.4** | **−78% (4.55×)** |

All three are **decode-free** (no new client codec, no WASM, no GeoArrow break
for the consumer beyond what `--quantize-coords` already does) and stay inside
the existing Arrow-columnar tile format.

Whole-archive sizes after a real `waymo-sf-day` rebuild (manifest-referenced
packs, all 5 zoom levels) — the win grows with density because the per-point
cost dominates over fixed overhead:

| tier | OLD | NEW | ratio |
|------|----:|----:|------:|
| lidar (low) | 106.9 MB | 24.7 MB | 4.32× |
| lidar-med | 209.8 MB | 44.1 MB | 4.75× |
| lidar-high | 412.9 MB | 78.8 MB | 5.24× |
| lidar-ultra | 797.4 MB | 142.6 MB | 5.59× |
| lidar-full | 2310.7 MB | 342.7 MB | 6.74× |
| **bundle total** | **3.84 GB** | **633 MB** | **6.07×** |

(The per-zoom 4.55× and the whole-archive 4.3–6.7× agree because cross-zoom
dedup was never significant here — only ~1.1× — so the per-point win passes
straight through to total size.)

## How we got here: measure first

A deep-research pass (3D Tiles / COPC / Potree / Draco / G-PCC) said the
portable wins are RTC + uint16 position quantization and an additive octree, and
that the strong codecs (G-PCC, learned octree models) are **not** browser-
decodable at interactive rates. Good guidance — but before porting anything we
measured where a real Waymo tile actually spends its bytes
(`crates/stt-core/examples/point_column_stats.rs`, per-column zstd attribution):

```
z14 baseline, 20.0 B/pt:
  id          8.04 B/pt   40.2%   <- UInt64 hash of (time,lon,lat): incompressible
  z           7.58 B/pt   37.9%   <- raw Float64 elevation: barely compresses
  geometry    2.53 B/pt   12.7%   <- already i32-quantized (--quantize-coords 0.05)
  intensity   1.66 B/pt    8.3%   <- DEAD: nothing in the render path reads it
  height_band 0.12 B/pt    0.6%
  start/end   0.06 B/pt    0.2%   <- constant per 100ms frame -> ~free already
```

This **redirected the plan**. The research's headline lever (coordinate
quantization → uint16 RTC) targets `geometry`, which is already only 2.5 B/pt
here — not worth the dedup tension for ~1 B/pt. The actual costs were `id` and
`z`, and the "per-point time tax" we expected to fight was already free (zstd
crushes the constant-per-frame `start_time`/`end_time`).

## What shipped

1. **Sequential point ids** (`crates/stt-build/src/columnar.rs`,
   `build_point_layer`). A point is never split across tiles, so it needs no
   globally-stable id. The fallback id was a hash of `(time,lon,lat)` — a random
   incompressible u64. Anonymous points now get the per-tile row index (unique
   within the tile → picking still works; monotonic → zstd crushes it). Explicit
   source ids (earthquake/storm-cell etc.) are preserved. **8.04 → 1.07 B/pt.**

2. **Drop dead `intensity`** (`scripts/data-generation/av_common.py`,
   `write_lidar_points`). Decoded from Waymo and written to every tile as
   Float64, but no consumer reads it (the cloud colors by
   `height_band`/`seg_class`/camera RGB). No longer written. **−1.66 B/pt.**

3. **Numeric-attribute quantization** — new opt-in `--quantize-attr name=prec`
   (`crates/stt-core/src/arrow_tile.rs` encoder + `packages/core/src/tile.ts`
   reader). A named Float64 property ships as the smallest int leaf
   (`UInt16`/`Int32`) plus a per-column affine `{o,s}` in field metadata
   (`stt:qa`); the reader reconstructs `value = o + q*s`, mirroring the geometry
   coordinate quantization (`stt:quant`). Waymo lidar opts `z` in at 0.05 m.
   **7.58 → 0.69 B/pt** on the `z` column. Per-column min offset is deterministic
   so content-addressed dedup is preserved.

Tests: `arrow_tile.rs` roundtrip + opt-in unit test; cross-lang reader test
`packages/core/test/quantized-attr.test.ts`; Python pipeline asserted to drop
intensity and emit `--quantize-attr`.

## Deferred levers (measured, not worth it *yet*)

- **uint16-RTC geometry** — would halve `geometry` (2.53 → ~1.3 B/pt) but a
  per-tile/per-node origin breaks cross-tile blob dedup (the reason
  `--quantize-coords` uses a world grid). ~1 B/pt for real risk. Revisit only if
  geometry becomes the dominant column.

- **Pyramid replication** — the cloud is re-tiled at *every* zoom (z14–z18) with
  no thinning, so coarse zooms carry identical density and exist only to satisfy
  the mercator pyramid (content-addressed dedup recovers some of it). Collapsing
  to one or two data zooms (deck.gl over-zooms the rest) is the biggest remaining
  **total-archive** lever, but it changes LOD behaviour → needs an in-browser
  visual check before adopting.

- **Additive octree + screen-space-error LOD** (Potree/COPC style) — the
  "proper" fix for both replication and render-side culling, but a large
  architectural change to a 2D-mercator-keyed engine. Out of scope for this pass.

- **Browser point codecs** (Draco kd-tree, G-PCC, range-image/FLiCR) — research
  verdict: Draco is the only WASM-portable option and it is not rate-distortion
  optimal; the strong codecs decode 1–3 orders of magnitude too slowly for
  interactive playback. Quantization captured most of the win decode-free, so a
  codec path is not justified.

## Applying to other AV datasets

The Rust/Python changes are shared, so nuScenes / Argoverse / other Waymo scenes
get the sequential-id + intensity-drop wins on their next rebuild; add
`quantize_attrs={"z": <prec>}` to their `run_stt_build` calls to also quantize
`z` (nuScenes/Argoverse already pass `quantize_coords`).

## Generalization: born-optimized generation (all datasets)

The same levers generalize to every dataset, and — per the directive that
*optimization can't be a second step, it must be built into generation* — they
are now the **default** of the generation pipeline, not an opt-in or a
post-transcode:

- **Automatic numeric quantization** (`stt-build --quantize-attrs-auto`,
  `arrow_tile.rs::build_quantized_numeric_auto`): every Float64 scalar property
  is quantized to a **range-adaptive UInt16** — the column's `[min,max]` span
  maps onto 16 bits, the reader reconstructs Float64. No per-column precision to
  pick. ~16 bits of dynamic range is visually lossless for STT's scalar fields
  (magnitude, depth, altitude, speed, SST, dBZ, fare, …). It *always* emits the
  same `UInt16` type per column (constant / all-null tiles included) so the
  layer schema never drifts across tiles.
- **Born-optimized `stt-generate`** (`common.rs::run_stt_build_with_full_options`):
  coordinate quantization (`DEFAULT_QUANTIZE_COORDS_M = 0.1` m, world-grid so
  dedup survives) + `--quantize-attrs-auto` + sequential point ids are ON by
  default for **every** dataset funneled through the build helper. Zero
  per-dataset config; `STT_GEN_NO_QUANTIZE=1` opts out wholesale, an explicit
  `quantize_coords`/`quantize_attrs` overrides per dataset.
- **Measured** on a controlled double-build (same synthetic generator, quant off
  vs on): an OD line dataset went **73.7 → 52.9 B/pt (−28%)** — geometry
  `List<f64>` → `List<i32>`, `trip_distance`/`fare_amount` `Float64` → `UInt16`.
  The win is dataset-shaped: large on geometry/numeric/point-heavy data, modest
  on text-heavy data (earthquakes only −12% — its `title`/`place` description
  strings are ~46% and aren't quantizable).

### Existing archives: the transcoder

The generation default only helps *future* builds. For the ~50 GB of already-built
live archives that are expensive or impossible to rebuild from source (OSRM /
login / live-API drift), `crates/stt-core/examples/reoptimize.rs` re-optimizes
them **data-preserving**: it decodes each tile, rebuilds the `ColumnarLayer`, and
re-encodes through the same production encoder (so coord + auto-attr quant +
sequential point ids apply), then re-packs — same data, smaller. It's slower than
a from-scratch build (decode + re-encode every tile), so it's the fallback, not
the primary path.
