# Packed format — roadmap / deferred work

> **Status: format SHIPPED 2026-06-07** (deployed to R2, all datasets). Every
> item below is still open / deferred as of 2026-06-10.

The packed format is **adopted and live** (see
[`docs/spec/stt-packed-format.md`](../spec/stt-packed-format.md)). The items
below were deliberately **deferred** during the 2026-06 formalization pass — they
are architectural bets, not cleanup, and were not in scope. Recorded here so the
direction isn't lost.

## 1. Global content-addressed pack store

**Today:** each dataset owns its own `packs/` directory, so blake3 dedup only
fires *within* a dataset.

**Bet:** move packs into one shared, content-addressed store
(`/packs/<blake3>.sttp`) with per-dataset manifests pointing into it — the Git
object-store / Docker-layer model. The manifest's "`packs[]` index **is** the
`pack_id`" design already supports this: the index stays manifest-local; only the
`key` changes to point at the shared store.

**Unlocks:**
- **Cross-dataset / cross-version dedup** — shared basemap, summary, or
  near-duplicate tiles stored once. (Within-dataset dedup already shrank
  earthquakes 266 MB → 72 MB; cross-dataset is the next increment.)
- **Incremental deploys** — a rebuild that changes two tiles ships the one or
  two new packs, not the whole dataset. Re-sync skips unchanged content
  addresses for free.
- **A natural GC story** — a pack is collectible once no live manifest references
  its hash.

**Open questions:** GC / refcount policy; whether the store is per-origin or
per-deploy; cache-key implications (still immutable, so unaffected); how
`r2-sync.sh` enumerates the shared store vs per-dataset trees.

## 2. Streaming `PackWriter` (closes spec D3)

**Today:** the only reason the single-file `ArchiveWriter` / `write_tail` write
path still exists is that `stt-build --streaming-arrow` needs a bounded-RAM
intermediate, and `PackWriter` currently buffers all tiles in memory to compute
blob ordering before cutting packs.

**Bet:** a spill-to-disk streaming `PackWriter` that orders and cuts packs
without holding the whole tile set in RAM. Then `--streaming-arrow` can cut packs
directly, and the single-file **write** path (and the v4-only write code) can be
deleted outright — finally closing decision **D3** (currently "demoted, not
deleted"). The v4 **read** path stays for transcoding old archives.

**Open questions:** how to choose a good blob ordering with only a streaming
(not global) view — e.g. external-sort the directory keys, or a two-pass
build (index pass to decide ordering, payload pass to write packs).

## 3. Paged directory with temporal pruning (COPC-informed)

**Today:** the `.sttd` directory is a single whole-load blob on the cold-start
critical path (spec §6: cold load = manifest + **entire directory** + pack
ranges). Measured at-rest sizes across the showcase fleet (2026-06-11, pre-zstd):
5.9 KB (nyc-taxi-flows) → **15.8 MB** (nyc-taxi-points, ais-all-us), with five
datasets over 7 MB. zstd-at-rest (D5) halves that but doesn't change the shape:
cost grows with dataset size, not with what the session actually views. The spec
already leaves "per-section framing (for partial directory reads)" open — this is
that bet, designed.

**Bet:** adopt COPC's paged-hierarchy design (see *Prior art* below), plus the
one improvement its community temporal extension added:

- Fixed-width entries; a sentinel field discriminates *data entry* vs *pointer
  to a child directory page* vs *empty-but-descend* — one homogeneous record
  type, no framing (entry count = page bytes / entry size).
- Pages cut every K tree levels; subtrees under a node-count threshold are
  inlined into the parent page so small datasets stay **one root page** and
  request amplification never fires. (COPC: K=4, inline ≤50 nodes; typical
  ≤5-level files = whole directory in one small read.)
- **Hoist `t_min`/`t_max` (and the `cover_t_min` bound) onto the page-pointer
  entries themselves**, so a reader prunes whole subtrees/pages by time *without
  fetching them*. This is the COPC temporal extension's headline trick and a
  strict generalization of our `cover_t_min` covering section.

**Unlocks:** cold start proportional to the viewport/time-window footprint, not
dataset size — a 15 MB directory becomes a few-KB root page + pages for visited
subtrees; temporal pruning before any page fetch; the directory stops being the
reason large datasets feel slow to open.

**Open questions:** page-key scheme over our (z,x,y,t) directory order (COPC
pages over an octree; we page over directory-sort runs — does run-length encoding
survive page boundaries?); interaction with the global-coalesce fetch layer
(pages are just more ranges to coalesce); whether the root page lives inline in
`manifest.json` to save a request (COPC needs 3 requests to first render —
adopt **requests-to-first-frame** as a tracked metric either way).

## 4. Lightweight column encodings (MLT-informed)

**Today:** Arrow IPC tile payloads ship raw i32/f32 columns and rely entirely on
HTTP gzip/brotli; quantized `vertex_time` and tile-local coordinates are
monotone-ish columns that transparent compression handles far worse than a
delta pass would.

**Bet:** a small, fixed set of per-column lightweight encodings — **delta +
bit-packing for sorted/monotone integer columns, RLE for low-cardinality ones**
— declared per column, applied before (or instead of) transport compression.
MLT's published result (SIGSPATIAL'25): lightweight-encoded columns beat
*gzipped* MVT on size (1.1–2×) while decoding 2–3× **faster** — the rare
no-tradeoff outcome — because decode becomes branch-light array arithmetic and
whole streams can be skipped.

