# Scrub-time LOD degradation — research finding + plan

> **Status: RESEARCH + PLAN (nothing built).** 2026-07-03. Investigates using the
> loading coordinator to serve a *lower level-of-detail* (temporal and/or spatial)
> while the user is actively scrubbing the timeline, then refine to full fidelity
> once the scrub settles. Pairs a 5-domain external SoTA survey (video/NLE,
> map/geo tiling, interaction-aware graphics LOD, temporal LOD, scheduling/prefetch —
> all adversarially verified against primary sources) with a four-slice codebase
> grounding pass (loading coordinator, LOD system, scrub/time control, request
> scheduler). Companion to [`playback-and-loading.md`](./playback-and-loading.md),
> which shipped the clock↔buffer coupling this builds on.

---

## 0. TL;DR

The single unifying idea across every mature interactive system is a **two-tier
architecture: a cheap "motion tier" served while the user moves, and the expensive
"settle tier" served once they stop.** Video players do it with proxy / I-frame
tracks; web maps do it with scaled parent tiles; VTK/ParaView do it with
interactive-vs-still render passes; time-series charts do it by picking a bucket
size ≈ chart-pixel-width.

**STT already has almost all the pieces** — a precise scrub lifecycle
(`beginScrub`/`scrubTo`/`endScrub`), a spatial parent-fallback + a pinned "overview"
storyboard tier, a **fully-built but unwired temporal-LOD pyramid**, a summary
(H3/Quadbin) tier, paged-directory `[t_min,t_max]`/zoom/bbox pruning, a shared EDF
+ DRR request scheduler with tiering and cancellation, a dual-EWMA throughput
sensor, and an auto-speed policy engine that is the exact template for the
adaptivity plumbing. **What is missing is policy and wiring, not machinery:**

1. the "we are scrubbing" bit never reaches the loader (it dies inside the governor);
2. LOD is chosen purely from camera zoom — nothing motion- or scrub-aware degrades it;
3. the temporal-LOD pyramid is never auto-selected in the playback hot path;
4. there is no time-coarse stand-in symmetric to the spatial overview tier;
5. the coarse-time aggregator only re-buckets — it does not yet *reduce feature
   count*, so a coarse tier isn't guaranteed cheaper to fetch/decode.

The plan is five phases, front-loaded so the first perceived-latency win ships with
**no build-format change and a hard kill-switch** (mirroring how the multi-source
scheduler shipped), then progressively adds a genuinely-cheap baked scrub tier and
coordinator-level velocity prefetch.

---

## 1. The problem

Today, dragging the timeline scrubber does this (traced end-to-end):

- `PlaybackControls` fires `governor.beginScrub()` on pointer-down, then
  `governor.scrubTo(value)` on every move plus a `seekSettleMs`-debounced
  `seekTo(value)` settle-commit; `endScrub(value)` on release
  (`packages/react/src/components/PlaybackControls.tsx:246-297`).
- `beginScrub()` freezes the clock and sets a **private** `scrubbing` flag
  (`packages/playback/src/playback-governor.ts:304, 678-682`). While it is held, no
  gate can pass and the frontier clamp is suppressed — a deliberate "no degraded
  playback under a held thumb" policy (`playback-governor.ts:413, 1239-1248`).
- `scrubTo()` is documented as "move the clock for preview — no tileset update
  storm, no fetches" (`playback-governor.ts:688-691`). **But that docstring is only
  half true:** `scrubTo → timeController.setTime` fires a `tick`, the layer's own
  tick subscription runs `_handleTimeUpdate` (throttled to ≤10 Hz wall and
  `timeWindow/20` sim, `packages/layers/src/layers/spatiotemporal-layer.ts:696-761`),
  which calls `tileset.update({ time, … })`. A large scrub jump trips the tileset's
  seek detector, which **`flushPrefetch()`es and re-runs `selectAndLoadTiles()`**
  (`packages/core/src/spatiotemporal-tileset.ts:953-996`). So a fast drag issues up
  to ~10 fresh viewport×window tile selections/sec, each flushing the last.

