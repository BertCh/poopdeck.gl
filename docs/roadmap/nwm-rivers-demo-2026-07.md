# NWM Rivers demo — CONUS river network breathing (design, 2026-07)

Status: design. Companion to `docs/roadmap/dataset-candidates-2026-07.md` §D.
Goal: animate hourly/daily modeled discharge (NOAA NWM v3.0 retrospective) on the
NHDPlus CONUS river network with the existing `vertex_value_matrix` format and
FlowCorridorLayer — zero new tile-format features, zero new layer code.

## Recommendation (TL;DR)

Ship **option (b): two demos sharing one geometry pipeline**:

1. **`nwm-rivers-2019`** — full year 2019, **daily** buckets (365), value =
   **self-scaled** per reach (each reach's own annual [p2, p98] log-discharge →
   [0, 1]) so colour shows each river's seasonal *variation*, not its absolute
   size. The continental network breathing through a record flood year. ≈
   **0.3–0.45 GiB** on disk. (`log-q` absolute discharge kept as a `--value` option.)
2. **`nwm-rivers-flood-2019-03`** — March 2019, **hourly** buckets (744), value =
   `log2(q / median2019)` flood **anomaly**. The Missouri bomb-cyclone flood wave
   propagating downstream hour by hour. ≈ **0.6–0.9 GiB** on disk.

Zoom ladder z4–z8 (stream-order threshold per zoom, producer-side resampling to
~2 px vertex spacing), 1.23 M total emitted vertices per demo. Combined ≈
**1.0–1.4 GiB** — inside the 2–4 GB budget with headroom for a z9 stretch band.
Renderer: **FlowCorridorLayer as-is** (`flowMatrix: true`, log values baked at
generate time, static per-feature `getWidth` property). New code is one Rust
dataset (`stt-generate nwm`) + one small Python geometry-export script.

## 1. What the repo already provides (verified against code)

- **`vertex_value_matrix` is per-vertex × per-bucket, vertex-major, `List<Float32>`**
  (`crates/stt-core/src/arrow_tile.rs` `ColumnarLayer.vertex_value_matrix`,
  `stt:vertex_value_buckets` schema key; spec in `docs/architecture/data-format.md`).
  There is **no 1-value-per-bucket-per-feature variant** — every vertex carries the
  full bucket series, so per-feature decoded cost = `verts × buckets × 4 B`.
  **Quantization does not apply**: `stt:qa` covers `<prop>` columns only; the matrix
  leaf is always f32. Any size/precision shaping must happen in the producer.
- **`--simplify` is incompatible with the matrix**: `stt-build` accepts a supplied
  matrix only when simplification is OFF (`crates/stt-build/src/clip.rs`,
  `clip_trajectory`: matrix accepted iff `!config.simplify`). Clipping at tile
  seams *does* resample matrix rows correctly (`interp_row`). ⇒ per-zoom
  generalization must be baked by the generator, not by `stt-build`.
- **One tile per (z,x,y) spanning the whole range**: features are bucketed by
  start time; all matrix corridors share `start = bucket0`, so each spatial cell
  builds exactly one tile with `time_end = range_end`
  (`tiler.rs` test `matrix_corridor_builds_one_tile_spanning_range`). The client
  fetches geometry+matrix once; playback is column selection, no re-fetch.
- **Zoom banding**: `--min-zoom-field` is a per-feature LOD floor, `--max-zoom-field`
  a ceiling; together they confine a feature to a band (`tiler.rs:110–123`,
  whole-feature skip before clip). Proven by bixi clustering (`[z,z]` bands) and
  LiDAR additive-octree `home_zoom` (`av_common.py`, min=max).
- **The template is `bixi --streets`** (`crates/stt-generate/src/datasets/bixi.rs`
  `generate_streets`): aggregate → `FlowAggregator.write_parquet` →
  `StreamingLineStringParquetWriter` (has a `vertex_value_matrix` column,
  `common.rs`) → `run_stt_build_with_full_options` (`min_zoom_field`, temporal
  bucket = bin, `end_time_field`) → showcase entry with `flowMatrix: true`
  (`examples/showcase/src/datasets.ts` `bixi-streets`).
