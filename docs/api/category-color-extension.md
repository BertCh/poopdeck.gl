# CategoryColorExtension

The `CategoryColorExtension` is a deck.gl layer extension that provides GPU-based categorical color lookup. Instead of expanding category indices to RGBA colors on the CPU, it passes per-feature category indices to the GPU and samples a palette **texture** in the fragment shader.

## Installation

```typescript
import { CategoryColorExtension, CATEGORY_PALETTE_SIZE } from '@stt/deck.gl';
```

## Usage

```typescript
import { ScatterplotLayer } from '@deck.gl/layers';
import { CategoryColorExtension } from '@stt/deck.gl';

const layer = new ScatterplotLayer({
  id: 'categorical-points',
  data: myData,

  extensions: [new CategoryColorExtension()],
  categoryPalette: [
    [255, 0, 0, 255],   // Category 0: Red
    [0, 255, 0, 255],   // Category 1: Green
    [0, 0, 255, 255],   // Category 2: Blue
  ],
  getCategoryIndex: d => d.categoryId,
  useCategoryColor: true, // must opt in — off by default

  getPosition: d => d.coordinates,
  getRadius: 100,
});
```

In binary mode (how the STT layers use it), supply `instanceCategoryIndex` as a size-1 float attribute on the binary `data` object instead of `getCategoryIndex`.

## Extension Props

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `categoryPalette` | `Color[]` | `[]` | Color palette (up to `CATEGORY_PALETTE_SIZE` = **4096** entries). |
| `getCategoryIndex` | `Accessor<number>` | `0` | Accessor returning the category index (0..4095). |
| `useCategoryColor` | `boolean` | **`false`** | Enable categorical coloring. Off by default — the layer must opt in. With the extension installed but the toggle off, the layer draws its normal constant/accessor color, so it is safe to include unconditionally. |

## How it works

- The palette is uploaded as a **4096×1 RGBA texture** and sampled by category index in the fragment shader. A texture (rather than a `vec4[]` uniform array) is used because uniform-array size limits vary across GL backends and 4096 entries exceeds most platforms' guarantees.
- **Why 4096**: real datasets carry thousands of categories — AIS reaches ~3500 distinct MMSI country prefixes, airport-code datasets push ~2000 — so a smaller palette would force distinct categories to share colors. Palettes larger than 4096 warn and clamp rather than wrapping indices into incorrect (but plausible-looking) colors.
- **Shared, content-addressed texture cache**: palette textures are cached per GPU `Device`, keyed by palette CONTENT (a digest). Every sublayer of a layer family — and any other layer using the same palette — binds the SAME texture, created and uploaded exactly once (16 KB per distinct palette per device). Entries are refcounted by the layers bound to them and destroyed when the last layer unbinds (finalize or palette change), so a dataset switch cannot leak textures. A re-created but content-identical palette array never re-uploads.
- **Alpha composition**: the palette sample composes with the incoming alpha — `color = vec4(palette.rgb, palette.a * color.a)` — instead of replacing the whole vec4. Extensions run in list order (the STT layers use `[timeFilter, categoryColor]`), and the time filter has already written the temporal fade/wake alpha into `color.a`; replacing it would pin every categorical feature at the palette's own alpha and kill fades.
- The category-index attribute is registered with `stepMode: 'dynamic'`, so the same extension works on instanced layers (Scatterplot/Path) and non-instanced ones (`SolidPolygonLayer`'s per-vertex fill model) — the upstream `DataFilterExtension` pattern.

## Benefits

1. **Eliminates the O(n) CPU loop** and the 4n-byte RGBA buffer it produced per tile.
2. **Compact attribute**: one float per feature instead of 4 color bytes per feature (per vertex, on path layers).
3. **Dynamic palette changes**: a palette swap binds one freshly-uploaded texture instead of touching every tile's attributes.

## When the CPU path still applies

The GPU lookup indexes the palette by the per-tile category **index**. The STT layers fall back to CPU color expansion when you pass `colorMapping` (an explicit category-**string** → color map), because a string key can't index a texture. See `AnimatedPointLayer.colorMapping` for the trade-off (stable cross-tile colors vs CPU expansion per tile).

## Limitations

- Maximum 4096 categories (`CATEGORY_PALETTE_SIZE`); larger palettes warn once and use the first 4096.
- Category indices must be integers in `0..4095`; out-of-range indices clamp.
- When enabled, the palette lookup overrides the layer's normal RGB while preserving the incoming alpha (see above).

## Source

[packages/deck.gl/src/category-color-extension.ts](../../packages/deck.gl/src/category-color-extension.ts)
