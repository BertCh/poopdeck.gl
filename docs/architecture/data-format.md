# Data Format Specification

The Spatiotemporal Tile (`.stt`) format is a custom binary archive format designed for efficient random access of spatiotemporal data. It combines a spatial index with a temporal index to allow clients to fetch only the data required for a specific map view and time window.

## File Structure

A `.stt` file is composed of four main sections:

| Section | Description | Size |
|---------|-------------|------|
| **Header** | Magic bytes, version, and offsets to indices. | Fixed (e.g., 64 bytes) |
| **Metadata** | JSON blob with dataset info (bounds, time range, etc.). | Variable |
| **Index** | Spatial and Temporal indices for looking up tiles. | Variable |
| **Tiles** | The compressed binary tile data. | Majority of file |

### 1. Header
The header allows the reader to locate the Index and Metadata without reading the whole file.

```rust
struct ArchiveHeader {
    magic: [u8; 4],      // "STT\0"
    version: u8,         // Format version (currently 1)
    index_offset: u64,   // Byte offset to start of Index
    index_length: u64,   // Length of Index in bytes
    metadata_offset: u64,// Byte offset to start of Metadata
    metadata_length: u64,// Length of Metadata in bytes
}
```

### 2. Tiles (Protocol Buffers)
Each tile is a Protocol Buffer message compressed with **Brotli**. The schema is defined in `proto/tile.proto`.

#### `Tile` Message
```protobuf
message Tile {
  uint32 version = 1;
  uint64 time_start = 2;
  uint64 time_end = 3;
  repeated Layer layers = 4;
  
  // Hints for interpolation
  Interpolation interpolation = 5;
  
  // Metadata about bucket size and suggested playback speed
  TemporalResolution temporal_resolution = 6;
}
```

#### `Feature` Message (with Delta Encoding)
Features use delta encoding to minimize size. Coordinates are often zig-zag encoded integers relative to the tile origin (similar to Mapbox Vector Tiles).

```protobuf
message Feature {
  uint64 id = 1;
  GeomType type = 2;
  
  // Geometry commands (MoveTo, LineTo) + Coordinates
  repeated uint32 geometry = 3 [packed=true];
  
  // Property tags (Key Index, Value Index)
  repeated uint32 tags = 4 [packed=true];
  
  // Change tracking
  ChangeType change = 8; // UNCHANGED, CREATED, MODIFIED, DELETED
  uint64 previous_hash = 7;
}
```

### 3. Index
The index maps a `(Zoom, X, Y, Time)` tuple to a byte offset and length in the file.

- **Spatial Layout:** Tiles are typically written in Hilbert Curve order to maximize spatial locality.
- **Temporal Lookup:** The index allows querying for "all tiles at Zoom Z overlapping Time T".

## Coordinate System
- **Projection:** Web Mercator (EPSG:3857).
- **Tile Grid:** Standard Google/OSM tiling scheme.
- **Internal Coordinates:** Within a tile, coordinates are integers (0-4096 typically) relative to the tile's top-left corner.

## Compression
- **Geometry:** Delta encoded zig-zag integers.
- **Properties:** Dictionary encoded (keys and values stored once per layer).
- **Tile:** The entire serialized Tile message is compressed using Brotli (default) or Gzip.