- **Renderer**: `FlowCorridorLayer` (`packages/layers/src/layers/trips/flow-corridor-layer.ts`)
  blends the two adjacent bucket columns per playhead sub-step (STEP = 0.5) into a
  per-vertex scalar; `AnimatedTripsLayer` maps it **linearly** over
  `tripGradient.domain` through the ramp (`expandGradientColors`); `NaN` → fallback
  color. `getWidth` accepts a per-feature property name. All flow tiles must share
  one bucket axis (cached from the first tile) — satisfied here.
- **Budgets in the wild**: bixi-streets ≈ 14 K corridors / 21 MB; nyc-taxi-flows
  31 MB; the showcase already serves 1–4 GB archives (nyc-taxi-paths 4 GB,
  drifters 2.8 GB). The bixi `--typical-day` comment warns that full-span matrices
  can hit "tens–hundreds of MB per overview tile" *decoded* — the ladder below is
  designed around that. `--max-tile-bytes/-features` exist but drop features; not
  used here (the ladder is the budget mechanism).

## 2. Data sources (verified — do not re-verify)

- **Values**: `https://noaa-nwm-retrospective-3-0-pds.s3.amazonaws.com/CONUS/zarr/chrtout.zarr`
  (anonymous). `streamflow[385704 h × 2776734 reaches]`, int32 × 0.01 → m³/s,
  fill −999900, chunks `[672, 30000]` C-order, zstd-9, no filters — each chunk is a
  plain zstd frame (~6.3 MB compressed / 80.6 MB raw); plain HTTP GET + zstd decode.
  Time axis: hours since 1979-02-01T01:00. Sibling 1-D arrays: `order` (Strahler),
  `latitude`, `longitude`, `gage_id`, `elevation`.
  Index math (verified): 2019-01-01 = index 349,895 (time-chunk 520);
  2019-03-01 = 351,311 (chunk 522); full 2019 = chunks 520–533 (14) × 93
  reach-chunks = 1,302 chunks ≈ **7.6 GB** transfer; March 2019 = 2 × 93 = 186
  chunks ≈ **1.2 GB**.
- **Order distribution**: ≥7: 32,417 · ≥6: 81,363 · ≥5: 174,244 · ≥4: 347,866 ·
  ≥3: 669,060 · ≥2: 1,278,707 · all: 2,776,734.
- **Geometry**: NHDPlusV21 national seamless GDB (~7 GB 7z, downloading to
  `data/nwm/`); `NHDFlowline_Network.COMID == NWM feature_id`. Export via pyogrio
  in `scripts/data-generation/venv-rivers` (py7zr, pyogrio, pyarrow, numpy present).
- **Window**: 2019 — March Missouri bomb-cyclone flood + record-length Mississippi
  flood through summer.

## 3. Decision 1 — temporal scope & cadence

Cost model: `bytes_raw = Σ_zoom verts(z) × buckets × 4 B`; disk ≈ raw ÷ zstd ratio.
All options share the same ladder (1.23 M verts, §4), so cost ∝ bucket count:

| option | buckets | raw matrix | disk @4× | disk @6× | story |
| --- | --- | --- | --- | --- | --- |
| (a) 6 mo 2019 @ 6 h | 732 | 3.35 GiB | 0.84 | 0.56 | one demo; 6 h cadence blurs flash floods, diurnal cycle |
| **(b) year daily + March hourly** | 365 + 744 | 1.67 + 3.41 GiB | **0.42 + 0.85** | 0.28 + 0.57 | two stories: seasonal breathing **and** hourly flood wave |
| (c) 1 mo hourly only | 744 | 3.41 GiB | 0.85 | 0.57 | no seasonal story |

**Pick (b).** Similar total cost to (a), two headline demos, and the daily archive
doubles as the median source for the anomaly encoding. The two demos are separate
packed datasets sharing the geometry pipeline and the zarr chunk cache (the March
hours are a subset of the year download).

