# @poopdeck.gl/react

React playback hooks and UI controls, extracted from the showcase app. Built on
the renderer-agnostic [`@poopdeck.gl/playback`](./stt-player.md) engine (a direct
dependency, alongside `@poopdeck.gl/core`); `react`, `react-dom`, and the deck.gl
peers (`@deck.gl/core`, `@deck.gl/react` — needed only for `HoverPreview`) are
peer dependencies. The package owns the [`TimeController`](./time-controller.md) +
[`PlaybackGovernor`](./playback-governor.md) lifecycle for you and surfaces it as
reactive React state, so a host app wires layers and renders a transport bar
without re-implementing the buffering choreography.

## Install

```bash
pnpm add @poopdeck.gl/react react react-dom
# HoverPreview also needs the deck.gl peers:
pnpm add @deck.gl/core @deck.gl/react
```

## Styling

Import the shipped stylesheet once and the components render fully styled —
no Tailwind required in your app:

```ts
import '@poopdeck.gl/react/styles.css';
```

It contains the utility classes the components use (compiled at package
build; no preflight/reset, so it cannot affect the host app) plus defaults
for the theme tokens (`--accent`, `--surface`, `--ink-900`, `--ink-500`,
`--ink-400`, `--hairline`, `--accent-soft`, `--page-bg`) — override any of
them in your own CSS to re-theme. Apps that already run Tailwind v4 can skip
the stylesheet, but must register the package for scanning (Tailwind ignores
`node_modules` by default) and define those tokens themselves:

```css
@import 'tailwindcss';
@source "../node_modules/@poopdeck.gl/react/src";
```

## usePlayback

