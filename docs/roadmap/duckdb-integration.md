# DuckDB integration for STT

*Implemented 2026-06-23. DuckDB becomes a first-class **input source** for
`stt-build` (a complement to the GeoParquet file and PostGIS paths), and a
second **backend** for the `stt-serve` dynamic tile server — the in-process,
no-server sibling of the [PostGIS integration](./postgis-integration.md).*

---

## 1. Why

DuckDB is the analytics-native columnar engine, and a great deal of
spatiotemporal data already lives in DuckDB databases — or in Parquet / CSV /
GeoJSON / Shapefiles that DuckDB's `spatial` extension can scan **in process,
with no server to run**. Before this, the file path needed a separate export
step (`COPY … TO 'x.parquet'`) and the live path needed PostgreSQL. Two
capabilities were added, mirroring the PostGIS work:

1. **Ingest** — `stt-build` reads features directly from a DuckDB query and
   builds the identical packed archive it would from a file. No export step.
2. **Dynamic serve** — `stt-serve --duckdb …` answers
   `GET /tiles/{z}/{x}/{y}/{t}.stt` by querying DuckDB per request, with no
   pre-bake and no database server.

Both slot into the existing pipeline because the tiler and the per-tile encoder
already consume `ParsedFeature` and are agnostic to where the features came from.

## 2. Architecture

```
INGEST   DuckDB ──ST_AsWKB, ValueRef──▶ ParsedFeature ──▶ existing tiler ──▶ packed archive
SERVE    GET /tiles/{z}/{x}/{y}/{t}.stt ──bbox+time query──▶ encode_single_tile ──▶ Arrow-IPC tile blob
```

- **Ingest** lives in `stt-build` behind the **`duckdb` cargo feature** (off by
  default). The engine is **statically bundled** (`duckdb` crate `bundled`
  feature) so there is no system-lib requirement — matching the self-contained
  `postgres` driver. Module: `crates/stt-build/src/duckdb_input.rs`.
- The geometry bridge is **WKB**: DuckDB's spatial `ST_AsWKB(geom)` emits
  standard OGC WKB, which `stt-build`'s existing `parse_wkb_geometry`
  (`geozero`) already decodes — no new geometry code.
- Rows decode from DuckDB's **self-describing `ValueRef`** (one tagged value per
  cell), so — unlike the PostGIS path, which resolves each column's PG type up
  front — no per-type schema introspection is needed. SQL `NULL` is just
  `ValueRef::Null`; unmappable types (raw `GEOMETRY`, decimals, nested types)
  decode to `None` and are dropped per row.
- **Serve** is a second backend in the same `crates/stt-serve` binary, selected
  by `--duckdb` (vs `--postgres`). DuckDB is embedded and **blocking** (its
  `Connection` is `Send` but `!Sync`), so it uses an `r2d2` connection pool and
  runs the whole per-request path — pool checkout, query, decode, encode — on a
  `spawn_blocking` worker. The tile bytes are **byte-for-byte what the offline
  build would emit for that tile**.

### DuckDB-specific details

- **Spatial extension** is a *separate, downloadable* extension (not part of the
  bundle, and not auto-loadable). The reader runs `INSTALL spatial; LOAD spatial;`
  on connect — a one-time network fetch, cached under `~/.duckdb` and offline
  thereafter — and pins the session to **UTC** so epoch math is
  timezone-independent.
- **No `ST_SetSRID`.** DuckDB `GEOMETRY` carries no per-row SRID, so reprojection
  passes the source CRS to `ST_Transform` as an explicit string:
  `ST_Transform(geom, 'EPSG:<srid>', 'EPSG:4326', always_xy => true)`. The
  `always_xy` flag keeps EPSG:4326 output as lon/lat (x,y) instead of the
  authority's lat/lon order.
- **Read-only file access.** A real `.duckdb` file is opened **read-only**, so a
  build never mutates the user's data and can run against a file another process
  holds. `:memory:` opens a fresh in-memory database — for scanning external
  files via `--sql` (`read_parquet`/`read_csv_auto`/…).
