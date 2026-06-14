# Player buffering: coupling the playback clock to data loading

> **Status: SHIPPED 2026-06-09** (design record; the living docs are
> [`docs/api/stt-player.md`](../api/stt-player.md),
> [`docs/api/playback-governor.md`](../api/playback-governor.md) and
> [`docs/api/time-controller.md`](../api/time-controller.md)). 2026-06-10
> follow-ups: frontier-hold fix (tick-driven stall, playhead clamped to the
> buffered frontier, degraded creep), loop wraps gate via `'seeking'`, QoE
> counters (`getQoeStats()` + `'playback'` probe channel), tab-refocus delta
> clamp. 2026-06-11 ergonomics wave (from the player conventions review,
> consolidated here): `SttPlayer` HTMLMediaElement-shaped facade (the
> recommended entry point pre-npm-publish), scrub hold (gates never resume
> under a held thumb; settle-commit warms the pipeline only), `'ended'` +
> replay-from-start, direction/speed separation (bounce owns direction),
> Auto-speed `Infinity` when fully buffered, `paused` intent getter,
> showcase keyboard map + scrubber step + a11y/UTC/creep-honest labels +
> hover timestamp + data-volume density strip, StoryGlobe on the shared
> auto-speed policy. Remaining: governor wiring in the MapLibre adapter (its
> `onTilesetReady`/`onBufferChange` hooks landed 2026-06-10; the facade makes
> this pure wiring), and exposing the temporal window/trail length as a
> player-level control (the data-player "exposure" knob — kepler.gl's brushed
> range width; interacts with the runway horizon math).

Status: IMPLEMENTED (2026-06-09, branch audit-fixes-2026-05) — all workstreams
(WS-A coverage/runway/cost APIs + throughput EWMA, WS-B PlaybackGovernor +
buffered-bar/buffering UI + workaround deletion, WS-C scrub/seek + storyboard
tier, WS-D Auto speed, WS-E retry/hardening). Browser-verified incl. throttled
networks and high-speed playback. Three integration findings fixed post-merge:
React StrictMode governor lifecycle (create in effect, dispose is terminal +
warn-once), the gated-stall prefetch deadlock (gates assert
setAnimationState(true, speed); canplaythrough ETA predicate; pipeline-idle
re-planning), and aborted-batch orphan headers blocking re-fetch (dead-header
re-enqueue in the prefetch planner).
Date: 2026-06-09

## 1. Problem

The STT "player" (play/pause/seek/speed over streamed spatiotemporal tiles) behaves
like a video player with the buffering logic deleted. The animation clock
(`TimeController.tick()`, packages/layers/src/time-controller.ts:189) advances
`currentTime += elapsedWallMs * speed` unconditionally — it never consults the
loader. When tiles for the current window haven't arrived, the GPU time filter
simply renders whatever is resident: entities pop in late, frames are silently
partial or empty, and seeks land on blank screens until the network catches up.

Every mitigation we have today is an ad-hoc workaround for this one missing
coupling:

| Workaround | Where | What it papers over |
|---|---|---|
| `PLAYBACK_SLOWDOWN = 2` (global half-speed) | examples/showcase types.ts:373 | playhead outrunning R2 loading |
| Hero globe waits for first `onTileLoad` (+4 s fallback) | HomePage.tsx:56–63,122 | startup with no data |
| Story cross-dissolve: fade to black, wait ≤850 ms for tiles | StoryGlobe.tsx:316–353 | blank frames on era jumps (seeks) |
| Per-beat conservative `speedDays` ("so the sweep doesn't outrun loading") | drifterStory.ts:138 | no bandwidth awareness |

These are symptoms of one architectural gap: **nothing can answer "is the time
range [t, t+Δ] loaded for this viewport?", and nothing pauses the clock when
the answer is no.**

## 2. What video players do (state of the art)

Survey of HTMLMediaElement, hls.js, dash.js, Shaka, ExoPlayer, plus the QoE
literature (Krishnan & Sitaraman IMC'12; Dobrian SIGCOMM'11; BBA SIGCOMM'14;
BOLA INFOCOM'16; RobustMPC SIGCOMM'15). Key facts:

- **Startup**: start small, buffer while playing. ExoPlayer starts at 2.5 s of
  buffer; Shaka `rebufferingGoal` ≈ 2 s; nobody fills the full target before
  starting. Users abandon at ~2 s startup delay (+5.8 %/s after).
- **Steady state**: target 10–30 s of forward buffer (hls.js `maxBufferLength`
  30 s) with a **dual constraint** — seconds AND bytes (`maxBufferSize` 60 MB);
  whichever cap hits first stops loading. Loading is duty-cycled between
  low/high watermarks, not continuous.
