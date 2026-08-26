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

### Light and dark

The stylesheet ships **both** palettes. The light "paper" set is the default;
under `prefers-color-scheme: dark` the same eight tokens switch to the dark set
the showcase floats over its map canvas. Pin a mode with `data-stt-theme` on any
ancestor of the bar — `<html>`, a wrapper, or the bar's own `style` prop:

```tsx
// A transport bar over a dark map, in an otherwise light page.
<div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1 }}>
  <div data-stt-theme="dark">
    <PlaybackControls {...playback} />
  </div>
</div>
```

Setting the tokens yourself still wins over both — a later `:root` rule in your
own CSS, or an inline `style` on any ancestor.

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

| Member                                                           | Type                                           | Description                                                                                                                                                          |
| :--------------------------------------------------------------- | :--------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeController`                                                 | `TimeController`                               | The shared animation clock. Hand it to layers via `useDeckClock`'s `userData` channel, or pass it directly as a layer's `timeController` prop.                       |
| `governor`                                                       | `PlaybackGovernor \| null`                     | The buffer-gating governor (null only on the first paint). Pass to `PlaybackControls`.                                                                               |
| `tilesetRef`                                                     | `React.MutableRefObject<BufferSource \| null>` | Handle to the first `required` registered tileset (e.g. for polling `getVisibleTiles`).                                                                              |
| `currentTime`                                                    | `number`                                       | 20 Hz-throttled UI clock (slider/label only, not the layers).                                                                                                        |
| `isPlaying`                                                      | `boolean`                                      | User-intent play bit, mirrored from the governor.                                                                                                                    |
| `bufferState`                                                    | `PlaybackGovernorState`                        | Governor machine state (`idle`/`starting`/`playing`/`buffering`/`seeking`).                                                                                          |
| `speedMultiplier`                                                | `number`                                       | Current speed multiplier over `baseSpeed`.                                                                                                                           |
| `currentSpeedMultiplier`                                         | `number`                                       | Same value under `PlaybackControls`' prop name, so `<PlaybackControls {...playback} />` spreads cleanly.                                                             |
| `timeRange`                                                      | `{ start: number; end: number } \| undefined`  | The `timeRange` option echoed back (for the spread).                                                                                                                 |
| `autoSpeed`                                                      | `boolean`                                      | Whether opt-in Auto speed mode is active.                                                                                                                            |
| `ended`                                                          | `boolean`                                      | Media-element `ended`: parked at a non-looping range boundary. Mirrored from the governor's `ended` bit + `'ended'` event; drives the transport's replay affordance. |
| `loop`                                                           | `boolean`                                      | Live loop state, seeded from `UsePlaybackOptions.loop` (default `true`).                                                                                             |
| `overviewPreload`                                                | `OverviewPreloadResult \| null`                | Storyboard-tier preload outcome (perf HUD).                                                                                                                          |
| `baseAnimationSpeed`                                             | `number`                                       | The resolved `baseSpeed` (defaulted to 1000).                                                                                                                        |
| `onPlayPause` / `onSeek` / `onSpeedChange` / `onAutoSpeedSelect` | handlers                                       | Transport callbacks for `PlaybackControls`.                                                                                                                          |
| `onLoopToggle`                                                   | `() => void`                                   | Flip looping at the range end. Pushed to the clock via `TimeController.setLoop`; never moves the playhead.                                                           |
| `play` / `pause`                                                 | `() => void`                                   | Imperative play/pause for visibility-driven embeds.                                                                                                                  |
| `registry`                                                       | `SourceRegistry`                               | Multi-source registration API for the governor — see below. Wire each layer's `onTilesetReady`/`onBufferChange` through it.                                          |
| `handleOverviewPreload`                                          | `(result: OverviewPreloadResult) => void`      | Pass as the layer's overview-preload callback.                                                                                                                       |

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
| `onBeforeRender` | `() => void`                                  | Advances `timeController` by one frame, in lockstep with deck's render loop. Coalesced per animation frame (see below), so extra draws in the same frame do not advance time again.      |
| `userData`       | `{ stt: { timeController: TimeController } }` | The `context.userData.stt` channel every STT layer reads time from, so layers need no per-layer `timeController` prop.                                                                   |

### One advance per frame, not per render

deck.gl's React wrapper redraws **synchronously from a dependency-less layout
effect** (`deck.redraw('Initial render')` in `DeckGLWithRef`), so
`onBeforeRender` fires once per React **commit**, not once per frame. The
controller therefore coalesces `advanceFrame()` on the browser's frame token
(`document.timeline.currentTime`) and advances at most once per frame; no
sim-time is lost, because the next accepted advance integrates the whole
elapsed span.

This is load-bearing, not tidiness. Without it, any playback state a tick
produces — the governor freezing the clock at the low watermark, a gate opening
it again — re-enters React from inside its own commit → render → draw → tick
chain, and React ends that chain by throwing `Maximum update depth exceeded`.
It also decouples the governor's per-tick work from the app's render rate.

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
| `,` / `.`      | Fine step −/+0.2 % of the range               |
| `Home` / `End` | Jump to range start / end                     |
| `<` / `>`      | Step speed down / up the shared preset ladder |
| `0`–`9`        | Jump to N×10 % of the range                   |

Held keys auto-repeat; committed seeks are rate-capped to ~6/s so a held arrow is
a stream of seeks, not a `flushPrefetch` storm.

The same table is exported as data — `PLAYBACK_SHORTCUTS: readonly PlaybackShortcut[]`
— so a shortcuts UI can render it without a copy that drifts. `PlaybackControls`'
`keyboardShortcuts` prop renders exactly that array.

### Two deliberate yields

The player sits on top of a map and inside a normal focus order, so it declines
two keys rather than break what is underneath:

- **Speed is `<` / `>`, not `↑` / `↓`.** deck.gl, MapLibre and Cesium all pan on
  the arrow keys once their canvas has focus (deck sets `tabIndex = 0` on it and
  defaults `keyboard: true`). A window-level listener claiming `↑`/`↓` fires _in
  addition to_ the map's own pan — one keypress, two reactions. `←`/`→` are for
  the same reason yielded whenever the event target is a `<canvas>` or a
  `[data-poopdeck-map]` element: **map focused → arrows pan; anything else →
  arrows seek.**
- **`Space` is yielded to a focused button/link.** A `<button>` activates on
  Space, and `preventDefault()` on the keydown suppresses that activation — so a
  window-level Space handler makes every button on the surface unpressable by
  keyboard, including the transport's own. `K` is unaffected and still toggles
  play–pause from anywhere.

## useReducedMotion

A live `prefers-reduced-motion: reduce` subscription, exported because the
transport bar needs it: several of its surfaces are styled with **inline**
`transition` / `animation` (so the controls survive a consumer whose Tailwind
build never scanned `node_modules`), and an inline style cannot be gated by a
CSS media query.

```typescript
import { useReducedMotion } from '@poopdeck.gl/react';

