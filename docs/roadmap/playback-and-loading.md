# Playback & loading — clock↔data coupling and multi-source coordination

> **Status: SHIPPED + COMMITTED.** Single-source clock↔buffer coupling shipped
> 2026-06-09; multi-source coordination shipped 2026-06-19 (`86bbb0f`). This is a
> consolidated decision record — the *why*, not current behavior. Shipped
> behavior + API live in [`stt-player`](../api/stt-player.md),
> [`playback-governor`](../api/playback-governor.md) (including the multi-source
> `addSource`/`removeSource` gate + `SharedRequestScheduler`), and
> [`time-controller`](../api/time-controller.md). Merges the former
> `player-buffering.md` + `multi-source-coordination.md`.

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
RobustMPC SIGCOMM'15):

- **Startup:** start small, buffer while playing (ExoPlayer 2.5 s, Shaka
  `rebufferingGoal` ≈ 2 s) — nobody fills the full target before starting. Users
  abandon at ~2 s startup delay (+5.8 %/s after).
- **Steady state:** 10–30 s forward buffer (hls.js `maxBufferLength` 30 s) under a
  **dual seconds-AND-bytes cap** (`maxBufferSize` 60 MB); loading duty-cycled
  between low/high watermarks, not continuous.
- **Stall:** the playhead **freezes**, `waiting` fires, UI shows buffering — time
  never advances over missing media. Rebuffering hurts QoE more than any quality
  drop; stall *count* hurts separately from duration.
- **Resume hysteresis:** ExoPlayer resumes at 5 s (2× the 2.5 s start gate) to
  kill stall/resume oscillation.
- **Seeking:** instant feedback from a tiny always-resident storyboard tier
  (BIF/VTT sprites); real fetches debounced until the scrub settles (~150–250 ms),
  in-flight old-position requests aborted, resume at a *small* post-seek gate.
- **Bandwidth:** dual EWMA (fast ≈3 s / slow ≈9 s half-life), use the min;
  asymmetric switch factors (down at 0.95×, up only at 0.7×).
- **Rate adaptation:** mainstream video NEVER slows playback for slow networks — it
  drops quality then stalls; the only rate change is ±2–5 % live-edge catch-up.
- **Non-video precedents** (deck.gl TripsLayer, kepler.gl, CesiumJS Clock, FR24):
  none couple the clock to loading — all play through gaps. Google Earth Timelapse
  solved it by re-encoding data *as video*, forfeiting interactivity. Clock↔buffer
  coupling is the genuinely novel piece for a data player.

**Where a data player deliberately differs from video:**

1. **Cost is knowable in advance.** The v5 directory stores every tile's
   `(timeStart, timeEnd, length)`, so we compute *exactly* the bytes the next N
   playback-seconds cost for the current viewport, ÷ measured throughput = an
   honest ETA — MPC-style lookahead for free; deadlines are *exact*, not estimated.
2. **Speed multiplies data rate** — buffer targets are denominated in wall-seconds
   × current speed; a speed change is a re-plan event.
3. **Viewport is a second seek axis** — pan/zoom invalidates the buffer while time
   stands still; the same debounce/abort/reprioritize machinery applies.
4. **Speed is a user-facing semantic control** (no audio, no authored tempo), so
   *visible, opt-in* speed adaptation is acceptable here — but only after honest
   buffering, never silently.
5. **Partial render is possible** — but as a principled mode (scrub preview,
   explicit "play anyway") with a completeness indicator, never the silent default.

## 3. Single-source design (shipped — see the API docs for behavior)

`PlaybackGovernor` is a small state machine between `TimeController` (kept a dumb
wall-clock × speed rAF clock) and the tileset. It gates `play()` on a buffered
runway ahead of the playhead, freezes the clock (never advances into unloaded
time) when the runway drains, applies resume hysteresis so stall/resume never
oscillates, and turns seeks/scrubs into preview-vs-commit operations with a
post-seek gate. The buffer model + readiness API (`getBufferedRunway`,
`estimateCost`, `estimateTimeToReadyMs`, dual-EWMA throughput) live in
`packages/core`; the gate + auto-speed live in `@poopdeck.gl/playback`.