- **Stall semantics**: when the buffer empties, the playhead **freezes**, a
  `waiting` event fires, UI shows buffering. Time never advances over missing
  media. Rebuffering hurts QoE more than any quality reduction.
- **Resume hysteresis**: ExoPlayer resumes after a stall at 5 s buffered — 2×
  the 2.5 s start gate — to kill stall/resume oscillation. Stall *count* hurts
  separately from stall duration; one 3 s stall beats three 1 s stalls.
- **Seeking**: instant scrub feedback comes from a tiny always-resident
  storyboard tier (BIF/VTT sprites), never the main pipeline. Real fetches are
  debounced until the scrub settles (~150–250 ms); in-flight requests for the
  old position are aborted; playback resumes after a *small* post-seek gate
  (startup-sized, not full target). Backward seeks served from back buffer.
- **Bandwidth estimation**: dual EWMA (fast ≈3 s / slow ≈9 s half-life), use
  the min — react fast to drops, rise cautiously. Asymmetric switch factors
  (down at 0.95×, up only at 0.7× estimate).
- **Rate adaptation**: mainstream video NEVER slows playback for slow networks
  — it drops quality, then stalls. The only rate adaptation is live-edge
  catch-up at ±2–5 % (imperceptibility threshold ~5 %).
- **Non-video precedents** (deck.gl TripsLayer, kepler.gl, CesiumJS Clock +
  availability, FR24 playback): none couple the clock to loading. All play
  through gaps. Google Earth Timelapse solved it by re-encoding data *as
  video*, forfeiting interactivity. Clock↔buffer coupling is the genuinely
  novel piece for a data player.

Where a data player should deliberately differ from video:

1. **Cost is knowable in advance.** Video predicts segment cost reactively; our
   v5 directory already stores every tile's `(timeStart, timeEnd, length)` —
   we can compute *exactly* how many bytes the next N playback-seconds cost
   for the current viewport, and divide by measured throughput for an honest
   time-to-ready. This is MPC-style lookahead for free; video players would
   kill for it.
2. **Speed multiplies data rate.** Buffer targets must be denominated in
   wall-clock seconds × current speed. A speed change is a re-plan event.
3. **Viewport is a second seek axis.** Pan/zoom invalidates the buffer while
   time stands still — same machinery (debounce/abort/reprioritize) applies.
4. **Speed is already a user-facing semantic control** (no audio, no authored
   tempo), so *visible, opt-in* speed adaptation is acceptable here in a way
   it isn't for video — but only after honest buffering, never silently.
5. **Partial render is possible** — but it must be a principled mode (scrub
   preview, explicit "play anyway") with a completeness indicator, not the
   silent default it is today.

## 3. Current implementation — strengths and gaps

What's already good (post packed-format + packing work):

- Coalesced batch fetch: viewport×window working set → few HTTP range requests
  (archive.ts:735–814, 2 MB gap rule, 24-way pool).
- Speed-aware, direction-aware prefetch runway, budget-capped at 50 % of cache,
  nearest-first ordering, flip hysteresis (spatiotemporal-tileset.ts:793–932).
- Abort of superseded priority requests on viewport/time change
  (spatiotemporal-tileset.ts:1160–1181).
- Two-tier LRU cache (compressed bytes + decoded tiles) with byte ceilings and
  animation-aware grace periods; backward seeks to cached time are near-free.
- `cover_t_min` avoids fetching tiles whose data is entirely after the window.

The gaps, mapped to player symptoms:

| Symptom | Root cause | File:line |
|---|---|---|
| Plays before data arrives | No start gate; `play()` just starts the rAF loop | time-controller.ts:189 |
| Playhead outruns loading; entities pop in | Clock never stalls; no readiness predicate exists | time-controller.ts:198–199 |
| Seek lands on blank frame | Seek is `setTime()` + throttled tileset update; no post-seek gate, no preview tier | time-controller.ts:83; spatiotemporal-layer.ts:404 |
| Scrubbing thrashes the loader | No drag-vs-settle distinction; every slider onChange is a full seek | TimeControls.tsx:92–98 |
| Everything runs at half speed | `PLAYBACK_SLOWDOWN=2` global hack instead of adaptive control | types.ts:373 |
| Can't even build the above | No API for "is [t1,t2] buffered?", no pending-tile visibility, no bandwidth estimate, no per-bucket byte cost query | tileset exposes only `getCacheStats()`/`getVisibleTiles()` |
| Flaky networks fail silently | No retry/backoff; errors only reach `onTileError` | spatiotemporal-tileset.ts:1138 |

