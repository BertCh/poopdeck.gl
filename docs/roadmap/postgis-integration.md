# PostgreSQL / PostGIS integration for STT

*Implemented + benchmarked 2026-06-23. PostGIS becomes a first-class **input
source** for `stt-build` (a complement to the GeoParquet file path), and a new
`stt-serve` binary generates STT tiles **on the fly** from a live PostGIS table —
the `ST_AsMVT` analog for the STT format.*

*See also [duckdb-integration.md](./duckdb-integration.md) — the same two
capabilities for DuckDB (in-process, no server), sharing `stt-serve` and the
`encode_single_tile` core.*

---

## 1. Why

Lots of spatiotemporal data already lives in PostGIS, and the analytics
ecosystem expects a "point your database at a tiler" workflow (pg_tileserv,
Martin, `ST_AsMVT`). Before this, the only way into STT was a GeoParquet file.
Two capabilities were added:

1. **Ingest** — `stt-build` reads features directly from a PostGIS query and
   builds the identical packed archive it would from a file. No export step.
2. **Dynamic serve** — `stt-serve` answers `GET /tiles/{z}/{x}/{y}/{t}.stt` by
   querying PostGIS per request and encoding one STT tile, with no pre-bake.

The whole thing slots into the existing pipeline because both the tiler and the
per-tile encoder already consume `ParsedFeature` and are agnostic to where the
features came from.

## 2. Architecture

```
INGEST   PostGIS ──cursor, ST_AsEWKB──▶ ParsedFeature ──▶ existing tiler ──▶ packed archive
SERVE    GET /tiles/{z}/{x}/{y}/{t}.stt ──bbox+time query──▶ encode_single_tile ──▶ Arrow-IPC tile blob
```

