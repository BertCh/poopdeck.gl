# AnimatedIconLayer

The `AnimatedIconLayer` renders **directional markers** at point features, rotated per-feature by a heading column — the natural fit for moving objects like AIS vessels (`cog`) or aircraft (`heading`). It draws through deck.gl's `IconLayer` (`@deck.gl/layers`), one binary sublayer per tile, animated window-mode by the shared [`TimeFilterExtension`](./time-filter-extension.md).

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and follows the same instanced-at-points pattern as [`AnimatedPointLayer`](./animated-point-layer.md). Rotation, color, and size are full instanced attributes. The sprite itself is constant by default, but setting [`iconProperty`](#per-category-icons) keys it off a categorical column: the layer bakes the per-feature `instanceIconDefs` buffer itself — one `iconMapping` lookup per distinct _category_, then a typed-array fill — which bypasses deck's per-row `getIcon` accessor that binary tiles cannot run.

## Installation

```typescript
import { AnimatedIconLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new AnimatedIconLayer({
  id: 'vessels',
  data: '/data/ais/manifest.json',
  currentTime,
  timeWindow: 24 * 3600 * 1000,
  iconAtlas: '/icons/arrow-atlas.png',
  iconMapping: { arrow: { x: 0, y: 0, width: 64, height: 64, mask: true } },
  icon: 'arrow',
  angle: 'cog', // rotate by the heading column (degrees, CCW)
  color: [80, 200, 255, 255],
  size: 16,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property                                                      | Type                                               | Default             | Description                                                                                                                                                                                                                                                                                                                            |
| :------------------------------------------------------------ | :------------------------------------------------- | :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iconAtlas`                                                   | `string \| Texture`                                | —                   | Sprite atlas (URL or texture). Required to render anything.                                                                                                                                                                                                                                                                            |
| `iconMapping`                                                 | `Record<string, {x,y,width,height,...}> \| string` | —                   | Named sub-rectangles into the atlas — **or a URL string** pointing at a JSON file of the same shape, which deck resolves asynchronously (its `iconMapping` prop is `async`). `iconProperty` needs the mapping's CONTENT, so it requires the object form; with a URL string the layer warns once and falls back to the constant `icon`. |
| `icon`                                                        | `string`                                           | `'marker'`          | The icon name used for every feature — and, when `iconProperty` is set, the fallback for features whose category resolves to no entry.                                                                                                                                                                                                 |
| `iconProperty`                                                | `string \| null`                                   | `null`              | Categorical column NAME whose per-feature value selects the sprite. See [Per-category icons](#per-category-icons).                                                                                                                                                                                                                     |
| `iconCategoryMapping`                                         | `Record<string, string> \| null`                   | `null`              | Explicit category value → icon NAME map for `iconProperty`. Unset means the category value _is_ the icon name.                                                                                                                                                                                                                         |
| `onIconError`                                                 | `(context) => void \| null`                        | `null`              | Called when deck's `IconManager` fails to fetch an icon (a bad atlas URL, a 403 on a credentialed atlas). Without it the failure is only observable as a `log.error` in the console. `IconLayer` pass-through.                                                                                                                         |
| `iconLoadOptions`                                             | `Record<string, unknown> \| null`                  | `null`              | loaders.gl load options for the **icon atlas** fetch — headers, credentials, a custom `fetch`. Deliberately split from the base `loadOptions`; see [Two load-options props](#two-load-options-props).                                                                                                                                  |
| `angle` / `getAngle`                                          | `number \| string`                                 | `0`                 | Rotation in degrees (CCW from up) — constant or a numeric heading column.                                                                                                                                                                                                                                                              |
| `color` / `getColor`                                          | `Color \| string`                                  | `[255,255,255,255]` | Tint — constant or a categorical column (GPU palette; only meaningful for `mask: true` icons).                                                                                                                                                                                                                                         |
| `size` / `getSize`                                            | `number \| string`                                 | `12`                | Icon size — constant or numeric column.                                                                                                                                                                                                                                                                                                |
| `sizeUnits` / `sizeScale` / `sizeMinPixels` / `sizeMaxPixels` | —                                                  | —                   | `IconLayer` sizing pass-throughs.                                                                                                                                                                                                                                                                                                      |
| `sizeBasis`                                                   | `'height' \| 'width'`                              | `'height'`          | Which dimension of a non-square icon `size` measures — `IconLayer` pass-through.                                                                                                                                                                                                                                                       |
| `pixelOffset` / `getPixelOffset`                              | `[number, number] \| string`                       | `[0, 0]`            | Screen-space `[x, y]` pixel offset — constant or a size-2 property-column name.                                                                                                                                                                                                                                                        |
| `billboard`                                                   | `boolean`                                          | `true`              | Face the camera in 3D views.                                                                                                                                                                                                                                                                                                           |
| `alphaCutoff`                                                 | `number`                                           | `0.05`              | Alpha discard threshold `[0, 1]`; crisps masked-icon edges.                                                                                                                                                                                                                                                                            |
| `textureParameters`                                           | `Record<string, unknown> \| null`                  | `null`              | Atlas sampler params (filtering/wrap); `null` keeps `IconManager` defaults.                                                                                                                                                                                                                                                            |
| `colorPalette`                                                | `Color[]`                                          | 10-stop             | Palette for a categorical `color` column.                                                                                                                                                                                                                                                                                              |
| `fadeInDuration` / `fadeOutDuration`                          | `number`                                           | `300`               | Window fade ramps (ms).                                                                                                                                                                                                                                                                                                                |

### Stable categorical color

| Property              | Type                            | Default        | Description                                                                                                                                                                                                              |
| :-------------------- | :------------------------------ | :------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `colorMapping`        | `Record<string, Color> \| null` | `null`         | Explicit category-string → color map. Forces the CPU per-feature RGBA path, which is the only way to get colors that stay stable across tiles carrying different category subsets. Takes precedence over `colorPalette`. |
| `colorMappingDefault` | `Color`                         | `[0, 0, 0, 0]` | Fallback for categories absent from `colorMapping` — transparent, so an unmapped category disappears rather than rendering a misleading color.                                                                           |

### Wake mode

| Property        | Type     | Default | Description                                                                                                                                                                                                                                                                                                                                                                 |
| :-------------- | :------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeLength`    | `number` | `0`     | When > 0, switches the [`TimeFilterExtension`](./time-filter-extension.md) into one-sided "ship wake" mode: an icon is visible only while `0 <= currentTime - startTime <= wakeLength`, its alpha fading to 0 at the trailing edge. Takes precedence over the symmetric window filter. The layer widens its own load window to `2 × wakeLength` so the tail stays resident. |
| `wakeTailScale` | `number` | `0.15`  | Trailing-edge size multiplier, forwarded for parity with [`AnimatedPointLayer`](./animated-point-layer.md). **No visible effect on icons** — the size-shrink shader hook is `ScatterplotLayer`-only, so the icon wake is alpha alone.                                                                                                                                       |

### Column range filter

Wires a baked numeric column into
[`STTDataFilterExtension`](./data-filter-extension.md). Icons whose value falls
inside `filterRange` render; the rest are hidden, or soft-faded via
`filterSoftRange`. It composes with the time filter — an icon must pass both.

| Property          | Type                       | Default | Description                                                    |
| :---------------- | :------------------------- | :------ | :------------------------------------------------------------- |
| `filterProperty`  | `string \| null`           | `null`  | Name of the baked numeric column to filter by.                 |
| `filterRange`     | `[number, number] \| null` | `null`  | Inclusive `[min, max]` bounds.                                 |
| `filterSoftRange` | `[number, number] \| null` | `null`  | Soft bounds inside `filterRange`; values between the two fade. |
| `filterEnabled`   | `boolean`                  | `true`  | Toggle the filter without dropping the bound attribute.        |

`filterProperty` is the accessor-alias of deck's `getFilterValue`: pass a column
NAME, not a function (a function warns once and is ignored). Leaving it unset
means the extension is not installed at all — zero attribute, zero uniform, zero
shader change. A tile lacking the named column renders unfiltered; a tile where
the column is _categorical_ warns once and idles (v1 range-filters numeric
columns only). The filter applies to the discrete window path — the glide path
below filters by activity instead.

### Motion interpolation (glide)

Icon archives carry one row per entity **per sample**, so a GPU time-window
filter shows every sample in the window at once and a moving marker pops. Glide
pools the loaded tiles' samples by `idProperty` and emits **one** icon per
active entity per frame, with position _and_ heading CPU-interpolated between
the samples bracketing the playhead.

| Property              | Type             | Default    | Description                                                                                                                                                                                      |
| :-------------------- | :--------------- | :--------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interpolate`         | `boolean`        | `false`    | Opt into the glide path. Used only when `interpolate && !reducedMotion &&` a resolvable `idProperty && wakeLength === 0`; any unmet condition leaves the GPU window path byte-identical.         |
| `idProperty`          | `string \| null` | `null`     | Categorical column NAME grouping samples into one track (AIS vessel id, aircraft `icao24`). Must be an EXACT per-entity id — a lossy or quantized id fuses distinct entities.                    |
| `maxInterpolationGap` | `number`         | `Infinity` | Largest gap (ms) between two of an entity's samples that glide interpolates across. A wider gap HOLDS the last sample (position and heading) rather than fabricating motion through a data hole. |
| `reducedMotion`       | `boolean`        | `false`    | Honor the viewer's reduced-motion preference: disables glide and degrades to the GPU window path.                                                                                                |

## Per-category icons

Set `iconProperty` to a categorical column name and each feature gets its own
sprite, mirroring how `color` keys a category column:

```typescript
const layer = new AnimatedIconLayer({
  iconAtlas: '/icons/transport-atlas.png',
  iconMapping: {/* object form required */},
  iconProperty: 'vessel_type',
  iconCategoryMapping: { cargo: 'ship', tanker: 'tanker', tug: 'boat' },
  icon: 'marker', // fallback for categories the map misses
});
```

- The column value is resolved to an icon name through `iconCategoryMapping`
  when set; otherwise the category value **is** the icon name (a key of
  `iconMapping`).
- Categories absent from `iconCategoryMapping` fall back to `icon`. A resolved
  icon name absent from `iconMapping` falls back to `iconMapping[icon]`; only
  when that is missing too does the feature render a zero-size (invisible)
  sprite, matching deck's own `MISSING_ICON` behaviour — and the layer warns
  once, naming the unmapped icon.
- Requires an **object** `iconMapping` (a URL string warns once and falls back).
- Ignored on the glide (`interpolate`) path, which re-emits one pose per entity
  and has no per-sample category to read.
- Unset (the default) ⇒ every feature uses the constant `icon` and no
  `instanceIconDefs` attribute is baked.

## Two load-options props

`iconLoadOptions` is deliberately separate from the base
[`SpatioTemporalLayer`](./spatiotemporal-layer.md) `loadOptions`:

- **`loadOptions`** (`SttLoadOptions`, inherited) — HTTP for the **archive**:
  manifest, directory, pack ranges.
- **`iconLoadOptions`** — loaders.gl options for the **icon atlas** fetch,
  reaching deck's `IconManager` as the sublayer's `loadOptions`.

`CompositeLayer.getSubLayerProps` does not forward `loadOptions`, so overloading
one prop for both would either break archive loading or leak archive auth
headers to a third-party atlas host.

## Behavior notes

- **Heading convention**: `IconLayer.getAngle` is degrees **counter-clockwise** from the icon's up orientation; compass headings (CW from north) may need `360 - heading` baked into the source column.
- **Point tiles only**: tile layers whose `geometryType` is not `Point` are skipped with one named console warning rather than misread as one position per feature.
- The sublayer short id for `_subLayerProps` overrides is **`icons`**.

## Source

[packages/layers/src/layers/core/animated-icon-layer.ts](../../packages/layers/src/layers/core/animated-icon-layer.ts)
