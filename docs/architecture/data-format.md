# STT tile payload format

> **Scope:** this page is the normative spec for the **tile payload** (Apache
> Arrow IPC + GeoArrow), which is identical regardless of container. The
> **container** is the packed format —
> [`docs/spec/stt-packed-format.md`](../spec/stt-packed-format.md), which also
> specifies the v5 directory codec (§4 there). The single-file layout
> under "Top-level layout" below is the **single-file container**, used as the
> streaming/transcode intermediate.

An STT dataset combines a spatial tile pyramid with a temporal axis. Tile
payloads are **Apache Arrow IPC** record batches with **GeoArrow**-encoded
geometry, so a browser can decode a tile with one library (`apache-arrow`) and
feed the resulting columnar buffers directly to deck.gl.

This document is the normative spec for the tile payload. The Rust authority is
`crates/stt-core/src/arrow_tile.rs` (payload), `crates/stt-core/src/archive.rs`
(single-file container) and `crates/stt-core/src/directory.rs` (the tile
index codec); the TypeScript reader (packed format only) lives in
`packages/core/src/archive.ts` / `tile.ts`. If this document and the code
disagree, the code wins — please open a PR.

## Top-level layout (single-file container)

> The container below is the **single-file** archive. The primary
> container is the packed format (`manifest.json` + content-addressed
> `packs/*.sttp` + `index/*.sttd`); see
> [`stt-packed-format.md`](../spec/stt-packed-format.md). The single-file
> container is produced as the bounded-RAM streaming intermediate that is
> transcoded to packs.

