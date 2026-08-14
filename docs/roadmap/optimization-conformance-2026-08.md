# Optimization program — conformance record (2026-08-11)

_Point-in-time audit of the implemented tree against the two source documents:
[optimization-problems-2026-08.md](./optimization-problems-2026-08.md) (the diagnosis) and
[optimization-implementation-plan-2026-08.md](./optimization-implementation-plan-2026-08.md) (the
execution spec, 68 work items). It records what landed, what did not, and the defects found along
the way — including defects **in the source documents themselves**._

_House-rules note: this is a decision record, not a schedule. Open work still lives only in
[the backlog](./README.md)._

## 1. Headline

**66 of the 68 work items are implemented and tested. 2 are not started.**

| Section                                 | Items        | Landed                               |
| --------------------------------------- | ------------ | ------------------------------------ |
| §1 Phase 0 — measurement infrastructure | P0-1 … P0-8  | **8 / 8**                            |
| §2 M5 — client cost-oracle              | CO-1 … CO-7  | **7 / 7**                            |
| §3 M6 — byte-honest budgets             | BH-1 … BH-10 | **10 / 10**                          |
| §4 M1 + M3 — oracle v2, `--target-size` | MO-1 … MO-9  | **9 / 9**                            |
| §5 M4 — workload model                  | WM-1 … WM-3  | **3 / 3**                            |
| §5 M4 — storage-layout DPs              | WM-4 … WM-6  | **3 / 3**                            |
| §6 M7 — semantic honesty                | SH-1 … SH-6  | **6 / 6**                            |
| §7 M2 — two-pass build                  | TB-1 … TB-6  | **6 / 6** (TB-5 inert, see §4)       |
| §7 — the §4 builder batch + re-pin      | TB-7 … TB-14 | **7 / 8** (TB-7 … TB-13; TB-14 held) |
| §8 M8 — declared tiers                  | DT-1 … DT-5  | **4 / 5** (DT-1, DT-2, DT-4, DT-5)   |
| §8 — frustum selection                  | FS-1 … FS-3  | **3 / 3**                            |

## 2. Test state

| Target                                    | Result                     | Baseline at session start |
| ----------------------------------------- | -------------------------- | ------------------------- |
| `cargo test --workspace --locked`         | 949 passed, **1 failed**   | green                     |
| `@poopdeck.gl/core`                       | **1349** passed, 0 failed  | 891 / 0                   |
| `@poopdeck.gl/playback`                   | **308** passed, 0 failed   | 180 / 0                   |
| `@poopdeck.gl/maplibre`                   | 1320 passed, 0 failed      | 1320 / 0                  |
| `@poopdeck.gl/react` · `/cesium` · `/mcp` | 62 · 112 · 187, 0 failed   | identical                 |
| `@poopdeck.gl/layers`                     | 1572 passed, **12 failed** | 1552 / **12 failed**      |
| `@poopdeck.gl/three`                      | 670 passed, **10 failed**  | 670 / **10 failed**       |

**Zero regressions.** The 22 TypeScript failures are the pre-existing `tileKey` `#<variant>` drift
from in-flight work that predates this program; they are unchanged and were never absorbed.

The single Rust failure is `v2_golden::v2_build_is_byte_identical_to_golden`, and it is **the
intended signal**, not a defect: the M2 encoder changes moved archive bytes and the committed golden
corpus has deliberately _not_ been re-blessed. Regeneration happens exactly once, under item TB-14
inside rebuild window R1, with a `Rebuild-Window: R1` commit trailer — which the Phase 0 gate
(`.github/scripts/check-golden-pins.mjs`) now enforces mechanically.

## 3. Defects found in the source documents

The goal was to implement the plan **and test it against the source documents**. Testing ran both
ways: three source-document defects surfaced, two of which had already propagated into code.

1. **problems §9.1 / line 1028 mis-describes the pressure ladder.** It states a _"disable threshold
   0.25"_; the code it cites implements a **floor** — `Math.max(PRESSURE_SCALE_MIN /* 0.25 */,
