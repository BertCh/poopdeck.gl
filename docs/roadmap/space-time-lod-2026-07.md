# Space × time LOD — audit, SOTA, and the improvement plan

> **Status: PLAN (2026-07-10) — theorycrafting for very-large datasets; nothing
> here is implemented.** Inputs: a two-sided codebase audit (Rust build path, TS
> runtime path), a 104-agent adversarially-verified external research sweep
> (13 findings survived 3-0 verification; 1 refuted), and the standing design
> records ([scrub-lod-2026-07.md](./scrub-lod-2026-07.md),
> [stt-packed-format-decisions.md](./stt-packed-format-decisions.md),
> [../spec/time-model.md](../spec/time-model.md)). Companion to — not a
> replacement for — the scrub-LOD record: scrub P3/P4 become phases of this plan.

---

## 0. TL;DR

STT today has **exactly one real data-space reduction (the summary tier)** and a
**fully-wired but universally-disabled motion tier (scrubLod)**. Everything else
is either replication (every feature stored at every zoom), a fixed
`floor(viewport.zoom)` mapping (no screen-space error anywhere, in any of the
four renderers), or machinery that exists but doesn't reduce (the temporal-LOD
pyramid re-buckets without shrinking). For very-large datasets that's three
compounding costs: archives ~O(zooms × N), fetches that ignore what a pixel can
show, and render paths with no budget.

The verified SOTA converges on one architecture, and STT already has a
hand-rolled proof of it in-tree: **disjoint additive decomposition + an authored
per-level error metric + a client-side budgeted refinement loop.** Potree proves
LOD without data loss at billion-point scale (every point in exactly one node;
union = the full dataset); 3D Tiles/COPC prove the metric belongs _in the
format_; tippecanoe proves degradation should be _budget-conditional, not
eager_; M4 proves temporal downsampling can be _provably lossless at screen
resolution_. The AV cockpit's `-lod` LiDAR bundles (per-return `home_zoom` +
`lodMode:'additive'`) are exactly this pattern, built by hand for one dataset.

The plan: six phases that promote that pattern from a hand recipe to a
first-class, **declared** (never silent) capability across all four LOD axes —
vertex, feature-count, temporal, attribute — then close the loop with a
budgeted, interaction-aware runtime selector. Joint space×time LOD policy has
**no verified external precedent** — the research killed every claim about it —
so phase 6 is STT naming a category, not copying one.

**Governing principle (amended 2026-07-10):** no thinning _by default_ stands —
the base tier is always lossless and demos stay comprehensive. But for
super-huge (Waymo-LiDAR-class) datasets the user explicitly allows reduction,
delivered as **declared, opt-in LOD tiers** announced by metadata (the
"declared variant" hook the time-model spec §4 already reserves) — never as a
silent default.

---

## 1. Current state — the audit in one table

Four LOD axes plus two cross-cutting behaviors. "—" = does not exist.

| Axis                              | Build side (Rust)                                                                                                                                                                                                                                                                                     | Runtime side (TS)                                                                                                                                                                      |
| :-------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vertex (lines/polys)**          | Trajectory-only VW + time-aware TD-TR (`simplify.rs`), **default OFF**, latitude-unaware degree-epsilon ladder; polygons & timeless lines **never** simplified (`tiler.rs:804-914`, `1067-1071`); mutually exclusive with `vertex_value_matrix` (`clip.rs:765-766`)                                   | — (no decimation, no SSE)                                                                                                                                                              |
| **Feature-count (points/events)** | **Full per-zoom replication** (`process_zoom_level` re-places every feature per zoom, `tiler.rs:465-486`; earthquakes: 47.5 K × 11 zooms = 523 K rows). Opt-outs: `min/max_zoom_field` banding (hand-authored; NWM stream-order, AV `home_zoom`), `min_features_per_tile`, opt-in lossy `tile_budget` | `floor(zoom)` → tile-z, clamp, `PARENT_FALLBACK_LEVELS=4`; `lodMode:'additive'` unions `[minZoom..z]` (used only by AV `-lod`); pinned z0–1 overview (20 MiB)                          |
| **Temporal resolution**           | `--temporal-lod` pyramid exists but **re-buckets only — zero reduction** (self-described scaffold, `tiler.rs:362-373`); summary tier (H3/Quadbin + `sub_buckets`) is the only true aggregation; bounded vertex-time quantization (u16 deltas)                                                         | Pyramid consumed **only** via scrubLod P2 — which is default-OFF and **enabled in zero call-sites**; nothing selects coarse buckets at rest                                            |
| **Attribute**                     | `--quantize-coords` world-grid (shipped), `--quantize-attr(s)`                                                                                                                                                                                                                                        | Lazy-props materialization format-ready, reader eager-only                                                                                                                             |
| **Interaction state**             | — (build has no notion)                                                                                                                                                                                                                                                                               | scrubLod P0–P2 fully wired (`setInteractive` → zoom-drop + temporal-LOD route), kill-switched, **inert everywhere**; governor caps _speed_ from throughput but never degrades _detail_ |
| **Budgets**                       | Opt-in per-tile byte/feature budgets (importance-scored, never auto)                                                                                                                                                                                                                                  | **None** — no point/vertex/instance budget, no frame-time adaptation, in deck, maplibre, three, or cesium                                                                              |

