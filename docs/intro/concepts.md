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

### 1. Chunked Feature Storage
Each tile now stores absolute WGS84 coordinates for the features that intersect it. There is no delta or zig-zag encoding—tiles are literally **chunks of the source dataset** broken up by `(zoom, x, y, time)`. This makes the format easy to debug (you can dump a tile and immediately see lon/lat values) and keeps the refactor focused on correctness over extreme compression.

### 2. Temporal Bucketing
Not all data needs millisecond precision. **Temporal Bucketing** allows grouping updates into discrete time slots (e.g., 1 second, 1 hour, 1 day) based on the zoom level.

- **Zoom 0-3 (World):** Daily or Monthly buckets.
- **Zoom 14 (Street):** Second-level precision.

This acts as a "Temporal Level of Detail" (LOD), ensuring you don't load millisecond-precision data when viewing the entire globe.

### 3. Spatial Indexing (Hilbert Curve)
Tiles are stored in the archive using a **Hilbert Space-Filling Curve**. This ensures that tiles that are spatially close (neighbors on the map) are also close in the file byte stream.

- **Benefit:** Improves HDD/SSD read performance and enables efficient range requests.

## Client-Side Rendering

### Optimistic Rendering
The STT client implementation (`@stt/core`) is designed for smooth animation. It employs **Optimistic Rendering**:
- It immediately displays whatever data is available in the cache.
- It fetches higher-resolution or adjacent temporal data in the background.
- It never blocks the animation loop waiting for network requests.

### Predictive Prefetching
When you play an animation, the client predicts which tiles will be needed next (e.g., $t+1, t+2$) and fetches them ahead of time. This ensures 60 FPS playback even on constrained networks.