pressure * 0.7)`. A floor clamps at 0.25; a disable threshold snaps to 0. A coder implemented the
   prose rather than the code, which silently broke CO-2's kill-switch path (horizons 1000 ms where
   HEAD gave 1600 ms from the 4th eviction on) and then renamed the incumbent's guard test and
   rewrote its expected values to match. **Fixed**, and the ladder is now pinned by literal horizon
   sequence rather than by a symbol. The document is still wrong and should be corrected.

2. **The plan's FS-1/FS-3 "≥10× at pitch ≥ 60" is measurably wrong.** Across all 432 cameras of the
   pitch × bearing matrix, ≥10× holds from **pitch 70** up (16.9× minimum); at pitch 60–65 the
   reduction is 1.3–3.1×. Measured curve: p60 1.30–2.00×, p65 1.94–3.14×, p70 16.9–21.6×,
   p85 32.9–41.4×. `tile-loading-3d-2026-07.md` §4.4's own erratum predicts this.

3. **The problems doc's self-count is wrong.** Its prose claims **66** formal problems; mechanical
   extraction of `### N.M` headings finds **64**. Per-section: §1:4 §2:6 §3:8 §4:5 §5:2 §6:5 §7:6
   §8:5 §9:5 §10:2 §11:6 §12:5 §13:5.

4. **TB-12's reader inventory names the wrong single site.** The item says the decoder backfill
   "relaxes the reader contract ρ … for all three consumers at once, since all of them read the
   decoder's output buffer", and points at `tessellateFeature` in
   `packages/core/src/render/geometry.ts`. Only **maplibre** calls `tessellateFeature`. deck hands
   `binary.triangles` to deck.gl as one whole-layer `indices` attribute
   (`animated-polygon-layer.ts`), and three switches on a layer-global `hasPreBaked`
   (`polygon-buffers.ts`). A backfill placed only at `tessellateFeature` would therefore have fixed
   one backend of three and left single-ring polygons **vanishing** in the other two — the exact
   failure the item set out to prevent. The implemented fix puts the backfill in `decodeTile`
   instead, completing the buffer before any backend sees it, which genuinely does fix all three at
   once; `tessellateFeature` keeps a per-feature guard as a second line. The item's _conclusion_ was
   right and its _reason_ was wrong, which is the dangerous combination.

5. **TB-12's byte claim is uncompressed.** The item inherits columnar.rs's "40-45% of the wire bytes
   of a polygon-heavy tile". That is the raw column share. Measured end-to-end through the real
   binary on a 400-feature fixture with 1-in-8 holed polygons, per-feature emission saves **6.3%**
   of pack bytes (61,270 vs 65,409) — zstd already compresses repetitive triangle indices very well.
   The saving is real and the mechanism is sound; the headline number is not the number that lands
   on the wire.

6. **TB-11 extension 3 names the wrong component.** The item routes the playback-coupled ceiling
   into "an stt-optimize advisory writing `--vertex-time-precision` into recommended recipes". The
   temporal advisor's own module docs already rule that out, correctly: the analyzer reads a SOURCE
   (GeoParquet), whose features carry no per-vertex times, so it has nothing to price and the lever
   is explicitly deferred there to "the packed-side doctor". Implemented as a doctor rule
   accordingly. Same mechanism, same output, different home — worth correcting in the plan, since
   following it literally would have produced an advisory that can never fire.

7. **TB-10's shared-boundary acceptance (">0.9 across neighboring cells") is conditional.** It holds
   for neighbours of comparable density (measured 0.90–1.00) and does not for strongly mismatched
   ones (measured 0.50–0.62 at a 5-minute candidate grid, versus **0.00** unsnapped). The reason is
   structural, not a defect in the implementation: two cells whose window _counts_ differ cannot
   choose the same instants however the candidate grid is drawn, and the plan fixes the grid at 256
   quantiles of the global timestamp distribution, which is not tied to any cell's window cadence.
   The property that actually fixes the recorded prefetch gotcha — every key drawn from an
   enumerable published set — holds unconditionally and is what the test pins hardest.

## 4. Problem coverage

Of the 64 numbered problems, **52 are cited in a work item's heading**, 7 more only in item bodies
(§2.1, §3.1, §4.4, §7.1, §7.4, §8.5), and **5 are cited nowhere — all of them deliberately**:

