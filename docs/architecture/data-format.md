# STT v3 file format

The Spatiotemporal Tile (`.stt`) format is a single-file archive that combines
a spatial tile pyramid with a temporal axis. Tile payloads are **Apache Arrow
IPC** record batches with **GeoArrow**-encoded geometry, so a browser can
decode a tile with one library (`apache-arrow`) and feed the resulting
columnar buffers directly to deck.gl.

This document is the normative spec. The Rust authority is
`crates/stt-core/src/archive.rs` and `crates/stt-core/src/arrow_tile.rs`; the
TypeScript reader lives in `packages/core/src/archive.ts`. If this document
and the code disagree, the code wins — please open a PR.

## Top-level layout

```
┌─────────────────────────┐  offset 0
│ Header (64 bytes)       │  fixed-size, little-endian
├─────────────────────────┤
│ Tile blobs              │  compressed Arrow IPC layer frames
│ ...                     │  one HTTP range request per tile
├─────────────────────────┤
│ Dictionary (optional)   │  zstd training dictionary shared across tiles
├─────────────────────────┤
│ Index (Arrow IPC)       │  the directory — one row per tile
├─────────────────────────┤
│ Metadata (UTF-8 JSON)   │  human-inspectable; serde-versioned
└─────────────────────────┘  offset = file length
```

Every byte after the header is addressable by `(offset, length)` pairs that
live in the header itself, so a reader can fetch the header, then the
dictionary (if present), index and metadata, then each tile, with O(1) range
requests per addressable unit.

## Magic and version

The first four bytes are the magic number; the trailing byte is the format
version.

| Magic        | Version | Status                                              |
| ------------ | ------- | --------------------------------------------------- |
| `STT\x01`    | 1       | retired (pre-Arrow protobuf tiles)                  |
| `STT\x02`    | 2       | legacy (gzip + BLAKE3-64 dedup, no dictionary slot) |
| `STT\x03`    | 3       | **current** (zstd + CRC32C, optional dictionary)    |

Both v2 and v3 share the 64-byte header layout — v2 readers/writers simply
treat the v3 `dictionary_offset` / `dictionary_length` fields as zero
(they fall inside what v2 calls "reserved"). Readers MUST refuse archives
whose version they do not understand.

## Header (64 bytes, little-endian)

```rust
struct ArchiveHeader {
    magic: [u8; 4],             // "STT\x03" (or "STT\x02" for legacy)
    version: u8,                // 3
    compression: u8,            // 0 = none, 1 = gzip, 2 = zstd
    index_offset: u64,          // start of Index, bytes from file start
    index_length: u64,
    metadata_offset: u64,       // start of Metadata
    metadata_length: u64,
    dictionary_offset: u64,     // 0 if no dictionary present (v3 only)
    dictionary_length: u64,     // 0 if no dictionary present (v3 only)
    reserved: [u8; 10],         // MUST be zero, RESERVED for future use
}
```

Total: 4 + 1 + 1 + 8 + 8 + 8 + 8 + 8 + 8 + 10 = **64 bytes**.

`compression` is the algorithm applied to every tile blob; the header itself,
the index, the metadata, and the dictionary are always uncompressed.

## Tile blobs

Tile blobs are written immediately after the header, back to back, with no
padding. The directory tells a reader where each one starts and how long it
is.

Each blob is **zstd(layer frame)** (v3 default), **gzip(layer frame)**, or
the raw layer frame, depending on the header's `compression` byte. In v3,
blobs are also **content-addressed** via a 32-bit CRC32C: if two directory
entries produce byte-identical compressed blobs, only one copy is written
and both rows point at the same offset. This gives free deduplication for
sparse zoom levels and for tiles that repeat geometry across temporal
buckets.

Every blob carries an integrity tag in its directory row that readers MUST
verify on read:

- **v3**: CRC32C of the compressed bytes, zero-extended to 64 bits.
- **v2**: leading 8 bytes of a BLAKE3 digest (used as the dedup key on the
  write side).

The directory column is called `content_hash` in both versions for
back-compat.

### Layer frame

A tile may carry several named layers (e.g. one for points and one for
linestrings). The blob payload is a tiny frame around one Arrow IPC stream
per layer:

```
[u16 layer_count]
  repeated layer_count times:
    [u16 name_len][name utf8][u32 ipc_len][ipc stream bytes]
```

All integers are little-endian. `ipc stream bytes` is the output of an Arrow
`StreamWriter` containing exactly one `RecordBatch`.

### Per-layer Arrow schema