zstd ratio assumption (validate in pilot, §8): **4× conservative, 6–10× plausible**.
Rationale: values are rounded to 0.01 in log space → ≤ ~700 distinct f32 bit
patterns; log-space series change slowly bucket-to-bucket; resampled vertices
within one source reach carry byte-identical rows (1,460 B repeats at 365 buckets)
that zstd collapses. Packed-format blob dedup adds nothing here (each tile unique).

## 4. Decision 2 — zoom-band ladder

Assumptions (stated, to check in stage 1): mean NHDPlus reach ≈ 2.0 km (≈5.5 M km
total / 2.78 M reaches; medium-res 1:100k, raw vertex spacing ~50–150 m). Subset
length ≈ count × 2 km. Vertex spacing target = 2 px at each zoom (38°N,
`123,357 m/px / 2^z`); +20 % for 2-vertex feature floors and tile-seam clip
duplication. Bands are `[z, z]` (min_zoom = max_zoom = z per emitted copy), bixi-
cluster style, because `--simplify` can't touch matrices — each zoom gets its own
pre-resampled copy with its own consistent matrix.

| zoom | order ≥ | reaches | network km | 2 px spacing | est. verts | raw @365 | raw @744 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| z4 | 6 | 81,363 | 163 k | 15.4 km | 13 k | 19 MB | 39 MB |
| z5 | 6 | 81,363 | 163 k | 7.7 km | 25 k | 37 MB | 76 MB |
| z6 | 5 | 174,244 | 349 k | 3.9 km | 108 k | 158 MB | 322 MB |
| z7 | 5 | 174,244 | 349 k | 1.9 km | 217 k | 317 MB | 646 MB |
| z8 | 4 | 347,866 | 696 k | 964 m | 866 k | 1.26 GB | 2.58 GB |
| **Σ z4–8** | | | | | **1.23 M** | **1.67 GiB** | **3.41 GiB** |
| z9 stretch | 4 | 347,866 | 696 k | 482 m | 1.73 M | +2.36 GiB | +4.80 GiB |

- **Mainstem merging at all bands**: merge reach chains within runs of constant
  `(LevelPathI, StreamOrde)`, ordered by `Hydroseq` (NHDPlus attributes exported in
  stage 1). This is near-required: without merging, the 2-vertex feature floor at
  z4 costs 81 k × 2 = 163 k verts vs 13 k merged (12×). Constant-order runs keep
  per-feature `order`/width/band membership well-defined. Each resampled vertex
  inherits the discharge series of the source reach it lands on — so a merged
  mainstem shows the flood front **moving downstream through its own geometry**
  (per-vertex color interpolation along the path is free in PathLayer).
- **Upper bands use merged+resampled geometry; no raw reaches anywhere** — even
  z8 is resampled (raw NHDPlus vertex density would triple the matrix for zero
  visual gain at 482 m/px).
- **Order-1/2 deep-only rejected by arithmetic**: order ≥2 at z10 (2 px = 241 m)
  = 12.7 M verts → 17.3 GiB raw at 365 buckets (all reaches: 27.7 M / 37.6 GiB).
  Headwater detail is only shippable with a short window or a typical-hydrograph
  fold — out of scope; note as follow-up.
- Build `--max-zoom 8` (client overzooms past z8 with the z8 network). Add the z9
  band later to the **daily demo only** if the pilot's compression lands ≥6×.
- Decoded-viewport sanity: z4–5 fully resident = 13–25 k verts × 365 × 4 ≈ 19–37 MB.
  z8 viewport ≈ 12 of ~900 CONUS tiles; with 3× hot-spot density (Mississippi
  valley) ≈ 35 k verts → ~50 MB (daily) / ~104 MB (hourly) — acceptable; knob if
  not: z8 → order ≥5 for the hourly demo (−58 % verts).

## 5. Decision 3 — value encoding

Matrix is f32-only (no `stt:qa`), and the ramp is linear over `domain` — so bake
the transfer function into the values at generate time:

