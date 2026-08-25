# PlaybackGovernor

The `PlaybackGovernor` is the buffering state machine between user intent and the [`TimeController`](./time-controller.md). The TimeController stays a plain wall-clock × speed rAF clock; the governor wraps it and adds the loader coupling a video player has:

- it **gates `play()`** on a buffered runway ahead of the playhead,
- it **freezes the clock** (instead of advancing into unloaded time) when the runway drains,
- it applies **resume hysteresis** (a `resumeFactor ×` gate after a stall, plus the anti-flap rule below) so one honest stall replaces a burst of micro-stalls — it bounds oscillation rather than abolishing it: a link whose throughput sits right at the consumption rate still alternates stall and resume at the hysteresis period,
- it turns seeks/scrubs into **preview-vs-commit** operations with a post-seek gate,
- it **clamps the playhead to the buffered frontier**, so a stall always lands on fully-loaded data — never on a blank frame deep in unloaded time. The cached frontier can be up to one probe interval (200 ms) old, so a crossing is re-probed _at the frontier_ before it snaps or gates: a bucket that landed inside that window is found and the clock plays on (audit B6).

All thresholds are denominated in **wall-clock milliseconds × current |speed|**, because playback speed multiplies the data-consumption rate: 2 s of runway at 1× is 2 sim-seconds; at a 65-sim-days-per-real-second sweep it is ~130 sim-days. A speed change is therefore a re-plan event.

> **New integrations:** [`SttPlayer`](./stt-player.md) is the recommended single entry point — it wires a `TimeController` and `PlaybackGovernor` together for you. Both remain the underlying pieces and are fully usable standalone as documented here.

## Installation

```typescript
import { PlaybackGovernor, TimeController } from '@poopdeck.gl/playback';
```

## Usage

```typescript
const timeController = new TimeController({
  initialTime: range.start,
  speed: 86_400_000 / 1000, // 1 day per second
  loop: true,
  timeRange: range,
});

const governor = new PlaybackGovernor(timeController);

new AnimatedTripsLayer({
  data: manifestUrl,
  timeController,
  // The tileset satisfies the governor's BufferSource contract:
  onTilesetReady: (tileset) => governor.setSource(tileset),
  // Push-path: buffer events re-evaluate gates immediately (vs the 250 ms poll):
  onBufferChange: (runway) => governor.notifyBufferChange(runway),
});

// Drive playback through the governor, never the controller directly:
playButton.onclick = () => governor.requestPlay();
pauseButton.onclick = () => governor.requestPause();

// Scrubbing: preview is free, release commits a seek.
slider.onpointerdown = () => governor.beginScrub();
slider.oninput = (e) => governor.scrubTo(+e.target.value);
slider.onpointerup = (e) => governor.endScrub(+e.target.value);

// UI feedback
governor.on('statechange', (state) => setBadge(state));
governor.on('waiting', ({ etaMs }) => showSpinner(etaMs));
governor.on('ready', ({ degraded }) => hideSpinner());
governor.on('progress', (runway) =>
  updateBufferBar(governor.getBufferedRanges()),
);
```

## The BufferSource contract

