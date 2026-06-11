# TimeFilterExtension

The `TimeFilterExtension` is a deck.gl layer extension that provides GPU-based temporal filtering. It filters and fades features based on their time range relative to the current time, entirely in shaders — the CPU only updates one uniform block per frame. It also implements time-as-height (the "space-time cube" lift).

It works on instanced layers (`ScatterplotLayer`, `PathLayer`) and non-instanced ones (`SolidPolygonLayer`) alike: its attributes are registered with `stepMode: 'dynamic'`, which resolves to per-instance on instanced models and per-vertex on non-instanced ones — the same mechanism as upstream `DataFilterExtension`.

## Installation

```typescript
import { TimeFilterExtension, relativizeTime, MAX_RELATIVE_TIME_MS } from '@stt/deck.gl';
```

## Usage

The extension is used internally by the STT layers (`AnimatedPointLayer`, `AnimatedPathLayer`, …), but can be applied to any deck.gl layer for custom temporal visualizations.

```typescript
import { ScatterplotLayer } from '@deck.gl/layers';
import { TimeFilterExtension, relativizeTime } from '@stt/deck.gl';

const timeOffset = dataStartMs; // see "The timeOffset contract" below

const layer = new ScatterplotLayer({
  id: 'custom-temporal',
  data: myData,

  extensions: [new TimeFilterExtension()],
  getTime: () => timeController.getTime(), // absolute; relativized internally
  timeOffset,
  timeWindow: 3600000, // 1 hour window
  fadeInDuration: 300,
  fadeOutDuration: 300,

  // Time accessors — must return RELATIVE times (absolute - timeOffset):
  getInstanceStartTime: d => relativizeTime(d.startTime, timeOffset),
  getInstanceEndTime: d => relativizeTime(d.endTime, timeOffset),

  getPosition: d => d.coordinates,
  getRadius: 100,
});
```

## Extension Props

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `currentTime` | `number` | `0` | Current time (Unix ms). |
| `getTime` | `(() => number) \| null` | `null` | Dynamic time getter — called every `draw()` so the layer instance stays cached across animation ticks (only uniforms update per frame). Takes priority over `currentTime`. |
| `timeOffset` | `number` | `0` | The per-layer time origin all attribute times are relative to. **Critical for f32 precision — see below.** |
| `timeWindow` | `number` | `0` | Window size in ms (window mode): features within `currentTime ± timeWindow/2` are visible. |
| `fadeInDuration` | `number` | `0` | Fade-in duration (ms) for appearing features. |
| `fadeOutDuration` | `number` | `0` | Fade-out duration (ms) for disappearing features (window mode only). |
| `trailLength` | `number` | `0` | Trail length in ms (trail mode when > 0). |
| `fadeTrail` | `boolean` | `true` | In trail mode: fade head→tail (the classic comet trail) vs constant opacity along the whole length (a solid snake). |
| `wakeLength` | `number` | `0` | Wake length in ms (wake mode when > 0). |
| `wakeTailScale` | `number` | `0.15` | Trailing-edge point-size multiplier in wake mode (0..1; head = 1.0). |
| `cumulative` | `boolean` | `false` | Cumulative ("draw and persist") mode. |
| `timeHeightScale` | `number` | `0` | Time-as-height: meters of altitude per sim-ms (0 = off). |
| `timeHeightOrigin` | `number` | `0` | Absolute time (Unix ms) mapped to altitude 0 in time-as-height mode. |

## Data Accessors

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `getInstanceStartTime` | `Accessor<number>` | `0` | Feature start time, RELATIVE to `timeOffset`. |
| `getInstanceEndTime` | `Accessor<number>` | `Infinity` | Feature end time, RELATIVE to `timeOffset`. |
| `getInstanceVertexTime` | `Accessor<number>` | `0` | Per-vertex timestamp (trail mode), RELATIVE to `timeOffset`. The attribute is always registered, so the constant default keeps non-trail layers valid. |

## Modes

One mode is active at a time, by precedence: **cumulative → wake → trail → window**.

### Window mode (default)

Features whose `[startTime, endTime]` overlaps `currentTime ± timeWindow/2` are visible; `fadeInDuration` ramps alpha at the leading edge, `fadeOutDuration` at the trailing edge.

### Trail mode (`trailLength > 0`)

Progressive drawing with a trailing fade — the `AnimatedTripsLayer` "vehicle moving along route" effect. Uses the per-vertex `instanceVertexTime` attribute:

```
visible if: currentTime - trailLength <= vertexTime <= currentTime
alpha = fadeTrail ? 1 - age / trailLength : 1
```

### Wake mode (`wakeLength > 0`)

