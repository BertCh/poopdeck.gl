# Database input adaptors for STT (PostGIS + DuckDB)

*Decision record. PostGIS and DuckDB are first-class **input sources** for
`stt-build` (complements to the GeoParquet file path) and the two backends of
`stt-serve`, a dynamic tile server that generates one STT tile per request — the
`ST_AsMVT` analog for the STT format.*

**Status.** The base of this work (both DB readers, the `stt-serve` binary, the
IBTrACS benchmarks) shipped in commit **`17789f7`**. The **full generation-parity
layer** — the shared `build_options.rs`, `encode_single_tile_counted`, the
per-vertex column bridge, and the cross-source parity suite — is **uncommitted on
branch `feat/db-parity-comprehensive`** as of this writing. Open follow-ups live
in [data-sources-and-encoder.md](./data-sources-and-encoder.md), not here.

Merges the former `postgis-integration.md` + `duckdb-integration.md`. Pairs with
[data-sources-and-encoder.md](./data-sources-and-encoder.md) (the roadmap/learnings)
and [preprocessing-framework.md](./preprocessing-framework.md).

---

## 1. Why

A great deal of spatiotemporal data already lives in a database, and the
analytics ecosystem expects a "point your database at a tiler" workflow
(pg_tileserv, Martin, `ST_AsMVT`; DuckDB's in-process `spatial` scan of
Parquet/CSV/GeoJSON/Shapefile). Before this, the only way into STT was a
GeoParquet file. Two capabilities were added for **each** engine:

1. **Ingest** — `stt-build` reads features directly from a DB query and builds the
   identical packed archive it would from a file. No export step.
2. **Dynamic serve** — `stt-serve` answers `GET /tiles/{z}/{x}/{y}/{t}.stt` by
   querying the DB per request and encoding one STT tile, with no pre-bake.

The two engines cover complementary needs: **PostGIS** is the live, mutating,
server-backed table; **DuckDB** is in-process with no server — point it straight
at a `.duckdb` file, or scan a Parquet/CSV with `:memory:` and no table at all.

## 2. Architecture

```
INGEST   DB ──WKB (ST_AsEWKB / ST_AsWKB)──▶ ParsedFeature ──▶ existing tiler ──▶ packed archive
SERVE    GET /tiles/{z}/{x}/{y}/{t}.stt ──bbox+time query──▶ encode_single_tile ──▶ Arrow-IPC tile blob
```

The whole thing slots into the existing pipeline because both the tiler and the
per-tile encoder already consume **`ParsedFeature`** and are agnostic to where the
features came from. Three properties make it a small change:

- **`ParsedFeature` is the source-agnostic seam.** A new adaptor is "produce the
  same struct" and nothing downstream changes.
- **WKB is the geometry bridge.** PostGIS `ST_AsEWKB(geom)` and DuckDB
  `ST_AsWKB(geom)` both emit WKB that `stt-build`'s existing `parse_wkb_geometry`
  (`geozero`) already decodes — no new geometry code. (GeoArrow-native input
  encodings are still rejected; WKB is the ingest lingua franca.)
- **`encode_single_tile_counted` is the shared per-tile core.** The offline build
  and every per-request serve call the *same* `build_tile`/`encode_tile` path
  (factored out in `tiler.rs`), so a served tile is **byte-for-byte** what the
  offline build would emit for that `(z,x,y,t)` and the same source rows. It
  returns the placed-feature count so serve can honour `--min-features-per-tile`
  (a below-threshold tile is `204 No Content`).

Both readers live in `stt-build` behind an off-by-default cargo feature
(`postgres` / `duckdb`) so default builds pull no DB driver. Both drivers are
self-contained: `postgres` is pure-Rust; the `duckdb` engine is **statically
bundled** (no system lib). `stt-serve` runs the whole per-request path on a
`spawn_blocking` worker.

### CLI (shape only — full flags in [../api/cli-reference.md](../api/cli-reference.md))