- DuckDB's `query()` computes the result into its compact in-memory columnar
  format; our streaming reader flushes parsed features in bounded batches, so
  downstream tiling stays bounded by the flush size.

### CLI

```bash
# Ingest from a DuckDB table (everything downstream — LOD, quantization, summary
# tiers, --publish, etc. — works unchanged):
stt-build --duckdb hurricane.duckdb \
          --table hurricane_obs --geom-column geom --time-field iso_time \
          --where "iso_time >= '1970-01-01'" --temporal-bucket 7d -o out.stt

# …or scan a Parquet / CSV file directly with an in-memory database — no
# intermediate export, no table to create:
stt-build --duckdb :memory: \
          --sql "SELECT ST_Point(lon, lat) AS geom, ts, mag
                 FROM read_parquet('quakes.parquet')" \
          --geom-column geom --time-field ts -o out.stt

# Dynamic tile server (no database server needed):
stt-serve --duckdb hurricane.duckdb --table hurricane_obs --geom-column geom \
          --time-field iso_time --temporal-bucket 7d --min-zoom 3 --max-zoom 8
#   GET /tiles/{z}/{x}/{y}/{t}.stt   GET /metadata.json   GET /health
```

`--duckdb` is mutually exclusive with `--input` and `--postgres`; the serve path
also reads `STT_DUCKDB_PATH`. Bare `--table`/`--sql` (no `--duckdb`/`--postgres`)
still defaults to PostGIS for backward compatibility.

### Consistency notes

- Property columns map by DuckDB type (bool / ints / floats / text / timestamp /
  date). The time column → unix-ms (timestamp/timestamptz directly via
  `TimeUnit`; `DATE` at midnight UTC; integer columns honour `--time-format`;
  text parsed as ISO-8601), matching the GeoParquet and PostGIS readers.
- Geometry-component column names (`lon`/`lat`/`x`/`y`/…) are excluded from
  properties exactly as the other readers do, so tiles never carry coordinates
  twice and the ingest paths stay logically equivalent.
- STT stores **unsigned** epoch-ms, so pre-1970 timestamps are rejected (shared
  guard) — filter them in `--where`/`--sql`.

The DuckDB reader is **byte-for-byte consistent with the PostGIS reader**
(verified on the IBTrACS A/B above). Both DB readers share a few *intentional*
small differences from the GeoParquet **file** reader, none of which affected
the benchmark parity (they only surface on uncommon data shapes):

- a `NULL`/unparseable `--end-time-field` value yields `end_timestamp = None`
  (the file reader coerces it to `Some(0)` in `--warn` mode);
- extra `TIMESTAMP`/`DATE` columns become integer-ms properties (the file reader
  drops them);
- a non-finite (`NaN`/`Inf`) float property is dropped (the file reader keeps the
  key with a JSON `null`);
- coordinate-name exclusion (`lon`/`lat`/…) is case-insensitive (the file reader
  is case-sensitive).

## 3. Benchmark (IBTrACS hurricanes)

DuckDB 1.5.4 (statically bundled). Source = NOAA IBTrACS best-track
observations loaded into a `hurricane.duckdb` `hurricane_obs` table
(Point/4326). Reproduce with `cargo run --release -p stt-build --features duckdb
--example duckdb_load_ibtracs` then `scripts/duckdb/{bench-ingest.sh,
bench-serve.sh}`.

### 3.1 Ingest: DuckDB vs file (identical post-1970 point set = 48,538 obs, z0–8, 7-day buckets)

| metric | GeoParquet file | DuckDB | match |
|---|---|---|---|
| tile_count | 60,521 | 60,521 | ✅ |
| feature instances (across tiles) | 436,842 | 436,842 | ✅ |
| spatial bounds / time range / bucket | — | — | ✅ identical |
| payload bytes (zstd) | 67,037,268 | 67,036,607 | Δ **0.00%** |
| **wall-clock (best of 3)** | **7.60 s** | **5.05 s** | **0.66×** |

