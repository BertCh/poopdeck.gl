# STT Packed Format (v1) — Specification

Status: **ADOPTED** — shipped 2026-06-07, live in production. The canonical STT
container, replacing single-file v4 (`STT\x04`). Machine-checkable manifest
contract: [`manifest.schema.json`](./manifest.schema.json). Versioning model: §10.

## 1. Motivation

A single-file v4 archive cannot be edge-cached once it exceeds the CDN per-object
limit (Cloudflare Free/Pro/Business = 512 MB). Our 4.28 GB `nyc-taxi-paths.stt`
returns `cf-cache-status: BYPASS` on every range request — all reads hit R2 origin,
forever, for every user. Reordering blobs doesn't help (measured: 3.7%).

The fix is structural: **make the cacheable unit a small object, not the whole
dataset.** Data is split into many content-addressed *pack* objects (each well under
the limit) plus a tiny manifest. A dumb CDN caches each pack natively. No Worker, no
vendor lock-in — cacheability becomes a property of the format, so it works on R2, S3,
GCS, or any static host.

## 2. On-disk / on-bucket layout (per dataset)

```
data/<dataset>/
  manifest.json            # tiny, MUTABLE   → short TTL (or purge-on-deploy)
  index/<blake3>.sttd      # directory blob  → IMMUTABLE (content-addressed)
  packs/<blake3>.sttp      # tile blob data  → IMMUTABLE (content-addressed)
  packs/<blake3>.sttp
  ...
```

- **Packs and the directory are content-addressed** (blake3, 128-bit → 32 hex chars).
  Their bytes never change without their name changing, so they ship with
  `Cache-Control: public, max-age=31536000, immutable` → cached at the edge forever,
  and re-sync skips unchanged packs (incremental deploys, cross-version dedup).
- **`manifest.json` is the only mutable object** → short `max-age` (e.g. 60 s) and/or
  explicit purge on deploy. It is tiny (a few KB), so this is cheap. It is the only
  thing a deploy must invalidate.
- **Retention contract (origin GC).** Deploys are *additive*: a deploy MUST NOT
  delete objects the previous manifest references, because manifests are cached
  (up to their TTL) and an open session holds its manifest in memory for its whole
  lifetime — both keep resolving old pack names. Origin garbage collection is a
  separate, retention-aware pass: an immutable object may be deleted only when it
  is BOTH unreferenced by the dataset's current manifest AND older than a retention
  window that exceeds every cached manifest's TTL plus the longest expected session
  (the reference deploy script `scripts/r2-sync.sh` defaults to 7 days, override
  `R2_PRUNE_RETENTION`, escape hatch `--prune-now`). Edge caches need no purge
  either way — an evicted-at-origin object simply ages out of the edge.

## 3. `manifest.json` schema

```json
{
  "format": "stt-packed",
  "formatVersion": 1,
  "compression": "zstd",
  "directory": { "key": "index/<hash>.sttd", "length": 1234567, "directoryVersion": 5, "encoding": "zstd" },
  "packs": [
    { "key": "packs/<hash0>.sttp", "length": 67108864 },
    { "key": "packs/<hash1>.sttp", "length": 67108864 }
  ],
  "metadata": { "...": "the existing stt-core Metadata JSON, verbatim" }
}
```

- `packs[]` index **is** the `pack_id`. The directory references packs by this index.
- `metadata` is the current `crate::metadata::Metadata` JSON — folded into the manifest,
  so the reader needs **no** separate header or metadata fetch.
- `directory.encoding` (OPTIONAL, additive 2026-06): at-rest encoding of the `.sttd`
  object. `"zstd"` = the object is a single zstd frame wrapping the directory codec
  bytes (~2× smaller; the directory sits on the cold-start critical path with no CDN
  content-encoding rescue). **Absent = raw codec bytes** — the shape of every manifest
  written before the field existed. The content address (`key`) and `length` always
  describe the **at-rest** bytes (i.e. the compressed bytes when `encoding` is set),
  so readers validate the fetched body length before decoding. Readers MUST support
  both shapes and MUST fail loudly on an unrecognized value.
