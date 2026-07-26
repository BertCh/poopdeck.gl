# STT packed format — consolidated decision record

> **Re-consolidated 2026-07-24.** Rationale, measured baselines, negative results
> ("don't relitigate"), counted-out items with revival triggers. Normative
> behavior lives in [`stt-packed-format.md`](../spec/stt-packed-format.md) and
> [`cli-reference.md`](../api/cli-reference.md); this doc never restates it.
> Absorbs the durable content of `stt-packed.md`, `stt-format-review-2026-07.md`,
> `stt-packed-v2-design-2026-07.md`, `blob-ordering-heuristic-2026-07.md`,
> `rust-audit-2026-06.md`, `stt-optimize-intelligence-2026-07.md`,
> `space-time-lod-2026-07.md`, `preprocessing-framework.md`, and the wire-token
> invariants of `naming-types-consistency-2026-06.md`.
>
> Lineage: packed shipped 2026-06-07; paged directory 2026-06-11; deep-review
> Phases A/B/T1.1/D2 and packed-v2 both closed 2026-07-05; 0.3.0 published to
> crates.io **and** npm 2026-07-05 (tree now 0.5.0). Two old caveats are dead:
> determinism is CLOSED (arrow ≥ 59 — identical rebuilds re-derive identical pack
> names), and transcoding (single-file container, `ArchiveWriter`/`ArchiveReader`,
> `--streaming-arrow`) was removed entirely 2026-07-04.

## 1. Positioning — the five defended contributions

Independently assessed in the 2026-07 deep review. No shipping open format has:

1. **The temporal directory** — `(z,x,y,t)`-keyed delta+zigzag varint columns with
   blob-run RLE collapsing _time-identical_ content (the temporal analogue of
   PMTiles collapsing ocean tiles), plus `cover_t_min` backward-coverage and
   per-leaf `[t_min,t_max]` page pruning.
2. **Byte-reproducible content-addressed builds as a spec concern** — what makes
   the immutable-CDN economics real rather than aspirational.
3. **World-anchored quantization** — a few % of compression traded for cross-tile
   dedup (per-tile grids cost **+61 %**); the original answer to tile-local grids.
4. **Trajectory payload primitives** — `vertex_time` u16-delta with a bounded
   precision ceiling and exact-Int64 fallback, plus the `vertex_value_matrix`
   space-time-cube column. Absent from MVT/MLT/GeoParquet.
5. **Zero-copy GPU discipline** — 8-byte-aligned frame + FixedSizeList interleaved
   leaves; IPC buffers reach the GPU without a copy.

The foundation (Arrow IPC tiles + GeoArrow + content-addressed packs + zstd +
Hilbert/Morton ordering + consolidated manifest) is the convergent cloud-native
SoTA design, independently matching PMTiles v3, COPC, Zarr-v3 sharding, MLT. The
niche — **time as a first-class tiling axis for vector features** — has no
standard; everyone else loads spatial tiles and filters time client-side, which
breaks exactly when the series won't fit in memory. **Squeeze risk, plainly:** the
moat is the temporal directory + reproducible builds + trajectory primitives
_plus the renderer stack_; the container alone is squeezable by a future MLT
temporal extension or GeoZarr from either side.

## 2. Measured baselines

**v1 byte-level probe** (arrow 59, zstd-3, single point layer):

| Config                    | raw payload | zstd      | note                                               |
| ------------------------- | ----------- | --------- | -------------------------------------------------- |
| 0 features, no props      | 1,048 B     | **429 B** | pure fixed tax: frame (16 B) + IPC schema/messages |
| 0 features, +2 props      | 1,560 B     | 547 B     | +512 B raw per 2 fields                            |
| 1 feature ≡ 2 features    | 1,688 B     | ~570 B    | arrow-rs pads each buffer to 64 B                  |
| 1,000 features            | 41,880 B    | 6,592 B   | marginal ≈ 40.8 B/feat raw → 6.2 B/feat zstd       |
| 1,000 features, quantized | 33,944 B    | 3,720 B   | → 3.3 B/feat zstd                                  |

Fleet check (`inspect` on `earthquakes-v2`): 102,225 tiles / 522,982 rows / 117 MB
compressed → avg blob ≈ 1.1 KB, of which ~430 B schema/framing tax ≈ **37 % of all
pack bytes** (the measured 30–45 % band). Per-zoom duplication is total (~47.5 K
quakes × 11 zooms = 523 K rows); blob dedup reaches only 0.815 on sparse events;
near-unique dictionary strings (`title`, `place`) are **28 %** of standalone column
bytes — a `doctor` concern, not a format one. Other structural costs are healthy:
directory ≈ 8–20 B/entry pre-zstd, paged root 12 B + 52 B/page, pack framing 0 B.

