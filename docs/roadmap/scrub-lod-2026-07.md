# Scrub-time LOD degradation — research, design, shipped Track A

> **Status: P0–P2 SHIPPED 2026-07-05; P3 + P4 + browser QoE verify OPEN.**
> Researched 2026-07-03. The wire-only Track A shipped: governor `setInteractive`
> → tileset `scrubLod` option (**DEFAULT OFF**, kill-switched); the spatial axis
> is the primary policy, the temporal axis is wired but inert until enabled.
> Remaining: the P3 baked scrub tier, P4 polish, the user-run QoE verify (§7).
> §2/§9 preserve the five-domain SoTA survey (adversarially verified) as durable
> research. Companion to [`playback-and-loading.md`](./playback-and-loading.md),
> which shipped the clock↔buffer coupling this builds on.

---

## 0. TL;DR

The single unifying idea across every mature interactive system is a **two-tier
architecture: a cheap "motion tier" served while the user moves, and the expensive
"settle tier" served once they stop.** Video players do it with proxy / I-frame
tracks; web maps do it with scaled parent tiles; VTK/ParaView do it with
interactive-vs-still render passes; time-series charts do it by picking a bucket
size ≈ chart-pixel-width.

**STT already had almost all the pieces** (inventory in §3). **What was missing
was policy and wiring, not machinery:** the "we are scrubbing" bit died inside
the governor; LOD was purely camera-zoom; the temporal-LOD pyramid was never
auto-selected in the hot path; no time-coarse stand-in mirrored the spatial
overview tier. The shipped P0–P2 closed all four, wire-only. The fifth finding
stands: **the coarse-time aggregator only re-buckets — it does not reduce
feature count** (G5), so a coarse tier isn't guaranteed cheaper to fetch/decode —
exactly why P3 remains. The rollout was front-loaded so the first
perceived-latency win shipped with **no build-format change and a hard
kill-switch**, mirroring the multi-source scheduler.

---

## 1. The problem

Pre-ship trace of a timeline drag (still the shipped DEFAULT, since `scrubLod`
ships OFF): `PlaybackControls` fires `beginScrub()` on pointer-down,
`scrubTo(value)` per move + a `seekSettleMs`-debounced settle-commit `seekTo`,
`endScrub(value)` on release. `beginScrub()` freezes the clock and sets a
**private** `scrubbing` flag; while held, no gate can pass and the frontier clamp
is suppressed — a deliberate "no degraded playback under a held thumb" policy.
`scrubTo()` is documented as "move the clock for preview — no tileset update
storm, no fetches", but that is **only half true**: it fires a `tick`, the
layer's throttled (≤10 Hz wall, `timeWindow/20` sim) `_handleTimeUpdate` calls
`tileset.update({ time, … })`, and a large jump trips the seek detector, which
**`flushPrefetch()`es and re-runs `selectAndLoadTiles()`** — a fast drag issues
up to ~10 fresh viewport×window selections/sec, each flushing the last.

The net effect on a heavy dataset (NYC taxi ~10 M vertices; AV cockpit
LiDAR/surfels): scrubbing to an unbuffered instant shows **whatever coarse tile
is already resident** — the pinned z0..z1 overview if it exists, else nothing —
while the base-tier fetch for the exact viewport×instant churns and is repeatedly
superseded. There was **no deliberate coarse-tier substitution** — the system
waited, at full detail, for a target it kept invalidating. The opportunity:
**during the drag, deliberately ask for less** — a coarser spatial zoom and/or
temporal bucket cheap enough to actually arrive within a scrub frame — then let
the existing settle-commit + gate path refine to full detail on release.

---

## 2. State of the art (external research)

Five domains, one pattern. Full source list in §9. Claims flagged with residual
uncertainty are marked `⚠`.

### 2.1 The unifying pattern — a motion tier and a settle tier

Every mature system that stays responsive under interaction keeps **two
representations**: a cheap one addressable at any point for *motion*, and an
expensive one for the *settled* frame.