**Frontier hold + degraded creep** (2026-06-10 follow-up): the first governor
detected stalls only from network events, so between events the playhead could
sail past the loaded frontier and freeze deep in unloaded time (blank frame). Three
additions close this — a **tick-driven** runway probe every ~200 ms (a quiet
network can't blind it), a **frontier clamp** that snaps a playhead crossing the
buffered frontier back onto loaded data (overruns > ~1 wall-second × |speed| are
treated as external seeks and never snapped), and **degraded creep** after an
escape-hatch resume that pins playback to the frontier so it advances at
data-arrival rate instead of looping fixed-length freezes.

Full behavior, states, gates, options, QoE counters, and auto-speed:
[`playback-governor.md`](../api/playback-governor.md).

## 4. Multi-source: what the SoTA says (deep-research, adversarially verified)

Confidence + 3-vote tallies from adversarial verification.

- **Combined health = min over *required* sources** (`high`, 3-0). MSE reaches
  `HAVE_ENOUGH_DATA` only when all active buffers have data past the playhead;
  `HTMLMediaElement.buffered` is the **intersection**. → Gate on
  `min(getBufferedRunway)` over required; `complete` = AND.
- **Naive `min()` MISFIRES on fractional horizon differences** (`high`, 3-0). W3C
  Bug 26436 (RESOLVED FIXED): raw min-gating stalls when active buffers have
  fractionally-different lengths, and streams are "exceedingly unlikely" to share
  exact durations. → Different cadence means horizons never align; needs a
  **tolerance band**. The single most important caveat for arbitrary sources.
- **Graceful-degradation menu** (`high`, 2-1). MSE #160: (a) AND-gate to where all
  are buffered; (b) OR-gate to where any has data + degrade laggards; (c) keep
  running, degrade laggards. → required → AND; optional → continue-and-degrade
  (STT's degraded creep is option (c) for one source).
- **Required-vs-optional = a per-source `blocking` flag** (`high`, 2-1, PROPOSED).
  MSE proposal Oct 2025 validates a first-class `required` flag deciding inclusion
  in the min-gate (dash.js's production workaround today is `playbackRate=0`).
- **Independent per-source loading IS the failure mode** (`high`/`medium`). DASH's
  greedy per-client bandwidth grab starves peers; adding a shared global view
  measured +10 % fairness / +8 % efficiency. → one shared scheduler beats
  independent pools.
- **Divide a fixed budget by WEIGHT, not hard caps (WFQ)** (`high`, 3-0):
  work-conserving weighted-fair share, priorities → weights; a managed/weighted
  (gating) tier vs a best-effort tier = the bandwidth analog of required-vs-optional.
- **Rank-and-redistribute** (`high`, 3-0): rank required sources by distance from
  their gate and feed the laggard first; a central authority overrides local greed.
- **Shared-scheduler primitives** (`high`, 3-0): loaders.gl `RequestScheduler`
  (global `maxRequests`, `done()` handshake on completion or failure,
  `getPriority`<0 cancels) + Cesium (priority = distance-from-camera, re-sorted per
  frame). → priority = time-to-playhead, re-evaluated per frame, cancel tiles the
  playhead passed = earliest-deadline-first.
- **BOLA** (`high`, 3-0): a per-source seconds-ahead buffer scalar is the gate, but
  add a throughput floor at cold-start/after-seek (empty buffer). →
  `getBufferedRunway().simMs` is that scalar; the dual-EWMA estimator is the floor.
- **Refuted (0-3):** combined health via MAX end-time (MSE uses min, the opposite);
  an app-provided buffered-gap tolerance as a standard MSE mechanism (not real — we
  implement it ourselves); buffer occupancy alone with no throughput estimate.

STT already had most of the hard primitives (`TimeController`,
`getBufferedRunway().simMs`, `runway.complete`, exact `estimateTimeToReadyMs`,
dual-EWMA throughput, end-to-end `fetchPriority`, single-source degraded creep) — so
the work was: (1) generalize the gate to a fold over N classified sources, and (2)
hoist per-instance request pools to one shared EDF + weighted-fair scheduler. The
`BufferSource`/`BufferedRunway` contracts needed no change — only aggregation over a
set.

## 5. Multi-source architecture (shipped)

```
        TimeController (master clock — unchanged)
              │  play/stall/seek
        PlaybackGovernor  ── holds Map<id,{source,required,weight}>
              │             gate = min(runway) over REQUIRED (± tolerance band)
              │             complete = AND · ETA = max · cost = Σ
              │ priority hints (playhead, dir, per-source deficit-to-gate)
        SharedRequestScheduler (singleton, packages/core)
              │  global maxRequests · EDF by time-to-playhead
              │  weighted-fair (DRR) · work-conserving · done() · cancel<0
   archive A (required) · archive B (required) · archive C (optional)
```

Two rules fall straight out of the research: **gate on `min` over required with a
tolerance band** (optional sources never gate — they continue-and-degrade); **one
scheduler is the authority** — priority = EDF on exact time-to-playhead, required
sources below their gate promoted (rank-and-redistribute), weighted-fair slot share
so no required source starves another, optional = best-effort. The gate, tolerance
band, `addSource`/`removeSource`, and `SharedRequestScheduler` +
`configureSharedScheduler({enabled})` kill-switch are documented in
[`playback-governor.md`](../api/playback-governor.md).

## 6. Implementation log (2026-06-19, `86bbb0f`)

Built in 5 review-gated waves; **1056 tests pass** (baseline ~669), typechecks
clean, showcase build green.

- **P0 — N-source gate.** `PlaybackGovernor` holds `Map<id,{source,required,
  weight}>` via `addSource`/`removeSource` (`setSource` kept as a back-compat shim).
  Gating folds over REQUIRED only: runway = min simMs, complete = AND, ETA = max,
  cost = Σ; optional sources never gate but still load and count; zero-required ⇒
  never stalls; side-effects broadcast to all sources.
- **P1 — cadence tolerance band.** `runwayToleranceMs` (default 200 = the tick-probe
  interval): a required source within tolerance of the leading required frontier is
  lifted before the min, absorbing cadence jitter (W3C Bug 26436) without lowering
  genuine stall protection; `tolerance=0` ⇒ exact raw-min.
- **Wiring.** Every layer registers as a classified governor source via a
  `SourceRegistry` (`packages/react` `usePlayback` + showcase `buildDemoLayers`/
  `StoryMap`/`DemoViewer`/`AvDeck`): radar field = required, tracks/cells = optional;
  AV primary stream = required; single-layer demos = one required source (identical
  to before).
- **P2 — shared scheduler.** `packages/core/src/request-scheduler.ts`
  (`SharedRequestScheduler`, deficit-round-robin fairness, `getPriority`<0 cancels,
  `done()` handshake, AbortSignal) + `shared-scheduler.ts` singleton with kill-switch
  `configureSharedScheduler({enabled, maxRequests})` (default enabled, budget 24 =
  old per-archive cap → single-dataset unchanged via work-conservation). Integrated
  into `archive.ts` (the getTiles cursor runner + the paged-page fetcher), preserving
  coalescing/prefetch/supersession/retry/timeout/throughput sampling.
- **EDF — end-to-end.** Each coalesced range-group is scheduled by tier (prefetch
  ranks below need-now globally) then min distance-to-playhead, comparable across
  archives sharing one playhead (playhead threaded tileset → archive.getTiles).
- **P3 — cold-start.** Audited: the P0 min-gate already prerolls to a common start
  across required sources; degraded creep already pins to the nearest required
  frontier; max-ETA over required already supplies the throughput floor. Regression
  tests added, no new code needed.
- **P4 — auto-speed + UI.** `getAutoSpeedSuggestion` returns the **contended** bound
  (aggregate throughput ÷ Σ per-source demand) so Auto can't over-feed N heavy
  sources; `null` if any required source's sizes are unknown. New `getSourceRunways()`
  accessor + a per-source buffered strip in `PlaybackControls`.

**Bugs adversarial review caught that passed the impl agents' own tests** (the reason
for per-wave review gates): DRR weighted-fairness starvation; a paged-path
forever-deadlock when a queued page-group was superseded; silent throughput-doubling
(the per-archive cap became a no-op); an auto-speed fix inert on the live
no-`getThroughput` path. All fixed + regression-tested.

## 7. Follow-ups — triaged 2026-07-01

- **Multi-source browser-verify — the one remaining gate (user-run, open):**
  (1) a multi-source composite (radar / AV cockpit) plays with all REQUIRED
  sources locked, no overlay racing ahead of unloaded required data; (2)
  single-dataset demos unchanged (no throughput regression, identical bar); (3)
  under a slow network the buffered strip shows the gating source held, recovery
  smooth (no catch-up lurch); (4) rollback drill —
  `configureSharedScheduler({enabled:false})` reverts loading to the
  per-instance path with no gate behavior change.
- **MapLibre governor wiring — COUNTED OUT (stays app-wired).**
  `onTilesetReady`/`onBufferChange` are forwarded from `packages/maplibre`
  (`base-layer.ts`); a first-class `SttPlayer`-level maplibre integration waits
  until maplibre is a supported *player* surface, not just a renderer.
- **Player-level "exposure" control — COUNTED OUT.** A temporal-window /
  trail-length player knob (kepler.gl's brushed range width) is a feature ask,
  not debt; it interacts with runway-horizon math, so build it only against a
  concrete UX request.
- **Layer-level teardown on stream-toggle-off — DONE (this line was stale).**
  Hidden governed streams are actively unregistered on toggle-off
  (`AvDeck.tsx` iterates `GOVERNED_STREAMS` → `registry.unregisterSource(id)`,
  idempotent), so a toggled-off required LiDAR can't strand the clock.
- **StrictMode remount re-registration — COUNTED OUT (mitigated).**
  `use-playback.ts` already hands the tileset over via a one-shot `tilesetRef`
  on governor recreation; the residual multi-source ordering is transient and
  gets checked during the browser-verify above rather than coded around.
- **Gating-track nub at runway=0 — FIXED 2026-07-01.** The per-source strip now
  paints a minimum-width (3px, CSS `max()`/`min()`-clamped) nub, so a bone-dry
  gating source stays visible at the playhead instead of vanishing
  (`packages/react/src/components/PlaybackControls.tsx`).

## 8. Sources

MSE/W3C: public-html-media 2014Jul/0032, MSE 2, media-source#160, Media WG minutes
2019-09-19. ABR/fairness: BOLA (arXiv 1601.06748) + ToN PDF, QoE-Fair DASH (ACM TOMM
2020), Future Internet 14(5)152, ASTESJ v06i01p21, US10104413B2 (WFQ). Schedulers:
loaders.gl RequestScheduler, Cesium Request + RequestScheduler src. Clock sync:
GStreamer clocks + latency, DASH-IF Timing Model.
