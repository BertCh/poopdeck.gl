# STT packed format — consolidated decision record

> **Consolidated 2026-07-07.** Merges the durable content of five roadmap docs:
> `stt-packed.md`, `stt-format-review-2026-07.md`,
> `stt-packed-v2-design-2026-07.md`, `blob-ordering-heuristic-2026-07.md`, and
> the format-relevant bits of `rust-audit-2026-06.md`. Normative behavior lives
> in [`docs/spec/stt-packed-format.md`](../spec/stt-packed-format.md) — this doc
> never restates it. What survives here: rationale, measured baselines, negative
> results ("don't relitigate"), counted-out items with revival triggers, and the
> genuinely-open tail.

## 1. Status & lineage

Timeline (all verified against code/registries 2026-07-07):

- **2026-06-07** — packed format SHIPPED (deployed to R2, all datasets).
- **2026-06-11** — paged directory shipped + committed (`92dc0d1`, `b503e24`);
  COPC/MLT prior-art deep read; lightweight-column-encodings NO-GO measured.
- **2026-07-05** — format deep-review **Phases A + B + T1.1 + D2 implemented**
  (integrity & loud failure, spec hardening / independent implementability,
  polygon coverage-clipping, client-memory items). **Packed v2 campaign
  COMPLETE** — all six stages (spike → C-RUST → C-TS → Stage III measure → E1 →
  close-out review, 15/15 findings fixed): **−44.8 % hurricanes pack bytes**,
  dual v1/v2 readers in Rust + TS, `--format-version 1` kill switch, E1
  spill-to-disk `PackWriter`. Blob-ordering F1–F5 shipped. **0.3.0 published to
  BOTH crates.io and npm** (workspace since bumped to 0.4.0 in-tree).
- **Determinism CLOSED** — arrow ≥ 59 shipped; builds are byte-reproducible
  (total sort tiebreaks + canonical Arrow metadata; identical rebuilds re-derive
  identical pack names). The old "unfixed nondeterministic-encoding bug" caveat
  is dead.
- **Transcoding REMOVED entirely** — the single-file `.stt` container,
  `ArchiveWriter`/`ArchiveReader`, all transcode/reoptimize functions, and
  `--streaming-arrow` are gone. `stt-build` emits packed directories directly.

Where the normative behavior lives (per-topic pointers into the spec):

| topic | spec section |
| --- | --- |
| required-to-understand capabilities | [§3.1](../spec/stt-packed-format.md) |
| schema templates (`schemas`) | [§3.2](../spec/stt-packed-format.md) |
| directory v5 + the Hilbert key (normative, with test vectors) | [§4](../spec/stt-packed-format.md) |
| paged container (`layout: "paged"`) | [§4.1](../spec/stt-packed-format.md) |
| layer frame v2 (sectioned, template-referencing) | [§5.2](../spec/stt-packed-format.md) |
| design decisions (incl. reproducible-builds D6) | [§7](../spec/stt-packed-format.md) |
| versioning, media types, magic bytes, changelog | [§9](../spec/stt-packed-format.md) |
| container limits (u32 caps, root scale, packs-array) | [§12](../spec/stt-packed-format.md) |
| bundle profile `.sttb` | [§13](../spec/stt-packed-format.md) |

**Genuinely open** (details in §10): demo-fleet republish to v2 + R2 sync +
browser-verify (user-run ops gate); lazy-props client materialization; serve-v2;
temporal-LOD reader wiring beyond scrub-LOD P0–P2; interior-tile/quadtree
polygon coverage; T5.1 remaining memory heads; E2 long-lived stratification +
E3 append story (wait for a forcing dataset); T4.4 attribute stats (descriptor
kind 1 stays reserved).

## 2. Positioning — the five defended contributions

From the 2026-07 deep review (independently assessed, not just self-claimed) —
no shipping open format has these:

1. **The temporal directory** — `(z,x,y,t)`-keyed delta+zigzag varint columns
   with blob-run RLE that collapses *time-identical* content (the temporal
   analogue of PMTiles collapsing ocean tiles), plus `cover_t_min`
   backward-coverage and per-leaf `[t_min,t_max]` page pruning. The format's
   central contribution; competitive with PMTiles v3 on its own terms while
   adding an axis PMTiles doesn't have.
2. **Byte-reproducible content-addressed builds as a spec concern** — no
   comparable format attempts this; it is what makes the immutable-CDN
   economics real. (Now spec §7 D6; shipped with arrow ≥ 59.)
