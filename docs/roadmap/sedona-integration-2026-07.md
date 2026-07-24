# Apache SedonaDB as an STT input source (embedded, ingest + serve)

_Plan / decision record. Adds **Apache SedonaDB** (`apache/sedona-db`) as a
third first-class **input source** for `stt-build` and a third backend for
`stt-serve`, alongside PostGIS and DuckDB. This doc records the target, the
architecture (it reuses the existing `ParsedFeature` seam wholesale), the one
hard constraint (an Arrow major-version skew), the phased implementation, and
the open decisions to close in the Phase-0 spike. **Extends**
[db-input-adaptors.md](./db-input-adaptors.md) — every invariant in its §4
(encoder-seam lessons) and §5 (consistency notes) is binding here; this doc
only records what is **new** for a Rust-embedded, Arrow-native, async engine._

**Status.** Proposed 2026-07-23. Scope ratified by user: **SedonaDB embedded**
(not the classic distributed Spark/Flink Sedona) and **ingest + dynamic serve**
(both `stt-build` and `stt-serve`). Not started.

---

## 1. Target: SedonaDB, not classic Sedona

"Apache Sedona" is now two projects, and the useful one here is the new one:

| | **Apache Sedona** (classic) | **Apache SedonaDB** (`apache/sedona-db`) |
| --- | --- | --- |
| Since | ~2015 (GeoSpark), mature | **Sept 2025**, 0.1 → **0.3.0 crates (Mar 2026)**, 0.4 line mid-2026 |
| Runtime | Distributed, **JVM** (Spark / Flink / Snowflake) | **Single-node, Rust** |
| Built on | Spark Catalyst / JTS | **Apache DataFusion + arrow-rs** |
| In-memory geometry | JTS objects | **`geoarrow.wkb` Arrow extension arrays** |
| Reach from Rust | Spark Thrift/Hive JDBC or GeoParquet export | **Embed the crates in-process** |
| Formats read | Spark datasources | GeoParquet 1.0/1.1, GDAL/OGR (SHP, GeoJSON, FGB, GPKG), LAS/LAZ, cloud object stores |
| License | Apache-2.0 | Apache-2.0 |

SedonaDB is an **architectural twin of the DuckDB backend**: embedded,
in-process, SQL, CRS-aware, returns Arrow, no server to stand up. That is why it
slots into the existing seam with the same "produce a `ParsedFeature`" change
DuckDB needed — and it is the "emerging" Sedona the request was about. The
classic distributed engine is explicitly **out of scope** for this campaign
(the pragmatic bridge for cluster users remains: Sedona-on-Spark
`df.write.format("geoparquet")` → `stt-build --input`, which already works and
needs no code; recorded here only so it is not re-litigated).

## 2. Pinned facts (verified 2026-07-23)

- **Crates are published on crates.io** — the whole set the context pulls:
  `sedona` **0.3.0** (2026-03-09) depends on `sedona-common`, `sedona-datasource`,
  `sedona-expr`, `sedona-functions`, `sedona-geometry`, `sedona-geoparquet`,
  `sedona-proj`, `sedona-schema` (all 0.3.0), with optional `sedona-geo`,
  `sedona-geos`, `sedona-pointcloud`, `sedona-s2geography`, `sedona-spatial-join`,
  `sedona-tg`. **Consequence:** the optional feature _can_ ship in the published
  `spatiotemporal-tiles` facade (an optional feature may only depend on
  crates.io-resolvable crates — this gate is now cleared).
- **Arrow / DataFusion pin (published 0.3.0):** `arrow-array`/`arrow-schema`/
  `parquet` **^57**, `datafusion` **^51**. (The `apache/sedona-db` `main`
  branch has moved to arrow 58 / DataFusion 54 via dependabot, but the shippable
  crates today are arrow 57.) The workspace is **arrow 59** → a **two-major
  skew**. See §4.
- **Geometry** is the `geoarrow.wkb` Arrow extension type; `ST_AsBinary(geom)`
  yields OGC WKB bytes that `input::parse_wkb_geometry` (geozero) already
  decodes — same bridge PostGIS/DuckDB use.