Additional grounded facts the plan leans on:

- The **zoom-range clamp** (`recommend_zoom_levels` occupancy walk-down) and
  **byte time-binning** are the current no-thinning answers; both bound the
  pyramid, neither reduces within a tile.
- All LOD-shaped advice from `stt-optimize` (temporal-lod, budgets, summary,
  zoom-field) is **suggestion-only**, never auto-applied; there is **no
  simplify advisor** at all.
- `resolvePlaybackParams` derives time/speed/window from archive metadata but
  produces **no LOD parameter**.
- FlowCorridorLayer still re-tessellates ~2×/bucket (new `data` object → new
  `PathLayer` per gradient sub-step); the static-array memoization reduced CPU
  but the "geometry stays" comment overstates it. Root cause in
  [[stt-rivers-rain-perf-rootcause]] memory; fixing it is a **prerequisite for
  honest LOD measurement** (phase 0).
- The rivers lesson (detail-zoom 11 data tiled to z4–8 → 8× over-dense
  geometry) is the vertex-axis failure mode already observed in production.

## 2. Verified SOTA (2026-07-10 sweep) — what transfers

Thirteen findings survived 3-vote adversarial verification; the full cited set
lives in the research transcript. What each contributes here:

**Spatial, vector (tippecanoe, geojson-vt):**

- **Budget-conditional degradation** — tippecanoe's drop/coalesce strategies
  fire _only when a tile breaches_ an explicit budget (500 KB / 200 K features
  default). Lesson: degrade lazily against a declared budget, never eagerly.
- **Geometric drop ladder** — below a `basezoom` at which _all_ points are
  kept, retain ~1/2.5 per zoom step; `gamma` thins sub-pixel-spaced points to
  √count. The "basezoom keeps everything" shape is exactly compatible with a
  lossless base tier.
- **Simplification bounded in tile units** — DP tolerance = one tile unit
  (i.e. resolution-relative, not degrees); **tiny-polygon diffusion** preserves
  aggregate area probabilistically instead of deleting small polygons — the
  anti-silent-data-loss mechanism for the polygon axis.
- **Per-vertex significance precompute** (geojson-vt) — compute RDP importance
  once per vertex; each zoom is a threshold slice. One pass, N zoom outputs.

**Spatial, 3D/point-cloud (3D Tiles, cesium-native, COPC, Potree):**

- **The metric lives in the format** — 3D Tiles `geometricError` (meters,
  required per tile) / COPC per-level point `spacing` (halved per level); the
  client projects it to screen-space error and refines when SSE ≥ threshold.
- **ADD vs REPLACE refinement** — ADD (children add detail, parent stays) is
  the format-level no-thinning precedent; STT's `lodMode:'additive'` is the
  same concept, currently reader-only.
- **Potree's disjoint additive octree** — every point in exactly one node,
  union reconstructs the dataset exactly; **LOD and comprehensiveness are
  compatible**. Refinement is a _global point-budget priority traversal_
  (max-heap by projected size; hard `break` on budget) — the hardware-adaptive
  knob is one number.
- **Interaction hysteresis** (cesium-native "Ancestor-Meets-SSE", "Kicking",
  `loadingDescendantLimit`) — deliberately violate the pure metric during
  motion to avoid vanishing detail/holes; kicked tiles stay in load queues so
  refinement completes at rest. The closest production analog to scrubLod P4.

**Temporal (M4, MinMaxLTTB):**