- **Unknown fields are permitted at every envelope level** and MUST be ignored by
  readers (additive evolution within `formatVersion` 1). The JSON Schema encodes
  this: `format`, `formatVersion` and `directoryVersion` are strict consts, the
  envelopes are open.

The manifest envelope is the **cross-language wire contract**. Its authoritative,
machine-checkable definition is [`manifest.schema.json`](./manifest.schema.json),
which is pinned in CI against the Rust writer (`crate::pack::Manifest`), the TS
reader type (`@stt/core` `PackedManifest`) and the golden fixture
(`packages/core/test/manifest-schema.test.ts`). Any drift between the three fails
the build.

## 4. Directory format v5

The directory (`index/<hash>.sttd`) is a pure columnar binary buffer
(`crates/stt-core/src/directory.rs`), inspired by PMTiles v3: delta + zig-zag
varint key columns plus blob-run RLE. v5 is the retired single-file v4 codec
extended with pack awareness (`DIRECTORY_VERSION = 5`); readers keep v4 decode
only for transcoding old archives. Specified in full here since this is the
codec's only deployment.

**Varints.** Unsigned values use LEB128; signed deltas use LEB128 over a zig-zag
mapping `zz(v) = (v << 1) ^ (v >> 63)`. Deltas are computed with wrapping
arithmetic, so any `i64` round-trips exactly.

**Sort order.** Entries are sorted into directory order
`(zoom, hilbert, time_start, temporal_bucket_ms)` — see the §5 tiebreak — so
every key column is near-monotonic and delta-codes to ~1 byte per entry.

**Layout.**

```
u8     version_tag = 0x05
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
  uvarint  bucket_present      # temporal_bucket_ms: 0 = None, 1 = Some
  uvarint  bucket_value        #   present only when bucket_present == 1

# per-run blob columns, R rows:
repeat R:
  uvarint  run_length          # entries sharing this blob; Σ run_length == N
  ivarint  Δpack_id            # zig-zag vs the previous run's pack_id (v5)
  uvarint  offset_flag         # 0 = contiguous (== expected_offset)
  uvarint  offset              #   present only when offset_flag == 1: raw
                               #   pack-relative offset
  uvarint  length              # compressed blob length
  uvarint  uncompressed_size
  u32 (LE) crc32c              # integrity tag of the compressed blob

# optional trailing covering section:
u8       section_tag = 1       # COVER_SECTION_TMIN
repeat N:
  ivarint  Δcover_t_min        # cover_t_min - time_start (signed)
```

**Run-length encoding (the headline win).** A *run* is a maximal stretch of
consecutive entries (in directory order) that reference the **same physical
blob** — same `(pack_id, offset, length, uncompressed_size, crc32c)`. Because
the writer deduplicates byte-identical blobs (§5), a spatial cell whose content
is identical across many consecutive time buckets collapses to a single run:
the heavy blob columns are written **once per run** instead of once per entry —
the temporal analogue of PMTiles collapsing identical ocean tiles across space.
`pack_id` is part of run identity (v5): two entries collapse only when same
pack *and* same blob.

**Per-run `pack_id` column (new in v5).** Delta+zig-zag coded against the
previous run's `pack_id`; packs are near-monotonic in directory order, so this
costs ~1 byte/run. It sits immediately after `run_length`, before the offset
sentinel.

**Pack-relative offset contiguity.** Offsets are relative to the run's pack.
A run whose blob immediately follows the previous run's blob in the same pack
(the common, sequential case) stores `0`; a back-reference (a deduped blob
written earlier) stores a `1` flag + the raw offset. The decoder tracks
`expected = prev.offset + prev.length`, and `expected` resets to `0` whenever
`pack_id` changes between consecutive runs — so the first run of each pack
still hits the cheap `0` sentinel.