The net user experience on a heavy dataset (NYC taxi ~10 M vertices; AV cockpit
LiDAR/surfels): scrubbing to an unbuffered instant shows **whatever coarse tile
happens to already be resident** — the pinned z0..z1 overview if it exists, else
nothing — while the base-tier fetch for the exact viewport×instant churns and is
repeatedly superseded. There is **no deliberate coarse-tier substitution**: the
system neither drops to a cheaper spatial zoom nor to a cheaper temporal resolution
on purpose. It just waits, at full detail, for a target it keeps invalidating.

The opportunity the loading coordinator unlocks: **during the drag, deliberately
ask for less** — a coarser spatial zoom and/or a coarser temporal bucket that is
cheap enough to actually arrive within a scrub frame — then let the existing
settle-commit + gate path refine to full detail on release.

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

## 3. What STT already has (the grounding — this is the good news)

Every row below is a primitive the SoTA prescribes that **already exists in the
tree**. File:line anchors are jump targets from the current working tree.

### 3.1 A precise scrub lifecycle (SoTA §2.1 motion/settle boundary)
- `beginScrub()` / `scrubTo(time)` / `endScrub(time)` on the governor
  (`playback-governor.ts:678-711`); shared `seekSettleMs` knob (default 200 ms,
  the exact debounce window SoTA recommends); settle-commit warms the pipeline
  mid-drag, release commits (`PlaybackControls.tsx:255-297`).
- The drag brackets are exact and already suppress work: `tickHandler` and
  `evaluateGate` bail on `this.scrubbing` (`playback-governor.ts:413, 1239-1248`).

### 3.2 Spatial LOD + a storyboard tier (SoTA §2.4)
- `getZoomLevelsToLoad(zoom)` with `refinementStrategy` `'best-available'`
  (parent fallback, up to `PARENT_FALLBACK_LEVELS = 4` coarser) / `'no-overlap'`, and
  `lodMode` `'parent-fallback'`/`'additive'` (`spatiotemporal-tileset.ts:1023-1060`);
  a **`zoomOverride` prop** already exists as the requested-zoom hook
  (`spatiotemporal-layer.ts:253, 338, 1274-1293`).
- `isOversizedParent()` skips fetching a coarse parent bigger than
  `maxParentTileBytes` (default 2 MB) except at the primary display zoom
  (`spatiotemporal-tileset.ts:1072-1082`).
- **`preloadOverviewTier()`** pins z0..z1 across the **full time range**
  (`DEFAULT_OVERVIEW_MAX_ZOOM = 1`, `DEFAULT_OVERVIEW_BUDGET_BYTES = 20 MB`,
  `spatiotemporal-tileset.ts:2370`), rendered via parent-fallback "so scrubbing always
  shows something." **This is a spatial-only storyboard tier — the exact SoTA pattern,
  already half-built.**

### 3.3 A fully-built but UNWIRED temporal-LOD pyramid (SoTA §2.3) — the key finding
- Metadata: `temporal_lod: Option<Vec<TemporalLodLevel { bucket_ms, max_zoom_level }>>`
  (`crates/stt-core/src/metadata.rs:206-260`), with a zoom→level selector
  `Metadata::temporal_lod_for_zoom(zoom)` returning the coarsest level covering that
  zoom (`metadata.rs:367-373`), surfaced in TileJSON (`metadata.rs:461-466`).