```bash
# Ingest: from PostGIS (--features postgres), a DuckDB file, or a direct
# Parquet scan via an in-memory DuckDB (--features duckdb):
stt-build --postgres "$PGURL" --table hurricane_obs --geom-column geom \
          --time-field iso_time --where "iso_time >= '1970-01-01'" -o out.stt
stt-build --duckdb :memory: \
          --sql "SELECT ST_Point(lon,lat) AS geom, ts, mag
                 FROM read_parquet('quakes.parquet')" \
          --geom-column geom --time-field ts -o out.stt

# Dynamic tile server — pick a backend with --postgres or --duckdb:
stt-serve --duckdb hurricane.duckdb --table hurricane_obs --geom-column geom \
          --time-field iso_time --temporal-bucket 7d --min-zoom 3 --max-zoom 8
#   GET /tiles/{z}/{x}/{y}/{t}.stt   GET /metadata.json   GET /health
```

`--postgres`/`--duckdb` are mutually exclusive with each other and with `--input`
(which becomes optional). Connections may also come from `STT_POSTGRES_URL` /
`DATABASE_URL` / `STT_DUCKDB_PATH`.

## 3. Serve parity with the offline build

`encode_single_tile_counted` shares the exact `build_tile`/`encode_tile` path the
offline build uses, so `stt-serve` exposes the **full generation surface** —
byte-identical to the offline-built tile for the same source rows. The complete
per-tile flag list (`--simplify`, `--pre-tessellate`, clip/zoom-field flags, the
per-tile budgets, `--exclude`/`--include`), the encoder-global flags
(`--quantize-*`, `--vector-group`, `--point-elevation-column`,
`--vertex-time-precision`), `--table`/`--sql`, and `--temporal-lod` are in
[../api/cli-reference.md](../api/cli-reference.md). Two serve-only notes:

- **Temporal LOD** is advertised in `/metadata.json` as `temporal_lod`.
- **Heatmap domain** — `--heatmap-weight`/`--heatmap-class` are computed once at
  startup via a SQL aggregate and advertised as `heatmap_domain` (the DB's
  continuous percentile — a style hint that may differ marginally from the
  offline floor-index percentile).

The CLI and the server build these from the **same flag strings** via the shared
`stt_build::build_options` module (parsers + `EncoderSettings` +
budget/attribute-filter builders) — one source of truth, no drift. `stt-serve`
logs its active parity-affecting config at startup so an operator can confirm it.