Generalizes a dataset's `{ timeRange, baseSpeed }` into full playback state. It
constructs the `TimeController` + `PlaybackGovernor`, drives a 20 Hz-throttled UI
clock (the layers read the controller directly — never this state), handles speed
and opt-in Auto speed, and exposes a `registry` that classifies every layer's
tileset into the governor's N-source gate (see [PlaybackGovernor → Multiple
sources](./playback-governor.md#multiple-sources-n-source-gate)). Returns
once-stable handlers you pass straight through as layer and `PlaybackControls`
props.

Each STT layer registers its own tileset under a stable id when it becomes
ready — `required: true` for the field/primary layer (it gates the clock),
`required: false` for optional overlays (they load but never gate). Pair
`usePlayback` with [`useDeckClock`](#usedeckclock) to drive the shared
`TimeController` from deck's own render loop and hand it to layers via
`context.userData.stt.timeController`, so no layer needs a `timeController` prop:

```tsx
import { usePlayback, useDeckClock } from '@poopdeck.gl/react';
import DeckGL from '@deck.gl/react';

const playback = usePlayback({
  timeRange: { start, end },
  baseSpeed: (end - start) / 60_000, // dataset plays in ~60 s at 1×
});
const deckClock = useDeckClock(playback.timeController, playback.isPlaying);

const layers = [
  new AnimatedTripsLayer({
    id: 'trips',
    data: manifestUrl,
    onTilesetReady: (tileset) =>
      playback.registry.registerSource('trips', tileset, { required: true }),
    onBufferChange: (runway) =>
      playback.registry.onBufferChange('trips', runway),
  }),
];

<DeckGL {...deckClock} layers={layers} />;
```

### `UsePlaybackOptions`

| Option        | Type                             | Default           | Description                                                                                                                       |
| :------------ | :------------------------------- | :---------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| `timeRange`   | `{ start: number; end: number }` | —                 | Full data span (sim-ms). Drives the clock range and the slider.                                                                   |
| `baseSpeed`   | `number`                         | `1000`            | Wall-ms → sim-ms base rate at 1× (the controller's `speed`); multiplied by the user's speed preset.                               |
| `loop`        | `boolean`                        | `true`            | Wrap to the range start at the end.                                                                                               |
| `initialTime` | `number`                         | `timeRange.start` | Initial playhead position (clamped into `timeRange`). Mount-time only — a later `timeRange` change resets to the new range start. |

### `PlaybackState` (return value)

| Member                                                           | Type                                           | Description                                                                                                                                    |
| :--------------------------------------------------------------- | :--------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeController`                                                 | `TimeController`                               | The shared animation clock. Hand it to layers via `useDeckClock`'s `userData` channel, or pass it directly as a layer's `timeController` prop. |
| `governor`                                                       | `PlaybackGovernor \| null`                     | The buffer-gating governor (null only on the first paint). Pass to `PlaybackControls`.                                                         |
| `tilesetRef`                                                     | `React.MutableRefObject<BufferSource \| null>` | Handle to the first `required` registered tileset (e.g. for polling `getVisibleTiles`).                                                        |
| `currentTime`                                                    | `number`                                       | 20 Hz-throttled UI clock (slider/label only, not the layers).                                                                                  |
| `isPlaying`                                                      | `boolean`                                      | User-intent play bit, mirrored from the governor.                                                                                              |
| `bufferState`                                                    | `PlaybackGovernorState`                        | Governor machine state (`idle`/`starting`/`playing`/`buffering`/`seeking`).                                                                    |
| `speedMultiplier`                                                | `number`                                       | Current speed multiplier over `baseSpeed`.                                                                                                     |
| `currentSpeedMultiplier`                                         | `number`                                       | Same value under `PlaybackControls`' prop name, so `<PlaybackControls {...playback} />` spreads cleanly.                                       |
| `timeRange`                                                      | `{ start: number; end: number } \| undefined`  | The `timeRange` option echoed back (for the spread).                                                                                           |
| `autoSpeed`                                                      | `boolean`                                      | Whether opt-in Auto speed mode is active.                                                                                                      |
| `overviewPreload`                                                | `OverviewPreloadResult \| null`                | Storyboard-tier preload outcome (perf HUD).                                                                                                    |
| `baseAnimationSpeed`                                             | `number`                                       | The resolved `baseSpeed` (defaulted to 1000).                                                                                                  |
| `onPlayPause` / `onSeek` / `onSpeedChange` / `onAutoSpeedSelect` | handlers                                       | Transport callbacks for `PlaybackControls`.                                                                                                    |
| `play` / `pause`                                                 | `() => void`                                   | Imperative play/pause for visibility-driven embeds.                                                                                            |
| `registry`                                                       | `SourceRegistry`                               | Multi-source registration API for the governor — see below. Wire each layer's `onTilesetReady`/`onBufferChange` through it.                    |
| `handleOverviewPreload`                                          | `(result: OverviewPreloadResult) => void`      | Pass as the layer's overview-preload callback.                                                                                                 |

### `SourceRegistry`

The registry classifies every layer's tileset into the governor's N-source gate
(one call per layer, keyed by a stable id — typically the layer's deck.gl `id`),
so the clock waits for every `required` source while optional overlays load
without gating it.

| Member                               | Type                                                                                          | Description                                                                                                                                                                    |
| :----------------------------------- | :-------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerSource(id, tileset, opts?)` | `(id: string, tileset: BufferSource, opts?: { required?: boolean; weight?: number }) => void` | Register (or replace) one source. `required` (default `true`) gates the clock; `weight` (default `1`) is a bandwidth-share hint. Call from the layer's `onTilesetReady`.       |
| `unregisterSource(id)`               | `(id: string) => void`                                                                        | Drop a source by id (no-op if absent) — call on layer unmount.                                                                                                                 |
| `onBufferChange(id, runway)`         | `(id: string, runway: BufferedRunway) => void`                                                | Forward the layer's `onBufferChange`. The governor re-probes every registered source itself, so `runway` is advisory — it just triggers an immediate gate/stall re-evaluation. |

`SourceRegistry` mirrors `PlaybackGovernor.addSource`/`removeSource`/
`notifyBufferChange` one-to-one; see [PlaybackGovernor → Multiple
sources](./playback-governor.md#multiple-sources-n-source-gate) for the full
gating semantics.

## useDeckClock

Binds a `TimeController` to a deck.gl render surface so the playhead advances
inside deck's own animation loop instead of on its own `requestAnimationFrame`
— one frame clock, no phase skew between "time advanced" and "scene drawn".
Returns props to spread straight onto `<DeckGL>`. Kept separate from
`usePlayback` so non-deck consumers (maplibre, three, a standalone canvas) can
keep driving the same `TimeController` off its self-owned rAF instead.

```tsx
import { usePlayback, useDeckClock } from '@poopdeck.gl/react';
import DeckGL from '@deck.gl/react';

const playback = usePlayback({ timeRange, baseSpeed });
const deckClock = useDeckClock(playback.timeController, playback.isPlaying);

<DeckGL {...deckClock} layers={layers} />;
```

`useDeckClock(timeController: TimeController, isPlaying: boolean): DeckClockProps`

### `DeckClockProps`

| Prop             | Type                                          | Description                                                                                                                                                                              |
| :--------------- | :-------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_animate`       | `boolean`                                     | deck.gl's unconditional-redraw flag. `true` while playing, so `onBeforeRender` fires every frame; `false` while paused (seeks and interactions still redraw through deck's normal path). |
| `onBeforeRender` | `() => void`                                  | Advances `timeController` by one frame, in lockstep with deck's render loop.                                                                                                             |
| `userData`       | `{ stt: { timeController: TimeController } }` | The `context.userData.stt` channel every STT layer reads time from, so layers need no per-layer `timeController` prop.                                                                   |

## usePlaybackHotkeys

Installs the standard video-player keyboard map as a single window-level
`keydown` listener. Mount it **only on a fullscreen surface** — on scrolling or
embed pages, Space means "scroll the page". It is inert when disabled, when no
time range is known, when the event was already handled, when a meta/ctrl/alt
modifier is held, or when focus is in a form field / contenteditable (including
the scrubber).

```typescript
import { usePlaybackHotkeys } from '@poopdeck.gl/react';

usePlaybackHotkeys(playback, timeRange, isFullscreen);
```

`usePlaybackHotkeys(playback: PlaybackState, timeRange: { start, end } | undefined, enabled = true)`

| Key            | Action                                        |
| :------------- | :-------------------------------------------- |
| `Space` / `K`  | Toggle play–pause                             |
| `←` / `→`      | Committed seek −/+2 % of the range            |
| `J` / `L`      | Committed seek −/+10 % of the range           |
| `Home` / `End` | Jump to range start / end                     |
| `↑` / `↓`      | Step speed up / down the shared preset ladder |
| `0`–`9`        | Jump to N×10 % of the range                   |

Held keys auto-repeat; committed seeks are rate-capped to ~6/s so a held arrow is
a stream of seeks, not a `flushPrefetch` storm.

## PlaybackControls

The transport-bar UI: play/pause + restart, a drag-aware scrubber with a buffered
bar, hover timestamp, ETA chip, a data-volume density strip, speed presets + fine slider + Auto, and an optional hover-preview toggle. Drag-scrubbing talks to
the governor directly (`beginScrub`/`scrubTo`/`endScrub`); committed seeks route
through `onSeek` so the page owns the commit path.

`usePlayback`'s return is spread-compatible — it echoes `timeRange` and
exposes the speed under both `speedMultiplier` and `currentSpeedMultiplier`:

```tsx
import { PlaybackControls } from '@poopdeck.gl/react';

<PlaybackControls {...playback} />;
```

Or pass the props individually to interpose on any of them:

```tsx
<PlaybackControls
  currentTime={playback.currentTime}
  timeRange={timeRange}
  isPlaying={playback.isPlaying}
  bufferState={playback.bufferState}
  governor={playback.governor}
  onPlayPause={playback.onPlayPause}
  onSeek={playback.onSeek}
  onSpeedChange={playback.onSpeedChange}
  currentSpeedMultiplier={playback.speedMultiplier}
  targetPlaybackSeconds={60}
  autoSpeed={playback.autoSpeed}
  onAutoSpeedSelect={playback.onAutoSpeedSelect}
/>
```

### `PlaybackControlsProps`

| Prop                     | Type                                | Description                                                                                                                                       |
| :----------------------- | :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `currentTime`            | `number`                            | Current playhead (sim-ms); the throttled UI clock.                                                                                                |
| `timeRange`              | `{ start: number; end: number }`    | Full data range; drives the bar geometry and slider bounds.                                                                                       |
| `isPlaying`              | `boolean`                           | User intent — drives the play/pause glyph.                                                                                                        |
| `bufferState`            | `PlaybackGovernorState`             | Governor machine state — drives the buffering chip.                                                                                               |
| `governor`               | `PlaybackGovernor \| null`          | Scrub previews/commits target it directly; null falls back to `onSeek`.                                                                           |
| `onPlayPause`            | `() => void`                        | Toggle play/pause.                                                                                                                                |
| `onSeek`                 | `(time: number) => void`            | Committed seek (keyboard arrows on the slider, jump-to-start).                                                                                    |
| `onSpeedChange`          | `(multiplier: number) => void`      | Speed preset / slider change.                                                                                                                     |
| `currentSpeedMultiplier` | `number`                            | Active speed multiplier (lights the matching preset).                                                                                             |
| `targetPlaybackSeconds`  | `number`                            | Optional (default `60`). Wall-seconds the dataset plays in at 1× — drives the "time left" readout.                                                |
| `autoSpeed`              | `boolean`                           | Whether Auto speed mode is active.                                                                                                                |
| `onAutoSpeedSelect`      | `() => void`                        | Select Auto speed (any explicit choice exits it).                                                                                                 |
| `renderPreview`          | `(time: number) => React.ReactNode` | Optional. When supplied, a "Preview" toggle appears; hovering the scrubber renders the map at the settled hovered time. Pair with `HoverPreview`. |

## HoverPreview

The generic frozen-clock thumbnail: a second, independent `DeckGL` instance that
renders your layers at a single frozen timestamp, mirroring a supplied camera —
the render produced by `PlaybackControls`' `renderPreview` render-prop. It is
renderer-agnostic about _what_ it draws: you supply `buildLayers(controller)`
(the frozen clock is handed in so your time-filtered layers read from it), the
`viewState`/`views`, the card size, and an optional `basemapUrl` drawn behind the
transparent deck canvas. It is a second WebGL context + archive for the same
data, so mount it only while the preview is visible, keyed by source id.

It is on its **own subpath**, not in the package barrel: it value-imports the
optional `@deck.gl/core` / `@deck.gl/react` peers, and keeping it out of the
barrel is what lets `import … from '@poopdeck.gl/react'` resolve without
deck.gl installed. Importing it from the barrel throws.

```tsx
import { HoverPreview } from '@poopdeck.gl/react/hover-preview';

renderPreview={(time) => (
  <HoverPreview
    time={time}
    timeRange={timeRange}
    buildLayers={(controller) => buildDemoLayers({ dataset, controller })}
    viewState={previewViewState}
    width={264}
    height={148}
    basemapUrl={previewBasemapUrl}
  />
)}
```

### `HoverPreviewProps`

| Prop               | Type                                        | Default     | Description                                                                                |
| :----------------- | :------------------------------------------ | :---------- | :----------------------------------------------------------------------------------------- |
| `time`             | `number`                                    | —           | Settled hovered timestamp (sim-ms).                                                        |
| `timeRange`        | `{ start: number; end: number }`            | —           | Full data range; seeds the frozen clock.                                                   |
| `buildLayers`      | `(controller: TimeController) => unknown[]` | —           | Builds the layers to render; the frozen preview clock is passed in. Called once per mount. |
| `viewState`        | `unknown`                                   | —           | deck.gl viewState (camera) to render at.                                                   |
| `views`            | `unknown`                                   | —           | deck.gl views (e.g. a `GlobeView`). Omit for the default map view.                         |
| `width` / `height` | `number`                                    | —           | Card dimensions (px) — match the live viewport's aspect ratio.                             |
| `basemapUrl`       | `string \| null`                            | —           | Optional basemap image drawn behind the transparent deck canvas.                           |
| `background`       | `string`                                    | `"#242730"` | Background behind everything.                                                              |
| `parameters`       | `unknown`                                   | —           | Forwarded to DeckGL `parameters` (e.g. `{ cull: true }` on a globe).                       |

## Source

[packages/react/src](../../packages/react/src) ·
underlying engine: [SttPlayer](./stt-player.md), [TimeController](./time-controller.md), [PlaybackGovernor](./playback-governor.md)
