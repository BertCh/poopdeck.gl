# @poopdeck.gl/playback

A **zero-dependency, renderer-agnostic playback engine** for time-series
visualization: an animation clock, a buffering governor that gates playback
on a buffered runway (stall/resume, seek gates, adaptive Auto speed), and an
HTMLMediaElement-style facade tying them together.

## Install

```bash
npm install @poopdeck.gl/playback
```

No peer dependencies, no runtime dependencies.

## Hello world — TimeController basics

```ts
import { TimeController } from "@poopdeck.gl/playback";

const clock = new TimeController({
  timeRange: { start, end },
  speed: 3600, // sim-ms per wall-ms: one hour of data per second
  loop: true,
});

const unsubscribe = clock.on("tick", (t) => render(t));
clock.play();
// later:
clock.pause();
clock.seek(start);
unsubscribe();
```

## The pieces

- **`TimeController`** — the shared clock (sim-ms per wall-ms speed model).
- **`PlaybackGovernor`** — the buffering state machine over N registered
  sources, plus `decideAutoSpeedMultiplier` / `SPEED_STEPS` (ABR-style
  Auto speed).
- **`SttPlayer`** — the recommended single entry point (`play/pause/seek`,
  `playbackRate`, throttled `timeupdate`); feed it any `BufferSource`
  (e.g. `@poopdeck.gl/core`'s tileset) via `setSource()`.

No deck.gl, no DOM, no STT dependency — any renderer with a "how much is
buffered" signal can use it.

## Docs

- [SttPlayer](../../docs/api/stt-player.md)
- [TimeController](../../docs/api/time-controller.md)
- [PlaybackGovernor](../../docs/api/playback-governor.md)

MIT.