| Problem                        | Why it is correctly untouched                                          |
| ------------------------------ | ---------------------------------------------------------------------- |
| §3.2 property type inference   | Register: the observe/seal type lattice is pinned optimal.             |
| §4.1 summary-tier shaping      | Design doc: explicitly not scheduled.                                  |
| §4.2 aggregate materialization | Design doc: explicitly not scheduled.                                  |
| §6.1 content-addressed dedup   | Register: dedup is load-bearing; delta chains are a standing NO-GO.    |
| §8.4 failed-tile retry         | Register: the 3-attempt gate is rejected; write-off is pinned optimal. |

**No problem was accidentally dropped.** Every uncovered one is either pinned in the do-not-touch
register or on the explicit not-scheduled list. That property must be re-checked if this program is
resumed — quietly implementing one of those five would be a register violation.

## 5. What is NOT implemented

- **DT-3** — M4/MinMaxLTTB reduced tiers. Trigger needs route-level QoE captures.
- **TB-14** — the golden re-pin. Deliberately not run; see §2. It is also _blocked_ on §6.1–6.3.

### Landed directly (not via the agent fleet)

- **TB-7 — tile-relative line clip buffer.** `LineBuffer::{TileRelativePx, FixedDegrees}` on
  `ClipConfig` with `line_buffer_degrees(zoom) = px/256 × 360/2^z`; default 8 px of a 256-px tile.
  CLI `--clip-buffer-px` / `--clip-buffer-degrees` (rollback). **The polygon buffer stays 0 and is
  guard-tested as unreachable from the line mode** — it is pinned optimal by the watertight
  bit-identical-seam construction. 4 tests; the antimeridian seam suite stays green untouched.
- **TB-8 — metric simplification as the default.** `simplify_metric` defaults true;
  `--simplify-degree-table` is the rollback and `--simplify-metric` survives as an accepted no-op
  alias for one release. The existing latitude-consistency pair now guards the _default_ path.
- **TB-9 — temporal-LOD default zoom cutoffs.** `default_lod_cutoff` picks the largest `z` whose
  cumulative pass-1 byte mass stays within 25 % of the total; coarser tiers step strictly downward;
  an explicit `@z` always wins; no mass (a `--single-pass` build) reproduces the legacy default
  exactly. 5 tests.
