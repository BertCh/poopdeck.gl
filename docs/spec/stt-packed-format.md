# STT Packed Format (v1) — Specification

The canonical STT container. Machine-checkable manifest
contract: [`manifest.schema.json`](./manifest.schema.json). Versioning model: §9.

## 1. Motivation

A single-file archive cannot be edge-cached once it exceeds the CDN per-object
limit (Cloudflare Free/Pro/Business = 512 MB): a multi-GB dataset returns
`cf-cache-status: BYPASS` on every range request, so all reads hit origin for
every user. Reordering blobs does not change this.

The packed format makes the cacheable unit a small object, not the whole
dataset. Data is split into many content-addressed *pack* objects (each well under
the limit) plus a tiny manifest. A dumb CDN caches each pack natively. No Worker, no
vendor lock-in — cacheability is a property of the format, so it works on R2, S3,
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
  "directory": { "key": "index/<hash>.sttd", "length": 1234567, "directoryVersion": 5, "encoding": "zstd",
                 "layout": "paged", "rootLength": 7024, "pageCount": 137, "pageEntries": 4096 },
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
- `directory.encoding` (OPTIONAL): at-rest encoding of the `.sttd`
  object. `"zstd"` = a zstd frame wrapping the directory codec bytes (~2× smaller; the
  directory sits on the cold-start critical path with no CDN content-encoding rescue).
  For a **paged** directory (below) it describes the framing of *each page* (root + every
  leaf), not one frame over the whole object. **Absent = raw codec bytes.** The content
  address (`key`) and `length` always describe the **at-rest** bytes (i.e. the compressed
  bytes when `encoding` is set), so readers validate the fetched body length before decoding.
  Readers MUST support both shapes and MUST fail loudly on an unrecognized value.
- `directory.layout` (OPTIONAL): container shape. `"paged"` = a root page + leaf pages
  (§4.1), so a cold reader fetches only the leaves its viewport/time-window touches.
  **Absent or `"single"` = the whole-load object** (one buffer the reader decodes in full).
  When `"paged"`, `rootLength` (at-rest byte length of the root prefix), `pageCount` and
  `pageEntries` accompany it. The leaf codec is unchanged v5 — `layout`, not
  `directoryVersion`, discriminates the container.
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

**Sort order.** Entries are sorted into directory order `(zoom, hilbert,
time_start)` — the codec's own (stable) sort key; the writer pre-sorts with
the additional `temporal_bucket_ms` tiebreak of §5, which the stable sort
preserves — so every key column is near-monotonic and delta-codes to ~1 byte
per entry.

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
> for Web-Mercator tiles and Unix-ms time. The directory is single-level (no
> leaf directories).

## 4.1 Paged container (optional `layout: "paged"`)

A whole-load directory must be fetched and decoded in full before any tile can
be requested — cost grows with dataset size, not with what a session views (a
15 MB directory on the cold-start critical path). The **paged container** wraps
the v5 codec so a cold reader fetches a tiny root page plus only the leaf pages
its viewport/time-window touches. Implemented in `crates/stt-core/src/directory_page.rs`
(Rust) and `packages/core/src/directory.ts` (`decodePagedRoot`, TS).

**Layout.** The `.sttd` object is a root frame followed by leaf frames:

```text
.sttd  =  [root page frame][leaf 0 frame][leaf 1 frame] ...
```

- A **leaf page** is the *unchanged* §4 v5 codec over a contiguous slice of
  directory order `(zoom, hilbert, time_start)`. Slicing resets delta state and
  splits RLE runs at boundaries — the only paging cost (measured +6–19% at rest,
  paid once by the immutable CDN object, not per session).
- Each page (root + every leaf) is an **independent frame**: when
  `encoding == "zstd"` each is its own zstd frame (no shared dictionary, so the
  fzstd TS path decodes every page); absent = raw codec bytes per page.
- The directory is **single-level** (a flat page table; no multi-level tree) —
  sufficient for the whole fleet (~560 K entries → ~137 pages → a ~7 KB root).