**Packed v2 — the schema-tax result.** Template 896 B raw / 471 B zstd3 **once per
dataset**; per-tile v2 overhead ≈ frame+TOC 32 B + TILE_META ~104 B raw;
whole-blob zstd3 v1→v2 610→210 B (n=0), 872→458 B (n=5), 13,686→13,060 B
(n=1,000). Stage III A/B, identical flags except `--format-version`, zstd-19, w8:

| dataset    | shape                                        | v1 pack B   | v2 pack B   | Δ pack      | wall s v1→v2 |
| ---------- | -------------------------------------------- | ----------- | ----------- | ----------- | ------------ |
| hurricanes | sparse global points, 4 dict cols, quantized | 10,049,785  | 6,392,849   | **−36.4 %** | 26.2→29.3    |
| ecco       | trajectories, vertex_time+values, long-lived | 733,409,267 | 702,361,861 | **−4.2 %**  | 143.0→159.8  |
| taxi       | dense urban trajectories, short trips        | 132,399,630 | 131,853,238 | **−0.4 %**  | 42.4→45.5    |
| ais        | dense coastal points, categorical-heavy      | 292,576,474 | 276,000,619 | **−5.7 %**  | 64.6→68.6    |

The saving scales inversely with tile size, as predicted: −36 % on hurricanes
(12,886 tiles, ~780 B/tile) down to −0.4 % on taxi (600 tiles, ~220 KB/tile).
Manifests grew 1,035→3,093 B (hurricanes) … 2,007→5,254 B (ecco); wall time
+6–12 %. **No dataset grew**, decode is complete and equal v1 = v2 everywhere, and
the campaign's headline E2E number on hurricanes was **−44.8 %** pack bytes.
Caveat: earthquakes-v2 / drifters / nyc-taxi-points needed a network re-fetch and
were covered by shape proxies; no summary-tier or temporal-LOD archive was in the
corpus.

**E1 spill-to-disk (scale ceiling).** `--pack-memory-budget <MiB>` (default 512,
0 = unlimited) caps uncompressed payload buffered before `finalize`. On 20 M
synthetic points (12 cores / 36 GB, z0–3, 6 h buckets, 8 workers; 9,386 tiles,
2.03 GB out): 512 MiB → 359.5 s / 14.71 GiB peak RSS; budget 0 → 338.1 s /
16.41 GiB, `diff -r` clean against the spill run — **−1.83 GB peak RSS (−10.4 %)
for +21 s (+6.3 %)**. Output bytes are identical at any budget (total-order sort
keys make arrival order irrelevant). Remaining unbounded heads (T5.1):
`Vec<ParsedFeature>` (~200 B/feature) + per-zoom placement vecs (20 M features ≈
10+ GB resident) → ceiling ≈ 10⁷ comfortable, low-10⁸ heroic.

## 3. Design decisions kept as rationale

### 3.1 Paged directory (D1–D6)

The `.sttd` was a whole-load blob on the cold-start critical path; measured fleet
directories ran 5.9 KB → 15.8 MB, growing with dataset size, not with what the
session views.

- **D1 — single level (root + leaf pages), not a tree.** Max fleet directory
  ~560 K entries → ~137 pages at 4096/page → a ~7 KB root. COPC's K-level paging
  earns its keep at 1.2 B points; a flat page table covers this fleet.
- **D2 — a leaf page is the v5 codec verbatim.** Slicing resets delta state and
  splits RLE runs at boundaries (+6–19 % at rest); reusing the
  adversarially-tested codec makes the root page the only new bytes.
- **D3 — page descriptor = geo-bbox, not Hilbert key range (FROZEN by the step-0
  A/B sim).** Geo-bbox matched or beat the Hilbert-range model wherever paging
  matters: nyc-taxi-points **9.5 % / 15.5 %** of whole-load (med/p90) vs hilbert
  11.4 % / 36.5 %; drifters **25.0 % / 35.1 %** vs 26.3 % / 66.1 %; only ais-all-us
  favoured hilbert (2.7 % / 4.4 % vs 0.9 % / 1.8 %) in an already-sub-5 % regime.
  Geo-bbox wins the p90 tail because a viewport box maps to a Hilbert _interval_
  that falsely retains spatially-distant pages. Bonus: zoom-correct, and **no
  Hilbert port in TS**.