3. **World-anchored quantization** — trading a few % of compression for
   cross-tile content-address dedup (measured: per-tile grids cost +61 %). A
   coherent, original answer to MVT/MLT tile-local grids.
4. **First-class trajectory payload primitives** — `vertex_time` u16-delta with
   bounded precision ceiling and exact-Int64 fallback; the
   `vertex_value_matrix` space-time-cube column. Absent from MVT/MLT/GeoParquet.
5. **Zero-copy GPU discipline** — 8-byte-aligned layer frame + FixedSizeList
   interleaved leaves; the browser hands IPC buffers to the GPU without a copy.
   None of the comparison formats prioritize this.

**The rust-audit "vs the field" verdict (2026-06-11, still holds):** the
foundation — Arrow IPC tile payloads + GeoArrow geometry + content-addressed
packs + zstd + Hilbert/Morton ordering + consolidated manifest — is the
convergent cloud-native SoTA design, independently matching PMTiles v3, COPC,
Zarr-v3 sharding, and MLT/GeoArrow. The targeted niche — **time as a
first-class tiling axis for vector features** — has no established standard;
everyone else does "load spatial tiles, filter time client-side," which breaks
exactly when the time series won't fit in memory. The genuine frontier with no
prior art to copy: temporal axis on the directory; temporal budgeting; 3D
(space+time) locality ordering; mutability/append; no reference consumer
(hence shipping builder + deck.gl layers together).

**Squeeze risk, stated plainly:** the defensible moat is the temporal directory
+ reproducible builds + trajectory primitives *plus the renderer stack*. The
container alone is squeezable by a future MLT temporal extension or GeoZarr
from either side. The spec-hardening tier (review T6 → Phase B, implemented
2026-07-05) is what converts "nice internal format" into "the open standard for
temporally-tiled vector data" before someone else names that category.

## 3. Measured baselines

### 3.1 v1 byte-level probe (arrow 59, zstd-3, single point layer)

| Config | raw payload | zstd | note |
|---|---|---|---|
| 0 features, no props | 1,048 B | **429 B** | pure fixed tax: frame (16 B) + IPC schema/messages |
| 0 features, +2 props | 1,560 B | 547 B | +512 B raw per 2 fields |
| 1 feature ≡ 2 features | 1,688 B | ~570 B | arrow-rs pads each buffer to 64 B |
| 1,000 features | 41,880 B | 6,592 B | marginal ≈ 40.8 B/feat raw → 6.2 B/feat zstd |
| 1,000 features, quantized | 33,944 B | 3,720 B | → 3.3 B/feat zstd |

Fleet reality check (`stt-optimize inspect` on `earthquakes-v2`): 102,225 tiles
/ 522,982 feature-rows / 117 MB compressed → average compressed blob ≈ 1.1 KB,
of which ~430 B schema/framing tax ≈ **37 % of all pack bytes** (the review's
30–45 % band, measured). Per-zoom feature duplication is total (~47.5 K source
quakes × 11 zooms = 523 K stored rows); blob dedup only reaches 0.815 on sparse
events; near-unique dictionary strings (`title`, `place`) are the top two
per-column costs (**28 %** of standalone column bytes — a `doctor` concern, not
a format one). Fixed structural costs elsewhere are healthy: directory ≈ 8–20
B/entry pre-zstd (~2× under zstd), paged root 12 B + 52 B/page, pack framing
0 B, manifest ~60–100 B per pack entry.

### 3.2 v2 spike numbers (template splice, gate PASSED)

Template 896 B raw / 471 B zstd3 **once per dataset**; per-tile v2 overhead ≈
frame+TOC 32 B + TILE_META ~104 B raw. v1→v2 whole-blob zstd3: 610→210 B
(n=0), 872→458 B (n=5), 13,686→13,060 B (n=1,000). Earthquakes-v2 projection
≈ 40.4 MB ≈ 34 %. Templates proven byte-identical across tiles differing in
qa-affines/t0/categories/row-count; TS splice zero-copy under apache-arrow 17.

### 3.3 Stage III A/B (measured 2026-07-05; identical flags except `--format-version`, zstd-19, w8)

