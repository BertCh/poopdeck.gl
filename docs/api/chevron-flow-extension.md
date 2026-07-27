# ChevronFlowExtension

The `ChevronFlowExtension` is a deck.gl layer extension that overlays marching directional chevrons ("›››") on a `PathLayer`-based layer, entirely in the fragment shader — the CPU only updates one uniform block per frame. A corridor rendered with it reads as _flowing_ one way instead of just sitting there as a static colored line.

It composes with any `PathLayer`-derived layer through the standard `extensions` prop, and is designed to pair with [`FlowCorridorLayer`](./flow-corridor-layer.md): the extension draws the chevron overlay, while the host layer's own per-vertex coloring (e.g. `FlowCorridorLayer`'s time-bucket gradient) shows through underneath.

## Installation

```typescript
import { ChevronFlowExtension } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { FlowCorridorLayer } from '@poopdeck.gl/layers';
import { ChevronFlowExtension } from '@poopdeck.gl/layers';

const layer = new FlowCorridorLayer({
  id: 'directional-corridors',
  data: '/data/bixi-streets-flow/manifest.json',
  getTime: () => timeController.getTime(),
  gradientDomain: [0, 16],
  gradientColorRamp: [
    [40, 40, 80, 180],
    [80, 180, 255, 220],
    [255, 220, 120, 255],
  ],
  signedFlow: true, // paired FlowCorridorLayer prop — see below

  extensions: [
    new ChevronFlowExtension({
      speed: 0.0006,
      perBucketDirection: true,
      directionColor: true,
    }),
  ],
});
```

A minimal, non-directional overlay on a plain `PathLayer` needs nothing from the host beyond a play-head:

```typescript
import { PathLayer } from '@deck.gl/layers';
import { ChevronFlowExtension } from '@poopdeck.gl/layers';

const layer = new PathLayer({
  id: 'marching-corridor',
  data: myCorridors,
  getPath: (d) => d.path,
  getColor: [80, 180, 255, 220],
  widthMinPixels: 3,

  extensions: [new ChevronFlowExtension()],
  getTime: () => timeController.getTime(),
});
```

## Extension Props

