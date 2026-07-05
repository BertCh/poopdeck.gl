# DataFilterExtension

The `DataFilterExtension` is a deck.gl layer extension that GPU range-filters features by a single baked numeric column. A feature is rendered when its `filterValue` falls inside a `[min, max]` range and hidden otherwise, with optional soft fading at the edges — the CPU only updates one uniform block per `draw()`. It is the general-column sibling of the `TimeFilterExtension` (which is a hand-built `DataFilterExtension` specialized to the time window): both bind a per-feature numeric attribute and gate the feature in the vertex shader.

It works on instanced layers (`ScatterplotLayer`, `PathLayer`) and non-instanced ones (`SolidPolygonLayer`) alike: its `filterValue` attribute is registered with `stepMode: 'dynamic'`, which resolves to per-instance on instanced models and per-vertex on non-instanced ones — the same mechanism as upstream `DataFilterExtension`.

## Difference from deck.gl's `DataFilterExtension`

Upstream `@deck.gl/extensions` sources its filter value by running a JS **function** accessor (`getFilterValue`) over each data row. STT tiles are binary Arrow columns — there is no per-row JS to run. So the layer binds the `filterValue` attribute straight from a baked numeric column (zero-copy) and this extension reads that attribute plus a few constant uniforms. Consequently, at the **layer** level, callers filter through a `filterProperty` accessor-alias (a baked-column **name**); a function passed there warns once and is ignored. At the **extension** level, `getFilterValue` survives only as the internal binding accessor / the constant fallback used when a tile lacks the column. The public props (`filterRange`, `filterSoftRange`, `filterEnabled`, `filterTransformSize`, `filterTransformColor`) mirror deck's surface.

## Installation

```typescript
import { DataFilterExtension } from '@poopdeck.gl/layers';
import type { DataFilterRange } from '@poopdeck.gl/layers';
```

## Usage

The extension is used internally by the STT layers (`AnimatedPointLayer`, `AnimatedPathLayer`), which install it when a `filterProperty` (a baked-column name) is set and bind that column to the `filterValue` attribute zero-copy. It can also be applied to any deck.gl layer directly, supplying the `getFilterValue` accessor:

```typescript
import { ScatterplotLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@poopdeck.gl/layers';

const layer = new ScatterplotLayer({
  id: 'value-filtered-points',
  data: myData,

  extensions: [new DataFilterExtension({ filterSize: 1 })],
  getFilterValue: d => d.magnitude,
  filterRange: [2.5, 6.0],        // render features with magnitude in [2.5, 6.0]
  filterSoftRange: [3.0, 5.5],    // fade the [2.5, 3.0] and [5.5, 6.0] margins
  filterEnabled: true,

  getPosition: d => d.coordinates,
  getRadius: 100,
});
```

## Constructor options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `filterSize` | `1` | `1` | Number of scalar columns to filter by. **v1 supports `1` only** (a single numeric column). Any other value warns once and falls back to `1`. Multi-size filtering (2–4, `vec4` range with a per-component min-reduce), `fp64` precision, and category-bitmask filtering (`categorySize`) are deferred. |

## Extension Props

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `filterEnabled` | `boolean` | `true` | Enable/disable the filter. When disabled every feature is rendered (a no-op). The effective state is ALSO gated by whether a valid `filterRange` is present and — at the layer — whether the named column exists in a given tile. |
| `filterRange` | `DataFilterRange \| null` | `null` | Inclusive `[min, max]` bounds. A feature renders when its `filterValue` is within the bounds, hidden otherwise. `null` means "no range yet" → the filter idles and everything renders, so the attribute can be bound up-front and the range animated later (a slider) purely by uniform with zero tile re-preparation. |
| `filterSoftRange` | `DataFilterRange \| null` | `null` | If set, features fade in/out across the margin between `filterSoftRange` and `filterRange` instead of hard-clipping. A value inside `filterRange` but outside `filterSoftRange` renders "faded". Must sit INSIDE `filterRange` to have any effect (a soft edge wider than the hard edge is ignored per-edge, matching deck). |
| `filterTransformSize` | `boolean` | `true` | When a feature is "faded" (soft range only), also shrink its size/width. `ScatterplotLayer` honours this via `DECKGL_FILTER_SIZE`; layers without that hook (e.g. `PathLayer`) silently ignore it. |
| `filterTransformColor` | `boolean` | `true` | When a feature is "faded" (soft range only), also lower its opacity. |
| `getFilterValue` | `Accessor<DataT, number>` | `0` | **Internal** binding accessor for the `filterValue` attribute — the constant fallback used when a tile does not supply the binary column. STT-layer callers filter through the layer's `filterProperty` (a column name), NOT this. Kept for deck-surface parity; a function here is a plain deck accessor and never runs against binary tiles (which bind the attribute directly). |

## Types

```typescript
/** An inclusive [min, max] filter bound. */
type DataFilterRange = readonly [number, number];
```

## Behavior

- **Active vs idle.** The filter is active only when `filterEnabled` is true AND `filterRange` is a finite `[min, max]` pair. A `null` or malformed range idles the extension (renders everything), so the attribute can be bound before a range exists. When idle, the `enabled` uniform is `0.0` and the shader branch is skipped entirely.
- **Hard range.** With no `filterSoftRange`, `filterValue` inside `[min, max]` renders at full alpha and anything outside is discarded.
- **Soft fade.** With a `filterSoftRange` inside `filterRange`, features fade via `smoothstep` across each margin. Because `smoothstep` is undefined when its edges collapse, an edge whose soft bound is truncated by the hard bound falls back to a hard `step` on that side — matching upstream.
- **Vertex-stage collapse.** Fully-filtered features are collapsed at the VERTEX stage (a degenerate clip-space position ⇒ zero fragments rasterized). `filterValue` is per-FEATURE, so all vertices of a feature share it and the feature collapses as a whole.
- **Composition.** The extension uses a distinct GLSL module name (`sttFilter`), attribute (`filterValue`) and varying (`vDataFilterAlpha`), so it composes without name collision alongside `TimeFilterExtension`, `CategoryColorExtension`, and even deck's own stock `dataFilter` module. Each extension multiplies its own factor into `color.a`, so the temporal fade, categorical color, and column filter all compose.
- **f32 precision.** v1 compares `filterValue` in **f32**, so columns with very large magnitudes (raw epoch-ms, say) lose precision. Bake a pre-normalized / offset column for those. (Unlike time, which `TimeFilterExtension` relativizes for you.)
- **Installation cost.** With the extension installed but disabled (no range yet, or a tile missing the column) the layer still draws everything, so it is safe to include unconditionally. The STT layers go further and only install it when a `filterProperty` is set — no column named means zero attribute, zero uniform, zero shader change.

## Source

[packages/layers/src/extensions/data-filter-extension.ts](../../packages/layers/src/extensions/data-filter-extension.ts)
