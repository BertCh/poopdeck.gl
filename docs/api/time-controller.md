# TimeController

The `TimeController` class manages temporal animation playback. It provides a central clock that layers can subscribe to, enabling synchronized animation across multiple layers.

## Installation

```typescript
import { TimeController } from '@stt/deck.gl';
```

## Usage

```typescript
import { TimeController, AnimatedPointLayer } from '@stt/deck.gl';

// Create a controller with time range
const timeController = new TimeController({
  initialTime: Date.parse('2020-01-01'),
  speed: 86400000, // 1 day per second
  loop: true,
  timeRange: {
    start: Date.parse('2020-01-01'),
    end: Date.parse('2020-12-31'),
  },
});

// Subscribe to time updates
timeController.on('tick', (time) => {
  console.log('Current time:', new Date(time));
});

// Pass to layers for automatic synchronization
const layer = new AnimatedPointLayer({
  id: 'earthquakes',
  data: 'https://example.com/earthquakes.stt',
  timeController, // Layer subscribes automatically
  timeWindow: 86400000,
});

// Control playback
timeController.play();
timeController.pause();
timeController.seek(Date.parse('2020-06-15'));
```

## Constructor Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `initialTime` | `number` | `Date.now()` | Starting time in Unix milliseconds. |
| `speed` | `number` | `1.0` | Playback speed multiplier. Value represents simulation ms per real ms. |
| `loop` | `boolean` | `false` | Whether to loop when reaching the end of the time range. |
| `timeRange` | `{ start: number; end: number }` | `undefined` | Optional time range boundaries. |

## Methods

### Playback Control

| Method | Description |
| :--- | :--- |
| `play()` | Start playback. |
| `pause()` | Pause playback. |
| `toggle()` | Toggle play/pause state. |
| `seek(time: number)` | Jump to a specific time. |
| `seekBy(delta: number)` | Seek by a relative offset. |

### State Access

| Method | Returns | Description |
| :--- | :--- | :--- |
| `getTime()` | `number` | Get current time in Unix milliseconds. |
| `setTime(time: number)` | `void` | Set current time. |
| `isPlaying()` | `boolean` | Check if currently playing. |
| `getSpeed()` | `number` | Get current playback speed. |
| `setSpeed(speed: number)` | `void` | Set playback speed. |
| `setTimeRange(range)` | `void` | Set time range boundaries. |
| `getState()` | `TimeControllerState` | Get full state object. |

### Event Handling

| Method | Description |
| :--- | :--- |
| `on('tick', callback)` | Subscribe to time updates. Called on every animation frame. |
| `on('playState', callback)` | Subscribe to play/pause state changes. |
| `off('tick', callback)` | Unsubscribe from time updates. |
| `off('playState', callback)` | Unsubscribe from play state changes. |
| `destroy()` | Clean up and stop all listeners. |

## Types

```typescript
interface TimeControllerOptions {
  initialTime?: number;
  speed?: number;
  loop?: boolean;
  timeRange?: { start: number; end: number };
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

1. Subscribes to `tick` events for time updates
2. Subscribes to `playState` events to enable prefetching during playback
3. Unsubscribes when the layer is destroyed

This allows for efficient animation without React re-renders on every frame.

## Source

[packages/deck.gl/src/time-controller.ts](../../packages/deck.gl/src/time-controller.ts)