## 4. Plan

Five workstreams, ordered by dependency. WS-A and WS-B deliver the user-visible
fix; WS-C/D/E are quality multipliers.

### WS-A: Buffer model + readiness API (packages/core)

The foundation everything else stands on. In `SpatiotemporalTileset`:

1. **Coverage index**: maintain, per current viewport tile set, the loaded/
   pending/missing status of each temporal bucket. The directory already gives
   bucket boundaries; the needed-tile computation already exists in
   `selectAndLoadTiles()` — this is bookkeeping, not new selection logic.
2. **`getBufferedRunway(time, direction): { simMs, bytesPending }`** — the
   contiguous sim-time span ahead of `time` for which every needed tile
   (primary zoom, current viewport) is resident. Stop at the first bucket with
   a missing tile.
3. **`estimateCost(timeRange): { bytes, tiles }`** — sum of directory `length`
   for needed-but-not-resident tiles in the range. Pure directory math; no
   network.
4. **Events**: `onBufferChange(runway)` fired when the runway crosses
   registered thresholds (not every tile load — avoid 60 Hz churn).
5. **Throughput estimator** in `STTArchive`: record (bytes, ms) per coalesced
   range response; dual EWMA with 3 s/9 s half-lives; expose
   `getThroughputEstimate()` = min(fast, slow). Range responses are large
   enough (coalesced) that per-sample noise is manageable.

Then `estimateTimeToReady(range) = estimateCost(range).bytes / throughput` —
an honest ETA video players cannot compute. Surface in `getCacheStats()`.

### WS-B: PlaybackGovernor (packages/layers, shared with maplibre)

A small state machine between `TimeController` and the tileset. The
TimeController stays a dumb clock; the governor subscribes to ticks and buffer
events and calls `pause()`/`play()` plus emits UI states. States:

- `idle → starting`: on user play, enter `starting`; begin loading; start the
  clock only when runway ≥ **startGate** (default: tiles for the current
  window resident AND runway ≥ 2 wall-seconds × speed, capped by
  estimateTimeToReady ≤ ~2 s so heavy datasets still start promptly at a
  partial-runway floor).
- `playing → buffering`: when runway < **lowWatermark** (default 0.5 wall-sec
  × speed), freeze the clock, emit `waiting`. The GPU keeps drawing the frozen
  frame — no blank.
- `buffering → playing`: resume when runway ≥ **resumeGate** = 2× startGate
  (ExoPlayer hysteresis). Never oscillate.
- `seeking`: see WS-C.

UI in the showcase:

- Buffering spinner/“buffering…” chip on TimeControls during `starting`/`buffering`.
- **Buffered-range bar** under the scrubber (the gray bar every video player
  has), driven by the coverage index — also a great debugging tool.
- ETA text from `estimateTimeToReady` ("~3 s") instead of an anonymous spinner.

Cleanup once landed: **delete `PLAYBACK_SLOWDOWN`**, restore intended
`targetPlaybackSeconds`, replace the HomePage first-tile gate and the
StoryGlobe 850 ms fade-wait cap with governor states (the cross-dissolve
*presentation* stays; its wait condition becomes `runway ≥ resumeGate`).

#### WS-B addendum (2026-06): frontier hold + degraded creep

The first shipped governor detected stalls only from network events
(`notifyBufferChange`) — but when playback has nearly caught the frontier,
batches are by definition completing slowly, so between events the playhead
sailed PAST the loaded frontier at full sim-speed. The stall then froze the
clock deep in unloaded time (blank frame, truncated trails), the resume gate
re-anchored in the void, and when the gate couldn't fill within
`maxStartWaitMs` the escape hatch passed degraded — only for the next buffer
event to re-enter `buffering` for another 8 s freeze: a freeze/lurch
heartbeat. Three additions close this (all in `playback-governor.ts`):

1. **Tick-driven stall detection.** The governor subscribes to `tick` and
   re-probes runway + low watermark every 200 ms of wall time from the clock
   itself — a quiet network can no longer blind it.
2. **Frontier clamp.** The probe caches the buffered frontier as an absolute
   sim-time bound (`bufferedUntil`); a playhead that crosses it is snapped
   back and stalls ON loaded data — video-player semantics (`currentTime`
   never exceeds the buffered end). Overruns larger than ~1 wall-second ×
   |speed| are treated as external seeks and never snapped.
