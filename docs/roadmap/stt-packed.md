# Packed format — roadmap / deferred work

> **Status: format SHIPPED 2026-06-07** (deployed to R2, all datasets); the
> **paged directory** shipped + committed 2026-06-11 (`92dc0d1`, `b503e24`). The
> live spec is [`docs/spec/stt-packed-format.md`](../spec/stt-packed-format.md)
> (paged container in §4.1). Everything else below is still open / deferred.

The packed format is **adopted and live**. The bets below were deliberately
**deferred** during the 2026-06 formalization pass — architectural, not cleanup,
and out of scope then. §3 is the one that shipped, kept here as a compact
decision record (rationale, not behavior). Recorded so the direction isn't lost.

> **Triage 2026-07-01:** re-confirmed against code. §1 and §2 stay **counted
> out** (architectural bets with no forcing cost today — revive §1 when
> cross-dataset dedup or incremental deploys become a real cost, §2 if the
> `--streaming-arrow` temp-single-file detour actually hurts; §2 is also the
> prerequisite for retiring the legacy single-file scripts in §5). §3's only
> remainder is the user-run rollout ops (below). §4 stays a measured NO-GO;
> note the world-grid cross-reference added there. §5 items carry individual
> statuses inline.

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

> **Update 2026-07: DONE — the single-file write path + `--streaming-arrow` were
> removed.** `stt-build` builds packed directories directly; the non-arrow
> `--streaming` path streams tiles into the `PackWriter`. The single-file
> `ArchiveWriter`/`ArchiveReader`, the transcode functions, and the `.stt`
> container are gone — D3 is closed. (Prose below is the historical record.)

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

## 3. Paged directory with temporal pruning (COPC-informed) — ✅ SHIPPED 2026-06-11

> **SHIPPED + COMMITTED** (`92dc0d1`, `b503e24`). Rust codec + writer
> (`directory_page.rs`), TS reader (`decodePagedRoot` + paged
> `getIndex`/`ensurePages` in `archive.ts`), manifest contract, `stt-validate`
> checks, and the `repack-directory` migration tool. Wire format specified in
> [`stt-packed-format.md` §4.1](../spec/stt-packed-format.md). This section is the
> compressed decision record (the standalone `paged-directory.md` plan it absorbs
> has been deleted). The leaf codec is unchanged v5 and the TS public surface —
> tileset + deck.gl/maplibre layers — is untouched.

**Problem.** The `.sttd` directory was a single whole-load blob on the cold-start
critical path — nothing could be requested until the whole directory was
resident. Measured fleet directories ran 5.9 KB → 15.8 MB; cost grew with dataset
size, not with what the session actually views. Paging makes cold start
proportional to the viewport/time-window footprint: a few-KB root page + only the
leaf pages the session visits, with temporal pruning *before* any leaf fetch.
Small datasets stay one read — request amplification never fires.

**Decisions (resolved).**

- **D1 — single-level (root + leaf pages), not a multi-level tree.** Max fleet
  directory ~560 K entries → ~137 pages at 4096/page → a ~7 KB root. COPC's
  K-level paging earns its keep at 1.2 B points; at our scale a flat page-table is
  simpler and fully covers the fleet. Door left open for a future level.
- **D2 — a leaf page is the existing v5 codec, verbatim.** Each leaf is a
  contiguous slice of directory order `(zoom, hilbert, time_start)` run through the
  unchanged `encode_directory`/`decodeDirectory`. Slicing resets delta state +
  splits RLE runs at boundaries (the measured +6–19% at-rest cost); reusing the
  fuzzed v5 codec makes the only new bytes the root page + framing.
- **D3 — page descriptor = geo-bbox + zoom-range + `[t_min, t_max]` +
  `cover_t_min` (FROZEN by the step-0 A/B sim).** Geo-bbox matched or beat the
  Hilbert-key-range model on every dataset where paging matters — nyc-taxi-points
  **9.5% / 15.5%** of whole-load (med/p90) vs hilbert 11.4% / 36.5%, drifters
  **25.0% / 35.1%** vs 26.3% / 66.1%; only ais-all-us favoured hilbert (2.7% /
  4.4% vs 0.9% / 1.8%) in an already-sub-5% regime. Geo-bbox wins the p90 tail
  because a viewport box maps to a Hilbert *interval* that falsely keeps
  spatially-distant pages, while geo-bbox tests real overlap. Bonus: zoom-correct,
  **no Hilbert port in TS**, composes with the future per-tile `geoarrow.box`
  covering column.
- **D4 — one content-addressed `.sttd`; root is a byte-range prefix.** Layout
  `[root page][leaf 0][leaf 1]…`; the reader range-GETs `bytes=0-(rootLength-1)`
  for the root, then ranges for leaves — never a second addressing path (the COPC
  anti-lesson). **Small-dataset fast path:** `length ≤ threshold` GETs the whole
  object and skips paging (wildfires-shaped datasets behave as before). Inlining
  the root into `manifest.json` (saves one RTT) is a noted future opt, deferred
  (it couples immutable-derived data into the mutable manifest).
- **D5 — `directoryVersion: 6` + `layout: "paged"`; v5 whole-load path retained.**
  Readers branch on layout: `paged` → the new query path; absent/`single` → the
  existing whole-load path, unchanged, for every un-migrated dataset.
