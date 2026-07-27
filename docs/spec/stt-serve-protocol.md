# The `stt-serve` Protocol

> **Scope:** the HTTP surface of `stt-serve`
> (`crates/spatiotemporal-tiles/src/bin/stt-serve.rs`) — an axum server that
> generates STT tiles **on the fly**, one per request, from a live PostGIS
> table or a DuckDB database, with no `manifest.json` or packs written to
> disk. This is the `ST_AsMVT` analog for the STT format: request a
> `(z, x, y, t)`, get back one tile. Route shapes, status codes, response
> headers, and the JSON descriptor are documented here; the full CLI flag
> surface (every generation-parity flag `stt-serve` shares with `stt-build`) is
> in [`../api/cli-reference.md`](../api/cli-reference.md#stt-serve), and the
> rationale for dynamic serving as a database-input capability is in
> [`../roadmap/db-input-adaptors.md`](../roadmap/db-input-adaptors.md). This
> page does not repeat either.

## 1. Overview

`stt-serve` answers tile requests by querying a live source per request
instead of reading a pre-built [packed archive](./stt-packed-format.md):

1. `(z, x, y)` maps to a WGS84 bounding box; `t` maps to a temporal bucket
   (§4).
2. A source query filters by that bbox (spatial index) and time window.
3. The matching rows decode to features and encode into exactly one tile
   payload, using the **same** per-tile encoder `stt-build` uses.

There is one binary with two mutually-exclusive backends (`--postgres` /
`--duckdb`, §5) and two serving modes (single-dataset / multi-dataset, §2).
Nothing is cached on the server: every response is generated fresh, so unlike
the packed format's content-addressed packs, `stt-serve` responses are **not**
edge-cacheable (§7).

## 2. Serving modes

| Mode               | Selected by             | Routes live at                                                                  |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------- |
| **Single-dataset** | default (no `--config`) | the process root: `/metadata.json`, `/tiles/…`                                  |
| **Multi-dataset**  | `--config <file.json>`  | `/{dataset}/metadata.json`, `/{dataset}/tiles/…`, plus a catalog at `/datasets` |

A multi-dataset `--config` file lists one JSON object per dataset, each with
the same fields as the CLI flags (§6). Every dataset gets its own connection
pool, its own resolved `TileConfig`, and its own **explicit** encoder
configuration (never a process-wide global) — so several datasets with
_different_ quantization, vector grouping, or temporal bucketing are served
concurrently from one process without cross-contaminating each other's
settings. Single-dataset mode is the CLI-flags-describe-one-dataset case,
served at the root for backward compatibility.

## 3. Routes

| Method & path (single-dataset)   | Method & path (multi-dataset)              | §   |
| -------------------------------- | ------------------------------------------ | --- |
| `GET /health`                    | `GET /health`                              | 3.1 |
| `GET /metadata.json`             | `GET /{dataset}/metadata.json`             | 3.2 |
| —                                | `GET /datasets`                            | 3.3 |
| `GET /tiles/{z}/{x}/{y}/{t}.stt` | `GET /{dataset}/tiles/{z}/{x}/{y}/{t}.stt` | 3.4 |

### 3.1 `GET /health`

Liveness probe. Always `200 OK`, body `ok` (plain text). No dataset lookup —
present in both modes even though it does nothing dataset-specific.

### 3.2 `GET /metadata.json` (or `/{dataset}/metadata.json`)

Returns `200 OK` with a `Content-Type: application/json` body describing the
dataset: its spatial/temporal extent, zoom range, temporal bucket, feature
count, and (if configured) a heatmap domain. It is computed **once at server
startup** from a whole-source SQL aggregate — it does not reflect writes to
the source made after startup. Field shapes are in §4.

In multi-dataset mode, an unknown `{dataset}` segment returns `404 Not Found`
with a plain-text body `unknown dataset '<name>'`.

### 3.3 `GET /datasets` (multi-dataset mode only)

The dataset catalog:

```jsonc
{
  "datasets": [
    {
      "name": "obs",
      "metadata": {
        /* the same object /metadata.json returns for this dataset */
      },
    },
    { "name": "trips", "metadata": { "...": "..." } },
  ],
}
```

Entries are sorted by `name`. Not present in single-dataset mode (there is
nothing to catalog).

### 3.4 `GET /tiles/{z}/{x}/{y}/{t}.stt` (or `/{dataset}/tiles/{z}/{x}/{y}/{t}.stt`)

Generates and returns exactly one tile.

**Path parameters:**

| Param    | Type                                  | Meaning                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `z`      | `u8`                                  | Zoom level (slippy-map convention). Hard-bounded: `z > 31` returns `400` (§3.4.5) — beyond 31 the `2^z` grid exceeds the `u32` x/y space. It is **not** range-checked against `--min-zoom`/`--max-zoom` — a request at an unconfigured (but in-bounds) zoom simply queries and, most likely, encodes an empty tile (§3.4.3). |
| `x`, `y` | `u32`                                 | Tile column/row at `z` (slippy-map convention); must lie in the `2^z` grid — `x ≥ 2^z` or `y ≥ 2^z` returns `400` (§3.4.5).                                                                                                                                                                                                  |
| `t`      | the whole final path segment, as text | A **Unix-ms integer**. A trailing `.stt` suffix (the convention `tileUrlTemplate` in `/metadata.json` advertises) is stripped before parsing, so it is accepted but not required — `.../1700000000000` and `.../1700000000000.stt` are equivalent requests.                                                                  |

`z`, `x`, and `y` are extracted by axum's typed path matching: a segment that
doesn't parse as its declared integer type (non-numeric, or out of `u8`/`u32`
range) never reaches the handler — axum's own path-extraction rejection
applies (`400 Bad Request`, framework-generated body, distinct from the
handler's own `t`-specific `400` below).

#### 3.4.1 Bounding-box resolution

`(z, x, y)` maps to a WGS84 `[min_lon, min_lat, max_lon, max_lat]` box via the
standard Web Mercator slippy-tile formula, then **widened by 5% of the tile's
own span on each side** (~10% wider total) before it is used as the SQL
pre-filter. This buffer exists so a feature that straddles a tile edge is
never missed by the bbox predicate; it is deliberately loose. The exact
per-tile placement (which features actually belong in this tile, including
trajectory clipping) is performed afterward by the same placement code
`stt-build` uses — the buffer only affects which rows the SQL query fetches as
_candidates_, never which end up in the tile.

#### 3.4.2 Temporal bucket resolution

The effective bucket for a request is **not always** `--temporal-bucket`:

1. Start from the base bucket (`--temporal-bucket`, parsed once at startup).
2. If `--temporal-lod` is configured, find every LOD level whose
   `max_zoom_level >= z` ("applies at this zoom") and take the **largest**
   `bucket_ms` among them (coarsest applicable level wins). If none applies,
   the base bucket stands.
3. `t` is floored to a multiple of the effective bucket:
   `bucket_start = floor(max(t, 0) / bucket) * bucket`, and the query window
   is the half-open interval `[bucket_start, bucket_start + bucket)`.
   **A negative `t` is clamped to `0` before flooring** — it is not rejected,
   it lands in the same bucket as `t = 0`.
   `t` need not already be bucket-aligned; the server aligns it. A client
   should still request bucket-aligned values (as `/metadata.json` and any
   `temporalLod` entries describe) so consecutive requests address distinct
   tiles.

When an LOD level applies, the response is generated as if the dataset had
been offline-built with that level's bucket size for this tile — the same
tile a static `stt-build --temporal-lod` archive would serve at that zoom.

#### 3.4.3 Success response

```
200 OK
Content-Type: application/x-stt-tile
Cache-Control: no-store
x-stt-gen-micros: <integer>

<tile bytes>
```

- **Body.** The raw (uncompressed) **layer-frame** payload — the same
  [tile-payload bytes](../architecture/data-format.md) a packed writer would
  zstd-compress into a `packs/*.sttp` blob for this `(z, x, y, t)` and these
  source rows. `stt-serve` performs that encode step but **not** the
  compression step: there is no `Content-Encoding` on the response and no
  compression middleware in front of it, so the bytes on the wire are the
  pre-compression layer frame, not a stored pack blob. A client decodes it
  exactly as it would decode one tile's payload after unwrapping the
  corresponding pack blob's zstd frame.
- **`Content-Type: application/x-stt-tile`.** A custom media type; there is no
  registered IANA type for this payload, and the `x-` prefix is deprecated
  practice. The planned vendor-tree registrations
  ([packed spec §9.2](./stt-packed-format.md#92-media-types--magic-bytes)) will
  add a `vnd.` type for the uncompressed layer frame; when one is registered
  the server will switch and this label retires.
- **`Cache-Control: no-store`.** Explicit and unconditional — see §7.
- **`x-stt-gen-micros`.** Server-side generation time in **microseconds**, as
  a decimal integer string. The clock starts once the request parameters have
  been parsed (before the bucket/bbox math and the source query) and stops the
  instant the tile bytes are ready, so it covers pool checkout + query +
  row/`ValueRef` decode + encode, but excludes parameter parsing, connection
  setup already paid for by a warm pool, and response serialization/network
  time. It is the same header on both backends (backend-agnostic).
- **No CORS headers.** The server sets no `Access-Control-*` headers. A
  browser client on another origin needs a CORS-adding proxy or gateway in
  front of `stt-serve` (the same place TLS and auth belong — see §7).

#### 3.4.4 `204 No Content` — the empty-tile response

No custom headers, no body. Returned whenever the tile has nothing to serve,
which happens for any of three reasons:

1. **No candidate rows.** The bbox+time source query returns zero rows.
2. **Nothing placed.** Rows existed in the buffered bbox, but after exact
   per-tile placement (trajectory clipping, precise point-in-tile test, exact
   bucket membership) none actually belong to this `(z, x, y, t)` — expected,
   since the SQL bbox is a deliberately loose superset (§3.4.1).
3. **Below `--min-features-per-tile`.** Features placed, but fewer than the
   configured minimum (default `1`, so this reason is inert unless the flag is
   raised) — mirrors the offline writer's `--min-features-per-tile` tile-drop.

A conformant client MUST treat `204` as "this tile is legitimately empty," not
as an error — it is the expected response for the (common) case of a sparse
dataset's off-data tiles.

#### 3.4.5 Error responses

| Status                      | Cause                                                                                                                               | Body                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400 Bad Request`           | `z > 31`, or `x`/`y` outside the `2^z` tile grid                                                                                    | `tile out of range: need z <= 31 and x, y < 2^z` (plain text)                                                                                                                               |
| `400 Bad Request`           | `t` does not parse as an integer after stripping a trailing `.stt`                                                                  | `t must be an integer (ms since epoch)` (plain text)                                                                                                                                        |
| `404 Not Found`             | (multi-dataset mode only) `{dataset}` does not match any configured dataset                                                         | `unknown dataset '<name>'` (plain text)                                                                                                                                                     |
| `500 Internal Server Error` | the source query, row decode, or tile encode fails (connection error, malformed SQL from a bad `--sql`/`--where`, encoder error, …) | the fixed string `internal error generating tile` (plain text) — the full `anyhow` error chain (which can contain SQL and connection strings) goes to the server log only, never the client |

Every `500` is also logged server-side (`tracing::error!`) with the failing
`(z, x, y, t)` and the full error chain.

## 4. `/metadata.json` field reference

```jsonc
{
  "format": "stt-postgis-dynamic", // or "stt-duckdb-dynamic"
  "formatVersion": 2,
  "capabilities": [], // e.g. ["coord-quant", "time-delta"]
  "name": "hurricane_obs",
  "boundingBox": [
    [-179.9, -71.2],
    [179.8, 81.0],
  ],
  "timeRange": { "start": 946684800000, "end": 1700000000000 },
  "minZoom": 3,
  "maxZoom": 8,
  "temporalBucketMs": 604800000,
  "featureCount": 48538,
  "tileUrlTemplate": "/tiles/{z}/{x}/{y}/{t}.stt",
  "heatmapDomain": {
    "classes": [
      { "id": "default", "min": 0.0, "max": 4.7, "property": "wind_kt" },
    ],
  },
  "temporalLod": [{ "bucket_ms": 2592000000, "max_zoom_level": 4 }],
}
```

| Key                   | Type                                | Always present?                                        | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format`              | string                              | yes                                                    | `"stt-postgis-dynamic"` or `"stt-duckdb-dynamic"` — identifies the _live_ origin, distinct from the packed manifest's `format: "stt-packed"`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `formatVersion`       | `u32`                               | yes                                                    | The layer-frame version this server emits, mirroring the packed manifest's `formatVersion`. Frames are self-describing to `decode_tile`, but a client that pins a decoder needs to know **before** it fetches. Currently `2` (§8).                                                                                                                                                                                                                                                                                             |
| `capabilities`        | `string[]`                          | yes                                                    | The protocol's **capability channel** — the twin of the packed manifest's `capabilities`, derived from the same `EncoderSettings::required_capabilities()` the offline build declares with. Each entry names an encoder feature that RE-TYPES a tile column, so a client lacking one would silently misdecode rather than error. **Always present**, empty when the server encodes the capability-free shape, so its ABSENCE unambiguously means "server predates this key" rather than "declares nothing". Advisory — see §8. |
| `name`                | string                              | yes                                                    | Resolved dataset name: the `--name` override, else the table name (schema-qualified table's last segment) or `"query"` for a `--sql` source.                                                                                                                                                                                                                                                                                                                                                                                   |
| `boundingBox`         | `[[minLon,minLat],[maxLon,maxLat]]` | yes                                                    | The whole source's spatial extent from a startup `ST_Extent`-style aggregate (reprojected to 4326 first when `--source-srid` is set). Falls back to `[[-180,-90],[180,90]]` if the source is empty.                                                                                                                                                                                                                                                                                                                            |
| `timeRange`           | `{ start, end }` (Unix ms)          | yes                                                    | `MIN`/`MAX` of `--time-field` over the whole source, converted to ms per `--time-format` for an integer time column. Falls back to `{0, 0}` if the source is empty.                                                                                                                                                                                                                                                                                                                                                            |
| `minZoom` / `maxZoom` | `u8`                                | yes                                                    | Echo `--min-zoom` / `--max-zoom`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `temporalBucketMs`    | `u64`                               | yes                                                    | The **base** bucket (`--temporal-bucket`, parsed to ms). Does not reflect per-request LOD widening (§3.4.2) — a client reads `temporalLod` for that.                                                                                                                                                                                                                                                                                                                                                                           |
| `featureCount`        | `i64`                               | yes                                                    | `COUNT(*)` over the whole source at startup — a dataset-wide count, not a per-tile count.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tileUrlTemplate`     | string                              | yes                                                    | Always the literal `"/tiles/{z}/{x}/{y}/{t}.stt"`, **even in multi-dataset mode** — it is not prefixed with `/{dataset}`. A multi-dataset client must prepend the dataset segment itself.                                                                                                                                                                                                                                                                                                                                      |
| `heatmapDomain`       | `{ classes: HeatmapClassDomain[] }` | only if `--heatmap-weight` or `--heatmap-class` is set | See §4.1. Key is **absent** (not `null`) when neither flag is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `temporalLod`         | `TemporalLodLevel[]`                | only if `--temporal-lod` is set                        | The parsed LOD pyramid, so a client can discover which zooms get a coarser bucket. Key is **absent** when `--temporal-lod` is unset. Note: unlike every other key in this object, array elements keep their Rust field names verbatim — `bucket_ms` / `max_zoom_level`, snake_case — because `TemporalLodLevel` has no camelCase rename.                                                                                                                                                                                       |

Every **top-level** key besides the `temporalLod` array's own field names is
camelCase (the loaders.gl `TileSource`-style runtime-descriptor convention),
which deliberately diverges from the packed manifest's snake_case
`heatmap_domain` / `temporal_lod` keys — no client reads the serve response
and the packed manifest with the same code path, so the two are free to use
their own casing conventions.

### 4.1 `heatmapDomain` — computed from `--heatmap-weight` / `--heatmap-class`

Mirrors the packed archive's build-time heatmap domain
(`stt-build --heatmap-weight`/`--heatmap-class`), computed here **once at
startup** via a SQL aggregate over the whole source rather than at build time
over the whole dataset — same shape, live source:

```jsonc
"heatmapDomain": {
  "classes": [
    { "id": "default", "min": 0.0, "max": 4.7, "property": "wind_kt" }
  ]
}
```

| `--heatmap-weight` | `--heatmap-class` | Aggregate                                                                                                         | `classes`                                                                                           |
| ------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| set                | unset             | `min(weight)`, `percentile_cont(0.95)` (Postgres) / `quantile_cont(weight, 0.95)` (DuckDB), over the whole source | one entry, `id: "default"`                                                                          |
| set                | set               | the same aggregate, `GROUP BY` class, `ORDER BY` class, capped at **8** groups                                    | one entry per distinct class value (as `id`), `property` set                                        |
| unset              | set               | `DISTINCT` class values, capped at **8**, `ORDER BY` class                                                        | one entry per value, `min: 1.0, max: 1.0, property: null` (an enumeration, not an intensity domain) |
| unset              | unset             | not computed                                                                                                      | key absent from `/metadata.json`                                                                    |

The percentile is the **database's own continuous percentile function**, which
may differ marginally from the offline build's floor-index percentile — this
is a rendering style hint (the heatmap's color ramp domain), not tile payload
bytes, so the two need not match exactly.

## 5. Backends

|                       | `--postgres <CONN>`                                                                                                                                     | `--duckdb <PATH>`                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine                | PostgreSQL/PostGIS, external server                                                                                                                     | DuckDB, embedded (statically bundled — no system lib, no server)                                                                                                                                                                                                                                                                                                                                         |
| Pool                  | `deadpool_postgres`, async, `NoTls`, `RecyclingMethod::Fast`                                                                                            | `r2d2`, blocking (`duckdb::Connection` is `Send` but `!Sync`)                                                                                                                                                                                                                                                                                                                                            |
| `--pool-size`         | `deadpool_postgres::Pool` `max_size`                                                                                                                    | `r2d2::Pool` `max_size`, with the CLI value itself clamped to a minimum of `1` before it reaches the pool builder                                                                                                                                                                                                                                                                                        |
| Env fallback          | `STT_POSTGRES_URL`, then `DATABASE_URL`                                                                                                                 | `STT_DUCKDB_PATH`                                                                                                                                                                                                                                                                                                                                                                                        |
| Per-request execution | runs on the async reactor for the query; row decode + tile encode are CPU-bound and run on `spawn_blocking`                                             | pool checkout, query, decode, **and** encode all run on one `spawn_blocking` worker (nothing about DuckDB is async)                                                                                                                                                                                                                                                                                      |
| Extra setup           | none beyond the pool                                                                                                                                    | every **new physical connection** (not every checkout) runs `INSTALL spatial; LOAD spatial; SET TimeZone='UTC';` — a one-time network fetch for the extension, cached under `~/.duckdb`, and UTC pinning so `epoch_ms`/`ST_AsWKB` math is timezone-independent                                                                                                                                           |
| File access           | n/a (server-managed)                                                                                                                                    | a real `.duckdb` file opens **read-only** (never mutates the source, coexists with another process holding it); `:memory:` (or an empty path) opens a **fresh in-memory database**, logged with a warning that pooled connections share one in-memory DB via `try_clone` starting empty — only a `--sql` that scans external files (e.g. `read_parquet(...)`) works there, not a pre-existing table name |
| Malformed rows        | both backends decode with `InputStrictness::Warn` — a row that fails to parse is warned about and coerced/dropped rather than failing the whole request | (same)                                                                                                                                                                                                                                                                                                                                                                                                   |

`--postgres` and `--duckdb` are mutually exclusive; `stt-serve` refuses to
start if both (or neither, with no env fallback resolving one) are given.

At startup, both backends additionally probe the source's **result schema**
(DuckDB: a `LIMIT 0` execution of the tile projection; PostGIS: a statement
prepare) to pin each property column's tile kind — the same schema-pinning an
offline GeoParquet build derives from the Parquet schema — so a column that
happens to be all-NULL within one tile still gets its (all-null) column there
instead of drifting the layer schema across tiles. A failed probe logs a
warning and falls back to per-tile value sniffing.

## 6. Multi-dataset `--config` file

```jsonc
{
  "datasets": [
    {
      "name": "obs",
      "postgres": "postgresql://x",
      "table": "hurricane_obs",
      "time-field": "iso_time",
      "temporal-bucket": "7d",
      "quantize-coords": 50.0,
    },
    {
      "name": "trips",
      "duckdb": "trips.duckdb",
      "sql": "SELECT * FROM t",
      "geom-column": "the_geom",
      "time-format": "unix-ms",
      "min-zoom": 2,
      "max-zoom": 10,
    },
  ],
}
```

- Every dataset entry accepts the **same fields as the CLI flags**, keyed by
  the flag's kebab-case name (`temporal-bucket`, not `temporal_bucket`). A
  field a dataset entry omits falls back to the same default the CLI flag
  would use — there is one source of defaults (the `clap` definitions), shared
  by both parse paths.
- Unknown keys are rejected (a typo'd field name fails to parse the config
  file, rather than being silently ignored).
- `name` is optional per dataset — omitting it derives one from `--table`
  (the part after the last `.`, e.g. `public.obs` → `obs`) or `query` for
  `--sql`. Whatever name is used (explicit or derived) MUST be unique within
  the file — a duplicate name fails at startup before the server binds.
- `--config` itself is CLI-only (not a field a config entry can set).

## 7. Caching semantics

| Route                                            | `Cache-Control`                                     |
| ------------------------------------------------ | --------------------------------------------------- |
| `GET /tiles/…`                                   | `no-store`, set explicitly on every `200` response  |
| `GET /metadata.json`, `/{dataset}/metadata.json` | none set — no explicit caching directive either way |
| `GET /datasets`, `GET /health`                   | none set                                            |

Tiles are **regenerated on every request**; there is no server-side response
cache and no on-disk artifact analogous to a pack. This is the deliberate
live-source trade-off: a pre-baked [packed archive](./stt-packed-format.md) is
content-addressed and edge-cacheable forever, while `stt-serve` trades that
away for always-current data. A reverse proxy or CDN placed in front of
`stt-serve` can still cache individual `(z, x, y, t)` responses on its own
terms (the explicit `no-store` only governs _this_ server's own intent, not
what an intermediary is permitted to layer on top) — see
[`db-input-adaptors.md` §6.3](../roadmap/db-input-adaptors.md#63-when-to-use-which)
for when a pre-bake is the better fit than dynamic serving.

## 8. Generation-parity contract

`stt-serve` and `stt-build` parse the **same flags** through the same
`stt_build::build_options` module into the same `TileConfig` /
`EncoderConfig` types, and both call the same per-tile encode path
(`encode_single_tile_counted`, backing `encode_tile_with`) — so a served tile
for a given `(z, x, y, t)` is generated by the identical code the offline
writer would use for that tile, over the same source rows. The full list of
shared per-tile flags (clip, simplify, pre-tessellate, min-/max-zoom-field,
per-tile budgets, attribute filter) and encoder-global flags
(`--quantize-*`, `--vector-group`, `--point-elevation-column`,
`--vertex-time-precision`) is in
[`cli-reference.md`](../api/cli-reference.md#stt-serve); the design rationale
for the shared seam is in
[`db-input-adaptors.md` §3](../roadmap/db-input-adaptors.md#3-serve-parity-with-the-offline-build).

Two features are **rejected at startup** (a clear error, not a runtime
failure per request) because a single tile's rows cannot answer them:

- `--summary-tier` — cross-tile H3/quadbin aggregation spans many spatial
  tiles by construction.
- `--adaptive-temporal` — its window size is chosen from a cell's _whole_ time
  range, not a single bucket's rows.

Both must be pre-baked with `stt-build` and served as a static archive
instead.

**Frame version: serve emits `formatVersion` 2** with **inline schemas**
([data-format.md §Layer frame](../architecture/data-format.md#layer-frame)).
Inline is the only v2 mode that makes sense for a manifest-less server — there
is nowhere to carry a `schemas` registry — and since responses are `no-store`
(§7), the template amortization the registry buys would be dead weight anyway.
The frame version is advertised as `formatVersion` on `/metadata.json` (§4), and
the encoder features that re-type a column are advertised alongside it as
`capabilities`. Both are written from the same `EncoderSettings` that produces
the bytes, so the declaration cannot drift from the tile.

That channel is **advisory, not enforcing**: a packed archive lets an
under-capable reader refuse the dataset at open, but nothing makes an HTTP
client read `/metadata.json` before fetching a tile. This is why serve
**inverts the offline default for every re-typing feature** — `--compact-times`
is opt-in here and on by default in `stt-build` — so the out-of-the-box server
emits the shape an older decoder reads correctly, and the byte-saving shape is
something an operator turns on once they control their clients.

Byte parity is therefore scoped by **encoder settings, not format version**: a
served tile is byte-identical to the offline tile of a build carrying the same
encoder flags. Out of the box that is a `--no-compact-times` build, because
compact times are the one default the two sides disagree on.

Non-4326 source geometry is served via `--source-srid <SRID>` (mirroring
`stt-build --source-srid` at ingest): every per-tile query reprojects the
stored geometry to 4326 **before** both the bbox filter and the WKB
projection (DuckDB: `ST_Transform(geom, 'EPSG:<srid>', 'EPSG:4326')` with
`always_xy`; PostGIS: `ST_Transform(ST_SetSRID(geom, <srid>), 4326)` — the
exact ingest expressions), and the startup metadata extent is reprojected the
same way, so advertised bounds and served tiles are always lon/lat. The
trade-off: the per-row transform bypasses a plain spatial index on the raw
column, so tile queries scan without index help — on PostGIS a functional
index on the transform expression restores index use; on either engine,
storing 4326 remains the fast path.

## 9. Relationship to the rest of the spec

- The response body for `GET /tiles/…` is one instance of the
  [tile payload](../architecture/data-format.md) format — the same
  layer-frame bytes a [packed archive](./stt-packed-format.md) stores
  zstd-compressed per tile. Nothing about the payload's Arrow/GeoArrow shape
  differs between a dynamically-served tile and a pre-built pack's tile blob;
  only the transport-level compression is absent here (§3.4.3).
- `stt-serve` produces no `manifest.json` and is out of scope for
  [`stt-validate`](./conformance.md) and the
  [directory/paging conformance requirements](./conformance.md) — those apply
  to the packed container this server does not write.
- See [`sidecar-assets.md`](./sidecar-assets.md) for the unrelated notion of
  _sidecar_ (non-tile) files in a scene bundle — `stt-serve` has no sidecar
  concept; every response is either a tile or the dataset descriptor.