- **CRS is strict.** SedonaDB tracks CRS on read and **errors** on mismatched
  CRS rather than guessing (`Mismatched CRS arguments: ogc:crs84 vs epsg:32618`).
  Reprojection must set the source CRS explicitly before transforming — stricter
  than DuckDB, closer to PostGIS's per-row SRID. See §5.
- **Engine is async** (DataFusion/tokio) and **streams** (`DataFrame::
  execute_stream()` → `SendableRecordBatchStream`, bounded memory) — unlike the
  DuckDB reader, which materializes the full result set (a documented DuckDB
  tradeoff). This is a genuine advantage for both large ingest and per-request
  serve.
- **Concurrency:** a DataFusion `SessionContext` is `Send + Sync` and built for
  concurrent queries (it will even parallelize a single query), so serve needs
  **one shared context**, not a DuckDB-style r2d2 / PostGIS-style deadpool
  connection pool.

## 3. Architecture — reuses the existing seam unchanged

```
INGEST   SedonaDB ──ST_AsBinary → WKB──▶ ParsedFeature ──▶ existing tiler ──▶ packed archive
SERVE    GET /tiles/{z}/{x}/{y}/{t}.stt ──bbox+time SQL──▶ encode_single_tile_counted ──▶ tile blob
```

Identical to db-input-adaptors.md §2. The new backend is "produce
`ParsedFeature`" for ingest and "answer a bbox+time query, feed
`encode_single_tile_counted`" for serve. Everything that made the DuckDB/PostGIS
work concentrated rather than sprawling applies verbatim:

- `ParsedFeature` is the source-agnostic boundary (§4.1).
- WKB is the geometry lingua franca (§4.6) — `geoarrow.wkb` → `ST_AsBinary` →
  `parse_wkb_geometry`, no new geometry code.
- `encode_single_tile_counted` is the shared per-tile core (§4.7) → byte-parity
  between served and offline-built tiles for the same source rows.
- Row-decode rules reused from `db_input_common.rs`, name predicates from
  `input.rs` — a new engine "can't silently diverge" (§4.5).

## 4. The one hard constraint: Arrow 57 ↔ 59 skew

The workspace is arrow 59; publishable SedonaDB is arrow 57. `RecordBatch` /
`ArrayRef` from arrow 57 and arrow 59 are **distinct, incompatible types** — you
cannot hand a SedonaDB batch to arrow-59 code. This is the **same class of
problem** the DuckDB reader already solved (it vendors its own arrow and is
therefore "row/`ValueRef` API only, no `query_arrow`").

**Mitigation (mandatory, proven): contain SedonaDB's Arrow entirely inside
`sedona_input.rs`.** The module's public surface emits only `ParsedFeature`,
`serde_json::Value`, `&[u8]`, and `PropertyKind` — never an Arrow type. Inside
the module, using SedonaDB's own arrow 57:

- geometry column `__stt_wkb` → `BinaryArray` → `&[u8]` → `parse_wkb_geometry`
  (geozero is arrow-version-agnostic);
- timestamp column → downcast to `Int64Array` / `TimestampArray` → `i64` →
  `apply_int_time_format` / `scale_timestamp_to_ms`;
- property columns → downcast to scalars → `serde_json::Value` (a
  `property_kind_for_sedona` + value decoder pair mirroring the DuckDB
  `ValueRef` decode, one arrow-57 downcast site).

Because the containment is total, the two-major gap is irrelevant — it works the
same at any skew, and it does not block the workspace from advancing arrow. Two
alternatives were considered and are **not** v1:

- **Arrow C Data Interface (FFI) / IPC transcode** 57→59, then reuse the
  GeoParquet reader's `extract_property_value` / `property_kind_for` downcasts.
  Cleaner reuse, but adds an FFI/serialize layer and a second failure surface.
  Revisit only if the arrow-57 downcast code becomes a maintenance burden.
