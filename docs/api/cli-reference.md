# CLI Reference

`cargo install spatiotemporal-tiles` installs five binaries — `stt-build`,
`stt-optimize`, `stt-validate`, `stt-bundle`, `stt-serve` — and **not**
`stt-generate`, which is `publish = false` and builds only from a repo
checkout. You can also grab a prebuilt binary from the
[GitHub releases page](https://github.com/BertCh/spatiotemporal-tiles/releases)
(shell/powershell installers included), or build from the repo root with
`cargo build --release -p spatiotemporal-tiles` (binaries land in
`target/release/`).

| Binary         | Purpose                                                                              |
| -------------- | ------------------------------------------------------------------------------------ |
| `stt-build`    | Convert a GeoParquet file **or a PostGIS/DuckDB query** into a packed STT dataset    |
| `stt-optimize` | Analyze an input and recommend `stt-build` flags; inspect/diff/doctor built tilesets |
| `stt-validate` | Verify a packed dataset, decode every tile                                           |
| `stt-bundle`   | Pack a dataset into a single-file `.sttb` interchange bundle, or unpack one          |
| `stt-serve`    | Generate STT tiles on the fly from a live PostGIS or DuckDB source                   |

The default install gives [`stt-serve`](#stt-serve) the PostGIS backend;
`--features cli` (or `--features serve`) adds the embedded-DuckDB backend, a
heavy bundled C++ compile.

A sixth binary, **`stt-generate`** (the bundled showcase-dataset generators,
see [below](#stt-generate)), is **repo-only** — it is not on crates.io and no
install command produces it.

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

### Input & output

| Flag                  | Description                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <PATH>`  | Source GeoParquet file. Required unless a database source (below) replaces it.                                                                                             |
| `-o, --output <PATH>` | (required) Output dataset **directory**. A path ending in `.stt` has the extension stripped for convenience, so `-o foo.stt` produces `foo/{manifest.json,index/,packs/}`. |

### Database input sources (opt-in)

Instead of `--input`, `stt-build` can read features directly from a **PostGIS**
or **DuckDB** query and build the identical packed archive it would from a file
(no export step). Geometry bridges through WKB (`ST_AsEWKB` / `ST_AsWKB`), so
everything downstream — LOD, quantization, summary tiers, `--publish` — works
unchanged. `--postgres`/`--duckdb` are mutually exclusive with each other and
with `--input`, which then becomes optional. Each reader is behind an
off-by-default cargo feature, so build with the matching feature:
`cargo build --release -p stt-build --features postgres` (or `duckdb`).
The full design + benchmarks are in
[db-input-adaptors.md](../roadmap/db-input-adaptors.md).

| Flag                   | Default | Description                                                                                                                                                                                                                                                                |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--postgres <CONN>`    | —       | Read from a PostGIS table/query (`--features postgres`). Env fallback: `STT_POSTGRES_URL` / `DATABASE_URL`. Connection is NoTls (localhost / trusted-network).                                                                                                             |
| `--duckdb <PATH>`      | —       | Read from a DuckDB database file (`--features duckdb`, engine statically bundled — no system lib). A real file opens read-only; `:memory:` opens a fresh in-memory DB for scanning external files via `--sql` (e.g. `read_parquet(...)`). Env fallback: `STT_DUCKDB_PATH`. |
| `--table <NAME>`       | —       | Source table to read (optionally schema-qualified, e.g. `public.hurricane_obs`). Mutually exclusive with `--sql`; provide exactly one.                                                                                                                                     |
| `--sql <SELECT>`       | —       | Arbitrary SQL `SELECT` to read from (wrapped as a subquery). Mutually exclusive with `--table`. Must expose `--geom-column` and `--time-field`.                                                                                                                            |
| `--geom-column <NAME>` | `geom`  | Geometry column. Must be (or reproject to) EPSG:4326 lon/lat.                                                                                                                                                                                                              |
| `--where <SQL>`        | —       | Optional SQL predicate appended to a `--table` read (e.g. `--where "iso_time >= '1970-01-01'"`).                                                                                                                                                                           |
| `--source-srid <SRID>` | —       | Reproject the source geometry from this EPSG code to 4326 at ingest (PostGIS `ST_Transform`; DuckDB `ST_Transform(..., always_xy => true)`).                                                                                                                               |

The `--time-field` / `--time-format` / `--end-time-field` flags below apply
identically to a DB source. Per-vertex list columns (`vertex_timestamps`,
`vertex_values`, `vertex_value_matrix`) are bridged from array/`LIST` columns of
the matching element type. **Pre-1970 timestamps still fail** (unsigned epoch) —
filter them in `--where`/`--sql`.

### Time

| Flag                      | Default     | Description                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-t, --time-field <NAME>` | `timestamp` | Field carrying the (start) timestamp                                                                                                                                                                                                                                                                                                                                                                       |
| `--end-time-field <NAME>` | —           | Optional end-time field; creates per-feature ranges (LineString trajectories)                                                                                                                                                                                                                                                                                                                              |
| `--time-format <FMT>`     | `iso8601`   | One of `iso8601`, `unix-sec`, `unix-ms` (closed vocabulary — a typo is a clap error with a did-you-mean). Only consulted for integer (Int64) time columns: Arrow Timestamp columns are self-describing and String columns are always parsed as ISO 8601. An Int64 column under the default `iso8601` logs a warning and is interpreted as unix-ms — pass `unix-ms`/`unix-sec` to make the intent explicit. |
| `--strict-times`          | off         | Fail the build on null/unparseable timestamps instead of coercing to epoch 0 with a warning                                                                                                                                                                                                                                                                                                                |

**Pre-1970 timestamps always fail the build**, in both strictness modes —
the temporal index stores unsigned ms-since-epoch and cannot represent
negative times. Filter or re-epoch such rows before building.

### Geometry strictness

Rows whose geometry is null or unparseable have no position to tile at.
By default they are **skipped** (with a count warning at the end of the
load); they are never placed at (0,0).

| Flag                | Default | Description                                                                       |
| ------------------- | ------- | --------------------------------------------------------------------------------- |
| `--strict-geometry` | off     | Fail the build on the first null/unparseable geometry instead of skipping the row |

### Spatial tiling

| Flag             | Default   | Description                               |
| ---------------- | --------- | ----------------------------------------- |
| `--min-zoom <N>` | `0`       | Lowest zoom to emit                       |
| `--max-zoom <N>` | `14`      | Highest zoom to emit                      |
| `--layer <NAME>` | `default` | Layer name carried inside each tile frame |

### Temporal bucketing & LOD

| Flag                      | Default | Description                                                                                                                                                                                                                      |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--temporal-bucket <DUR>` | `1h`    | Base bucket size (e.g. `30m`, `1h`, `6h`, `1d`)                                                                                                                                                                                  |
| `--temporal-lod <SPEC>`   | —       | Coarser-bucket pyramid, e.g. `1d,30d` or `1d@8,30d@4`. Each entry MUST be a multiple of `--temporal-bucket`, sorted ascending. `@N` clamps that level to zooms ≤ N. In-memory pipeline only (`--streaming` is ignored when set). |
| `--adaptive-temporal <N>` | —       | Adaptive temporal chunking: instead of fixed buckets, partition each tile's features into windows of ~N features (dense periods get fine windows, sparse periods coarse ones). In-memory builds only.                            |

### Pack layout & compression

| Flag                         | Default | Description                                                              |
| ---------------------------- | ------- | ------------------------------------------------------------------------ |
| `--blob-ordering <ORD>`      | `auto`  | Tile-blob layout before packs are cut. See below.                        |
| `--pack-size <MIB>`          | `64`    | Target pack object size in MiB. A blob larger than it gets its own pack. |
| `--pack-memory-budget <MIB>` | `512`   | RAM budget for payloads buffered between encode and finalize.            |
| `--compression <ALGO>`       | `zstd`  | The packed format is zstd-only; `gzip`/`none` are rejected.              |

`--blob-ordering` accepts `auto` (picks from the dataset's occupied space-vs-time
extent: shallow or wide-time → spatial-major, else 3D-Hilbert), `measured`
(simulate per-ordering range-read cost and pick the cheapest — see
`stt-optimize order-audit`), or an explicit `spatial`, `time-major`, `hilbert3`,
or `morton3`. `morton3` is research-only; the auto and measured pickers never
select it. The resolved order is recorded in `manifest.blobOrdering`. Better
locality means fewer packs touched per viewport, and so fewer client range
requests.

`--pack-size` trades cache granularity against object count: smaller is finer
and more numerous, larger is coarser and fewer. Stay well under the CDN
per-object cap (512 MB).

`--pack-memory-budget` is purely a memory-behaviour lever — output bytes are
identical at any budget. Beyond the budget, payloads spill to a temp file inside
the output directory (removed on success and failure alike) and are read back
during finalize; the ~100 B of per-tile directory metadata always stays in RAM.
`0` means unlimited.

There is **no `--format-version` flag.** `stt-build` emits packed
`formatVersion` 2 unconditionally — schema templates embedded in the
manifest (no per-tile schema tax), sectioned layer frames with `TILE_META`,
time-sorted rows, and `STTP`/`STTD` object magic (packed spec §5.2, §9.2).
The transitional `--format-version 1` kill switch was removed together with
v1 read support on 2026-07-26 (packed spec §9.1); a v1 dataset can no longer
be written **or** read by this toolchain.

### Size & layout

The directory is **paged by default** (a tiny root page + leaf pages, so a cold
reader fetches only the leaves its viewport / time-window touches).

| Flag                         | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--publish`                  | off     | Deploy-ready build: raises the zstd level to 19 for serve-as-is output (see `--zstd-level` for why); `--zstd-level` overrides it. The directory is already paged by default, so this only bumps the level. This is what `stt-generate` uses, so a from-source build is publish-quality as written (no separate repack pass). (Coordinate quantization stays a per-dataset opt-in via `--quantize-coords`.)                                                                                                                              |
| `--zstd-level <1..22>`       | `3`     | zstd level for tile blobs + directory. Default 3 is zstd's "fast" tier; a publish build should pass 19 — the format is write-once / serve-many, so the higher (one-time, offline) build CPU buys −10..19% on every client fetch, and decode is level-independent (free on the client). 19 ≈ 22 on STT tiles, so there's no reason to go past 19.                                                                                                                                                                                        |
| `--quantize-coords <METERS>` | `0`     | Opt-in coordinate quantization: store geometry as fixed-point integers at this ground precision in **meters** instead of Float64 lon/lat. `0` keeps Float64 GeoArrow coords. Coordinates are the dominant, near-incompressible tile column, so e.g. `--quantize-coords 1` (sub-meter error) is the largest size lever — measured −25..47% on trip/path datasets. Trade-off: a quantized tile is no longer self-describing Float64 GeoArrow (the per-tile affine rides in geometry field metadata; the STT reader reconstructs Float64). |
| `--single-directory`         | off     | Opt OUT of the paged directory and emit a single whole-load `.sttd` instead. For small datasets paging is ~free (one leaf, whole-loaded by the reader); the single shape only saves a few hundred bytes of root.                                                                                                                                                                                                                                                                                                                        |
| `--page-entries <N>`         | `4096`  | Entries per leaf page (the sim-validated 1024–4096 sweet spot). Ignored with `--single-directory`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Column encoding & packing (opt-in)

Per-column encoders that trade raw Float64 fidelity for size, or repack scalar
columns into GPU-ready shapes. All are off by default (output stays
byte-identical unless opted in).

| Flag                                   | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--quantize-attr <NAME=PREC>`          | —       | Store the named Float64 property as fixed-point integers at the given precision (in the property's own units) instead of raw Float64, with a per-column affine in field metadata (the reader reconstructs Float64). Repeatable: `--quantize-attr z=0.05 --quantize-attr speed=0.1`. A raw Float64 attribute is near-incompressible; for a LiDAR `z` elevation this is the largest size lever after the geometry — measured ~−80% on the `z` column.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--quantize-attrs-auto`                | off     | Automatically quantize every Float64 numeric property that has no explicit `--quantize-attr` precision. Two regimes, chosen per column per tile: an **integer-valued** column is quantized EXACTLY (step `1.0`, `UInt16`, widening to `Int32` past a 65 535 span) — lossless AND smaller; anything else is range-adaptive `UInt16`, the column's `[min, max]` span mapped onto 16 bits (~65k levels), which is visually lossless for STT's scalar fields. The reader reconstructs Float64 from the per-tile affine. Identifier-magnitude columns — anything reaching `i32::MAX`, which covers both 64-bit hash ids and mid-range ones like OSM node ids — are **left as Float64** rather than corrupted (`f64` holds them exactly). That single refusal is magnitude-based on purpose: span- or distribution-based rules vary with whichever rows a tile caught, which would flip a column's Arrow type between tiles and fail validation. A small-magnitude column with a rare outlier still quantizes, coarsely. The "born-optimized" default for generated datasets. |
| `--vector-group <NAME=COLS[:f32\|u8]>` | —       | Fuse several scalar numeric properties into ONE interleaved GPU-ready column (`FixedSizeList<f32\|u8, width>`) so the renderer binds it zero-copy with no per-point re-interleave on the main thread. Format: `NAME=col1,col2,…[:f32\|:u8]` (default leaf `f32`; use `u8` for 0–255 RGBA). The component order is the vector's component order. Repeatable: `--vector-group surfel_quat=qx,qy,qz,qw --vector-group surfel_rgba=r,g,b,a:u8`. The source scalar columns are removed from the tile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--point-elevation-column <NAME>`      | —       | Fold a numeric property into POINT geometry as the 3rd (altitude) coordinate, so the tile ships true 3D points (`FixedSizeList<_,3>`) the renderer binds zero-copy — no per-point pad-to-3D on the main thread. The column is removed from the property set (it lives in the geometry). Only affects POINT layers. Pairs with `--quantize-coords` (the z axis is quantized to the same ground precision).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--quantize-vertex-values`             | off     | Store the per-vertex value columns (`vertex_value`, `vertex_value_matrix`) as `UInt16` indices under a per-column range-adaptive affine instead of raw `Float32` — **exactly half the bytes**, plus the `vertex-value-quant` capability. These are the format's only `List<Float32>` columns and had NO size lever before (`--quantize-attr`/`--quantize-attrs-auto` cover per-feature scalar properties only), while measuring 64.2% of `nyc-taxi-flows` and 93.7% of `bixi-corridors` tile bytes. The `NaN` "no value at this vertex" marker survives via a reserved index (`0xFFFF`). Off by default because it is genuinely lossy — 16 bits across the column's own range, on data a map colours by.                                                                                                                                                                                                                                                                                                                                                                |

`--quantize-vertex-values` declares the `vertex-value-quant` capability in
`manifest.capabilities`, so a reader that does not implement it refuses the
dataset at open rather than rendering raw 0..65534 indices as physical
values. Payload contract: [data-format.md](../architecture/data-format.md),
"Per-vertex value quantization".

### Feature-time encoding

Feature `start_time` / `end_time` ship in a compact form by default: each
tile layer stores `start_time` as a `UInt32` millisecond offset from that
layer's own minimum (`TILE_META.t0`) and `end_time` as a `UInt32` duration
against each feature's own start — or omits `end_time` entirely when every
feature is instantaneous, which is 100% of features on most event datasets.
Both reference readers re-inflate absolute `Int64` columns before anything
downstream sees the batch, so nothing but the wire bytes can tell.

| Flag                 | Default | Description                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-compact-times` | off     | Kill switch: emit the historical absolute `Int64` pair instead, and suppress the `time-delta` capability. For byte-compat with a reader that predates the encoding. Measured cost of turning it off: the two columns are 33% of `nyc-taxi-points` and 17% of `earthquakes-v2` per-column cost, and compact times cut uncompressed payload ~13% on an instantaneous-event corpus. |

Note the trade-off, because it is not one-directional: compact times are a
**decode / memory** win, not always a wire win. Sorted absolute `Int64`
times compress extremely well (constant high byte-planes, and `end_time` is
a near-copy of a nearby block), so on an all-instantaneous corpus the packed
bytes measured **+3.4%** while uncompressed payload fell 13%. Uncompressed
size is what drives reader allocation and the client memory budget, which is
why the default is on.

Because compact times are on by default, `time-delta` is the first
capability a default build declares — essentially every archive written from
2026-07-26 carries it. See packed spec §3.1 / §5.2.4.

### Per-tile budgets (opt-in)

The project follows a documented "no thinning / comprehensive data by default"
principle. These caps are **inert unless explicitly set**, and when they DO drop
features they log exactly how many per affected tile (never randomly).

| Flag                           | Default | Description                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--maximum-tile-bytes <BYTES>` | —       | Soft cap on a tile's estimated UNCOMPRESSED payload in bytes. When a tile exceeds this, its lowest-importance features are dropped to fit. Unset = no byte cap. tippecanoe analogue: `--maximum-tile-bytes`.                                                                                                                                                     |
| `--maximum-tile-features <N>`  | —       | Hard cap on the number of features per tile. When a tile exceeds this, its lowest-importance features are dropped to fit. Unset = no feature cap. tippecanoe analogue: `--maximum-tile-features`.                                                                                                                                                                |
| `--drop-densest-as-needed`     | off     | When a per-tile budget drops features, prefer to drop from the DENSEST features first (geometry-size density). Only meaningful with `--maximum-tile-bytes`/`--maximum-tile-features`. Without it a budget still drops the LEAST-important features first (a combined geometry+property score) — never randomly. tippecanoe analogue: `--drop-densest-as-needed`. |

### Attribute control (opt-in)

Default = keep every property. System columns (id/time/geometry/vertex_*/triangles)
always survive regardless.

| Flag               | Default | Description                                                                                                                              |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `--exclude <PROP>` | —       | Drop these property columns from output tiles (repeatable). Mutually exclusive with `--include`. tippecanoe analogue: `--exclude`.       |
| `--include <PROP>` | —       | Keep ONLY these property columns (repeatable). Mutually exclusive with `--exclude`. tippecanoe analogue: `--include`.                    |
| `--exclude-all`    | off     | Drop EVERY user property — geometry + times only. Mutually exclusive with `--exclude`/`--include`. tippecanoe analogue: `--exclude-all`. |

### Zoom LOD fields (per-feature)

Whole-feature filtering driven by a per-feature numeric property; geometry and
attributes are untouched.

| Flag                      | Default | Description                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--min-zoom-field <NAME>` | —       | Per-feature numeric property naming the shallowest zoom a feature appears at (road-class-style LOD). A feature is skipped at any zoom below its value — major roads when zoomed out, all streets up close.                                                                                                                                   |
| `--max-zoom-field <NAME>` | —       | Per-feature numeric property naming the DEEPEST zoom a feature appears at (LOD ceiling). A feature is skipped at any zoom above its value. Paired with `--min-zoom-field` it confines a feature to a zoom band `[min_zoom, max_zoom]` — e.g. coarse-zoom clustered/aggregated overviews that must not bleed into full-resolution deep zooms. |

The per-tile budgets and attribute-control flags hook into the in-memory build
path only.

### Trajectory clipping

LineStrings with `--end-time-field` are clipped at tile boundaries with
Liang–Barsky, and per-vertex timestamps are interpolated so each tile's
sub-trajectory animates correctly.

| Flag                      | Default | Description                                                     |
| ------------------------- | ------- | --------------------------------------------------------------- |
| `--no-clip`               | off     | Disable clipping — entire trajectory lives in the centroid tile |
| `--clip-min-vertices <N>` | `2`     | Skip clipping for paths shorter than this                       |

NON-trajectory geometry (polygons, MultiPolygons, timeless
(Multi)LineStrings, MultiPoints) is coverage-clipped unconditionally — it
lands in every tile it spans. The legacy whole-feature-placement kill switch
that opted out of this was removed with the other 0.6.0 deprecation shims;
there is no flag to restore it.

### Simplification

| Flag                      | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--simplify`              | off     | Per-zoom Visvalingam–Whyatt simplification on LineStrings                                                                                                                                                                                                                                                                                                                                                                                        |
| `--simplify-max-zoom <N>` | `14`    | Above this zoom, keep full vertex detail                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--simplify-metric`       | off     | Simplify with a latitude-corrected **metric** tolerance instead of the fixed per-zoom degree table. The longitude axis is scaled by `cos(latitude)` before simplifying, so a given zoom's tolerance means the same GROUND distance at every latitude (a fixed degree tolerance is up to ~2× coarser in E–W terms at 60° than at the equator). Opt-in — without it, builds are byte-identical to before. Takes effect together with `--simplify`. |
| `--time-aware-simplify`   | off     | Use time-aware TD-TR (Synchronized Euclidean Distance) instead of plain spatial Visvalingam — preserves per-vertex timing so zoomed-out playback keeps moving objects in the right place at the right time. Takes effect together with `--simplify`.                                                                                                                                                                                             |

### Polygon pre-tessellation

| Flag               | Default | Description                                                                                                            |
| ------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--pre-tessellate` | off     | Run earcut at build time, store triangle indices in a sidecar column. Renderers skip CPU tessellation on tile arrival. |

### Vertex-time precision

Per-vertex timestamps ride a compact u16-delta encoding whose step is
derived from each tile layer's temporal span. A layer that would need a
step coarser than the ceiling is stored as exact i64 timestamps instead
(larger payload, zero precision loss).

| Flag                           | Default | Description                                                                                                                                                                  |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--vertex-time-precision <MS>` | `1000`  | Ceiling (ms) on the quantization step. The default is below anything playback can show; raise it only to trade precision for payload size on very wide temporal-LOD buckets. |

### Streaming pipelines

| Flag                          | Default | Description                                                                                                                                                            |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--streaming`                 | off     | Write tiles as each zoom level completes, streaming them straight into the `PackWriter` (lower peak RAM, some parallelism lost). Ignored when `--temporal-lod` is set. |
| `-w, --workers <N>`           | `4`     | Parallel worker threads                                                                                                                                                |
| `--min-features-per-tile <N>` | `1`     | Drop tiles below this count. Useful for sparse points — the TS reader's `'best-available'` refinement surfaces dropped features from parents.                          |

`--streaming` is ignored when `--temporal-lod` is set (a warning is logged; the
temporal-LOD pyramid needs the in-memory pipeline), and `--style-hints` is
skipped under it. The per-tile budgets and attribute-control flags likewise
apply to the in-memory build path only. The `--summary-tier`,
`--heatmap-weight`/`--heatmap-class`, and `--metadata-output` passes run over
the loaded features after the raw tier is written, so they compose with
`--streaming`.

### Auto-tuning

| Flag            | Default | Description                                                             |
| --------------- | ------- | ----------------------------------------------------------------------- |
| `--auto [MODE]` | off     | Run `stt-optimize` first and fill in flags you did not pass. See below. |

Bare `--auto` (= `--auto basic`) fills in the zoom range and temporal bucket
only; the analyzer's compression recommendation is not applied, since the packed
format is zstd-only. `--auto encode` additionally applies the advisors' non-lossy
byte-level levers: the zstd level (19, the `--publish` equivalent — the directory
is already paged by default), `--blob-ordering`, and `--pack-size`.

Lossy advice is never auto-applied in either mode. Quantization
(`--quantize-coords`, `--quantize-attrs-auto`) and the per-tile budgets are
logged loudly as `suggested, not applied: <flag> — <why>` for you to opt into.
Semantic levers (`--temporal-lod`, `--adaptive-temporal`, `--summary-tier`,
`--min-zoom-field`) are likewise suggestion-only in both modes. An explicitly
passed flag always wins over any auto value.

### Summary tier (server-aggregated low-zoom tier)

When set, the archive carries one summary tile per `(zoom, x, y, t)` in
addition to the raw tier — readers dispatch between them automatically
from `metadata.summaryTier`. `h3` and `quadbin` are the available schemes.

| Flag                        | Default                       | Description                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--summary-tier <SCHEME>`   | —                             | `h3` (Uber H3 hexes) or `quadbin` (CARTO quadbin)                                                                                                                                                                                             |
| `--summary-min-zoom <N>`    | `min-zoom`                    | Lowest zoom for summary tiles                                                                                                                                                                                                                 |
| `--summary-max-zoom <N>`    | `min(min-zoom + 4, max-zoom)` | Highest zoom for summary tiles                                                                                                                                                                                                                |
| `--summary-columns <SPEC>`  | `""`                          | Comma-separated `name:agg` list, e.g. `magnitude:mean,magnitude:max,depth:sum`. `count` is always implicit.                                                                                                                                   |
| `--summary-layer <NAME>`    | `summary`                     | Layer name carried in summary tile frames                                                                                                                                                                                                     |
| `--summary-sub-buckets <N>` | `1`                           | Sub-buckets PER tile temporal bucket. `>1` adds N `bucket_<i>` count columns per cell (one per `bucket_ms / N` sub-window) so the renderer can animate through them with no data re-upload. Recommended 12–30 for hour buckets; capped at 32. |

### HeatmapLayer build-time domain

When the data ships with property values far outside `[0, 1]` (earthquake
magnitudes, AIS speed), bake a per-class intensity domain into archive
metadata so the renderer doesn't fall back to a runtime GPU readback.

| Flag                      | Default | Description                                                                                         |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `--heatmap-weight <PROP>` | —       | Numeric property driving per-splat weight. The build computes its `[min, 95p]` across all features. |
| `--heatmap-class <PROP>`  | —       | Categorical property whose unique values become per-class entries (up to 8).                        |

### Style hints (build-time render defaults)

| Flag            | Default | Description                                                                                                                                                                                 |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--style-hints` | off     | Profile the loaded features and bake a `style_hints` block into the archive metadata (and therefore `manifest.json`). In-memory pipeline only — skipped with a warning under `--streaming`. |

The block carries, per numeric property, `min`/`p50`/`p90`/`p95`/`p97`/`p99`/`max`
plus a `suggested_domain` of `[min, p97]` with each endpoint rounded **outward**
to 2 significant figures — the p97 clamp bakes in the project's manual
domain-tuning convention (one outlier must not dim the whole ramp). Categorical
(string) properties carry only their distinct-value count (`cardinality`,
capped at 10 000). Two archive-level hints ride along: a
`suggested_playback_seconds` (`clamp(round(sqrt(bucket_count)), 20, 90)`) and a
`layer_hint` (`points`/`paths`/`trips`/`polygons`, from the kinds the build
produced — lines with per-vertex times hint `trips`).

Hints are **defaults**: a renderer or user can always override every one of
them. Values are sampled at a deterministic stride capped at ~250k values per
property (memory guard), so re-builds of the same input emit identical hints.
The block is additive — readers that don't know it are unaffected. Wire shape:
[`manifest.schema.json`](../spec/manifest.schema.json).

### STAC Item (discovery)

| Flag     | Default | Description                                                                                       |
| -------- | ------- | ------------------------------------------------------------------------------------------------- |
| `--stac` | off     | Also write a [STAC](https://stacspec.org/) Item to `<out-dir>/stac.json`, beside `manifest.json`. |

STAC catalogs assets; it does not constrain their format, so an STT dataset
needs no standards negotiation to be discoverable by an existing catalog,
STAC browser or `pystac` reader — they read the Item, then follow the asset
href into the normal reader flow.

Everything is derived from the finished manifest, so the Item is reproducible
from a published dataset and never disagrees with it:

| Item field                                       | Source                                                |
| ------------------------------------------------ | ----------------------------------------------------- |
| `id`                                             | `metadata.name`, falling back to the output dir       |
| `bbox`, `geometry` (closed 5-point polygon ring) | `metadata.bounds`                                     |
| `properties.start_datetime` / `end_datetime`     | `metadata.time_range` (RFC 3339, UTC, ms)             |
| `properties.stt:*`                               | zoom range, tile/feature counts, layers, capabilities |
| `assets.stt.href`                                | `./manifest.json` — **relative**                      |

`properties.datetime` is present and `null` (the STAC encoding for a range
rather than an instant), and `links` is an empty array a publisher fills in
with `self`/`parent` when the Item is placed in a catalog. The asset href is
relative so the Item stays correct wherever the directory is published; STAC
resolves it against the Item's own location.

```bash
stt-build -i earthquakes.parquet -o earthquakes.stt \
  --time-field time --time-format unix-ms \
  --name earthquakes --stac
```

Full profile rationale: [packed-format spec §10.3](../spec/stt-packed-format.md#103-stac-profile).

### Metadata

| Flag                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <STR>`               | Archive name                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--description <STR>`        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--attribution <STR>`        | Attribution text                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--metadata-output <PATH>`   | Also write a sidecar JSON for the showcase config (its `filename` points at `<dir>/manifest.json`)                                                                                                                                                                                                                                                                                                                                                   |
| `--no-manifest-capabilities` | Escape hatch: do NOT declare required-to-understand features in `manifest.capabilities` (restores pre-capabilities manifest bytes for a quantized / elevation-fold build). Only for byte-compat with tooling that predates the capability check — a reader lacking a declared feature then silently misdecodes the re-typed columns instead of refusing at open. Builds using none of those features are unaffected (the key is omitted either way). |
| `-v, --verbose`              | Debug-level tracing                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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
  _Point_ encoding is also readable. Native geoarrow
  `linestring`/`polygon`/`multi*` encodings fail with a re-export hint
  (geopandas: `gdf.to_parquet(..., geometry_encoding='WKB')`).

| Geometry   | Notes                                                                         |
| ---------- | ----------------------------------------------------------------------------- |
| Point      | Events, sensors, vehicle positions                                            |
| LineString | Trajectories, routes; `--end-time-field` enables per-vertex timing + clipping |
| Polygon    | Boundaries; `--pre-tessellate` bakes earcut indices                           |

Multi-geometries are read but **flattened within the feature**, not
exploded: a MultiPoint collapses to a single point at its centroid, a
MultiLineString's vertices are concatenated into one path, and a
MultiPolygon's rings are flattened part-major into one ring list. The ring
offsets alone do **not** keep the parts separable — `geoarrow.polygon` has
no part level, so a generic GeoArrow consumer reads parts 2..n as holes of
part 1. STT recovers the boundary with the additive `part_offsets` column
(payload spec: [`part_offsets`](../architecture/data-format.md#part_offsets-multipolygon-part-boundaries)),
which the builder emits whenever some feature in the layer is multi-part and
which the reference tessellator uses to earcut each part separately. Split
multi-geometries into one row per part before export if you need them
addressable as independent features (distinct ids, properties, picking).

Two optional list columns are recognised when present: `vertex_timestamps`
(`List<Timestamp>` / `List<Int64>`, real per-segment timing for
trajectories) and `vertex_values` (`List<Float32>` / `List<Float64>`, a
per-vertex scalar such as sea-surface temperature), both aligned with the
geometry's vertices.

---

## `stt-generate`

> **Not installable.** `cargo install spatiotemporal-tiles` installs five
> binaries — `stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`,
> `stt-serve` — and **not** `stt-generate`, which is `publish = false` and
> builds only from a repo checkout. It exists to (re)build _this repo's_
> showcase datasets, not as part of the shipped toolchain; nothing else in the
> pipeline depends on it, and it reaches `stt-build` by shelling out to the
> binary. It also sits **outside the root workspace** (at `tools/stt-generate`,
> with its own lockfile — its dep tree carries a higher MSRV than the published
> crates need), so `-p stt-generate` from the repo root does not resolve it.
> Get it with:
>
> ```bash
> git clone https://github.com/BertCh/spatiotemporal-tiles
> cargo install --path tools/stt-generate
> ```

Convenience CLI that fetches the source for each bundled showcase
dataset, normalises it into GeoParquet, and shells out to `stt-build`
(so each output is a packed dataset directory too).

```bash
stt-generate <SUBCOMMAND> [OPTIONS]
```

Subcommands:

| Subcommand        | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `earthquakes`     | USGS API (M4.0+ global, 2020–2024)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ais`             | NOAA Marine Cadastre AIS vessel positions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `flights`         | OpenSky Network ADS-B (Mondays 2017–2020); `--paths` emits LineString trajectories instead of points                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `hurricanes`      | NOAA IBTrACS historical archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `wildfires`       | NIFC perimeters (1000+ acres)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `nyc-rideshare`   | NYC TLC trips + OSRM routing; `--paths` for LineString trajectories, `--flows` for pre-aggregated corridor flows binned to intersection-to-intersection road segments (`--flow-bin` default `15m`), `--od` for one straight 2-vertex origin→destination LineString per trip (no OSRM — the `AnimatedArcLayer`/`AnimatedLineLayer` overview geometry; mutually exclusive with `--paths`/`--flows`); `--with-bearing` adds a per-feature `bearing` numeric column (initial O→D great-circle heading with `--od`, heading toward the next trip point for point trajectories) |
| `bixi`            | Montréal BIXI open-data trips → a directed origin→destination flowmap. Geometry modes and flags: [below](#bixi-flags).                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `gtfs`            | Static GTFS feed → every vehicle journey scheduled on one service date. Flags and conventions: [below](#gtfs-flags).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `nwm`             | NOAA National Water Model retrospective discharge over the CONUS river network. Flags and conventions: [below](#nwm-flags).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `nyc-taxi-points` | derived from `nyc-rideshare` via polyline interpolation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `satellites`      | CelesTrak TLE + SGP4 propagation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `drifters`        | NOAA Global Drifter Program 6-hourly buoy trajectories                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `drifters-hourly` | EXPERIMENTAL: GDP hourly product (`drifter_hourly_qc`) — 6× the temporal resolution (and volume) of `drifters`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `animals`         | GBIF animal-tracking datasets (license-filtered via `--licenses`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `osm-edits`       | OSM editing history — `--source nodes` (first-version node creations from a full-history `.osh.pbf`) or `--source changesets` (bbox-centroids from `changesets-latest.osm.bz2`), scoped to a metro `--bounds`. © OpenStreetMap contributors (ODbL).                                                                                                                                                                                                                                                                                                                       |
| `storms`          | NEXRAD storm-radar tiles for the 2020-08-10 Iowa derecho. Downloads archived Level II volumes from AWS, reprojects/mosaics each ~5-min scan, and bakes **three** packed archives under `--output`: `storm-field` (filled reflectivity contour bands), `storm-cells` (storm-cell centroids), and `storm-tracks` (cells linked across scans into animated trails).                                                                                                                                                                                                          |

Each subcommand has its own flags — run `stt-generate <subcommand> --help`
for the per-dataset options. See the
[Data Generation Guide](../guides/data-generation.md) for end-to-end
recipes.

### `bixi` flags

One 2-vertex origin→destination arc per station pair, carrying a per-bucket count
matrix. `--input` is required: the BIXI `.zip`/`.csv`, or a directory of them.

Per-zoom station clustering is on by default (`--cluster-radius`, or
`--no-cluster` to disable). Four geometry modes are mutually exclusive:

- `--bake-bundling` — bake KDEEB edge bundling into the tile geometry.
- `--streets` — route pairs onto the OSM bicycle network instead of straight
  arcs. Needs `--osm-pbf` and a bicycle-profile `--osrm-url`. `--directional`
  bakes per-segment travel direction into that output.
- `--merged-paths` — synthesize twin-ribbon directed corridors from the same
  bicycle-routed OD pairs.
- `--flow-graph` — build an abstract Sankey-like bundled flow network, with no
  street routing.

### `gtfs` flags

Every trip scheduled on one service `--date YYYYMMDD` becomes a LineString along
its shape, with per-vertex timestamps interpolated in shape-distance between stop
times. No routing server is needed — the feed carries both geometry and
timetable. Render it with `type: 'trip-heads'`.

`--feed <dir>` is the extracted feed. Service-date selection reads weekly
`calendar.txt` when present plus `calendar_dates.txt` exceptions, where
`exception_type=2` removals win. For the bundled NL OVapi feed the busiest
fully-defined date is `20260703`, a Friday, at ~121k trips.

Clock times past `24:00:00` are handled; timestamps are absolute Unix ms anchored
at local midnight in the feed's agency timezone. The GTFS "noon − 12 h" DST rule
is simplified away, which is ±1 h off only for times crossing the 02:00 switch on
the two DST nights a year.

Per-trip fallbacks: an unusable `shape_dist_traveled` falls back to nearest-point
projection onto the shape, and a missing shape to straight stop-to-stop lines.
Dwell is kept as a duplicated stop vertex, and drops are counted per reason.

Properties emitted: numeric `trip_id`; categorical `route_type` as a string label
(`bus`/`rail`/`tram`/`metro`/`ferry`, never the numeric code); `route_short_name`;
`agency_id`; and `trip_headsign` under the opt-in `--headsign`.

Also `--bin` (default `1h`), `--max-trips` (even temporal stride),
`--min-zoom`/`--max-zoom` (default 6–14), and `--skip-build`. `--out` is an alias
of `--output`.

### `nwm` flags

NOAA National Water Model v3.0 retrospective discharge (`chrtout.zarr` on
anonymous S3 — the chunks are bare zstd int32 frames, fetched over plain HTTPS
with the `zstd` crate, no zarr crate) joined to NHDPlusV2 flowlines on
`COMID == feature_id`. Output is the CONUS river network as `vertex_value_matrix`
flow corridors. `--flowlines` names the GeoParquet, default
`data/nwm/nhd-flowlines-order3.parquet`.

`--window YYYY|YYYY-MM` × `--bin 1d|1h` selects the bucket axis; hourly is
month-scoped, and `1d` is a daily mean. `--value` picks what gets baked:

| `--value`               | Bakes                                           | Reads as                                        |
| ----------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `self-scaled` (default) | `round(clamp((log10 q − p2)/(p98 − p2),0,1),2)` | Seasonal variation per reach, not absolute size |
| `log-q`                 | `round(log10(max(q,0.01)),2)`                   | Absolute discharge                              |
| `log-anomaly`           | `round(clamp(log2(q/median2019),0,6),2)`        | Flood anomaly vs the reach's 2019 daily median  |

`log-anomaly` auto-ensures the window year's `1d` reduce for the per-reach
medians; intermittent reaches yield NaN and fall back to the fallback colour.

Within each zoom band (`--zooms`, default `4-8`, with a stream-order ladder of
z≤5 → ≥6, z6–7 → ≥5, z8+ → ≥4 that `--min-order-override` replaces) reaches are
mainstem-merged across runs of constant `(LevelPathI, StreamOrde)` walked along
`DnHydroseq`, resampled to ~2-px vertex spacing, and emitted as a `[z,z]`-banded
copy (`min_zoom` = `max_zoom` = z). Per-zoom copies are required because
`--simplify` cannot touch matrices, so the build runs without simplification.

Chunk downloads cache at `data/nwm/chrtout-cache/` and per-stripe reduced series
at `data/nwm/reduced/`, both resumable skip-if-exists; `--skip-download` fails
instead of fetching. Properties emitted: `order`, and `width` (`2^(order−4)`,
clamped to `[0.5, 16]`).

Also `--detail-zoom` (default 11 — the zoom whose ~2-px spacing the geometry is
resampled to), `--chunk-buckets` (default `0` = auto, ~30 matrix columns per
temporal tile), `--max-reach-stripes` (smoke tests only), and `--skip-build`.
`--out` is an alias of `--output`.

---

## `stt-optimize`

Profiles both sides of a build: `analyze`/`recommend` inspect a GeoParquet
**input** and print recommended `stt-build` flags;
`inspect`/`diff`/`doctor`/`order-audit` open a **built** packed dataset and
report where the bytes went — and, for `doctor`, what to do about it.

### `stt-optimize analyze`

Reads a GeoParquet input and prints an optimization report: the recommended
zoom range and temporal bucket, per-zoom size estimates, and the evidence
behind both. The analyze report includes a measured-encoding
section — a deterministic sample of the input pushed through the real
encoder + zstd — which also calibrates the per-zoom size estimates. Both
reports carry an **Advisor** section: evidence-based suggestions for
`stt-build` flags beyond the zoom/bucket basics (quantization, temporal LOD,
wire layout, per-tile budgets), each with the dataset-specific rationale, a
measured/estimated projection where available, a confidence grade, and a
`[LOSSY - opt-in]` marker on anything that would discard or degrade data.
The JSON report includes the same entries verbatim as an `advice` array.

```bash
stt-optimize analyze --input data.parquet --time-field timestamp \
  --time-format unix-ms

stt-optimize analyze --input data.parquet --format json -o report.json
```

| Flag                      | Description                                   |
| ------------------------- | --------------------------------------------- |
| `-i, --input <PATH>`      | Source GeoParquet file                        |
| `-t, --time-field <NAME>` | Timestamp column (default `timestamp`)        |
| `--time-format <FMT>`     | `iso8601` (default), `unix-sec`, or `unix-ms` |
| `--format <FMT>`          | `text` (default) or `json`                    |
| `-o, --output <FILE>`     | Write the report to a file instead of stdout  |
| `-v, --verbose`           | Debug-level logging for the analysis pass     |

### `stt-optimize recommend`

Emits the same analysis as a JSON `stt-build` config.
`recommend --show-command` prints a copy-pasteable `stt-build` invocation
that bakes in the recommendation, including the **non-lossy** advisor flags
(lossy levers never join the command). The same logic runs inside
`stt-build --auto` (which applies the zoom-range and temporal-bucket
recommendations but not compression — the packed format is zstd-only;
`stt-build --auto encode` additionally applies the non-lossy byte-level
advisor levers — see [Auto-tuning](#auto-tuning)).

```bash
stt-optimize recommend --input data.parquet --time-field timestamp \
  --time-format unix-ms --show-command
```

| Flag                      | Description                                                                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <PATH>`      | Source GeoParquet file                                                                                                                                                                                                                      |
| `-t, --time-field <NAME>` | Timestamp column (default `timestamp`)                                                                                                                                                                                                      |
| `--time-format <FMT>`     | `iso8601` (default), `unix-sec`, or `unix-ms`                                                                                                                                                                                               |
| `-o, --output <FILE>`     | Write the JSON config to a file instead of stdout                                                                                                                                                                                           |
| `--show-command`          | Print a copy-pasteable `stt-build` invocation (non-lossy advisor flags included; lossy levers never join it)                                                                                                                                |
| `--explain`               | Print an evidence table of every advisor suggestion after the config JSON — flag, value, confidence, projected effect, and the dataset-specific why — including lossy levers, marked `[LOSSY - opt-in]` (surfaced only; never auto-applied) |

### `stt-optimize inspect`

Reports on a built packed dataset: per-zoom directory stats (entries,
distinct blobs, blob bytes, time buckets), dedup and compression ratios,
and per-column compressed-cost attribution with encoding notes.

```bash
stt-optimize inspect --archive my-dataset/ --sample 200
stt-optimize inspect --archive my-dataset/ --format json -o inspect.json
```

| Flag                  | Description                                                                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-a, --archive <DIR>` | Packed dataset directory or its `manifest.json` (single and paged directory layouts both work)                                                                                                                        |
| `--sample <N>`        | Decode only a deterministic, evenly-spread sample of at most N tiles (`stt-validate --sample` semantics; `0` skips the decode pass). Directory-derived stats (per-zoom, dedup, wire totals) always cover every entry. |
| `--format <FMT>`      | `text` (default) or `json`                                                                                                                                                                                            |
| `-o, --output <FILE>` | Write the report to a file instead of stdout                                                                                                                                                                          |

### `stt-optimize diff`

Inspects two built tilesets and compares them — totals, per-zoom directory
stats, and per-column costs, each as absolute and percent deltas (rows
present on only one side are flagged). Made for before/after re-encode
comparisons and fleet-reprocess size gates.

```bash
stt-optimize diff --before old-dataset/ --after new-dataset/
stt-optimize diff --before old/ --after new/ --fail-on-growth 5 --format json
```

| Flag                               | Description                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `--before <DIR>` / `--after <DIR>` | The two packed datasets (directory or `manifest.json`)                                                       |
| `--sample <N>`                     | Sample the decode pass on both sides (as `inspect --sample`); the totals and the growth gate stay exact      |
| `--format <FMT>`                   | `text` (default) or `json`                                                                                   |
| `-o, --output <FILE>`              | Write the report to a file instead of stdout                                                                 |
| `--fail-on-growth <PCT>`           | Exit non-zero after printing if `after` total compressed blob bytes exceed `before` by more than PCT percent |

### `stt-optimize doctor`

Lints a built tileset: severity-ranked findings (`CRITICAL` / `WARNING` /
`INFO`), each citing the tileset's **measured** numbers, with the concrete
remediation flag(s) and — where derivable from the measured column costs —
a projected win. The doctor never re-encodes anything; every projection is
labeled as an estimate. An empty report means the tileset passes every rule.

```bash
stt-optimize doctor --archive my-dataset/
stt-optimize doctor --archive my-dataset/ --strict --format json -o doctor.json
```

Rules (stable kebab-case codes, also the JSON `code` field):
`raw-f64-column` (plain Float64 property columns → `--quantize-attr` /
`--quantize-attrs-auto`), `expensive-feature-ids` (near-incompressible
hash-like ids), `dead-columns` (constant/all-null columns → `--exclude`,
one finding per column, sampled evidence), `z0-bomb` (deep shallow pyramid
under tiny bounds → `--min-zoom`), `unpaged-large` (whole-load directory
past 10k entries → repack paged), `oversized-blobs` (tiles past 1 MiB
compressed), and `missing-summary-tier` (huge point dataset with no
aggregated tier → `--summary-tier`).

| Flag                  | Description                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-a, --archive <DIR>` | Packed dataset directory or its `manifest.json`                                                                                                                                                                                    |
| `--sample <N>`        | Sample the inspect decode pass (as `inspect --sample`); directory-derived rules always cover every entry. `--sample 0` skips the inspect decode, which disables the column-cost rules (`raw-f64-column`, `expensive-feature-ids`). |
| `--format <FMT>`      | `text` (default) or `json`                                                                                                                                                                                                         |
| `-o, --output <FILE>` | Write the report to a file instead of stdout                                                                                                                                                                                       |
| `--strict`            | Exit non-zero **after printing** if any Warning-or-worse finding exists — the CI-gate analog of `diff --fail-on-growth`. Info findings never trip it.                                                                              |

### `stt-optimize export`

Exports a built tileset back out as GeoParquet — the whole archive, or a
bbox / time-range subset. One export is always ONE zoom level: the same
feature is re-tiled at every level with a different simplification tolerance,
so mixing levels would emit the same feature several times at several
fidelities.

```bash
stt-optimize export --archive my-dataset/ -o my-dataset.parquet
stt-optimize export --archive my-dataset/ -o nyc.parquet \
  --bbox -74.3,40.4,-73.6,41.0 --start 2024-01-01T00:00:00Z --zoom 12
```

| Flag                           | Description                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-a, --archive <DIR>`          | Packed dataset directory or its `manifest.json`                                                                                                                         |
| `-o, --output <FILE>`          | Output `.parquet` path. With several layers and no `--layer`, this is the stem: each layer lands in `<stem>.<layer>.parquet`.                                           |
| `--zoom <Z>`                   | Zoom level to export (default: the deepest one present)                                                                                                                 |
| `--layer <NAME>`               | Layer to export (default: every layer, one file each)                                                                                                                   |
| `--bbox <MINX,MINY,MAXX,MAXY>` | Keep only features intersecting this box                                                                                                                                |
| `--start <TIME>`               | Keep only features whose time span reaches this instant or later (ISO-8601 or Unix ms)                                                                                  |
| `--end <TIME>`                 | Keep only features whose time span starts at this instant or earlier (ISO-8601 or Unix ms)                                                                              |
| `--geometry-encoding <ENC>`    | Geometry column typing: `wkb` (default, GeoParquet 1.1 — what every deployed reader understands) or `native` (adds Parquet's `GEOMETRY` logical type on the same bytes) |
| `--format <FMT>`               | Run report: `text` (default) or `json`                                                                                                                                  |

### `stt-optimize order-audit`

Audits a built tileset's **blob ordering**: over the native-tier directory (no
payload decode), it simulates the two canonical access patterns — scrub a
viewport across all time, pan one instant across space — under the reader's
range coalescing, and ranks the four orderings by a blended cost
(`bytes_read + reads × gap`, so request count and over-read are both priced).
It prints the per-ordering cost table, the measured recommendation, what `auto`
would pick, and the archive's currently-recorded `manifest.blobOrdering`. It
never re-sorts anything — rebuild with `--blob-ordering measured` to adopt the
recommendation. `morton3` is shown for comparison but never recommended.

```bash
stt-optimize order-audit --archive my-dataset/
stt-optimize order-audit --archive my-dataset/ --strict --format json -o order.json
```

| Flag                  | Description                                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-a, --archive <DIR>` | Packed dataset directory or its `manifest.json`                                                                                                     |
| `--format <FMT>`      | `text` (default) or `json`                                                                                                                          |
| `-o, --output <FILE>` | Write the report to a file instead of stdout                                                                                                        |
| `--strict`            | Exit non-zero if the archive's recorded ordering isn't the measured recommendation. Archives with no recorded ordering (pre-2026-07) warn and pass. |

---

## `stt-validate`

Validates an STT dataset in the **packed format** — pass the dataset
directory, its `manifest.json`, or a single-file `.sttb` bundle (the
integrity tier then verifies each in-bundle object's blake3 against its key
exactly like the exploded case). (The single-file `.stt` container has been
removed; only the packed format is accepted.)

```bash
stt-validate my-dataset/ [--json] [--fail-fast] [--skip-decode]
stt-validate my-dataset/manifest.json
stt-validate my-dataset.sttb
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
7. Every feature's interval is sane (`end_time >= start_time`); violations are counted across the decoded tiles and the first offender named.
8. Each tile entry's directory `time_end` is **tight** — it equals the max feature `end_time` across the tile's layers. Readers prune interval queries on `time_end`, so a nominal bucket end silently hides interval features.
9. When the metadata declares a **summary tier**, every summary-layer `id` is a valid H3/Quadbin cell index at the tier's resolution for the tile's zoom (a sequential `id` column — the blank-render bug — fails).
10. Metadata totals (`tile_count`/`feature_count`) match the directory-derived totals; zeroed totals from pre-0.1.1 writers warn instead of failing.

| Flag            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--json`        | Machine-readable report (suitable for CI)                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--fail-fast`   | Exit on the first failure                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--skip-decode` | Skip the per-tile decode step — only header/integrity, index, and content-hash checks                                                                                                                                                                                                                                                                                                                                                                   |
| `--sample <N>`  | Decode only a deterministic, evenly-spread sample of at most N tiles instead of every tile. The integrity / header / content-hash / temporal-bound checks still run over ALL tiles (they're cheap); only the expensive Arrow-decode + schema + feature-count checks are sampled. The sample is reproducible (every `ceil(total/N)`-th entry), and the report makes clear the decode was sampled rather than exhaustive. Useful for very large archives. |

Exits non-zero on any failure. Suitable for CI gating any dataset that
ships with the project.

---

## `stt-bundle`

Packs an exploded packed dataset (its `manifest.json` + content-addressed
objects) into **one `.sttb` file** for interchange — the "download one file"
property the packed layout gave up — and unpacks it back. Objects round-trip
**byte-identical**: they are content-addressed, `pack` re-hashes every one on
the way in, and `unpack` re-verifies the result with the same integrity pass
`stt-validate` runs (any mismatch exits non-zero). Bundling is deterministic:
the same dataset packs to byte-identical bundle bytes.

Strictly an interchange profile (spec §13, non-normative draft): the
CDN/serving story remains the exploded layout — nothing serves bundles over
HTTP ranges. The container is object-agnostic (keys and bytes are opaque),
so it carries any manifest `formatVersion` unchanged.

```bash
stt-bundle pack my-dataset/ -o my-dataset.sttb    # dir or manifest.json
stt-bundle unpack my-dataset.sttb -o my-dataset/
stt-validate my-dataset.sttb                      # bundles validate directly
```

| Flag                  | Description                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `-o, --output <PATH>` | `pack`: the output `.sttb` path. `unpack`: the output dataset directory (created if missing). |

Container shape: 8-byte magic (`"STTB"`, version 1, three zero bytes), a
little-endian `u32` header length, a JSON header
`{ "manifest": <verbatim manifest.json>, "objects": [ { "key", "offset",
"length" } ] }`, then the objects back-to-back at 8-byte-aligned offsets in
manifest order (directory first, then packs in `pack_id` order). See the
[packed-format spec §13](../spec/stt-packed-format.md#13-bundle-profile-sttb--interchange-non-normative-draft)
for the full layout.

---

## `stt-serve`

Optional binary (feature-gated in the `spatiotemporal-tiles` crate) that
generates STT tiles **on the fly** from a live PostGIS or DuckDB source — the
`ST_AsMVT` analog for the STT format, with no pre-bake. It shares `stt-build`'s
per-tile encoder, so a served tile is byte-identical to the offline-built tile
for the same `(z,x,y,t)` and source rows. The default build already ships the
PostGIS backend; opt into the embedded-DuckDB backend with a feature:

```bash
# Default install already includes the PostGIS serve backend:
cargo build --release -p spatiotemporal-tiles
# Add the embedded-DuckDB backend (heavy bundled C++ compile); `--features serve` enables both:
cargo build --release -p spatiotemporal-tiles --features serve-duckdb

# PostGIS backend:
stt-serve --postgres "$PGURL" --table hurricane_obs --geom-column geom \
          --time-field iso_time --temporal-bucket 7d --min-zoom 3 --max-zoom 8

# DuckDB backend (no database server needed — point at a .duckdb file):
stt-serve --duckdb hurricane.duckdb --table hurricane_obs --geom-column geom \
          --time-field iso_time --temporal-bucket 7d
```

Endpoints: `GET /tiles/{z}/{x}/{y}/{t}.stt` (a below-threshold tile returns `204
No Content`), `GET /metadata.json`, `GET /health`; with `--config`, each dataset
is served under `GET /{name}/tiles/{z}/{x}/{y}/{t}.stt` /
`GET /{name}/metadata.json` plus a `GET /datasets` catalog, and each dataset's
metadata advertises its own prefixed `tileUrlTemplate`
(`/{name}/tiles/{z}/{x}/{y}/{t}.stt`) so a client can point a tileset at it
unchanged. Full HTTP semantics:
[the `stt-serve` protocol spec](../spec/stt-serve-protocol.md).

| Flag                                              | Default          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--postgres <CONN>`                               | —                | PostGIS backend (deadpool pool, NoTls). Env fallback: `STT_POSTGRES_URL` / `DATABASE_URL`. Mutually exclusive with `--duckdb`.                                                                                                                                                                                                                                                                                                                                                                     |
| `--duckdb <PATH>`                                 | —                | DuckDB backend (r2d2 pool; read-only file, or `:memory:` for external-file `--sql` scans). Env fallback: `STT_DUCKDB_PATH`. Mutually exclusive with `--postgres`.                                                                                                                                                                                                                                                                                                                                  |
| `--table <NAME>` / `--sql <SELECT>`               | —                | Source table or arbitrary `SELECT` (provide exactly one). A `--sql` source must expose `--geom-column` and `--time-field`.                                                                                                                                                                                                                                                                                                                                                                         |
| `--geom-column <NAME>`                            | `geom`           | Geometry column (EPSG:4326 lon/lat, unless `--source-srid` says otherwise).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--source-srid <SRID>`                            | —                | SRID of the stored geometry when it is NOT 4326: every per-tile query reprojects it to 4326 before filtering and encoding (the exact `stt-build --source-srid` ingest expressions), and the startup metadata extent is reprojected too. Costs a per-row transform that bypasses a plain spatial index — store 4326 for the fast path.                                                                                                                                                              |
| `--time-field <NAME>`                             | `timestamp`      | Timestamp column (timestamp/timestamptz, or an integer column read per `--time-format`).                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--end-time-field <NAME>` / `--time-format <FMT>` | — / `iso8601`    | Optional end-time column; wire format of an integer time column (matches `stt-build`).                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--min-zoom <N>` / `--max-zoom <N>`               | `0` / `14`       | Zoom range advertised in `/metadata.json` and within which LOD levels apply.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--temporal-bucket <DUR>`                         | `1h`             | Base bucket size — must match how clients address tiles in time.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--temporal-lod <SPEC>`                           | —                | Coarser-bucket pyramid (e.g. `1d,30d` or `1d@8,30d@4`); at an applicable zoom the server widens to that level's bucket (coarsest wins).                                                                                                                                                                                                                                                                                                                                                            |
| `--layer <NAME>`                                  | `default`        | Layer name embedded in each tile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--config <PATH>`                                 | —                | Multi-dataset mode: JSON file `{ "datasets": [ {…}, … ] }` where each entry carries the same fields as these flags (kebab-case; unknown keys rejected). Each dataset serves under `/{name}/…`.                                                                                                                                                                                                                                                                                                     |
| `--name <NAME>`                                   | derived          | Dataset name — the `/{name}/…` URL segment and the metadata `name` in `--config` mode. Single-dataset mode derives it from the table/query and serves at the root.                                                                                                                                                                                                                                                                                                                                 |
| `--pool-size <N>`                                 | `8`              | Connection-pool size for whichever backend is active — `max_size` on the deadpool pool for `--postgres`, or the r2d2 pool for `--duckdb`.                                                                                                                                                                                                                                                                                                                                                          |
| `--heatmap-weight <PROP>`                         | —                | Numeric property driving `HeatmapLayer` weight. Its `[min, 95th percentile]` (per `--heatmap-class` if set) is computed ONCE at startup via a SQL aggregate over the whole source and advertised as `heatmapDomain` in `/metadata.json` — matches `stt-build --heatmap-weight`.                                                                                                                                                                                                                    |
| `--heatmap-class <PROP>`                          | —                | Categorical property whose distinct values become per-class `heatmapDomain` entries (capped at 8). Matches `stt-build --heatmap-class`.                                                                                                                                                                                                                                                                                                                                                            |
| `--bind <ADDR>`                                   | `127.0.0.1:8088` | Listen address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--compact-times`                                 | off              | Emit the compact time columns (`TILE_META.st`/`.et`) instead of the historical absolute `Int64` pair — the inverse default of `stt-build`, whose `--no-compact-times` is the kill switch. Opt-in here because a served tile carries no manifest, so a client that predates the `time-delta` capability cannot refuse it and would silently misdecode; `/metadata.json` advertises `capabilities` for clients that do check. Turning it on restores byte parity with a default `stt-build` archive. |

`stt-serve` also accepts the full offline **per-tile** flag surface
(`--simplify`/`--simplify-max-zoom`/`--simplify-metric`/`--time-aware-simplify`, `--pre-tessellate`,
`--no-clip`/`--clip-min-vertices`,
`--min-zoom-field`/`--max-zoom-field`, the
per-tile budgets `--maximum-tile-bytes`/`--maximum-tile-features`/
`--drop-densest-as-needed`, `--exclude`/`--include`/`--exclude-all`,
`--min-features-per-tile`) and the **encoder** flags (`--quantize-coords`,
`--quantize-attr`, `--quantize-attrs-auto`, `--vector-group`,
`--point-elevation-column`, `--vertex-time-precision`) — resolved identically to
the offline build via the shared `build_options` module, into an explicit
per-dataset encoder config (never process-wide state, so two datasets served
from one process cannot inherit each other's settings). `--summary-tier` and
`--adaptive-temporal` are **not** servable per single-tile request (rejected at
startup — pre-bake them with `stt-build`).

`stt-serve` **inverts the `stt-build` default for compact times**: they are
opt-in here via `--compact-times`, so an out-of-the-box served tile matches an
offline `--no-compact-times` build. The asymmetry is deliberate. A packed
archive carries `manifest.capabilities`, so a reader that predates a
required-to-understand re-typing refuses the dataset loudly at open; a served
tile has no manifest, and the serve protocol grew no version channel, so the
same reader would silently misdecode every tile's times. `/metadata.json` now
advertises a `capabilities` array derived from the server's actual encoder
settings, which gives a current client a way to check — but an already-shipped
client does not read it, and the format's stated worst failure mode is silent
garbage, so the safe shape is the default. `--quantize-vertex-values` has no
serve twin at all (it is off by default on both sides).

Served tiles are self-contained `formatVersion` 2 frames — every layer inlines
its own schema, since a live server has no manifest to carry a `schemas`
registry — advertised as `formatVersion` on `/metadata.json`.

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

Others (`packed-stats`, `point_column_stats`,
`encoding-experiment`, …) are analysis/benchmark aids — see
`crates/stt-core/examples/README.md`.