**Not servable per single-tile request** (rejected at startup with a clear
error): `--summary-tier` (cross-tile H3/quadbin aggregation) and
`--adaptive-temporal` (windows sized across a cell's whole time range) — pre-bake
these and serve the static archive. Non-4326 source geometry is served via
`stt-serve --source-srid` (per-tile `ST_Transform` before the bbox filter,
mirroring the ingest expressions) — correct but index-bypassing; store 4326 (or
add a PostGIS functional index on the transform) for the fast path.

`stt-serve` also **pins property kinds from the source's result schema at
startup** (DuckDB: `LIMIT 0` probe; PostGIS: statement prepare) — the same
schema-pinning an offline build derives from the Parquet schema (and, since the
same probe was threaded into `stt-build`'s DB sources, from the DB result schema
there too), so an all-NULL-within-one-tile column no longer drifts the layer
schema on any path.

## 4. Cross-source parity testing

`crates/stt-build/tests/source_parity.rs` (+ `tests/common/mod.rs`) proves
**file ≡ DuckDB ≡ PostgreSQL** produce the same `ParsedFeature` stream and the
same per-tile archive from one logical fixture spanning points, LineStrings,
per-vertex `vertex_timestamps`/`vertex_values` (incl. a NULL element), every
common property type, a NaN float, and a null geometry. Comparison is
order-independent and robust to the project's non-deterministic-encoding caveats:
exact `ParsedFeature` equality after a stable sort, plus the per-tile
`(zoom,x,y,t_start,t_end,feature_count)` key-set. Raw bytes / compressed size are
not compared.

DuckDB is statically bundled, so `file ≡ DuckDB` runs in **CI with no service and
no spatial extension** — the fixture parquet is read back through core
`read_parquet` and the WKB geometry rides as a `BLOB` column:

```bash
cargo test -p stt-build --features duckdb
```

PostgreSQL parity needs a live server, so it is `#[ignore]`d behind a DSN env var:

```bash
STT_TEST_PG_DSN=postgresql://postgres:postgres@localhost:5432/stt \
  cargo test -p stt-build --features duckdb,postgres -- --ignored
```

## 5. Consistency notes

Shared across both DB readers (and the GeoParquet file reader):

- **Property columns** map by source type (int/float/bool/text/timestamp/…). The
  time column → unix-ms (timestamp/timestamptz directly; `DATE` at midnight UTC;
  integer columns honour `--time-format`; text parsed as ISO-8601).
- **Geometry-component names** (`lon`/`lat`/`x`/`y`/…) are excluded from
  properties (case-sensitive lowercase match, shared `is_coordinate_column_name`),
  so tiles never carry coordinates twice.
- **Per-vertex columns are bridged.** Columns named `vertex_timestamps`,
  `vertex_values`, or `vertex_value_matrix` populate the matching `ParsedFeature`
  fields (shared `is_vertex_metadata_column` / `VERTEX_METADATA_COLUMNS`), so
  LineString trajectories, per-vertex scalar coloring, and animated
  static-geometry overviews all ingest and serve at full fidelity. Integer
  vertex-timestamp arrays are raw ms (never reinterpreted via `--time-format`); a
  NULL list element → `0` (timestamps) / `NaN` (values); a negative vertex
  timestamp is a hard error (unsigned-epoch guard). These columns are excluded
  from the property set.
- A **NaN/Inf float property** becomes JSON `null` with the key retained
  (`serde_json::json!(nan) == null`).
- STT stores **unsigned** epoch-ms, so pre-1970 timestamps are rejected (shared
  guard) — filter them in `--where`/`--sql`.

The two DB readers are intentional **supersets** of the file reader on a few
type shapes that have no GeoParquet-Float64 equivalent, so they only ever *add*
properties a file build couldn't carry — never diverge on the same logical data.

### PostGIS-specific

- Column types are resolved **up front** from the PG type
  (`int2`/`int4`/`int8`/float/`numeric`/bool/text/`timestamp[tz]`/`date`/
  `json`/`jsonb`). `int2`, `numeric` (→ nearest-f64 via the decimal conversion
  shared with DuckDB), `timestamp`/`timestamptz`/`date`-as-integer-ms, and
  `json`/`jsonb` as nested JSON are the additive superset over the file reader.
- Geometry bridges via `ST_AsEWKB` (SRID-prefixed EWKB), decoded by the same
  `parse_wkb_geometry`.
- Streaming uses a server-side `DECLARE … CURSOR` + `FETCH` loop, so memory is
  bounded regardless of result size. Per-vertex array columns map from
  `int8[]`/`int4[]`/`timestamp[]`/`timestamptz[]`/`date[]` (timestamps) and
  `float8[]`/`float4[]` (values).
- The reader is **NoTls** today (localhost / trusted-network).

### DuckDB-specific

- Rows decode from DuckDB's **self-describing `ValueRef`** (one tagged value per
  cell), so — unlike PostGIS's up-front schema resolution — no per-type
  introspection is needed. SQL `NULL` is `ValueRef::Null`; `DECIMAL` maps to a
  nearest-f64 number (via the one decimal conversion shared with the PostGIS
  `numeric` arm, so identical values agree across engines); unmappable types
  (raw `GEOMETRY`, intervals, nested types) decode to `None` and are dropped
  per row. Per-vertex arrays arrive as `Value::List`.