- **Pin the workspace down to arrow 57** to share types in-process. Rejected:
  the workspace just moved _up_ to 59 (byte-reproducible builds depend on ≥59 —
  packed-format §7 D6), and coupling the whole repo to SedonaDB's arrow line is a
  far bigger blast radius than one contained module.

## 5. What is genuinely new vs PostGIS/DuckDB

Everything else follows the DuckDB template; these are the deltas that need
design, all to be nailed in Phase 0:

1. **Async containment.** DataFusion is async. `stt-build`'s ingest path is
   deliberately sync (PostGIS uses the sync `postgres` crate to stay
   tokio-free; DuckDB is sync). Wrap all SedonaDB calls in a **contained
   current-thread `tokio::runtime::Runtime` + `block_on`** inside
   `sedona_input.rs`, so async never leaks into the sync ingest pipeline. (Serve
   is already async/axum — there it composes directly.)
2. **CRS strictness → explicit set-then-transform.** DuckDB has no per-row SRID
   and reprojects with `ST_Transform(geom,'EPSG:<srid>','EPSG:4326',always_xy)`.
   SedonaDB errors on unknown/mismatched CRS, so `--source-srid` must **assign**
   the CRS first: `ST_Transform(ST_SetSRID(geom, <srid>), 'EPSG:4326')` (confirm
   the exact function names — `ST_SetSRID` vs `ST_SetCRS` — and lon/lat axis
   handling in Phase 0). When the source already carries CRS metadata (GeoParquet
   1.1), no `--source-srid` is needed and a bare transform to 4326 suffices.
3. **`ST_AsBinary`, not `ST_AsEWKB`/`ST_AsWKB`.** The wrapped ingest query is
   `SELECT ST_AsBinary(q."geom") AS __stt_wkb, q.* FROM (<table|sql>) q [WHERE …]`.
4. **The `--sedona <arg>` surface.** SedonaDB "connects" to files/dirs/URIs, not
   a server. Proposed: `--sedona <path|dir|uri|:memory:>` registers the source as
   table `q` (a GeoParquet file/dir, or `s3://…`/`https://…` via DataFusion's
   object store); with `:memory:`, the user supplies `--sql` referencing
   `read_parquet('…')` / a GDAL scan directly. `--table`/`--sql`/`--geom-column`/
   `--where`/`--source-srid` are reused unchanged.
5. **Object-store reads for free.** DataFusion's object store gives `s3://`,
   `gs://`, `http(s)://` sources — a capability neither PostGIS nor DuckDB-in-STT
   exposes. In scope as a natural consequence; documented, lightly tested.
6. **Single shared context on serve** (§2) — no connection pool. Register the
   source table once at startup into one `Arc`'d context; each request runs its
   bbox+time SQL against it; DataFusion handles concurrency/parallelism.
7. **Feature-set minimization.** Pull only what ingest/serve need:
   `sedona` (context) + `sedona-geoparquet` + `sedona-datasource` +
   `sedona-functions` + `sedona-schema` + (optionally) `sedona-proj` for
   `ST_Transform`. **Avoid `sedona-geos`** (GEOS topology — libgeos system dep)
   unless a user's `--where`/`--sql` needs topology predicates; gate PROJ
   reprojection behind a sub-feature (`sedona-proj` → libproj). GDAL/OGR and
   LAS/LAZ readers stay **behind their own opt-in sub-features** (system GDAL /
   heavy) — see §7 follow-ons.
8. **Bonus formats (follow-on, not v1 core).** GDAL/OGR vector formats and
   LAS/LAZ point clouds arrive through the same backend once their sub-features
   are enabled — a real expansion of `stt-build`'s input reach, sequenced after
   the GeoParquet core path proves out.

## 6. Implementation plan

### Phase 0 — spike & de-risk (blocking; answers §5 open items)

- New `crates/stt-build` cargo feature `sedona` (off by default). Add
  `sedona = "0.3"` + the minimal subcrates + a matching `arrow = "57"` **scoped
  to the reader only** (renamed dep or module-local, so it never collides with
  the workspace `arrow = "59"`). Confirm the dual-arrow tree **compiles and
  links**.
