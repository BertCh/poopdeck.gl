# Database input adaptors for STT (PostGIS + DuckDB)

_Decision record. PostGIS and DuckDB are first-class **input sources** for
`stt-build` (complements to the GeoParquet file path) and the two backends of
`stt-serve`, a dynamic tile server that generates one STT tile per request —
the `ST_AsMVT` analog for the STT format. This doc records rationale, lessons,
benchmarks, negative results, and the static-vs-DB verdict. **Behavior lives
elsewhere:** routes/caching/metadata/error semantics in
[../spec/stt-serve-protocol.md](../spec/stt-serve-protocol.md); the flag
surface in [../api/cli-reference.md](../api/cli-reference.md)._

**Status.** Landed on `main` and published to crates.io + npm since 0.3.0
(2026-07-05): both DB readers, the `stt-serve` binary, the full
generation-parity layer (shared `build_options.rs`, `encode_single_tile_counted`,
per-vertex column bridge, cross-source parity suite), and the 2026-07-05 deep
review (z-guard, DECIMAL props, kind-pinning, serve `--source-srid`, sargable
SQL — all tests green). Merges the former PostGIS/DuckDB integration docs plus
the absorbed encoder-seam-lessons and static-vs-DB sibling docs, and the
counted-out SedonaDB third-backend proposal (§8).

---

## 1. Why DB inputs

A great deal of spatiotemporal data already lives in a database, and the
analytics ecosystem expects a "point your database at a tiler" workflow
(pg_tileserv, Martin, `ST_AsMVT`; DuckDB's in-process `spatial` scan of
Parquet/CSV/GeoJSON/Shapefile). Before this, the only way into STT was a
GeoParquet file. Two capabilities were added for **each** engine:

1. **Ingest** — `stt-build` reads features directly from a DB query and builds
   the identical packed archive it would from a file. No export step.
2. **Dynamic serve** — `stt-serve` answers `GET /tiles/{z}/{x}/{y}/{t}.stt` by
   querying the DB per request and encoding one STT tile, with no pre-bake.

The engines cover complementary needs: **PostGIS** is the live, mutating,
server-backed table; **DuckDB** is in-process with no server — point it at a
`.duckdb` file, or scan a Parquet/CSV with `:memory:` and no table at all.

## 2. Architecture

```
INGEST   DB ──WKB (ST_AsEWKB / ST_AsWKB)──▶ ParsedFeature ──▶ existing tiler ──▶ packed archive
SERVE    GET /tiles/{z}/{x}/{y}/{t}.stt ──bbox+time query──▶ encode_single_tile ──▶ Arrow-IPC tile blob
```

The whole thing slots into the existing pipeline because both the tiler and
the per-tile encoder already consume **`ParsedFeature`** and are agnostic to
where the features came from. Three properties made it a small change:

- **`ParsedFeature` is the source-agnostic seam.** A new adaptor is "produce
  the same struct" and nothing downstream changes.
- **WKB is the geometry bridge.** PostGIS `ST_AsEWKB(geom)` and DuckDB
  `ST_AsWKB(geom)` both emit WKB that `stt-build`'s existing
  `parse_wkb_geometry` (`geozero`) already decodes — no new geometry code.
  (GeoArrow-native input encodings are rejected; WKB is the ingest lingua
  franca.)
- **`encode_single_tile_counted` is the shared per-tile core.** The offline
  build and every per-request serve call the _same_ `build_tile`/`encode_tile`
  path (factored out in `tiler.rs`), so a served tile is **byte-for-byte**
  what the offline build would emit for that `(z,x,y,t)` and the same source
  rows. It returns the placed-feature count so serve can honour
  `--min-features-per-tile` (below threshold → `204 No Content`).

Both readers live in `stt-build` behind off-by-default cargo features
(`postgres` / `duckdb`) so default builds pull no DB driver; both are
self-contained (`postgres` pure-Rust; the `duckdb` engine **statically
bundled**, no system lib). `stt-serve` runs the per-request path on a
`spawn_blocking` worker over a deadpool (PostGIS) / r2d2 (DuckDB) pool. CLI
shape, connection env-vars, routes: see the two docs linked in the header.

## 3. Serve parity with the offline build

