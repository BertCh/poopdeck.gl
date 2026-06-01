# STT v4 format specification

Status: **partial / in-progress.** This documents the v4 archive container and the
new run-length **directory** as implemented in `crates/stt-core` (the eager v2/v3
Arrow-index writer remains the default; v4 is produced by `ArchiveWriter::create_v4`).
Tile-payload encoding (GeoArrow IPC, interleaved coords, u16-delta vertex times,
pre-tessellated triangles) is unchanged from v3 — see `docs/architecture/data-format.md`.

> v4 is a clean break: no on-disk back-compat is promised. Readers still *accept*
> v2/v3 for migration, but v4 archives regenerate from source.

## 1. Container layout

```
┌───────────────────────────────┐
│ 64-byte header                │
├───────────────────────────────┤
│ tile blobs                    │  zstd-compressed (shared dictionary),
│                               │  byte-deduplicated, Hilbert-ordered
├───────────────────────────────┤
│ shared zstd dictionary        │  optional (present iff training succeeded)
├───────────────────────────────┤
│ directory                     │  the compact run-length tile index (§3)
├───────────────────────────────┤
│ metadata (UTF-8 JSON)         │  also exposes TileJSON 3.0 + STAC (§4)
└───────────────────────────────┘
```

A reader fetches header → directory → metadata (three range requests, or one
coalesced), then each tile blob with one more.

## 2. Header (64 bytes, little-endian)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Magic. `b"STT"` + version byte: `0x02` v2, `0x03` v3, **`0x04` v4** |
| 4 | 1 | Version (redundant; must equal magic's 4th byte) |
| 5 | 1 | Compression of tile blobs: `0` none, `1` gzip, `2` zstd (v4 ⇒ `2`) |
| 6 | 8 | `index_offset` — byte offset of the directory (§3) |
| 14 | 8 | `index_length` |
| 22 | 8 | `metadata_offset` |
| 30 | 8 | `metadata_length` |
| 38 | 8 | `dictionary_offset` (0 if absent) |
| 46 | 8 | `dictionary_length` (0 if absent) |
| 54 | 10 | reserved (zero) |

A reader rejects versions above `MAX_SUPPORTED_VERSION` (4).

## 3. The v4 directory

A pure columnar binary buffer (`crates/stt-core/src/directory.rs`) that replaces
the v2/v3 Arrow-IPC index. Entries are sorted into directory order
`(zoom, hilbert, time_start)` so columns are near-monotonic and delta-code well.

**Varints.** Unsigned values use LEB128; signed deltas use LEB128 over a zig-zag
mapping `zz(v) = (v << 1) ^ (v >> 63)`. Deltas are computed with wrapping
arithmetic, so any `i64` round-trips exactly.

**Layout.**

```
u8     version_tag = 0x04
uvarint N          # entry count
uvarint R          # run count

# per-entry key columns, N rows, delta-coded against the previous entry:
repeat N:
  ivarint  Δzoom
  ivarint  Δhilbert
  ivarint  Δx
  ivarint  Δy
  ivarint  Δtime_start
  ivarint  duration            # time_end - time_start (wrapping)
  uvarint  feature_count
  uvarint  bucket_present       # temporal_bucket_ms: 0 = None, 1 = Some
  uvarint  bucket_value         #   present only when bucket_present == 1

# per-run blob columns, R rows:
repeat R:
  uvarint  run_length          # entries sharing this blob; Σ run_length == N
  uvarint  offset_flag          # 0 = contiguous (== prev.offset + prev.length)
  uvarint  offset               #   present only when offset_flag == 1: raw offset
  uvarint  length              # compressed blob length
  uvarint  uncompressed_size
  u32 (LE) crc32c              # integrity tag of the compressed blob
```

**Run-length encoding (the headline win).** A *run* is a maximal stretch of
consecutive entries (in directory order) that reference the **same physical
blob** — same `(offset, length, uncompressed_size, crc32c)`. Because v4
deduplicates byte-identical blobs (§5), a spatial cell whose content is identical
across many consecutive time buckets collapses to a single run: the heavy blob
columns are written **once per run** instead of once per entry. This is the
temporal analogue of PMTiles collapsing identical ocean tiles across space.

**Offset contiguity.** Runs whose blob immediately follows the previous run's
blob (the common, sequential case) store `0`; a back-reference (a deduped blob
written earlier) stores `offset + 1`. The decoder tracks
`expected = prev.offset + prev.length`.

**Decode** reconstructs the N key rows, then walks the R runs, assigning each
run's blob fields to its `run_length` entries; it errors if the run lengths don't
sum to `N` or the buffer is truncated.

> Assumes `hilbert < 2^63` (zoom ≤ ~31) and timestamps within `i64` ms — true for
> Web-Mercator tiles and Unix-ms time. Single-level (no leaf directories) today;
> leaf directories are a planned scale add-on.

## 4. Metadata

Stored as UTF-8 JSON (serde, versionless via field defaults). `Metadata` also
renders a **TileJSON 3.0** descriptor via `to_tilejson()`:

- Core fields: `tilejson:"3.0.0"`, `tiles`, `name`, `description`, `attribution`,
  `scheme:"xyz"`, `minzoom`, `maxzoom`, `bounds`, `center`, `vector_layers`.
- Additive **`temporal`** block (STAC-style): `interval: [[startISO, endISO]]`
  (`null` for an open end), `bucket_ms`, ISO-8601 `step` (e.g. `"PT1H"`), and an
  optional `lod` pyramid. Existing web clients ignore unknown keys; STAC catalogs
  can index the temporal extent.

## 5. Tile blobs, dedup & shared dictionary

- **Payload**: unchanged from v3 — an Arrow-IPC layer frame with interleaved
  GeoArrow geometry (`OGC:CRS84`), per-vertex u16-delta times, optional
  pre-tessellated triangles, numeric / `Dictionary<UInt16,Utf8>` properties.
- **Shared dictionary**: a single zstd dictionary trained over a bounded sample
  of tile payloads at finalize, stored in the dictionary slot, and used to
  compress/decompress every blob. Recovers most of the per-tile framing overhead
  on small/sparse/summary tiles. Degrades gracefully (empty slot, plain zstd) when
  the corpus is too small to train.
- **Dedup**: byte-identical compressed blobs are written once (keyed by a strong
  hash of the compressed bytes); multiple directory entries then reference the one
  blob and RLE-collapse (§3). Integrity is a per-blob CRC32C, verified on read.

## 6. Implemented vs planned

| Area | Status |
|---|---|
| v4 container + header + version dispatch | **implemented** (`archive.rs`) |
| Run-length directory codec | **implemented** (`directory.rs`, round-trip + RLE + edge-case tests) |
| Blob dedup + Hilbert-ordered blobs | **implemented** (`create_v4` buffered finalize) |
| Shared zstd dictionary (writer trains, Rust reader decodes) | **implemented** |
| Property numeric-string promotion | **implemented** (`stt-build/columnar.rs`) |
| TileJSON 3.0 + STAC temporal descriptor | **implemented** (`metadata.rs`) |
| Build-CLI flag to emit v4; `stt-validate` v4 awareness | planned |
| TypeScript reader: v4 directory + dict-zstd decode | planned (`packages/core`) |
| Temporal clipping into base path; adaptive temporal chunking; SED LOD | planned (`stt-build`) |
| Leaf directories (planet scale) | planned |
