# TimeFilterExtension

The `TimeFilterExtension` is a deck.gl layer extension that provides GPU-based temporal filtering. It allows any layer to filter and fade features based on their time range relative to the current time.

## Installation

```typescript
import { TimeFilterExtension } from '@stt/deck.gl';
```

## Usage

The extension is used internally by STT layers (`AnimatedPointLayer`, `AnimatedPathLayer`, etc.), but can also be applied to any deck.gl layer for custom temporal visualizations.

```typescript
import { ScatterplotLayer } from '@deck.gl/layers';
import { TimeFilterExtension } from '@stt/deck.gl';

const layer = new ScatterplotLayer({
  id: 'custom-temporal',
  data: myData,
  
  // Extension configuration
  extensions: [new TimeFilterExtension()],
  currentTime: Date.now(),
  timeWindow: 3600000, // 1 hour window
  fadeInDuration: 300,
  fadeOutDuration: 300,
  
  // Time accessors (per-feature times)
  getInstanceStartTime: d => d.startTime,
  getInstanceEndTime: d => d.endTime,
  
  // Regular layer props
  getPosition: d => d.coordinates,
  getRadius: 100,
});
```

## Extension Props

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `currentTime` | `number` | `0` | Current time in Unix milliseconds. |
| `getTime` | `() => number` | `undefined` | Dynamic time getter (performance optimization). Takes priority over `currentTime`. |
| `timeWindow` | `number` | `0` | Time window size in milliseconds. Features within `currentTime ± timeWindow/2` are visible. |
| `fadeInDuration` | `number` | `0` | Fade-in duration in milliseconds. |
| `fadeOutDuration` | `number` | `0` | Fade-out duration in milliseconds. |
| `trailLength` | `number` | `0` | Trail length for progressive drawing (used by trips layers). |

## Data Accessors

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `getInstanceStartTime` | `Accessor<number>` | `0` | Accessor for feature start time. |
| `getInstanceEndTime` | `Accessor<number>` | `Infinity` | Accessor for feature end time. |

## Modes

The extension supports two modes:

### Window Mode (default)

When `trailLength = 0`, the extension shows features whose time range overlaps with the current time window:

```
visible if: featureEnd >= (currentTime - windowHalf) AND featureStart <= (currentTime + windowHalf)
```

Features can optionally fade in/out at the edges of their visibility window.

### Trail Mode

When `trailLength > 0`, the extension enables progressive drawing with a trailing fade. This is used by `AnimatedTripsLayer` for the "vehicle moving along route" effect:

```
visible if: vertexTime is between (currentTime - trailLength) and currentTime
alpha = 1.0 - (age / trailLength)
```

## Performance Optimization

For high-performance animation, use the `getTime` prop instead of `currentTime`:

```typescript
// Less efficient - layer props change every frame
new ScatterplotLayer({
  currentTime: animationTime, // Changes trigger prop diffing
  // ...
});

// More efficient - layer can be cached
new ScatterplotLayer({
  getTime: () => timeController.getTime(), // Called in draw()
  // ...
});
```

When `getTime` is provided, the extension reads the current time dynamically in its `draw()` method, allowing deck.gl to cache and reuse the layer instance.

## Source

[packages/deck.gl/src/time-filter-extension.ts](../../packages/deck.gl/src/time-filter-extension.ts)

