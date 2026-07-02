# @poopdeck.gl/react

React hooks and UI for **spatiotemporal playback**: `usePlayback` (clock +
governor + multi-source registry as React state), `usePlaybackHotkeys`
(media-player keyboard controls), `PlaybackControls` (transport bar +
scrubber + speed presets), and `HoverPreview` (frozen-clock scrubber
thumbnail).

## Install

> **Not yet published to npm** — today, consume it from the monorepo:

```bash
git clone https://github.com/BertCh/spatiotemporal-tiles
cd spatiotemporal-tiles
pnpm install && pnpm build
```

Inside the workspace, depend on `"@poopdeck.gl/react": "workspace:*"`; from
an external app, point a `file:` dependency at `packages/react`.

Once published:

```bash
npm install @poopdeck.gl/react react react-dom
```

**Peers**: `react` / `react-dom` ≥ 18 (required); `@deck.gl/core` +
`@deck.gl/react` `>=9.3.0 <10` are optional — they are needed only by
`HoverPreview`, which lives on its own subpath so the base import stays
deck-free:

```ts
import { HoverPreview } from "@poopdeck.gl/react/hover-preview";
```

Components are styled with standard Tailwind utility classes; supply your
own Tailwind build or override via `className`.

## Hello world — usePlayback + PlaybackControls

```tsx
import { usePlayback, PlaybackControls } from "@poopdeck.gl/react";

function Transport({ timeRange }: { timeRange: { start: number; end: number } }) {
  const pb = usePlayback({ timeRange, baseSpeed: 3600 });

  return (
    <PlaybackControls
      currentTime={pb.currentTime}
      timeRange={timeRange}
      isPlaying={pb.isPlaying}
      bufferState={pb.bufferState}
      governor={pb.governor}
      onPlayPause={pb.onPlayPause}
      onSeek={pb.onSeek}
      onSpeedChange={pb.onSpeedChange}
      currentSpeedMultiplier={pb.speedMultiplier}
      targetPlaybackSeconds={60}
      autoSpeed={pb.autoSpeed}
      onAutoSpeedSelect={pb.onAutoSpeedSelect}
    />
  );
}
```

Wire layers into the same playhead via `pb.timeController` (the
`timeController` prop on any `@poopdeck.gl/layers` layer) and register each
layer's tileset with `pb.registry.registerSource(...)` so buffering gates the
clock. `useDeckClock(pb.timeController, pb.isPlaying)` hands the per-frame
advance to deck's own render loop.

Depends only on `@poopdeck.gl/core` + `@poopdeck.gl/playback`.

## Docs

- [@poopdeck.gl/react reference](../../docs/api/stt-react.md)

MIT.
