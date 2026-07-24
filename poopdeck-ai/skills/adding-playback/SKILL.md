---
name: adding-playback
description: >-
  Add play/pause, scrubbing, speed, and buffer-aware playback to a SpatioTemporal
  Tiles map. Use when a user wants a timeline or transport bar, asks how to
  animate a .stt, how to drive currentTime, what SttPlayer / TimeController /
  PlaybackGovernor / usePlayback / PlaybackControls do, why playback stalls or
  stutters, how to set playback speed or loop a dataset, or how to keep several
  datasets on one playhead. Covers the wiring, the buffering gates, and the
  React hooks.
license: MIT
metadata:
  version: '0.5.0'
---

# Adding playback to an STT map

`@poopdeck.gl/playback` is the framework- and renderer-agnostic playback engine
(zero runtime dependencies); `@poopdeck.gl/react` is the React binding plus the
transport-bar UI. Layers **read** the clock — they never own it.

> **Doc paths** are repo-relative. With no repo on disk, use the MCP
> `get_doc`/`search_docs` tools (or the `stt://docs/<path>` resource), or fetch
> `https://poopdeck.gl/llms/<path>` — full chain in **poopdeck-overview**.
> Everything load-bearing below is inlined.

## The pieces (pick the highest one that fits)

| Piece              | What it is                                                                                       | Use it when                                        |
| ------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `TimeController`   | A dumb wall-clock × speed rAF clock. Knows nothing about loading.                                | Offline/tests, or a custom transport               |
| `PlaybackGovernor` | The buffering state machine: gates play/resume/seek on the buffered runway ahead of the playhead | You need honest stalls, scrub, multi-source gating |
| `SttPlayer`        | HTMLMediaElement-shaped facade over both — **the recommended single entry point**                | Any vanilla-JS integration                         |
| `usePlayback`      | React hook that owns a controller + governor and exposes them as state                           | Any React app (pair with `PlaybackControls`)       |

**The cardinal rule:** in a networked app never call `timeController.play()` /
`setTime()` directly — that bypasses the gates and advances the clock into
unloaded time. Drive `SttPlayer`/the governor instead.

## Vanilla: `SttPlayer` in four wires

```ts
import { SttPlayer } from '@poopdeck.gl/playback';

const player = new SttPlayer({
  timeRange: { start, end },
  baseRate: (end - start) / 60_000, // sim-ms per wall-ms → plays in ~60 s at 1×
  loop: true,
});

new AnimatedTripsLayer({
  data: manifestUrl,
  timeController: player.timeController, // 1. layers READ the clock
  onTilesetReady: (t) => player.setSource(t), // 2. the tileset IS the BufferSource
  onBufferChange: (r) => player.notifyBufferChange(r), // 3. push-path gate re-eval
});

playButton.onclick = () => (player.paused ? player.play() : player.pause()); // 4.
```

Scrubbing is a **trio** — preview is free, release commits:

```ts
slider.onpointerdown = () => player.beginScrub();
slider.oninput = (e) => player.scrubTo(+e.target.value); // no fetch churn
slider.onpointerup = (e) => player.endScrub(+e.target.value); // real seek
```

Media-element-shaped events: `timeupdate` (throttled to `timeupdateHz`, default
`4`; the internal clock still ticks every frame), `play`, `pause`, `statechange`,
`waiting` (`{ state, etaMs }` — a gate froze the clock), `ready`
(`{ degraded }`), `progress`, `ended`, `ratechange`, `scrubstart`, `scrubend`.
`on()` returns an unsubscribe function.

**Speed model:** `effective sim-ms per wall-ms = baseRate × playbackRate`. Pick
`baseRate` so the dataset plays in a target wall duration (`span / targetMs`) and
expose `playbackRate` as the user's 0.25×–10× control.

## React: `usePlayback` + `PlaybackControls`

```tsx
import { usePlayback, useDeckClock, PlaybackControls } from '@poopdeck.gl/react';
import '@poopdeck.gl/react/styles.css'; // once; no Tailwind needed in your app

const playback = usePlayback({
  timeRange: { start, end },
  baseSpeed: (end - start) / 60_000, // same units as SttPlayer's baseRate
});
const deckClock = useDeckClock(playback.timeController, playback.isPlaying);

const layers = [
  new AnimatedTripsLayer({
    id: 'trips',
    data: manifestUrl,
    onTilesetReady: (t) =>
      playback.registry.registerSource('trips', t, { required: true }),
    onBufferChange: (r) => playback.registry.onBufferChange('trips', r),
  }),
];

<DeckGL {...deckClock} layers={layers} />
<PlaybackControls {...playback} />
```