| Domain | Motion tier | Settle tier | Switch trigger |
| :-- | :-- | :-- | :-- |
| NLE editing | low-res **proxy** media | full-res original (relink) | render/grade |
| Video seek | **I-frame-only track** / storyboard sprites (WebVTT `#xywh`, Roku BIF, HLS `EXT-X-I-FRAMES-ONLY`) | full GOP decode | scrub release |
| Web map | scaled **parent tile** (`best-available`) | exact-zoom tile | camera `idle` |
| 3D/terrain | coarse ancestor (SSE, "kicking") | SSE-selected fine tile | camera settle |
| Sci-vis (VTK/ParaView) | **interactive** low-quality pass (decimated / points / bbox) | **still** full-res pass | interaction end |
| Time-series chart | coarse **pyramid level** (bucket ≈ pixel-width) | raw series | zoom settle |

The motion tier's defining discipline (from I-frame tracks): it must be
**independently addressable / decodable** — no cross-tile decode dependency — so a
jump to any point is instant. And "**disappearing detail is worse than
late-arriving detail**" (Cesium "Ancestor Meets SSE" / "Kicking"): keep the coarse
tier visible *under* the fine tier until the fine one lands, rather than blanking.

### 2.2 Bound working resolution by output pixels — on both axes

M4 (Jugel et al., PVLDB 2014) and Grafana's `maxDataPoints` state the temporal case:
you can never display more distinct values than the timeline has **pixels**, so
effective resolution = visible-span ÷ chart-pixel-width (Grafana's default
`maxDataPoints` *is* the panel width; interval ≈ range / maxDataPoints, e.g. 7 d /
1000 px ≈ 10 min/point). Cesium's screen-space-error is the identical rule in space:
never carry more geometric detail than a pixel of on-screen error
(`maximumScreenSpaceError` default 16 px). **This makes "how coarse should the
preview be" a deterministic computation, not a guess** — pick the temporal LOD level
whose bucket ≈ visible-span / timeline-pixel-width, and the spatial level whose
ground-resolution ≈ viewport pixel size.

### 2.3 Temporal LOD algorithms (what a cheap time tier should store)

- **M4** — per pixel-column keep **min, max, first, last** (4 tuples/column):
  provably pixel-perfect for a 1px line at a given width; ~4×pixel-width points
  regardless of N; expressible in SQL.
- **LTTB** (Largest-Triangle-Three-Buckets, Steinarsson 2013) — keep the point per
  bucket forming the largest-area triangle with the prior kept point and the next
  bucket's centroid; **shape/peak-preserving**, picks real points, linear time.
  `MinMaxLTTB` (2023) scales it to huge N.
- **Temporal pyramids / roll-ups** — precompute power-of-two resolutions; **store
  min/max/count/first/last, not avg** (avg hides spikes). O(output size), independent
  of N — ideal for scrubbing.
- **Gorilla** (delta-of-delta timestamps + XOR values, ~10×, lossless) — the
  time-series analog of keyframe+delta; keeps more data resident/streamable.
- **Interactive cubes** — Nanocubes (hierarchical space+time, bounded screen error),
  imMens (GPU data tiles ~50 fps brushing), Hashedcubes (≈2 orders less memory). The
  closest architectural fit to a space×time tile store.

### 2.4 Map / geo tiling mechanics we can reuse verbatim