`encode_single_tile_counted` shares the exact `build_tile`/`encode_tile` path
the offline build uses, so `stt-serve` exposes the **full generation surface** —
byte-identical to the offline-built tile for the same source rows. The CLI and
the server build their configuration from the **same flag strings** via the
shared `stt_build::build_options` module — one source of truth, no drift — and
`stt-serve` logs its active parity-affecting config at startup so an operator
can confirm it. Flag list:
[../api/cli-reference.md](../api/cli-reference.md); the parity contract is
normative in [../spec/stt-serve-protocol.md](../spec/stt-serve-protocol.md) §8.

Parity-relevant decisions worth recording here:

- **Kind-pinning from the result schema.** `stt-serve` pins property kinds at
  startup (DuckDB: `LIMIT 0` probe; PostGIS: statement prepare) — the same
  schema-pinning an offline build derives from the Parquet schema, also
  threaded into `stt-build`'s DB sources — so an all-NULL-within-one-tile
  column can no longer drift the layer schema on any path.
- **`--source-srid` shipped in serve** (2026-07-05 review): non-4326 source
  geometry is served via a per-tile `ST_Transform` before the bbox filter,
  mirroring the ingest expressions. Correct but index-bypassing — store 4326
  (or add a PostGIS functional index on the transform) for the fast path.
- **The 2026-07-05 deep review** also shipped: the z-guard (tile coordinates
  validated `z ≤ 31`, `x, y < 2^z` → `400`), DECIMAL/NUMERIC property mapping
  via the one decimal→nearest-f64 conversion shared by both engines, and
  **sargable time predicates** — integer-epoch filters compare the raw column
  against pre-scaled literals (never wrap the column in an expression), so
  b-tree indexes / zone maps still apply.
- **Heatmap domain** is computed once at startup via a SQL aggregate — the DB's
  continuous percentile, a style hint that may differ marginally from the
  offline floor-index percentile (field semantics: protocol spec §4.1).