| Property                 | Type                           | Default                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| :----------------------- | :----------------------------- | :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `period`                 | `number`                       | `6`                     | Chevron spacing along the path, in units of line width (so it scales with `widthMinPixels`/`widthMaxPixels`). Larger = more space between arrows.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `speed`                  | `number`                       | `0.0006`                | March speed: units of phase (same width-units as `period`) advanced per second of play-head time. The phase rides the play-head, so chevrons freeze when playback is paused and reverse when scrubbing backward.                                                                                                                                                                                                                                                                                                                                   |
| `skew`                   | `number`                       | `1.4`                   | Arrowhead sharpness: how much the band shears along the path per unit of half-width. Larger makes a pointier "›"; `0` makes a straight dash.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `duty`                   | `number`                       | `0.5`                   | Fraction of each period lit by the chevron band, in `[0, 1]`. Smaller = thinner arrowheads with more dark gap between them.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `feather`                | `number`                       | `0.28`                  | Soft-edge width of the band's trailing edge, as a fraction of a period. Larger = softer, more comet-like tails.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `baseAlpha`              | `number`                       | `0.15`                  | Alpha multiplier for the path between chevrons: `0` shows chevrons only (an otherwise invisible track); `1` leaves the base line fully solid with a brightness ripple.                                                                                                                                                                                                                                                                                                                                                                             |
| `perBucketDirection`     | `boolean`                      | `false`                 | When true, direction is no longer fixed to geometry winding — each vertex carries a continuous signed direction in `[-1, 1]` (from the host layer) that morphs the arrow shape (">" at `+1` → flat dash at `0` → "<" at `-1`), blends its cardinal hue forward↔reverse, and marches the way the arrows point, all smoothly with no hard flip. Adds no new vertex attribute (see [Direction](#direction) below). Requires a sibling `TimeFilterExtension` on the same layer; without one it degrades to the static winding with a one-time warning. |
| `uniformSpacing`         | `boolean`                      | `false`                 | Fits a whole number of chevrons into each rendered path _segment_ instead of using the raw `period` (which is measured per-segment and restarts at every vertex), so arrows are never truncated at a joint. **Combines with a marching `speed`** — the phase is applied in turns, so a wrap moves the band by exactly one whole chevron. Requires a `PathLayer`-family host; elsewhere it degrades to the raw `period` with a one-time warning.                                                                                                    |
| `directionColor`         | `boolean`                      | `false`                 | Tints the arrowheads by the compass bearing they point, using four colors placed at the cardinal directions (`directionColors`) and blended cyclically around the compass. Applied to the arrowheads only. Requires a `PathLayer`-family host (the bearing comes from `instanceStartPositions`/`instanceEndPositions`); elsewhere it degrades to the inherited host color with a one-time warning.                                                                                                                                                 |
| `directionColors`        | `[Color, Color, Color, Color]` | amber/green/teal/violet | The four cardinal colors `[N, E, S, W]`, each `[r, g, b]` in 0–255, placed at bearings `offset`, `offset + 90`, `offset + 180`, `offset + 270` and interpolated cyclically for in-between bearings. **Interned by content** at construction, so an inline literal written fresh in every React render still yields the same options reference and does not thrash the shader cache — see [Performance](#performance).                                                                                                                              |
| `directionOffsetDegrees` | `number`                       | `0`                     | Compass-bearing offset (degrees) of `directionColors[0]`; `0` anchors it due North. Use `45` to place the four colors on the intercardinals (NE/SE/SW/NW).                                                                                                                                                                                                                                                                                                                                                                                         |
| `perTripLight`           | `boolean`                      | `false`                 | Two-signal corridor rendering: the incoming color's RGB carries a rolling-window aggregate (the dim background track), and its alpha carries an instantaneous per-feature flow signal. Arrowheads flash their cardinal `directionColor` hue as the signal passes, fading to `perTripFloor` between flashes; the track shows the aggregate. Designed to pair with `FlowCorridorLayer`'s `chevronPerTripLight` prop.                                                                                                                                 |
| `perTripFloor`           | `number`                       | `0.22`                  | With `perTripLight`: arrowhead opacity floor between flashes, in `[0, 1]`. The arrowhead alpha recedes toward this floor and pops to full as the signal passes (the hue stays saturated, so it reads whenever it shows). `0` = arrows invisible between flashes.                                                                                                                                                                                                                                                                                   |

## How it works

### The chevron band

The fragment shader reads `PathLayer`'s `geometry.uv` varying — `.x ∈ [-1, 1]` is the position across the path width (`0` = center line), `.y` is the distance along the current segment, in units of line width. From these it builds a repeating band:

```
chevronS    = along + abs(across) * skew * dir - phase * sign(dir)
chevronBand = fract(chevronS / period)
chevronHead = 1 - smoothstep(duty - feather, duty, chevronBand)
```

The `abs(across) * skew` term shears the band by position across the path, so the leading edge forms a "›" point instead of a straight bar; `smoothstep` gives the band a sharp leading edge and a soft, feathered trailing edge. `chevronHead` (in `[0, 1]`) then drives everything downstream: by default it just modulates alpha, `color.a *= mix(baseAlpha, 1.0, chevronHead)`, so the base line dims to `baseAlpha` between arrowheads and brightens to full color at each one.

Because the shear direction is signed by `dir` and the march is `sign(dir) * phase`, the band shears and marches symmetrically for forward and reverse: at `dir = 0` the shear vanishes and the band collapses to a flat dash perpendicular to the path, which is the mid-transition shape when `perBucketDirection` is animating a corridor's flow across neutral.

### Direction

Direction is a per-vertex scalar `dir`, not derived from data — it comes from geometry winding, not from any per-vertex time or value attribute in the tile:

- **Default (`perBucketDirection: false`)**: `dir = 1.0` everywhere. Chevrons always point toward increasing vertex index — i.e. along the path's digitization order. To make that order match real-world travel direction, pre-orient the source geometry at build time (as the `bixi --streets --directional` / `--per-bucket-direction` build modes do).
- **`perBucketDirection: true`**: `dir` is a continuous signed value in `[-1, 1]`, read from a per-vertex varying the host layer supplies. Rather than adding a new vertex attribute — `PathLayer` already sits close to WebGL2's 16-attribute ceiling once fp64 positions, `TimeFilterExtension`'s three time attributes, and color/width are stacked — the extension reuses `TimeFilterExtension`'s `instanceVertexTime` attribute slot to carry the sign. This is safe on a host that registers `instanceVertexTime` but never reads it for its own purpose (e.g. `FlowCorridorLayer` in window mode, which is not trail mode); it is unsafe to combine with a host that uses `instanceVertexTime` for actual per-vertex timestamps (trail mode).

### Uniform spacing

With `uniformSpacing: true`, the fragment reads `PathLayer`'s `vPathLength` varying (the current segment's length, in the same width-units as `geometry.uv.y`) and snaps the effective period so a whole number of chevrons fits the segment exactly:

```
period' = max(segLen / max(round(segLen / period), 1), 0.001)
```

Because the fitted period divides the segment length exactly, a chevron edge lands on both segment endpoints — arrows are never truncated at a joint, and adjacent segments meet edge-to-edge. Density stays close to `1 / period` per unit of path length even on many-vertex corridors whose segments are individually shorter than one `period` (the common case at an overview zoom).

**It combines with a marching `speed`.** The phase is applied in **turns**
(`phase / period`), not in width-units: the CPU reduces the play-head modulo the
_raw_ `period`, so `phase / period` wraps 1 → 0 and `fract()` stays continuous
across the wrap. Arrows advance one arrow-spacing per `period / speed` seconds on
every segment — uniform in _arrows_ per second even where the fitted spacing
differs from `period`. (Subtracting the phase in width-units _before_ dividing by
the refitted period is what used to shift the band by
`fract(rawPeriod / fittedPeriod)` at each wrap and make the march visibly step.)

### Direction color

With `directionColor: true`, the vertex shader computes each segment's (east, north) heading vector from `instanceStartPositions`/`instanceEndPositions` (Δlng scaled by `cos(lat)` so the vector is metric under Web Mercator) and passes it to the fragment as a varying. The fragment maps that heading — and its 180°-flipped reverse — through a four-color cyclic ramp anchored at the cardinal directions, then blends forward and reverse hues by `(dir + 1) / 2`:

- `dir = +1` (full forward): pure forward-heading hue.
- `dir = 0`: an even 50/50 blend — the same instant the arrow shape flattens to a dash.
- `dir = -1` (full reverse): pure reverse-heading hue (the heading rotated 180°).

The resulting hue replaces `color.rgb` under the chevron band (`chevronHead`) only; the track between arrowheads keeps the host layer's own color.

### Per-trip light

With `perTripLight: true`, the extension treats the incoming fragment color as two independently packed signals (as produced by `FlowCorridorLayer`'s `chevronPerTripLight` mode): RGB is a rolling-window aggregate (its luminance drives a faint background track), and alpha is an instantaneous flash signal in `[0, 1]`. The shader recombines them as:

```
arrowAlpha = mix(perTripFloor, 1.0, colorIn.a)
trackAlpha = baseAlpha * luminance(colorIn.rgb)
color.rgb  = mix(colorIn.rgb, arrowHue, chevronHead)
color.a    = mix(trackAlpha, arrowAlpha, chevronHead)
```

so the recession between flashes is carried purely by alpha (the directional hue stays saturated) while the always-on track reflects overall volume.

### Animating the march

Each `draw()` call reads the host layer's play-head — via a `getTime` callback if the host provides one (preferred; see [Requirements](#requirements)), falling back to a static `currentTime` prop — and reduces it into a phase:

```
phase = ((time / 1000) * speed) mod period
```

The modulo is computed on the CPU in double precision before the value is written into an f32 uniform, because the raw epoch-millisecond play-head (~1.7 × 10¹²) would lose all sub-second precision as an f32; only the already-small `phase ∈ [0, period)` is uploaded. The uniform block (`period`, `phase`, `skew`, `duty`, `feather`, `baseAlpha`) is the only per-frame update — geometry and vertex attributes never change — so animating the chevrons costs one small uniform upload per frame, independent of feature count.

## Requirements

- The host layer must be `PathLayer`-based: the shader reads `PathLayer`'s `geometry.uv` and `vPathLength` varyings and (for `directionColor`) its `instanceStartPositions`/`instanceEndPositions` attributes. It composes with `AnimatedPathLayer`, `AnimatedTripsLayer`, `FlowCorridorLayer`, and `FlowStrokeLayer`, but not point or polygon layers.
- The host layer must forward a `getTime` (preferred) or `currentTime` prop for the shader to read a play-head from — the same convention as [`TimeFilterExtension`](./time-filter-extension.md). The animated-trips layer family (and thus `FlowCorridorLayer`) does this already via its `TimeFilterExtension` plumbing.
- `perBucketDirection` requires the host to supply the signed direction through the reused `instanceVertexTime` slot (e.g. `FlowCorridorLayer`'s `signedFlow` prop); without a cooperating host it reads whatever value the host happens to leave there.

### Host-capability degradation

`getShaders()` inspects the host layer's props and **degrades any option whose
symbols the host does not provide, emitting one named console warning** — where
it previously emitted an undeclared GLSL identifier and blanked the layer:

| Option                             | Host requirement                                                                 | Degrades to                    |
| :--------------------------------- | :------------------------------------------------------------------------------- | :----------------------------- |
| `uniformSpacing`, `directionColor` | A `PathLayer`-family host (detected by a `getPath` accessor in the merged props) | Raw `period` / inherited color |
| `perBucketDirection`               | A sibling `TimeFilterExtension` (it is what declares `instanceVertexTime`)       | Static geometry winding        |

A host whose props cannot be inspected at all is assumed capable, so nothing
silently turns itself off. The `TimeFilterExtension` check is by static
`extensionName`, not `instanceof`, so a duplicate module instance (a dependency
hoisted twice) does not defeat it.

## Performance

The shader-injection object returned by `getShaders()` is memoized per extension instance — deck.gl calls `getShaders()` on every sublayer construction, and a fresh object each time would thrash the shader/pipeline cache. Because a `LayerExtension` instance's options are compared by value (not reference) when keying the repo's sublayer cache, constructing a fresh `new ChevronFlowExtension(opts)` on every render is free as long as `opts` is stable. deck's own diff (`LayerExtension.equals`) is a depth-1 `deepEqual`, which compares arrays **by reference** — so `directionColors` is interned by content in the constructor. Without that, an inline palette literal written fresh each React render looked "changed" every frame, `extensionsChanged` fired, and the sublayer silently destroyed and rebuilt its `Model`. Per-frame updates are limited to the one small uniform block described above; use `getTime` rather than `currentTime` so the host layer instance itself stays cached across animation ticks.

## Limitations

- Direction always derives from geometry winding (`instanceStartPositions` → `instanceEndPositions` order) or, with `perBucketDirection`, from a value the host layer supplies — never from a value computed inside the extension itself. Geometry that is not pre-oriented toward a meaningful real-world direction will still animate, just along its raw digitization order.
- `perBucketDirection` shares the `instanceVertexTime` attribute slot with `TimeFilterExtension`'s trail mode; do not combine it with a host configuration that also needs `instanceVertexTime` for genuine per-vertex timestamps.
- Option values are read once per extension construction; changing them requires constructing a new `ChevronFlowExtension`, not mutating an existing instance's props. (`directionColors` is the exception in one direction only: an _equal-by-content_ palette is interned to the same reference, so re-constructing with the same colors is free.)

## Related layers

[`FlowCorridorLayer`](./flow-corridor-layer.md) is the primary host: its `signedFlow` prop feeds `perBucketDirection`, and its `chevronPerTripLight` prop feeds `perTripLight`. [`FlowStrokeLayer`](./flow-stroke-layer.md), which extends `FlowCorridorLayer` for merged, directed corridor networks, inherits the same pairing. Unlike those layers' own per-vertex gradient coloring, `ChevronFlowExtension` is a standalone `LayerExtension` and can be added to any other `PathLayer`-based layer via the inherited `extensions` prop.

## Source

[packages/layers/src/extensions/chevron-flow-extension.ts](../../packages/layers/src/extensions/chevron-flow-extension.ts)
