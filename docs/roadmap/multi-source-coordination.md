# Multi-Source Coordination — Research + Implementation Plan

**Status:** SHIPPED (uncommitted, branch `feat/multi-source-coordination`) — **pending browser verify**. Design 2026-06-18; implemented 2026-06-19.
**Problem:** A story/demo may composite **N arbitrary STT datasets of mixed/arbitrary intensity** — possibly *several heavy ones*, not just one heavy field + light overlays. Today timing is coordinated but loading is not, and the playback gate trusts a single source. We want loading + timing coordinated across N sources so the shared playhead never (a) stalls on the lightest source nor (b) races ahead of a heavy one it didn't wait for.

This doc pairs an external SoTA deep-research pass (MSE/DASH, multi-stream ABR, Cesium/loaders.gl, GStreamer, game engines — cited below) with a codebase grounding pass, and lands a phased plan.

---

## 1. Where we are today (codebase grounding)

| Primitive | Today | File |
|---|---|---|
| **Master clock** | `TimeController` — dumb rAF loop, drives all layers in lock-step, never consults the loader | `packages/playback/src/time-controller.ts` |
| **Gate** | `PlaybackGovernor` holds **exactly one** `private source: BufferSource \| null` (line 227); *every* readiness read is singular | `packages/playback/src/playback-governor.ts` |
| **Per-source scalar** | `getBufferedRunway(t,dir) → {simMs, bytesPending, horizonSimMs, complete}` — sim-time ahead of playhead, denominated wall-ms × speed | `packages/core/src/spatiotemporal-tileset.ts:1891` |
| **Honest ETA** | `estimateTimeToReadyMs = cost.bytes / throughput`; `estimateCost` = pure directory byte/tile sum (no network) | tileset `:2020`, `:2055` |
| **Throughput** | dual-EWMA estimator in `STTArchive` (3 s/9 s, `min(fast,slow)`) | `packages/core/src/throughput.ts` |
| **Request pool** | **per-instance.** `STTArchive.maxConcurrentRequests` (default 24) + an in-flight cursor runner (`archive.ts:1577-1593`). **No `static` scheduler anywhere.** | `packages/core/src/archive.ts` |
| **Priority signal** | `fetchPriority` flows layer→archive end-to-end; within a tileset, queue is drained nearest-playhead-first | tileset `:1535` |
| **Degraded creep** | governor pins playhead to the buffered frontier and advances at data-arrival rate when the start gate times out — *an OR-style play-through-degraded mechanism, but single-source* | governor `:909` |
| **Required/optional** | implicit only — the `onTilesetReady`/`onBufferChange` plumbing-strip in `buildDemoLayers.ts:529` (field wired, overlays nulled) | showcase |

**Two concrete gaps:**
1. **Gate is single-source.** In the radar demo, field is `required`, tracks+cells stream **ungated** — if an overlay can't keep up, the playhead advances past data it hasn't buffered. Fine while overlays are sparse/cheap; **breaks the moment two genuinely heavy datasets are composited.**
2. **Loading is uncoordinated.** N tilesets each open up to 24 concurrent range requests and **fight for bandwidth with zero shared budget, priority, or fairness.**

---

## 2. What the SoTA says (deep-research, cited + adversarially verified)

Five domains converge on **one coherent architecture**. Confidence + vote tallies are from 3-vote adversarial verification.

