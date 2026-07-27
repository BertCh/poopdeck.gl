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
- Categories absent from `iconCategoryMapping` fall back to `icon`. An icon name
  absent from `iconMapping` renders a zero-size (invisible) sprite, matching
  deck's own `MISSING_ICON` behaviour.
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