- **D4 — one content-addressed `.sttd`; the root is a byte-range prefix.** Never a
  second addressing path (§6). `length ≤ threshold` GETs the whole object, so
  request amplification never fires on wildfires-shaped datasets.
- **D5 — `layout: "paged"` discriminates; `directoryVersion` stays 5.** The draft
  bumped to v6, but the leaf codec is unchanged, so layout — not codec version —
  discriminates, and the whole-load path survives for un-migrated datasets.
- **D6 — per-page zstd, NO shared dictionary**, keeping each leaf independently
  fetchable and the dictionary-less fzstd TS path working. Forfeits the
  whole-directory zstd window: **+6–19 % generally, +117 % on earthquakes** (whose
  blob-dedup redundancy compresses 3.7× under one window) — **accepted**: paid once
  by the immutable CDN-cached object while per-session bytes drop 1–2 orders of
  magnitude. At ship: earthquakes-v2 dir 3.38→2.41 MB, root 524 B.

### 3.2 Packed v2 — the coordinated byte break

Every wire-breaking change batched into ONE bump so content addresses churn once.

- **Template reference = blake3-128 hash, not an index** — blob bytes depend only
  on their own template's content: deterministic under any encode parallelism, no
  churn coupling to the template set.
- **Templates embedded in the manifest, not external `schemas/<hash>.sttt`
  objects.** One move dissolved four blockers: the r2-sync new-object-class
  problem, the template-404-bricks-dataset failure class, an extra cold-start
  fetch, and schema-ref index determinism. At 1–2 templates × ~900 B the manifest
  grows by low KB, which every session already fetches. Realized cardinality is
  2–3/dataset (type splits like vertex_time u16/i64 are legitimate).
- **Core/props split** enables lazy property decode; the shipped TS reader is
  eager-only and behavior-identical to v1.
- **Time-sorted rows — default, no escape flag**, sorting AFTER id assignment so
  ids stay order-independent. Per-column isolation showed the sort does NOT
  scramble spatial locality at tile granularity (geometry-cost deltas: hurricanes
  +0.19 %, ecco −0.09 %, taxi +0.01 %, ais −0.12 % — nowhere near the
  2 %-of-pack-bytes damage line) while the upside is real: ais start_time and
  end_time **−61.2 % each**, ecco start_time −8.9 %, vertex_time −3.7 %. Worst
  regressions anywhere: ais `id` +55.0 % (+1.1 MB standalone against −5.1 MB banked
  on time columns), taxi `trip_id` +1.8 % — both net-positive tiles.
- **Splice guards — the bug this prevents.** The splice MUST use exactly the
  TOC-declared section length and SHOULD assert the section begins with
  `0xFFFFFFFF`: stray zero bytes make arrow-rs silently return an EMPTY tile
  (legacy 4-byte EOS) and make arrow-js silently drop zero-copy.
- **`manifest.formatVersion` is authoritative**; the frame's `0xFFFF` escape is
  defense-in-depth, not a negotiation channel. Deployed 0.3.0 readers hard-reject
  `formatVersion != 1` by name — a loud refusal is the designed failure mode.
- **`--format-version 1` = 0.3.x-READER-compatible emission, not bit-parity** with
  the 0.3.0 binary (forfeited already by the FNV-1a synthetic-id migration and the
  `Auto`-ordering occupied-extent fix). Reader compatibility is the contract,
  pinned by `v1_golden.rs`; republishing a v1 dataset is a full re-upload anyway.
- **r2-sync prune grace — the bug this prevents.** The prune pass built its
  referenced set from the LOCAL manifest only; a v2 republish makes every v1 object
  unreferenced-and-old → reaped on the first default sync while edge manifests
  (≤60 s) and open sessions still resolve v1. Fix: union the deployed remote
  manifest's references into the protected set (one-deploy grace), `--min-age` as
  the second gate, `--no-prune` for major republishes.
- **Bundle profile** (`.sttb`) embeds the manifest as verbatim raw bytes so
  pack→unpack round-trips byte-identically — restoring the "download one file"
  interchange story the retired container had.
- **Serve stays v1.** Inline schemas are `stt-serve`'s only mode and responses are
  `no-store` origin/LAN, so template amortization buys nothing; a serve-v2 must add
  `formatVersion` to `/metadata.json` FIRST. File ≡ DB byte-parity is scoped to
  hold between a `--format-version 1` build and serve.

### 3.3 Build intelligence: measure, don't model

