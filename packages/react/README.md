# @poopdeck.gl/react

React hooks and UI for **spatiotemporal playback**: `usePlayback` (clock +
governor + multi-source registry as React state), `usePlaybackHotkeys`
(media-player keyboard controls), `PlaybackControls` (transport bar +
scrubber + speed presets), and `HoverPreview` (frozen-clock scrubber
thumbnail).

## Install

```bash
npm install @poopdeck.gl/react react react-dom
```

**Peers**: `react` / `react-dom` ≥ 18 (required); `@deck.gl/core` +
`@deck.gl/react` `>=9.3.0 <10` are optional — they are needed only by
`HoverPreview`, which lives on its own subpath so the base import stays
deck-free:

```ts
import { HoverPreview } from '@poopdeck.gl/react/hover-preview';
```

## Styling

The components render styled after ONE import — no Tailwind required:

```ts
import '@poopdeck.gl/react/styles.css';
```

That stylesheet carries the utility classes the components use (compiled at
package build; **no preflight/reset**, so it can't affect your app's own
styles) plus defaults for the theme tokens. Re-theme by overriding the
tokens anywhere in your CSS:

```css
:root {
  --accent: #e11d48; /* play button, active states, scrubber fill */
  --surface: #16181d; /* control surfaces */
  --ink-900: #f5f7fa; /* strongest text */
  --ink-500: #9aa3b2; /* labels */
  --ink-400: #6b7280; /* captions */
  --hairline: #2a2e37; /* separators / outlines */
  --accent-soft: rgba(225, 29, 72, 0.12);
  --page-bg: #0b0d12;
}
```

If your app already runs **Tailwind v4**, you can skip the stylesheet and
generate the classes yourself — Tailwind does not scan `node_modules` by
default, so register the package explicitly (and define the theme tokens
above):

```css
@import 'tailwindcss';
@source "../node_modules/@poopdeck.gl/react/src";
```

`PlaybackControls` takes `className` and `style`, both merged onto its root
element — `style` is the usual place to re-map the tokens for one instance
(e.g. a dark bar floated over a map inside an otherwise light app).

Note `--ink-400` is **decorative only** (density bars, the buffered fill). It
does not clear WCAG contrast for text, and the components never draw text in
it.

## Keyboard

`usePlaybackHotkeys` installs the media-player map on a **fullscreen** surface
(never on a scrolling/embed page — `Space` there means "scroll"):

| Keys          | Action                                                      |
| ------------- | ----------------------------------------------------------- |
| `Space` / `K` | Play / pause                                                |
| `←` / `→`     | Seek ∓2% (yielded to the map when the map canvas has focus) |
| `J` / `L`     | Seek ∓10%                                                   |
| `,` / `.`     | Fine step ∓0.2%                                             |
| `Home`/`End`  | Jump to start / end                                         |
| `<` / `>`     | Slower / faster                                             |
| `0`–`9`       | Jump to 0–90% of the range                                  |

Speed sits on `<` / `>` rather than `↑` / `↓` because deck.gl, MapLibre and
Cesium all **pan on the arrow keys** once their canvas has focus; a
window-level listener claiming `↑`/`↓` would fire in addition to the map's own
pan. For the same reason `←`/`→` yield to a focused map surface, and `Space`
yields to a focused button so the transport's own controls stay pressable.

The same map is available as data via `PLAYBACK_SHORTCUTS`; pass
`keyboardShortcuts` to `PlaybackControls` on surfaces that mount the hook and
it renders a shortcuts disclosure from exactly that array.

## Hello world — usePlayback + PlaybackControls

```tsx
import { usePlayback, PlaybackControls } from '@poopdeck.gl/react';
import '@poopdeck.gl/react/styles.css';

function Transport({
  timeRange,
}: {
  timeRange: { start: number; end: number };
}) {
  const pb = usePlayback({ timeRange, baseSpeed: 3600 });
  return <PlaybackControls {...pb} />;
}
```

The hook's return is spread-compatible with `PlaybackControls` — it echoes
`timeRange` and exposes the current speed under both names
(`speedMultiplier` / `currentSpeedMultiplier`). Every prop can still be
passed individually when you need to interpose (e.g. wrap `onSeek` to update
a URL param).

Wire layers into the same playhead via `pb.timeController` (the
`timeController` prop on any `@poopdeck.gl/layers` layer) and register each
layer's tileset with `pb.registry.registerSource(...)` so buffering gates the
clock. `useDeckClock(pb.timeController, pb.isPlaying)` hands the per-frame
advance to deck's own render loop.

Depends only on `@poopdeck.gl/core` + `@poopdeck.gl/playback`.

## Docs

- [@poopdeck.gl/react reference](../../docs/api/stt-react.md)

MIT.