**Covering section.** One signed varint per entry, `cover_t_min - time_start`
(signed — a feature can start before its bucket boundary), giving the tight
lower temporal bound the reader's backward-coverage checks use. Emitted only
when **every** entry carries a bound; a pre-covering directory simply ends
after the run columns (`cover_t_min = None`), and a decoder that doesn't
recognise a trailing section tag stops reading.

**Decode** reconstructs the N key rows, then walks the R runs, assigning each
run's blob fields to its `run_length` entries; it errors if the run lengths
don't sum to `N` or the buffer is truncated.

> Assumes `hilbert < 2^63` (zoom ≤ ~31) and timestamps within `i64` ms — true
> for Web-Mercator tiles and Unix-ms time. Single-level (no leaf directories)
> today; leaf directories are a planned scale add-on.

## 5. Pack-cutting (writer)

1. Order blobs by `BlobOrdering` (default = `simulate_layout`'s empirical per-dataset
   winner if available, else `BlobOrdering::choose`). Locality → fewer packs per viewport.
   The curve key is extended with a **total tiebreak** `(z, x, y, time_start,
   temporal_bucket_ms)` — the curve alone ties between a cell's base and temporal-LOD
   tiles (and the 21-bit cube cap can collide), and the input arrives in nondeterministic
   (parallel) order. The tiebreak makes the blob byte order — and therefore every
   content address — **byte-reproducible across identical rebuilds**, which is what the
   immutable-pack caching economics rest on. The directory entry sort gets the same
   treatment: `(zoom, hilbert, time_start, temporal_bucket_ms)`.
2. Per-blob zstd, byte-identical dedup (blake3). **No shared dictionary** (keeps the
   fzstd TS reader able to decode — same contract as `create_reordered`).
3. Cut the ordered, deduped blob stream into packs of **≤ `pack_target_bytes`** (default
   **64 MiB**, override `--pack-size`). Never split a blob across packs.
4. Assign `pack_id` in cut order; `offset_in_pack` resets to 0 per pack.
5. zstd-compress the encoded directory (declared via `directory.encoding`, §3), then
   blake3 each finished pack and the at-rest directory → content-addressed filenames.
6. Emit `manifest.json` (metadata + directory pointer + pack table).

### 5.1 Tile payload layer frame (alignment rule)

A tile blob decompresses to the *layer frame*:

```text
[u16 layer_count | 0x8000]
  repeated: [u16 name_len][name utf8][u32 ipc_len][pad to 8][Arrow IPC stream]
```

The leading u16's top bit (`0x8000`, `ALIGNED_FRAME_FLAG`) marks the **aligned
frame** (additive 2026-06): after each `ipc_len`, zero bytes pad the position to the
next 8-byte boundary *relative to the payload start*, so every Arrow IPC stream
begins 8-byte aligned and a reader can hand it to an Arrow implementation zero-copy
(Arrow guarantees buffer alignment only *within* a stream; a stream at a misaligned
offset forces a copy of every buffer). The pad length is **never stored** — readers
derive it as `(8 - pos % 8) % 8` from the position after `ipc_len`; `ipc_len` is the
exact IPC byte length, padding excluded. Frames with the flag unset (every archive
written before the flag existed) carry no padding and decode as before; readers MUST
accept both. The flag caps the layer count at `0x7fff` (layer counts are tiny in
practice).

## 6. Reader flow (identical contract, Rust + TS)

1. `GET manifest.json` → metadata, directory `{key,length,encoding?}`, `packs[]`.
2. `GET <directory.key>` (one whole-object fetch, immutable/cached) → validate the body
   length against `directory.length`, unwrap `directory.encoding` if set (zstd inflate),
   then decode v5 entries, each carrying `(pack_id, offset_in_pack, length, …)`.
3. Tile read: `entry` → `pack = packs[entry.pack_id]` → range `GET pack.key`
   `bytes=<offset>-<offset+length-1>`.
