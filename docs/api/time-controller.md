# TimeController

The `TimeController` class is the animation clock: a wall-clock × speed rAF loop that layers subscribe to for synchronized animation. It deliberately knows nothing about data loading — in any networked app, drive it through a [`PlaybackGovernor`](./playback-governor.md), which gates play/resume/seek on the buffered runway so the clock never advances into unloaded time.

## Installation

```typescript
import { TimeController } from '@stt/deck.gl';
```

## Usage

```typescript
import { TimeController, PlaybackGovernor, AnimatedPointLayer } from '@stt/deck.gl';

const timeController = new TimeController({
  initialTime: Date.parse('2020-01-01'),
  speed: 86400000 / 1000, // 1 day per second
  loop: true,
  timeRange: {
    start: Date.parse('2020-01-01'),
    end: Date.parse('2020-12-31'),
  },
  tickThrottleMs: 16,
});

// Recommended: gate playback on data readiness.
const governor = new PlaybackGovernor(timeController);

const layer = new AnimatedPointLayer({
  id: 'earthquakes',
  data: 'https://example.com/earthquakes/manifest.json',
  timeController, // layer subscribes automatically
  timeWindow: 86400000,
  onTilesetReady: (tileset) => governor.setSource(tileset),
  onBufferChange: (runway) => governor.notifyBufferChange(runway),
});

// Drive playback through the governor…
governor.requestPlay();
governor.requestPause();
governor.seekTo(Date.parse('2020-06-15'));

// …or, for offline/test scenarios, the controller directly:
timeController.play();
timeController.pause();
timeController.seek(Date.parse('2020-06-15'));
```

## Constructor Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `initialTime` | `number` | `Date.now()` | Starting time in Unix milliseconds (an explicit `0` is honored). |
| `speed` | `number` | `1.0` | Playback speed: simulation ms per real ms. Negative plays backward. |
| `loop` | `boolean` | `false` | Wrap to the other end of `timeRange` when a boundary is hit. |
| `bounce` | `boolean` | `false` | Ping-pong at the range boundaries instead of jumping: the overshoot is reflected back into the range and playback direction reverses, so time stays CONTINUOUS across the boundary. Takes precedence over `loop`. Exists because a hard loop-wrap teleports `currentTime` by the full range span in one frame — for trail/window layers that one-frame jump causes a mass tile evict+reload blink and a visible layer flash. Fine for ambient slow drifts; not what you want for directional replay. |
| `timeRange` | `{ start: number; end: number }` | `undefined` | Time range boundaries. Without it, time advances unbounded. |
| `tickThrottleMs` | `number` | `0` | Minimum wall-clock interval (ms) between `'tick'` notifications during playback. Internal time still advances every animation frame; this only throttles listener notification. `0` = notify every frame. |

## Playback boundary behavior

With a `timeRange`, hitting a boundary does one of three things:

1. **`bounce: true`** — reflect and reverse direction; fires a `playState` notification (the speed's sign flipped) so tile loaders re-aim their prefetch immediately.
2. **`loop: true`** — teleport to the other end; fires the **`wrap`** event. The wrap is a teleport-seek the clock performed on its own; the `PlaybackGovernor` subscribes to `wrap` and routes it through seek semantics (flush stale prefetch, startup-sized gate) instead of letting playback run ungated into possibly-unloaded time.
3. **Neither** — clamp to the boundary and `pause()`.

## Frame-delta clamp and tab refocus

Browsers suspend `requestAnimationFrame` in background tabs, so without protection the first frame after a refocus would advance time by the ENTIRE background duration — a playhead teleport. Two defenses are built in:

- every frame's wall-clock delta is **clamped to 250 ms** (any real frame longer than that is dropped-frames jank where advancing by the full gap would only compound the stutter), and
- a `visibilitychange` handler **re-anchors the frame clock** when the tab becomes visible while playing, removing even the clamped jump. The handler is registered in `play()` and removed in `pause()` / `destroy()`, so idle controllers add no document listeners.

## Methods

### Playback Control

| Method | Description |
| :--- | :--- |
| `play()` | Start playback. No-op when already playing. |
| `pause()` | Pause playback. No-op (and no `playState` notification) when already paused. |
| `toggle()` | Toggle play/pause state. |
| `seek(time: number)` | Jump to a specific time (alias of `setTime`). |
| `seekBy(delta: number)` | Seek by a relative offset. |

### State Access

| Method | Returns | Description |
| :--- | :--- | :--- |
| `getTime()` | `number` | Get current time in Unix milliseconds. |
| `setTime(time: number)` | `void` | Set current time (notifies `tick` listeners synchronously). |
| `isPlaying()` | `boolean` | Check if currently playing. |
| `getSpeed()` | `number` | Get current playback speed. |
| `setSpeed(speed: number)` | `void` | Set playback speed. Fires `playState` while playing (a re-plan event for governors/loaders). |
| `setTimeRange(range)` | `void` | Set time range boundaries. |
| `getState()` | `TimeControllerState` | Get full state object. |

### Event Handling

| Method | Description |
| :--- | :--- |
| `on('tick', cb)` | Time updates. Called every animation frame (or per `tickThrottleMs`) with the current time. |
| `on('playState', cb)` | Play/pause/speed changes: `(playing: boolean, speed: number)`. Also fired on a `bounce` reversal. |
| `on('wrap', cb)` | Loop wraps (both directions): `(time: number)` after the teleport. |
| `off(event, cb)` | Unsubscribe (same three event names). |
| `destroy()` | Pause (also removes the `visibilitychange` handler) and clear all listeners. |

## Types

```typescript
interface TimeControllerOptions {
  initialTime?: number;
  speed?: number;
  loop?: boolean;
  bounce?: boolean;
  timeRange?: { start: number; end: number };
  tickThrottleMs?: number;
}

interface TimeControllerState {
  currentTime: number;
  playing: boolean;
  speed: number;
  loop: boolean;
}

type TimeUpdateCallback = (time: number) => void;
type PlayStateCallback = (playing: boolean, speed: number) => void;
```

## Integration with Layers

When you pass a `TimeController` to a layer via the `timeController` prop, the layer automatically:

1. Subscribes to `tick` events for time updates (read via a `getTime` getter in the shader extension's `draw()` — no React re-render per frame)
2. Subscribes to `playState` events to drive prefetch sizing and direction
3. Unsubscribes when the layer is finalized

## Source

[packages/deck.gl/src/time-controller.ts](../../packages/deck.gl/src/time-controller.ts)