The governor never imports `@poopdeck.gl/core` — it consumes a structural readiness/cost oracle. `SpatioTemporalTileset` satisfies it (see the [buffer model](./spatiotemporal-tileset.md#buffer-model-player-buffering)); tests drive it with a plain object.

```typescript
interface BufferSource {
  getBufferedRunway(time, direction, horizonSimMs?): BufferedRunway;
  getBufferedRanges(opts?): Array<{ start: number; end: number }>;
  estimateCost(range): { bytes: number; tiles: number };
  estimateTimeToReadyMs(range): number | null;
  flushPrefetch(): void;
  // Optional: asserted while a gate holds the clock frozen, so the loader
  // keeps prefetching ahead (otherwise a frozen clock reads as "paused",
  // prefetch stops, and the gate could never fill its own runway).
  setAnimationState?(isAnimating: boolean, speed?: number): void;
  // Optional: the interactive/motion bit — true from beginScrub until
  // endScrub. A loader MAY serve a cheaper preview tier while it is held
  // (coarser spatial zoom and/or a coarser temporal-LOD bucket) and MUST
  // restore its settle tier when it clears. Preview-only by contract:
  // readiness reporting stays honest about the fine tier, so gates on release
  // re-arm against full detail.
  setInteractive?(interactive: boolean): void;
}
```

A source missing `getBufferedRunway` is rejected with a console warning and gating degrades to the `maxStartWaitMs` escape hatch.

Across the scrub bracket (`beginScrub` … `endScrub`) the governor broadcasts `setInteractive(true)` then `setInteractive(false)` to **every** registered source (required and optional). The bit is also re-asserted when a source is added/removed/replaced mid-drag and cleared if the governor is disposed mid-drag, so a custom loader that implements `setInteractive` never gets stranded on its degraded preview tier.

## States

| State       | Meaning                                                                                                          |
| :---------- | :--------------------------------------------------------------------------------------------------------------- |
| `idle`      | Paused (user intent is "not playing").                                                                           |
| `starting`  | User pressed play; waiting for the start gate.                                                                   |
| `playing`   | Clock running.                                                                                                   |
| `buffering` | Runway drained mid-playback; clock frozen, waiting for the resume gate.                                          |
| `seeking`   | A committed seek (or loop wrap) while intent is "playing"; clock frozen, waiting for a plain startup-sized gate. |

## Gates and hysteresis

- **Start gate**: playback begins when the runway covers `startGateWallMs × |speed|` of sim-time (or the runway is `complete`).
- **Low watermark**: while playing, the clock freezes (`buffering`) when the runway drops under `lowWatermarkWallMs × |speed|` and is not complete. The check is **tick-driven** (every ~200 ms of clock time), so a quiet network with no buffer events cannot blind it.
- **Resume gate**: after a stall, resuming requires `resumeFactor ×` the start gate (ExoPlayer-style hysteresis) — one honest stall instead of many micro-stalls.
- **canplaythrough predictor**: a gate/watermark also passes when the MISSING remainder of its window is predicted (cost ÷ throughput) to download in less wall time than the already-buffered runway plays out (floored at 250 ms) — so a cold seek on a fast network starts instantly instead of waiting for a speed-scaled runway. Conservative when blind: never passes while the throughput estimator has no samples.
- **Escape hatch**: if a gate hasn't passed after `maxStartWaitMs`, playback starts anyway, flagged `degraded` — a broken network must never hard-lock playback.
- **Anti-flap**: the watermark never stalls into a state the resume gate would open again on the spot — before freezing the clock it asks whether a `resumeFactor ×` gate would pass right now, and if it would, playback simply continues. The two checks measure the same question over different windows and can reach it by different predicates (the predictor, a probe capped at its own horizon), so they can genuinely disagree; a stall that resumes in the same instant is not a stall but a pause + a play, once per tick. Measured on `flights` at 250 kbps: 1054 stalls totalling 59 ms (i.e. all of them zero-length) became one honest 8 s stall. A standing disagreement is reported once on the console rather than smoothed away silently.
- **Scrub hold**: no gate can pass — and the escape hatch never fires — while the scrubber thumb is held (degraded playback under a held thumb is worse than a longer-held preview). A settle-commit (`seekTo` during a scrub) warms the pipeline, but playback resumes only on `endScrub`; releasing on the settle-committed position skips the duplicate commit (no second prefetch flush + gate) and re-bases the escape-hatch clock.

## Frontier clamp and degraded creep

While playing, the governor re-probes the **buffered frontier** (the absolute sim-time the contiguous loaded span reaches) every ~200 ms. If the playhead crosses it — possible at high sim-speeds between probes — the clock is snapped back to the frontier and stalled THERE, so the frozen frame renders fully-loaded data with its trail intact. An overrun bigger than `|speed| × 1 s` is treated as an external seek and never snapped back.

When a gate passed via the escape hatch, the runway by definition could not fill (sustained throughput deficit). Re-entering `buffering` would just freeze for another `maxStartWaitMs` and lurch, repeatedly. Instead the governor enters **degraded creep**: the low-watermark stall is suppressed and the per-tick clamp pins the playhead AT the frontier, so playback advances exactly as fast as data arrives. Surfaced via `isCreeping`; normal stalling re-arms automatically once the runway recovers past the resume gate.

## Loop wraps

A `loop: true` wrap is a teleport-seek the clock performed on its own — the resident tile window and cached frontier are both invalid. The governor subscribes to the controller's `wrap` event and routes it through the same commit path as a user seek: flush stale prefetch, re-gate at the PLAIN startup gate (`seeking`). A wrap into fully-cached time passes the gate synchronously (no visible pause); a wrap into time that is not resident holds a `seeking` gate until the loop start fills — one gate-fill per lap, rather than an ungated blind window followed by a stall.

Whether the loop start _is_ resident is the loader's business, not the governor's. Today the tileset's prefetch planner is not loop-aware (its horizon runs past the range end into nothing), so on any archive whose timeline exceeds the tile cache the loop start has usually been evicted by the time the wrap lands and every lap pays the `seeking` gate (typically 0.5–3 s on a CDN; up to `maxStartWaitMs` plus creep on a slow link). Small, fully-resident archives loop seamlessly. Loop-aware prefetch (planning the remainder of the horizon from `loopRange.start`) is landing in the tileset separately; the governor side needs no change for it. A wrap counts as a `seeking` gate entry in the QoE counters but not as a seek.

## Constructor

```typescript
new PlaybackGovernor(timeController: TimeController, opts?: PlaybackGovernorOptions)
```

| Option               | Type                       | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| :------------------- | :------------------------- | :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`             | `BufferSource \| null`     | `null`  | The readiness oracle. Arrives async in real apps — set later via `setSource()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `startGateWallMs`    | `number`                   | `2000`  | Wall-clock ms of runway required to start (or resume after a seek): required runway = `startGateWallMs × \|speed\|` sim-ms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lowWatermarkWallMs` | `number`                   | `600`   | Stall threshold while playing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `resumeFactor`       | `number`                   | `2`     | Resume-gate multiplier after a stall.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `seekSettleMs`       | `number`                   | `200`   | How long a scrub position must rest before a UI should commit it as a real seek. The governor doesn't run this timer — it's exposed (as the readonly `seekSettleMs` field) so scrubbing UIs share one knob.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `maxStartWaitMs`     | `number`                   | `8000`  | Escape hatch: start degraded if a gate hasn't passed by then. Timed from the gate entry, or from the first `addSource` when the registry was empty at `requestPlay` (embed autoplay before the tileset exists); with no source registered — and none offered — the hatch does not run at all, since there is no runway to be degraded about.                                                                                                                                                                                                                                                                                                           |
| `getThroughput`      | `() => ThroughputEstimate` | `null`  | Optional throughput getter for `getAutoSpeedSuggestion`; when absent the governor implies one from the source's own `estimateTimeToReadyMs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `runwayToleranceMs`  | `number`                   | unset   | Multi-source cadence tolerance band (see [Multiple sources](#multiple-sources-n-source-gate)). Wall-ms × \|speed\|; a required source within this of the leading required frontier is not counted as starved. **Authoring it pins the band globally** (`0` = exact raw-min gating). **Left unset**, the band is derived per source from the buckets the sources declare — `τᵢ = max(Δᵢ, Δ_L) + 200 ms × \|speed\|` — and only applied while the leading source is measurably inside the probe horizon; against a leader pinned at the probe cap (every healthy leader at the watermark or gate probe) the band is the 200 ms × \|speed\| wall default. |

## Methods

### User intent

| Method           | Description                                                                                                                                                                                                                                                                                                                                                                                               |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestPlay()`  | User pressed play. Gates the start on the buffered runway. While `ended`, restarts from the range start (the range end when travelling in reverse) — the media-element replay convention.                                                                                                                                                                                                                 |
| `requestPause()` | User pressed pause. Sticks even while a gate is in progress.                                                                                                                                                                                                                                                                                                                                              |
| `beginScrub()`   | Scrubber grabbed: freezes the clock; everything until `endScrub` is preview-only (no fetch churn). **Idempotent** — a second grab of an already-held thumb is the same drag. Fires `scrubstart` and broadcasts `setInteractive(true)` to every source.                                                                                                                                                    |
| `scrubTo(time)`  | Preview a scrub position — moves the clock so resident tiles render, WITHOUT committing a seek.                                                                                                                                                                                                                                                                                                           |
| `endScrub(time)` | Scrubber released — commits the final position as a real seek. Broadcasts `setInteractive(false)` and fires `scrubend` before the commit (so a scrub-LOD loader restores its fine tier first, and the flush + post-seek gate measure full detail). Releasing on a position a settle-commit already committed skips the duplicate commit and just lifts the scrub hold (re-basing the escape-hatch clock). |
| `seekTo(time)`   | Programmatic committed seek (keyboard arrows, story beats). Flushes prefetch, moves the clock, re-gates if intent is playing. Mid-scrub it acts as the settle-commit: the pipeline warms, but playback resumes only on `endScrub`.                                                                                                                                                                        |

### Wiring and queries

| Method                                        | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `addSource(id, source, {required?, weight?})` | Register (or replace) one classified source in the N-source registry (see [Multiple sources](#multiple-sources-n-source-gate)). `required` (default `true`) gates the clock; optional sources never gate but still load and count toward cost/ETA. `weight` (default `1`) is the source's BASE bandwidth share for the shared scheduler; while playing, the governor re-weights required sources around it (see the fair-share fill under [Multiple sources](#multiple-sources-n-source-gate)). A source lacking `getBufferedRunway` is rejected with a console warning (and still arms the escape hatch — the documented degrade for a loader predating the API). Registering the first source into an empty registry re-bases the escape-hatch clock. |
| `removeSource(id)`                            | Drop a source from the registry by id (no-op if absent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `setSource(source)`                           | Back-compat single-source shim: clears the registry and (when non-null) registers `source` as the required `'default'` source. New code should prefer `addSource`/`removeSource` so overlays can be classified. The governor may sit in `starting` with no source — it passes the gate the moment the required set proves readiness, or starts degraded `maxStartWaitMs` after the first source registered (never with an empty registry).                                                                                                                                                                                                                                                                                                              |
| `notifyBufferChange(runway)`                  | Consumer-forwarded buffer event (layer `onBufferChange` → here). Re-emits as `progress` and triggers an immediate gate/stall evaluation in addition to the 250 ms gated cadence. While playing, the frontier walk (and the fairness pass that rides it) is coalesced to one per 200 ms probe interval per source — N sources each firing 10 Hz buffer events no longer cost O(N²) runway walks per second (audit G6); the stall check itself runs on every event.                                                                                                                                                                                                                                                                                       |
| `getEtaMs()`                                  | Honest ETA (wall-ms) until the current gate window is ready; `null` when unknown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `getBufferedRanges(opts?)`                    | Passthrough to the source (for a buffered-bar UI); `[]` without a source.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `getSourceRunways()`                          | Per-source `{ id, required, runwaySimMs, complete, bytesPending }[]` snapshot for a multi-track buffered bar (the gating source is the `min` over required); `[]` with no sources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `estimateCost(range)`                         | Byte/tile cost of making `range` fully buffered for the current viewport (passthrough to the source's directory math; zeros without a source). UIs use it for ETA chips and timeline density strips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `getQoeStats()`                               | Snapshot of the session's QoE counters (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getAutoSpeedSuggestion()`                    | Maximum sustainable playback speed (see below); `Infinity` when the upcoming horizon has nothing left to load, `null` when unknown.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `dispose()`                                   | Detach from the TimeController and stop all timers. The clock is left as-is. Calling intent methods after dispose warns once and no-ops (React StrictMode note: create the governor inside an effect so a remount gets a fresh instance).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Properties

| Property       | Type                    | Description                                                                                                                                                                                                                                                                                       |
| :------------- | :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`        | `PlaybackGovernorState` | Current machine state.                                                                                                                                                                                                                                                                            |
| `paused`       | `boolean`               | User intent, HTMLMediaElement-shaped: true when the user does not want playback. Stays `false` through `starting`/`buffering`/`seeking` gates (the user pressed play; the machine is just not there yet), so UIs can drive the play/pause glyph from this single bit instead of mirroring intent. |
| `ended`        | `boolean`               | True while parked at a non-looping range boundary (media-element `'ended'`). Cleared by any committed seek; `requestPlay()` while ended restarts from the range start.                                                                                                                            |
| `isCreeping`   | `boolean`               | True while in degraded creep (playing pinned to the frontier at data-arrival rate).                                                                                                                                                                                                               |
| `isScrubbing`  | `boolean`               | True while the scrubber is held (`beginScrub` … `endScrub`) — the same bit that suppresses gates internally, exposed so UIs/loaders can observe the drag bracket.                                                                                                                                 |
| `isDisposed`   | `boolean`               | True once `dispose()` has run.                                                                                                                                                                                                                                                                    |
| `seekSettleMs` | `number`                | The shared scrub-settle knob.                                                                                                                                                                                                                                                                     |

## Events

```typescript
governor.on('statechange', (state: PlaybackGovernorState) => {});
governor.on('waiting', ({ state, etaMs }: GovernorWaitingEvent) => {});
governor.on('ready', ({ degraded }: GovernorReadyEvent) => {});
governor.on('progress', (runway: BufferedRunway) => {});
governor.on('ended', (time: number) => {});
governor.on('scrubstart', (time: number) => {});
governor.on('scrubend', (time: number) => {});
```

`waiting` fires whenever a gate is entered (the clock is frozen) with an honest `etaMs` when computable; `ready` fires when a gate passes and the clock starts (`degraded: true` when the escape hatch fired). `progress` re-emits forwarded buffer events. `ended` fires when playback parks at a non-looping range boundary (media-element `'ended'` — distinct from a user pause; show a replay affordance). `scrubstart` fires when the scrubber is grabbed (payload: the playhead at the grab) and `scrubend` when it is released (payload: the committed position) — across that bracket the governor broadcasts `setInteractive(true/false)` to every source, so a scrub-LOD loader can drive a cheaper preview tier during the drag. `on()` returns an unsubscribe function; `off(event, callback)` also works:

```typescript
const unsubscribe = governor.on('statechange', (state) => setBadge(state));
// later (e.g. effect cleanup):
unsubscribe();
```

Every transition is also pushed on the telemetry `playback` probe channel (`__sttProbe.playback`) as `{ event: 'statechange' | 'waiting' | 'ready', state, etaMs?, degraded?, ...PlaybackQoeStats }`.

## QoE counters

`getQoeStats()` returns Conviva-style playback quality counters, accumulated on the governor's own state transitions for its lifetime (one governor per mounted player). In-progress stall/creep spans are included in snapshots, so a probe can read mid-stall.

```typescript
interface PlaybackQoeStats {
  stallCount: number; // mid-playback rebuffer events (entries into 'buffering')
  totalStallMs: number; // cumulative wall ms in 'buffering'
  stallMs: number; // the same figure under the tile-loading audit's canonical name
  startupMs: number | null; // wall ms the most recent start gate took
  degradedResumeCount: number; // 'ready' events via the escape hatch
  creepMs: number; // cumulative wall ms in degraded creep
  seekCount: number; // committed seeks (seekTo / endScrub / replay) — loop wraps are not seeks
  seekSettleMsP50: number | null; // median wall ms from a committed seek to its gate passing (last 64)
  gateEntriesByReason: { starting: number; buffering: number; seeking: number }; // every clock freeze, by why
  frontierSnapBacks: number; // backward snaps to the frontier on the clamp path (creep pins excluded)
  blockedPermanentlyCount: number; // sources whose runway flipped to a permanent block (played through)
}
```

A CI probe asserting `stallCount` stays bounded catches freeze/lurch failure modes that unit-level state-machine tests cannot see; `frontierSnapBacks` separates the probe-staleness micro-stalls (each is a visible backward jump) from honest watermark stalls, and `gateEntriesByReason.buffering` always equals `stallCount`.

The same fields are published as the `playback.state` probe snapshot (`__sttProbe.snapshots['playback.state']`, alongside `playheadMs` / `speed` / `direction` / `animating`) on every transition and every buffer pulse, so a harness whose measurement window contains no transition still gets a reading. The counters are cumulative over the governor's lifetime; a windowed figure is the difference of two readings.

## Auto speed

`getAutoSpeedSuggestion()` returns the maximum sustainable playback speed (TimeController units — sim-ms per wall-ms) the measured network can feed, derived from the byte cost of the next 8 wall-seconds at the current speed with a 0.7 safety factor (ABR-style). Returns `Infinity` when the upcoming horizon has nothing left to load (everything buffered ⇒ the network imposes no cap) — consumers clamp it to their max step via `decideAutoSpeedMultiplier`, so a fully-cached dataset rises to full speed instead of freezing at whatever multiplier Auto last chose. Returns `null` when the math cannot be honest: throughput unknown, or tiles pending whose byte sizes the directory doesn't expose.

Consumers apply the snapping/clamping/asymmetry via the shared policy in `decideAutoSpeedMultiplier` (exported from `@poopdeck.gl/playback`): **downshifts apply immediately with no deadband; upshifts are damped** (cadence-only, and only past a 25 % relative deadband), and the result snaps to a preset-like step list (default: the exported `SPEED_STEPS` ladder, 0.25–10×; override via an optional fourth `{ steps, minMultiplier, maxMultiplier, upshiftDeadband }` argument). It returns `null` to hold the current multiplier.

```typescript
import { decideAutoSpeedMultiplier } from '@poopdeck.gl/playback';

const raw = governor.getAutoSpeedSuggestion();
if (raw != null) {
  const next = decideAutoSpeedMultiplier(
    currentMultiplier,
    raw / baseSpeed,
    phase, // 'cadence' (periodic timer) or 'waiting' (gate entered — downshift-only)
  );
  if (next != null) timeController.setSpeed(baseSpeed * next);
}
```

## Multiple sources (N-source gate)

A single governor can gate one shared clock on **N composited sources** — a story
or cockpit overlaying several datasets on one playhead. Register each with
`addSource(id, source, { required, weight })`; the gate folds over the **required**
subset:

- **runway** = `min` `simMs` over required — the clock waits for the slowest
  required source (MSE's `HAVE_ENOUGH_DATA` = all active buffers ready);
- **complete** = **AND** over required — never stall on a finished source;
- **ETA** = `max`, **cost** = `Σ` over the contributing sources.

**Optional** sources (`required: false`) never gate — they continue-and-degrade:
they load and render what's resident and still count toward cost/ETA, but a lagging
optional source never freezes the clock. Classify lightweight overlays optional and
heavy base layers required so the playhead locks to the data that matters. With zero
required sources the clock never stalls.

**Cadence tolerance band (`runwayToleranceMs`).** Sources with different temporal
chunking almost never share a buffered horizon, so a raw `min()` spuriously stalls
the instant the fastest-cadence source's runway dips a few ms below a peer (the W3C
Bug 26436 misfire — this is _not_ an inherited MSE mechanism; STT implements it). A
required source within the band of the leading required frontier is treated as if it
reached the leader before the `min`. Authoring `runwayToleranceMs` pins the band at
that many wall-ms × |speed| for every source (`0` reproduces exact raw-min gating).
Left unset — the default — the band is derived per source from the buckets the
sources declare via `getTemporalBucketMs()`: `τᵢ = max(Δᵢ, Δ_L) + 200 ms × |speed|`
(the 200 ms is the tick-probe interval, the governor's own observation resolution;
sources that declare nothing get exactly that). The derived widening is applied only
while the leader is _measurable_ — its runway inside the horizon the probe asked for.
The watermark and gate probes cap what a source reports at their own window (floored
at the source's bucket), so a healthy leader there reads exactly the cap and says
nothing about how far ahead it really is; measured against such a leader, a
bucket-sized band lifted every laggard — a starved one included — and the min-gate
degenerated to a max-gate on every bucket-coarse composite. Against a capped leader
the band is the 200 ms × |speed| default, so genuine stall protection is never below
the authored-default fold.

**Fair-share re-weighting (`setBandwidthWeight`).** The registered `weight` is a
BASE. On every frontier probe while playing (and at the gated cadence while gated),
each incomplete required source is priced by the bytes it still has to buy to reach
the leader, `Nᵢ = βᵢ × max(0, (r_lead − slack) − rᵢ)`, with `βᵢ` its byte density at
its own frontier (`estimateCost` over one bucket, memoised per bucket), and its
scheduler weight is set to

`wᵢ = baseᵢ × clamp(4 × Nᵢ / maxⱼ Nⱼ, 0.25, 4)`

— the neediest source lands on `4 × base`, a source already within the slack band
sheds to `0.25 × base`, optional and complete sources stay at base. Leaders are also
run-ahead capped at `laggard + slack` via `setPrefetchRunAheadLimit`. Both writes are
throttled to > 20 % moves, so a near-tie sends nothing. A source without
`estimateCost` bytes reads `β = 1` and degrades to the runway-only shed.

`setSource(s)` is the single-source shim: it clears the registry and registers `s` as
the required `'default'` source, so an app that never composites behaves exactly as
before.

## Shared request scheduler

By default each `SpatioTemporalTileset`'s archive opens up to its own concurrency cap
(24), and N composited archives fight for bandwidth with no shared budget. The
process-shared **`SharedRequestScheduler`** (in `@poopdeck.gl/core`) is one global
authority all archives draw from: a global `maxRequests` budget, priority-ordered by
**EDF on exact time-to-playhead** (comparable across archives sharing one playhead),
**weighted-fair** slot share (deficit round-robin over the per-source weight — the
registered base as re-weighted by the governor's fair-share fill above) so no
required source starves another, work-conserving (an idle source's slots are
reclaimed), a `done()` handshake on completion or failure, and negative-priority
cancellation for tiles the playhead has passed.

The default budget (24) equals the legacy per-archive cap, so a single-dataset scene
is unchanged (work-conservation lets one source draw all 24 slots). There is no
kill-switch — every archive draws from the shared scheduler unconditionally — so
re-tune it instead:

```typescript
import { configureSharedScheduler } from '@poopdeck.gl/core';

// Re-tune the global concurrency budget (replaces the singleton — do it at startup,
// not mid-playback). Omitted fields are left unchanged. `enabled` is not an option
// (typed `never`); the DRR rollback is `{ byteQuantum: null }`.
configureSharedScheduler({ maxRequests: 32 });
```

Design rationale (the SoTA survey, the N-source fold, the scheduler): the
[playback & loading decision record](../roadmap/playback-and-loading.md).

## Source

[packages/playback/src/playback-governor.ts](../../packages/playback/src/playback-governor.ts) ·
[packages/playback/src/auto-speed.ts](../../packages/playback/src/auto-speed.ts) ·
[packages/core/src/request-scheduler.ts](../../packages/core/src/request-scheduler.ts) ·
design doc: [`docs/roadmap/playback-and-loading.md`](../roadmap/playback-and-loading.md)