3. **Degraded creep.** After an escape-hatch (degraded) resume, the low
   watermark is suppressed and the clamp pins playback to the frontier, so it
   advances at data-arrival rate — the optimum under a sustained throughput
   deficit — instead of looping 8 s freezes. Normal stalling re-arms once the
   runway recovers past the resume gate (`isCreeping` exposes the mode to
   UIs). A committed seek now also freezes the clock *before* moving it, so
   the clamp can never misread a seek target.

### WS-C: Seek & scrub overhaul

1. **Drag vs. commit**: while the slider is being dragged (pointerdown→up),
   update only the clock/uniform — instant feedback from whatever is resident.
   Commit the seek (tileset update + fetch) on release or after the position
   is stable ~200 ms. Today every `onChange` is a full seek.
2. **Post-seek gate**: a committed seek during playback enters `buffering` and
   resumes at **startGate** (small), not the full steady-state target.
3. **Abort harder**: on commit, cancel in-flight priority requests for the old
   window (exists, batch-granular) and *flush the prefetch queue* (currently
   prefetch is never cancelled, so a seek competes with stale prefetch for
   the 24-request pool).
4. **Storyboard tier** (follow-up, biggest seek-UX win): eagerly load an
   always-resident coarse tier — z0/z1 tiles for the full time range, or the
   existing opt-in summary tier — so scrubbing *always* renders a meaningful
   preview, video-thumbnail style. Honors the no-thinning principle: it's a
   preview during scrub, full data renders on settle. Needs a byte budget
   check per dataset (z0 across all buckets can be large for some datasets —
   satellites z0 is 17 MB *per tile*; gate on `estimateCost`).

### WS-D: Adaptive speed (explicitly opt-in, last in the hierarchy)

The video lesson: adapt other things first. Our hierarchy when sustained
throughput < consumption rate:

1. Prefetch harder / earlier (governor already does this implicitly).
2. Stall honestly with ETA (WS-B).
3. **"Auto" speed preset** in the speed control: compute the max sustainable
   speed as `throughput / bytesPerSimMs(viewport, upcoming range)` (both
   measurable per WS-A), apply a 0.7 safety factor, snap to a sane step, and
   *show it* ("Auto 2.5×"). Re-evaluate on a slow cadence (≥5 s) with
   hysteresis so it doesn't flap. Never silently change a user-chosen speed;
   at most show a hint ("network can't sustain 10× — try Auto").

This replaces the per-beat hand-tuned `speedDays` guards in stories: a story
beat can declare `speed: 'auto', max: 130` instead of hard-coding to the
author's network.

### WS-E: Loader hardening (small, independent)

- Retry with exponential backoff + jitter on range-request failure (2–3
  attempts) before surfacing `onTileError`; today one transient 5xx silently
  drops tiles and the coverage index would mark the bucket permanently missing.
- Per-tile abort within a batch is unnecessary (coalesced ranges are shared),
  but a failed coalesced range should re-enqueue its member tiles individually.
- Time-proximity ordering inside the priority queue (currently FIFO within
  tier) — cheap sort at enqueue, matters under constrained pools.

### Sequencing & effort

| Step | Depends on | Size |
|---|---|---|
| A1–A4 coverage index + runway + cost API | — | M (core, well-tested area) |
| A5 throughput EWMA | — | S |
| B governor + showcase UI + workaround deletion | A | M |
| C1–C3 scrub/commit + post-seek gate + prefetch flush | B | S–M |
| C4 storyboard tier | A, C1 | M (needs per-dataset budget eval) |
| D auto speed | A, B | S–M |
| E hardening | — | S (can land first) |

Definition of done for the headline fix (A+B+C1–3): on a throttled connection
(DevTools "Fast 3G"), every showcase demo (a) shows a buffering state instead
of empty frames, (b) starts within ~2 s or shows an ETA, (c) never advances the
playhead into unloaded time, (d) resumes from seeks within the post-seek gate
without blank frames, and (e) runs at full intended speed on a fast connection
with `PLAYBACK_SLOWDOWN` deleted.

## 5. Open questions

- **Readiness definition vs. parent fallback**: is a bucket "ready" if only
  parent-zoom tiles are resident? Proposal: primary zoom required for `playing`;
  parents suffice for scrub preview. Revisit if startGate feels slow at high zoom.
- **MapLibre parity**: governor lives where TimeController lives today
  (deck.gl package). The maplibre adapter drives `tileset.update()` per render
  frame with its own clock — decide whether to lift TimeController + governor
  into core (cleaner) or duplicate (faster). Leaning: lift to core.
- **GPU-side readiness**: WS-A measures network readiness only. Decode/upload
  cost can also stall frames on heavy datasets; out of scope here, but the
  governor's state machine has room for a `decoding` input later.