`stt-optimize` began as a predictor — feature size was `100 + vertex_count*16 +
property_count*20`, compressed size a hardcoded `uncompressed / 3`, and the density
simulation modeled a build that doesn't exist (byte-bounded chunks; the real build
cuts by `--temporal-bucket` duration, and no `--chunk-size` flag exists). Three
findings settled it:

- **Measurement overturned expert plans twice.** The "octree geometry" plan died
  when per-column stats showed AV LiDAR geometry was only **12.7 %** of bytes while
  id-hash (**40 %**) and raw-f64 `z` (**38 %**) dominated — the win was seq-ids +
  `--quantize-attr` on `z`. And lightweight column encodings measured NO-GO (§4). A
  heuristic advisor would have recommended exactly the work measurement killed.
- **Wins are dataset-shaped, 1.07×–21×.** The `reoptimize` pass
  measured 21 datasets at 20.4 → 13.2 GB: **1.07–1.99×** typical, up to **21×**
  where a zoom floor was wrong. No formula predicts which lever pays for a given
  dataset; a 30-second sample-encode does.
- So the formula was replaced by a deterministic feature sample through the real
  `stt-core` encoder + zstd at target level, and every verb (`inspect`, `diff`,
  `recommend --explain`, `doctor --strict`, `order-audit`) reads from it.

Binding product principles: **quantization is lossy → suggested loudly, never
silently applied** (opt in per flag or `--auto=encode+quantize` with precisions
echoed; plain `--auto=encode` applies only reversible levers — seq ids, zstd level,
blob ordering, pack size, vertex-time precision). **Budgets and thinning are never
auto-applied, ever.** Amended 2026-07-10 (user): the base tier is always lossless,
but super-huge (Waymo-LiDAR-class) datasets may ship **declared, opt-in** reduced
tiers announced by metadata — never a silent variant. `style_hints` /
`heatmap_domain` are defaults, always overridable: advisory data, not behavior.

### 3.4 Two shipped levers that had a flag and no recorded rationale

- **`--simplify-metric`** (opt-in). The legacy tolerance is a fixed **degree**
  epsilon, so one zoom's tolerance means a different ground distance at every
  latitude — up to ~2× coarser in E–W terms at 60° than at the equator, i.e. a
  global dataset is simplified inconsistently by construction. Metric mode scales
  longitude by `cos φ` before simplifying and unscales after; a positive uniform
  scale preserves ring winding and non-self-intersection, so the
  topology-preserving guarantee carries back unchanged. Opt-in because it moves
  vertices: without the flag builds stay byte-identical.