- The **spatial extension** is a separate downloadable extension (not bundled,
  not auto-loadable). The reader runs `INSTALL spatial; LOAD spatial;` on connect
  (a one-time network fetch cached under `~/.duckdb`) and pins the session to
  **UTC**.
- **No `ST_SetSRID`.** DuckDB `GEOMETRY` carries no per-row SRID, so reprojection
  passes the source CRS explicitly:
  `ST_Transform(geom, 'EPSG:<srid>', 'EPSG:4326', always_xy => true)` (the
  `always_xy` flag keeps 4326 output as lon/lat rather than authority lat/lon).
- **Read-only file access.** A real `.duckdb` file opens read-only (never mutates
  the user's data; works against a file another process holds). `:memory:` opens a
  fresh in-memory database for external file scans via `--sql`.
- The serve backend uses an `r2d2` connection pool (DuckDB `Connection` is `Send`
  but `!Sync`).
- A `NULL`/unparseable `--end-time-field` value yields `end_timestamp = None` (the
  file reader coerces to `Some(0)` in `--warn` mode); keep end-times non-null for
  strict parity.

## 6. Benchmark (IBTrACS hurricanes)

Source in both cases = NOAA IBTrACS best-track observations (Point/4326):
126,970 total, benchmark slice = the 48,538 post-1970 observations, z0–8, 7-day
buckets. The GeoParquet baseline is exported from the same DB query, so each A/B
compares an **identical column set**. Reproduce via `scripts/postgis/*`
(PostGIS 16/3.4 in Colima on Apple Silicon) and `scripts/duckdb/*`
(DuckDB 1.5.4, statically bundled).

### 6.1 Ingest vs the file path (logically identical tiles)

| metric | GeoParquet file | PostGIS | DuckDB |
|---|---|---|---|
| tile_count | 60,521 | 60,521 ✅ | 60,521 ✅ |
| feature instances (across tiles) | 436,842 | 436,842 ✅ | 436,842 ✅ |
| spatial bounds / time range / bucket | — | identical ✅ | identical ✅ |
| payload bytes (zstd) | ~67.0 MB | Δ **0.10%** | Δ **0.00%** |
| **wall-clock (best of 3)** | 4.36 s / 7.60 s¹ | **4.29 s (0.98×)** | **5.05 s (0.66×)** |

¹ PostGIS and DuckDB were benchmarked in separate runs against their own
identically-columned file baseline (4.36 s and 7.60 s respectively). Both DB
paths produce **logically identical tiles** (same count, same feature set, same
bounds) and are **as fast as or faster than** the file path — the cursor/columnar
stream overlaps with tiling while the file path pays Parquet decode up front. The
sub-0.1% byte difference is only within-tile feature order (a `SELECT … ORDER BY`
closes even that).

### 6.2 Serve: dynamic vs pre-baked static (conc 16, avg tile 5.7 KB)

| server | p50 | p95 | p99 | throughput | server-side gen p50 |
|---|---|---|---|---|---|
| **Dynamic PostGIS** (warm) | **2.0–3.0 ms** | 2.7–4.5 ms | 5–14 ms | **5k–7k req/s** | **1.9–2.8 ms** |
| **Dynamic DuckDB** (warm) | **7.7 ms** | 29.8 ms | 87 ms | **~1,380 req/s** | **5.4 ms** |
| Static pre-baked files¹ | 1.1–2.7 ms | 2.0–8.5 ms | *(≈100–200 ms¹)* | ~1.9k–4k req/s¹ | — |

¹ The static baseline is Python's `http.server` (a stand-in for "tile already on
disk"); its p99 spikes and throughput cap are the test server's GIL, **not** a
real CDN. Treat the static p50 (a raw file read) as the fair comparison.
"server-side gen" is the backend-agnostic `x-stt-gen-micros` header. Correctness
was cross-checked (a served tile's feature count equals an independent DB
`COUNT(*)` over the same bbox + bucket; the DuckDB run served 2,001/2,001 tiles
non-empty).

**Reading it:** generating a full STT tile live — bbox+time query → row/`ValueRef`
decode → GeoArrow/Arrow-IPC encode → zstd — costs **~2 ms (PostGIS) / ~5 ms
(DuckDB)** of pure compute at over a thousand tiles/sec on one laptop core-set.

### 6.3 When to use which

- **Pre-bake (`stt-build` → packed archive on R2/S3/CDN)** stays the default for
  published, read-many datasets: immutable, content-addressed, **edge-cacheable**,
  zero origin compute. DB-as-source just removes the export step (and, with
  DuckDB, lets you tile a Parquet/CSV directly with no intermediate).
- **Dynamic (`stt-serve`)** fits live / frequently-mutating tables (PostGIS) and
  ad-hoc exploration of local files (DuckDB, no server to stand up) where a
  pre-bake would be stale or wasteful. The trade-off is that it is **not**
  edge-cacheable (every tile is origin compute); a reverse-proxy cache in front
  recovers most of that for hot tiles.

## 7. What's here

| Path | What |
|---|---|
| `crates/stt-build/src/postgres_input.rs` | PostGIS reader (feature `postgres`): streaming cursor, row→`ParsedFeature`, `build_tile_query`/`decode_rows` for the server |
| `crates/stt-build/src/duckdb_input.rs` | DuckDB reader (feature `duckdb`): streaming `ValueRef` decode, `build_tile_query`/`build_metadata_query`/`decode_query` for the server |
| `crates/stt-build/src/build_options.rs` | Shared flag→config parsing (`EncoderSettings`, duration/LOD/quantize/vector-group parsers, budget + attribute-filter builders) used by BOTH the CLI and `stt-serve` — one source of truth |
| `crates/stt-build/src/tiler.rs` `encode_single_tile_counted` | The reusable single-tile encoder (shared build_tile/encode_tile path; returns the placed-feature count) |
| `crates/stt-serve` | axum dynamic tile server; PostGIS (deadpool) + DuckDB (`--duckdb`, r2d2) backends with full generation parity |
| `crates/stt-build/tests/source_parity.rs` + `tests/common/mod.rs` | file ≡ DuckDB ≡ PostgreSQL parity suite (DuckDB in CI; Postgres gated on `STT_TEST_PG_DSN`) |
| `crates/stt-build/examples/duckdb_load_ibtracs.rs` | build the benchmark `hurricane.duckdb` + baseline Parquet from IBTrACS CSV (bundled engine) |
| `scripts/postgis/*`, `scripts/duckdb/*` | setup / load / bench-ingest / bench-serve (DuckDB reuses the backend-agnostic PostGIS serve helpers) |

## 8. Follow-ups

The DB-path/encoder backlog is owned in one place —
**[data-sources-and-encoder.md](./data-sources-and-encoder.md) §4** — and was
fully triaged 2026-07-01. For orientation (statuses live there, not here):
`EncoderConfig` threading, multi-dataset serve, the integer-epoch serve-filter,
and dropped-data accounting (DB readers **and** now the file reader) are
**SHIPPED**; the packed-manifest facade, TLS, in-process LRU, whole-dataset
`--streaming-arrow` passes, and retiring the offline globals are **counted out**
with recorded revival triggers; the byte-determinism guard is resolved-by-path
(workspace arrow upgrade to ≥59, whose `metadata_to_fb` sorts metadata keys).

DuckDB-specific ideas floated in earlier drafts but never scheduled —
`stream_arrow` batch ingest (blocked on the same arrow-version split the upgrade
fixes), shared-in-memory serve, RTREE index probing — are hereby **counted
out**: the row API measured *faster* than the file baseline (0.66×), so no
performance debt forces them. Revisit `stream_arrow` opportunistically after the
arrow upgrade.
