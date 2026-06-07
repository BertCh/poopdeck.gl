# STT Packed Format (v1) — Specification

Status: **DRAFT — awaiting sign-off** · Replaces single-file v4 (`STT\x04`) as the canonical format.

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
  `Cache-Control: public, max-age=31536000, immutable` → cached forever, **never
  purged**, and re-sync skips unchanged packs (incremental deploys, cross-version dedup).
- **`manifest.json` is the only mutable object** → short `max-age` (e.g. 60 s) and/or
  explicit purge on deploy. It is tiny (a few KB), so this is cheap. It is the only
  thing a deploy must invalidate.

## 3. `manifest.json` schema

```json
{
  "format": "stt-packed",
  "formatVersion": 1,
  "compression": "zstd",
  "directory": { "key": "index/<hash>.sttd", "length": 1234567, "directoryVersion": 5 },
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

## 4. Directory format v5 (extends the v4 codec)

Reuses the entire v4 columnar + delta+zig-zag varint + blob-run RLE + trailing
`COVER_SECTION_TMIN` scheme (`crates/stt-core/src/directory.rs`). Changes only:

- `DIRECTORY_VERSION = 5`.
- `TileEntry` gains `pack_id: u32`. It is a per-blob (per-run) property, not a per-entry key.
- **Run identity** additionally requires equal `pack_id` (two entries RLE-collapse only
  when same pack *and* same blob).
- A new **per-run `pack_id` column**, delta+zig-zag coded against the previous run's
  `pack_id` (packs are near-monotonic in directory order → ~1 byte/run).
- **`offset` becomes pack-relative.** The existing offset contiguity sentinel is kept
  verbatim, except `expected_offset` resets to `0` whenever `pack_id` changes between
  consecutive runs (so the first run of each pack still hits the cheap `0` sentinel).

Per-entry key columns (Δzoom, Δhilbert, Δx, Δy, Δtime_start, duration, feature_count,
temporal_bucket_ms flag) and the cover section are **unchanged**.

## 5. Pack-cutting (writer)

1. Order blobs by `BlobOrdering` (default = `simulate_layout`'s empirical per-dataset
   winner if available, else `BlobOrdering::choose`). Locality → fewer packs per viewport.
2. Per-blob zstd, byte-identical dedup (blake3). **No shared dictionary** (keeps the
   fzstd TS reader able to decode — same contract as `create_reordered`).
3. Cut the ordered, deduped blob stream into packs of **≤ `pack_target_bytes`** (default
   **64 MiB**, override `--pack-size`). Never split a blob across packs; prefer cutting on
   zoom-level boundaries.
4. Assign `pack_id` in cut order; `offset_in_pack` resets to 0 per pack.
5. blake3 each finished pack and the encoded directory → content-addressed filenames.
6. Emit `manifest.json` (metadata + directory pointer + pack table).

## 6. Reader flow (identical contract, Rust + TS)

1. `GET manifest.json` → metadata, directory `{key,length}`, `packs[]`.
2. `GET <directory.key>` (one whole-object fetch, immutable/cached) → decode v5 entries,
   each carrying `(pack_id, offset_in_pack, length, …)`.
3. Tile read: `entry` → `pack = packs[entry.pack_id]` → range `GET pack.key`
   `bytes=<offset>-<offset+length-1>`.
4. **Coalescing is per-pack**: group needed entries by `pack_id`, then coalesce by offset
   gap *within* each pack (a range can't bridge two pack objects); a concurrency pool runs
   groups in parallel.
5. Decompress per-blob zstd (fzstd in TS — no dict).

Cold load = 1 manifest + 1 directory + N pack ranges. Warm = all served from edge cache.

## 7. Component changes

### Rust — `crates/stt-core`
- `archive.rs`: `TileEntry += pack_id`. Keep `ArchiveReader` (v4 single-file, mmap) **as the
  transcode input reader**. Remove the v4 single-file **write** path (`write_tail` etc.).
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
- `scripts/r2-sync.sh`: sync per-dataset trees; **two** `Cache-Control` passes — `immutable`
  for `packs/` + `index/`, short TTL for `manifest.json`.

## 8. Open decisions (sign-off)

- **D1 — pack target size.** Default **64 MiB**? Smaller → finer cache granularity + more
  parallelism, but more objects + more R2 GET ops to warm. Larger → fewer objects, coarser.
- **D2 — hash.** blake3, 128-bit (32 hex). OK? (blake3 already used for dedup.)
- **D3 — drop the v4 *write* path** (keep v4 read only for transcoding). Matches "replace."
- **D4 — manifest freshness.** Short `max-age` (auto, slightly stale-tolerant) vs
  purge-`manifest.json`-on-deploy (always fresh, one purge per dataset).

## 9. Non-goals (tracked separately)
- **Low-zoom data volume** (the 80 MB zoom-out) → needs the summary/aggregate tier, not packing.
- **Worker / edge compute** → unnecessary; cacheability now lives in the format.