| dataset | shape | v1 pack B | v2 pack B | Δ pack | dir B v1→v2 | manifest B v1→v2 | templates (raw B) | wall s v1→v2 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hurricanes | sparse global points, 4 dict cols, quantized | 10,049,785 | 6,392,849 | **−36.4 %** | 141,368→144,348 | 1,035→3,093 | 2 (1,408) | 26.2→29.3 |
| ecco | current trajectories, vertex_time+values, long-lived | 733,409,267 | 702,361,861 | **−4.2 %** | 768,905→767,620 | 2,007→5,254 | 3 (2,240) | 143.0→159.8 |
| taxi | dense urban trajectories, short trips | 132,399,630 | 131,853,238 | **−0.4 %** | 3,838→3,832 | 1,152→4,315 | 3 (2,176) | 42.4→45.5 |
| ais | dense coastal points, categorical-heavy | 292,576,474 | 276,000,619 | **−5.7 %** | 205,504→208,757 | 1,440→3,498 | 2 (1,408) | 64.6→68.6 |

Reading: the schema-tax saving scales inversely with tile size, as predicted —
−36 % on sparse-tile hurricanes (12,886 tiles, ~780 B/tile pack), −4…−6 % on
mid-size ecco/ais, −0.4 % on taxi (600 tiles, ~220 KB/tile). v2 build wall time
costs **+6–12 %** (sort + template registry). **No dataset grew.** Feature
counts decode complete and equal v1 = v2 on every dataset. The campaign's
headline C-RUST E2E number on the hurricanes build was **−44.8 %** pack bytes
(re-confirmed post close-out fixes). Corpus caveat: the named demos
(earthquakes-v2, drifters, nyc-taxi-points) needed network re-fetch and were
covered by shape proxies; no summary-tier or temporal-LOD archive in the
corpus; a future re-litigation should re-run `retype_measure.py` on a rebuilt
corpus.

## 4. Design decisions kept as rationale

### 4.1 Paged directory (D1–D6, shipped 2026-06-11)

Problem: the `.sttd` directory was a single whole-load blob on the cold-start
critical path; measured fleet directories ran 5.9 KB → 15.8 MB, cost growing
with dataset size, not with what the session views. Paging makes cold start
proportional to the viewport/time-window footprint. The rationale behind the
spec §4.1 behavior:

- **D1 — single-level (root + leaf pages), not a multi-level tree.** Max fleet
  directory ~560 K entries → ~137 pages at 4096/page → a ~7 KB root. COPC's
  K-level paging earns its keep at 1.2 B points; at our scale a flat page table
  is simpler and fully covers the fleet. Door left open for a future level.
- **D2 — a leaf page is the existing v5 codec, verbatim.** Slicing resets delta
  state + splits RLE runs at boundaries (the measured +6–19 % at-rest cost);
  reusing the adversarially-tested codec makes the only new bytes the root page
  + framing.
- **D3 — page descriptor = geo-bbox, not Hilbert key range (FROZEN by the
  step-0 A/B sim).** Geo-bbox matched or beat the Hilbert-range model on every
  dataset where paging matters — nyc-taxi-points **9.5 % / 15.5 %** of
  whole-load (med/p90) vs hilbert 11.4 % / 36.5 %; drifters **25.0 % / 35.1 %**
  vs 26.3 % / 66.1 %; only ais-all-us favoured hilbert (2.7 % / 4.4 % vs 0.9 % /
  1.8 %) in an already-sub-5 % regime. Geo-bbox wins the p90 tail because a
  viewport box maps to a Hilbert *interval* that falsely keeps
  spatially-distant pages, while geo-bbox tests real overlap. Bonus:
  zoom-correct, and **no Hilbert port in TS**.
- **D4 — one content-addressed `.sttd`; root is a byte-range prefix.** Never a
  second addressing path (the COPC anti-lesson, §7). Small-dataset fast path:
  `length ≤ threshold` GETs the whole object — request amplification never
  fires on wildfires-shaped datasets. Inlining the root into `manifest.json`
  (saves one RTT) stays deferred: it couples immutable-derived data into the
  mutable manifest.
- **D5 — `layout: "paged"` discriminates the container; `directoryVersion`
  stays 5.** The draft bumped to v6; as shipped the leaf codec is unchanged, so
  layout — not codec version — discriminates, and the whole-load path is
  retained for un-migrated datasets.
- **D6 — per-page zstd, NO shared dictionary.** Each leaf independently
  fetchable/decodable (the dictionary-less fzstd TS path keeps working). This
  forfeits the whole-directory zstd window: **+6–19 % generally, +117 % on
  earthquakes** (whose blob-dedup redundancy compresses 3.7× under one window)
  — **accepted:** paid once by the immutable CDN-cached object, not
  per-session, while per-session bytes drop 1–2 orders of magnitude. A shared
  dict in the root would recover it but breaks the fzstd contract — parked,
  trigger: at-rest `.sttd` size becomes a real problem (it is off the
  per-session path).