### 2.1 Combined buffer health = weakest-link / min over *required* sources — `high`, 3-0
The canonical default. **MSE** computes `HAVE_ENOUGH_DATA` only when buffered coverage exists "for ALL objects in `activeSourceBuffers`"; it stalls (`HAVE_CURRENT_DATA`) the moment *one* active buffer lacks data after the playhead. The current spec defines `HTMLMediaElement.buffered` as the **intersection** of all active `SourceBuffer.buffered` ranges. → **Gate on `min(getBufferedRunway)` across required sources; `complete` = AND of `complete`.**
- Sources: [W3C public-html-media 2014Jul/0032](https://lists.w3.org/Archives/Public/public-html-media/2014Jul/0032.html), [MSE 2 spec](https://www.w3.org/TR/media-source-2/)

### 2.2 Naive `min()` MISFIRES on fractionally-different horizons — `high`, 3-0
**W3C Bug 26436 (RESOLVED FIXED):** raw min-gating "causes playback to stall … when 2 or more SourceBuffers of fractionally different buffered lengths are active," and "it is exceedingly unlikely that streams of different types will have exactly the same duration." → **Different temporal chunking/cadence means runway horizons never align exactly; a raw `min()` spuriously stalls. Needs a tolerance band / gap-coalescing.** This is the single most important caveat for *arbitrary* sources.
- Sources: same as 2.1

### 2.3 The graceful-degradation menu (AND vs OR vs keep-running) — `high`, 2-1
MSE issue #160 (spec co-editor) lists exactly: **(a)** seek/wait to the next point where **all** active sources are buffered (AND gating); **(b)** seek to earliest where **any** source has data and play silence/last-frame for laggards (OR gating); **(c)** keep the clock running at `playbackRate`, degrade laggards. → **required → AND-gate; optional → OR-gate / continue-and-degrade.** STT's existing degraded-creep is option (c) for one source.
- Sources: [w3c/media-source#160](https://github.com/w3c/media-source/issues/160), [W3C Media WG minutes 2019-09-19](https://www.w3.org/wiki/Media/Group/Minutes/2019-09-19)

### 2.4 Required-vs-optional = a per-source `blocking` flag — `high`, 2-1 *(PROPOSED, not standardized)*
MSE proposal (Oct 2025): a **blocking** active source always triggers a waiting/stall event on underflow; a **non-blocking** one never does; inactive sources never block. → **First-class `required` flag per source decides inclusion in the min-gate.** Treat as design direction (dash.js production workaround today is `playbackRate=0` + fake waiting event), but it validates the seam.
- Source: [w3c/media-source#160](https://github.com/w3c/media-source/issues/160)

### 2.5 Independent per-source loading IS the failure mode; shared global view wins — `high`/`medium`, 2-1
"The client-driven scheme of DASH does not consider the status of the other clients and tries to occupy the available bandwidth … This greedy characteristic causes bandwidth starvation … leading to QoE degradation and unfair QoE" (corroborated by TFDASH/FAURAS/FESTIVE). An ablation adding a server-provided global view to per-stream decisions gave **+10 % fairness, +8 % efficiency** (medium — single 2022 sim). → **Replace independent per-source pools with one shared scheduler; the shared view measurably beats independent.**
- Sources: [QoE-Fair DASH (ACM TOMM 2020)](https://doi.org/10.1145/3397227), [Future Internet 14(5) 152](https://www.mdpi.com/1999-5903/14/5/152)

### 2.6 Divide a fixed budget by per-source WEIGHT, not hard caps (WFQ) — `high`, 3-0
Weighted Fair Queuing gives each source its weighted share over time, is **work-conserving** (an idle source's budget is reclaimed and redistributed), and needs no control plane tuning caps. Priorities map to weights (illustrative: P1=3.0, P2=1.5, P3=0.75, P4=0.375 — each level halves). Separate a **managed/weighted (gating)** tier from a **best-effort** tier — the bandwidth analog of required-vs-optional. *Caveat: WFQ is packet-granularity; STT is discrete concurrency-slot granularity — sound analogy, constants illustrative.*
- Sources: [US10104413B2](https://patents.google.com/patent/US10104413B2/en)

### 2.7 Rank-and-redistribute; centralized authority overrides local greed — `high`, 3-0
SDN approach: rank each source from `α·(buffer/bufferMax) + β·(rate/rateMax)`, take a fraction of the highest-ranked source's bandwidth and give to another, balancing **efficiency / fairness / stability**. Centralized controllers enforce per-source rate by rewriting manifests. → **The shared scheduler is the authority over per-source loading; rank required sources by how far each is from its gate and feed the laggard first.**
- Sources: [ASTESJ v06i01p21](https://www.astesj.com/v06/i01/p21/), [QoE-Fair DASH](https://doi.org/10.1145/3397227)

### 2.8 Shared scheduler primitives: global `maxRequests` + `done()` handshake + dynamic re-prioritization + cancel — `high`, 3-0
**loaders.gl `RequestScheduler`:** `maxRequests` ("additional requests are queued until an open request has completed"; default 6, Tileset3D uses 64); on completion **or failure** the caller must call `done()` to free the slot; a `getPriority` callback "is called when request slots open up, allowing the caller to update priority or cancel the request. Highest priority executes first, **priority < 0 cancels**." **Cesium:** "Priority is a unit-less value where lower values represent higher priority … usually the distance from the camera"; `priorityFunction` runs **once per frame**, the queue heap is re-sorted, highest-priority popped first. → **Distance-from-camera is the direct analog of time-to-playhead. Set each tile's priority = time-to-playhead, re-evaluate per frame as the playhead moves, cancel tiles the playhead passed (negative priority) = earliest-deadline-first.**
- Sources: [loaders.gl RequestScheduler](https://loaders.gl/docs/modules/loader-utils/api-reference/request-scheduler), [Cesium Request](https://cesium.com/learn/cesiumjs/ref-doc/Request.html), [Cesium RequestScheduler src](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/RequestScheduler.js)

### 2.9 BOLA: a per-source buffer-level scalar is the gate, but add a throughput floor at cold start — `high`, 3-0
BOLA reduces buffer-based ABR to buffer-level thresholds (buffer in **seconds-ahead**); "does not require prediction of available network bandwidth" in steady state, within `O(1/V)` of optimal. **But** pure buffer-only gating behaves poorly at cold-start/after-seek (empty buffer) — production dash.js uses a throughput floor at low buffer, BOLA at high. → **`getBufferedRunway().simMs` (seconds-ahead) is the comparable per-source scalar gate; augment with a throughput-based startup floor.**
- Sources: [BOLA (arXiv 1601.06748)](https://arxiv.org/abs/1601.06748), [BOLA IEEE/ACM ToN PDF](https://groups.cs.umass.edu/wp-content/uploads/sites/3/2020/07/09110784.pdf)

### 2.10 Refuted — DO NOT adopt (each 0-3)
- **Combined health via MAX end-time** across buffers to make horizons comparable — **wrong**; MSE uses **intersection/min**, the opposite.
- **App-provided sub-second buffered-gap tolerance is a standard MSE mechanism** — **not real**; exists only as discussion / per-engine heuristics (hls.js gap-skip). **We must implement the tolerance band ourselves** (ties back to 2.2).
- **Buffer occupancy alone is a sufficient statistic with no throughput estimate** — **insufficient**; fails at cold-start (see 2.9).

---

## 3. The lucky part: STT already has most of the hard primitives

| SoTA mechanism | STT status |
|---|---|
| Master clock | ✅ `TimeController` |
| Per-source seconds-ahead scalar gate (BOLA) | ✅ `getBufferedRunway().simMs` (already wall-ms × speed) |
| "Never stall on a finished source" | ✅ `runway.complete` |
| Honest deadline/ETA for EDF | ✅✅ `estimateTimeToReadyMs` = `cost.bytes / throughput` — **better than video**: the v5 directory stores every tile's `(timeStart, timeEnd, length)`, so time-to-playhead deadlines are *exact*, not estimated |
| Throughput floor for cold-start | ✅ dual-EWMA estimator already exists |
| Dynamic priority signal | ◑ `fetchPriority` end-to-end + nearest-playhead sort, but **within** a tileset only |
| Continue-and-degrade (OR option c) | ◑ degraded creep exists, **single-source** |
| Combined min-gate across N | ❌ governor holds 1 source |
| Required/optional flag | ❌ implicit (plumbing-strip) |
| Cadence tolerance band | ❌ |
| Shared global scheduler (budget/priority/fairness) | ❌ per-instance pools |

**So the work is: (1) generalize the gate to a fold over N classified sources, (2) hoist the per-instance pool to one shared EDF+weighted scheduler. The contracts (`BufferSource`, `BufferedRunway`) need essentially no change — only the *aggregation over a set* is new.**

---

## 4. Recommended architecture

```
                    TimeController (master clock — unchanged)
                          │  play/stall/seek
                    PlaybackGovernor  ──────────── holds Map<id,{source,required,weight}>
                          │                         gate = min(runway) over REQUIRED, with tolerance band
                          │                         complete = AND(complete) over REQUIRED
                          │                         ETA = max, cost = Σ, autoSpeed = min sustainable
                          │ priority hints (playhead, dir, per-source deficit-to-gate)
                    SharedRequestScheduler (NEW singleton)
                          │  global maxRequests budget · EDF by time-to-playhead
                          │  weighted-fair slot share · work-conserving · done() handshake · cancel<0
        ┌─────────────────┼─────────────────┐
   archive A          archive B          archive C      (each enqueues instead of running its own runner)
   (required)         (required)         (optional)
```

Two design rules fall straight out of the research:
- **Gate on `min` over *required* sources, with a tolerance band** (2.1 + 2.2). Optional sources never gate — they continue-and-degrade (2.3, option c, which STT already does via creep).
- **One scheduler is the authority** (2.5, 2.7). Priority = **EDF on exact time-to-playhead** (2.8/2.9), with **required sources below their gate promoted** (rank-and-redistribute, 2.7) and **weighted-fair slot sharing** so no required source starves another (2.6). Optional = best-effort tier.

---

## 5. Phased implementation plan

Ordered to ship the **correctness fix cheaply first**, then the **bandwidth win**. Phases 0–1 are governor-local + wiring (low risk); Phase 2 touches the archive hot path (higher risk) and is the real multi-heavy-dataset payoff.

### Phase 0 — N-source registry + required/optional classification *(the actual correctness fix)*
**Goal:** the clock waits for every *required* source, not just one.
- `PlaybackGovernor`: replace `private source` with `private sources: Map<string, {source: BufferSource; required: boolean; weight: number}>`. Add `addSource(id, source, {required=true, weight=1})` / `removeSource(id)`; keep `setSource(s)` as a one-source back-compat shim (`addSource('default', s, {required:true})`).
- Fold every singular read (grounding listed them): `evaluateGate`/`checkLowWatermark`/`refreshFrontier` → **min `simMs` + AND `complete`** over required; `predictsPlaythrough` → **max** `estimateTimeToReadyMs`; `getEtaMs` → max; `estimateCost` → sum; `getBufferedRanges` → per-source (for a multi-track bar) or intersection; `bufferedUntil` → nearest required frontier.
- Broadcast side-effects to **all** sources: `enterGate`'s `setAnimationState(true,speed)`, `requestPause`'s `setAnimationState(false,0)`, `commitSeek`/`wrapHandler` `flushPrefetch()`.
- Wiring: `buildDemoLayers` passes `onTilesetReady`/`onBufferChange` to **all** layers; each layer carries a `required` flag (radar: field=required, tracks/cells=optional). App calls `addSource(layerId, tileset, {required})` per layer instead of `setSource` for only the field.
- **Tests:** unit-test the fold math with a mock multi-source `BufferSource` (min/AND/max/sum). Add a regression case: two required sources, one lagging → clock holds at the laggard's frontier.
- **Risk:** low, fully inside `packages/playback`. **Delivers:** correct timing coordination for arbitrary required sources.

### Phase 1 — Cadence tolerance band *(stop spurious stalls — the W3C Bug 26436 lesson)*
**Goal:** sources with different temporal chunking don't stall each other on fractional horizon differences.
- Add `runwayToleranceMs` (per-source or global). The min-gate treats a source as starved only when its runway drops below `lowWatermark − tolerance`; coalesce sub-tolerance gaps before the AND. (We *must* implement this — it is **not** an inherited standard; see refuted 2.10.)
- Confirm the sparse-source case is already safe: `getBufferedRunway` walks the coverage index and only stops at a **needed-but-not-loaded** bucket, so a source with *no data* in a region reports a long/complete runway and won't falsely gate. Add a test pinning this.
- **Risk:** low. **Delivers:** robustness for *arbitrary* cadence mixes (the user's "arbitrary intensity" requirement).

> **MVP cut:** Phases 0+1 alone make N required sources play correctly in lock-step without false stalls. If the composited heavy datasets are few and bandwidth isn't yet the bottleneck, this may be enough — ship and measure before Phase 2.

### Phase 2 — Shared request scheduler *(the loading-coordination win)*
**Goal:** N heavy datasets share one budget instead of each grabbing 24 connections.
- New `SharedRequestScheduler` singleton (loaders.gl pattern, 2.8): global `maxRequests` (~24–32 total, replacing per-archive 24), priority-ordered queue, `done()` handshake on completion **or failure**, dynamic re-prioritization, **negative-priority cancellation** for tiles the playhead has passed.
- Hoist point: the archive's in-flight cursor runner (`archive.ts:1577-1593`) and the paged-page fetcher enqueue into the shared scheduler instead of running their own `limit`-runner. (Tileset-level `processRequestQueue` tier ordering stays; bandwidth contention is at the HTTP layer.)
- **Priority function** (re-evaluated per frame / per slot-free, lower = higher):
  1. **required source below its gate** → top class, ordered by **deficit-to-gate** (rank-and-redistribute, 2.7);
  2. then **EDF on exact time-to-playhead** (2.8) — STT can compute this precisely from the v5 directory;
  3. then optional/best-effort.
- **Weighted-fair slot share** over discrete slots via **deficit round-robin** so a heavy required source can't monopolize all slots and starve a light required one below its gating need; work-conserving (idle source's slots reclaimed — 2.6).
- **Tests:** scheduler unit tests (budget cap, done() reclaim, cancel<0, weighted share); an integration test with two heavy mock archives proving neither starves.
- **Risk:** higher (hot path, abort/retry interaction). Land behind a flag; keep per-instance runner as fallback.
- **Delivers:** the "multiple heavy datasets in an arbitrary fashion" goal.

### Phase 3 — Cold-start preroll + seek across N sources
- Play-from-cold / seek: preroll until **all required** sources reach a common start-gate horizon (min over required), with the **throughput floor** (BOLA cold-start, 2.9) and the existing `maxStartWaitMs` escape hatch → **generalized degraded creep** (pin to the *nearest* required frontier). Decide: hard preroll-to-common-start vs progressive reveal of optional sources.
- **Delivers:** clean seeks in multi-source stories without long perceived stalls.

### Phase 4 — Multi-source UI + telemetry
- Buffered bar shows per-source runway (gating source highlighted) or the intersection; aggregate QoE stats.
- Auto-speed = **min sustainable speed** across required (Σ bytes / max ETA), Infinity only when *all* required are `complete`.

---

## 6. Open decisions (need a call before Phase 2)
1. **Cadence normalization tolerance default** — no source gives a quantitative default for arbitrary cadences. Propose tolerance = `max(lowWatermarkWallMs, coarsest-source-chunk-duration)`; validate empirically.
2. **Slot fairness algorithm** — deficit round-robin (recommended) vs per-source minimum reservations within the global `maxRequests`.
3. **EDF vs absolute required-class** — does a required source below gate *always* outrank an optional source regardless of deadline (recommended), and how do we bound optional-source starvation?
4. **Preroll policy** — wait-for-all-required vs progressive reveal (Phase 3).

## 6b. Implementation log (2026-06-19, branch `feat/multi-source-coordination`)

Built in 5 coordinated waves (parallel teams + adversarial review + fix gate per wave). **1056 tests pass** (baseline ~669), all typechecks clean, showcase build green. All work uncommitted; **not yet browser-verified**.

**What shipped:**
- **P0 — N-source gate.** `PlaybackGovernor` now holds `Map<id,{source,required,weight}>` via `addSource`/`removeSource` (`setSource` kept as back-compat shim). Gating folds over REQUIRED sources only: runway = `min` simMs, `complete` = AND, ETA = max, cost = Σ; optional sources never gate but still load + count toward cost/ETA; zero-required ⇒ never stalls. Side-effects broadcast to all sources.
- **P1 — cadence tolerance band.** `runwayToleranceMs` option (default 200 = `TICK_PROBE_INTERVAL_MS`); a required source within tolerance of the leading frontier is lifted before the min, absorbing cadence jitter (W3C Bug 26436) **without** lowering genuine stall protection. `tolerance=0` ⇒ exact raw-min.
- **Wiring — gate is live.** Every layer registers as a classified governor source via a `SourceRegistry` (`packages/react` `usePlayback` + `examples/showcase` `buildDemoLayers`/`StoryMap`/`DemoViewer`/`AvDeck`). Role policy: radar field = required, tracks/cells = optional; AV primary stream = required, others = optional; single-layer demos = one required source (identical to before).
- **P2 — shared scheduler.** New `packages/core/src/request-scheduler.ts` (`SharedRequestScheduler`, deficit-round-robin weighted fairness, `getPriority`<0 cancels, `done()`-handshake, AbortSignal) + `shared-scheduler.ts` singleton with **kill-switch** `configureSharedScheduler({enabled, maxRequests})` (default enabled, budget 24 = old per-archive cap → single-dataset unchanged via work-conservation). Integrated into `archive.ts` (both the getTiles cursor runner and the paged-page fetcher), preserving coalescing/prefetch/supersession/retry/timeout/throughput-sampling; per-archive `maxRequests` still honored as a ceiling under the global budget.
- **EDF — active end-to-end.** Each coalesced range-group is scheduled by tier (prefetch ranks below need-now globally) then `min` distance-to-playhead, comparable across archives sharing one playhead. Playhead threaded `tileset → archive.getTiles` via `TileBatchHooks.playheadTime/playheadDirection` and forwarded by `layers` + `maplibre`.
- **P3 — cold-start.** Audited: the Phase-0 combined min-gate already prerolls to a common start across required sources; degraded-creep already pins to the nearest required frontier; `predictsPlaythrough` (max ETA over required) already provides the throughput floor. Regression tests added, no new code needed.
- **P4 — auto-speed + UI.** `getAutoSpeedSuggestion` now returns the **contended** bound (aggregate throughput ÷ Σ per-source demand, incl. the no-`getThroughput` ETA fallback path) so Auto can't over-feed N heavy sources; returns `null` if any required source's sizes are unknown. New `getSourceRunways()` accessor + a per-source buffered strip in `PlaybackControls` (gating source highlighted; single-dataset bar unchanged).

**Bugs caught by adversarial review that passed the impl agents' own tests** (the reason for the per-wave review gates): DRR weighted-fairness starvation; a forever-deadlock on the paged path when a queued page-group was superseded; silent throughput-doubling (per-archive cap became a no-op); and an auto-speed fix that was inert on the live (no-`getThroughput`) path. All fixed + regression-tested.

**Known deferred (low, non-blocking):** layer-level teardown hook so optional overlays `removeSource` on stream-toggle-off (currently self-heal on dataset switch); UI gating-track nub at runway=0 (cosmetic, left for in-browser aesthetic verify); StrictMode remount re-registers only the required source until layers re-fire.

**Browser-verify checklist (the remaining step):**
1. A multi-source composite (radar / AV cockpit) plays with all REQUIRED sources locked; no overlay races ahead of unloaded required data.
2. Single-dataset demos unchanged (no throughput regression, identical bar).
3. Under a slow network, the buffered strip shows the gating source held; recovery is smooth (no catch-up lurch).
4. Rollback drill: `configureSharedScheduler({enabled:false})` reverts loading to the per-instance path with no behavior change to the gate.

## 7. Sources
Verified, primary unless noted. MSE/W3C: [public-html-media 2014Jul/0032](https://lists.w3.org/Archives/Public/public-html-media/2014Jul/0032.html), [MSE 2](https://www.w3.org/TR/media-source-2/), [media-source#160](https://github.com/w3c/media-source/issues/160), [Media WG minutes 2019-09-19](https://www.w3.org/wiki/Media/Group/Minutes/2019-09-19). ABR/fairness: [BOLA arXiv](https://arxiv.org/abs/1601.06748) + [ToN PDF](https://groups.cs.umass.edu/wp-content/uploads/sites/3/2020/07/09110784.pdf), [QoE-Fair DASH TOMM](https://doi.org/10.1145/3397227), [Future Internet 14(5)152](https://www.mdpi.com/1999-5903/14/5/152), [ASTESJ rank-redistribute](https://www.astesj.com/v06/i01/p21/), [US10104413B2 WFQ](https://patents.google.com/patent/US10104413B2/en). Schedulers: [loaders.gl RequestScheduler](https://loaders.gl/docs/modules/loader-utils/api-reference/request-scheduler), [Cesium Request](https://cesium.com/learn/cesiumjs/ref-doc/Request.html) + [RequestScheduler src](https://github.com/CesiumGS/cesium/blob/main/packages/engine/Source/Core/RequestScheduler.js). Clock sync: [GStreamer clocks](https://gstreamer.freedesktop.org/documentation/application-development/advanced/clocks.html) + [latency](https://gstreamer.freedesktop.org/documentation/additional/design/latency.html), [DASH-IF Timing Model](https://dashif.org/Guidelines-TimingModel/).