- **M4** — min/max/first/last per pixel column is provably sufficient _and
  necessary_ for pixel-identical line rendering: a hard 4·w bound, up to 100×
  reduction. Temporal downsampling can be _error-free at screen resolution_
  when bins align to output pixels (caveat: two-color non-AA rasterization).
- **MinMaxLTTB ladder** — MinMax preselect (ratio 4) → LTTB, for
  shape-preserving approximate decimation when pixel-exactness isn't required.
- ⚠ The tsdownsample-as-reusable-Rust-crate claim was **refuted (0-3)**; plan
  assumes **in-house Rust implementations** (the algorithms are small).

**What did NOT survive verification — the open frontier:** no claim about
_joint_ space-time LOD (detail as a function of zoom **and** window/speed),
CARTO dynamic aggregation internals, Zarr/TileDB temporal pyramid conventions,
or trajectory compressors (SQUISH-E, dead-reckoning) survived. Absence ≠
nonexistence, but: **nobody has a verified, published joint policy. STT's
time-native premise means it can define the category** (the same wedge argument
as the temporal directory, format-decisions §2).

_Update 2026-07-21:_ the temporal-deltas research (format-decisions §11)
sharpened this frontier's boundary: the **lossless inter-timestep delta**
branch is ruled out (breaks standalone decode/seek/dedup; zero production
adoption; zstd-over-time-adjacent recovers most of it), so the productive
branches remain exactly this plan's reduction tiers plus one new format lever —
**geometry-blob sharing across temporal chunks** (reference-dedup of static
geometry, format-decisions §11 follow-up 1), which also relieves the rivers
13× decoded-duplication pressure noted below.

## 3. Design synthesis — the STT LOD model

One sentence: **author a per-level error metric into the archive for each of
the four axes, store detail as disjoint additive levels wherever reduction is
allowed, and let one budgeted client-side selector spend a global budget across
space and time, with interaction-state hysteresis.**

Concretely, five mechanisms:

1. **Declared reduced tiers** (temporal + point axes). Fill the reserved
   "declared variant" hook: `temporal_lod[].reduction: "none" | "m4" |
"minmaxlttb" | "spacing"` (+ a `capabilities` must-understand entry so old
   readers refuse politely rather than misrender). `"m4"` keeps per
   (cell, coarse-bucket, property) min/max/first/last features; `"spacing"` is
   the voxel/Poisson decimation for point clouds (generalizes
   `adaptive_lidar_select`). This is scrub-LOD P3 (G5), generalized from
   "scrub tier" to "any reduced tier".
2. **Additive home-zoom decomposition** (feature-count axis). Opt-in
   `--spatial-lod additive`: each feature stored at exactly **one** zoom (its
   home zoom, from a deterministic density/importance rank), reader renders the
   union `[minZoom..z]` — the machinery `lodMode:'additive'` + zoom-band
   filtering already implements. Union at maxZoom = the complete dataset
   (lossless, Potree-style); archive size drops from O(zooms×N) to O(N).
   Replaces the AV/NWM hand recipes with a build-pipeline feature.
3. **Resolution-true simplification** (vertex axis). Rewrite the epsilon
   ladder in tile units (Mercator-aware), extend to polygons (with
   deterministic area-preserving tiny-polygon handling) and timeless lines,
   precompute per-vertex significance once (geojson-vt), make it
   matrix-aware (decimate `vertex_value_matrix` rows in lockstep — the rivers
   per-reach-constant case is provably safe). Still opt-in per build.
