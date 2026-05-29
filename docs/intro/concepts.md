# Core Concepts

This guide introduces the fundamental concepts behind Spatiotemporal Tiles (STT).

## What is a Spatiotemporal Tile?

A **Spatiotemporal Tile** is a unit of data that organizes geospatial features not just by space (X, Y coordinates at a Zoom level) but also by **Time**. Unlike traditional vector tiles (MVT) which are static snapshots, an STT contains a time-ordered sequence of feature states.

Each tile represents:
- A specific spatial bounds (Web Mercator tile).
- A specific time interval (start time to end time).
- A collection of features that exist within that space-time volume.

### Why add Time?

Traditional approaches to animating massive datasets (millions of points) usually involve:
1.  **Loading everything:** Heavy memory usage, slow initial load.
2.  **GeoJSON per frame:** Huge network overhead, redundant data.
3.  **Filtering static tiles:** CPU intensive on the client to filter millions of points every frame.

STT solves this by pre-indexing data temporally. The client only downloads data relevant to the current time window and animation speed.

## Key Concepts

### 1. Apache Arrow IPC + GeoArrow tile payloads
Each tile is one Apache Arrow `RecordBatch` per layer, with geometry
encoded as standard **GeoArrow** (interleaved `[x, y]` Float64 inside a
`FixedSizeList`). Coordinates are absolute WGS84 — no delta or zig-zag
encoding — so a tile is "a chunk of the source dataset, broken up by
`(zoom, x, y, time)`" and can be inspected with any Arrow tool. zstd
(default) or gzip on the IPC bytes does the size compression. The
client only needs one library (`apache-arrow`) to decode both the
directory and the tile payloads.

### 2. Temporal Bucketing
Not all data needs millisecond precision. **Temporal Bucketing** groups
features into fixed-width time slots — the same bucket size everywhere
in the archive, configurable as `--temporal-bucket` (default `1h`).
Bucket boundaries become the cache-hit pivot for predictive prefetch
during animation.

### 3. Temporal LOD pyramid
For multi-year datasets you'd animate at fine bucket resolution, the
build can emit one or more coarser-bucket tiers alongside the base
(`--temporal-lod 1d,30d` or `1d@8,30d@4`). The **reader API** can pick the
coarsest tier whose `max_zoom_level` covers the current zoom
(`STTArchive.pickTemporalLodForZoom` + `getTilesInBoundsForTemporalLod`) —
so "zoomed out, scrubbing a decade" can read 30-day aggregates instead of
streaming per-hour base tiles. Note: this is reader-API-only today — the
tileset and renderers do not yet dispatch temporal LOD automatically, so an
app must call these methods itself to use the coarser tiers. (The summary
tier below, by contrast, is wired into the tileset.)

### 4. Summary tier (server-side aggregation)
For 100M+ point datasets, a `--summary-tier h3` build emits a
server-aggregated H3-hex tier alongside the raw tier. Each hex carries a
`count` plus any configured `name:agg` (mean / sum / max / min) columns.
The reader dispatches to summary tiles below the configured zoom
threshold, so low-zoom rendering never streams the raw points.

### 5. Spatial Indexing (Hilbert Curve)
Tiles are stored in the archive using a **Hilbert Space-Filling Curve**.
Spatially-neighbouring tiles end up adjacent in the file, so the reader's
range-coalescer often satisfies several tiles with one HTTP Range
request — important for CDN cacheability and total request count under
viewport pans.

## Client-Side Rendering

### Optimistic Rendering
The STT client implementation (`@stt/core`) is designed for smooth animation. It employs **Optimistic Rendering**:
- It immediately displays whatever data is available in the cache.
- It fetches higher-resolution or adjacent temporal data in the background.
- It never blocks the animation loop waiting for network requests.

### Predictive Prefetching
When you play an animation, the client predicts which tiles will be needed next (e.g., $t+1, t+2$) and fetches them ahead of time. This ensures 60 FPS playback even on constrained networks.