**Root page** — a fixed-width header + one fixed-width descriptor per leaf (count
= bytes / width, no per-record framing). All little-endian:

```text
u8   root_version = 1
u8   descriptor_kind = 0          # 0 = geo-bbox + zoom-range + temporal bounds
u16  reserved = 0
u32  page_count P
u32  page_entries                 # nominal entries-per-page used at build

repeat P  (52 bytes each):
  u64  rel_offset                 # leaf byte offset RELATIVE TO rootLength
                                  #   (absolute = rootLength + rel_offset)
  u32  length                     # at-rest (framed) byte length of the leaf
  u32  entry_count                # entries in this leaf (Σ == N)
  u8   min_zoom
  u8   max_zoom
  u16  reserved = 0
  i32  min_lon_e7, min_lat_e7,    # geographic bbox, lon/lat × 1e7 fixed point;
       max_lon_e7, max_lat_e7     #   mins floored / maxes ceiled so the integer
                                  #   bbox always COVERS the leaf's tiles
  i64  t_min                      # min(cover_t_min ?? time_start) over the leaf
  i64  t_max                      # max(time_end) over the leaf
```

Offsets are relative to the root's end so the root encodes without knowing its
own at-rest length first.

**Descriptor choice (geo-bbox).** A reader prunes a leaf when its **zoom range**
excludes the query zoom, its **geo bbox** misses the viewport, or its
**`[t_min, t_max]`** misses the time window — all without fetching the leaf. The
geographic bbox (rather than a Hilbert key range) is zoom-correct and needs no
Hilbert index in the reader; it was frozen over the alternative by an A/B sim
(`crates/stt-core/examples/directory-paging-sim.rs`): at 4096 entries/page it
matched or beat Hilbert-range pruning on every dataset where paging matters
(nyc-taxi-points 9.5%/15.5% of whole-load med/p90; drifters 25.0%/35.1%),
because a viewport box maps to a Hilbert *interval* that falsely keeps
spatially-distant pages while geo-bbox tests real overlap. It also composes with
a future per-tile `geoarrow.box` covering column.

**Covering section.** A leaf emits the §4 covering section iff **every** entry in
the *whole directory* carries `cover_t_min` (a global decision, so a paged
directory decodes byte-for-identical-entries to a whole-load directory of the
same corpus). Per-leaf `t_min` already encodes the tight lower bound on the page
pointer.

**Validation.** Beyond plain decode (root frame, leaf byte-ranges, per-leaf
entry counts), `stt-validate` checks the paged-specific invariants
(`verify_paged_structure`): every descriptor's bounds **cover** its leaf's
entries (geo bbox, zoom range, temporal) so a prune never drops a matching tile,
and cross-page key order is monotonic in `(zoom, hilbert, time_start)`.

## 5. Pack-cutting (writer)

1. Order blobs by `BlobOrdering` (default `Auto`, i.e. `--blob-ordering auto`:
   resolved at finalize via `BlobOrdering::choose` from the dataset's space-vs-time
   cardinality — wide-time → spatial-major, else 3D Hilbert). Locality → fewer packs
   per viewport.
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
frame**: after each `ipc_len`, zero bytes pad the position to the
next 8-byte boundary *relative to the payload start*, so every Arrow IPC stream
begins 8-byte aligned and a reader can hand it to an Arrow implementation zero-copy
(Arrow guarantees buffer alignment only *within* a stream; a stream at a misaligned
offset forces a copy of every buffer). The pad length is **never stored** — readers
derive it as `(8 - pos % 8) % 8` from the position after `ipc_len`; `ipc_len` is the
exact IPC byte length, padding excluded. Frames with the flag unset carry no padding
and decode without it; readers MUST accept both. The flag caps the layer count at
`0x7fff` (layer counts are tiny in practice).

## 6. Reader flow (identical contract, Rust + TS)

