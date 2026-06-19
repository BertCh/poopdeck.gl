# @poopdeck.gl/react

React playback hooks and UI controls, extracted from the showcase app. Built on
the renderer-agnostic [`@poopdeck.gl/playback`](./stt-player.md) engine (a direct
dependency, alongside `@poopdeck.gl/core`); `react`, `react-dom`, and the deck.gl
peers (`@deck.gl/core`, `@deck.gl/react` — needed only for `HoverPreview`) are
peer dependencies. The package owns the [`TimeController`](./time-controller.md) +
[`PlaybackGovernor`](./playback-governor.md) lifecycle for you and surfaces it as
reactive React state, so a host app wires layers and renders a transport bar
without re-implementing the buffering choreography. Components are styled with
plain Tailwind utility classes; bring your own Tailwind build (or override via
`className`).

## Install

```bash
pnpm add @poopdeck.gl/react react react-dom
# HoverPreview also needs the deck.gl peers:
pnpm add @deck.gl/core @deck.gl/react
```

## usePlayback

Generalizes a dataset's `{ timeRange, baseSpeed }` into full playback state. It
constructs the `TimeController` + `PlaybackGovernor`, drives a 20 Hz-throttled UI
clock (the layers read the controller directly — never this state), handles speed
and opt-in Auto speed, and exposes the tileset/buffer handoff the renderer layers
call back into. Returns once-stable handlers you pass straight through as layer
and `PlaybackControls` props.

```typescript
import { usePlayback } from '@poopdeck.gl/react';

const playback = usePlayback({
  timeRange: { start, end },
  baseSpeed: (end - start) / 60_000, // dataset plays in ~60 s at 1×
});

// Wire the governor handoff into your STT layer:
new AnimatedTripsLayer({
  data: manifestUrl,
  timeController: playback.timeController,
  onTilesetReady: playback.handleTilesetReady,
  onBufferChange: playback.handleBufferChange,
});
```