`useDeckClock` advances the clock inside deck's own render loop (one frame clock,
no phase skew) and passes the controller down `context.userData.stt`, so layers
need no `timeController` prop. `usePlayback` options: `timeRange`, `baseSpeed`
(default `1000`), `loop` (default `true`), `initialTime`; its return spreads
straight into `PlaybackControls`. Also exported:
`usePlaybackHotkeys(playback, timeRange, enabled)` — the standard Space/K, ←/→,
J/L, Home/End, ↑/↓, 0–9 map, **fullscreen surfaces only** (elsewhere Space means
"scroll") — and `HoverPreview`, on the `@poopdeck.gl/react/hover-preview` subpath,
for `PlaybackControls`' `renderPreview` render-prop. Peers: `react`/`react-dom`
`>=18`; `@deck.gl/core` + `@deck.gl/react` are **optional**, needed only for
`useDeckClock`/`HoverPreview`.

## Derive the params from the archive, don't hardcode them

```ts
import { resolvePlaybackParams } from '@poopdeck.gl/playback';

const p = resolvePlaybackParams(archiveMetadata, { targetPlaybackSeconds: 60 });
// → { timeRange, span, baseSpeed, targetPlaybackSeconds, timeWindow,
//     temporalBucketMs, frameCount, trailLength?, wakeLength? }
```

It reconciles authored overrides against the manifest: an authored sub-range
inside the archive extent is respected silently; one that spills outside is
clamped **and warned**. `deriveViewStateFromBounds` does the same for the camera.

## Tuning the gates (defaults are good; know them before changing)

| Option               | Default | Meaning                                                        |
| -------------------- | ------- | -------------------------------------------------------------- |
| `startGateWallMs`    | `2000`  | Runway required to start: `startGateWallMs × \|speed\|` sim-ms |
| `lowWatermarkWallMs` | `600`   | Mid-playback stall threshold                                   |
| `resumeFactor`       | `2`     | Resume gate multiplier after a stall (hysteresis)              |
| `maxStartWaitMs`     | `8000`  | Escape hatch — start `degraded` rather than hard-lock          |
| `seekSettleMs`       | `200`   | Shared scrub-settle knob for UIs                               |
| `runwayToleranceMs`  | `200`   | Multi-source cadence tolerance band (`0` = exact raw-min)      |

Thresholds are wall-ms **× current |speed|**, so a speed change is a re-plan
event. Pass them via `new SttPlayer({ governor: {…} })`.

## Several datasets, one playhead

Register each source and classify it: `required: true` sources gate the clock
(runway = `min`, complete = AND over the required set); `required: false`
overlays load and count toward cost/ETA but **never** freeze the playhead.

```ts
governor.addSource('base', baseTileset, { required: true });
governor.addSource('labels', labelTileset, { required: false, weight: 0.5 });
```

In React that is `playback.registry.registerSource(id, tileset, opts)` /
`unregisterSource(id)` on unmount. `setSource(s)` is the single-source shim.

## Gotchas

- **`currentTime` outside the archive's `timeRange` renders nothing.** Seed the
  playhead from the manifest — see **debugging-blank-renders**.
- **Loop wraps are seeks.** The governor routes the controller's `wrap` through
  the full commit path (flush prefetch, startup-sized gate), so a slow network
  shows a brief `seeking` at the loop boundary. For trail/window layers prefer
  `bounce: true` — a hard wrap teleports the playhead a full span in one frame
  and mass-evicts tiles (a visible flash).
- **`paused` is user intent**, not machine state: it stays `false` through
  `starting`/`buffering`/`seeking`, so drive the glyph off that one bit and the
  buffering chip off `state`.
- **Auto speed:** never apply `getAutoSpeedMultiplierSuggestion()` raw (it can be
  `Infinity`) — run it through `decideAutoSpeedMultiplier` (immediate downshifts,
  damped upshifts, snapped to `SPEED_STEPS`). Under React StrictMode create the
  governor inside an effect so a remount gets a fresh one (`usePlayback` does).
- **Nothing animating?** Either the clock isn't advancing (no rAF/`_animate`
  driver) or the window is so wide everything shows at once. Read
  `getQoeStats()` (`stallCount`, `totalStallMs`) before blaming the renderer.

Refs: `docs/api/stt-player.md`, `docs/api/time-controller.md`,
`docs/api/playback-governor.md`, `docs/api/stt-react.md`.
