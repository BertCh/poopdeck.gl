# CLI Reference

The Rust toolchain ships four binaries. Build them with
`cargo build --release` from the repo root; binaries land in
`target/release/`.

| Binary          | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `stt-build`     | Convert a GeoParquet file into a packed STT dataset                |
| `stt-generate`  | Download + build the bundled showcase datasets                     |
| `stt-optimize`  | Analyze an input and recommend `stt-build` flags                   |
| `stt-validate`  | Verify a packed dataset (or single-file `.stt`), decode every tile |

---

## `stt-build`

```bash
stt-build [OPTIONS] --input <INPUT> --output <OUTPUT>
```

Reads a GeoParquet file (`.parquet` / `.geoparquet`) with a WKB geometry
column (or separate `lon`/`lat` columns) plus a timestamp column, tiles it
across zooms and temporal buckets, and writes the **packed format**: a
dataset directory containing `manifest.json` (tiny, mutable), one
`index/<blake3>.sttd` directory object, and one or more content-addressed
`packs/<blake3>.sttp` objects (immutable, forever-cacheable). Deploy the
directory with `scripts/r2-sync.sh` (immutable packs + short-TTL manifest).

### Required

| Flag | Description |
| ---- | ----------- |
| `-i, --input <PATH>` | Source GeoParquet file |
| `-o, --output <PATH>` | Output dataset **directory**. A path ending in `.stt` has the extension stripped for convenience, so `-o foo.stt` produces `foo/{manifest.json,index/,packs/}`. |

### Time

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `-t, --time-field <NAME>` | `timestamp` | Field carrying the (start) timestamp |
| `--end-time-field <NAME>` | — | Optional end-time field; creates per-feature ranges (LineString trajectories) |
| `--time-format <FMT>` | `iso8601` | One of `iso8601`, `unix-sec`, `unix-ms` (closed vocabulary — a typo is a clap error with a did-you-mean). Only consulted for integer (Int64) time columns: Arrow Timestamp columns are self-describing and String columns are always parsed as ISO 8601. An Int64 column under the default `iso8601` logs a warning and is interpreted as unix-ms — pass `unix-ms`/`unix-sec` to make the intent explicit. |
| `--strict-times` | off | Fail the build on null/unparseable timestamps instead of coercing to epoch 0 with a warning |

**Pre-1970 timestamps always fail the build**, in both strictness modes —
the temporal index stores unsigned ms-since-epoch and cannot represent
negative times. Filter or re-epoch such rows before building.

### Geometry strictness

Rows whose geometry is null or unparseable have no position to tile at.
By default they are **skipped** (with a count warning at the end of the
load); they are never placed at (0,0).

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--strict-geometry` | off | Fail the build on the first null/unparseable geometry instead of skipping the row |

### Spatial tiling

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--min-zoom <N>` | `0` | Lowest zoom to emit |
| `--max-zoom <N>` | `14` | Highest zoom to emit |
| `--layer <NAME>` | `default` | Layer name carried inside each tile frame |