### `UsePlaybackOptions`

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `timeRange` | `{ start: number; end: number }` | — | Full data span (sim-ms). Drives the clock range and the slider. |
| `baseSpeed` | `number` | `1000` | Wall-ms → sim-ms base rate at 1× (the controller's `speed`); multiplied by the user's speed preset. |
| `loop` | `boolean` | `true` | Wrap to the range start at the end. |
| `initialTime` | `number` | `timeRange.start` | Initial playhead position. |

### `PlaybackState` (return value)

| Member | Type | Description |
| :--- | :--- | :--- |
| `timeController` | `TimeController` | The animation clock — pass to layers via their `timeController` prop. |
| `governor` | `PlaybackGovernor \| null` | The buffer-gating governor (null only on the first paint). Pass to `PlaybackControls`. |
| `tilesetRef` | `React.MutableRefObject<BufferSource \| null>` | Live tileset handle (e.g. for polling `getVisibleTiles`). |
| `currentTime` | `number` | 20 Hz-throttled UI clock (slider/label only, not the layers). |
| `isPlaying` | `boolean` | User-intent play bit, mirrored from the governor. |
| `bufferState` | `PlaybackGovernorState` | Governor machine state (`idle`/`starting`/`playing`/`buffering`/`seeking`). |
| `speedMultiplier` | `number` | Current speed multiplier over `baseSpeed`. |
| `autoSpeed` | `boolean` | Whether opt-in Auto speed mode is active. |
| `overviewPreload` | `OverviewPreloadResult \| null` | Storyboard-tier preload outcome (perf HUD). |
| `baseAnimationSpeed` | `number` | The resolved `baseSpeed` (defaulted to 1000). |
| `onPlayPause` / `onSeek` / `onSpeedChange` / `onAutoSpeedSelect` | handlers | Transport callbacks for `PlaybackControls`. |
| `play` / `pause` | `() => void` | Imperative play/pause for visibility-driven embeds. |
| `handleTilesetReady` | `(tileset: BufferSource) => void` | Pass as the layer's `onTilesetReady`. |
| `handleBufferChange` | `(runway: BufferedRunway) => void` | Pass as the layer's `onBufferChange`. |
| `handleOverviewPreload` | `(result: OverviewPreloadResult) => void` | Pass as the layer's overview-preload callback. |

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

| Key | Action |
| :--- | :--- |
| `Space` / `K` | Toggle play–pause |
| `←` / `→` | Committed seek −/+2 % of the range |
| `J` / `L` | Committed seek −/+10 % of the range |
| `Home` / `End` | Jump to range start / end |
| `↑` / `↓` | Step speed up / down the shared preset ladder |
| `0`–`9` | Jump to N×10 % of the range |

Held keys auto-repeat; committed seeks are rate-capped to ~6/s so a held arrow is
a stream of seeks, not a `flushPrefetch` storm.

## PlaybackControls

The transport-bar UI: play/pause + restart, a drag-aware scrubber with a buffered
bar, hover timestamp, ETA chip, a data-volume density strip, speed presets + fine slider + Auto, and an optional hover-preview toggle. Drag-scrubbing talks to
the governor directly (`beginScrub`/`scrubTo`/`endScrub`); committed seeks route
through `onSeek` so the page owns the commit path.

```tsx
import { PlaybackControls } from '@poopdeck.gl/react';

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

| Prop | Type | Description |
| :--- | :--- | :--- |
| `currentTime` | `number` | Current playhead (sim-ms); the throttled UI clock. |
| `timeRange` | `{ start: number; end: number }` | Full data range; drives the bar geometry and slider bounds. |
| `isPlaying` | `boolean` | User intent — drives the play/pause glyph. |
| `bufferState` | `PlaybackGovernorState` | Governor machine state — drives the buffering chip. |
| `governor` | `PlaybackGovernor \| null` | Scrub previews/commits target it directly; null falls back to `onSeek`. |
| `onPlayPause` | `() => void` | Toggle play/pause. |
| `onSeek` | `(time: number) => void` | Committed seek (keyboard arrows on the slider, jump-to-start). |
| `onSpeedChange` | `(multiplier: number) => void` | Speed preset / slider change. |
| `currentSpeedMultiplier` | `number` | Active speed multiplier (lights the matching preset). |
| `targetPlaybackSeconds` | `number` | Wall-seconds the dataset plays in at 1× — drives the "time left" readout. |
| `autoSpeed` | `boolean` | Whether Auto speed mode is active. |
| `onAutoSpeedSelect` | `() => void` | Select Auto speed (any explicit choice exits it). |
| `renderPreview` | `(time: number) => React.ReactNode` | Optional. When supplied, a "Preview" toggle appears; hovering the scrubber renders the map at the settled hovered time. Pair with `HoverPreview`. |

## HoverPreview

The generic frozen-clock thumbnail: a second, independent `DeckGL` instance that
renders your layers at a single frozen timestamp, mirroring a supplied camera —
the render produced by `PlaybackControls`' `renderPreview` render-prop. It is
renderer-agnostic about *what* it draws: you supply `buildLayers(controller)`
(the frozen clock is handed in so your time-filtered layers read from it), the
`viewState`/`views`, the card size, and an optional `basemapUrl` drawn behind the
transparent deck canvas. It is a second WebGL context + archive for the same
data, so mount it only while the preview is visible, keyed by source id.

```tsx
import { HoverPreview } from '@poopdeck.gl/react';

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

| Prop | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `time` | `number` | — | Settled hovered timestamp (sim-ms). |
| `timeRange` | `{ start: number; end: number }` | — | Full data range; seeds the frozen clock. |
| `buildLayers` | `(controller: TimeController) => unknown[]` | — | Builds the layers to render; the frozen preview clock is passed in. Called once per mount. |
| `viewState` | `unknown` | — | deck.gl viewState (camera) to render at. |
| `views` | `unknown` | — | deck.gl views (e.g. a `GlobeView`). Omit for the default map view. |
| `width` / `height` | `number` | — | Card dimensions (px) — match the live viewport's aspect ratio. |
| `basemapUrl` | `string \| null` | — | Optional basemap image drawn behind the transparent deck canvas. |
| `background` | `string` | `"#242730"` | Background behind everything. |
| `parameters` | `unknown` | — | Forwarded to DeckGL `parameters` (e.g. `{ cull: true }` on a globe). |

## Source

[packages/react/src](../../packages/react/src) ·
underlying engine: [SttPlayer](./stt-player.md), [TimeController](./time-controller.md), [PlaybackGovernor](./playback-governor.md)