const reducedMotion = useReducedMotion();
<div style={{ transition: reducedMotion ? undefined : 'opacity 200ms ease' }} />;
```

Backed by `useSyncExternalStore`, so the **first** paint is already correct — a
`useState` + effect version renders one animated frame before correcting itself,
which is exactly the frame the setting exists to prevent. SSR-safe
(`getServerSnapshot` returns `false`).

## PlaybackControls

The transport-bar UI: restart / ∓10 % skip / play-pause / loop, a drag-aware
scrubber with a visible thumb, buffered bar, hover timestamp, ETA chip and a
data-volume density strip, an absolute-UTC **and** elapsed-of-total readout,
speed presets + fine slider + Auto, and optional hover-preview and
keyboard-shortcut disclosures. Drag-scrubbing talks to the governor directly
(`beginScrub`/`scrubTo`/`endScrub`); committed seeks route through `onSeek` so
the page owns the commit path.

Conventions it deliberately borrows from video players, and the reasons:

- **The scrub target is 24 px tall** even though the painted track is 6 px
  (8 px while active) — WCAG 2.5.8, and a 6 px grab region is unusable on
  touch. The density strip is inside that region, so clicking the histogram
  seeks, which is what everyone tries first.
- **Arrow keys on the focused scrubber step the same 2 %** the global hotkey
  map uses. The input's native `step` stays at range/500 because it also
  quantizes _dragging_; keyboard movement is handled explicitly instead of
  riding on it.
- **The live region holds transitions only** (buffering, degraded creep,
  ended). The remaining-time countdown next to it changes every second — inside
  `aria-live` a screen reader would recite it forever.
- **Speed is a real radio group** (`<fieldset>` of visually-hidden radios), not
  toggle buttons with `aria-pressed`: the presets and Auto are mutually
  exclusive, and native radios bring roving arrow-key traversal for free.
- **`ended` swaps the play glyph for replay**, and restart _plays_ — a control
  that leaves you paused at frame zero is a seek, not a replay.
- Animation (the buffering spinner, the track/thumb growth, the progress-fill
  smoothing) is gated on `prefers-reduced-motion` via `useReducedMotion`.

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

| Prop                     | Type                                | Description                                                                                                                                        |
| :----------------------- | :---------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currentTime`            | `number`                            | Current playhead (sim-ms); the throttled UI clock.                                                                                                 |
| `timeRange`              | `{ start: number; end: number }`    | Full data range; drives the bar geometry and slider bounds.                                                                                        |
| `isPlaying`              | `boolean`                           | User intent — drives the play/pause glyph.                                                                                                         |
| `bufferState`            | `PlaybackGovernorState`             | Governor machine state — drives the buffering chip.                                                                                                |
| `governor`               | `PlaybackGovernor \| null`          | Scrub previews/commits target it directly; null falls back to `onSeek`.                                                                            |
| `onPlayPause`            | `() => void`                        | Toggle play/pause.                                                                                                                                 |
| `onSeek`                 | `(time: number) => void`            | Committed seek (keyboard arrows on the slider, jump-to-start).                                                                                     |
| `onSpeedChange`          | `(multiplier: number) => void`      | Speed preset / slider change.                                                                                                                      |
| `currentSpeedMultiplier` | `number`                            | Active speed multiplier (lights the matching preset).                                                                                              |
| `targetPlaybackSeconds`  | `number`                            | Optional (default `60`). Wall-seconds the dataset plays in at 1× — drives the "time left" readout.                                                 |
| `autoSpeed`              | `boolean`                           | Whether Auto speed mode is active.                                                                                                                 |
| `onAutoSpeedSelect`      | `() => void`                        | Select Auto speed (any explicit choice exits it).                                                                                                  |
| `ended`                  | `boolean`                           | Optional. Parked at a non-looping range boundary — shows the replay glyph and announces "Ended". `usePlayback` mirrors it off the governor.        |
| `loop`                   | `boolean`                           | Optional. Current loop state; rendered only alongside `onLoopToggle`.                                                                              |
| `onLoopToggle`           | `() => void`                        | Optional. Supply to render the loop toggle.                                                                                                        |
| `keyboardShortcuts`      | `boolean`                           | Optional (default `false`). Set on surfaces that also mount `usePlaybackHotkeys`: adds a shortcuts disclosure and appends keys to button tooltips. |
| `renderPreview`          | `(time: number) => React.ReactNode` | Optional. When supplied, a "Preview" toggle appears; hovering the scrubber renders the map at the settled hovered time. Pair with `HoverPreview`.  |
| `className` / `style`    | `string` / `React.CSSProperties`    | Optional. Merged onto the root element — `style` is where you re-map the theme tokens for one instance.                                            |

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