Eval at ship: earthquakes-v2 dir 3.38→2.41 MB, root 524 B.

### 4.2 Packed v2 — the coordinated byte break (frozen + shipped 2026-07-05)

Executed the review's Phase C: **every wire-breaking change batched into ONE
version bump** so content addresses churn once. Wire format is spec §5.2/§3.2/§9;
the decisions worth keeping:

- **Template reference = blake3-128 hash (16 raw bytes), not an index (F1).**
  Blob bytes depend only on their own template's content — deterministic under
  any encode parallelism (E1-proof), no churn coupling to the template set.
- **Templates embedded in the manifest, not external objects (F3).** Replacing
  the draft's `schemas/<hash>.sttt` objects dissolved four blockers in one
  move: the r2-sync new-object-class problem, the template-404-bricks-dataset
  failure class, the extra cold-start fetch, and the schema-ref index
  determinism/churn blocker. At 1–2 templates × ~900 B the manifest grows by
  low KB, which every session already fetches. Cardinality census (F2): 2–3
  templates/dataset realized (type splits like vertex_time u16/i64 are
  legitimate); `--v2-inline-schemas` stays a theoretical escape.
- **Core/props split.** Reserved columns form the CORE batch; property columns
  a separate PROPS batch with its own template — the format *enables* lazy
  property decode, but the shipped TS reader is eager-only
  (behavior-identical to v1). When lazy materialization is built it must run
  its Arrow parse in the decode worker and re-account cached byteSize through
  an explicit tileset callback, never silently.
- **Time-sorted rows — CONFIRMED default, no escape flag.** Sort runs AFTER id
  assignment (F10) so ids are order-independent. Per-column isolation showed
  the sort does NOT scramble spatial locality at tile granularity
  (geometry-cost deltas: hurricanes +0.19 %, ecco −0.09 %, taxi +0.01 %, ais
  −0.12 % — nowhere near the 2 %-of-pack-bytes damage line) while the upside is
  real: ais start_time/end_time **−61.2 % each**, ecco start_time −8.9 %,
  vertex_time −3.7 %. Worst column regressions anywhere: ais `id` +55.0 %
  (+1.1 MB standalone vs −5.1 MB banked on time columns) and taxi `trip_id`
  +1.8 % — both net-positive tiles.
- **Splice guards (spike-learned failure mode).** The splice MUST use exactly
  the TOC-declared section length and SHOULD assert the section begins with
  `0xFFFFFFFF`: stray zero bytes make arrow-rs silently return an EMPTY tile
  (legacy 4-byte EOS) and make arrow-js silently drop zero-copy.
- **`manifest.formatVersion` is authoritative; the frame's `0xFFFF` escape is
  defense-in-depth, not a negotiation channel (F6).** The deployed 0.3.0
  readers already hard-reject `formatVersion != 1` by name — the v2 failure
  mode for old clients is the loud refusal, by design.
- **`--format-version 1` kill-switch semantics.** v1 mode is
  **0.3.x-READER-compatible v1 emission**, pinned byte-stable against the
  CURRENT writer by committed goldens (`crates/stt-core/tests/v1_golden.rs`) —
  NOT bit-parity with the 0.3.0 binary, which was already forfeited before v2
  by the deliberate FNV-1a synthetic-id migration and the `Auto`-ordering
  occupied-extent fix (spec §9.3). Reader compatibility, not historical byte
  parity, is the contract. Corollary: republishing a v1 dataset is a full
  re-upload regardless of format version.
- **Serve stays v1.** Inline schemas are `stt-serve`'s only mode anyway;
  responses are `no-store` origin/LAN, so template amortization buys nothing.
  A future serve-v2 must add `formatVersion` to `/metadata.json` FIRST. The
  file≡DB byte-parity story is scoped: parity holds between a
  `--format-version 1` offline build and serve.
- **r2-sync prune grace (pre-existing latent bug, maximized by v2, fixed
  2026-07-05).** The prune pass built its referenced set from the LOCAL
  manifest only; a v2 republish makes every v1 object unreferenced-and-old →
  reaped on the first default sync while edge manifests (≤60 s) and open
  sessions still resolve v1. Fix: fetch the currently-deployed remote
  manifest.json and union its references into the protected set (one-deploy
  grace), keeping `--min-age` as the second gate; `--no-prune` is the
  belt-and-braces mode for major republishes.
- **Bundle profile shipped early** (`.sttb`, `stt-bundle`,
  `PackedReader::open_bundle`, validator support — spec §13): manifest embedded
  as verbatim raw bytes so pack→unpack round-trips byte-identically; restores
  PMTiles' "download one file" interchange story that retiring the single-file
  container had surrendered.
