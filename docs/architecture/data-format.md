# Data Format Specification

The Spatiotemporal Tile (`.stt`) format is a custom binary archive format designed for efficient random access of spatiotemporal data. It combines a spatial index with a temporal index to allow clients to fetch only the data required for a specific map view and time window.

## Format Versions

- **Version 1** (Original): Absolute WGS84 coordinates, per-feature properties
- **Version 2** (New): Quantized tile-relative coordinates, columnar properties

## File Structure

A `.stt` file is composed of four main sections:

| Section | Description | Size |
|---------|-------------|------|
| **Header** | Magic bytes, version, and offsets to indices. | Fixed (53 bytes) |
| **Tiles** | The compressed binary tile data. | Majority of file |
| **Index** | Spatial and Temporal indices for looking up tiles. | Variable |
| **Metadata** | Proto blob with dataset info (bounds, time range, etc.). | Variable |

### 1. Header
The header allows the reader to locate the Index and Metadata without reading the whole file.

```rust
struct ArchiveHeader {
    magic: [u8; 4],      // "STT\x01"
    version: u8,         // Format version (currently 1)
    index_offset: u64,   // Byte offset to start of Index
    index_length: u64,   // Length of Index in bytes
    metadata_offset: u64,// Byte offset to start of Metadata
    metadata_length: u64,// Length of Metadata in bytes
    reserved: [u8; 16],  // Reserved for future use
}
```

### 2. Tiles (Protocol Buffers)
Each tile is a Protocol Buffer message compressed with **Gzip**. The schema is defined in `proto/tile.proto`.

#### `Tile` Message
```protobuf
message Tile {
  uint32 version = 1;
  uint64 time_start = 2;
  uint64 time_end = 3;
  repeated Layer layers = 4;
}
```

#### `Layer` Message
```protobuf
message Layer {
  string name = 1;
  uint32 extent = 2;
  repeated Feature features = 3;
}
```

#### `Feature` Message
Each feature stores absolute WGS84 positions. There is no delta or zig-zag encoding—the tile is simply a chunk of time-sorted GeoJSON features.

```protobuf
message Feature {
  uint64 id = 1;
  GeomType type = 2;
  repeated Position positions = 3;
  map<string, Value> properties = 4;
  uint64 valid_from = 5;
  uint64 valid_to = 6;
}

message Position {
  double lon = 1;
  double lat = 2;
}
```

### 3. Index
The index maps a `(Zoom, X, Y, Time)` tuple to a byte offset and length in the file.

- **Spatial Layout:** Tiles are written in Hilbert Curve order to maximize spatial locality.
- **Temporal Lookup:** The index allows querying for "all tiles at Zoom Z overlapping Time T".

### 4. Metadata
Contains dataset-level information:
- Geographic bounds
- Time range
- Zoom levels (min/max)
- Layer information

## Coordinate System
- **Projection:** Web Mercator (EPSG:3857) for tiling.
- **Tile Grid:** Standard Google/OSM tiling scheme.
- **Internal Coordinates:** Features store absolute WGS84 lon/lat as doubles.

## Compression
- **Version 1 Geometry:** Stored as full-precision longitude/latitude pairs.
- **Version 2 Geometry:** Delta-encoded quantized coordinates (4-8x smaller).
- **Properties:** V1: inline per feature. V2: columnar typed arrays.
- **Tile:** The serialized Tile message is compressed using Gzip.

## Version 2 Format Details

Version 2 provides significant improvements for GPU rendering:

### Coordinate Quantization (MVT-style)
```protobuf
// V1: 16 bytes per coordinate
message Position {
  double lon = 1;  // 8 bytes
  double lat = 2;  // 8 bytes
}

// V2: ~2-4 bytes per coordinate (delta + varint)
repeated sint32 geometry = 4 [packed = true];  // [dx, dy, dx, dy, ...]
```

### Columnar Properties
```protobuf
message ColumnarFeatures {
  uint32 feature_count = 1;
  
  // All positions in one array (GPU buffer ready)
  repeated sint32 geometry = 4 [packed = true];
  
  // All timestamps in one array
  repeated sint64 start_times = 6 [packed = true];
  
  // Numeric properties as typed arrays
  repeated NumericColumn numeric_properties = 8;
  
  // Categorical properties with dictionary encoding
  repeated CategoricalColumn categorical_properties = 9;
}
```

### Generating V2 Tiles

```bash
stt-build -i data.geojson -o output.stt --v2
```

## Design Philosophy

The format prioritizes simplicity and compatibility with deck.gl:

1. **Version 1**: Simple format with absolute coordinates for easy debugging.

2. **Version 2**: GPU-optimized format with quantized coordinates and columnar layout.

3. **Size-Based Chunking**: Tiles are chunked by estimated byte size to ensure consistent network transfer times.

4. **Direct deck.gl Compatibility**: Features can be passed directly to deck.gl layers with minimal transformation.

5. **HTTP Range Requests**: The archive structure supports efficient random access via HTTP Range Requests.