**Hard constraint, learned from MLT's pain:** every encoding admitted costs a
port per decoder platform. MLT's FSST/FastPFOR/ALP advanced set forced a
two-profile spec, WASM shims, and cross-language decode breakage. We have one
client language today — keep it that way by capping the toolbox at **two
encodings** and skipping the adaptive per-tile selection machinery entirely
(declare the encoding in column metadata; the writer picks once per column).

**Open questions:** whether this lives inside the Arrow IPC envelope (custom
metadata + encoded child buffers, decode-on-arrival) or motivates dropping IPC
framing for hot columns — MLT's `VectorType`-tagged vectors with explicit
16/64-byte alignment are an existence proof that zero-copy GPU upload survives
without IPC's padding regime (relevant to the ALIGNED_FRAME_FLAG work);
measure on `vertex_time` + coordinate columns of one heavy dataset first.

## 5. Smaller follow-ups

- **`stt-optimize` packed awareness** — it still analyses GeoParquet and legacy
  single-file `.stt`; teach its loader to read a packed dataset so it can
  re-analyse shipped datasets directly.
- **Retire single-file measurement scripts** once (1)/(2) land —
  `scripts/optimize-tiles.sh` and `reprocess-run.sh` are single-file-only
  (now labelled LEGACY).
- **Requests-to-first-frame metric** — COPC reaches first render in 3 range
  requests (589 B header probe → root directory page → root chunk). Measure
  STT's cold-start equivalent (manifest → directory → first slice) and track it
  as a number; it's the user-facing cost that §3 exists to cut.
- **Adoption kit** — COPC's spread was driven less by range reads than by a
  one-sitting spec, a reference writer, a hosted validator
  (validate.copc.io), and a drag-and-drop web viewer. `stt-validate` is the
  seed; a hosted validate/inspect page is cheap once the npm publish lands.

## Prior art: COPC & MapLibre Tiles (studied 2026-06-11)

Condensed from a deep read of [COPC](https://copc.io/) (cloud-optimized point
clouds) and the [MapLibre Tile spec](https://maplibre.org/maplibre-tile-spec/)
(MLT). What transfers, what doesn't, and what to avoid.

**COPC** — "EPT in a single LAZ": octree of LAZ chunks + a **lazy paged
hierarchy** in (E)VLRs, range-read from a dumb HTTP server.

- Hierarchy entry = fixed **32 B** (`VoxelKey` 16 + offset 8 + byteSize 4 +
  pointCount 4); `pointCount > 0` data / `-1` child page / `0` empty-but-descend.
  No page header — count implied by byte size. Reference writer pages every 4
  levels, inlines subtrees ≤ 50 nodes.
- A third-party **temporal index extension** (multi-epoch surveys) sorts points
  by time within each node, stores strided time samples per node, and puts
  **subtree t-min/max on the page pointers** — whole-page pruning with zero
  fetches; their worked example answers a spatiotemporal query on a 5.7 GB /
  1.2 B-point file in **4 reads / ~110 KB**. The strided samples also estimate
  byte sub-ranges *inside* a blob — a possible future path to partial-tile
  reads for narrow time windows.
- Why it won vs many-files EPT: single asset/URL, CDN-cacheable ranges,
  graceful degradation ("any LAZ reader still reads it"), one canonical writer
  + public validator + viewer, ~370-line spec. Core shipped with **zero**
  temporal support — the ecosystem had to bolt it on, which validates STT's
  time-native premise.
- **Anti-lesson:** COPC keeps two parallel addressings of the same chunks (LAZ
  chunk table + hierarchy offsets) for backward compat; generic LAZ tools
  rewrite chunks under a stale hierarchy → valid-LAZ, corrupt-COPC files.
  Content-addressed packs are the stronger integrity story — never add a
  second addressing path beside them.

**MLT** — columnar successor to MVT (official release 2026-01): per-layer
FeatureTables of typed columns, each column split into Present/Data/Length/
Offset streams with per-stream lightweight encodings.

- Encoding toolbox: Boolean-RLE presence bitmaps, RLE / delta / delta-RLE
  integers, SIMD-FastPFOR bit-packing, FSST + shared string dictionaries,
  Hilbert/Morton-sorted vertex dictionaries; selection is adaptive per column
  per tile (BtrBlocks-style trial encoding). Benchmarks: 1.1–2× smaller than
  *gzipped* MVT, 2–3× faster decode, property-only scans 3.7–4.4× faster,
  lazy geometry-skip 14.8× — columnar's killer app is **skipping**, not just
  compression. Real-world caveat: on already-optimized tilesets the size win
  shrinks to ~10–30%.
- The advanced encodings nearly sank portability (per-language ports, WASM
  shims, a spec split into simple/advanced profiles, one encoder shipping an
  encoding before any decoder could read it) — the source of §4's two-encoding
  cap.
- Relevant patterns: u32 dictionary offsets (the fix-class for our u16
  overflow family); optional in-tile pre-tessellation streams
  (`NumTriangles` + `IndexBuffer` → GPU-ready polygons; spec'd but their own
  JS renderer doesn't consume it yet — pattern proven, economics not);
  no-global-header concatenability (tiles assembled by concatenating
  independently encoded tables — echoes pack assembly without re-encode);
  sorting as a first-class, spec-level compression lever (matches our layout
  simulator, minus their freedom to reorder — we have a temporal constraint).
- MLT has **no temporal semantics**: Timestamp is a plain per-feature i64
  column; vertex-scoped property columns (structurally our per-vertex time)
  are experimental with ordering still TODO. Both ecosystems leave STT's
  time-native wedge uncontested.