- Build: `generate_tiles_with_lod` / `generate_lod_level` re-bucket features at each
  coarser `bucket_ms` and clamp `max_zoom` (`crates/stt-build/src/tiler.rs:241-327`);
  CLI `--temporal-lod`. **Caveat (`tiler.rs:288-290`): the aggregator only
  re-buckets — it does NOT yet reduce feature count** ("collapse 1000 points into 50
  means is left as a follow-up"). So a coarse-time tile can still hold every feature
  in the cell — coarser in time but not necessarily cheaper to fetch/decode.
- Client reader API exists: `STTArchive.pickTemporalLodForZoom(zoom)` (`archive.ts:2254`)
  + `getTileIdsInBoundsForTemporalLod(bounds, zoom, timeRange, bucketMs)`
  (`archive.ts:2119`). **But it is opt-in and never called from the tileset/layer hot
  path** — the default `getTileIdsInBounds` actively *filters LOD tiles out*
  (`archive.ts:2081-2092`). Contrast the spatial summary tier, which IS auto-dispatched.

### 3.4 A summary (H3/Quadbin) tier — genuinely fewer features (SoTA §2.3 cubes)
- `SummaryTier { scheme, cell_resolution_per_zoom, sub_buckets, … }`
  (`metadata.rs:38-90`), built by `summary.rs`, auto-dispatched client-side by
  `pickTierForZoom(zoom)` → `tier: 'raw'|'summary'|'auto'`
  (`spatiotemporal-tileset.ts:803-814`). `sub_buckets` gives per-cell intra-tile time
  samples ("switch which column drives per-cell colour — zero re-upload between
  frames"). **This is the one existing tier that genuinely reduces feature count**,
  and it already auto-selects by zoom — the model to copy for temporal-LOD.

### 3.5 Paged-directory pre-fetch selectivity (SoTA §2.4 deferred loading)
- `PageDescriptor::overlaps(zoom, bbox, t_start, t_end)` prunes whole leaf pages by
  zoom ∧ bbox ∧ `[t_min,t_max]` before any download
  (`crates/stt-core/src/directory_page.rs:100-118`); TS mirror `ensurePagesForBounds`
  applies the identical 3-way prune (`archive.ts:1318-1338`). A scrub to a far time
  already prunes leaves cheaply — the selectivity a coarse-time preload needs is present.

### 3.6 A shared EDF + DRR scheduler with tiering & cancellation (SoTA §2.6)
- `SharedRequestScheduler` (`packages/core/src/request-scheduler.ts`): global
  `maxRequests` (24), loaders.gl `done()` handshake, `priority < 0` cancels,
  Cesium-style priority re-evaluated at dispatch, deficit-round-robin weighted fairness.
- Priority value `groupSchedulerPriority = tierBase(prefetch +1e15) + timeToPlayhead
  (EDF) + spatialTieBreak` (`archive.ts:1555-1575`) — **already the "temporal distance
  to playhead + screen distance to center" ranking SoTA prescribes.** A scrub tier
  slots in as another tier / sourceId.
- Cancellation is fully in place: negative-priority drop, `abortSource(id)`,
  tier-aware `cancelSupersededRequests` (`spatiotemporal-tileset.ts:2026-2084`),
  `flushPrefetch` (`:2296-2335`).

### 3.7 The adaptivity template + sensors (SoTA §2.5 predictive budget)
- **Auto-speed is the exact plumbing pattern to copy:**
  `governor.getAutoSpeedSuggestion()` (contended max sustainable speed from byte cost
  ÷ throughput, `playback-governor.ts:897-982`) → `decideAutoSpeedMultiplier`
  (asymmetric ABR policy: immediate downshift, damped upshift past a 25 % deadband,
  snap to a ladder, `auto-speed.ts:67-93`) → applied on a 5 s cadence + on the
  governor `'waiting'` event (`use-playback.ts:305-330`). A scrub-LOD policy mirrors
  this shape exactly: **signal = isScrubbing / scrub velocity / throughput; action =
  LOD-degrade depth.**
- Sensor: dual-EWMA throughput (`throughput.ts`, 3 s/9 s, `min(fast,slow)`), already
  wired into the tileset via `getThroughput` and `prefetchSliceBytes`.
- Precedent for degrading-under-load: **degraded creep** pins the playhead to the
  data-arrival frontier (`playback-governor.ts:1300-1354`) — degrades temporal
  smoothness today; a spatial/temporal-LOD degrade is the missing sibling.

---

## 4. Gap analysis — what actually has to be built

Mapped to the phases in §6.

| # | Gap | Where | Phase |
| :-- | :-- | :-- | :-- |
| G1 | The `scrubbing`/interactive bit never reaches the loader — it dies in the governor; the tileset only sees `setTime` + `setAnimationState(isAnimating, speed)`. | `playback-governor.ts:304`; `spatiotemporal-tileset.ts:876-914` | P0 |
| G2 | LOD is chosen purely from camera zoom; nothing motion/scrub/velocity-aware degrades the requested zoom. `zoomOverride` exists but nothing drives it from playback state. | `spatiotemporal-tileset.ts:1023-1060`, `spatiotemporal-layer.ts:1274-1293` | P1 |
| G3 | The temporal-LOD pyramid is never auto-selected in the hot path; `getAvailableTiles` → base `getTileIdsInBounds`, which excludes LOD tiles. The zoom→level selector exists but is unused in playback. | `archive.ts:2072-2151, 2254-2265` | P2 |
| G4 | No time-coarse stand-in symmetric to the spatial overview; `preloadOverviewTier` coarsens space only. No fallback *ladder* base → temporal-LOD → summary → overview. | `spatiotemporal-tileset.ts:2370` | P2/P4 |
| G5 | The coarse-time aggregator only re-buckets — it does not reduce feature count, so a coarse tier isn't guaranteed cheaper. No M4/LTTB/voxel reduction in the pyramid. | `tiler.rs:288-290` | P3 |
| G6 | No throughput-/velocity-driven quality controller for LOD (the spatial analog of `getAutoSpeedSuggestion`); no scrub-velocity prefetch (ATLAS-style); no LOD cross-fade / hysteresis. | new | P4 |
| G7 | `getBufferedRunway`/gate math is "honest about the PRIMARY zoom." If the requested tier is degraded during scrub, we must ensure the gate on **release** re-arms against the *fine* tier, not the coarse one. | `spatiotemporal-tileset.ts:2111, 2358-2362` | P0/P2 (contract) |

**The essential correctness contract (G7):** the coarse scrub tier is
**preview-only and never gates**. Because the scrub hold already suppresses all
gates while the thumb is down (§3.1), the coarse tier only ever renders during a
window where nothing gates anyway. On `endScrub → commitSeek`, the governor flushes
and re-gates at the **fine** tier exactly as today. This keeps the whole feature
orthogonal to the buffering state machine — the same property that let the
multi-source scheduler ship behind a kill-switch.

---

## 5. Design

### 5.1 Shape: an "interactive tier" driven by the loading coordinator

Introduce one new concept — an **interactive (motion) state** on the tileset — and a
**degrade policy** that maps it to a coarser requested tier on two independent axes.
Everything else reuses existing machinery.

```
   PlaybackControls  ──beginScrub/endScrub──▶  PlaybackGovernor
        (drag UI)          + scrub velocity       │  emits 'scrubstart'/'scrubend'
                                                   │  exposes  get isScrubbing()
                                                   ▼
                              layer  ──▶  tileset.setInteractive(true, {velocityHz})
                                                   │
                                     ScrubLodPolicy (pure fn, mirrors decideAutoSpeedMultiplier)
                                       in:  isScrubbing, scrubVelocity, throughput bytesPerMs,
                                            viewport zoom, timeline pixel-width, span
                                       out: { spatialZoomDrop: N, temporalBucketMs: B | null }
                                                   │
                     ┌─────────────────────────────┴─────────────────────────────┐
             SPATIAL axis                                              TEMPORAL axis
   requestedZoom = clamp(zoom − N)                     getAvailableTiles → pickTemporalLodForZoom
   (reuses zoomOverride + parent-fallback +            + getTileIdsInBoundsForTemporalLod(B)
    the pinned overview tier)                          (bucket B ≈ span / timeline-pixel-width)
                                                   │
                              SharedRequestScheduler — coarse tier as its own tier/sourceId
                              (EDF by time-to-playhead, cancel-on-supersede, done())
                                                   │
                              endScrub → commitSeek → flush coarse, re-gate at FINE tier
                                          (cross-fade coarse↓ / fine↑, hysteresis on N and B)
```

### 5.2 The bounded-resolution rule (deterministic, not a guess)

Per SoTA §2.2, both degrade depths are computed, not tuned by hand:

- **Temporal bucket** `B ≈ visibleSpan / timelinePixelWidth`, then snapped **up** to
  the coarsest available `temporal_lod` level whose `max_zoom_level ≥ requestedZoom`
  (`pickTemporalLodForZoom` already does the snap). Rationale: you cannot resolve a
  finer time step than the scrubber has pixels, so fetching base-resolution time
  during a drag is pure waste.
- **Spatial zoom drop** `N`: start from an SSE-style target (drop until a tile's
  ground-resolution ≈ viewport pixel size), then bias by **scrub velocity** (faster
  drag → larger `N`, per §2.5 velocity-driven degrade) and by **throughput**
  (`bytesPerMs` low → larger `N`, the spatial analog of auto-speed's contended bound).
  Clamp `N` to `[0, PARENT_FALLBACK_LEVELS]` so the parent tiles the fallback path
  already fetches are the coarse target — often **zero new fetches**.

### 5.3 Settle & anti-pop (SoTA §2.1, §2.5)

- **Settle** reuses `seekSettleMs` — the debounce already lives in `PlaybackControls`;
  the settle-commit warms the fine tier mid-drag, release commits it. No new timer.
- **Anti-pop**: keep the coarse tier resident *under* the fine tier (ADD-style, not
  REPLACE) until the fine tile is loaded — "disappearing detail is worse than
  late-arriving detail." Cross-fade via the existing time-filter alpha / a
  `raster-fade`-style 200–300 ms blend. Apply **hysteresis** to `N` and `B` (different
  thresholds to deepen vs recover) so a jittery drag can't oscillate the tier — the
  same idea as the existing `DIRECTION_FLIP_THRESHOLD = 3` frames and three.js LOD
  hysteresis.

### 5.4 Two implementation tracks for the "cheap tier"

**Track A — wire-only, no build change (P0–P2).** Use tiers that already exist or
that a rebuild opt-in produces: spatial parent/overview (always present) + temporal
LOD (present when built with `--temporal-lod`) + summary (present when built). During
scrub, degrade to these; on settle, refine to base. Ships immediately, kill-switched.

**Track B — a genuinely-cheap baked scrub tier (P3).** Close G5: extend the
temporal-LOD aggregator to *reduce feature count*, following the SoTA algorithms —
per (cell, coarse-bucket) keep **M4 min/max/first/last** (so no level hides extrema)
for scalar/line data, or **voxel/LTTB decimation** for point clouds (STT already has
`lod_home_zoom` / `adaptive_lidar_select` — reuse them per coarse bucket). Enforce the
**independently-decodable** discipline (each coarse tile self-contained, like an
I-frame track) so any scrub instant is one cheap fetch. This is the real "motion
tier"; Track A is the storyboard that bridges to it.

### 5.5 Why the coordinator is the right enforcement point

The request scheduler is already the single authority over what gets fetched, in what
order, with cancellation (§3.6). Making the scrub tier *a scheduling decision* (its
own tier + sourceId, EDF-ranked, superseded-cancelled) rather than a rendering hack
means: (a) coarse scrub fetches automatically rank against everything else on one
playhead; (b) a scrub that ends mid-flight cancels cleanly via existing
supersession/`abortSource`; (c) the kill-switch (`configureSharedScheduler`) and the
interactive flag together give a clean rollback. This is the same architectural bet
the multi-source work made and it paid off.

---

## 6. Phased plan

Front-loaded like the multi-source rollout: the first perceived win ships with **no
format change and a hard kill-switch**; format/aggregator work comes only after the
wire-only version proves the UX.

### P0 — Surface the interactive/scrub signal end-to-end *(low risk, no behavior change)*
- Add `get isScrubbing()` to `PlaybackGovernor` (expose the private flag) and emit
  `'scrubstart'`/`'scrubend'` on its existing event bus; mirror through `SttPlayer`
  and `usePlayback` / `PlaybackState`.
- Add `SpatiotemporalTileset.setInteractive(interactive: boolean, opts?: { velocityHz })`
  — stored state only, no selection change yet. Drive it from the layer on
  scrubstart/scrubend. Optionally carry scrub velocity from `PlaybackControls`
  (`Δvalue/Δt` across `scrubTo` calls).
- **Ship as pure plumbing**, verified by a test asserting the bit propagates. Nothing
  degrades yet. Establishes G1 + the G7 contract (interactive tier will be
  preview-only; gate stays fine-tier).

### P1 — Spatial LOD degrade during scrub *(Track A; no build change; kill-switched)*
- A `ScrubLodPolicy` pure function (mirroring `decideAutoSpeedMultiplier`) computes
  `spatialZoomDrop N` from `isScrubbing` + velocity + throughput + viewport zoom
  (§5.2), clamped to `[0, PARENT_FALLBACK_LEVELS]`.
- While interactive, feed `requestedZoom = clamp(zoom − N)` into selection (the
  existing `zoomOverride`/primary-zoom path). Lean on the already-pinned overview
  tier as the floor. On `endScrub`, restore `N = 0` and let `commitSeek` refine.
- Anti-pop + hysteresis (§5.3). Flag: `scrubLod: { spatial?: boolean }`, default off.
- **This is the immediate win** — a fast drag on a heavy dataset renders a crisp
  coarse-zoom preview from tiles that are largely already resident, instead of
  churning the base tier. Measure before widening.

### P2 — Wire temporal-LOD auto-selection during scrub *(Track A; needs `--temporal-lod` archives)*
- Capability-detect `metadata.temporal_lod`. When present AND interactive, route
  `getAvailableTiles` through `pickTemporalLodForZoom` +
  `getTileIdsInBoundsForTemporalLod(B)` with `B` from §5.2; else fall back to base
  (unchanged). This is the temporal analog of the existing `pickTierForZoom` dispatch.
- Add a **coarse-time preload** symmetric to `preloadOverviewTier`: pin the coarsest
  `temporal_lod` tier for the current viewport across the visible span, pruned cheaply
  by the paged `[t_min,t_max]` descriptors (§3.5) — a time storyboard (G4).
- Define the **fallback ladder**: base → temporal-LOD → summary → spatial-overview;
  render the first resident tier, refine downward on settle (SoTA "best-available" on
  the time axis).
- Contract check (G7): the temporal tier is preview-only; `getBufferedRunway`/gate
  keep tracking the fine base tier so release re-gates honestly.

### P3 — A genuinely-cheap baked scrub tier *(Track B; build-format work; closes G5)*
- Extend `generate_lod_level` to reduce feature count per (cell, coarse-bucket):
  **M4 min/max/first/last** for scalar/line fields; **voxel/LTTB decimation** for
  point clouds (reuse `lod_home_zoom` / `adaptive_lidar_select`). Store
  min/max/count so no coarse level hides extrema (SoTA §2.3).
- Enforce **independently-decodable** coarse tiles (I-frame-track discipline).
- New golden fixtures + `stt-validate` checks (coarse tier ⊆ base, extrema preserved,
  byte-cost ≪ base). Now P2's temporal tier is actually cheap → scrubbing is fast,
  not just correct.

### P4 — Coordinator-level polish: velocity prefetch, budget controller, cross-fade *(higher risk)*
- **Scrub-velocity prefetch (ATLAS-style, §2.6):** during a sustained drag, prefetch
  the coarse tier for the next time window in the drag direction; balance against
  supersession-cancel of overshoot; keep the existing LRU so a reversal doesn't refetch.
- **LOD budget controller** (§2.5, Funkhouser–Séquin *predictive*): fold throughput +
  visible-tile cost into `N`/`B` so the degrade depth tracks the network — the spatial
  sibling of `getAutoSpeedSuggestion`. Predict cost before fetching; add a feedback trim.
- Give the scrub tier its own scheduler tier/sourceId + EDF weight (§3.6) so it ranks
  correctly against playback prefetch on a shared playhead.
- Full cross-fade + hysteresis tuning; wire QoE counters (§7).

---

## 7. Measurement plan

Reuse the QoE harness (`getQoeStats`, `__sttProbe.playback`) and add scrub-specific
counters so "responsive" is a number, not a vibe:

- **Scrub time-to-first-pixel** — wall-ms from `scrubTo` to a rendered frame reflecting
  the new instant (target: < one 60 Hz frame from a resident coarse tier).
- **Scrub fresh-frame fraction** — % of drag frames showing data for the current
  instant (any tier) vs stale/blank.
- **Bytes-during-scrub** — should *drop* vs the base-tier churn baseline (fewer,
  coarser fetches), the efficiency proof.
- **Settle-to-full-detail latency** — `endScrub` → fine tier resident.
- **Pop/oscillation count** — LOD-tier switches per scrub (hysteresis keeps it ~1–2).
- **No single-dataset regression** — a demo with `scrubLod` off is byte- and
  behavior-identical (the multi-source rollback drill).

Heavy demos to profile: NYC taxi trips (~10 M vertices), AV cockpit LiDAR/surfels,
BIXI flowmaps.

---

## 8. Open decisions

1. **Degrade axes default** — spatial-only, temporal-only, or both? Spatial (P1) is
   the cheapest win and needs no rebuild; temporal (P2) needs `--temporal-lod`
   archives. Recommend: ship P0+P1 first, measure, then decide whether temporal is
   worth the fleet rebuild.
2. **Velocity vs binary** — is `isScrubbing` (on/off) enough, or is scrub-velocity
   scaling worth the extra signal plumbing? Start binary; add velocity in P4 if the
   binary version under/over-degrades.
3. **Coarse-tier reduction algorithm** (P3) — M4 (exact-at-pixels, line-oriented) vs
   LTTB (shape) vs voxel (point clouds). Likely per-dataset-kind; the tiler already
   branches on geometry type.
4. **Where the policy lives** — a pure `@poopdeck.gl/playback` function (like
   `decideAutoSpeedMultiplier`) consumed by the layer, vs inside the tileset. Recommend
   the former for testability and to keep the tileset dumb.
5. **Default on or off** — recommend **off** behind `scrubLod` + the shared-scheduler
   kill-switch until browser-verified on the heavy demos, then flip after measuring.

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
  `SharedRequestScheduler` this plan extends all shipped there (`86bbb0f`).
- Reuses the spatial additive-LOD / overview-tier work
  ([`av-lidar-compression.md`](./av-lidar-compression.md) and the zoom-LOD effort) and
  the `lod_home_zoom` / adaptive-decimation primitives for P3's point-cloud reduction.
- The temporal-LOD pyramid it wires was built (unwired) as part of the time-model /
  rust-audit work ([`rust-audit-2026-06.md`](./rust-audit-2026-06.md),
  [`../spec/time-model.md`](../spec/time-model.md)); this plan is what finally puts it
  on the playback hot path.
