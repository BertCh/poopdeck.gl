# Playback & loading — clock↔data coupling and multi-source coordination

> **Status: SHIPPED + COMMITTED.** Single-source clock↔buffer coupling shipped
> 2026-06-09; multi-source coordination 2026-06-19 (`86bbb0f`). A consolidated
> decision record — the *why*, not current behavior; shipped behavior + API live
> in [`stt-player`](../api/stt-player.md),
> [`playback-governor`](../api/playback-governor.md) (incl. the multi-source
> `addSource`/`removeSource` gate + `SharedRequestScheduler`), and
> [`time-controller`](../api/time-controller.md). Merges the former
> `player-buffering.md` + `multi-source-coordination.md`. Inbound link:
> `docs/api/playback-governor.md` → this file (keep this path). Companion:
> [`scrub-lod-2026-07.md`](./scrub-lod-2026-07.md) — motion-tier LOD built on
> this doc's clock↔buffer coupling.

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
advances over missing media, and stall *count* hurts QoE separately from
duration; resume hysteresis (ExoPlayer resumes at 5 s = 2× the 2.5 s start gate);
seek feedback from a tiny always-resident storyboard tier (BIF/VTT sprites), real
fetches debounced until the scrub settles (~150–250 ms), stale in-flight requests
aborted; bandwidth = dual EWMA (fast ≈3 s / slow ≈9 s half-life, use the min),
asymmetric switch factors (down at 0.95×, up only at 0.7×). Mainstream video
NEVER slows playback for slow networks — it drops quality then stalls; the only
rate change is ±2–5 % live-edge catch-up.

**Non-video precedents** (deck.gl TripsLayer, kepler.gl, CesiumJS Clock, FR24):
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
+ auto-speed in `@poopdeck.gl/playback`.

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

- **Combined health = min over *required* sources** (`high`, 3-0). MSE reaches
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

## 7. Follow-ups — triaged 2026-07-01

**The one open item — multi-source browser-verify (user-run):** (1) a
multi-source composite (radar / AV cockpit) plays with all REQUIRED sources
locked, no overlay racing ahead of unloaded required data; (2) single-dataset
demos unchanged — no throughput regression, identical bar; (3) under a slow
network the buffered strip shows the gating source held, recovery smooth (no
catch-up lurch); (4) rollback drill — `configureSharedScheduler({enabled:false})`
reverts loading to the per-instance path with no gate behavior change.

Counted out: **maplibre governor wiring** (stays app-wired; trigger = maplibre
becoming a supported *player* surface, not just a renderer) · **player-level
"exposure"/trail-length knob** (a feature ask touching runway-horizon math —
build only against a concrete UX request) · **StrictMode remount re-registration**
(mitigated via the one-shot `tilesetRef` handover in `use-playback.ts`; residual
ordering is transient, checked in the browser-verify above). Done: **layer
teardown on stream-toggle-off** (`AvDeck.tsx` unregisters governed streams,
idempotent — a toggled-off required LiDAR can't strand the clock) and the
**runway=0 gating-track nub** (3px clamped minimum in `PlaybackControls.tsx`,
fixed 2026-07-01).

## 8. Sources

MSE/W3C: public-html-media 2014Jul/0032, MSE 2, media-source#160, Media WG minutes
2019-09-19. ABR/fairness: BOLA (arXiv 1601.06748) + ToN PDF, QoE-Fair DASH (ACM TOMM
2020), Future Internet 14(5)152, ASTESJ v06i01p21, US10104413B2 (WFQ). Schedulers:
loaders.gl RequestScheduler, Cesium Request + RequestScheduler src. Clock sync:
GStreamer clocks + latency, DASH-IF Timing Model.
