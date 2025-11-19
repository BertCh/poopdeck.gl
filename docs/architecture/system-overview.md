# System Overview

The Spatiotemporal Tiles (STT) system consists of two main technology stacks: a **Rust** backend for high-performance data processing and tile generation, and a **TypeScript** frontend for efficient web-based rendering.

## Architecture Diagram

```mermaid
graph TD
    subgraph Input Data
        CSV[CSV Files]
        GEO[GeoJSON]
        DB[(PostGIS)]
    end

    subgraph Rust Toolchain
        CLI[stt-build CLI]
        LIB[stt-core]
        CLI --> LIB
    end

    subgraph Storage
        STT[".stt" Archive]
        IDX[Index & Metadata]
        STT --- IDX
    end

    subgraph Client (Browser)
        Loader[@stt/core]
        Cache[LRU Cache]
        Layer[@stt/deck.gl]
        
        Loader --> Cache
        Cache --> Layer
    end

    CSV --> CLI
    GEO --> CLI
    DB --> CLI
    
    CLI --> STT
    STT --> Loader
```

## Rust Toolchain (Generation)

The Rust stack is responsible for ingesting raw data and producing optimized `.stt` archives.

### `stt-build`
The primary CLI tool. It performs the following steps:
1.  **Ingest:** Reads streams of GeoJSON, CSV, or DB rows.
2.  **Parse & Bucket:** Parses timestamps and groups features into spatial tiles and temporal buckets.
3.  **Simplification:** Applies Douglas-Peucker simplification to geometries based on zoom level.
4.  **Delta Encoding:** Calculates changes between consecutive time steps to remove redundancy.
5.  **Compression:** Encodes data using Protocol Buffers and compresses with Brotli.
6.  **Indexing:** Generates a Hilbert-curve based spatial index and a temporal index.

### `stt-core`
The shared library containing the logic for:
- Protocol Buffer definitions (`proto/tile.proto`).
- Coordinate projection (Web Mercator).
- Geometry math and quantization.
- File I/O and archive structure.

## TypeScript Stack (Consumption)

The TypeScript stack runs in the browser and handles the efficient loading and rendering of the data.

### `@stt/core`
The core loader library.
- **`STTArchive`**: Handles HTTP Range Requests to fetch only specific byte ranges from the `.stt` file.
- **`SpatiotemporalTileset`**: Manages the lifecycle of tiles, including loading, caching, and eviction.
- **`STTLoader`**: A loaders.gl compatible loader for parsing the binary tile format.

### `@stt/deck.gl`
The rendering layer for [deck.gl](https://deck.gl).
- **`SpatioTemporalLayer`**: A composite layer that handles time synchronization.
- **`AnimatedPointLayer`**: Renders points with interpolation.
- **`TimeController`**: Manages the playback clock, speed, and looping.

## Key Interactions

1.  **Generation:** You run `stt-build` once to convert your massive CSV/GeoJSON into a single `.stt` file.
2.  **Hosting:** You host the `.stt` file on any static file server (S3, Nginx, etc.). No special backend is required.
3.  **Loading:** The browser client downloads the header (first few KB) to get the index.
4.  **Streaming:** As the user pans or plays the timeline, the client calculates which byte ranges to fetch and requests them in parallel.