4. **Authored refinement metric + SSE selection.** Metadata gains a per-level
   scalar (`geometric_error` meters, or point `spacing`); the tileset gains an
   optional SSE selector (fractional zoom, devicePixelRatio, tilt-aware) that
   replaces `floor(zoom)` when the archive declares the metric. On the temporal
   axis the metric is already there (`bucket_ms`); the M4 rule ("bucket ≈
   visible-span / timeline-px") makes the temporal pick deterministic.
5. **Global draw budget + interaction hysteresis.** A per-frame point/vertex
   budget spent by priority (projected size × temporal proximity to playhead),
   Potree-style hard stop; Kicking-style anti-pop (coarse stays resident under
   fine; degraded-only-during-motion via the existing `setInteractive` bit);
   governor gains the _"keep speed, degrade detail"_ alternative to its current
   _"cap speed, keep detail"_ auto-speed answer — user-selectable policy.

The four axes and the mechanisms that serve them:

```
            vertex axis      feature-count axis   temporal axis        attribute axis
build:      (3) simplify     (2) additive home-z  (1) reduced tiers    quantize (shipped)
metadata:   (4) geom_error   (4) geom_error       bucket_ms (shipped)  lazy-props (open)
runtime:    (4) SSE select   (4)+(5) SSE+budget   M4-rule pick + (5)   lazy materialize
```

## 4. Phases

Ordered by risk-adjusted value; each phase ships independently and is
individually kill-switched. Phases 1–2 need no format break; 3–4 are
metadata-additive (capabilities-gated); nothing rewrites existing archives.

**Phase 0 — measure first, and stop the bleeding (runtime-only, no format
change).** Fix FlowCorridor ref-stable data + color-only updates (root cause
already analyzed; invalidates every rivers/rain perf number until fixed). Add
"LOD waste" metrics to `stt-optimize inspect`: per-zoom duplication factor,
sub-pixel vertex fraction at each zoom's ground resolution, bytes-per-visible-
pixel at reference viewports. These numbers are the before/after evidence for
every later phase — the measure-don't-model lesson (optimize record: wins are
dataset-shaped, 1.07×–21×).

**Phase 1 — vertex axis: simplification done right (build, opt-in).**
Tile-unit tolerance replacing the degree ladder; polygons + timeless lines;
per-vertex significance precompute so all zooms come from one pass;
matrix-aware decimation lifting the `vertex_value_matrix` exclusivity; a
`simplify` advisor (fires on sub-pixel vertex fraction, i.e. would have caught
rivers-dz11 automatically). Golden fixtures + a "no visible change at native
zoom" render test. Biggest quality-per-byte win, zero reader changes.

**Phase 2 — temporal axis: declared reduced tiers (= scrub P3, generalized).**
Extend `generate_lod_level` with the reduction modes; spec erratum activating
the declared-variant hook + `capabilities` entry; in-house Rust M4/MinMaxLTTB
(tsdownsample refuted — implement, don't wrap); `stt-validate` conformance
(extrema preserved, coarse byte-cost ≪ base, determinism). Runtime: consume the
pyramid **at rest** (zoomed-out wide-window playback picks coarse buckets, the
same shape as summary `tier:'auto'` dispatch), and run the scrub-LOD §7 QoE
verify to finally flip `scrubLod` on for heavy demos. Pilots: drifters/ecco
(long time series), AV LiDAR `spacing` mode (per the 2026-07-10 no-thinning
amendment).

**Phase 3 — feature-count axis: first-class additive decomposition (build +
metadata).** `--spatial-lod additive` with deterministic home-zoom assignment
(density-rank via FNV feature-id hash — **no RNG**, reproducible-builds D6 is
non-negotiable); `metadata.spatial_lod` + capabilities so readers auto-switch
to `lodMode:'additive'`; advisor fires on duplication factor (earthquakes 11×
is the poster child). Points/events first; interval features and trajectories
stay replicated in v1 of this phase (their LOD is the vertex axis).
Cross-check with blob-ordering: additive levels change the directory's zoom
distribution, so re-run the `ordering_sim` measured picker on pilots.

**Phase 4 — runtime engine: SSE + global budget + anti-pop (= scrub P4
absorbed).** Optional SSE selector consuming the authored metric (also fixes
tilted/globe over-fetch, where `floor(zoom)` is wrong by construction); global
point/vertex budget with Potree's break-on-budget priority traversal, enforced
at selection (what to fetch/draw) not per-renderer; hysteresis + cross-fade +
Kicking analog on the existing parent-fallback machinery; velocity-aware scrub
degrade. This is where "no GPU budget anywhere" gets its answer.

**Phase 5 — the frontier: one joint space-time policy, named and spec'd.**
Unify: `detail = f(zoom/SSE, timeline-px (M4 rule), playbackSpeed, interaction
state, global budget, measured throughput)`. Governor exposes the
speed-vs-detail policy choice; `resolvePlaybackParams` starts emitting LOD
params (today it emits none). Publish as a spec chapter + blog-shaped
positioning doc — the research sweep confirmed nobody has published this;
it's the same "name the category" move as the temporal directory.

## 5. Constraints & invariants (bind every phase)

- **Base tier stays lossless; reduction is declared or it doesn't ship.**
  Every reduced representation is announced by metadata + capabilities
  (Zarr `must_understand` semantics, already in the spec). No silent variant.
- **Determinism** — reproducible builds are spec D6. Every selection/reduction
  is rank- or hash-keyed (FNV ids), never RNG, never HashMap-iteration-order.
  Tippecanoe's _probabilistic_ diffusion must become deterministic here.
- **Time-model invariants hold in every tier**: tight `time_end`, `cover_t_min`,
  one-bucket placement, LOD levels strict multiples sorted ascending.
- **Coarse tiers never gate** (scrub G7): preview-only; the governor's buffer
  math tracks the fine tier.
- **Feature identity across tiers** where the spec promises it (same `id`
  resolves everywhere); reduced tiers that synthesize features (M4 rows) must
  declare a distinct identity domain rather than fake base ids.
- **Don't relitigate**: lightweight encodings NO-GO, rel-times32/narrow-ids
  SKIP, tile-local quantization (+61 %), request-count as ordering cost. And
  no server-side dynamic aggregation — STT's architecture is static tiers +
  client selection (serve stays v1 by decision).
- **Cost cross-check**: v2's schema-tax lesson (fixed tax dominates small
  tiles) applies to reduced tiers too — a coarse tier of many near-empty tiles
  can cost more than it saves; the validator's byte-cost gate is load-bearing.