- **DT-1 — the unified tier declaration.** One concept replacing four
  separately-grown tier mechanisms. `TemporalLodLevel` gains optional
  `contract: "union" | "reduced"` and `method: "m4" | "minmaxlttb"`;
  `VariantKind` gains `Reduced` with `method`/`params`; `Metadata` gains
  `partition: "replicated" | "home-zoom"` plus the must-understand capability
  `additive-partition`. All additive-optional, so every existing manifest stays
  valid and serializes byte-identically (absent = union = today's normative MUST).
  Normative rules enforced in `validate_temporal_lod`: a `reduced` tier MUST name
  a method (a reader cannot substitute a reduction it does not understand), and a
  `union` tier may NOT (a category error). `validate_partition_capability` refuses
  `home-zoom` without its capability — the silent-misdecode class where an old
  parent-fallback reader renders a sparse per-zoom slice as if complete. Mirrored
  in TS (`TierContract`, `ReductionMethod`, `ArchivePartition`) with the
  never-substitute-what-you-don't-understand rule documented. 5 Rust tests.
- **TB-12 — decoder earcut backfill, then per-feature triangle emission.** In the plan's own
  binding order: reader first, builder second. `decodeTile` completes a partially-baked triangle
  buffer by earcutting each _provably_ single-ring feature whose baked list is empty, so all three
  backends keep working unchanged (see §3.4 for why the item's stated reason for this was wrong).
  "Provably" is the load-bearing word and it is deliberately asymmetric: absent `ringIndices` proves
  nothing and refuses to backfill, because earcutting a holed feature's rings as one flat loop
  renders the holes **filled** — a silent corruption strictly worse than the missing geometry it
  would avoid. The builder then bakes only what a renderer's single-boundary earcut cannot
  reproduce, declaring the new must-understand capability `triangles-partial` **only when a layer
  actually mixes** (a uniformly-baked layer emits the incumbent bytes and must not lock readers
  out). `--pre-tessellate` still bakes everything; `--no-partial-triangles` is the rollback.
  Registered in all four places the registry lives: Rust `KNOWN_CAPABILITIES`, TS
  `KNOWN_MANIFEST_CAPABILITIES`, `manifest.schema.json`'s `x-stt-capability-registry`, and the spec
  §3.1 table — the cross-language pin test catches any three-of-four. **`stt-serve` diverges
  deliberately:** per-feature emission is OPT-IN there (`--partial-triangles`), because a served
  tile carries no manifest and so gives an old client no chance to refuse — the same policy that
  already keeps `--compact-times` opt-in on the server. 5 TS + 5 Rust unit tests + 3 CLI tests.
- **TB-10 — exact adaptive partition + shared boundary snapping.** The greedy first-fit is replaced
  by an exact min-max partition over timestamp atoms: binary-search the optimal cap, then
  reconstruct by _aiming_ at an even share rather than taking the largest legal prefix. The
  distinction is the whole item — a largest-prefix reconstruction is min-max-optimal _and_ starves
  the tail, which is the greedy's own failure wearing a proof. (It also nearly shipped: the first
  implementation passed an exhaustive brute-force optimality test while emitting a **1-feature
  tile**, because the test checked only the maximum. It now pins the minimum too.) Feasibility uses
  a real O(m) unsplittable-atom oracle, not a sum bound — `18 ≤ 2×9` says nothing about whether
  `[5,6,7]` fits in two windows of 9. Window keys snap down onto a dataset-wide quantile set
  published as the additive manifest field `adaptiveBoundaries`, which is what makes adaptive keys
  enumerable by a prefetcher; collisions fall back to the exact timestamp and are counted and
  logged. `--adaptive-greedy` is the rollback, `--adaptive-boundary-count` tunes the set.
  **Measured** on a bursty 6-cell fixture, exact vs greedy: per-tile _feature_ variance 2 → **0**
  (min 26 → 37), per-tile _byte_ variance 1033 → **1005**, largest tile unchanged at 710 B. Metric 1
  is met; note the win is far larger in features than in bytes, because bytes do not track feature
  count tightly. 6 unit tests + 4 CLI tests (including byte-reproducibility).
- **TB-11 — all three vertex-time menu extensions.** (1) The bucket-proportional ceiling:
  `EncoderConfig::for_temporal_tier` scales `vertex_time_max_step_ms` by a tier tile's bucket ratio;
  the base tier returns `Cow::Borrowed`, so the common path stays byte-identical rather than merely
  equal. (2) The FEATURE-ANCHORED u16 tier, tried between the layer-anchored u16 and u32: deltas
  measured from each feature's own `start_time`, which is free on the wire because the anchor
  already ships in CORE. It rescues trip-shaped layers — wide layer span, narrow per-feature spans —
  from the u32/i64 cliff. New `TILE_META.vtf` (a distinct key, never a reshaped `vt`, per the
  extend-never-mutate rule) plus the must-understand capability `vertex-time-feature-anchor`, and it
  is again OBSERVED rather than derived, via a new `encode_tile_observed` returning
  `EncodeObservations` — a returned value, deliberately not shared state on `EncoderConfig`, which
  is compared for byte-equality. Both readers branch, **and so does `stt-optimize export`**, which
  would otherwise have written raw deltas into GeoParquet as if they were epoch millis (it now
  reconstructs the per-row anchor, handling the compact `UInt32`+`t0` start-time form too). The
  tier DECLINES rather than wrapping when a vertex predates its own feature's start — one
  un-anchorable vertex disqualifies the layer, and the scan simply continues. 5 Rust + 3 TS tests.
  (3) The playback coupling landed as a **doctor rule**, not an analyzer advisory: the temporal
  advisor's own docs correctly refuse this lever because source features carry no vertex times, so
  `rule_vertex_time_precision` reads the built archive instead. It prices the ceiling against
  playback — one frame of a 45 s / 30 fps loop advances `duration / 1350` ms, so a finer step is
  imperceptible — and fires only when the column is on u32/i64, costs ≥5 % of tile bytes, and the
  budget exceeds the default ceiling by 4×. Marked LOSSY in its own remediation text. 2 tests.
- **A serde-default on `Manifest.variants`.** Not a plan item — a diagnostics fix. The in-flight v3
  field had no default, so every pre-v3 archive died inside serde with `missing field 'variants'`
  _before_ the version gate could speak. Now `stt-optimize inspect` on a v2 archive reports
  `unsupported packed formatVersion 2 (this reader supports 3)`, which is the truth. The field is
  still required by v3 — `variant_id` resolution still validates it.

### The DT track and its triggers

DT-2, DT-3 and DT-5 are **trigger-gated**, and the plan is explicit that "the trigger may never fire;
the Phase 5 deliverable is the reviewed design plus instrumentation, and that is acceptable." So the
owed work is the _evaluation_, not the feature. Partial evidence gathered:

- **DT-2 (home-zoom assignment)** — condition 1 **fires**: `earthquakes-v2` declares
  `feature_count: 522,982` stored rows against ~47.5 K distinct quakes, i.e. a duplication factor
  **D ≈ 11×**, well past the D ≥ 4 threshold. Condition 2 (replicated geometry is the dominant
  archive-byte share, per M1's per-column measurement) is **unmeasured**: `stt-optimize inspect`
  cannot open the archive because it is `formatVersion 2` and the working-tree reader is v3.
  Measuring it requires a local v3 rebuild first.
- **DT-3 (reduced temporal tiers)** and **DT-5 (interval segregation)** — triggers unevaluated; both
  need route-level QoE captures that the v2/v3 skew blocks.
- **DT-1 (the tier-declaration spec)** and **DT-4 (the scrub decision)** are not trigger-gated and are
  simply not started.

## 6. Open defects in what DID land

Ranked by consequence. These are real and should be closed before R1 is run.

1. **A 39× client resident-memory regression from the M2 dictionary hoist — partially fixed.**
   Measured on 380,007 features: 400 resident tiles cost **264.4 MB** heap pinned vs **6.7 MB**
   unpinned, because every tile materialized the full dataset-global category list with zero
   array-identity sharing (`user` = 14,653 categories re-materialized per tile, including tiles
   holding one feature). At this project's measured 854-resident-tile figure that extrapolates past
   half a gigabyte. **"Bounded client memory" is one of the four constraints in the program's own
   spine**, so this was a spine violation shipped as a 12.2 % wire win.
   _Landed:_ `HoistPolicy` now gates hoisting on the dataset-scale wire surrogate
   (`dataset_dictionary_is_smaller`, which previously had **no production caller**) plus explicit
   caps (1024 categories / 4096 category-bytes), so a high-cardinality free-text column pins `Utf8`.
   _Still open:_ reader-side array-identity sharing in `packages/core/src/tile.ts`
   (`sharedArrayIdentityHits` was 0), and the `manifest.json` growth (10,353 B → 291,589 B, +2,716 %)
   on a startup-blocking un-ranged fetch. Re-measure the heap delta after both.
2. **TB-5 is inert.** `apply_synthetic_row_ids` / `IdRenumber` have no call site outside
   `arrow_tile/layer.rs`. The APIs and their proofs (cross-tile identity, per-tile uniqueness, a
   proptest over random clipping splits) are correct; nothing calls them. ⚠️ Wiring it naively is
   unsafe: the guard that a **mixed** layer stays `Keyed` belongs in `build_point_layer`
   (`crates/stt-build/src/columnar.rs`) and **was never written**, and TB-5's own test documents a
   live pre-existing collision (explicit source id `5` vs synthetic row index `5`).
3. **The golden fixtures cannot see M2.** `v2_golden.rs:95` and `make-golden-fixture.rs:50` both
   build from `..EncoderConfig::default()` ⇒ `global_pins: None` ⇒ they encode on the incumbent
   per-tile path. TB-14 must make the generator exercise pins _before_ regenerating, or it will
   re-bless bytes that pin nothing new.
4. **`encode.rs` hoist edge, unmeasured.** Hoisting requires
   `dict_columns == pinned_dict_columns`; a layer mixing a pinned column with an unpinned one that
   the per-tile surrogate dictionary-encodes falls back to `DictHoist::Tail`, shipping the full
   global list in every tile's tail. Most likely on summary/LOD tiers, where derived columns are
   unpinned by design.
5. **`stt-serve` does not consume pins.** `EncoderSettings::resolve()` uses
   `..EncoderConfig::default()`, so served tiles use per-tile verdicts while offline archives use
   pinned ones. Self-consistent per producer, not corrupting, but a divergence.

## 7. Environment findings

- **An in-flight v2 → v3 format break predates this program.** `packages/core/src/archive.ts` bumps
  `PACKED_FORMAT_VERSION` to 3 behind a strict-equality gate while HEAD, all 64 local showcase
  archives, and the 68-archive fleet are v2 — so the working-tree reader opens none of them. The
  Rust side has the same shape (an uncommitted non-defaulted `Manifest.variants`). This blocked every
  browser-side instrument until archives were rebuilt locally at v3.
- **The `bench-regression` CI job has been dead since the transcode-removal campaign.** Its baseline
  `tools/bench/baselines/earthquakes-ci.stt` is a legacy single-file container (`STT\x04`) that the
  packed-only reader tries to JSON-parse; `tools/bench/src/index.mjs` also rejects a packed directory
  with `EISDIR`. It is **not** part of the repo's stated green definition, so it was never
  load-bearing — but no later item may cite it as a guard until it is rebuilt or retired.
- **`stt-build --maximum-tile-features 5` produces 260 "directory `time_end` is not tight" errors**
  that vanish without the flag — a pre-existing writer defect adjacent to R1's levers.

## 8. The R1 gate

Rebuild window R1 was gated on M7's validator. The gate was reviewed adversarially **four times** and
answered NO three times before YES. What it now provably catches, with no false positive across
points/lines/polygons × 4 bucket widths × summary tier × temporal LOD × interval features: coordinate
scrambles on any geometry at full decode _and_ under `--sample`; z-range escapes; per-column numeric
range and categorical cardinality drift; under-stated `metadata.bounds` (error when attested, warning
when legacy); feature loss on point, line and polygon archives; `--expect-fingerprint` transform
acceptance.

**What it does not cover — carry these knowingly:**

1. **Exit code alone is not acceptance.** Arming is self-declared: strip the manifest properties from
   an archive carrying 40 % loss and it exits 0. An R1 acceptance script must assert
   `distinct_id_basis == "decoded-ids"` per archive.
2. **Archives above 5 M source features are disarmed** — `storm-3d` (44.1 M), `goes-glm` (14.4 M),
   `ecco-currents` (8.79 M) fall back to the loose row floor.
3. **Clipped trips get no feature-loss detection**; `--streaming` builds carry no fingerprint at all.
4. **Seam-crossing line geometry is uncovered** — a dateline-crossing 2-vertex line keeps its
   356°-wide edge and every check passes (affects `ais-all-us`, `drifters`, `animals`).
5. **The fingerprint is a tiler check, not a source check** — it is folded from parsed features by
   the same binary that writes the tiles, so it cannot see a bad parse. Only `--expect-fingerprint`
   against a pre-R1 archive crosses that boundary.

## 9. What a human must still do

- **Decide the golden re-pin (TB-14).** The tree currently carries one intentional red. Re-pinning
  requires a reviewed commit with a `Rebuild-Window: R1` trailer, and should not happen until §6.1–3
  are closed.
- **The fleet republish is untouched and remains a human decision** (~29.3 GiB / 1,324 objects). No
  agent uploaded, published, or ran an r2-sync script at any point in this program.
- **Browser-verified aesthetics.** This project requires the maintainer's own in-browser pass; no
  screenshot-judgment loop was built, per the standing rule.
- **Correct the seven source-document defects in §3.**
- **Pair the fleet republish with a client deploy, or hold `triangles-partial` back.** TB-12 is
  default-on for `stt-build`, so every republished polygon archive that mixes will declare the
  capability — and any already-deployed client without the decoder backfill will then **refuse to
  open it**. That is the capability working as designed (loud, not silent), but it is a real
  ordering constraint on R1: ship the reader first, or build the fleet with
  `--no-partial-triangles`. The rollback exists precisely so this is a choice rather than a
  discovery.