- **Ingest** lives in `stt-build` behind the **`postgres` cargo feature** (off by
  default, so default builds don't pull a DB driver). It uses the synchronous
  `postgres` crate with a server-side `DECLARE … CURSOR` + `FETCH` loop, so memory
  is bounded regardless of result size — the same streaming contract as the
  GeoParquet reader. Module: `crates/stt-build/src/postgres_input.rs`.
- The geometry bridge is **WKB**: PostGIS `ST_AsEWKB(geom)` emits the same
  SRID-prefixed EWKB that `stt-build`'s existing `parse_wkb_geometry`
  (`geozero`) already decodes — no new geometry code.
- **Serve** is a separate crate `crates/stt-serve` (axum + `tokio-postgres` +
  `deadpool-postgres`). Per request it maps `(z,x,y)`→bbox and `t`→a temporal
  bucket, runs a bbox (`&&`, GiST) + time-window query, and calls
  `stt_build::encode_single_tile` (the per-tile clip→bucket→`build_tile`→
  `encode_tile` path, factored out of the full build) on a `spawn_blocking`
  worker. The tile bytes are **byte-for-byte what the offline build would emit
  for that tile**.

### CLI

```bash
# Ingest from a table (everything downstream — LOD, quantization, summary tiers,
# --publish, etc. — works unchanged):
stt-build --postgres "postgresql://user@host/db" \
          --table hurricane_obs --geom-column geom --time-field iso_time \
          --where "iso_time >= '1970-01-01'" --temporal-bucket 7d -o out.stt

# …or from an arbitrary query:
stt-build --postgres "$PGURL" --sql "SELECT * FROM obs WHERE valid ORDER BY id" \
          --geom-column the_geom --time-field ts -o out.stt

# Dynamic tile server:
stt-serve --postgres "$PGURL" --table hurricane_obs --geom-column geom \
          --time-field iso_time --temporal-bucket 7d --min-zoom 3 --max-zoom 8
#   GET /tiles/{z}/{x}/{y}/{t}.stt   GET /metadata.json   GET /health
```

`--postgres` is mutually exclusive with `--input`; the connection can also come
from `STT_POSTGRES_URL` / `DATABASE_URL`. `--input` becomes optional.

### Consistency notes

- Property columns map by PG type (int/float/bool/text/timestamp/json). The
  time column → unix-ms (timestamp/timestamptz directly; integer columns honor
  `--time-format`; text parsed as ISO-8601), matching the GeoParquet reader.
- Geometry-component column names (`lon`/`lat`/`x`/`y`/…) are excluded from
  properties exactly as the GeoParquet reader does, so tiles never carry
  coordinates twice and the two ingest paths stay byte-equivalent.
- STT stores **unsigned** epoch-ms, so pre-1970 timestamps are rejected (shared
  guard) — filter them in `--where`/`--sql`.

## 3. Benchmark (IBTrACS hurricanes)

Native-arm64 PostGIS 16 / 3.4 in Colima on Apple Silicon. Source table
`hurricane_obs` = 126,970 NOAA IBTrACS best-track observations (Point/4326, GiST
+ btree(iso_time) indexes). Benchmark slice = the 48,538 post-1970 observations.
Reproduce with `scripts/postgis/{setup.sh, load-ibtracs.sh, bench-ingest.sh,
bench-serve.sh}`.

### 3.1 Ingest: PostGIS vs file (identical data, z0–8, 7-day buckets)

| metric | GeoParquet file | PostGIS | match |
|---|---|---|---|
| tile_count | 60,521 | 60,521 | ✅ |
| feature instances (across tiles) | 436,842 | 436,842 | ✅ |
| spatial bounds / time range / bucket | — | — | ✅ identical |
| payload bytes (zstd) | 67,038,042 | 67,106,568 | Δ **0.10%** |
| **wall-clock (best of 3)** | **4.36 s** | **4.29 s** | **0.98×** |

**PostGIS ingest produces logically identical tiles** (same count, same feature
set, same bounds) and is **as fast as the file path** — here marginally faster,
because the cursor stream overlaps with tiling while the file path pays Parquet
decode up front. The 0.10% byte difference is only feature order within a tile
(a `SELECT … ORDER BY` source closes even that). Earlier, against a *thinner*
8-column Parquet, PostGIS measured ~1.34× — i.e. the overhead is the per-column
decode, not the transport; on equal columns they converge.

### 3.2 Serve: dynamic PostGIS vs pre-baked static (1,895 non-empty tiles, conc 16, avg tile 5.7 KB)

| server | p50 | p95 | p99 | throughput | server-side gen p50 |
|---|---|---|---|---|---|
| **Dynamic PostGIS** (warm) | **2.0–3.0 ms** | 2.7–4.5 ms | 5–14 ms | **5k–7k req/s** | **1.9–2.8 ms** |
| Static pre-baked files | 1.1 ms | 2.0–2.5 ms | *(≈100 ms¹)* | ~4k req/s¹ | — |

¹ The static baseline is Python's `http.server` (a stand-in for "tile already on
disk"); its p99 spikes and ~4k cap are the test server's GIL, **not** a real
CDN — a CDN/`nginx` would be faster *and* edge-cacheable. Treat the static p50
(~1 ms, a raw file read) as the fair point of comparison.

**Reading it:** generating a full STT tile live from PostGIS — bbox+time query →
row decode → GeoArrow/Arrow-IPC encode → zstd — costs **~2 ms of pure compute**
and adds only ~1 ms over a raw file read, at thousands of tiles/sec on one
laptop core-set. Correctness was cross-checked: a served tile's feature count
equals an independent PostGIS `COUNT(*)` over the same tile bbox + bucket.

### 3.3 When to use which

- **Pre-bake (`stt-build` → packed archive on R2/S3/CDN)** stays the default for
  published, read-many datasets: immutable, content-addressed, **edge-cacheable**,
  zero origin compute. PostGIS-as-source just removes the export step.
- **Dynamic (`stt-serve`)** fits live / frequently-mutating tables and ad-hoc
  exploration where a pre-bake would be stale or wasteful. The trade-off is that
  it is **not** edge-cacheable (every tile is origin compute) — a reverse-proxy
  cache in front recovers most of that for hot tiles.

## 4. What's here

| Path | What |
|---|---|
| `crates/stt-build/src/postgres_input.rs` | PostGIS reader (feature `postgres`): streaming cursor, row→`ParsedFeature` decode, `build_tile_query`/`decode_rows` for the server |
| `crates/stt-build` CLI + `encode_single_tile` | `--postgres/--table/--sql/--geom-column/--where/--source-srid`; the reusable single-tile encoder |
| `crates/stt-serve` | axum dynamic tile server |
| `crates/stt-build/examples/tile_info.rs` | decode + inspect a raw tile blob |
| `scripts/postgis/*` | `setup.sh`, `load-ibtracs.sh`, `export-points-parquet.py`, `bench-ingest.sh`, `bench-serve.sh`, `bench_serve.py`, `gen_tile_urls.py` |

## 5. Possible follow-ups

- **TLS** connections (the reader is NoTls — localhost / trusted-network today).
- A **packed-manifest facade** on `stt-serve` so the existing TS reader can point
  at it directly (today the bench hits the tile endpoint directly; the dynamic
  model has no content-addressed packs to range-request).
- **Reverse-proxy cache** guidance / a small in-process LRU for hot tiles.
- Integer-epoch time columns in `stt-serve`'s time filter (the build path already
  handles them via `--time-format`; the server assumes a timestamp column).
- `--streaming-arrow` from PostGIS for very large tables (the streaming producer
  is already wired; pair it with a server-side cursor batch-size knob).