- **The summary-tier skew oracle (`top1pct_feature_share`).** The original rule
  fired on volume × heavy average tile (>1 M features and >5,000 features/tile at
  the overview zoom) and **missed hotspot data entirely** — empty cells drag the
  average down, so a dataset whose densest cells are unservable looks light. The
  oracle adds the share of features held by the densest 1 % of overview cells; a
  second trigger fires at >100 K features, share ≥ 0.60, and a peak tile over the
  10,000-feature oversized rule of thumb. Scheme follows the same evidence: H3 for
  `Localized` distributions (equal-area cells aggregate a dense blob more evenly
  than Quadbin's axis-aligned blockiness), Quadbin otherwise. Not lossy — summary
  tiles ship IN ADDITION to the raw tier, dispatched via `metadata.summaryTier`.

## 4. Negative results — don't relitigate

- **Lightweight column encodings: NO-GO** (`encoding-experiment.rs`, 400-tile
  samples of drifters / ais-all-us / flights, all variants re-zstd'd since packed is
  zstd-per-blob). Integer time columns: delta-varint wins big _relatively_
  (vertex_time −31 % drifters, feature times −55 % flights, −23 % ais) but those
  columns are only **~0.3–0.8 % of post-zstd payload** — negligible absolute.
  Coordinates (~57 % of drifters payload) get **worse** under byte-shuffle
  (**+31…+68 %**) and xor+shuffle (**+49…+71 %**): zstd already models raw
  little-endian f64 world coords better than shuffled layouts. Delta-bitpack
  consistently loses to delta-varint when zstd follows — skip FastPFOR-class packing
  entirely in a zstd-at-rest format. No encoding pass pays for its decoder port.
- **Transforms declined; quantization landed instead.** The NO-GO above tested
  _transforms_ on _un-quantized_ f64. Quantization was the real untested lever and
  shipped as opt-in world-grid `--quantize-coords <m>` (i32 world-grid leaf +
  reconstruction affine, deliberately NOT tile-local — per-tile grids cost **+61 %**
  by destroying cross-tile dedup; naive osm-streets went from **+57.7 % to −1.8 %**
  under the world grid). Measured **−25…47 %** on coord-heavy datasets; AV LiDAR
  ships on it (z14 20 → 4.4 B/pt).
- **`rel-times32`: SKIPPED.** Projected median saving ≈ **+0.2 %** (< the 1 % SKIP
  line) and the sign FLIPS on dense tiles — sorted absolute Int64 times (constant
  high 5 bytes per value) are _more_ zstd-redundant per row than dense Int32
  offsets: taxi re-encodes **+46 %**, ais **+34 %** larger as rel-Int32. Kill shot:
  on ecco **125,526 / 134,045 features (94 %)** overflow Int32 ms relative to bucket
  t0, so `end_time` would need a per-tile fallback for near-zero median upside. The
  v2 row-sort already banks the time-column win (ais −61 %), which is precisely what
  strands rel32.
- **`narrow-ids`: SKIPPED.** Median ≈ **+0.2 %**. UInt64 sequential ids carry 4
  always-zero high bytes that zstd folds into its match model almost for free —
  halving the raw width often _hurts_ (u32 re-encoded LARGER than u64 on ais z8,
  taxi z10, and every dataset's shallow-zoom groups). The one mild positive (ecco,
  ids replicated across clipped segments) tops out at +2.2 % on the optimistic bound
  only.
- **Inter-timestep delta chains (keyframe + P-frame): NO-GO** (2026-07-21). They
  break three load-bearing guarantees at once: standalone tile decode; the
  directory-only time-prune seek (`getTileIdsInBounds` never touches earlier buckets
  — a chain forces reading t to decode t+1); and content-addressed dedup + blob-run
  RLE, since delta blobs differ byte-wise even when the underlying state is
  identical, so the existing _lossless_ collapse of time-identical cells across
  buckets would be lost, not improved. No tiled map format ships t→t+1 deltas as of
  2026 — MLT's "delta" is purely intra-tile sort-then-difference and its spec
  explicitly defers random access into delta-encoded values as an unsolved research
  problem. And a strong general compressor recovers most of what structured deltas
  buy: MLT's headline 3–6× over MVT collapses to **1.12–1.96×** once gzip is applied
  to both sides, and DuckDB found Parquet V2 `DELTA_BINARY_PACKED` made files **~3×
  larger** under zstd (duckdb#18984) — the same lesson as the byte-shuffle NO-GO and
  the rel-times32 sign flip. Where deltas do win the _predictor_ is the win, not the
  differencing (Trajic's constant-velocity predictor cut temporal residuals **25.4 →
  4.3 bits**, 1.5–2.2× over plain deltas) and consumption must be _sequential_ —
  random-seek scrub fails that precondition. **Standing rule** if live/streamed
  updates are ever added (a different feature than playback): keyframe-bounded
  deltas from day one — universal practice across game netcode, video and trajectory
  systems; never open chains.
- **Request count is a broken cost primary for blob ordering** — §5.

## 5. The blob-ordering cost-primary lesson

A first cut ranked orderings by coalesced range-read _count_; on drifters that
recommended `time-major` at "2 reads" — which transfer **669 MiB** (a scattered
spatial band fuses into one archive-spanning range at the reader's 2 MiB coalescing
gap) against `spatial`'s **184 MiB in 94 requests**. Ranking by count called the
669 MiB read "cheapest." The fix is the blended cost **`bytes_read + reads × gap`**:
the reader over-reads up to `gap` bytes to save one request, so it prices a request
at exactly `gap` bytes, and ranking by that is self-consistent with the reader's own
coalescing. Related artefact: "morton3 is never optimal" was a proxy illusion — on
real read cost it edges tiny datasets, so the picker **reports but never selects**
it (`ordering_sim::SELECTABLE`), making the research-only claim true by
construction. Adjacency-break counts are a misleading locality proxy; never rank
orderings by them again.

Two heuristic bugs fixed in the same pass: `choose()` compared raw max-zoom (space)
against occupied-bucket bits (time), overstating spatial cardinality on sparse data
(nyc-rideshare: zoom 16 but ~7 bits of occupied tiles) — space bits now derive from
the occupied bbox; and at `time_bits ≤ 1` hilbert3 interleaves a degenerate 3rd
axis, strictly worse than 2D-Hilbert with zero access-pattern downside (no timeline
to scrub) → shallow-time picks `spatial`. Together they moved **12 of 36** archives
to a better `auto` pick; across all 36 `measured` picks spatial 16 / time-major 12 /
hilbert3 8 / morton3 0. **Open gate:** the simulator's scrub/pan query mix is
equal-weighted and fixed, so an access-pattern-weighted picker — and whether
`measured` ever becomes the `auto` default — waits on that weighting decision.
`measured` staying opt-in is the hedge: `auto` never selects `time-major`.

## 6. Prior art — what transfers, what doesn't, what to avoid

**COPC** — octree of LAZ chunks + lazy paged hierarchy, range-read from a dumb HTTP
server; it beat many-files EPT on single asset/URL, CDN-cacheable ranges, graceful
degradation, one canonical writer + validator + viewer, ~370-line spec. Core shipped
with **zero** temporal support; a third-party temporal-index extension answers a
spatiotemporal query on a 5.7 GB / 1.2 B-point file in **4 reads / ~110 KB**. That
the ecosystem had to bolt time on validates the time-native premise, and "N reads to
first frame" is the benchmark to track. **Anti-lesson — the bug this prevents:**
COPC keeps two parallel addressings of the same chunks (LAZ chunk table + hierarchy
offsets), so generic LAZ tools rewrite chunks under a stale hierarchy → valid-LAZ,
corrupt-COPC files. Content-addressed packs are the stronger integrity story:
**never add a second addressing path beside them** (this froze D4).

**MLT** — measured 1.1–2× smaller than _gzipped_ MVT, 2–3× faster decode,
property-only scans 3.7–4.4× faster, lazy geometry-skip 14.8×: columnar's killer app
is **skipping**, not compression (the motivation for v2's core/props split); on
already-optimized tilesets the size win shrinks to ~10–30 %. Its advanced encodings
(FSST/FastPFOR/ALP) nearly sank portability — per-language ports, WASM shims, a spec
split into simple/advanced profiles — the source of the **cap the toolbox, no
adaptive per-tile selection** rule here. MLT has no temporal semantics, so the wedge
stays uncontested.

**Still-open losses:** column stats + predicate pushdown and column projection
(Parquet/GeoParquet), extension-registry governance (COPC), spec governance and
brand neutrality (PMTiles). Closed since: single-file interchange (bundle), per-tile
fixed overhead and schema-once amortization (v2 templates), magic bytes + `vnd.`
media types, `capabilities` must-understand (exactly Zarr v3's `must_understand`).

## 7. Frozen wire-token invariants

- **Wire tokens are frozen** by deployed R2 archives and the published spec: do
  **not** rename wire columns (`vertex_time`/`vertex_value`), the `.stt` suffix, or
  renumber compression bytes. Fix docs and in-memory names; add aliases only.
- **Compression byte 1 (gzip) is permanently reserved, never to be reused.** It
  existed only in the legacy single-file `.stt`; the live enum is
  `{None = 0, Zstd = 2}`, no writer emits byte 1, it is absent from
  `manifest.schema.json`, and both readers reject it. _(Corrects the old
  naming-audit invariant "don't delete `Compression.Gzip`/`gunzipSync`" — verified
  2026-07-24: the enum member and the gunzip path are gone tree-wide.)_
- **`u64` → `i64` on `TimeRange.start/end` and `TileId.t` is counted out** — a
  breaking `stt-core` change; the documented non-negative invariant shipped instead.
  Revisit only at a semver-major, and it must not contradict the `Int64` payload
  columns.
- **`stt-serve` core keys** (`boundingBox`/`minZoom`/`maxZoom`) deliberately mirror
  the loaders.gl `TileSource` shape — decide which schema wins before unifying casing.
- Enforcement: `spec_conformance.rs`, the compression byte-set freeze,
  `v1_golden.rs`, `reproducible_build.rs`, and the per-binary
  `cli_flags_are_documented_in_cli_reference` gates (a new flag fails `cargo test`
  until documented; the first run caught 6 undocumented flags).

## 8. Counted out, with revival triggers

Re-triaged 2026-07-24 against the tree.

- **Global content-addressed pack store** — one shared `/packs/<blake3>.sttp` with
  per-dataset manifests pointing in; the "`packs[]` index IS the `pack_id`" design
  already supports it. Unlocks cross-dataset dedup (within-dataset dedup already
  took earthquakes 266 MB → 72 MB), incremental deploys, and a GC story; open
  questions are refcount policy, per-origin vs per-deploy store, r2-sync
  enumeration. **Trigger:** cross-dataset dedup or incremental deploys become a real
  cost.
- **Tile-local coordinate quantization** — the world-grid form shipped precisely
  because tile-local grids destroy cross-tile dedup (+61 %). **Trigger:** payload
  size becomes a priority again; §4's numbers are the baseline to beat and the
  f32-precision shader path is the renderer implication to solve first.
- **E2 long-lived-feature duration stratification** (a tile holding one
  near-immortal feature matches every query window forever; `cover_t_min` bounds
  only the lower end) and **E3 append** (blocker is the manifest contract —
  positional `pack_id`, no generation field — not the codec). **Trigger:** a forcing
  dataset (E1-scale incremental ingest).
- **T4.4 attribute statistics** — per-leaf-page column min/max as paged-root
  **descriptor kind 1** (the byte is reserved for exactly this) → pushdown for the
  "magnitude > 5" query class. **Trigger:** a client-side attribute predicate.
- **Shared zstd dictionary in the paged root** — would recover D6's +6–19 % but
  breaks the dictionary-less fzstd contract. **Trigger:** at-rest `.sttd` size
  becomes a real problem; it is off the per-session path today.
- **Manifest-inlined directory root** (saves one RTT) — deferred: couples
  immutable-derived data into the mutable manifest.
- **Geometry-blob sharing across temporal chunks — a reference, not a delta.** The
  one real cross-timestep duplication the 2026-07-21 audit found: chunked corridor
  datasets re-emit full static geometry per temporal chunk (NWM rivers re-emits the
  same reach geometry once per ~30-bucket chunk). Splitting the static geometry
  column-group into its own blob lets content-addressing dedupe it automatically;
  decode stays standalone-ish (a two-blob fetch). Needs a format design (multi-blob
  tile reference). **Trigger:** that duplication shows up in a fleet size or decode
  budget.
- **Quantized-int path-delta experiment.** §4's coordinate NO-GO tested transforms on
  _raw f64_; the untested cell is MLT-style deltas over **quantized Int32 world-grid
  coords** — where MLT's residual post-compression edge (1.12–1.96×) lives, on the
  column class that is ~57 % of payload. **Trigger:** run it through the measure
  fair-share harness against Stage III's <1 % SKIP line. Column-to-column deltas on
  `sub_bucket_*`/matrix columns stay counted out (zstd already sees adjacent columns
  in-blob; the DuckDB precedent says pre-zstd deltas can actively hurt).
- **Declared reduced temporal tiers (M4 / MinMaxLTTB / spacing).** The bound worth
  keeping: **M4** (min/max/first/last per pixel column) is provably sufficient _and_
  necessary for pixel-identical line rendering — a hard **4·w** bound, up to **100×**
  reduction, so temporal downsampling can be error-free at screen resolution when
  bins align to output pixels (caveat: two-color non-AA rasterization). MinMaxLTTB
  (MinMax preselect at ratio 4 → LTTB) is the shape-preserving fallback when
  pixel-exactness isn't required. ⚠ The "tsdownsample is a reusable Rust crate" claim
  was **refuted 0-3** — implement in-house; the algorithms are small. **Trigger:** a
  dataset whose zoomed-out wide-window playback is bandwidth-bound at the base tier.
- **Additive home-zoom decomposition** (each feature stored at exactly one zoom;
  reader unions `[minZoom..z]`). The insight worth keeping: **Potree proves LOD and
  comprehensiveness are compatible** — every point lives in exactly one node and the
  union reconstructs the dataset exactly, with refinement as a global point-budget
  priority traversal (max-heap by projected size, hard break on budget), so the
  hardware-adaptive knob is one number. Archive size would drop from O(zooms × N) to
  O(N) — earthquakes' 523 K stored rows for 47.5 K quakes is the poster child.
  Reader-side `lodMode:'additive'` exists and is used only by the AV `-lod` bundles;
  the build-side assignment does not. **Trigger:** an archive whose per-zoom
  duplication is the dominant size term, with a deterministic (hash- or rank-keyed,
  never RNG) home-zoom metric chosen — reproducible-builds D6 is non-negotiable.
- **Joint space × time LOD policy** (`detail = f(zoom/SSE, timeline-px,
playbackSpeed, interaction state, budget)`). The 2026-07-10 sweep killed **every**
  claim about a published joint policy — no verified external precedent exists. An
  opportunity, not a plan: counted out until the reduction tiers above exist to spend
  a budget against.
- **The preprocessing framework as a program** (Plan-IR operator DAG, declarative
  Recipes, rung registry, sufficient statistics, Salsa-style incremental builds) —
  self-labelled counted out as a whole, 0/7 phases built, its one prerequisite
  (determinism) closed elsewhere by arrow ≥ 59. The durable idea, in one line: _LOD
  changes the resolution of the answer; encoding changes the price per unit_ — the
  seam that lets encoding be applied universally at the build boundary. **Trigger:**
  a second dataset family needs the same bespoke operator chain, i.e. generator
  copy-paste costs more than the abstraction. The `Dataset`/`Recipe` trait for
  `stt-generate` is part of this program and revives with it.
- **`-zg` density-derived auto-maxzoom** — re-confirmed absent by grep 2026-07-24;
  every shipped dataset pins its zoom range. **Trigger:** third-party `stt-build`
  adoption makes zero-config builds a priority.
- **Full measure-and-correct build loop** (`--auto-measure`: sampled z-slice →
  measure → adjust flags → full build) — verified absent. **Trigger unchanged:** ship
  only after `doctor`/`inspect` prove demand; it multiplies build cost.
- **Per-feature bbox covering column** — paged per-page geo bounds already deliver
  the coarse pruning win. **Trigger:** a client-side spatial predicate.
- **Fired triggers still awaiting a decision** (not silent count-outs): `stt-tools`
  crate promotion (gated on "revive alongside crates.io publishing" — fired
  2026-07-05; the workspace still has no such crate, so the maintenance
  `cargo run --example` tools stay unpublished), and the **hosted half of the
  adoption kit** (the portable half is written — `docs/spec/conformance.md`; the
  hosted validate/inspect page was gated on the npm publish, which landed 2026-07-05).

**Corrected (was stale):** "`stt-optimize` packed re-analysis" was carried here as
counted out. It **shipped** — `PackedTileset` reads a packed tileset directly and
backs `inspect`, `diff`, `doctor`, `order-audit`. Removed from the register.

## 9. Open tail

The open register lives in [README.md](./README.md) (items 1, 4, 6, 8 are this
record's); not restated. Format-specific notes only:

- **Demo-fleet republish to packed v2** — verified 2026-07-24: deployed
  `data-publish` manifests are still `formatVersion: 1` (paged layout, v5
  directory); only `data-v2/` archives are v2. Everything re-uploads on the flip;
  prune-grace is shipped, `--no-prune` is the belt-and-braces mode, rollback =
  re-upload the previous manifest. This gate carries the **requests- /
  bytes-to-first-frame** capture (the COPC "4 reads" benchmark) — measuring before
  the flip would just measure the old layout.
- **Lazy-props client materialization** — format-enabled by the core/props split;
  the reader is eager-only. Already decided: the Arrow parse must run in the decode
  worker and cached tile `byteSize` must be re-accounted through an explicit tileset
  callback, never silently.
- **serve-v2** — stays v1 by decision (§3.2); `formatVersion` must reach
  `/metadata.json` first.
- **Temporal-LOD reader wiring beyond scrub-LOD P0–P2** — wired and kill-switched,
  but `scrubLod` is set at zero showcase call-sites, so the pyramid is consumed
  nowhere at rest. P3/P4: [playback-and-loading.md](./playback-and-loading.md).
- **Interior-tile fast path + quadtree subdivision for polygon coverage** —
  byte-breaking follow-ups deferred from T1.1 coverage clipping; also the cross-zoom
  clip pyramid and the `geo::BooleanOps` swap (workspace pins geo 0.28; revisit at
  ≥ 0.30). **T5.1 memory heads** (§2) are the next scale target.
- **Known issue (not a framework):** the AV render-mode set is declared in four-plus
  drifting places — the `renderModes` existence-probe memo in `AvCockpitImpl.tsx`,
  the `datasets.ts` regex gates (`HELD_BACK_AV_MODES`, `WAYMO_LOCAL_ONLY`), the
  route/mode-param handling, and the deck↔three parity copy. One registry row per
  mode would kill it; nothing else from the retired preprocessing-framework design
  is needed.

**Corrected while consolidating:** the space×time LOD audit table claimed "polygons &
timeless lines are **never** simplified." False since the kind-parity campaign —
`tiler.rs` runs `simplify_polygon_rings_for_zoom_with` on each surviving per-tile
polygon after the clip, using the topology-preserving `SimplifyVwPreserve` variant
(one R\*-tree shared across exterior + holes, so shell/hole intersections are
caught), gated to `zoom < simplify_max_zoom` so the max-tiled-zoom tier stays
bit-exact — which is what the watertight antimeridian seam requires.