- **D6 — per-page zstd, NO shared dictionary.** Each leaf is its own zstd frame so
  it is independently fetchable/decodable (the fzstd dictionary-less TS path keeps
  working). This forfeits the whole-directory zstd window (+6–19% generally; +117%
  on earthquakes, whose blob-dedup redundancy compresses 3.7× under one window) —
  **accepted:** paid once by the immutable CDN-cached object, *not* a per-session
  cost, while per-session bytes drop 1–2 orders of magnitude. A shared dict in the
  root would recover it but breaks the fzstd contract; parked (revisit only if
  at-rest `.sttd` size becomes a real problem — it is off the per-session path).

**Still open (rollout — user-run ops, not code; the tooling is complete).**
Fleet re-transcode + R2 re-sync + a browser-verify of a live paged dataset (held
per the dev-settling policy). Flip on per dataset with
`repack-directory <manifest> <out> 4096` (directory-only re-pack — the packs are
byte-unchanged, so re-sync is cheap; `repack-publish-all.sh` already paginates by
default with `PAGE_ENTRIES=4096`). Track **requests-to-first-frame** +
**bytes-to-first-frame** across the flip (the COPC "3 reads" benchmark) — this
is the same combined verify+sync gate that playback §7 and av-cockpit §4 carry;
run it once for all three.

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

**Measured: NO-GO in the cheap form (2026-06-11,
`crates/stt-core/examples/encoding-experiment.rs`, 400-tile samples of
drifters / ais-all-us / flights).** All variants re-zstd'd (packed is
zstd-per-blob), so the test is "does the transform make zstd's job better":

- Integer time columns: delta-varint wins big *relatively* (vertex_time
  −31% on drifters, feature times −55% on flights, −23% on ais) — but these
  columns are only **~0.3–0.8% of post-zstd payload**. Negligible absolute.
- Coordinates — the dominant column (~57% of drifters payload) — get **worse**
  under byte-shuffle (+31…+68%) and xor+shuffle (+49…+71%): zstd already
  models raw little-endian f64 world coords better than the shuffled layouts.
- Delta-bitpack consistently **loses to delta-varint when zstd follows**
  (dense packed bits resist the entropy pass; varint streams feed it) — skip
  FastPFOR-class packing entirely in a zstd-at-rest format.

**Conclusion:** no lightweight-encoding pass pays for its decoder. The real
size lever is **integer tile-local coordinate quantization** (MLT-style i32
tile coords instead of f64 world coords) — a format change with renderer
implications (precision at deep zoom, the f32-precision shader path), not an
encoding pass. Park it as its own bet if payload size becomes a priority;
the at-rest numbers above are the baseline to beat.

> **Cross-reference (2026-07-01):** coordinate quantization DID ship — but in
> the **world-grid** form (`stt-build --quantize-coords <m>`: i32 world-grid
> leaf + reconstruction affine), deliberately NOT the tile-local variant parked
> above, because the world grid preserves cross-tile content-address dedup
> that tile-local coords destroy. Measured −25..47% on coord-heavy datasets;
> the AV LiDAR fleet ships on it. Read this §4 as "encoding *transforms*
> declined; quantization landed via the world-grid route"; the tile-local bet
> stays parked with the same trigger.

## 5. Smaller follow-ups — triaged 2026-07-01

> **Update 2026-07: DONE — the single-file write path + `--streaming-arrow` were
> removed**, so the legacy single-file measurement scripts
> (`optimize-tiles.sh`, `reprocess-run.sh`) and the transcode/repack examples
> that exercised it were deleted along with it. (Prose below is the historical
> record.)

- **`stt-optimize` packed awareness — COUNTED OUT.** Its loader reads GeoParquet
  + legacy single-file `.stt` only; a packed-manifest loader is a low-risk
  additive variant, but nothing currently needs to re-analyse a shipped packed
  dataset (analysis runs pre-build on sources). Revive with the first real
  re-analysis ask.
- **Retire single-file measurement scripts — COUNTED OUT (blocked by design).**
  `scripts/optimize-tiles.sh` / `reprocess-run.sh` are labelled LEGACY and stay
  until §2's streaming `PackWriter` deletes the single-file write path they
  exercise — deleting them earlier would drop the only coverage of that path.
- **Requests-to-first-frame metric — folded into the §3 rollout (user-run ops).**
  Capture requests/bytes-to-first-frame (manifest → directory → first slice, the
  COPC "3 reads" benchmark) as part of the fleet re-transcode + R2 re-sync +
  browser-verify pass — measuring it before the paged flip is live would just
  measure the old layout.
- **Adoption kit — COUNTED OUT until npm publish.** The portable half is written
  ([`docs/spec/conformance.md`](../spec/conformance.md)); the hosted
  validate/inspect page is explicitly gated on the npm publish landing (its own
  workstream), as originally stated.
- **Cross-process reproducible payload bytes** — owned by
  [`data-sources-and-encoder.md`](./data-sources-and-encoder.md), where it is
  now **resolved-by-path** (2026-07-01): the encoder side is deterministic
  (sorted `BTreeMap`s) with logical-fingerprint guard tests in
  `crates/stt-core/tests/reproducible_build.rs`; strict byte-identity waits on
  the workspace arrow upgrade (arrow-ipc ≥59 sorts IPC metadata keys), with the
  `#[ignore]`d byte-identity test as the acceptance gate. The gap is narrower
  than this bullet originally implied.

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
