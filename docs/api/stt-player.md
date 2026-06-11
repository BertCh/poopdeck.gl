# SttPlayer

`SttPlayer` is the HTMLMediaElement-shaped facade over the [`TimeController`](./time-controller.md) and the [`PlaybackGovernor`](./playback-governor.md) — **the recommended single entry point for playback**. Underneath sit a dumb rAF clock, a buffering state machine, and the `BufferSource` oracle; the facade owns the choreography of coordinating them:

- **One driver.** Play/pause/seek/scrub all route through the governor's gates; speed routes through the controller — and you never have to remember which is which (or that calling `controller.play()/setTime()` directly bypasses the gates).
- **The `baseRate × playbackRate` speed model.** Video's literal 1× is meaningless for sim time; the data-player convention is a per-dataset base rate ("the dataset plays in its target duration") with a user-facing multiplier on top. The facade owns that split.
- **A throttled `timeupdate`.** Media elements fire `timeupdate` at ~4 Hz; the facade does the same (configurable), with an immediate emit whenever the clock freezes or a seek lands — so UIs never rest on a stale frame, and React consumers don't re-render at 60 Hz. The internal clock still advances every animation frame; layers read it directly.

The wrapped pieces stay exposed (`player.timeController` for layer wiring, `player.governor` for advanced use), so nothing the lower-level APIs can do is lost.

## Installation

```typescript
import { SttPlayer } from '@stt/deck.gl';
```

## Quick start

```typescript
const player = new SttPlayer({
  timeRange: { start, end },
  baseRate: (end - start) / 60_000, // dataset plays in ~60 s at 1×
  loop: true,
});

new AnimatedTripsLayer({
  data: manifestUrl,
  // Layers READ the clock; the player drives it.
  timeController: player.timeController,
  // The tileset is the governor's BufferSource — hand it over when it arrives:
  onTilesetReady: (tileset) => player.setSource(tileset),
  // Buffer events re-evaluate gates immediately (vs the 250 ms poll):
  onBufferChange: (runway) => player.notifyBufferChange(runway),
});

playButton.onclick = () => (player.paused ? player.play() : player.pause());

// Scrubbing: preview is free, release commits a seek.
slider.onpointerdown = () => player.beginScrub();
slider.oninput = (e) => player.scrubTo(+e.target.value);
slider.onpointerup = (e) => player.endScrub(+e.target.value);

// UI feedback — media-element shaped:
player.on('timeupdate', (t) => updateSlider(t));       // ~4 Hz + final snap
player.on('play', () => setGlyph('pause'));
player.on('pause', () => setGlyph('play'));
player.on('waiting', ({ etaMs }) => showSpinner(etaMs));
player.on('ready', () => hideSpinner());
player.on('ended', () => showReplayAffordance());
```

## HTMLMediaElement mapping

| HTMLMediaElement | SttPlayer | Notes |
| :--- | :--- | :--- |
| `play()` / `pause()` | `play()` / `pause()` | Routed through the governor's buffered-runway gates. `play()` at the ended boundary replays from the range start (media replay convention). |
| `paused` | `paused` | **User intent**: stays `false` through `starting`/`buffering`/`seeking` gates, so the play/pause glyph follows one bit. |
| `ended` | `ended` + `'ended'` event | True while parked at a non-looping range boundary (distinct from a user pause). |
| `currentTime` get/set | `currentTime` get/set | Setter = **committed seek** (prefetch flush + post-seek gate). For drags use the scrub trio — previews are free. |
| `duration` | `duration` | Range span in sim-ms. Times are absolute sim-ms (not zero-based seconds); `seekable` says where the range lives. |
| `playbackRate` | `playbackRate` | The multiplier over `baseRate`. Magnitude-only, like the media element — direction is separate (`timeController.setDirection`). |
| `seekable` | `seekable` | The configured time range; replace via `setTimeRange(range)`. |
| `buffered` | `buffered` | `governor.getBufferedRanges()` passthrough, for a buffered-bar UI. |
| `readyState` | `state` | The governor machine state (`idle`/`starting`/`playing`/`buffering`/`seeking`). |
| `'timeupdate'` (~4 Hz) | `'timeupdate'` | Throttled to `timeupdateHz`; emits immediately on pause/seek/scrub so UIs land on the final value. |
| `'waiting'` / `'canplay'` | `'waiting'` / `'ready'` | Gate entered (clock frozen) / gate passed (`degraded: true` when the escape hatch fired). |
| `'progress'` | `'progress'` | Forwarded buffer-runway events. |
| `'ratechange'` | `'ratechange'` | Fires on `playbackRate` changes only — `baseRate` re-bases what "1×" means without firing it. |

## Constructor