| column              | type                                    | nullability | notes                                |
| ------------------- | --------------------------------------- | ----------- | ------------------------------------ |
| `id`                | `UInt64`                                | non-null    | per-feature id (H3 cell index in summary tiles) |
| `start_time`        | `Int64`                                 | non-null    | Unix ms, absolute                    |
| `end_time`          | `Int64`                                 | non-null    | Unix ms, absolute                    |
| `geometry`          | GeoArrow Point / LineString / Polygon   | non-null    | interleaved f64 lon/lat              |
| `vertex_time`       | `List<Int64>`                           | nullable    | per-vertex Unix ms (LineString only) |
| `triangle_indices`  | `List<UInt32>`                          | nullable    | feature-local earcut indices (Polygon, `--pre-tessellate`) |
| `<prop>`            | `Float64` or `Utf8`                     | nullable    | one column per property, by name     |

Geometry uses the GeoArrow extension metadata key
`ARROW:extension:name` with values `geoarrow.point`, `geoarrow.linestring`,
or `geoarrow.polygon` — see [GeoArrow interop](#geoarrow-interop) below.
Coordinates are interleaved `[x, y]` in WGS84 degrees; the writer does
**not** quantize or delta-encode — zstd or gzip (header `compression`)
on the IPC bytes does the work.

Layers within one tile MUST agree on feature count for the rows they each
cover, but they MAY carry different property columns.

`triangle_indices` is present only when the archive was built with
`stt-build --pre-tessellate`. The Rust writer stores feature-LOCAL indices;
the TS decoder pre-shifts them by each feature's `startIndices[i]` and
exposes a single tile-global `triangles: Uint32Array` on `BinaryFeatures`
so the renderer can hand it straight to deck.gl / WebGL.

### GeoArrow interop

An STT tile layer **is** a valid [GeoArrow](https://geoarrow.org/format.html)
record batch. The Rust writer (`crates/stt-core/src/arrow_tile.rs`) tags
the `geometry` field's Arrow metadata with the standard extension key:

| field metadata key       | values                                                     |
| ------------------------ | ---------------------------------------------------------- |
| `ARROW:extension:name`   | `geoarrow.point` / `geoarrow.linestring` / `geoarrow.polygon` |

Coordinates use the GeoArrow **interleaved** convention
(`FixedSizeList<Float64, 2>` of `[x, y]` pairs), which matches the
`xy` storage Lonboard and `@geoarrow/deck.gl-layers` consume by
default. Polygons are encoded as `List<List<FixedSizeList<Float64, 2>>>`
(rings inside features), and linestrings as `List<FixedSizeList<Float64, 2>>`.

The schema also carries a legacy `stt:geometry` key in
schema-level metadata for back-compat; readers SHOULD prefer the standard
field-level key and fall back to `stt:geometry` only when it is absent.

In TypeScript, the decoded `Layer` exposes both surfaces:

```ts
import { toGeoArrowTable } from '@stt/core';
import { GeoArrowPathLayer } from '@geoarrow/deck.gl-layers';

const table = toGeoArrowTable(tile.layers[0]);
new GeoArrowPathLayer({
  id: 'paths',
  data: table,
  getPath: table.getChild('geometry')!,
});
```

`Layer.geometryExtensionName` carries the same string for callers
that want to dispatch on geometry kind without touching the Arrow
schema directly. This means any GeoArrow-aware renderer
(`@geoarrow/deck.gl-layers`, Lonboard, geoarrow-rs in WASM) can consume
STT tiles as-is — no per-tile conversion step.

### Naming conventions

Layer name `default` is the conventional "everything" layer. The build
pipeline may emit a `default_originals` companion layer containing
unsimplified geometry when `--simplify` is used; clients can pick the
appropriate one based on zoom. Summary-tier tiles use the layer name
`summary` by default (overridable via `--summary-layer`).

## Dictionary (optional, v3 only)

When present, the dictionary is a single zstd training dictionary that
applies to every tile blob in the archive. Sharing one dictionary across
many small/repetitive tiles substantially improves ratios at zooms where
most tiles repeat similar property values. The header's
`dictionary_offset` / `dictionary_length` point at it; readers load the
dictionary once at archive-open time and pass it to every per-tile zstd
decoder. `dictionary_offset == 0` means no dictionary — decode tiles
with a stock decoder.

## Index (Arrow IPC)

The directory is itself an Arrow IPC stream — one `RecordBatch`, one row per
tile, sorted by `(zoom ascending, hilbert ascending)` for spatial locality.

| column                | type     | description                                              |
| --------------------- | -------- | -------------------------------------------------------- |
| `zoom`                | `UInt8`  | zoom level                                               |
| `x`                   | `UInt32` | tile x                                                   |
| `y`                   | `UInt32` | tile y                                                   |
| `time_start`          | `Int64`  | inclusive temporal start, Unix ms                        |
| `time_end`            | `Int64`  | inclusive temporal end, Unix ms                          |
| `offset`              | `UInt64` | byte offset of compressed blob within the archive        |
| `length`              | `UInt32` | compressed blob length                                   |
| `uncompressed_size`   | `UInt32` | uncompressed payload length                              |
| `feature_count`       | `UInt32` | total features across the tile's layers                  |
| `hilbert`             | `UInt64` | Hilbert index of `(zoom, x, y)` — directory sort key     |
| `content_hash`        | `UInt64` | v3: CRC32C zero-extended; v2: low 8 bytes of BLAKE3      |
| `temporal_bucket_ms`  | `UInt64` | optional — bucket size in ms this tile covers (LOD-aware) |

The Hilbert ordering is what makes range coalescing work: viewport tiles at
the same zoom level tend to be contiguous in file order, so a reader can
issue one HTTP Range request that covers several tiles.

`temporal_bucket_ms` is populated on archives built after the temporal-LOD
scaffold landed: base tiles record the archive's base bucket size; LOD
tiles record their coarser bucket. Older archives leave the column null
and the reader falls back to the archive-level
`Metadata::temporal_bucket_ms`.

## Metadata (UTF-8 JSON)

Stored as a single `serde_json::Value`. Schema below; unknown fields are
preserved on round-trip via serde defaults so old readers don't break on
new fields.

```jsonc
{
  "name": "earthquakes",
  "description": "USGS feed",
  "attribution": "USGS",
  "bounds": { "min_lon": -180.0, "min_lat": -85.05, "max_lon": 180.0, "max_lat": 85.05 },
  "time_range": { "start": 1577836800000, "end": 1735689599000 },
  "min_zoom": 0,
  "max_zoom": 8,
  "tile_count": 1234,
  "feature_count": 56789,
  "layers": ["default"],
  "properties": {},
  "temporal_bucket_ms": 3600000,

  // Optional — present when the archive was built with --summary-tier
  "summary_tier": {
    "scheme": "h3",
    "min_zoom": 0,
    "max_zoom": 4,
    "cell_resolution_per_zoom": [0, 1, 2, 3, 4],
    "columns": [
      { "name": "_count", "agg": "count" },
      { "name": "magnitude", "agg": "mean" }
    ],
    "layer_name": "summary"
  },

  // Optional — present when the archive was built with --temporal-lod.
  // Each level's bucket_ms is a strict multiple of temporal_bucket_ms,
  // sorted ascending. Readers pick the coarsest level whose
  // max_zoom_level >= current zoom.
  "temporal_lod": [
    { "bucket_ms": 86400000,   "max_zoom_level": 8 },
    { "bucket_ms": 2592000000, "max_zoom_level": 4 }
  ],

  // Optional — present when built with --heatmap-weight / --heatmap-class.
  // HeatmapLayer pins colorDomain to [min, max] (95p of weight, not absolute
  // max) instead of doing a runtime GPU readback.
  "heatmap_domain": {
    "classes": [
      { "id": "default", "min": 4.0, "max": 6.2, "property": "magnitude" }
    ]
  }
}
```

`temporal_bucket_ms` is load-bearing: the client tileset enumerates exactly
these bucket boundaries when prefetching forward in time, which keeps the
cache-hit rate high during animation.

## Read order

A new client opens an archive like this:

1. Range `[0, 64)` → header. Verify magic and version.
2. If `dictionary_length > 0`: range
   `[dictionary_offset, dictionary_offset + dictionary_length)` → dictionary.
   Construct a shared zstd decompressor with it.
3. Range `[index_offset, index_offset + index_length)` → index. Decode as
   Arrow IPC; build any in-memory secondary indices.
4. Range `[metadata_offset, metadata_offset + metadata_length)` → metadata.
5. Per visible tile: range
   `[entry.offset, entry.offset + entry.length)` → blob. Verify
   `content_hash`, decompress, decode the layer frame, hand the resulting
   Arrow `RecordBatch`es to the renderer.

The reference TypeScript implementation coalesces adjacent ranges when their
gap is less than 32 KiB (`RANGE_COALESCE_GAP` in `packages/core/src/archive.ts`).

## Forward and backward compatibility

- The `compression` byte is the only place new compression algorithms are
  added; readers MUST reject values they do not understand.
- New columns added to the index are tolerated by the reader as long as the
  columns listed above remain present and well-typed.
- New per-layer columns are tolerated automatically — they appear in the
  Arrow schema and a property-aware client passes them through to the
  renderer.
- New metadata fields use serde defaults so old archives decode under new
  readers; new fields are skipped when unset so new archives decode under
  old readers that ignore them.
- The 10 reserved header bytes will be used for additive features
  (e.g. footer index, encrypted-payload bit). They MUST be zero on write
  today.

## Validating an archive

`stt-validate <path.stt>` opens an archive, content-hash-checks every tile,
decodes each, and reports schema and feature-count anomalies. Use it after
generating data and in CI for any dataset that ships with the project.
Pass `--json` for a machine-readable report, `--fail-fast` to stop on the
first failure, `--skip-decode` to verify only the integrity tags.