**DuckDB ingest produces logically identical tiles** (same count, same feature
set, same bounds) and here is **faster than the file path** (0.66×): DuckDB's
columnar scan streams into the tiler while the file path pays Parquet decode up
front, and on an identical column set the per-column decode is cheaper. The
0.00% byte difference is only feature order within a tile. The baseline
GeoParquet is exported from the same DuckDB query (`duckdb_load_ibtracs`
example), so the A/B compares an identical column set — and the row counts
(126,970 total / 48,538 post-1970) match the PostGIS benchmark exactly.

### 3.2 Serve: dynamic DuckDB vs pre-baked static (2,001 non-empty tiles, conc 16, avg tile 5.7 KB)

| server | p50 | p95 | p99 | throughput | server-side gen p50 |
|---|---|---|---|---|---|
| **Dynamic DuckDB** (warm) | **7.7 ms** | 29.8 ms | 87 ms | **~1,380 req/s** | **5.4 ms** |
| Static pre-baked files¹ | 2.7 ms | 8.5 ms | *(202 ms¹)* | ~1,850 req/s¹ | — |

¹ The static baseline is Python's `http.server` (a stand-in for "tile already on
disk"); its p99 spike and ~1.9k cap are the test server's GIL, **not** a real
CDN. Treat the static p50 (~2.7 ms, a raw file read) as the fair comparison.
"server-side gen" is the `x-stt-gen-micros` header (backend-agnostic; here it is
DuckDB → tile, not PostGIS).

**Reading it:** generating a full STT tile live from DuckDB — bbox+time query →
`ValueRef` decode → GeoArrow/Arrow-IPC encode → zstd — costs **~5 ms of compute**
and ~7.7 ms end-to-end, at well over a thousand tiles/sec on one laptop
core-set, with **every sampled tile served correctly** (2,001/2,001, zero empty).

### 3.3 When to use which

- **Pre-bake (`stt-build` → packed archive on R2/S3/CDN)** stays the default for
  published, read-many datasets: immutable, content-addressed, **edge-cacheable**,
  zero origin compute. DuckDB-as-source just removes the export step — and lets
  you tile a Parquet/CSV file directly with no intermediate.
- **Dynamic (`stt-serve --duckdb`)** fits ad-hoc exploration and live files where
  a pre-bake would be stale or wasteful, **without standing up a database
  server** — point it at a local `.duckdb` file. The trade-off is that it is
  **not** edge-cacheable (every tile is origin compute); a reverse-proxy cache in
  front recovers most of that for hot tiles.

## 4. What's here

| Path | What |
|---|---|
| `crates/stt-build/src/duckdb_input.rs` | DuckDB reader (feature `duckdb`): streaming `ValueRef` decode, row→`ParsedFeature`, `build_tile_query`/`build_metadata_query`/`decode_query` for the server |
| `crates/stt-build` CLI | `--duckdb/--table/--sql/--geom-column/--where/--source-srid` |
| `crates/stt-build/examples/duckdb_load_ibtracs.rs` | build the benchmark `hurricane.duckdb` + baseline Parquet from the IBTrACS CSV (bundled engine, no external DuckDB) |
| `crates/stt-serve` | DuckDB backend (`--duckdb`) alongside PostGIS, on an `r2d2` pool |
| `scripts/duckdb/*` | `bench-ingest.sh`, `bench-serve.sh` (reuse the backend-agnostic PostGIS serve helpers) |

## 5. Possible follow-ups

- **True streaming** of very large results via DuckDB's `stream_arrow` (the row
  API materialises the result set; today our flush keeps downstream bounded).
- **Shared in-memory** serve mode (today each pooled `:memory:` connection is a
  separate database; only file-scan `--sql` makes sense there).
- An **RTREE index** hint in the serve docs to accelerate `ST_Intersects`.
- Integer-epoch time columns in `stt-serve`'s time filter (the build path already
  handles them via `--time-format`; the server assumes a timestamp column).