One-sided "ship wake" for point layers: a feature is shown only while `0 <= currentTime - startTime <= wakeLength`; alpha fades linearly to zero at the trailing edge and (on `ScatterplotLayer`, via the `DECKGL_FILTER_SIZE` hook) point radius shrinks to `wakeTailScale` of the head radius. The host layer must set `timeWindow >= 2 × wakeLength` so the tile loader actually loads the past half of the wake — the shader filter is independent of the tile-loading window.

### Cumulative mode (`cumulative: true`)

"Draw and persist": a feature becomes visible once `startTime <= currentTime` and stays visible for the rest of playback. Ideal for "watch it get built" datasets (e.g. OSM node creations inking a city in). `fadeInDuration` still applies as an appear ramp; `instanceEndTime` is ignored. The host layer must keep already-revealed tiles resident (widen the loader's window) — the shader does the progressive reveal, not the loader.

### Time-as-height (orthogonal to the modes)

When `timeHeightScale != 0`, every vertex is lifted vertically by `(featureTime - timeHeightOrigin) × timeHeightScale` meters — per-VERTEX time in trail mode (the thread climbs along its length, slope = speed), per-FEATURE start time otherwise. The lift is computed as a clip-space delta between the lifted and unlifted common-space positions, so screen-space offsets the host layer baked in (path-width quads, billboards) are preserved. A single uniform — animating it (the flat-map ↔ cube "squash" morph) costs nothing per frame. MapView only.

## The timeOffset contract (f32 precision)

**This is the contract every consumer must honor.** Absolute epoch-ms values (~1.7e12) cannot be represented in a `Float32Array` or f32 uniform without ~131 s quantization — f32's 24-bit mantissa makes integers exact only up to 2^24 (`MAX_RELATIVE_TIME_MS` = 16,777,216 ms ≈ 4.66 h… per side of the offset).

The scheme, with `relativizeTime(absolute, offset) = absolute - offset` as the single source of truth:

- **Attributes** (`instanceStartTime` / `instanceEndTime` / `instanceVertexTime`) store `absoluteTime - timeOffset`. STT binary tiles already arrive this way: `BinaryFeatures.startTimes` etc. are relative to `binary.timeOffset`, so the STT layers pass tile values through unchanged and set `timeOffset: binary.timeOffset` per sublayer.
- **The uniform**: the extension subtracts the SAME `timeOffset` from the resolved current time on the CPU before uploading the `currentTime` uniform (and from `timeHeightOrigin`).

Both sides of every shader comparison are therefore small numbers that fit exactly in f32. **The layer MUST pass the same offset it used to relativize the attributes.**

### Worked example

Dataset starts 2024-01-01 00:00 UTC (`1704067200000`). A tile's earliest feature start is that instant, so the decoder sets `binary.timeOffset = 1704067200000`.

| Quantity | Absolute (ms) | Stored / uploaded |
| :--- | :--- | :--- |
| Feature start (01:00) | `1704070800000` | attribute `3600000` |
| Feature end (01:30) | `1704072600000` | attribute `5400000` |
| Playhead (02:00) | `1704074400000` | uniform `currentTime = 7200000` |

The shader compares `3600000 ≤ 7200000 ± window/2` — exact in f32. Had the attribute stored the absolute `1704070800000`, f32 would quantize it to a multiple of 128 ms and a `±131s`-class error would creep into every comparison.

A relative time past `MAX_RELATIVE_TIME_MS` triggers a one-time console warning ("check that `timeOffset` matches the tile data") — except in cumulative mode, which intentionally spans years and tolerates the quantization.

## Performance Optimization

For high-performance animation, use the `getTime` prop instead of `currentTime`:

```typescript
// Less efficient — layer props change every frame
new ScatterplotLayer({ currentTime: animationTime /* triggers prop diffing */ });

// More efficient — layer instance cached, time read in draw()
new ScatterplotLayer({ getTime: () => timeController.getTime() });
```

Other built-in optimizations: the shader-injection object is memoized per extension instance (object identity prevents pipeline re-links across sublayers sharing the singleton), and fully-hidden features are collapsed at the VERTEX stage (degenerate clip-space position ⇒ zero fragments rasterized) in the whole-feature modes.

## Limitations

- The three time attributes plus a layer's own attributes can brush WebGL2's 16-vertex-attribute guaranteed minimum when stacked with fp64 positions, picking, and `CategoryColorExtension`. On GPUs reporting exactly 16 slots, deck.gl logs a link warning and falls back to a non-picking shader; rendering proceeds. `AnimatedPathLayer`/`AnimatedTripsLayer` avoid this by default via `NoPickingPathLayer`. The constructor's `mode` option is reserved for the deck.gl 9.4 `gl_InstanceID` picking path and currently changes nothing.
- `PolygonTimeFilterExtension` is a deprecated alias kept for back-compat (warns once on construction) — `TimeFilterExtension` now works on `SolidPolygonLayer` directly.

## Source

[packages/deck.gl/src/time-filter-extension.ts](../../packages/deck.gl/src/time-filter-extension.ts)