- **Overzoom / parent backfill** — deck.gl `TileLayer.refinementStrategy`
  (`'best-available'` backfills from the closest cached level; `'no-overlap'`;
  `'never'`), MapLibre `OverscaledTileID` + `findLoadedParent` + LRU retention;
  raster **cross-fade** `raster-fade-duration` default **300 ms** (vector tiles pop —
  Mapbox #934).
- **SSE-driven refinement** — `error = geometricError·height / (distance·2·tan(fovy/2))`;
  REPLACE vs ADD refinement (ADD keeps the parent visible — right for point clouds);
  `skipLevelOfDetail`, `foveatedScreenSpaceError`, `progressiveResolutionHeightFraction`
  (coarse first pass).
- **Deferred loading during motion** — Cesium `cullRequestsWhileMoving` (don't
  request tiles the moving camera will have left behind), `foveatedTimeDelay` (wait
  after the camera stops before filling the periphery — a built-in settle heuristic);
  deck.gl `maxRequests` (6) + `debounceTime` (queue tile requests until N ms quiet,
  "to reduce bandwidth during interactive view transitions").

### 2.5 Interaction-aware graphics LOD

- **Interactive-vs-still tiers** — VTK `vtkRenderWindow::SetDesiredUpdateRate` raises
  the target FPS during interaction (picks a cheaper `vtkLODActor` representation),
  drops to a low `StillUpdateRate` on release for the full-res frame. Progressive
  path tracers do the same: low-sample during motion, **deferred refinement pass** to
  convergence when interaction stops. This is the most directly reusable framing.
- **Predictive budget, not reactive** — Funkhouser & Séquin (SIGGRAPH 93): assign
  each object Cost (est. render time) + Benefit (screen size, accuracy, focus,
  motion), maximize benefit within a per-frame Cost budget. Crucially **estimate cost
  *before* drawing** — pure feedback control "will tend to overshoot and oscillate,
  especially on an abrupt change in detail." Combine prediction + a feedback trim.
- **Anti-popping** — Hoppe geomorphs (SIGGRAPH 96/97, smooth interpolation between
  levels over frames); **hysteresis** (different up/down thresholds so a boundary
  object can't oscillate — three.js `LOD.addLevel(obj, distance, hysteresis)`);
  cross-fade.
- **Velocity-driven degrade** — human acuity drops for fast-moving imagery; degrade
  LOD ∝ motion velocity, restore as it slows (arXiv 2301.09394). → **scrub velocity
  is a legitimate input to how coarse to go.**

### 2.6 Scheduling / predictive prefetch

- **Cancel-in-flight** — `AbortController`/`AbortSignal`; RxJS `switchMap` ("only the
  latest matters"); deck.gl/MapLibre abort no-longer-visible tiles. Aggressive cancel
  saves bandwidth but causes **refetch churn** on reversal → keep a small LRU.
- **Settle detection** — trailing-edge **debounce** is the near-universal "user
  stopped" detector; idiom = *throttle a cheap preview during motion + debounce the
  expensive final load*; `requestIdleCallback` for the refinement pass (⚠ not
  Baseline — Safari disables it; needs a `setTimeout` shim).
- **Motion prediction** — **ATLAS** (Chan et al., VAST 2008) prefetches adjacent time
  ranges *in the pan direction* across >1 B records with LOD management — **the
  closest precedent for a scrubbing timeline.** ForeCache (SIGMOD 2016) combines
  momentum + hotspot models (+430% latency, +25% accuracy). All mispredict at
  reversals/abrupt stops → balance against cancellation; cold-start after a jump.
- **Priority queue under a concurrency cap** — Cesium `RequestScheduler`
  (`maximumRequests` 50, per-server 18 for HTTP/2), priority re-scored per frame,
  `RequestState.CANCELLED` via `cancelFunction`, coarse-before-fine + center-first
  ranking `(1 − dot(tileDir, camDir))·distance`. For a playhead: sort by **temporal
  distance to current time + screen distance to viewport center** — exactly STT's
  existing EDF metric.

---

## 3. What STT already had (grounding, condensed)

The four-slice grounding pass (loading coordinator, LOD, scrub/time control,
scheduler) found every primitive the SoTA prescribes already in the tree: the
`beginScrub`/`scrubTo`/`endScrub` lifecycle with the 200 ms `seekSettleMs`
debounce and gate suppression under a held thumb; `'best-available'`
parent-fallback (≤ `PARENT_FALLBACK_LEVELS` = 4) + the pinned z0..z1
`preloadOverviewTier()` spatial storyboard; **the key finding — a fully-built but
UNWIRED temporal-LOD pyramid** (`temporal_lod` metadata + `pickTemporalLodForZoom`
/ `getTileIdsInBoundsForTemporalLod`, opt-in, never on the hot path; the default
`getTileIdsInBounds` filtered LOD tiles *out*); the summary (H3/Quadbin) tier —
genuinely fewer features, auto-dispatched by `pickTierForZoom`, the model to
copy; paged zoom ∧ bbox ∧ time pruning; the shared EDF + DRR scheduler (already
ranked by temporal distance to playhead); and the auto-speed pipeline + dual-EWMA
throughput as the adaptivity template. File:line grounding walls are dropped —
the shipped code is the ground truth.

---

## 4. Gap analysis — updated 2026-07-05

Closed by the shipped Track A: **G1** (the scrubbing bit now reaches the loader:
governor → layer → `tileset.setInteractive`), **G2** (a scrub-aware policy
degrades the requested zoom via `zoomOverride`), **G3** (temporal-LOD
auto-selection wired — inert until enabled). What remains:

| # | Gap | Phase |
| :-- | :-- | :-- |
| G4 | No coarse-time preload symmetric to `preloadOverviewTier`; the fallback ladder base → temporal-LOD → summary → overview isn't fully realized. | P2 residue / P4 |
| G5 | The coarse-time aggregator only re-buckets — it does **not** reduce feature count (`tiler.rs`: "collapse 1000 points into 50 means is left as a follow-up"), so a coarse-time tile can still hold every feature in the cell — coarser in time but not guaranteed cheaper to fetch/decode. No M4/LTTB/voxel reduction in the pyramid. | P3 |
| G6 | No throughput-/velocity-driven LOD controller; no ATLAS-style scrub-velocity prefetch; no cross-fade / hysteresis tuning. | P4 |

**The essential correctness contract (G7 — held by the shipped code):** the
coarse scrub tier is **preview-only and never gates**. The scrub hold already
suppresses all gates while the thumb is down, so the coarse tier only renders in
a window where nothing gates anyway; on `endScrub → commitSeek` the governor
flushes and re-gates at the **fine** tier exactly as before — orthogonal to the
buffering state machine, the property that let it ship kill-switched.

---

## 5. Design

One new concept — an **interactive (motion) state** on the tileset — plus a
**degrade policy** mapping it to a coarser requested tier on two independent
axes; everything else reuses existing machinery. The scrub tier is *a scheduling
decision*, not a rendering hack — its own tier/sourceId in the shared scheduler,
EDF-ranked, superseded-cancelled — so the kill-switch + interactive flag give a
clean rollback (the multi-source bet, paid off again). The shape that shipped:

```
PlaybackControls ─beginScrub/endScrub + velocity─▶ PlaybackGovernor
   │ 'scrubstart'/'scrubend' · isScrubbing → layer → tileset.setInteractive()
   ▼ scrub-LOD policy (pure fn, mirrors decideAutoSpeedMultiplier):
     { isScrubbing, velocity, throughput, zoom, timeline px, span }
       → { spatialZoomDrop: N, temporalBucketMs: B | null }
   ▼ SPATIAL:  requestedZoom = clamp(zoom − N) (zoomOverride + parent-fallback + overview floor)
   ▼ TEMPORAL: pickTemporalLodForZoom + getTileIdsInBoundsForTemporalLod(B ≈ span / timeline px)
   ▼ SharedRequestScheduler (own tier/sourceId · EDF · cancel-on-supersede)
   ▼ endScrub → commitSeek → flush coarse, re-gate at FINE tier
                (cross-fade coarse↓/fine↑ · hysteresis on N and B)
```

**Bounded-resolution rule + settle/anti-pop.** Per §2.2 both depths are computed,
not hand-tuned: `B ≈ visibleSpan / timelinePixelWidth`, snapped **up** to the
coarsest `temporal_lod` level covering the requested zoom (you cannot resolve a
finer time step than the scrubber has pixels); `N` from an SSE-style target (tile
ground-resolution ≈ viewport pixel size), biased by scrub velocity (§2.5) and
throughput (the spatial analog of auto-speed's contended bound), clamped to
`[0, PARENT_FALLBACK_LEVELS]` so the parent tiles the fallback path already
fetches are the coarse target — often **zero new fetches**. Settle reuses
`seekSettleMs` (settle-commit warms the fine tier mid-drag, release commits — no
new timer). Anti-pop: keep the coarse tier resident *under* the fine tier
(ADD-style) until the fine tile lands — "disappearing detail is worse than
late-arriving detail" — with a `raster-fade`-style 200–300 ms cross-fade and
**hysteresis** on `N`/`B` so a jittery drag can't oscillate the tier.

---

## 6. Phases — Track A (P0–P2) SHIPPED, Track B (P3) + P4 OPEN

**Track A — wire-only, no build change (P0–P2) — SHIPPED 2026-07-05,
kill-switched, default OFF.** Degrade to tiers that already exist or a rebuild
opt-in produces (spatial parent/overview always present; temporal LOD when built
with `--temporal-lod`; summary when built); on settle, refine to base. **P0** —
interactive signal end-to-end: `PlaybackGovernor` exposes `isScrubbing` +
`'scrubstart'`/`'scrubend'` → layer → `tileset.setInteractive()` (establishes G1
+ the G7 preview-only contract). **P1** — spatial degrade: `spatialZoomDrop N`
fed through the existing `zoomOverride`/primary-zoom path, overview tier as
floor; `N = 0` restored on `endScrub`, `commitSeek` refines; options landed as
`ScrubLodOptions` on the tileset (packages/core). **P2** — temporal-LOD
auto-selection: capability-detects `metadata.temporal_lod`, routes through
`pickTemporalLodForZoom` + `getTileIdsInBoundsForTemporalLod(B)` while
interactive, base unchanged when absent; wired but **inert until enabled**; the
gate keeps tracking the fine base tier (G7).

**Track B / P3 — a genuinely-cheap baked scrub tier — OPEN (closes G5).** Extend
the temporal-LOD aggregator (`generate_lod_level`) to *reduce feature count*: per
(cell, coarse-bucket) keep **M4 min/max/first/last** (no level hides extrema) for
scalar/line data, or **voxel/LTTB decimation** for point clouds (reuse
`lod_home_zoom` / `adaptive_lidar_select`), with **independently-decodable**
coarse tiles (I-frame-track discipline) so any scrub instant is one cheap fetch.
New golden fixtures + `stt-validate` checks: coarse tier ⊆ base, extrema
preserved, byte-cost ≪ base. Only then is P2's temporal tier actually *cheap* —
scrubbing fast, not just correct. Track A is the storyboard bridging to it.

**P4 — coordinator-level polish (OPEN; higher risk).** Scrub-velocity prefetch
(ATLAS-style §2.6: coarse tier in the drag direction, balanced against
supersession-cancel, LRU so a reversal doesn't refetch); the predictive LOD
budget controller (Funkhouser–Séquin §2.5: fold throughput + visible-tile cost
into `N`/`B`, predict before fetching + a feedback trim — the spatial sibling of
`getAutoSpeedSuggestion`); a dedicated scheduler tier/sourceId + EDF weight;
cross-fade + hysteresis tuning; the §7 counters.

---

## 7. Measurement plan (the open browser QoE verify)

Reuse the QoE harness (`getQoeStats`, `__sttProbe.playback`) + scrub-specific
counters so "responsive" is a number, not a vibe: **scrub time-to-first-pixel**
(`scrubTo` → rendered frame reflecting the new instant; target < one 60 Hz frame
from a resident coarse tile); **fresh-frame fraction** (% of drag frames showing
data for the current instant, any tier, vs stale/blank); **bytes-during-scrub**
(should *drop* vs the base-tier churn baseline — the efficiency proof);
**settle-to-full-detail latency** (`endScrub` → fine tier resident);
**pop/oscillation count** (LOD-tier switches per scrub; hysteresis keeps it
~1–2); **no single-dataset regression** (`scrubLod` off is byte- and
behavior-identical — the rollback drill). Heavy demos: NYC taxi trips (~10 M
vertices), AV cockpit LiDAR/surfels, BIXI flowmaps.

---

## 8. Open decisions — updated for what shipping resolved

1. **Degrade axes default — RESOLVED: spatial-first.** Spatial (P1) is the
   default when `scrubLod` is enabled; temporal (P2) stays inert until enabled —
   a per-archive `--temporal-lod` rebuild question, decided after measuring.
2. **Velocity vs binary — RESOLVED: binary shipped.** `isScrubbing` on/off;
   velocity scaling only in P4 if the binary version under/over-degrades.
3. **Coarse-tier reduction algorithm (P3) — OPEN.** M4 (exact-at-pixels) vs LTTB
   (shape) vs voxel (point clouds); likely per-dataset-kind — the tiler already
   branches on geometry type.
4. **Where the policy lives — RESOLVED.** `ScrubLodOptions` on the tileset
   (packages/core) rather than a pure playback-package function.
5. **Default on or off — RESOLVED: OFF**, behind `scrubLod` + the shared-scheduler
   kill-switch until the §7 browser QoE verify passes on the heavy demos.

---

## 9. Sources

Full annotated list (with per-claim verification flags) is preserved in the research
transcript; primary anchors by domain:

- **Video/NLE motion tier:** HLS RFC 8216 `EXT-X-I-FRAMES-ONLY`/`EXT-X-I-FRAME-STREAM-INF`;
  DASH-IF `trickmode` adaptation sets; WebVTT storyboard `#xywh` sprites (Mux); Roku BIF;
  MDN WebCodecs GOP/keyframe decode-forward; ProRes/DNxHR intra-only random access.
- **Map/geo:** deck.gl `TileLayer` (`refinementStrategy`, `maxRequests`, `debounceTime`);
  MapLibre `OverscaledTileID`/retention + `raster-fade-duration`; Cesium
  `Cesium3DTileset` (SSE, `cullRequestsWhileMoving`, `foveatedTimeDelay`,
  `progressiveResolutionHeightFraction`, `skipLevelOfDetail`) + selection-algorithm
  ("Ancestor Meets SSE"/"Kicking"); quantized-mesh-1.0.
- **Interaction-aware LOD:** Funkhouser & Séquin SIGGRAPH 93 (predictive budget);
  Hoppe SIGGRAPH 96/97 (progressive meshes, geomorph, VDR); Luebke et al. *LOD for 3D
  Graphics* (taxonomy, hysteresis); VTK `SetDesiredUpdateRate` / ParaView still-vs-
  interactive; three.js `LOD`; Interruptible Rendering (Woolley/Luebke/Watson 2002 ⚠);
  Velocity-Based LOD Reduction in VR (arXiv 2301.09394).
- **Temporal LOD:** M4 (Jugel et al., PVLDB 2014); LTTB (Steinarsson 2013 ⚠) +
  MinMaxLTTB (arXiv 2305.00332); Gorilla (PVLDB 2015); Nanocubes (TVCG 2013), imMens
  (EuroVis 2013), Hashedcubes (TVCG 2017); Grafana `maxDataPoints` = panel width.
- **Scheduling/prefetch:** MDN `AbortController`/`AbortSignal`; RxJS `switchMap`;
  `requestIdleCallback` (⚠ not Baseline); Mapbox `moveend`/`idle`; ATLAS (VAST 2008);
  ForeCache (SIGMOD 2016); SCOUT (PVLDB 2012); Cesium `RequestScheduler`/`Request`.

`⚠` = residual verification caveat (see transcript): ABR "on seek" inferred from
startup behavior; FFmpeg Seeking wiki intermittently unreachable; Interruptible
Rendering confirmed as a 2002 sketch (fuller I3D 2003 paper not primary-verified);
LTTB thesis PDF 403'd (corroborated by author repo); `requestIdleCallback` Safari
support.

---

## 10. Relationship to prior work

- Builds directly on [`playback-and-loading.md`](./playback-and-loading.md) — the
  clock↔buffer coupling, `PlaybackGovernor` scrub semantics, and
  `SharedRequestScheduler` this work extends all shipped there (`86bbb0f`).
- Reuses the spatial additive-LOD / overview-tier work and `lod_home_zoom` /
  adaptive-decimation for P3's point-cloud reduction (LiDAR compression record:
  [`av-cockpit.md`](./av-cockpit.md) §3).
- The temporal-LOD pyramid P2 wires was built (unwired) in the time-model /
  rust-audit work (now recorded in [`stt-packed-format-decisions.md`](./stt-packed-format-decisions.md),
  [`../spec/time-model.md`](../spec/time-model.md)); P2 put it on the hot path.