1. `GET manifest.json` → metadata, directory `{key,length,encoding?,layout?,rootLength?}`, `packs[]`.
2. Load the directory, branching on `layout`:
   - **single** (or `layout` absent): `GET <directory.key>` (one whole-object fetch,
     immutable/cached) → validate body length against `directory.length`, unwrap
     `encoding` if set, then decode v5 entries, each carrying `(pack_id, offset_in_pack,
     length, …)`. Build the in-memory `(z,x,y[/t])` indexes.
   - **paged**: if `directory.length` ≤ a small cutoff (the reader's
     `directoryPageThresholdBytes`, default 256 KiB), whole-load as above (decode root +
     all leaves). Otherwise range-`GET bytes=0-(rootLength-1)` for the **root page** only,
     decode its descriptors, and leave the entry indexes empty. A query then selects the
     leaves overlapping its `(viewport bbox, zoom, time window)` from the root descriptors,
     range-fetches the missing ones (coalescing adjacent leaf ranges within the object) and
     merges their entries — so the entry indexes fill in **incrementally**, proportional to
     the query footprint.
3. Tile read: `entry` → `pack = packs[entry.pack_id]` → range `GET pack.key`
   `bytes=<offset>-<offset+length-1>`.
4. **Coalescing is per-pack**: group needed entries by `pack_id`, then coalesce by offset
   gap *within* each pack (a range can't bridge two pack objects); a concurrency pool runs
   groups in parallel. (Leaf-page reads against the `.sttd` object coalesce the same way.)
5. Decompress per-blob zstd (fzstd in TS — no dict).

Cold load (single) = 1 manifest + 1 directory + N pack ranges. Cold load (paged) =
1 manifest + 1 root range + the few leaf ranges the first viewport touches + N pack
ranges — directory bytes proportional to the viewport, not the dataset. Warm = all
served from edge cache.

## 7. Design decisions

The rationale behind the format's locked-in choices:

- **D1 — pack target size = 64 MiB** (override `--pack-size`). Well under the 512 MB
  CDN per-object cap, fine enough for granular caching + parallel range reads, coarse
  enough to keep the object count (and R2 GET ops to warm) modest. A single blob larger
  than the target gets its own oversized pack (blobs are never split).
- **D2 — content address = blake3, 128-bit** (32 hex chars). blake3 is already the
  dedup hash; 128 bits is collision-safe at our object counts and keeps keys short.
- **D3 — the single-file container is an intermediate, not a deployment target.** The
  single-file writer is not a deployment output; it serves as (a) the bounded-RAM
  **intermediate** that `stt-build --streaming-arrow` transcodes into packs, and (b) the
  read side that `transcode_archive_to_packs` consumes to migrate older archives. The
  single-file *read* path is retained for transcode.
- **D4 — manifest freshness = short `max-age` + `must-revalidate`.** `manifest.json`
  ships `max-age=60, must-revalidate`; packs/index ship `immutable, max-age=31536000`.
  Revalidation (`REVALIDATED`) keeps the tiny manifest fresh without a mandatory purge;
  packs never need an *edge* purge (origin GC is the §2 retention pass).
  `scripts/r2-sync.sh` applies the two cache-control classes.
- **D5 — directory compressed at rest.** The `.sttd` object is one
  zstd frame, declared via `directory.encoding` (§3); absent = raw codec bytes, which
  readers also accept. ~2× smaller on the cold-start critical path.
- **D6 — byte-reproducible builds.** The writer's blob and directory-entry
  sorts carry total tiebreaks (§5) so an identical rebuild re-derives identical content
  addresses — rebuilds of unchanged data cannot invalidate the immutable-object cache.
  (Caveat: payload bytes themselves are reproducible only within one builder run —
  Arrow IPC schema-metadata serialization order is not pinned across processes; the
  ordering layer is deterministic given identical payload bytes.)

## 8. Non-goals
- **Low-zoom data volume** (the 80 MB zoom-out) → needs the summary/aggregate tier, not packing.
- **Worker / edge compute** → unnecessary; cacheability now lives in the format.

## 9. Versioning & file extensions

STT has **three independent version axes**; this spec governs only the first.

| Axis | Where | Current | Meaning |
| --- | --- | --- | --- |
| Packed **format** version | `manifest.formatVersion` | **1** | The manifest envelope + object layout described here. |
| **Directory** codec version | `manifest.directory.directoryVersion` | **5** | The run-length tile index encoding (`crate::directory`). v5 adds the per-run `pack_id` column + pack-relative offsets over v4. |
| **Tile payload** encoding | Arrow IPC schema / GeoArrow field metadata | — | Per-tile geometry + properties; archive-format-independent. |

Packed format v1 emits directory v5. The single-file container (magic
`STT\x04`, "v4") is a fourth, retired axis — readable for transcode, never
written as output. Bumping any axis is a separate, independently-negotiated change.

**File extensions:** `.sttp` = pack object (tile blob data), `.sttd` = directory
object (the v5 index), `manifest.json` = the per-dataset manifest. `.stt` = the
single-file archive (the internal streaming/transcode intermediate).

## 10. Relationship to standards

**No existing open standard covers temporally-tiled vector data.** That is the
niche this format occupies: a spatial tile pyramid crossed with a temporal axis,
columnar GPU-ready payloads, and cacheability as a property of the container.
The adjacent standards are listed here so the "why not an existing standard?"
question has a concrete answer, and so future convergence points are explicit.

### 10.1 OGC API – Tiles / Tile Matrix Sets

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

### 10.2 OGC Moving Features (MF-JSON)

[OGC Moving Features JSON](https://docs.ogc.org/is/19-045r3/19-045r3.html) is
the semantic ancestor: it standardizes *trajectory encodings*
(`MF_TemporalGeometry`, per-coordinate timestamp arrays — the same model as
our per-vertex `vertex_times`). But it is feature-at-a-time JSON with no
tiling, no columnar layout, and no GPU story — a payload semantics standard,
not a delivery format. The natural convergence point is an ingest path
(`stt-build --input mf-json`): MF-JSON trajectories map losslessly onto STT's
per-vertex-timestamped LineStrings.

### 10.3 STAC profile

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

### 10.4 GeoZarr

[GeoZarr](https://github.com/zarr-developers/geozarr-spec) (V1 RC ~May 2026)
is the emerging standard for chunked, cloud-native **rasters and datacubes**.
Time-varying gridded data is explicitly out of STT's scope — STT is for
temporally-tiled *vector* data (trajectories, events, time-varying features).
Cite GeoZarr (or COG for static rasters), don't compete with it; the two
formats are complementary halves of a spatiotemporal stack.

### 10.5 Foursquare Hex Tiles

[Hex Tiles](https://foursquare.com/resources/blog/developer/hex-tiles-building-a-new-data-tiling-system-with-h3/)
is the closest existing analog — a tiling system designed for spatiotemporal
analytics, with an explicit temporal axis. It is proprietary (Foursquare
Studio's internal format) and H3-cell-based rather than vector-geometry-based.
STT is positioned as **the open alternative**: a published spec
(this document + [`manifest.schema.json`](./manifest.schema.json)), two
reference implementations (Rust writer/reader, TypeScript reader), exact
vector geometry rather than hex aggregates — with an optional H3 summary tier
where pre-aggregation is the right tool.

### 10.6 GeoArrow

[GeoArrow 0.2](https://geoarrow.org/extension-types.html) is the
payload-level standard STT conforms to: every tile's `geometry`
column carries `ARROW:extension:name` metadata
(conformance-tested in `crates/stt-core`), which is why a decompressed STT
tile opens directly in geoarrow-python / GeoPandas / Lonboard. The container
described in this spec is format-agnostic above the blob level; GeoArrow is
the normative payload contract (see
[`docs/architecture/data-format.md`](../architecture/data-format.md)).
