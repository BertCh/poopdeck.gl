# Playback & loading — clock↔data coupling, multi-source coordination, motion tier

> **Status: SHIPPED + COMMITTED.** Single-source clock↔buffer coupling shipped
> 2026-06-09; multi-source coordination 2026-06-19 (`86bbb0f`); run-ahead
> fairness + playhead-relative eviction 2026-07-22; scrub-LOD wiring 2026-07-05.
> A consolidated decision record — the _why_, not current behavior; shipped
> behavior + API live in [`stt-player`](../api/stt-player.md),
> [`playback-governor`](../api/playback-governor.md) (incl. the multi-source
> `addSource`/`removeSource` gate + `SharedRequestScheduler`),
> [`time-controller`](../api/time-controller.md), and
> [`spatiotemporal-tileset`](../api/spatiotemporal-tileset.md) (`scrubLod`).
> Merges the former `player-buffering.md`, `multi-source-coordination.md`, and
> `scrub-lod-2026-07.md`. Inbound link: `docs/api/playback-governor.md` → this
> file (keep this path).

## 1. The problem

The STT "player" behaved like a video player with the buffering logic deleted:
the animation clock (`TimeController.tick()`) advanced `currentTime += elapsed ×
speed` unconditionally and never consulted the loader, so entities popped in late,
frames were silently partial, and seeks landed on blank screens until the network
caught up. Every mitigation was an ad-hoc workaround for one missing coupling —
nothing could answer "is `[t, t+Δ]` loaded for this viewport?" and nothing paused
the clock when the answer was no. Deleted workarounds: a global
`PLAYBACK_SLOWDOWN=2` half-speed hack, a hero-globe first-tile wait, a story
cross-dissolve fade-to-black tile wait, and per-beat hand-tuned `speedDays` guards.

The multi-source extension is the same gap at N sources: a story or cockpit may
composite N arbitrary STT datasets — possibly several heavy ones — on one shared
playhead. Timing was coordinated but **loading was not**, and the gate trusted a
**single** source, so the shared playhead could stall on the lightest source or
race ahead of a heavy one it never waited for.

## 2. State of the art (video players)