- Confirm the entry-point API against `sedona` 0.3.0 (the context type —
  `SedonaContext` per project docs — its constructor, `sql().await`,
  `execute_stream()`), and the exact reprojection function names (§5.2).
- Minimal end-to-end: register a fixture GeoParquet → `SELECT ST_AsBinary(geom)
  AS __stt_wkb, * FROM q LIMIT 5` → pull `&[u8]` → `parse_wkb_geometry`. Proves
  the containment boundary and the WKB bridge.
- Decide system-dep posture: does the minimal feature set avoid libgeos? Is
  libproj acceptable as a gated sub-feature, or should `--source-srid` be
  documented-unsupported in v1 (source must be 4326 / carry CRS)? Record the CI
  image impact.
- Output: a short spike note appended here (arrow-isolation mechanism, confirmed
  API signatures, system-dep verdict) before Phase 1.

### Phase 1 — ingest reader (`stt-build`)

- `crates/stt-build/src/sedona_input.rs` mirroring `duckdb_input.rs`:
  `open_context()`, `QuerySpec` + `wrapped_query()`, `load_features_sedona` /
  `stream_features_sedona` (over `execute_stream`, bounded memory), `property_kinds`
  (via `SELECT * FROM (…) LIMIT 0` schema), `property_kind_for_sedona`, and the
  arrow-57 value decoder. Reuse `db_input_common` (`RowOutcome`,
  `VertexCoercions`, `decimal_string_to_json`, `apply_int_time_format`,
  `warn_dropped_columns`) and `input::{parse_wkb_geometry, parse_iso8601,
  reject_negative_timestamp, is_vertex_metadata_column, is_coordinate_column_name}`.
- `pub mod sedona_input` (gated) in `crates/stt-build/src/lib.rs`.
- Binary wiring in `crates/spatiotemporal-tiles/src/bin/stt-build.rs`: add
  `InputSource::Sedona { source, spec }`, extend the four match arms
  (`describe` / `default_name` / `property_kinds` / `load`), add `--sedona` +
  `resolve_sedona_source` (mutually exclusive with `--postgres`/`--duckdb`/
  `--input`; clear "rebuild with `--features sedona`" error when the feature is
  off).
- Facade feature `sedona = ["build", "stt-build/sedona"]` in
  `crates/spatiotemporal-tiles/Cargo.toml`.

### Phase 2 — dynamic serve (`stt-serve`)

- Serve functions in `sedona_input.rs`: `build_tile_query` (bbox via
  `ST_Intersects` + envelope, half-open `[t_start_ms, t_end_ms)` with **sargable**
  integer-second predicates via `ceil_ms_to_seconds`), `build_metadata_query`,
  `decode_stream`.
- Backend in `crates/spatiotemporal-tiles/src/bin/stt-serve/`: **one shared
  `Arc<SedonaContext>`** (no pool, §5.6); per-request query on the async axum
  path; `encode_single_tile_counted` for byte-parity; kind-pinning at startup
  (`LIMIT 0` schema probe, §db-input-adaptors §3); heatmap domain via a one-shot
  SQL aggregate; **reject `--summary-tier` and `--adaptive-temporal` loudly at
  startup** (not servable per single tile — same as the other backends).
- Facade feature `serve-sedona`.

### Phase 3 — tests, docs, close-out

- `crates/stt-build/tests/source_parity.rs`: `sedona_matches_file_parsed_features`,
  `sedona_matches_file_archive`, `sedona_property_kinds_match_file`. **These run
  ungated in CI** — SedonaDB is embedded Rust with built-in GeoParquet: no live
  server (unlike Postgres), no spatial-extension network install (unlike DuckDB's
  `INSTALL spatial`). Add `load_sedona` to `tests/common/mod.rs`.
- Benchmark ingest + serve vs the file and DuckDB paths (§6 of db-input-adaptors
  is the template; reuse the IBTrACS harness).