- **Reproducible-builds economics** — see spec §7 (D6); don't restate. The
  point of record: identical rebuilds re-derive identical pack names
  cross-process, which is what makes incremental re-sync and immutable CDN
  caching real rather than aspirational.

## 5. Negative results — don't relitigate

- **Lightweight column encodings: NO-GO** (2026-06-11,
  `crates/stt-core/examples/encoding-experiment.rs`, 400-tile samples of
  drifters / ais-all-us / flights; all variants re-zstd'd since packed is
  zstd-per-blob). Integer time columns: delta-varint wins big *relatively*
  (vertex_time −31 % drifters, feature times −55 % flights, −23 % ais) but
  those columns are only **~0.3–0.8 % of post-zstd payload** — negligible
  absolute. Coordinates (~57 % of drifters payload) get **worse** under
  byte-shuffle (+31…+68 %) and xor+shuffle (+49…+71 %): zstd already models raw
  little-endian f64 world coords better than shuffled layouts. Delta-bitpack
  consistently loses to delta-varint when zstd follows — skip FastPFOR-class
  packing entirely in a zstd-at-rest format. Conclusion: no encoding pass pays
  for its decoder port.
- **Transforms vs quantization (rust-audit resolution).** The NO-GO above
  tested *transforms* (delta/bitpack) on *un-quantized* f64 — quantization was
  the real, untested lever, and it shipped as opt-in world-grid
  `--quantize-coords <m>` (i32 world-grid leaf + reconstruction affine,
  deliberately NOT tile-local — per-tile grids cost +61 % by destroying
  cross-tile content-address dedup; the naive osm-streets case went from
  +57.7 % to −1.8 % under the world grid). Measured −25..47 % on coord-heavy
  datasets; AV LiDAR ships on it (z14 20→4.4 B/pt). Read the pair as:
  *encoding transforms declined; quantization landed via the world-grid route.*
- **`rel-times32`: SKIPPED** (Stage III, 2026-07-05). Projected blob-byte
  saving median ≈ +0.2 % (< the 1 % SKIP line) and the sign FLIPS on dense
  tiles — sorted absolute Int64 times (constant high 5 bytes per value) are
  *more* zstd-redundant per row than dense Int32 offsets: taxi re-encodes
  **+46 %**, ais **+34 %** larger as rel-Int32. Kill shot: on ecco 125,526 /
  134,045 features (**94 %**) overflow Int32 ms relative to bucket t0
  (long-lived tracks), so end_time would need a per-tile fallback for near-zero
  median upside. The §4.2 row-sort already banks the time-column win (ais
  −61 %), which is precisely what strands rel32.