- **Demo 1 (year, daily)**: `v = round(clamp((log10 q − p2) / (p98 − p2), 0, 1), 2)`
  — **self-scaled** per reach: each reach's own annual [p2, p98] log-discharge
  mapped onto [0, 1], so colour reads seasonal *variation* rather than absolute
  size and a headwater creek's snowmelt pulse lights up as vividly as the
  Mississippi's crest (absolute `log-q` left the great rivers pinning the scale
  and every tributary a flat dim — the original blow-out). A
  `SELF_SCALE_MIN_LOG_SPAN = 0.30` floor keeps near-constant/regulated reaches
  dim instead of amplifying their noise to full contrast. `tripGradient.domain:
  [0, 1]` (annual low → annual high). Fill (−999900) or a reach with no finite
  range → `NaN` → `colorMappingDefault`. (`log-q` is retained as a `--value`
  option for the absolute read.)
- **Demo 2 (March, hourly)**: `v = round(clamp(log2(q / median_2019), 0, 6), 2)`
  — **flood anomaly**; a creek at 50× median lights up like a mainstem, which is
  exactly the flood-wave read (absolute discharge would leave the flooding
  Missouri tributaries invisible next to Mississippi baseline). `median_2019` per
  reach computed from the demo-1 daily series (already downloaded — free and
  deterministic). Reaches with median ≈ 0 (intermittent) → `NaN` → fallback.
  `domain: [0, 6]` (1× → 64×).
- **Width**: static per-feature `width` property = f(Strahler order), driven by
  `getWidth: 'width'` (already supported per-feature) + `widthMinPixels/Max`.
  Constant-order merging keeps it exact per feature. No per-bucket width (would
  need matrix→width plumbing — new code; rejected).
- Rounding to 0.01 in log space (1–2 % relative error in q) is far below ramp
  resolution and is the main compression lever (§3).

## 6. Decision 4 — renderer

**Zero new layer code.** Reuse the exact `bixi-streets` showcase recipe:
`type: 'trips'`, `flowMatrix: true`, `trailLength: 0`, `timeWindow` = bucket ms,
`tripGradient` over the baked log/anomaly domain, `getWidth: 'width'`,
`capRounded/jointRounded: false`. Two `datasets.ts` entries; CONUS home view
(≈ lon −96, lat 38.5, z4.3, pitch 0). Confirmed non-gaps: log domain (baked),
NaN fill (fallback color path), single shared bucket axis (all features span the
range), no `vertex_time` conflict (matrix layers omit it). Known acceptable
limits: CPU re-expand per sub-step is O(resident verts) — ≤ ~1 M verts × 2-bucket
blend at overview, on par with existing flow demos; per-vertex color (not width)
carries the animation.

## 7. Decision 5 — pipeline architecture

Follow repo convention: datasets download + cache under `data/`, emit a GeoParquet
intermediate next to the output, then shell out to `stt-build`.

**Stage 1 — geometry export (Python, one-shot)**
`scripts/data-generation/nwm_flowlines_export.py` (venv-rivers): extract the 7z
(py7zr), read `NHDFlowline_Network` (pyogrio/OpenFileGDB), keep
`COMID, StreamOrde, LevelPathI, Hydroseq, Divergence, LENGTHKM, geometry`,
drop order < 4 minor divergences (braids), write
`data/nwm/nhd-flowlines.parquet` (WKB geometry). Pure export — all merging/
resampling lives in Rust where it's deterministic and tested.

**Stage 2 — `stt-generate nwm` (new Rust dataset, the bulk of the work)**
`crates/stt-generate/src/datasets/nwm.rs`, registered in `datasets/mod.rs` +
`main.rs::Commands`. Flags: `--flowlines <parquet>`, `--window 2019|2019-03`,
`--bin 1d|1h`, `--value log-q|log-anomaly`, `--ladder` (defaults per §4),
`--output`, `--skip-build`, `--skip-download`.
1. *Chunk fetch* — plain HTTPS GET of `chrtout.zarr/streamflow/{t}.{r}` objects
   (no zarr crate: chunks are bare zstd frames; decode with the existing `zstd`
   dep, parse int32 LE × 0.01). Cache compressed chunks at
   `data/nwm/chrtout-cache/{t}.{r}.zst`; skip-if-exists ⇒ resumable; March reuses
   the year's chunks. Also fetch 1-D `order` once (join sanity check vs NHDPlus
   `StreamOrde`).
