# System overview

STT has two stacks: a **Rust** toolchain that turns GeoParquet into a `.stt`
archive, and a **TypeScript** client that streams tiles from that archive
into deck.gl.

```mermaid
graph TD
    subgraph "Input data"
        PARQUET[GeoParquet]
    end

    subgraph "Rust toolchain"
        BUILD[stt-build]
        OPTIMIZE[stt-optimize]
        VALIDATE[stt-validate]
        GEN[stt-generate]
        CORE_RS[stt-core]
        BUILD --> CORE_RS
        OPTIMIZE --> CORE_RS
        VALIDATE --> CORE_RS
        GEN --> BUILD
    end

    subgraph "Storage"
        STT["(.stt) archive"]
    end

    subgraph "Client (browser)"
        ARCHIVE["@stt/core: STTArchive"]
        DECODER["WorkerTileDecoder pool"]
        TILESET[SpatiotemporalTileset]
        LAYERS["@stt/deck.gl layers"]
        ARCHIVE --> DECODER
        DECODER --> TILESET
        TILESET --> LAYERS
    end

    PARQUET --> BUILD
    BUILD --> STT
    STT -->|HTTP Range| ARCHIVE
```

## Rust toolchain

### `stt-build` (CLI)
Reads a GeoParquet file (WKB, GeoArrow, or `lon`/`lat` columns) and writes
one `.stt` archive. Pipeline:

1. **Load**: stream Arrow record batches from Parquet; extract geometry,
   timestamps (Unix ms, Unix s, or ISO 8601), and per-feature properties.
2. **Clip**: LineStrings with a duration (`--end-time-field`) are clipped
   to each zoom's tile boundaries with Liang-Barsky; per-vertex timestamps
   are interpolated so a tile's trajectory still animates correctly.
3. **Simplify** (optional): per-zoom Visvalingam-Whyatt simplification.
4. **Tile**: bucket features by `(zoom, x, y, time-bucket)`, where the
   bucket size is `--temporal-bucket` (default `1h`).
5. **Encode**: each tile becomes an Arrow IPC layer frame (see
   [Data format](./data-format.md)).
6. **Write**: `stt-core::Archive::create()` → gzip → content-addressed
   dedup → write directory + JSON metadata + 64-byte header.

Inputs must be GeoParquet. Convert other formats first:
`ogr2ogr -f Parquet out.parquet in.geojson`, or use DuckDB
(`COPY ... TO 'out.parquet' (FORMAT 'parquet')`).

### `stt-optimize`
Reads a Parquet or `.stt` and prints recommended `stt-build` settings —
zoom range, temporal bucket size, compression — based on the data's
spatial density and temporal distribution. Standalone today; can be invoked
in a future `stt-build --auto`.

### `stt-validate`
Opens an archive, verifies the content hash of every tile, decodes each
Arrow IPC payload, and reports any anomalies (decode failures, feature-count
mismatches, tile extents outside the metadata range). Suitable for CI.

### `stt-generate`
Convenience CLI that downloads + processes + builds the showcase datasets
(earthquakes, AIS, flights, hurricanes, wildfires, NYC rideshare, satellites).
Each subcommand emits GeoParquet and calls `stt-build` internally.

### `stt-core`
The library every CLI uses. Owns the archive format, Arrow tile codec,
compression abstraction, Hilbert/temporal indexing, and metadata.

## TypeScript stack

### `@stt/core`
- **`STTArchive`** — HTTP Range reader. Header → index → metadata → per-tile
  blob fetch. Range-coalesces adjacent tile reads (≤32 KiB gap). Caches
  compressed bytes (device-aware sizing: 512 MiB desktop, 256 MiB mobile).
- **`TileDecoder`** — see [stt-loader.md](../api/stt-loader.md). Worker-pool
  by default in browsers; inline fallback elsewhere. Crashed workers are
  replaced automatically.
- **`SpatiotemporalTileset`** — viewport + time-aware tile selection,
  bucket-aligned prefetch, direction hysteresis to suppress scrub jitter,
  grace-period LRU eviction.

### `@stt/deck.gl`
- **`SpatioTemporalLayer`** — composite layer; owns the archive + tileset,
  delegates rendering to specialized sublayers.
- **`AnimatedPointLayer` / `AnimatedPathLayer` / `AnimatedPolygonLayer` /
  `AnimatedTripsLayer`** — deck.gl layers with GPU time filtering.
- **`TimeFilterExtension`** — relativizes time against a per-layer
  `timeOffset` so f32 stays exact; supports window mode (whole feature on
  / off) and trail mode (per-vertex fade).
- **`CategoryColorExtension`** — texture-based palette lookup, scales to
  many categories without CPU-side color expansion.
- **`TimeController`** — `requestAnimationFrame`-driven playback clock.

## Design decisions

### Arrow IPC instead of a bespoke binary format
Standard, columnar, browser-native via `apache-arrow`. The same library
parses the archive's directory and its tile payloads. GeoArrow gives the
deck.gl layers exactly the buffer shape they need.

### Custom tileset, not deck.gl `TileLayer`
- 4D addressing — `(z, x, y, t)` — that `TileLayer` doesn't model.
- Bucket-aligned temporal prefetch needs first-class access to the time axis.
- Cache eviction needs to be temporal-aware (keep tiles for the active
  time window even when they're off-viewport for a frame).

### GPU time filtering, not CPU per-frame filtering
Once a tile is consolidated into the deck.gl layer's attribute buffers,
animation costs nothing extra. The CPU updates one uniform per frame; the
shader does the filter and the fade.

### One archive, one HTTP origin
A `.stt` file is served as static bytes by any HTTP server that honours
Range requests. No tile server, no database, no CDN smarts beyond
range-aware caching.

## Key interactions

1. **Generation** — run `stt-build` once to convert GeoParquet into a `.stt`.
2. **Hosting** — drop the `.stt` on S3, R2, Cloudflare Pages, nginx, etc.
3. **Loading** — the browser fetches the 64-byte header, then the index
   table and metadata, then each viewport tile via a Range request.
4. **Streaming** — as the user pans or plays the timeline, the tileset
   coalesces ranges, the decoder pool decodes off the main thread, and
   deck.gl renders the consolidated buffers with the time filter applied.