## 6. Measurement plan

Per phase, on the heavy pilots (NYC taxi ~10 M verts, rivers+rain, AV LiDAR,
drifters/ecco, earthquakes):

- **Archive**: total bytes, duplication factor, per-zoom row counts (phase 1/3
  headline: earthquakes 523 K → ~47.5 K rows; rivers 13× → 1×).
- **Wire**: bytes-to-first-frame / requests-to-first-frame (the COPC "4 reads"
  benchmark, already the register's metric), bytes-during-scrub vs baseline.
- **Render**: FPS on composite scenes, vertices/frame, pop/oscillation count
  (hysteresis target ~1–2 per scrub), scrub time-to-first-pixel (< one 60 Hz
  frame from a resident coarse tile).
- **Fidelity**: pixel-diff at native zoom for phase 1 (target: imperceptible);
  M4 extrema-preservation conformance for phase 2; union-equals-base checksum
  for phase 3.
- **Rollback drill**: every flag off ⇒ byte- and behavior-identical (the
  scrubLod discipline, kept).

## 7. Open decisions

1. **Home-zoom assignment metric** (phase 3): pure density rank (Poisson-disk
   style) vs importance column (magnitude, stream order) vs hybrid. Per-dataset
   choice via advisor; needs the phase-0 metrics to decide defaults.
2. **Where the global budget lives** (phase 4): tileset selection (backend-
   agnostic, coarse) vs per-renderer draw budgeting (precise, 4× the work).
   Leaning: selection-level first, renderer enforcement only if measurement
   demands it.
3. **M4 feature synthesis semantics** (phase 2): min/max/first/last as four
   synthetic point features per (cell, bucket, property) vs one feature with
   packed extrema props. Affects layer compatibility; decide against a real
   pilot dataset.
4. **SSE default** (phase 4): opt-in per archive (metric present) vs global
   default once proven. Cesium's default `maximumScreenSpaceError=16px` is the
   calibration anchor.
5. **Does additive become the build default** for point datasets once pilots
   are green, or stay advisor-recommended? (The no-thinning amendment covers
   opt-in; a _default_ flip needs its own user decision.)
6. **Trajectory-specific compression** (SQUISH-E, dead-reckoning): unverified
   territory; revisit only if TD-TR + vertex-axis work leaves a measured gap.

## 8. Relationship to prior work

- **Absorbs** scrub-LOD P3 (→ phase 2) and P4 (→ phase 4); the scrub record's
  §2 survey and G7 contract stand unmodified.
- **Activates** the time-model spec §4 "declared variant" reservation and the
  format-decisions capabilities mechanism; no new addressing (COPC anti-lesson:
  never a second addressing path).
- **Generalizes** the AV cockpit `home_zoom`/`adaptive_lidar_select` recipe and
  the NWM stream-order banding into build-pipeline features.
- **Feeds** the open register: item 4 (temporal-LOD beyond P0–P2) and item 5
  (scrub P3/P4) close through phases 2/4; the preprocessing-framework's
  "read-cost ∝ output-resolution" thesis is this plan's runtime dual.
- **Memory**: the no-thinning principle was amended 2026-07-10 (user) — base
  lossless, declared reduced tiers allowed for super-huge datasets.