2. *Reduce* — stream reach-stripe-major (one 30 k-reach stripe × 14 time-chunks ≈
   1 GB peak): daily mean (demo 1) / hourly passthrough (demo 2) / per-reach 2019
   median; keep only reaches with order ≥ 4 (669 k × 365 × 4 ≈ 1 GB RAM ceiling).
   Persist per-stripe reduced series to `data/nwm/reduced/{window}-{bin}/stripe-{r}.bin`
   ⇒ resumable, and demo 2 + medians reuse demo 1's pass.
3. *Assemble* — join reduced series to flowlines by COMID (log unmatched count);
   per band: filter by order, merge constant-`(LevelPathI, StreamOrde)` runs by
   `Hydroseq`, resample to the band's spacing, splat each vertex's source-reach
   series (rounded log values) into the flat vertex-major matrix; sort features by
   COMID for determinism; write one intermediate per demo via
   `StreamingLineStringParquetWriter` with properties
   `min_zoom, max_zoom, order, width` and `vertex_value_matrix`.
4. *Build* — `run_stt_build_with_full_options`: `time_field/end_time_field`,
   `min_zoom 4`, `max_zoom 8`, `temporal_bucket = bin`, `min_zoom_field`/
   `max_zoom_field`, `quantize_coords ≈ 10 m` (halves geometry bytes; geometry is
   ~5 % of the archive), no simplify (required), zstd. Outputs
   `examples/showcase/public/data/nwm-rivers-2019/` and `…-flood-2019-03/`;
   validate with `stt-validate`.

**Stage 3 — showcase** — two `datasets.ts` entries (§6).

Determinism: static source archive (retro 3.0, 1979–2023), pinned window/ladder/
rounding, sorted feature order, reproducible `stt-build` (covered by
`reproducible_build.rs`).

## 8. Pilot before full build

Build z6–z7 only, March hourly, order ≥5 (≈ 325 k verts × 744): measure archive
size (→ real zstd ratio vs the 4× assumption), largest-tile decoded size, and
showcase FPS while scrubbing. Gate the z9 stretch band and the demo-2 z8
threshold (≥4 vs ≥5) on the result. Cost: ~1.2 GB download, minutes of build.

## 9. Risks (ranked) & open questions

1. **Compression ratio unvalidated** (drives every disk number). Mitigation: log
   rounding + pilot; fallback knobs: coarser cadence (2019 @ 2-day = 183 buckets),
   higher order thresholds, drop z8→z7 for the hourly demo.
2. **Hot-tile decode/memory at 744 buckets** (Mississippi-valley z8 ≈ 100 MB
   decoded viewport worst case). Knob: z8 → order ≥5 for demo 2.
3. **Mainstem merge correctness** (LevelPathI/Hydroseq edge cases, divergences).
   Fallback: skip merging at z6+ (per-reach features; only z4–5 truly need merging).
4. **COMID ↔ feature_id join gaps** (expect >99 % match — NWM is built on
   NHDPlusV2; drop + log misses; cross-check zarr `order` vs `StreamOrde`).
5. **Anomaly baseline choice** (2019 median vs multi-year climatology; 2019 is a
   wet year, damping its own anomalies). Open: acceptable for v1?
6. Lakes/reservoir artificial paths render as rivers (fine visually); intermittent
   zero-flow reaches → NaN fallback color (verify it reads as "dry", not "error").
7. Open: attribution string (NOAA NWM + USGS NHDPlus), exact ramps (dataviz pass),
   AK/HI/PR domains (out of scope), z9 band ship/no-ship.