```typescript
new SttPlayer(options: SttPlayerOptions)
```

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `timeRange` | `{ start, end }` | required | The dataset's time range (absolute sim-ms). Drives `duration`/`seekable` and the clock's boundary behavior. |
| `initialTime` | `number` | `timeRange.start` | Initial playhead position. |
| `baseRate` | `number` | `1` | Sim-ms per wall-ms at `playbackRate` 1 — the per-dataset "1×". |
| `playbackRate` | `number` | `1` | User-facing speed multiplier. |
| `loop` | `boolean` | `false` | Wrap to the range start at the end. Wraps are routed through seek semantics by the governor (see [loop wraps](./playback-governor.md#loop-wraps)). |
| `bounce` | `boolean` | `false` | Ping-pong at the boundaries instead of wrapping (see [`TimeControllerOptions.bounce`](./time-controller.md)). |
| `timeupdateHz` | `number` | `4` | `'timeupdate'` cadence. Throttles ONLY the event — never the internal clock. |
| `governor` | `PlaybackGovernorOptions` minus `source` | `{}` | Gate/watermark/escape-hatch tuning. The source is wired via `setSource()`. |

## Methods and properties

### Playback

| Member | Description |
| :--- | :--- |
| `play()` / `pause()` | Gated play / sticky pause (see mapping table). |
| `paused` / `ended` / `state` / `isCreeping` | Intent, boundary-parked flag, governor machine state, degraded-creep flag. |
| `currentTime` get/set | Playhead; setter is a committed seek. |
| `duration` / `seekable` / `setTimeRange(range)` | Range span / window / replacement (dataset switch). |
| `playbackRate` get/set | Multiplier; setter applies `baseRate × rate` to the clock and fires `'ratechange'`. |
| `baseRate` get/set | The per-dataset "1×"; setter re-applies the effective speed without firing `'ratechange'`. |
| `buffered` | Loaded time ranges (`[]` before the source arrives). |

### Scrubbing

`beginScrub()` / `scrubTo(time)` / `endScrub(time)` — preview-vs-commit passthroughs to the governor (grab freezes the clock; previews render resident tiles with no fetch churn; release commits a real seek). The readonly `seekSettleMs` field is the shared settle-debounce knob for UIs that commit a rested thumb mid-drag.

### Plumbing and queries

| Member | Description |
| :--- | :--- |
| `setSource(source)` | Attach the readiness oracle (the tileset, from the layer's `onTilesetReady`). |
| `notifyBufferChange(runway)` | Forward the layer's `onBufferChange`; re-emitted as `'progress'`, re-evaluates gates immediately. |
| `getEtaMs()` | Honest wall-ms ETA for the current gate window; `null` when unknown. |
| `estimateCost(range)` | Byte/tile cost of buffering `range` (directory math — ETA chips, timeline density strips). |
| `getQoeStats()` | Session QoE counters (stalls, startup, creep). |
| `getAutoSpeedSuggestion()` | Raw sustainable speed in controller units (sim-ms per wall-ms). |
| `getAutoSpeedMultiplierSuggestion()` | The same suggestion ÷ `baseRate` — directly comparable to `playbackRate`. **May be `Infinity`** (fully-buffered horizon ⇒ no network cap): clamp/snap/damp via [`decideAutoSpeedMultiplier`](./playback-governor.md#auto-speed), never apply it raw. |
| `timeController` / `governor` | The wrapped pieces, for layer wiring and advanced use. |
| `destroy()` | Dispose the governor, destroy the clock, drop all listeners. Idempotent. |

## Events

```typescript
const unsubscribe = player.on('timeupdate', (time) => {});
player.on('play', () => {});            // intent became "playing" (incl. adopted external play)
player.on('pause', () => {});           // intent became "paused" (incl. external pause / range-end clamp)
player.on('statechange', (state) => {});
player.on('waiting', ({ state, etaMs }) => {});
player.on('ready', ({ degraded }) => {});
player.on('progress', (runway) => {});
player.on('ended', (time) => {});
player.on('ratechange', (rate) => {});
```

`on()` returns an unsubscribe function; `off(event, callback)` also works. At a non-looping range end, `'pause'` fires before `'ended'` (media-element ordering).

## Speed model

```
effective clock speed (sim-ms per wall-ms) = baseRate × playbackRate
```

Pick `baseRate` so the dataset plays in a target wall duration (`span / targetMs`); expose `playbackRate` to the user as the 0.25×–10× control. For Auto speed, feed `getAutoSpeedMultiplierSuggestion()` through `decideAutoSpeedMultiplier` on a cadence + on `'waiting'` — see the [governor docs](./playback-governor.md#auto-speed) for the asymmetric policy.

## Source

[packages/deck.gl/src/stt-player.ts](../../packages/deck.gl/src/stt-player.ts) ·
underlying pieces: [TimeController](./time-controller.md), [PlaybackGovernor](./playback-governor.md)