4. **Coalescing is per-pack**: group needed entries by `pack_id`, then coalesce by offset
   gap *within* each pack (a range can't bridge two pack objects); a concurrency pool runs
   groups in parallel.
5. Decompress per-blob zstd (fzstd in TS — no dict).

Cold load = 1 manifest + 1 directory + N pack ranges. Warm = all served from edge cache.

## 7. Component changes

> **Shipped.** All changes below landed in `b4dec99` (2026-06-07). This section is
> kept as an implementation record. Per **D3**, the single-file *write* path was
> demoted (kept as the streaming intermediate), not deleted.

### Rust — `crates/stt-core`
- `archive.rs`: `TileEntry += pack_id`. `ArchiveReader` (v4 single-file, mmap) is retained
  **as the transcode input reader** and the `--streaming-arrow` intermediate writer; it is
  no longer a deployment output (see D3).
- `directory.rs`: implement v5 (pack_id column, per-pack offset reset).
- New `pack.rs` (`PackWriter`): consumes an `(entry, payload)` stream (like `repack`), cuts
  packs, writes `packs/*.sttp` + `index/*.sttd` + `manifest.json` to an output **dir**.
  Reuses the dedup/zstd/curve-ordering logic from `finalize_buffered`.
- New `PackedReader`: opens a manifest (local path or URL via a fetch trait), maps
  `pack_id → pack`, `read_payload(entry)` reads from the correct pack (mmap locally / range
  remotely).

### Rust — examples / `stt-build`
- `pack-transcode` example: `ArchiveReader::open(v4.stt)` → `PackWriter(outdir)`. Migrates all
  20 existing datasets with no generator runs; preserves `cover_t_min`, `temporal_bucket_ms`.
- `stt-build`: replace the single-file `finalize` (sites at `main.rs:837`, and writer
  creation `599-616`) with `PackWriter` output. `--streaming-arrow` path (huge inputs):
  build a temp single-file, then `pack-transcode`.

### TS — `packages/core`
- `archive.ts` `STTArchive`: `url` now points at a `manifest.json`. Add `fetchManifest` /
  `fetchDirectory`; `fetchRange(packKey, start, end)`; `getTile`/`getTiles` route per-pack;
  coalesce per-pack. **Public API unchanged** (constructor, `.url`, `getMetadata`, `getTile`,
  `getTiles`, `get*IdsInBounds`, `getTileByteSize`, `getCacheStats`, `finalize`,
  `asTileSource`). Drop the header & dictionary fetch (folded into manifest; no dict).
- `directory.ts`: decode v5 (`packId`).
- OPFS cache fingerprint = manifest directory hash (stable across packs).

### Showcase + deploy
- `examples/showcase/src/datasets.ts`: each `url` → `/data/<dataset>/manifest.json`
  (`resolveDataUrl` chokepoint unchanged). 16 distinct datasets (several demos share a file).
- `scripts/r2-sync.sh`: copy per-dataset trees; **two** `Cache-Control` passes — `immutable`
  for `packs/` + `index/`, short TTL for `manifest.json` — plus the retention-aware GC
  pass described in §2 (`copy` + prune, never `sync`-with-delete).

## 8. Design decisions (locked)

All four were resolved when the format shipped; recorded here as rationale.

- **D1 — pack target size = 64 MiB** (override `--pack-size`). Well under the 512 MB
  CDN per-object cap, fine enough for granular caching + parallel range reads, coarse
  enough to keep the object count (and R2 GET ops to warm) modest. A single blob larger
  than the target gets its own oversized pack (blobs are never split).
- **D2 — content address = blake3, 128-bit** (32 hex chars). blake3 is already the
  dedup hash; 128 bits is collision-safe at our object counts and keeps keys short.
- **D3 — single-file *write* path demoted, not deleted.** The v4 single-file writer is
  no longer a deployment target, but it survives as (a) the bounded-RAM **intermediate**
  that `stt-build --streaming-arrow` transcodes into packs, and (b) the read side that
  `transcode_archive_to_packs` consumes to migrate old archives. Full deletion is gated
  on a streaming `PackWriter` (see the packed-format roadmap). The v4 *read* path is
  retained indefinitely for transcode.
- **D4 — manifest freshness = short `max-age` + `must-revalidate`.** `manifest.json`
  ships `max-age=60, must-revalidate`; packs/index ship `immutable, max-age=31536000`.
  Revalidation (`REVALIDATED`) keeps the tiny manifest fresh without a mandatory purge;
  packs never need an *edge* purge (origin GC is the §2 retention pass).
  `scripts/r2-sync.sh` applies the two cache-control classes.
- **D5 — directory compressed at rest (2026-06, additive).** The `.sttd` object is one
  zstd frame, declared via `directory.encoding` (§3); absent = raw, so every previously
  deployed manifest stays readable byte-for-byte. ~2× smaller on the cold-start
  critical path; per-section framing (for partial directory reads) stays open for a
  future additive field.
- **D6 — byte-reproducible builds (2026-06).** The writer's blob and directory-entry
  sorts carry total tiebreaks (§5) so an identical rebuild re-derives identical content
  addresses — rebuilds of unchanged data cannot invalidate the immutable-object cache.
  (Caveat: payload bytes themselves are reproducible only within one builder run —
  Arrow IPC schema-metadata serialization order is not pinned across processes; the
  ordering layer is deterministic given identical payload bytes.)

## 9. Non-goals (tracked separately)
- **Low-zoom data volume** (the 80 MB zoom-out) → needs the summary/aggregate tier, not packing.
- **Worker / edge compute** → unnecessary; cacheability now lives in the format.

## 10. Versioning & file extensions

STT has **three independent version axes**; this spec governs only the first.

| Axis | Where | Current | Meaning |
| --- | --- | --- | --- |
| Packed **format** version | `manifest.formatVersion` | **1** | The manifest envelope + object layout described here. |
| **Directory** codec version | `manifest.directory.directoryVersion` | **5** | The run-length tile index encoding (`crate::directory`). v5 adds the per-run `pack_id` column + pack-relative offsets over v4. |
| **Tile payload** encoding | Arrow IPC schema / GeoArrow field metadata | — | Per-tile geometry + properties; archive-format-independent. |

Packed format v1 emits directory v5. The legacy single-file container (magic
`STT\x04`, "v4") is a fourth, retired axis — readable for transcode, never
written as output. Bumping any axis is a separate, independently-negotiated change.

**File extensions:** `.sttp` = pack object (tile blob data), `.sttd` = directory
object (the v5 index), `manifest.json` = the per-dataset manifest. `.stt` = the
legacy single-file archive (now only an internal streaming intermediate).

## 11. Relationship to standards

**No existing open standard covers temporally-tiled vector data.** That is the
niche this format occupies: a spatial tile pyramid crossed with a temporal axis,
columnar GPU-ready payloads, and cacheability as a property of the container.
The adjacent standards are listed here so the "why not an existing standard?"
question has a concrete answer, and so future convergence points are explicit.

### 11.1 OGC API – Tiles / Tile Matrix Sets

[OGC API – Tiles](https://docs.ogc.org/is/20-057/20-057.html) standardizes 2D
tile addressing and retrieval. Its only temporal hook is a `datetime`
conformance class — a *filter parameter* on requests, not a temporal axis in
the tile address. Multi-dimensional tiling exists only as **informative
Annex J** of the 2D Tile Matrix Set standard; no conformance class implements
it. STT's `(zoom, x, y, bucket)` addressing is exactly an Annex-J-style extra
dimension made normative:

| STT address component | Annex-J-style TMS concept |
| --- | --- |
| `zoom` | `tileMatrix` (identifier within the TileMatrixSet) |
| `x`, `y` | `tileCol`, `tileRow` (WebMercatorQuad-compatible) |
| `bucket` (`time_start`, width `temporal_bucket_ms`) | an additional dimension: `name: "time"`, regular interval of `temporal_bucket_ms` milliseconds, bounded by the dataset `metadata.time_range` |
| `--temporal-lod` coarser buckets | per-tileMatrix dimension resolution (coarser time step at lower zoom) |

If OGC ever promotes multi-dimensional tiling to a normative conformance
class, STT's directory is already expressible in those terms; until then this
mapping is documentation, not a compliance claim.

### 11.2 OGC Moving Features (MF-JSON)

[OGC Moving Features JSON](https://docs.ogc.org/is/19-045r3/19-045r3.html) is
the semantic ancestor: it standardizes *trajectory encodings*
(`MF_TemporalGeometry`, per-coordinate timestamp arrays — the same model as
our per-vertex `vertex_times`). But it is feature-at-a-time JSON with no
tiling, no columnar layout, and no GPU story — a payload semantics standard,
not a delivery format. The natural convergence is an ingest path
(`stt-build --input mf-json`): MF-JSON trajectories map losslessly onto STT's
per-vertex-timestamped LineStrings. Not yet implemented; recorded here as the
intended bridge.

### 11.3 STAC profile

[STAC](https://stacspec.org/) catalogs assets; it does not constrain their
format. An STT dataset is self-describing enough to be advertised as a STAC
Item with no extra metadata: `metadata.bounds` → `bbox`/`geometry`,
`metadata.time_range` → `start_datetime`/`end_datetime`, and the manifest as
an asset with an `stt` role:

```json
{
  "type": "Feature",
  "stac_version": "1.0.0",
  "id": "drifters",
  "bbox": [-180.0, -78.4, 180.0, 81.5],
  "geometry": { "type": "Polygon", "coordinates": [[[-180.0,-78.4],[180.0,-78.4],[180.0,81.5],[-180.0,81.5],[-180.0,-78.4]]] },
  "properties": {
    "datetime": null,
    "start_datetime": "1979-02-15T00:00:00Z",
    "end_datetime": "2022-10-04T00:00:00Z"
  },
  "assets": {
    "stt": {
      "href": "https://example.com/data/drifters/manifest.json",
      "type": "application/json",
      "roles": ["data", "stt"],
      "title": "STT packed dataset (manifest)"
    }
  }
}
```

A reader discovers the dataset via STAC, then follows `assets.stt.href` into
the §6 reader flow. Since `manifest.json` already embeds the full dataset
metadata, the Item is generable mechanically from the manifest alone.

### 11.4 GeoZarr

[GeoZarr](https://github.com/zarr-developers/geozarr-spec) (V1 RC ~May 2026)
is the emerging standard for chunked, cloud-native **rasters and datacubes**.
Time-varying gridded data is explicitly out of STT's scope — STT is for
temporally-tiled *vector* data (trajectories, events, time-varying features).
Cite GeoZarr (or COG for static rasters), don't compete with it; the two
formats are complementary halves of a spatiotemporal stack.

### 11.5 Foursquare Hex Tiles

[Hex Tiles](https://foursquare.com/resources/blog/developer/hex-tiles-building-a-new-data-tiling-system-with-h3/)
is the closest existing analog — a tiling system designed for spatiotemporal
analytics, with an explicit temporal axis. It is proprietary (Foursquare
Studio's internal format) and H3-cell-based rather than vector-geometry-based.
STT is positioned as **the open alternative**: a published spec
(this document + [`manifest.schema.json`](./manifest.schema.json)), two
reference implementations (Rust writer/reader, TypeScript reader), exact
vector geometry rather than hex aggregates — with an optional H3 summary tier
where pre-aggregation is the right tool.

### 11.6 GeoArrow (already implemented)

[GeoArrow 0.2](https://geoarrow.org/extension-types.html) is the
payload-level standard STT *already conforms to*: every tile's `geometry`
column carries `ARROW:extension:name` metadata
(conformance-tested in `crates/stt-core`), which is why a decompressed STT
tile opens directly in geoarrow-python / GeoPandas / Lonboard. The container
described in this spec is format-agnostic above the blob level; GeoArrow is
the normative payload contract (see
[`docs/architecture/data-format.md`](../architecture/data-format.md)).