- Docs: `cli-reference.md` (`--sedona`, serve backend), `stt-serve-protocol.md`
  §8 (parity note), and a new row set + an "extends" pointer added to
  `db-input-adaptors.md` §9 file map. Update the CRS/reprojection consistency
  note (§5) with the SedonaDB set-then-transform stance.

## 7. Risks & follow-ons

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Arrow 57↔59 two-major skew | High | Total Arrow containment inside `sedona_input.rs` (§4) — proven pattern, skew-independent |
| System C deps (GEOS/PROJ/GDAL) | Med | Minimal feature set avoids GEOS; PROJ + GDAL + LAS gated behind opt-in sub-features; document CI image delta |
| Async in a sync ingest path | Med | Contained `block_on` current-thread runtime (§5.1) |
| SedonaDB young & fast-moving (0.2→0.4, frequent breaking bumps) | Med | Pin exact `=0.3.x`; feature off by default; treat as maintained-optional |
| DataFusion build weight (compile time / binary size) | Low | Optional feature, off by default |
| CRS-strict errors surprise users | Low | Explicit `--source-srid` set-then-transform; clear error text; document the 4326/CRS-metadata happy path |
| crates.io publish completeness | **Cleared** | All required 0.3.0 crates verified published (§2) |

**Follow-ons (counted out of v1, revive triggers noted):**

- **GDAL/OGR + LAS/LAZ input** via `sedona-datasource`/`sedona-pointcloud`
  sub-features — the biggest capability win, sequenced after the GeoParquet core
  proves out. Revive once §6 Phases 1–3 land green.
- **Arrow FFI/IPC transcode boundary** (§4 alt) — revive if the arrow-57
  downcast code becomes a maintenance burden or the FFI reuse of the GeoParquet
  downcasts is worth it.
- **Distributed Sedona Flight SQL / ADBC connector** (`--sedona-flight`) —
  explicitly deferred; the GeoParquet handoff is the cluster bridge. `sedona-db`
  already carries ADBC 0.23, so this is a clean future track if a live-cluster
  ask appears.

## 8. Proposed file map

| Path | What |
| --- | --- |
| `crates/stt-build/src/sedona_input.rs` | **new** — SedonaDB reader (feature `sedona`): context, `wrapped_query`, streaming decode, `build_tile_query`/`build_metadata_query` for serve |
| `crates/stt-build/src/lib.rs` | gated `pub mod sedona_input` |
| `crates/stt-build/Cargo.toml` | feature `sedona` + minimal sedona subcrates + isolated `arrow = "57"` |
| `crates/spatiotemporal-tiles/src/bin/stt-build.rs` | `InputSource::Sedona`, 4 match arms, `--sedona`, `resolve_sedona_source` |
| `crates/spatiotemporal-tiles/src/bin/stt-serve/` | SedonaDB serve backend (single shared context) |
| `crates/spatiotemporal-tiles/Cargo.toml` | facade features `sedona`, `serve-sedona` |
| `crates/stt-build/tests/source_parity.rs`, `tests/common/mod.rs` | `sedona_*` parity tests (ungated in CI) + `load_sedona` |
| `docs/api/cli-reference.md`, `docs/spec/stt-serve-protocol.md`, `docs/roadmap/db-input-adaptors.md` | doc updates |

## 9. Sources

- Introducing SedonaDB — <https://sedona.apache.org/latest/blog/2025/09/24/introducing-sedonadb-a-single-node-analytical-database-engine-with-geospatial-as-a-first-class-citizen/>
- SedonaDB 0.4 (GPU joins) — <https://sedona.apache.org/latest/blog/2026/06/26/sedonadb-04-gpu-accelerated-spatial-joins/>
- `apache/sedona-db` — <https://github.com/apache/sedona-db> · DeepWiki — <https://deepwiki.com/apache/sedona-db>
- `sedona` 0.3.0 crate (arrow 57 / datafusion 51) — <https://docs.rs/crate/sedona/latest>
- `sedona-geoparquet` 0.3.0 crate — <https://docs.rs/crate/sedona-geoparquet/latest>
- DataFusion ↔ Arrow version mapping — <https://docs.rs/crate/datafusion/latest>