- **`narrow-ids`: SKIPPED** (Stage III). Median ≈ +0.2 %. UInt64 sequential
  ids carry 4 always-zero high bytes that zstd folds into its match model
  almost for free — halving the raw width often *hurts* (u32 re-encoded LARGER
  than u64 on ais z8, taxi z10, and every dataset's shallow-zoom groups). The
  one mild positive (ecco, ids replicated across clipped segments) tops out at
  +2.2 % on the optimistic bound only.
- **Blob ordering: request count is a broken cost primary** (2026-07-05,
  learned building the measured picker). A first cut ranked orderings by
  coalesced range-read *count*; on drifters that recommended `time-major` at
  "2 reads" — which transfer **669 MiB** (a scattered spatial band fuses into
  one archive-spanning range at the reader's 2 MiB coalescing gap) vs
  `spatial`'s 184 MiB in 94 requests. Ranking by count called the 669 MiB read
  "cheapest." The fix is the **blended cost `bytes_read + reads × gap`** — the
  reader over-reads up to `gap` bytes to save one request, so it prices a
  request at exactly `gap` bytes; ranking by that is self-consistent with the
  reader's own coalescing. Related artefact: "morton3 is never optimal" was a
  proxy illusion — on real read-cost it edges tiny datasets, so the picker now
  **reports but never selects** it (`ordering_sim::SELECTABLE`), making the
  research-only claim true by construction. Adjacency-break counts are a
  misleading locality proxy; don't rank orderings by them again.

## 6. Blob ordering — heuristic findings and the measured picker

All five findings from the 2026-07 density sweep (36 local archives,
directory-only probe) shipped 2026-07-05:

- **F1** — `choose()` compared raw max-zoom (space) against occupied-bucket
  bits (time), systematically overstating spatial cardinality on sparse data
  (nyc-rideshare: zoom 16 but ~7 bits of occupied tiles). Fixed: space bits now
  derive from the occupied bbox, symmetric to the time axis.
- **F2** — the shallow-time pole: at `time_bits ≤ 1` hilbert3 interleaves a
  degenerate 3rd axis and is strictly worse than pure 2D-Hilbert, with zero
  access-pattern downside (no timeline to scrub). Fixed: shallow-time →
  `spatial`. F1+F2 together move **12/36** archives to a better `auto` pick.
- **F3** — the measured, access-pattern-aware picker promised in
  `curve.rs` comments was never built; now shipped as opt-in
  `--blob-ordering measured` (`PackWriter::with_measured_ordering`) + the
  `stt-optimize order-audit` advisor, both backed by the shared range-read
  simulator `crates/stt-core/src/ordering_sim.rs` (directory-only, no payload
  reads).
- **F4a** — the resolved ordering is persisted in `manifest.blobOrdering`
  (previously only inferable by reconstructing byte layout).
- Validated on all 36 archives: `measured` picks **spatial 16 / time-major 12 /
  hilbert3 8 / morton3 0**; deep-time → spatial, wide-shallow → time-major,
  balanced → hilbert3. `order-audit` prints the per-ordering cost table so the
  pick is legible (drifters shows time-major's 669 MiB next to spatial's
  184 MiB).

**Open gate:** the scrub/pan query mix is equal-weighted and fixed. A genuinely
access-pattern-weighted picker — and whether `measured` should ever become the
`auto` default — remains gated on that weighting decision. `measured` being
opt-in is the hedge: `auto` (improved `choose()`) stays the conservative
default and never selects `time-major`.

## 7. Prior art — what transfers, what doesn't, what to avoid

**COPC** (studied 2026-06-11) — "EPT in a single LAZ": octree of LAZ chunks +
lazy paged hierarchy, range-read from a dumb HTTP server. Hierarchy entry is a
fixed 32 B; the reference writer pages every 4 levels. Why it won vs many-files
EPT: single asset/URL, CDN-cacheable ranges, graceful degradation, one
canonical writer + public validator + viewer, ~370-line spec. Core shipped with
**zero** temporal support — a third-party temporal-index extension (subtree
t-min/max on page pointers, strided per-node time samples) answers a
spatiotemporal query on a 5.7 GB / 1.2 B-point file in **4 reads / ~110 KB**.
That the ecosystem had to bolt time on validates STT's time-native premise; the
"N reads to first frame" figure is the benchmark to track across the paged
flip. **Anti-lesson:** COPC keeps two parallel addressings of the same chunks
(LAZ chunk table + hierarchy offsets) for backward compat; generic LAZ tools
rewrite chunks under a stale hierarchy → valid-LAZ, corrupt-COPC files.
Content-addressed packs are the stronger integrity story — **never add a second
addressing path beside them** (this froze paged-directory D4).

**MLT** (columnar MVT successor, official release 2026-01) — benchmarks:
1.1–2× smaller than *gzipped* MVT, 2–3× faster decode, property-only scans
3.7–4.4× faster, lazy geometry-skip 14.8× — columnar's killer app is
**skipping**, not just compression (the motivation for v2's sectioned
core/props split). Real-world caveat: on already-optimized tilesets the size
win shrinks to ~10–30 %. Its advanced encodings (FSST/FastPFOR/ALP) nearly sank
portability — per-language ports, WASM shims, a spec split into
simple/advanced profiles — the source of the "cap the toolbox, no adaptive
per-tile selection" rule here. Patterns worth stealing when relevant: u32
dictionary offsets; optional in-tile pre-tessellation streams (pattern proven,
economics not — their own JS renderer doesn't consume it); no-global-header
concatenability; sorting as a spec-level compression lever. MLT has **no
temporal semantics** (Timestamp is a plain i64 column; vertex-scoped columns
experimental) — both ecosystems leave STT's time-native wedge uncontested.

**Scorecard** (format review, 2026-07):

| vs | STT wins | STT loses | Steal |
|---|---|---|---|
| **PMTiles v3** | temporal axis; >512 MB CDN cacheability; reproducible builds; run-RLE across *time* | single-file interchange; spec governance/media type; brand neutrality | spec-in-own-repo; bundle profile |
| **MLT/MVT** | columnar GPU-zero-copy; time; GeoArrow interop | per-tile fixed overhead (429 B vs single-digit); no column projection; no lightweight int encodings (measured trade, mostly justified) | lazy property scan economics; feature-scoped encodings only where re-measured |
| **COPC** | time axis (COPC core has none); CDN-native objects | graceful degradation (quantized STT breaks vanilla GeoArrow readers); extension registry | registry w/ owner prefixes; "N reads to first frame" as normative budget; strided in-blob sampling |
| **Parquet/GeoParquet** | tile-granular random access; GPU-readiness; time-addressed delivery | column stats/predicate pushdown; column projection; schema-once amortization | per-page column stats (paged-root descriptor kind 1); logical time types |
| **Zarr v3** | vector payloads; directory compactness | `must_understand` extension flags; codec/container separation | `capabilities` array is exactly Zarr's `must_understand` |
| **Hex Tiles** | open, exact geometry, published spec | marketing/platform integration | nothing technical |

*Update 2026-07-05:* several "loses" cells were since closed — single-file
interchange (bundle §13), per-tile fixed overhead (v2 templates), magic bytes +
`vnd.` media types (spec §9.2), `capabilities` must-understand (spec §3.1),
schema-once amortization (v2). Column projection is partially closed
(core/props sections; lazy client materialization still open, §10).

## 8. Scale (E1) — spill PackWriter benchmark

Shipped 2026-07-05 on the frozen v2 writer, byte-frozen (v1 goldens, v2
reproducible-rebuild tests, and every committed fixture pass unchanged):

- **Spill-to-disk `PackWriter`** — `--pack-memory-budget <MiB>` (default 512,
  0 = unlimited/legacy) caps UNCOMPRESSED payload bytes buffered between
  `add_tile_full` and `finalize`; excess spills to a temp file and is read back
  record-by-record inside finalize's chunked parallel compression. Output bytes
  identical at any budget — the total-order sort keys make arrival order
  irrelevant, and per-blob compression + strictly-sequential dedup mean chunk
  boundaries cannot move a byte.
- **Parallel encode loop** — every write loop encodes tiles to Arrow IPC in
  parallel on the `--workers` pool with deterministic ordered hand-off;
  template collection is order-independent by construction (hash-keyed, F1),
  so parallelism cannot move a byte.
- **Dead pipeline deleted** — `build_streaming_from_batches` and its support
  types/tests are gone; the review's "two pipelines with subtly different
  semantics" debt (T5.1) is closed.

Benchmark (M-series MBP, 12 cores / 36 GB, release; synthetic GeoParquet, 20 M
points, z0–3, 6 h buckets, 8 workers; 9,386 tiles, 31 packs, 2.03 GB output):

| budget | wall | peak RSS | byte-identical |
| --- | --- | --- | --- |
| 512 MiB (spill; default) | 359.5 s | 14.71 GiB | — (reference) |
| 0 (unlimited/legacy) | 338.1 s | 16.41 GiB | `diff -r` clean vs spill |

Spilling traded **−1.83 GB peak RSS (−10.4 %) for +21 s wall (+6.3 %)**; the
spill file transiently held ~4.3 GB of payloads. E1 removed the
`PackWriter.pending` head — the one that grows without bound (≈ uncompressed
dataset size) at finalize. The **remaining T5.1 heads** are the full
`Vec<ParsedFeature>` (~200 B/feature) plus per-zoom placement/tile vecs
(~20 M features ≈ 10+ GB resident) — explicitly out of E1 scope; practical
ceiling ≈ 10⁷ comfortable / low-10⁸ heroic until they're addressed. A
hurricanes rebuild at budget 1 vs 0 also `diff -r` clean (pins the parallel
encode loop on the non-streaming path).

## 9. Counted out, with revival triggers

- **Global content-addressed pack store.** One shared `/packs/<blake3>.sttp`
  store with per-dataset manifests pointing in (the Git object-store /
  Docker-layer model) — the "`packs[]` index IS the `pack_id`" design already
  supports it (index stays manifest-local; only the `key` changes). Unlocks
  cross-dataset/cross-version dedup (within-dataset dedup already shrank
  earthquakes 266 MB → 72 MB), incremental deploys, and a natural GC story
  (collectible once no live manifest references the hash). Open questions:
  GC/refcount policy; per-origin vs per-deploy store; r2-sync enumeration.
  Counted out, trigger: cross-dataset dedup or incremental deploys become a
  real cost.
- **Tile-local coordinate quantization.** Parked; the world-grid form shipped
  instead precisely because tile-local grids destroy cross-tile
  content-address dedup (measured +61 %). Counted out, trigger: payload size
  becomes a priority again — the §5 at-rest numbers are the baseline to beat,
  and the f32-precision shader path is the renderer implication to solve.
- **E2 — long-lived-feature duration stratification** (review T4.3): a tile
  holding one near-immortal feature matches every query window forever;
  `cover_t_min` bounds only the lower end. Needs a measured prototype before
  spec. **E3 — append story** (T5.3): the blocker is the manifest contract
  (positional `pack_id`, no generation field), not the codec. Both counted
  out, trigger: a forcing dataset (E1-scale incremental ingest) exists.
- **T4.4 — attribute statistics.** Per-leaf-page column min/max as paged-root
  **descriptor kind 1** (the byte is reserved precisely for this, alongside the
  antimeridian-aware bbox variant) → predicate pushdown for the
  "magnitude > 5" query class. Counted out, trigger: a client-side
  attribute-predicate use case appears.
- **`stt-optimize` packed re-analysis.** Nothing currently needs to re-analyse
  a shipped packed dataset (analysis runs pre-build on sources). Counted out,
  trigger: the first real re-analysis ask.
- **Rust-audit tail** (all deliberately parked 2026-07-01):
  - *Full measure-and-correct build loop* — a rebuild-cost multiplier with no
    consumer (budgets are opt-in and unused by the fleet). Trigger: first real
    tile-budget user.
  - *Per-feature bbox covering column* — paged per-page geo bounds already
    deliver the coarse pruning win. Trigger: a client-side spatial-predicate
    use case.
  - *`Dataset` trait for stt-generate* — superseded; absorbed into the
    preprocessing-framework design (its Recipe/`Dataset` trait IS this item,
    Phase 5 there). Revive with that framework, not independently.
  - *`-zg` density-derived auto-maxzoom* — confirmed absent by grep 2026-07-01
    (the 2026-06-11 "shipped" checkbox was wrong); every shipped dataset pins
    its zoom range explicitly. Trigger: third-party `stt-build` adoption makes
    zero-config builds a priority.
  - *`stt-tools` crate promotion* — original trigger was "revive alongside
    crates.io publishing." **Trigger FIRED 2026-07-05** (0.3.0 shipped to
    crates.io) — **needs re-triage**, not silent count-out: decide whether the
    `cargo run --example` maintenance tools graduate to a published crate.
- **Adoption kit, hosted half.** The portable half is written
  (`docs/spec/conformance.md`); the hosted validate/inspect page was gated on
  the npm publish landing. That gate condition was met 2026-07-05 (0.3.0 on
  npm) — needs re-triage alongside `stt-tools`.
- **Shared zstd dictionary in the paged root** — see D6 (§4.1); parked,
  trigger: at-rest `.sttd` size becomes a real problem.
- **Manifest-inlined directory root** — see D4 (§4.1); deferred (couples
  immutable-derived data into the mutable manifest).

## 10. Genuinely open (ops / non-format)

- **Demo-fleet republish to v2 + R2 sync + browser-verify** — the one user-run
  ops gate (held per the dev-settling policy). Use the migration playbook:
  everything re-uploads (all blobs change); the r2-sync prune-grace fix is
  already shipped and `--no-prune` is the belt-and-braces mode; v1 objects age
  out after the grace window; rollback = re-upload the previous manifest. This
  gate subsumes the older paged-directory rollout and carries the
  **requests-to-first-frame / bytes-to-first-frame** capture (the COPC
  "4 reads" benchmark) — measuring before the flip would just measure the old
  layout. It is the same combined verify+sync gate the playback and av-cockpit
  plans carry; run it once for all three.
- **Lazy-props client materialization** — format-enabled by the v2 core/props
  split; the reader ships eager-only. Constraints already decided: the Arrow
  parse must run in the decode worker, and cached tile byteSize must be
  re-accounted through an explicit tileset callback, never silently.
- **serve-v2** — `stt-serve` stays v1 by decision (§4.2); any future serve-v2
  must add `formatVersion` to `/metadata.json` first.
- **Temporal-LOD reader wiring beyond scrub-LOD P0–P2** — P0–P2 are wired
  (kill-switched, default off); P3 baked tier + P4 polish + browser QoE verify
  live in [`scrub-lod-2026-07.md`](./scrub-lod-2026-07.md).
- **Interior-tile fast path + quadtree subdivision for polygon coverage** —
  deferred from the T1.1 coverage-clipping work (byte-breaking follow-ups);
  also the cross-zoom clip pyramid and the `geo::BooleanOps` swap (revisit at
  geo ≥ 0.30).
- **T5.1 remaining memory heads** — feature-vec + per-zoom placement residency
  (§8); the next scale campaign's target.
