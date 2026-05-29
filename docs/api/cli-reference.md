# CLI Reference

The Rust toolchain ships four binaries. Build them with
`cargo build --release` from the repo root; binaries land in
`target/release/`.

| Binary          | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `stt-build`     | Convert a GeoParquet file into a `.stt` archive                  |
| `stt-generate`  | Download + build the bundled showcase datasets                   |
| `stt-optimize`  | Analyze an input and recommend `stt-build` flags                 |
| `stt-validate`  | Open an archive, verify integrity tags, decode each tile         |

---

## `stt-build`

```bash
stt-build [OPTIONS] --input <INPUT> --output <OUTPUT>
```

Reads a GeoParquet file (`.parquet` / `.geoparquet`) with a WKB or GeoArrow
geometry column (or separate `lon`/`lat` columns) plus a timestamp column,
tiles it across zooms and temporal buckets, and writes an STT v3 archive.

### Required

| Flag | Description |
| ---- | ----------- |
| `-i, --input <PATH>` | Source GeoParquet file |
| `-o, --output <PATH>` | Output `.stt` archive |

### Time

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `-t, --time-field <NAME>` | `timestamp` | Field carrying the (start) timestamp |
| `--end-time-field <NAME>` | — | Optional end-time field; creates per-feature ranges (LineString trajectories) |
| `--time-format <FMT>` | `iso8601` | One of `iso8601`, `unix-ms`, `unix-sec` |
| `--strict-times` | off | Fail the build on null/unparseable timestamps instead of coercing to epoch with a warning |

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
| `--temporal-lod <SPEC>` | — | Coarser-bucket pyramid, e.g. `1d,30d` or `1d@8,30d@4`. Each entry MUST be a multiple of `--temporal-bucket`, sorted ascending. `@N` clamps that level to zooms ≤ N. |

### Compression

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--compression <ALGO>` | `zstd` | One of `none`, `gzip`, `zstd`. zstd-3 is ~5× faster than gzip-6 at an equivalent or better ratio; pick `gzip` only for v2 compatibility. |

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

### Polygon pre-tessellation

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--pre-tessellate` | off | Run earcut at build time, store triangle indices in a sidecar column. Renderers skip CPU tessellation on tile arrival. |

### Streaming pipelines

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--streaming` | off | Write tiles as each zoom level completes (lower peak RAM, some parallelism lost) |
| `--streaming-arrow` | off | Arrow-native streaming — reads Parquet batches lazily, peak RSS bounded by one batch + the active spill budget. Required for >10 GB inputs. |
| `-w, --workers <N>` | `4` | Parallel worker threads |
| `--min-features-per-tile <N>` | `1` | Drop tiles below this count. Useful for sparse points — the TS reader's `'best-available'` refinement surfaces dropped features from parents. |

### Auto-tuning

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--auto` | off | Run `stt-optimize` over the input first and fill in any zoom / bucket / compression flag the user did not pass explicitly. |

### Summary tier (server-aggregated low-zoom tier)

When set, the archive carries one summary tile per `(zoom, x, y, t)` in
addition to the raw tier — readers dispatch between them automatically
from `metadata.summaryTier`. Currently only `h3` is implemented.

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--summary-tier <SCHEME>` | — | `h3` or `quadbin` (quadbin not implemented yet) |
| `--summary-min-zoom <N>` | `min-zoom` | Lowest zoom for summary tiles |
| `--summary-max-zoom <N>` | `min-zoom + 4` | Highest zoom for summary tiles |
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
| `--heatmap-raster <WxH>` | — | Density-grid raster tier spec, e.g. `128x128` (gated to the bottom 5 zooms). **Scaffold**: currently records intent in archive metadata only — the sidecar raster tile generation is not implemented yet. |

### Metadata

| Flag | Description |
| ---- | ----------- |
| `--name <STR>` | Archive name |
| `--description <STR>` | Description |
| `--attribution <STR>` | Attribution text |
| `--metadata-output <PATH>` | Also write a sidecar JSON for the showcase config |
| `-v, --verbose` | Debug-level tracing |

### Examples

Basic earthquake archive with auto-tuned settings:

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

### Supported geometry types

The tool automatically detects geometry from the standard GeoParquet
column names (`geometry`, `geom`, `wkb_geometry`, `the_geom`, `shape`),
falling back to a binary WKB column, a GeoArrow struct column, or
separate `lon`/`lat` (`longitude`/`latitude`) columns for Points.

| Geometry | Notes |
| -------- | ----- |
| Point | Events, sensors, vehicle positions |
| LineString | Trajectories, routes; `--end-time-field` enables per-vertex timing + clipping |
| Polygon | Boundaries; `--pre-tessellate` bakes earcut indices |

MultiPoint / MultiLineString / MultiPolygon are read but exploded into
their constituent single-geometry features before tiling.

---

## `stt-generate`

Convenience CLI that fetches the source for each bundled showcase
dataset, normalises it into GeoParquet, and shells out to `stt-build`.

```bash
stt-generate <SUBCOMMAND> [OPTIONS]
```

Subcommands:

| Subcommand | Source |
| ---------- | ------ |
| `all` | builds ONLY `earthquakes`, `hurricanes`, `wildfires` (the no-extra-setup datasets). `--output-dir <DIR>` (default `examples/showcase/public/data`), `--skip-existing`. The other datasets need per-run params (dates, OSRM, etc.) and must be run individually. |
| `earthquakes` | USGS API (M4.0+ global, 2020–2024) |
| `ais` | NOAA Marine Cadastre AIS vessel positions |
| `flights` | OpenSky Network ADS-B (Mondays 2017–2020) |
| `hurricanes` | NOAA IBTrACS historical archive |
| `wildfires` | NIFC perimeters (1000+ acres) |
| `nyc-rideshare` | NYC TLC trips + OSRM routing |
| `nyc-taxi-points` | derived from `nyc-rideshare` via polyline interpolation |
| `satellites` | CelesTrak TLE + SGP4 propagation |

Each subcommand has its own flags — run `stt-generate <subcommand> --help`
for the per-dataset options. See the
[Data Generation Guide](../guides/data-generation.md) for end-to-end
recipes.

---

## `stt-optimize`

Inspects an input (or an existing archive) and prints recommended
`stt-build` flags.

```bash
stt-optimize analyze --input data.parquet --time-field timestamp \
  --time-format unix-ms

stt-optimize recommend --input data.parquet --time-field timestamp \
  --time-format unix-ms --show-command
```

`recommend --show-command` prints a copy-pasteable `stt-build` invocation
that bakes in the recommendation. The same logic runs inside
`stt-build --auto`.

---

## `stt-validate`

Opens an archive, verifies the integrity tag (CRC32C in v3, BLAKE3-64 in
v2) on every tile, decodes each Arrow IPC payload, and reports any
anomalies.

```bash
stt-validate <ARCHIVE> [--json] [--fail-fast] [--skip-decode]
```

| Flag | Description |
| ---- | ----------- |
| `--json` | Machine-readable report (suitable for CI) |
| `--fail-fast` | Exit on the first failure |
| `--skip-decode` | Verify integrity tags only — don't decode payloads |

Suitable for CI gating any dataset that ships with the project.