Survey of HTMLMediaElement, hls.js, dash.js, Shaka, ExoPlayer + the QoE literature
(Krishnan & Sitaraman IMC'12, Dobrian SIGCOMM'11, BBA SIGCOMM'14, BOLA INFOCOM'16,
RobustMPC SIGCOMM'15). Consensus mechanics: start small, buffer while playing
(ExoPlayer 2.5 s, Shaka `rebufferingGoal` ≈ 2 s; users abandon at ~2 s startup,
+5.8 %/s after); 10–30 s forward buffer (hls.js `maxBufferLength` 30 s) under a
dual seconds-AND-bytes cap (`maxBufferSize` 60 MB), duty-cycled between
watermarks; on underrun the playhead **freezes** (`waiting`) — time never
advances over missing media, and stall _count_ hurts QoE separately from
duration; resume hysteresis (ExoPlayer resumes at 5 s = 2× the 2.5 s start gate);
seek feedback from a tiny always-resident storyboard tier (BIF/VTT sprites), real
fetches debounced until the scrub settles (~150–250 ms), stale in-flight requests
aborted; bandwidth = dual EWMA (fast ≈3 s / slow ≈9 s half-life, use the min),
asymmetric switch factors (down at 0.95×, up only at 0.7×). Mainstream video
NEVER slows playback for slow networks — it drops quality then stalls; the only
rate change is ±2–5 % live-edge catch-up.

**Non-video precedents** (deck.gl TripsLayer, kepler.gl, CesiumJS Clock, FR24):
none couple the clock to loading — all play through gaps. Google Earth Timelapse
solved it by re-encoding data _as video_, forfeiting interactivity. Clock↔buffer
coupling is the genuinely novel piece for a data player.

**Where a data player deliberately differs from video:**

1. **Cost is knowable in advance.** The v5 directory stores every tile's
   `(timeStart, timeEnd, length)`, so we compute _exactly_ the bytes the next N
   playback-seconds cost for the current viewport, ÷ measured throughput = an
   honest ETA — MPC-style lookahead for free; deadlines are _exact_, not estimated.
2. **Speed multiplies data rate** — buffer targets are denominated in wall-seconds
   × current speed; a speed change is a re-plan event.
3. **Viewport is a second seek axis** — pan/zoom invalidates the buffer while time
   stands still; the same debounce/abort/reprioritize machinery applies.
4. **Speed is a user-facing semantic control** (no audio, no authored tempo), so
   _visible, opt-in_ speed adaptation is acceptable here — but only after honest
   buffering, never silently.
5. **Partial render is possible** — but as a principled mode (scrub preview, an
   explicit "play anyway" + completeness indicator), never the silent default.

## 3. Single-source design (shipped — see the API docs for behavior)

`PlaybackGovernor` is a small state machine between `TimeController` (kept a dumb
wall-clock × speed rAF clock) and the tileset: it gates `play()` on a buffered
runway ahead of the playhead, freezes the clock (never into unloaded time) when
the runway drains, applies resume hysteresis so stall/resume never oscillates,
and turns seeks/scrubs into preview-vs-commit operations with a post-seek gate.
The buffer model + readiness API (`getBufferedRunway`, `estimateCost`,
`estimateTimeToReadyMs`, dual-EWMA throughput) live in `packages/core`; the gate
and auto-speed in `@poopdeck.gl/playback`.

**Frontier hold + degraded creep** (2026-06-10 follow-up): the first governor
detected stalls only from network events, so between events the playhead could
sail past the loaded frontier and freeze deep in unloaded time (blank frame). Three
additions close this — a **tick-driven** runway probe every ~200 ms (a quiet
network can't blind it), a **frontier clamp** that snaps a playhead crossing the
buffered frontier back onto loaded data (overruns > ~1 wall-second × |speed| are
treated as external seeks and never snapped), and **degraded creep** after an
escape-hatch resume that pins playback to the frontier so it advances at
data-arrival rate instead of looping fixed-length freezes. (Full behavior,
states, gates, options, QoE counters, auto-speed → the API doc above.)

## 4. Multi-source: what the SoTA says (deep-research, adversarially verified)

Confidence + 3-vote tallies from adversarial verification.

- **Combined health = min over _required_ sources** (`high`, 3-0). MSE reaches
  `HAVE_ENOUGH_DATA` only when all active buffers have data past the playhead;
  `HTMLMediaElement.buffered` is the **intersection**. → Gate on
  `min(getBufferedRunway)` over required; `complete` = AND.
- **Naive `min()` MISFIRES on fractional horizon differences** (`high`, 3-0). W3C
  Bug 26436 (RESOLVED FIXED): raw min-gating stalls on fractionally-different
  buffer lengths, and streams are "exceedingly unlikely" to share exact durations
  → different cadence means horizons never align; needs a **tolerance band**. The
  single most important caveat for arbitrary sources.
- **Graceful-degradation menu** (`high`, 2-1). MSE #160: (a) AND-gate to where all
  are buffered; (b) OR-gate + degrade laggards; (c) keep running, degrade laggards.
  → required → AND; optional → continue-and-degrade (STT's degraded creep = (c)
  for one source).
- **Required-vs-optional = a per-source `blocking` flag** (`high`, 2-1, PROPOSED).
  MSE proposal Oct 2025 validates a first-class `required` flag deciding inclusion
  in the min-gate (dash.js's production workaround today is `playbackRate=0`).
- **Independent per-source loading IS the failure mode** (`high`/`medium`). DASH's
  greedy per-client bandwidth grab starves peers; a shared global view measured
  +10 % fairness / +8 % efficiency. → one shared scheduler beats independent pools.
- **Divide a fixed budget by WEIGHT, not hard caps (WFQ)** (`high`, 3-0):
  work-conserving weighted-fair share, priorities → weights; a managed/weighted
  (gating) tier vs a best-effort tier = the bandwidth analog of required-vs-optional.
- **Rank-and-redistribute** (`high`, 3-0): rank required sources by distance from
  their gate and feed the laggard first; a central authority overrides local greed.
- **Shared-scheduler primitives** (`high`, 3-0): loaders.gl `RequestScheduler`
  (global `maxRequests`, `done()` handshake, `getPriority`<0 cancels) + Cesium
  (priority = distance-from-camera, re-sorted per frame). → priority =
  time-to-playhead re-evaluated per frame, cancel passed tiles = EDF.
- **BOLA** (`high`, 3-0): a per-source seconds-ahead buffer scalar is the gate, but
  add a throughput floor at cold-start/after-seek (empty buffer). →
  `getBufferedRunway().simMs` is that scalar; the dual-EWMA estimator is the floor.
- **Refuted (0-3):** combined health via MAX end-time (MSE uses min, the opposite);
  an app-provided buffered-gap tolerance as a standard MSE mechanism (not real — we
  implement it ourselves); buffer occupancy alone with no throughput estimate.

STT already had most of the hard primitives (`TimeController`,
`getBufferedRunway().simMs`, `runway.complete`, exact `estimateTimeToReadyMs`,
dual-EWMA throughput, end-to-end `fetchPriority`, single-source degraded creep) —
so the work was: (1) generalize the gate to a fold over N classified sources, (2)
hoist per-instance request pools to one shared EDF + weighted-fair scheduler. The
`BufferSource`/`BufferedRunway` contracts needed no change — only aggregation.

## 5. Multi-source architecture (shipped)

```
        TimeController (master clock — unchanged)
              │  play/stall/seek
        PlaybackGovernor  ── holds Map<id,{source,required,weight}>
              │  gate = min(runway) over REQUIRED (± tolerance band)
              │  complete = AND · ETA = max · cost = Σ · priority hints
        SharedRequestScheduler (singleton, packages/core)
              │  global maxRequests · EDF by time-to-playhead
              │  weighted-fair (DRR) · work-conserving · done() · cancel<0
   archive A (required) · archive B (required) · archive C (optional)
```

Two rules fall straight out of the research. **Gate on `min` over required with a
tolerance band** — `runwayToleranceMs`, default 200 ms (= the tick-probe
interval): a required source within tolerance of the leading required frontier is
lifted before the min, absorbing cadence jitter (W3C Bug 26436) without lowering
genuine stall protection; `tolerance=0` ⇒ exact raw-min; optional sources never
gate — they continue-and-degrade. **One scheduler is the authority** — EDF on
exact time-to-playhead, laggard required sources promoted (rank-and-redistribute),
weighted-fair slots, optional = best-effort. Gate, tolerance band,
`addSource`/`removeSource`, and the `SharedRequestScheduler` +
`configureSharedScheduler({enabled})` kill-switch:
[`playback-governor.md`](../api/playback-governor.md).

## 6. Implementation

Shipped 2026-06-09 (single-source) and 2026-06-19 `86bbb0f` (multi-source, five
review-gated waves); the wave-by-wave log and test counts live in git history.
**Bugs adversarial review caught that passed the impl agents' own tests** (the
reason for per-wave review gates): DRR weighted-fairness starvation; a paged-path
forever-deadlock when a queued page-group was superseded; silent
throughput-doubling (the per-archive cap became a no-op); an auto-speed fix inert
on the live no-`getThroughput` path. All fixed + regression-tested.

### 6.1 Run-ahead fairness + dynamic weights (2026-07-22 — Phase 2 finished)

Multi-dataset composites exposed the dual of the min-gate: the clock holds at
the required LAGGARD (MSE intersection, §4), so every sim-ms a leader buffers
past that intersection is dead weight — it cannot render before the laggard
catches up, its fetches contend with the laggard's in the shared DRR scheduler,
and under memory pressure it feeds the loader's cache eviction until the
eviction lands on a protected playhead window ("flashing tiles"). Shaka's rule
generalizes: cap any track ~1 segment past the neediest. The governor now
applies, on its existing probe cadences (playing tick-probe + gated eval — no
new timer, one probe per source per evaluation shared with the frontier fold):

- **Run-ahead cap** — every source that is not (one of) the laggard(s) gets
  `setPrefetchRunAheadLimit(laggard + slack)`, the laggard(s) get `null`;
  `slack = max(runwayToleranceMs, 3000 wall-ms) × |speed|`. Optional sources
  are capped too (one ahead of the required laggard is pure dead weight; one
  behind is unaffected — the cap only limits run-AHEAD). Loaders may keep an
  internal safety floor; degrading the prefetch horizon under pressure beats
  evicting the protected window.
- **Dynamic weights** — incomplete required sources get
  `base × clamp((slack + laggard) / (slack + runway_i), 0.25, 4)`: the laggard
  lands exactly on base, leaders shed share, bounded both ways. DRR is
  work-conserving, so this only matters while leaders still hold legitimate
  queued work (e.g. refetching near-window evictions) — the cap does most of
  the work. Optional sources stay at base.

Writes are throttled (>20% change or a to/from-null transition); caps clear
and base weights restore whenever fairness deactivates (pause, `setSource`,
dropping under 2 sources, removing the laggard, dispose, or no incomplete
required source left). Kill switch: `multiSourceFairness: false` (default
true). Both `BufferSource` hooks are optional — loaders without them are
simply not steered.

### 6.2 Playhead-relative eviction + the pressure ladder (2026-07-22)

Fairness capped what leaders _fetch_; this decides what the cache _keeps_. The
loader's over-limit pass used plain LRU, and **the bug that prevents**: under
memory pressure the runway just prefetched ahead of the playhead is the most
valuable content in the cache, and plain LRU reclaims exactly that (prefetched =
least-recently _touched_); the priority path then re-fetches the same bytes
seconds later — the multi-dataset "flashing tiles" thrash. Media players trim
relative to the playhead instead (back-buffer first, distant speculation next,
the imminent window last), so the over-limit pass now builds an ordered plan over
four tiers, evicting only until back under the size/byte limits:

| Tier | Contents                                        | Order                 |
| :--- | :---------------------------------------------- | :-------------------- |
| A    | not in the coverage index (stale viewport/zoom) | LRU, oldest first     |
| B    | coverage, `behind > max(timeWindow, bucketMs)`  | furthest behind first |
| C    | coverage, `ahead > max(timeWindow, 2×bucketMs)` | furthest ahead first  |
| D    | the near-playhead protected window              | LRU (last resort)     |

Distances are signed along the committed playback direction. Never candidates:
tiles in the current viewport, pinned overview (storyboard) tiles, and **in-flight
headers** — _the bug that prevents_: an in-flight header deleted out from under
its batch stays referenced by `deliverTile()` and resurrects as an orphan outside
the registry, inflating `currentCacheBytes`/`loadedTileCount` forever. With no
coverage index or no playhead (consumers that never touch the buffer APIs) the
plan degrades to the original LRU, byte-identical to before.

**Pressure ladder.** Reaching tier C/D means the limits forced the pass into the
protected runway, so instead of letting fetch→evict→refetch continue, the
speculative prefetch horizon degrades: `prefetchPressureScale ×= 0.7` on any
tier-C/D eviction, floored at `0.25`; it recovers `+0.1` only after `5000 ms` of
wall-clock with no runway eviction, rate-limited to one step per `1000 ms`.
_The bug that prevents_: recovery stepped per prefetch _plan_ rather than per
wall-clock interval would race the scale back to 1 in ~2 s under a fast playhead
(plans run many times per second) and oscillate fetch→evict indefinitely under
sustained pressure. The scale applies after every horizon cap, so the un-pressured
path stays byte-identical to the pre-ladder behavior — no floor may raise the
horizon. `cacheStats.runwayEvictions` counts tier-C/D evictions only: it is the
observable thrash signal, not a general eviction count.

### 6.3 Which sources gate — `overlayGatesPlayback` defaults TRUE

A composite demo's overlay archives register as **required** governor sources by
default (`dataset.overlayGatesPlayback ?? true`) on all three renderer paths
(deck `buildDemoLayers.ts`, `MaplibreRenderer.tsx`, `SttThreeGeoViewer.tsx`).
Default-true is the conservative reading of §4: an overlay the viewer can see is
data the clock should wait for, and defaulting it optional silently reintroduces
the original bug (the playhead racing ahead of data the frame shows). Setting
`overlayGatesPlayback: false` is the deliberate opt-in to continue-and-degrade
(§4 option (c)) for decorative overlays — timeless static substrates are excluded
from governor registration entirely rather than flagged.

## 7. Scrub-time LOD — a motion tier that no application enables

**The idea.** Every mature interactive system keeps two representations: a cheap
**motion tier** served while the user moves and the expensive **settle tier**
served once they stop (NLE proxies, I-frame tracks, scaled parent tiles, VTK's
interactive-vs-still passes). STT had every primitive — `beginScrub`/`scrubTo`/
`endScrub` with a 200 ms `seekSettleMs` debounce, `'best-available'` parent
fallback up to `PARENT_FALLBACK_LEVELS = 4`, a pinned z0..z1 overview tier, a
built-but-unwired `--temporal-lod` pyramid, an EDF scheduler already ranked by
temporal distance to the playhead. **What was missing was policy and wiring, not
machinery**: the "we are scrubbing" bit died inside the governor, LOD was purely
camera-zoom, and a fast drag issued up to ~10 fresh viewport×window selections/sec
that each flushed the last — the system waited, at full detail, for a target it
kept invalidating.

**What shipped (2026-07-05, wire-only, no build-format change):** the governor
exposes `isScrubbing` + `'scrubstart'`/`'scrubend'` → `BufferSource.setInteractive`
→ tileset `scrubLod`, with a **spatial** axis (`spatialZoomDrop N` through the
existing `zoomOverride` path, clamped to `[0, PARENT_FALLBACK_LEVELS]` so the
coarse target is usually a parent the fallback path already fetched — often zero
new fetches) and a **temporal** axis (`pickTemporalLodForZoom` +
`getTileIdsInBoundsForTemporalLod`, bucket `B ≈ visibleSpan / timelinePixelWidth`
per the bounded-resolution rule: you cannot resolve a finer time step than the
scrubber has pixels). Absent/empty `scrubLod` is the kill switch — `setInteractive`
becomes stored state and behavior is byte-identical.

**The correctness contract (G7 — held by the shipped code):** the coarse scrub
tier is **preview-only and never gates**. The scrub hold already suppresses all
gates while the thumb is down, so the coarse tier only renders in a window where
nothing gates anyway; on `endScrub → commitSeek` the governor flushes and re-gates
at the **fine** tier exactly as before — orthogonal to the buffering state machine,
the property that let it ship kill-switched. Anti-pop discipline, inherited from
Cesium: keep the coarse tier resident _under_ the fine tier until the fine tile
lands, because "disappearing detail is worse than late-arriving detail."

**The negative result that keeps it off (G5).** The temporal axis has no
guaranteed payoff, because the coarse-time aggregator only re-buckets — it does
**not** reduce feature count. `crates/stt-build/src/tiler.rs`, still true today:
"The scaffold _re-bucketes only_ — feature-level simplification (collapse 1000
points per cell into 50 means) is left as a follow-up." A coarse-time tile can
therefore hold every feature in the cell: coarser in time, **not guaranteed
cheaper to fetch or decode**. A tier that isn't cheaper cannot make scrubbing
faster.

**The blunt read (verified 2026-07-24).** `scrubLod` has **zero call sites in the
showcase across all three renderers** — nothing under `examples/*/src` passes it,
and `setInteractive` is called only inside the packages. The wire is complete and
tested end-to-end (`packages/core/test/scrub-lod.test.ts`,
`packages/three/test/streaming-tile-source.test.ts`, forwarded by the maplibre and
three sources) and enabled nowhere. **So it is not a feature — it is a tested
capability with no consumer,** and this record calls it counted out rather than
"open," with two triggers:

- **Spatial axis** — revive when a heavy demo (NYC taxi ~10 M vertices, AV cockpit
  LiDAR/surfels, BIXI flowmaps) measurably fails the criteria below in the browser.
  It is enable-able today at near-zero fetch cost; nobody has measured it, which is
  why there is no call site.
- **Temporal axis** — stays counted out until a baked _reducing_ tier exists
  (extend `generate_lod_level` to keep M4 min/max/first/last per (cell, coarse
  bucket) for scalar/line data or voxel/LTTB decimation for point clouds, with
  independently-decodable coarse tiles, plus `stt-validate` checks: coarse ⊆ base,
  extrema preserved, byte-cost ≪ base). Without that, G5 says enabling it buys
  nothing.

If neither trigger fires by the next format revision, delete the wiring rather
than carry a dark feature.

**How to decide it (the criteria, unmet).** Reuse the QoE harness (`getQoeStats`,
`__sttProbe.playback`) plus scrub counters so "responsive" is a number, not a
vibe: **scrub time-to-first-pixel** (`scrubTo` → rendered frame reflecting the new
instant; target < one 60 Hz frame from a resident coarse tile); **fresh-frame
fraction** (% of drag frames showing data for the current instant, any tier, vs
stale/blank); **bytes-during-scrub** (should _drop_ vs the base-tier churn
baseline — the efficiency proof); **settle-to-full-detail latency** (`endScrub` →
fine tier resident); **pop/oscillation count** (LOD-tier switches per scrub;
hysteresis should keep it ~1–2); **no single-dataset regression** (`scrubLod` off
is byte- and behavior-identical — the rollback drill).

Resolved while wiring it, and still the defaults: spatial-first (temporal inert
until enabled _and_ the archive was built with `--temporal-lod`); binary
`isScrubbing` rather than velocity-scaled degrade; policy lives as
`ScrubLodOptions` on the tileset (`packages/core`) rather than as a pure function
in the playback package; default OFF. Counted out with it: scrub-velocity
prefetch (ATLAS-style), a predictive LOD budget controller (Funkhouser–Séquin:
estimate cost _before_ drawing — pure feedback control "will tend to overshoot and
oscillate, especially on an abrupt change in detail"), and cross-fade/hysteresis
tuning — all P4 polish on a feature with no consumer, so none of it is scheduled.

## 8. Follow-ups — triaged 2026-07-01

**The one open item — multi-source browser-verify (user-run; part of L2 in the
[roadmap README](./README.md)):** (1) a
multi-source composite (radar / AV cockpit) plays with all REQUIRED sources
locked, no overlay racing ahead of unloaded required data; (2) single-dataset
demos unchanged — no throughput regression, identical bar; (3) under a slow
network the buffered strip shows the gating source held, recovery smooth (no
catch-up lurch); (4) rollback drill — `configureSharedScheduler({enabled:false})`
reverts loading to the per-instance path with no gate behavior change.

Counted out: **player-level "exposure"/trail-length knob** (a feature ask touching
runway-horizon math — build only against a concrete UX request) · **StrictMode
remount re-registration** (mitigated via the one-shot `tilesetRef` handover in
`packages/react/src/hooks/use-playback.ts`; residual ordering is transient,
checked in the browser-verify above).

Trigger FIRED — **maplibre governor wiring** was counted out with the trigger
"maplibre becomes a supported _player_ surface, not just a renderer." The maplibre
custom-layer parity work made it one, so it is now wired the same way as deck:
`MaplibreRenderer.tsx` registers every mounted layer's tileset as a governor
source (primary `required: true`, overlays per `overlayGatesPlayback ?? true`) and
unregisters on teardown.

Done: **layer teardown on stream-toggle-off** (`AvDeck.tsx` unregisters governed
streams, idempotent — a toggled-off required LiDAR can't strand the clock) and the
**runway=0 gating-track nub** (3 px clamped minimum in
`packages/react/src/components/PlaybackControls.tsx`, fixed 2026-07-01) — without
it the one source actually HOLDING the clock is the only one with no marker.

## 9. Sources

MSE/W3C: public-html-media 2014Jul/0032, MSE 2, media-source#160, Media WG minutes
2019-09-19. ABR/fairness: BOLA (arXiv 1601.06748) + ToN PDF, QoE-Fair DASH (ACM TOMM
2020), Future Internet 14(5)152, ASTESJ v06i01p21, US10104413B2 (WFQ). Schedulers:
loaders.gl RequestScheduler, Cesium Request + RequestScheduler src. Clock sync:
GStreamer clocks + latency, DASH-IF Timing Model. Motion tier: HLS RFC 8216
`EXT-X-I-FRAMES-ONLY`, Cesium selection algorithm ("Ancestor Meets SSE"/"Kicking"),
M4 (Jugel et al., PVLDB 2014), LTTB (Steinarsson 2013), Funkhouser & Séquin
(SIGGRAPH 93), VTK `SetDesiredUpdateRate`, ATLAS (VAST 2008).