```
┌─────────────────────────┐  offset 0
│ Header (64 bytes)       │  fixed-size, little-endian
├─────────────────────────┤
│ Tile blobs              │  compressed Arrow IPC layer frames
│ ...                     │  back to back, no padding
├─────────────────────────┤
│ Dictionary (optional)   │  shared zstd dictionary — no shipped producer
├─────────────────────────┤
│ Index (directory codec) │  the directory — one entry per tile
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
| `STT\x02`    | 2       | retired (gzip + BLAKE3-64 dedup)                    |
| `STT\x03`    | 3       | retired (zstd + CRC32C, no dedup)                   |
| `STT\x04`    | 4       | single-file container (dedup + run-length directory); the streaming/transcode intermediate |

> The **current container is the packed format**, which has no single-file magic
> — a dataset is identified by `manifest.json` with `"format": "stt-packed"`. The
> magic table above applies only to single-file archives, and the in-repo
> reader (`stt-core::archive::ArchiveReader`) accepts **only v4** — v1–v3 are
> rejected. Readers MUST refuse archives whose version they do not understand.

## Header (64 bytes, little-endian)

```rust
struct ArchiveHeader {
    magic: [u8; 4],             // "STT\x04" (4th byte doubles as the version)
    version: u8,                // 4
    compression: u8,            // 0 = none, 1 = gzip, 2 = zstd
    index_offset: u64,          // start of Index, bytes from file start
    index_length: u64,
    metadata_offset: u64,       // start of Metadata
    metadata_length: u64,
    dictionary_offset: u64,     // 0 if no dictionary present
    dictionary_length: u64,     // 0 if no dictionary present
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

Each blob is **zstd(layer frame)** (the default — `stt-build` is zstd-only),
**gzip(layer frame)**, or the raw layer frame, depending on the header's
`compression` byte.

**Deduplication.** The buffered ("optimized") v4 writer and the packed
`PackWriter` blake3-hash each compressed blob and write byte-identical blobs
once — a static cell repeated across time buckets stores one physical blob,
which the directory's run-length encoding then collapses into a single run.
The eager (streaming) v4 writer appends every blob unconditionally.

Every blob carries a **CRC32C of its compressed bytes** as an integrity tag
in its directory entry. Verification status:

- The Rust `ArchiveReader` (`stt-core::archive`) checks the tag on every
  `read_payload`, and `stt-validate` checks all tiles up front.
- The TypeScript reader (`packages/core/src/archive.ts`) decodes the tag from
  the directory but does **not** verify it on the hot decode path — a corrupt
  blob surfaces as an Arrow/zstd decode error instead. Readers SHOULD verify
  the tag.

### Layer frame

A tile may carry several named layers (e.g. one for points and one for
linestrings). The blob payload is a tiny frame around one Arrow IPC stream
per layer:

```
[u16 layer_count]            // high bit = ALIGNED_FRAME_FLAG (0x8000)
  repeated layer_count times:
    [u16 name_len][name utf8][u32 ipc_len][pad?][ipc stream bytes]
```

All integers are little-endian. `ipc stream bytes` is the output of an Arrow
`StreamWriter` containing exactly one `RecordBatch`.

When the leading `u16`'s `ALIGNED_FRAME_FLAG` (`0x8000`) bit is set, the
writer inserts `(8 - pos % 8) % 8` zero bytes after each `ipc_len` so every
IPC stream starts 8-byte aligned relative to the payload start — the
alignment Arrow requires for zero-copy buffer views. `ipc_len` is the exact
IPC byte length (padding excluded); the pad is never stored, readers derive
it from the same alignment math. Layer count is therefore capped at
`0x7fff`. Frames with the flag unset carry no padding; readers MUST accept
both shapes. See the packed spec §5.1.

### Per-layer Arrow schema

| column              | type                                    | nullability | notes                                |
| ------------------- | --------------------------------------- | ----------- | ------------------------------------ |
| `id`                | `UInt64`                                | non-null    | per-feature id (H3 cell index in summary tiles) |
| `start_time`        | `Int64`                                 | non-null    | Unix ms, absolute                    |
| `end_time`          | `Int64`                                 | non-null    | Unix ms, absolute                    |
| `geometry`          | GeoArrow Point / LineString / Polygon   | non-null    | interleaved f64 lon/lat              |
| `vertex_time`       | `List<UInt16>` (deltas) or `List<Int64>` (exact) | nullable | per-vertex times (LineString only) — see below |
| `vertex_value`      | `List<Float32>`                         | nullable    | per-vertex scalar (e.g. SST on drifters/currents); decoded to `BinaryFeatures.vertexValues` |
| `vertex_value_matrix` | `List<Float32>`                       | nullable    | per-vertex × per-bucket value matrix (vertex-major) for static-geometry overview animation; bucket count in schema metadata `stt:vertex_value_buckets` |
| `triangles`         | `List<UInt32>`                          | non-null    | feature-local earcut indices (Polygon, `--pre-tessellate`) |
| `<prop>`            | `Float64` (numeric) or `Dictionary<UInt16, Utf8>` (categorical) | nullable | one column per property, by name |

Geometry uses the GeoArrow extension metadata key
`ARROW:extension:name` with values `geoarrow.point`, `geoarrow.linestring`,
or `geoarrow.polygon` — see [GeoArrow interop](#geoarrow-interop) below.
Coordinates are interleaved `[x, y]` in WGS84 degrees; the writer does
**not** quantize or delta-encode — per-blob zstd on the IPC bytes does the
work (the writer is zstd-only; gzip remains a readable value for older
single-file archives).

Layers within one tile MUST agree on feature count for the rows they each
cover, but they MAY carry different property columns.

#### `vertex_time` (per-vertex timestamps)

LineString layers built with `--end-time-field` carry a per-vertex time
column. The writer encodes it as `List<UInt16>` **deltas** relative to a per-layer
`(origin, step)`: the absolute time of a vertex is
`origin + delta * step`. The origin and step are recorded in the layer's
**schema-level** Arrow metadata under the keys:

| schema metadata key            | meaning                                  |
| ------------------------------ | ---------------------------------------- |
| `stt:vertex_time_origin_ms`    | absolute Unix-ms origin (`i64` as string) |
| `stt:vertex_time_step_ms`      | ms per delta unit (`u32` as string)       |

The encoder picks the smallest `step` (≥ 1) that keeps every
`(t - origin)` inside `u16::MAX`, **bounded by a precision ceiling**
(`DEFAULT_VERTEX_TIME_MAX_STEP_MS` = 1000 ms, configurable via
`stt-build --vertex-time-precision`). A layer whose span would need a
coarser step — anything over ~18.2 h at the default — takes the exact
absolute `List<Int64>` shape instead and omits the two metadata keys, so
quantization error is always bounded by the ceiling. A reader
that sees a `List<Int64>` column (or no origin/step metadata) treats the
values as absolute Unix ms; a reader that sees `List<UInt16>` reconstructs
`origin + delta * step`.

#### `triangles` (pre-tessellated polygon meshes)

`triangles` is present only when the archive was built with
`stt-build --pre-tessellate` (the layer also carries the schema metadata
key `stt:has_triangles = "true"`). The column is emitted only for polygon
layers — an over-eager builder that attaches it to a point/line layer has
it silently dropped at encode time. The Rust writer stores feature-LOCAL
indices; the TS decoder pre-shifts them by each feature's
`startIndices[i]` and exposes a single tile-global
`triangles: Uint32Array` on `BinaryFeatures` so the renderer can hand it
straight to deck.gl / WebGL.

### GeoArrow interop

An STT tile layer **is** a valid [GeoArrow](https://geoarrow.org/format.html)
record batch. The Rust writer (`crates/stt-core/src/arrow_tile.rs`) tags
the `geometry` field's Arrow metadata with the standard extension keys:

| field metadata key          | values                                                     |
| --------------------------- | ---------------------------------------------------------- |
| `ARROW:extension:name`      | `geoarrow.point` / `geoarrow.linestring` / `geoarrow.polygon` |
| `ARROW:extension:metadata`  | `{"crs":"OGC:CRS84","crs_type":"authority_code"}`          |

The `ARROW:extension:metadata` value is the GeoArrow per-type metadata JSON.
STT pins the CRS to **OGC:CRS84** — WGS84 with the GeoJSON longitude-first axis
order, matching the interleaved `[lon, lat]` storage — *not* `EPSG:4326`, whose
strict (lat/lon) axis order would mislabel the data. Carrying it makes every
tile self-describing to GDAL / GeoPandas / lonboard / QGIS; a reader that wants
the CRS reads this key, and a reader that ignores it is unaffected (the key is
additive). Archives that carry only `ARROW:extension:name` (no CRS metadata)
should be treated as OGC:CRS84.

Coordinates use the GeoArrow **interleaved** convention
(`FixedSizeList<Float64, 2>` of `[x, y]` pairs), which matches the
`xy` storage Lonboard and `@geoarrow/deck.gl-layers` consume by
default. Polygons are encoded as `List<List<FixedSizeList<Float64, 2>>>`
(rings inside features), and linestrings as `List<FixedSizeList<Float64, 2>>`.

The schema-level metadata also carries `stt:layer` (the layer name) and a
legacy `stt:geometry` key for back-compat; readers SHOULD prefer the standard
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

## Dictionary (optional — no shipped producer)

The header reserves a slot (`dictionary_offset` / `dictionary_length`) for a
single shared zstd dictionary that would apply to every tile blob. The
plumbing exists (`ArchiveWriter::create_optimized*` trains a ~112 KiB
dictionary in buffered mode; `ArchiveReader` loads it at open and feeds the
per-tile zstd decoder), but **no producer in this repo ships one**:
`stt-build` writes packed datasets via `PackWriter` (explicitly
dictionary-less so the browser's `fzstd` decoder works), and its
`--streaming-arrow` single-file intermediate doesn't train one either. The
packed format has **no dictionary slot at all** — every blob is an
independent zstd frame. `dictionary_offset == 0` means no dictionary.

## Index (the directory)

The directory is **not** Arrow IPC — it is a compact columnar binary codec
(`crates/stt-core/src/directory.rs`): delta + zig-zag LEB128 varint key
columns plus blob-run RLE, sorted by `(zoom, hilbert, time_start)` so every
column delta-codes to ~1 byte per entry. The wire encoding is specified in
[the packed format spec §4](../spec/stt-packed-format.md); the
single-file container embeds the same codec at the header's
`index_offset` (its variant has no per-run `pack_id` column —
whole-file offsets, decoded as `pack_id = 0`).

Each entry decodes to these logical fields (`stt-core::archive::TileEntry`):

| field                 | type            | description                                              |
| --------------------- | --------------- | -------------------------------------------------------- |
| `zoom`                | `u8`            | zoom level                                               |
| `x`                   | `u32`           | tile x                                                   |
| `y`                   | `u32`           | tile y                                                   |
| `time_start`          | `i64`           | inclusive temporal start, Unix ms (bucket boundary)      |
| `time_end`            | `i64`           | inclusive temporal end, Unix ms                          |
| `pack_id`             | `u32`           | pack object index (always 0 in a single-file archive)    |
| `offset`              | `u64`           | byte offset of the compressed blob (pack-relative; whole-file in single-file) |
| `length`              | `u32`           | compressed blob length                                   |
| `uncompressed_size`   | `u32`           | uncompressed payload length                              |
| `feature_count`       | `u32`           | total features across the tile's layers                  |
| `hilbert`             | `u64`           | Hilbert index of `(zoom, x, y)` — directory sort key     |
| `crc32c`              | `u32`           | CRC32C of the compressed blob (integrity tag)            |
| `temporal_bucket_ms`  | `Option<u64>`   | bucket size this tile covers (base vs temporal-LOD tier) |
| `cover_t_min`         | `Option<i64>`   | tight lower covering bound — earliest feature start actually in the tile |

The Hilbert ordering is what makes range coalescing work: viewport tiles at
the same zoom level tend to be contiguous in blob order, so a reader can
issue one HTTP Range request that covers several tiles.

`temporal_bucket_ms` is `None` on archives without a temporal-LOD pyramid
(readers fall back to the archive-level `Metadata::temporal_bucket_ms`);
`cover_t_min` is `None` on pre-covering builds (readers fall back to
`time_start`).

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

**Packed (current):** `GET manifest.json` → `GET` the directory object →
per visible tile, a Range request into the right pack — see
[the packed format spec §6](../spec/stt-packed-format.md). The TypeScript
reader coalesces ranges within a pack when their gap is under 2 MiB
(`DEFAULT_RANGE_COALESCE_GAP` in `packages/core/src/archive.ts`,
overridable via `ArchiveOptions.coalesceGapBytes`) — tuned for HTTP/2
against edge caches, where re-fetching a small gap is cheaper than an
extra request.

**Single-file container** (Rust `ArchiveReader`, transcode input only):

1. Bytes `[0, 64)` → header. Verify magic and version.
2. If `dictionary_length > 0`: read the dictionary slot and construct a
   shared zstd decompressor with it.
3. `[index_offset, index_offset + index_length)` → index. Decode the
   directory codec; build in-memory secondary indices.
4. `[metadata_offset, metadata_offset + metadata_length)` → metadata.
5. Per tile: `[entry.offset, entry.offset + entry.length)` → blob. Verify
   the CRC32C, decompress, decode the layer frame, hand the resulting Arrow
   `RecordBatch`es to the consumer.

## Forward and backward compatibility

- The `compression` byte is the only place new compression algorithms are
  added; readers MUST reject values they do not understand.
- The directory codec carries its own version byte (currently v5 packed /
  v4 single-file) and evolves independently of the container.
- New per-layer columns are tolerated automatically — they appear in the
  Arrow schema and a property-aware client passes them through to the
  renderer.
- New metadata fields use serde defaults so old archives decode under new
  readers; new fields are skipped when unset so new archives decode under
  old readers that ignore them.
- The 10 reserved header bytes (single-file) are reserved for additive
  features. They MUST be zero on write.

## Validating an archive

`stt-validate <dataset>` accepts a packed dataset directory, its
`manifest.json`, or a single-file `.stt`. For packed inputs it first
verifies the content-addressing contract (every pack/directory object
blake3-hashes to its filename, declared lengths match, no out-of-range
`pack_id`), then verifies every tile's CRC32C, decodes each payload, and
reports schema and feature-count anomalies. Use it after generating data
and in CI. Pass `--json` for a machine-readable report, `--fail-fast` to
stop on the first failure, `--skip-decode` to verify only integrity.