### Temporal bucketing & LOD

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--temporal-bucket <DUR>` | `1h` | Base bucket size (e.g. `30m`, `1h`, `6h`, `1d`) |
| `--temporal-lod <SPEC>` | — | Coarser-bucket pyramid, e.g. `1d,30d` or `1d@8,30d@4`. Each entry MUST be a multiple of `--temporal-bucket`, sorted ascending. `@N` clamps that level to zooms ≤ N. In-memory pipeline only (`--streaming` is ignored when set; `--streaming-arrow` warns and skips LOD). |
| `--adaptive-temporal <N>` | — | Adaptive temporal chunking: instead of fixed buckets, partition each tile's features into windows of ~N features (dense periods get fine windows, sparse periods coarse ones). In-memory builds only. |

### Pack layout & compression

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--blob-ordering <ORD>` | `auto` | Tile-blob layout before packs are cut: `auto` (picks from the dataset's space-vs-time cardinality: wide-time → spatial-major, else 3D-Hilbert), or explicit `spatial`, `time-major`, `hilbert3`, `morton3`. Better locality → fewer packs touched per viewport → fewer client range requests. `eager` is accepted for backward-compat and maps to `auto`. |
| `--pack-size <MIB>` | `64` | Target pack object size in MiB. A single blob larger than the target gets its own pack rather than being split. Smaller → finer cache granularity, more objects; larger → fewer, coarser objects. Stay well under the CDN per-object cap (512 MB). |
| `--compression <ALGO>` | `zstd` | The packed format is **zstd-only** — every tile blob is compressed per-blob with zstd. `gzip`/`none` are rejected; drop the flag. |

### Size & layout

The directory is **paged by default** (a tiny root page + leaf pages, so a cold
reader fetches only the leaves its viewport / time-window touches).

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--publish` | off | Deploy-ready build: raises the zstd level to 19 (−10..19% on the wire, decode-free) for serve-as-is output. The directory is already paged by default, so this only bumps the level; `--zstd-level` overrides it. This is what `stt-generate` uses, so a from-source build is publish-quality without a separate re-transcode. (Coordinate quantization stays a per-dataset opt-in via `--quantize-coords`.) |
| `--zstd-level <1..22>` | `3` | zstd level for tile blobs + directory. Default 3 is zstd's "fast" tier; a publish build should pass 19 — the format is write-once / serve-many, so the higher (one-time, offline) build CPU buys −10..19% on every client fetch, and decode is level-independent (free on the client). 19 ≈ 22 on STT tiles, so there's no reason to go past 19. |
| `--quantize-coords <METERS>` | `0` | Opt-in coordinate quantization: store geometry as fixed-point integers at this ground precision in **meters** instead of Float64 lon/lat. `0` keeps Float64 GeoArrow coords. Coordinates are the dominant, near-incompressible tile column, so e.g. `--quantize-coords 1` (sub-meter error) is the largest size lever — measured −25..47% on trip/path datasets. Trade-off: a quantized tile is no longer self-describing Float64 GeoArrow (the per-tile affine rides in geometry field metadata; the STT reader reconstructs Float64). |
| `--single-directory` | off | Opt OUT of the paged directory and emit a single whole-load `.sttd` instead. For small datasets paging is ~free (one leaf, whole-loaded by the reader); the single shape only saves a few hundred bytes of root. |
| `--page-entries <N>` | `4096` | Entries per leaf page (the sim-validated 1024–4096 sweet spot). Ignored with `--single-directory`. |

### Per-tile budgets (opt-in)

The project follows a documented "no thinning / comprehensive data by default"
principle. These caps are **inert unless explicitly set**, and when they DO drop
features they log exactly how many per affected tile (never randomly).

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--maximum-tile-bytes <BYTES>` | — | Soft cap on a tile's estimated UNCOMPRESSED payload in bytes. When a tile exceeds this, its lowest-importance features are dropped to fit. Unset = no byte cap. tippecanoe analogue: `--maximum-tile-bytes`. |
| `--maximum-tile-features <N>` | — | Hard cap on the number of features per tile. When a tile exceeds this, its lowest-importance features are dropped to fit. Unset = no feature cap. tippecanoe analogue: `--maximum-tile-features`. |
| `--drop-densest-as-needed` | off | When a per-tile budget drops features, prefer to drop from the DENSEST features first (geometry-size density). Only meaningful with `--maximum-tile-bytes`/`--maximum-tile-features`. Without it a budget still drops the LEAST-important features first (a combined geometry+property score) — never randomly. tippecanoe analogue: `--drop-densest-as-needed`. |

### Attribute control (opt-in)

Default = keep every property. System columns (id/time/geometry/vertex_*/triangles)
always survive regardless.

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--exclude <PROP>` | — | Drop these property columns from output tiles (repeatable). Mutually exclusive with `--include`. tippecanoe analogue: `--exclude`. |
| `--include <PROP>` | — | Keep ONLY these property columns (repeatable). Mutually exclusive with `--exclude`. tippecanoe analogue: `--include`. |
| `--exclude-all` | off | Drop EVERY user property — geometry + times only. Mutually exclusive with `--exclude`/`--include`. tippecanoe analogue: `--exclude-all`. |

### Zoom LOD fields (per-feature)

Whole-feature filtering driven by a per-feature numeric property; geometry and
attributes are untouched.

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--min-zoom-field <NAME>` | — | Per-feature numeric property naming the shallowest zoom a feature appears at (road-class-style LOD). A feature is skipped at any zoom below its value — major roads when zoomed out, all streets up close. |
| `--max-zoom-field <NAME>` | — | Per-feature numeric property naming the DEEPEST zoom a feature appears at (LOD ceiling). A feature is skipped at any zoom above its value. Paired with `--min-zoom-field` it confines a feature to a zoom band `[min_zoom, max_zoom]` — e.g. coarse-zoom clustered/aggregated overviews that must not bleed into full-resolution deep zooms. |

The per-tile budgets and attribute-control flags hook into the in-memory build
path only; `--streaming-arrow` **errors** when combined with any of them (see
[Streaming pipelines](#streaming-pipelines)).

### Trajectory clipping

LineStrings with `--end-time-field` are clipped at tile boundaries with
Liang–Barsky, and per-vertex timestamps are interpolated so each tile's
sub-trajectory animates correctly.

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--no-clip` | off | Disable clipping — entire trajectory lives in the centroid tile |
| `--clip-min-vertices <N>` | `2` | Skip clipping for paths shorter than this |

### Simplification

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--simplify` | off | Per-zoom Visvalingam–Whyatt simplification on LineStrings |
| `--simplify-max-zoom <N>` | `14` | Above this zoom, keep full vertex detail |
| `--time-aware-simplify` | off | Use time-aware TD-TR (Synchronized Euclidean Distance) instead of plain spatial Visvalingam — preserves per-vertex timing so zoomed-out playback keeps moving objects in the right place at the right time. Takes effect together with `--simplify`. |

### Polygon pre-tessellation

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--pre-tessellate` | off | Run earcut at build time, store triangle indices in a sidecar column. Renderers skip CPU tessellation on tile arrival. |

### Vertex-time precision

Per-vertex timestamps ride a compact u16-delta encoding whose step is
derived from each tile layer's temporal span. A layer that would need a
step coarser than the ceiling is stored as exact i64 timestamps instead
(larger payload, zero precision loss).

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--vertex-time-precision <MS>` | `1000` | Ceiling (ms) on the quantization step. The default is below anything playback can show; raise it only to trade precision for payload size on very wide temporal-LOD buckets. |

### Streaming pipelines

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--streaming` | off | Write tiles as each zoom level completes (lower peak RAM, some parallelism lost). Ignored when `--temporal-lod` is set. |
| `--streaming-arrow` | off | Arrow-native streaming — reads Parquet batches lazily, peak RSS bounded by one batch + the active spill budget. Required for >10 GB inputs. Streams to a temp single-file archive, then transcodes to the packed directory (the `--blob-ordering` applies during the transcode pass). |
| `-w, --workers <N>` | `4` | Parallel worker threads (in-memory pipelines; **ignored** by `--streaming-arrow`, which is single-threaded) |
| `--min-features-per-tile <N>` | `1` | Drop tiles below this count. Useful for sparse points — the TS reader's `'best-available'` refinement surfaces dropped features from parents. |

`--streaming-arrow` refuses flag combinations it cannot honour rather than
silently dropping them — it **errors** when combined with `--summary-tier`,
`--heatmap-weight`, `--heatmap-class`, `--metadata-output`, the per-tile
budgets (`--maximum-tile-bytes` / `--maximum-tile-features` /
`--drop-densest-as-needed`), or the attribute-control flags (`--exclude` /
`--include` / `--exclude-all`) — those passes run after the in-memory
pipeline's finalize. `--temporal-lod` is ignored with a warning, and
`--adaptive-temporal` does not apply (fixed buckets only). Use the in-memory
pipeline for those features.

### Auto-tuning

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--auto` | off | Run `stt-optimize` over the input first and fill in any zoom / temporal-bucket flag the user did not pass explicitly. The analyzer's compression recommendation is NOT applied — the packed format is zstd-only. |

### Summary tier (server-aggregated low-zoom tier)

When set, the archive carries one summary tile per `(zoom, x, y, t)` in
addition to the raw tier — readers dispatch between them automatically
from `metadata.summaryTier`. `h3` is the available scheme.

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--summary-tier <SCHEME>` | — | `h3` (`quadbin` is reserved and not currently accepted) |
| `--summary-min-zoom <N>` | `min-zoom` | Lowest zoom for summary tiles |
| `--summary-max-zoom <N>` | `min(min-zoom + 4, max-zoom)` | Highest zoom for summary tiles |
| `--summary-columns <SPEC>` | `""` | Comma-separated `name:agg` list, e.g. `magnitude:mean,magnitude:max,depth:sum`. `count` is always implicit. |
| `--summary-layer <NAME>` | `summary` | Layer name carried in summary tile frames |
| `--summary-sub-buckets <N>` | `1` | Sub-buckets PER tile temporal bucket. `>1` adds N `bucket_<i>` count columns per cell (one per `bucket_ms / N` sub-window) so the renderer can animate through them with no data re-upload. Recommended 12–30 for hour buckets; capped at 32. |

### HeatmapLayer build-time domain

When the data ships with property values far outside `[0, 1]` (earthquake
magnitudes, AIS speed), bake a per-class intensity domain into archive
metadata so the renderer doesn't fall back to a runtime GPU readback.

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--heatmap-weight <PROP>` | — | Numeric property driving per-splat weight. The build computes its `[min, 95p]` across all features. |
| `--heatmap-class <PROP>` | — | Categorical property whose unique values become per-class entries (up to 8). |

### Metadata

| Flag | Description |
| ---- | ----------- |
| `--name <STR>` | Archive name |
| `--description <STR>` | Description |
| `--attribution <STR>` | Attribution text |
| `--metadata-output <PATH>` | Also write a sidecar JSON for the showcase config (its `filename` points at `<dir>/manifest.json`) |
| `-v, --verbose` | Debug-level tracing |

### Examples

Basic earthquake dataset with auto-tuned settings (writes the
`earthquakes/` directory):

```bash
stt-build -i earthquakes.parquet -o earthquakes.stt \
  --time-field time --time-format unix-ms \
  --auto
```

NYC taxi trajectories with simplification and a one-day temporal LOD:

```bash
stt-build -i taxi-trips.parquet -o taxi-trips.stt \
  --time-field start_time --end-time-field end_time \
  --time-format unix-ms \
  --simplify \
  --temporal-bucket 30m \
  --temporal-lod 1d@8,30d@4
```

Global earthquakes with an H3 summary tier for low-zoom rendering plus a
weight-aware heatmap domain:

```bash
stt-build -i earthquakes.parquet -o earthquakes.stt \
  --time-field time --time-format unix-ms \
  --summary-tier h3 --summary-min-zoom 0 --summary-max-zoom 4 \
  --summary-columns magnitude:mean,magnitude:max \
  --heatmap-weight magnitude
```

### Input requirements (GeoParquet)

The build reads the GeoParquet `geo` footer metadata when present:

- **`primary_column` wins** for geometry-column selection. Without it (or
  for plain Parquet inputs), the standard names are tried
  (`geometry`, `geom`, `wkb_geometry`, `the_geom`, `shape`), then any
  binary column (assumed WKB), then a separated x/y point struct, then
  top-level `lon`/`lat` (`longitude`/`latitude`, `x`/`y`) columns.
- **Coordinates must be lon/lat degrees** — `OGC:CRS84` / `EPSG:4326`
  (absent/`null` CRS means CRS84 per the GeoParquet spec). Any other
  declared CRS fails the build with a reproject hint
  (geopandas: `gdf.to_crs(4326).to_parquet(...)`).
- **Geometry encoding must be WKB** (`Binary`/`LargeBinary`/`BinaryView`
  all work), with one exception: the native geoarrow separated-struct
  *Point* encoding is also readable. Native geoarrow
  `linestring`/`polygon`/`multi*` encodings fail with a re-export hint
  (geopandas: `gdf.to_parquet(..., geometry_encoding='WKB')`).

| Geometry | Notes |
| -------- | ----- |
| Point | Events, sensors, vehicle positions |
| LineString | Trajectories, routes; `--end-time-field` enables per-vertex timing + clipping |
| Polygon | Boundaries; `--pre-tessellate` bakes earcut indices |

Multi-geometries are read but **flattened within the feature**, not
exploded: a MultiPoint collapses to a single point at its centroid, a
MultiLineString's vertices are concatenated into one path, and a
MultiPolygon's rings are flattened into one ring list (kept separable by
ring offsets). Split multi-geometries into one row per part before export
if you need them rendered independently.

Two optional list columns are recognised when present: `vertex_timestamps`
(`List<Timestamp>` / `List<Int64>`, real per-segment timing for
trajectories) and `vertex_values` (`List<Float32>` / `List<Float64>`, a
per-vertex scalar such as sea-surface temperature), both aligned with the
geometry's vertices.

---

## `stt-generate`

Convenience CLI that fetches the source for each bundled showcase
dataset, normalises it into GeoParquet, and shells out to `stt-build`
(so each output is a packed dataset directory too).

```bash
stt-generate <SUBCOMMAND> [OPTIONS]
```

Subcommands:

| Subcommand | Source |
| ---------- | ------ |
| `all` | builds ONLY `earthquakes`, `hurricanes`, `wildfires` (the no-extra-setup datasets). `--output-dir <DIR>` (default `examples/showcase/public/data`), `--skip-existing`. The other datasets need per-run params (dates, OSRM, etc.) and must be run individually. |
| `earthquakes` | USGS API (M4.0+ global, 2020–2024) |
| `ais` | NOAA Marine Cadastre AIS vessel positions |
| `flights` | OpenSky Network ADS-B (Mondays 2017–2020); `--paths` emits LineString trajectories instead of points |
| `hurricanes` | NOAA IBTrACS historical archive |
| `wildfires` | NIFC perimeters (1000+ acres) |
| `nyc-rideshare` | NYC TLC trips + OSRM routing; `--paths` for LineString trajectories, `--flows` for pre-aggregated corridor flows (`--flow-bin` default `15m`, `--flow-snap-meters` default `30` merges nearby road nodes; 0 = exact OSRM geometry) |
| `bixi` | Montréal BIXI open-data trips → directed origin→destination flowmap (one 2-vertex O→D arc per station pair carrying a per-bucket count matrix). `--input` is required (the BIXI `.zip`/`.csv` or a directory). Build-time per-zoom station clustering is on by default (`--cluster-radius`, `--no-cluster`); `--bake-bundling` bakes KDEEB edge bundling into the geometry; `--streets` routes onto the OSM bicycle network instead (needs `--osm-pbf` + a bicycle-profile `--osrm-url`). |
| `nyc-taxi-points` | derived from `nyc-rideshare` via polyline interpolation |
| `satellites` | CelesTrak TLE + SGP4 propagation |
| `drifters` | NOAA Global Drifter Program 6-hourly buoy trajectories |
| `drifters-hourly` | EXPERIMENTAL: GDP hourly product (`drifter_hourly_qc`) — 6× the temporal resolution (and volume) of `drifters` |
| `animals` | GBIF animal-tracking datasets (license-filtered via `--licenses`) |
| `osm-edits` | OSM editing history — `--source nodes` (first-version node creations from a full-history `.osh.pbf`) or `--source changesets` (bbox-centroids from `changesets-latest.osm.bz2`), scoped to a metro `--bounds`. © OpenStreetMap contributors (ODbL). |
| `storms` | NEXRAD storm-radar tiles for the 2020-08-10 Iowa derecho. Downloads archived Level II volumes from AWS, reprojects/mosaics each ~5-min scan, and bakes **three** packed archives under `--output`: `storm-field` (filled reflectivity contour bands), `storm-cells` (storm-cell centroids), and `storm-tracks` (cells linked across scans into animated trails). |

Each subcommand has its own flags — run `stt-generate <subcommand> --help`
for the per-dataset options. See the
[Data Generation Guide](../guides/data-generation.md) for end-to-end
recipes.

---

## `stt-optimize`

Inspects an input and prints recommended `stt-build` flags. `analyze` also
accepts an existing archive via `--stt` (single-file `.stt` only —
it does not open packed dataset directories) and supports
`--format json` / `-o <FILE>` for machine-readable output.

```bash
stt-optimize analyze --input data.parquet --time-field timestamp \
  --time-format unix-ms

stt-optimize recommend --input data.parquet --time-field timestamp \
  --time-format unix-ms --show-command
```

`recommend --show-command` prints a copy-pasteable `stt-build` invocation
that bakes in the recommendation. The same logic runs inside
`stt-build --auto` (which applies the zoom-range and temporal-bucket
recommendations but not compression — the packed format is zstd-only).

---

## `stt-validate`

Validates an STT dataset. Accepts the canonical **packed format** — pass
the dataset directory or its `manifest.json` — or a single-file
`.stt` archive.

```bash
stt-validate my-dataset/ [--json] [--fail-fast] [--skip-decode]
stt-validate my-dataset/manifest.json
stt-validate archive.stt
```

Checks performed:

1. (packed) Every pack and the directory object blake3-hash to the name
   the manifest gave them, on-disk lengths match, and the directory
   references no out-of-range `pack_id`.
2. The index decodes and every entry has the columns the schema promises.
3. Every tile blob round-trips its content hash and decompresses to its
   declared uncompressed size.
4. Every payload decodes as a layer frame of Arrow IPC streams.
5. Feature counts in tile entries match the decoded layer rows.
6. Tile temporal extents lie inside the dataset's metadata time range.

| Flag | Description |
| ---- | ----------- |
| `--json` | Machine-readable report (suitable for CI) |
| `--fail-fast` | Exit on the first failure |
| `--skip-decode` | Skip the per-tile decode step — only header/integrity, index, and content-hash checks |
| `--sample <N>` | Decode only a deterministic, evenly-spread sample of at most N tiles instead of every tile. The integrity / header / content-hash / temporal-bound checks still run over ALL tiles (they're cheap); only the expensive Arrow-decode + schema + feature-count checks are sampled. The sample is reproducible (every `ceil(total/N)`-th entry), and the report makes clear the decode was sampled rather than exhaustive. Useful for very large archives. |

Exits non-zero on any failure. Suitable for CI gating any dataset that
ships with the project.

---

## Maintenance tools (cargo examples)

`crates/stt-core/examples/` carries operational one-offs that are run via
`cargo run --release -p stt-core --example <name>` rather than shipped as
binaries. The one you're most likely to need:

- **`pack-cover`** — losslessly re-packs a packed dataset whose directory
  predates the `cover_t_min` covering section, backfilling the tight
  temporal bound per tile (payload bytes untouched):
  ```bash
  cargo run --release -p stt-core --example pack-cover -- \
    <in_dir/manifest.json> <out_dir> [pack_size_mb=64] [ordering=auto]
  ```

Others (`repack`, `packed-stats`, `pack-transcode`, `verify-packed`,
`simulate_layout`, …) are analysis/benchmark aids — see
`crates/stt-core/examples/README.md`.
