# Data Format Specification

The Spatiotemporal Tile (`.stt`) format is a custom binary archive format designed for efficient random access of spatiotemporal data. It combines a spatial index with a temporal index to allow clients to fetch only the data required for a specific map view and time window.

## File Structure

A `.stt` file is composed of four main sections:

| Section      | Description                                              | Size             |
| ------------ | -------------------------------------------------------- | ---------------- |
| **Header**   | Magic bytes, version, and offsets to indices.            | Fixed (53 bytes) |
| **Tiles**    | The compressed binary tile data.                         | Majority of file |
| **Index**    | Spatial and Temporal indices for looking up tiles.       | Variable         |
| **Metadata** | Proto blob with dataset info (bounds, time range, etc.). | Variable         |

### 1. Header

The header allows the reader to locate the Index and Metadata without reading the whole file.

```rust
struct ArchiveHeader {
    magic: [u8; 4],      // "STT\x01"
    version: u8,         // Archive format version
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
  uint32 version = 1;      // Always 2
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
  ColumnarFeatures columnar = 4;
}
```

#### `ColumnarFeatures` Message

Features use columnar layout with quantized coordinates for GPU-optimized rendering.

```protobuf
message ColumnarFeatures {
  uint32 feature_count = 1;
  GeomType geometry_type = 2;

  // Feature IDs as flat array
  repeated uint64 feature_ids = 3 [packed = true];

  // Quantized geometry (delta-encoded)
  repeated sint32 geometry = 4 [packed = true];
  repeated uint32 geometry_offsets = 5 [packed = true];

  // Temporal data (delta-encoded)
  repeated sint64 start_times = 6 [packed = true];
  repeated sint64 end_times = 7 [packed = true];

  // Properties (columnar layout)
  repeated NumericColumn numeric_properties = 8;
  repeated CategoricalColumn categorical_properties = 9;
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
- **Internal Coordinates:** Quantized tile-relative integers (MVT-style).

## Compression

- **Geometry:** Delta-encoded quantized coordinates (~2-4 bytes per coordinate).
- **Properties:** Columnar typed arrays with dictionary encoding for strings.
- **Tile:** The serialized Tile message is compressed using Gzip.

## Format Details

### Coordinate Quantization (MVT-style)

Coordinates are quantized to tile-relative integers and delta-encoded:

```protobuf
// ~2-4 bytes per coordinate (delta + varint)
repeated sint32 geometry = 4 [packed = true];  // [dx, dy, dx, dy, ...]
```

### Columnar Properties

Properties are stored in columnar format for efficient GPU upload:

```protobuf
// Numeric properties as typed arrays
repeated NumericColumn numeric_properties = 8;

// Categorical properties with dictionary encoding
repeated CategoricalColumn categorical_properties = 9;
```

### Generating Tiles

```bash
stt-build -i data.geojson -o output.stt
```

## Design Philosophy

The format prioritizes performance and compatibility with deck.gl:

1. **GPU-Optimized**: Quantized coordinates and columnar layout for efficient GPU upload.

2. **Size-Based Chunking**: Tiles are chunked by estimated byte size to ensure consistent network transfer times.

3. **Direct deck.gl Compatibility**: Features can be passed directly to deck.gl layers with minimal transformation.

4. **HTTP Range Requests**: The archive structure supports efficient random access via HTTP Range Requests.