- **Not servable per single-tile request** (rejected loudly at startup, never a
  silent drop): `--summary-tier` (cross-tile aggregation) and
  `--adaptive-temporal` (windows sized across a cell's whole time range) —
  pre-bake these and serve the static archive.

## 4. Encoder-seam lessons

Distilled from the parity work; the reason comprehensive DB parity was
_concentrated, not sprawling_ is one good seam and a few recurring smells.

1. **`ParsedFeature` is the source-agnostic boundary, and that's the whole
   game.** Everything downstream (tiler → encoder) reads only `ParsedFeature`,
   so a new input adaptor is "produce the same struct". **Corollary:** the
   Python extractors are a _fourth_ input adaptor (they emit GeoParquet, then
   shell to `stt-build`) — same seam, but their flag-construction logic lives
   outside it (lesson 5).

2. **Process-wide mutable encoder globals are a silent-divergence + concurrency
   footgun.** The encoder historically read six process-wide statics
   (vertex-time precision, coord/attr quantization, attrs-auto, vector groups,
   point-elevation — `stt-core/src/arrow_tile.rs`, statics block ~890–1105).
   The _original_ serve bug was exactly this: `stt-serve` never called the
   setters, so quantized/vector-grouped datasets served subtly wrong tiles with
   **no error**. Fixed by threading an explicit `EncoderConfig`
   (`encode_tile_with`) per request — also what made multi-dataset serve
   possible (different quantization configs in one process, live-verified).
   The offline CLI still uses the global setters — fine for a one-shot
   process; see the backlog.

3. **Silent degradation is the dangerous failure mode.** The DB readers
   originally dropped per-vertex columns to `None` with no warning — an entire
   dataset class lost fidelity invisibly. The antidote — counted, named
   end-of-read warnings for columns that carried no value — now applies to all
   three input adaptors symmetrically (the per-tile serve decoders skip it, so
   a live server never spams).

4. **Parity is provable at the intermediate representation, not the bytes.**
   Raw byte comparison is fragile (within-tile feature order from an unordered
   `SELECT`). The robust contract: exact `ParsedFeature` equality after a
   stable sort, plus order-independent per-tile
   `(zoom,x,y,t_start,t_end,feature_count)` key-sets
   (`crates/stt-build/tests/common/mod.rs`). Encoding determinism itself is
   closed — byte-reproducible builds on arrow ≥59 (normative:
   [../spec/stt-packed-format.md](../spec/stt-packed-format.md) §7 D6) — but
   the IR contract remains the right one for cross-_source_ comparison.

5. **Any spec interpreted in two places drifts.** `stt-serve` had silently
   drifted from the CLI (ignored most flags) until `build_options.rs` made one
   source of truth. The coordinate/vertex name sets were triplicated across the
   three readers (now deduped into shared `crate::input` predicates); the
   row→`ParsedFeature` decode rules were consolidated the same way
   (`db_input_common.rs` — every rule lives once, so a new engine can't
   silently diverge). Still outside the seam: the Python extractors
   hand-assemble flags and the showcase keeps dual-copy palettes — both
   mechanically guarded by parity tests rather than codegen (counted out;
   revive if the flag surface churns enough that those tests become the
   bottleneck).

6. **WKB is the ingest lingua franca; bundled/in-process is the CI win.** All
   readers bridge geometry through WKB → `parse_wkb_geometry`. DuckDB-bundled
   lets `file ≡ DuckDB` parity run in CI with zero infra — the fixture parquet
   is read back through core `read_parquet` with WKB riding as a `BLOB`
   column, sidestepping even the spatial-extension network install. PostgreSQL
   parity needs a live server, so it's `#[ignore]`d behind `STT_TEST_PG_DSN`.

7. **Factoring the smallest reusable unit enables online + offline reuse.**
   `encode_single_tile_counted` sharing the full `build_tile`/`encode_tile`
   path is the _only_ reason serve parity was "set the config", not
   "reimplement the tiler". The summary tier and preprocessing analytics
   aren't factored that way yet (backlog: `encode_single_cell`).

### Where each lesson lives in code

| Lesson                            | Anchor                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ParsedFeature` seam              | `crates/stt-build/src/input.rs` (struct + the file reader)                                               |
| Encoder globals / `EncoderConfig` | `crates/stt-core/src/arrow_tile.rs` (statics ~890–1105; `EncoderConfig` + `encode_tile_with` below them) |
| Shared flag→config                | `crates/stt-build/src/build_options.rs`                                                                  |
| Per-tile reuse                    | `crates/stt-build/src/tiler.rs` `encode_single_tile_counted`                                             |
| Parity comparator                 | `crates/stt-build/tests/common/mod.rs`, `tests/source_parity.rs`                                         |
| Shared name predicates            | `crates/stt-build/src/input.rs` `is_coordinate_column_name` / `is_vertex_metadata_column`                |
| Shared DB decode rules            | `crates/stt-build/src/db_input_common.rs`                                                                |

## 5. Consistency notes

Column/time/geometry mapping semantics are documented in
[../api/cli-reference.md](../api/cli-reference.md) and the protocol spec; what
belongs in the decision record is the _design stance_:

- **The DB readers are intentional supersets of the file reader**, only on
  type shapes with no GeoParquet-Float64 equivalent (`int2`, `numeric`/DECIMAL
  → nearest-f64, timestamp/date-as-integer-ms, `json`/`jsonb` as nested JSON).
  They only ever _add_ properties a file build couldn't carry — never diverge
  on the same logical data. The decimal conversion is one shared function, so
  identical values agree across engines.
- **PostGIS resolves column types up front** from the PG type at statement
  prepare; **DuckDB decodes from the self-describing `ValueRef`** (one tagged
  value per cell, no per-type introspection). Unmappable DuckDB types decode
  to `None` and are dropped per row — loudly, per lesson 3. PostGIS streams
  via a server-side `DECLARE … CURSOR` + `FETCH` loop, so ingest memory is
  bounded regardless of result size.
- **DuckDB has no per-row SRID** (no `ST_SetSRID`), so reprojection passes the
  source CRS explicitly:
  `ST_Transform(geom, 'EPSG:<srid>', 'EPSG:4326', always_xy => true)` — the
  `always_xy` flag keeps 4326 output as lon/lat rather than authority lat/lon.
  The spatial extension is not bundled; the reader runs
  `INSTALL spatial; LOAD spatial;` on connect (one-time network fetch cached
  under `~/.duckdb`) and pins the session to UTC.
- **Read-only file access.** A real `.duckdb` file opens read-only (never
  mutates the user's data; works against a file another process holds);
  `:memory:` opens a fresh in-memory database for external file scans via
  `--sql`. The PostGIS reader is **NoTls** (localhost posture — see backlog).
- STT stores **unsigned** epoch-ms, so pre-1970 timestamps are rejected by a
  shared guard on every path — filter them in `--where`/`--sql`.

## 6. Benchmark (IBTrACS hurricanes)

Source in both cases = NOAA IBTrACS best-track observations (Point/4326):
126,970 total, benchmark slice = the 48,538 post-1970 observations, z0–8, 7-day
buckets. The GeoParquet baseline is exported from the same DB query, so each A/B
compares an **identical column set**. Reproduce via `scripts/postgis/*`
(PostGIS 16/3.4 in Colima on Apple Silicon) and `scripts/duckdb/*`
(DuckDB 1.5.4, statically bundled).

### 6.1 Ingest vs the file path (logically identical tiles)

| metric                               | GeoParquet file  | PostGIS            | DuckDB             |
| ------------------------------------ | ---------------- | ------------------ | ------------------ |
| tile_count                           | 60,521           | 60,521 ✅          | 60,521 ✅          |
| feature instances (across tiles)     | 436,842          | 436,842 ✅         | 436,842 ✅         |
| spatial bounds / time range / bucket | —                | identical ✅       | identical ✅       |
| payload bytes (zstd)                 | ~67.0 MB         | Δ **0.10%**        | Δ **0.00%**        |
| **wall-clock (best of 3)**           | 4.36 s / 7.60 s¹ | **4.29 s (0.98×)** | **5.05 s (0.66×)** |

¹ PostGIS and DuckDB were benchmarked in separate runs against their own
identically-columned file baseline (4.36 s and 7.60 s respectively). Both DB
paths produce **logically identical tiles** (same count, same feature set, same
bounds) and are **as fast as or faster than** the file path — the cursor/columnar
stream overlaps with tiling while the file path pays Parquet decode up front. The
sub-0.1% byte difference is only within-tile feature order (a `SELECT … ORDER BY`
closes even that).

### 6.2 Serve: dynamic vs pre-baked static (conc 16, avg tile 5.7 KB)

| server                     | p50            | p95        | p99              | throughput       | server-side gen p50 |
| -------------------------- | -------------- | ---------- | ---------------- | ---------------- | ------------------- |
| **Dynamic PostGIS** (warm) | **2.0–3.0 ms** | 2.7–4.5 ms | 5–14 ms          | **5k–7k req/s**  | **1.9–2.8 ms**      |
| **Dynamic DuckDB** (warm)  | **7.7 ms**     | 29.8 ms    | 87 ms            | **~1,380 req/s** | **5.4 ms**          |
| Static pre-baked files¹    | 1.1–2.7 ms     | 2.0–8.5 ms | _(≈100–200 ms¹)_ | ~1.9k–4k req/s¹  | —                   |

¹ The static baseline is Python's `http.server` (a stand-in for "tile already on
disk"); its p99 spikes and throughput cap are the test server's GIL, **not** a
real CDN. Treat the static p50 (a raw file read) as the fair comparison.
"server-side gen" is the backend-agnostic `x-stt-gen-micros` header. Correctness
was cross-checked (a served tile's feature count equals an independent DB
`COUNT(*)` over the same bbox + bucket; the DuckDB run served 2,001/2,001 tiles
non-empty).

**Reading it:** generating a full STT tile live — bbox+time query → row/`ValueRef`
decode → Arrow-IPC encode → zstd — costs **~2 ms (PostGIS) / ~5 ms (DuckDB)** of
pure compute at over a thousand tiles/sec on one laptop core-set.

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

## 7. Static vs DB — the architectural verdict (2026-07-05)

Question investigated: is the packed format "rolling a custom DB", and would a
DuckDB/PostGIS-backed serve path beat it on performance? (Benchmark data: §6.)

The packed format **is** half a database — deliberately the read-only half:
clustered `(zoom, hilbert, time)` index, zone-map page pruning, per-blob zstd,
baked statistics, LOD. It skips the hard half (writes, concurrency, recovery,
query planning). Same trade PMTiles/COPC/Parquet made; not NIH.

**Raw single-node latency is a tie, not a static win**: warm dynamic PostGIS
serves a tile in ~2–3 ms p50 vs ~1–3 ms for static files (~5 ms DuckDB, 87 ms
p99). Static wins structurally, not on the hot path:

1. **Fan-out economics.** `stt-serve` is correctly `no-store` (live source) —
   every tile is origin compute forever. Packs are immutable + content-addressed
   → CDN-cached indefinitely; only the manifest is mutable. Prior art is blunt:
   under load the DB is always the bottleneck (Martin's own maintainer:
   "PMTiles is always a much faster choice").
2. **Scaling with data.** Dynamic cost ∝ rows-per-tile; low-zoom tiles are the
   industry-documented pathological case, and the no-thinning principle makes
   ours comprehensive. Static pays once at build (and DB _ingest_ is as fast as
   file ingest — 0.98×/0.66×).
3. **The directory is the client's planner.** Byte-budgeted prefetch slices and
   runway readiness run on per-tile byte lengths from the directory; a dynamic
   server can't know tile sizes before generating them, and can't coalesce
   ranges across tiles.

Every "clever DB thing" (page cache, matviews-per-zoom, R-tree, Varnish in
front) is a per-request reconstruction of what the build does once — and DuckDB
serving is read-only multi-process anyway, i.e. an immutable snapshot.

**Where the DB genuinely wins** — and why `stt-serve` stays: freshness
(live/mutating tables), ad-hoc attribute predicates (the format has no attribute
pushdown, whole-blob decode only), zero-build local exploration. The current
split (DB = live tier + input source with byte-parity via the shared encoder;
packed archive = published read-many default) is exactly the hybrid Felt /
Wikimedia / OSM / CARTO converged on. The temporal directory has **no**
off-the-shelf substitute — PMTiles has no time axis.

## 8. Backlog — counted out, with revival triggers

Everything scheduled from the original DB-path backlog has shipped:
`EncoderConfig` threading, multi-dataset serve, integer-epoch serve filters,
dropped-data accounting (all three readers), serve `--source-srid`, and the
byte-determinism guard (closed by the arrow ≥59 upgrade; normative:
[../spec/stt-packed-format.md](../spec/stt-packed-format.md) §7 D6). What
remains is deliberately unscheduled:

- **Packed-manifest facade for `stt-serve`** (`/manifest.json` + range-served
  packs so the TS `ArchiveReader` can point at a live server) — counted out
  2026-07-01: the dynamic `/metadata.json` descriptor and the packed manifest
  serve different consumers. Revive when a client genuinely needs one reader
  across both static and live sources.
- **TLS for the PostGIS _ingest_ reader** — still counted out: NoTls/localhost
  is the documented posture and the error text says so ("failed to connect to
  PostgreSQL (NoTls; localhost / non-TLS only)"), and ingest is a one-shot
  operator-run command, not an exposed service. The trigger already fired on
  the _serve_ side and was taken: `stt-serve` honours `sslmode=require` behind
  the opt-in `serve-postgres-tls` facade feature (native-tls connector; default
  and `sslmode=disable` keep the NoTls path, so local dev is unchanged). Revive
  for ingest when someone builds from a managed/remote Postgres.
- **Serve-side cache: in-process LRU + `--immutable-source` ETag** — counted
  out: an app cache needs a staleness policy the server can't infer (the
  source is a LIVE table — cached tiles silently go stale on writes); the
  documented answer stays "reverse proxy with an explicit TTL in front".
  Revive with a user-supplied freshness contract (`--immutable-source`) —
  e.g. the first static `.duckdb`/read-only snapshot with public traffic.
- **Zoom-dependent short TTLs** (60 s low zoom / 5 s high — the Sourcepole
  pattern) — revive if a genuinely live dataset ships publicly.
- **`encode_single_cell` per-unit core for the summary tier** (lesson 7 applied
  to analytics, enabling dynamic aggregated serve) — counted out: the seam
  lesson says factor the smallest reusable unit _when there are two callers_,
  and summary aggregation has exactly one
  (`summary::build_summary_tier`, called once from the `stt-build` binary).
  Factoring for a hypothetical second caller is how you get an abstraction
  shaped for nobody. **Revive on the second caller appearing** — concretely,
  either a request to serve `--summary-tier` tiles dynamically (today
  `stt-serve` rejects that flag loudly at startup, §3) or an incremental /
  append rebuild that needs to re-aggregate one cell without re-reading the
  whole feature set.
- **Retire the offline encoder globals entirely** — counted out: the offline
  CLI's global setters are fine for a one-shot process (one archive = one
  config); plumbing `EncoderConfig` through the config-agnostic
  `TileWriter::write_tile` impls is cleanliness with no correctness payoff.
  Revive if the offline builder ever needs multiple configs in one process.
- **`stream_arrow` batch ingest for the DuckDB reader** — originally blocked on
  the workspace arrow-version split; that trigger **fired** (arrow ≥59 landed
  2026-07). Re-triaged 2026-07-07 against §6.1: the row-`ValueRef` API already
  measured _faster_ than the file baseline (0.66×), so no performance debt
  forces the change. Stays parked unless profiling ever shows row decode as
  the ingest bottleneck.
- **A third DB backend — Apache SedonaDB (embedded Rust/DataFusion), ingest +
  serve** — counted out 2026-07-24. A full design pass produced **zero lines of
  code**, and two engines already cover every demo and every documented use:
  PostGIS is the live mutating server table, DuckDB is the zero-server
  in-process one that scans Parquet/CSV directly. A third engine buys no
  capability we can name and adds a permanent parity surface — lesson 5 says
  any spec interpreted in N places drifts, and that cost is paid forever.
  Facts worth keeping if it revives: the `sedona` 0.3.0 crates **are** on
  crates.io, so an optional facade feature is publishable (that gate is
  cleared); the real friction is a dependency skew — sedona 0.3.0 pins
  arrow `^57` against the workspace's arrow 59, and arrow-57 vs arrow-59
  `RecordBatch`/`ArrayRef` are distinct, incompatible types — which is
  containable exactly the way the DuckDB reader already contains its vendored
  arrow: keep every arrow-57 type inside one module and bridge geometry out as
  WKB bytes (`ST_AsBinary` → `parse_wkb_geometry`, which is geozero and
  arrow-version-agnostic). **Revive on a concrete ask for something only
  SedonaDB reads** — GDAL/OGR vector formats, LAS/LAZ point clouds, or
  object-store SQL over `s3://`/`gs://` via DataFusion — never on "support a
  third engine" as a goal in itself. For cluster users the bridge already
  exists and needs no code: Sedona-on-Spark
  `df.write.format("geoparquet")` → `stt-build --input`.

Dropped outright (not parked): everything premised on `--streaming-arrow` (the
flag was removed with the 2026-07 transcode-removal batch — moot), and
GeoArrow input/output alignment (geoarrow was dropped from the workspace; the
decision stands at WKB ingest / Arrow-IPC tiles).

## 9. File map

| Path                                                              | What                                                                                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/stt-build/src/postgres_input.rs`                          | PostGIS reader (feature `postgres`): streaming cursor, row→`ParsedFeature`, `build_tile_query`/`decode_rows` for the server                                         |
| `crates/stt-build/src/duckdb_input.rs`                            | DuckDB reader (feature `duckdb`): streaming `ValueRef` decode, `build_tile_query`/`build_metadata_query`/`decode_query` for the server                              |
| `crates/stt-build/src/db_input_common.rs`                         | Row-decode rules shared by both DB readers (decimal conversion, vertex-coercion accounting, time-format dispatch) — every rule lives once                           |
| `crates/stt-build/src/build_options.rs`                           | Shared flag→config parsing (`EncoderSettings`, duration/LOD/quantize/vector-group parsers, budget + attribute-filter builders) used by BOTH the CLI and `stt-serve` |
| `crates/stt-build/src/tiler.rs` `encode_single_tile_counted`      | The reusable single-tile encoder (shared build_tile/encode_tile path; returns the placed-feature count)                                                             |
| `crates/spatiotemporal-tiles/src/bin/stt-serve.rs`                | axum dynamic tile server (moved from the former `crates/stt-serve`): PostGIS (deadpool) + DuckDB (r2d2) backends with full generation parity                        |
| `crates/stt-build/tests/source_parity.rs` + `tests/common/mod.rs` | file ≡ DuckDB ≡ PostgreSQL parity suite (DuckDB in CI, bundled, no spatial extension; Postgres gated on `STT_TEST_PG_DSN`)                                          |
| `crates/stt-build/examples/duckdb_load_ibtracs.rs`                | build the benchmark `hurricane.duckdb` + baseline Parquet from IBTrACS CSV (bundled engine)                                                                         |
| `scripts/postgis/*`, `scripts/duckdb/*`                           | setup / load / bench-ingest / bench-serve (DuckDB reuses the backend-agnostic PostGIS serve helpers)                                                                |
