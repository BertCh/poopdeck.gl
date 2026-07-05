# AnimatedIconLayer

The `AnimatedIconLayer` renders **directional markers** at point features, rotated per-feature by a heading column — the natural fit for moving objects like AIS vessels (`cog`) or aircraft (`heading`). It draws through deck.gl's `IconLayer` (`@deck.gl/layers`), one binary sublayer per tile, animated window-mode by the shared [`TimeFilterExtension`](./time-filter-extension.md).

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and follows the same instanced-at-points pattern as [`AnimatedPointLayer`](./animated-point-layer.md). Because binary tiles can't run a per-row `getIcon` accessor, **all features share one constant icon**; per-feature rotation, color, and size are full instanced attributes.

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
  angle: 'cog',                 // rotate by the heading column (degrees, CCW)
  color: [80, 200, 255, 255],
  size: 16,
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `iconAtlas` | `string \| Texture` | — | Sprite atlas (URL or texture). Required to render anything. |
| `iconMapping` | `Record<string, {x,y,width,height,...}>` | — | Named sub-rectangles into the atlas. |
| `icon` | `string` | `'marker'` | The single icon name used for ALL features (constant `getIcon`). |
| `angle` / `getAngle` | `number \| string` | `0` | Rotation in degrees (CCW from up) — constant or a numeric heading column. |
| `color` / `getColor` | `Color \| string` | `[255,255,255,255]` | Tint — constant or a categorical column (GPU palette; only meaningful for `mask: true` icons). |
| `size` / `getSize` | `number \| string` | `12` | Icon size — constant or numeric column. |
| `sizeUnits` / `sizeScale` / `sizeMinPixels` / `sizeMaxPixels` | — | — | `IconLayer` sizing pass-throughs. |
| `sizeBasis` | `'height' \| 'width'` | `'height'` | Which dimension of a non-square icon `size` measures — `IconLayer` pass-through. |
| `pixelOffset` / `getPixelOffset` | `[number, number] \| string` | `[0, 0]` | Screen-space `[x, y]` pixel offset — constant or a size-2 property-column name. |
| `billboard` | `boolean` | `true` | Face the camera in 3D views. |
| `alphaCutoff` | `number` | `0.05` | Alpha discard threshold `[0, 1]`; crisps masked-icon edges. |
| `textureParameters` | `Record<string, unknown> \| null` | `null` | Atlas sampler params (filtering/wrap); `null` keeps `IconManager` defaults. |
| `colorPalette` | `Color[]` | 10-stop | Palette for a categorical `color` column. |
| `fadeInDuration` / `fadeOutDuration` | `number` | `300` | Window fade ramps (ms). |

## Behavior notes

- **Heading convention**: `IconLayer.getAngle` is degrees **counter-clockwise** from the icon's up orientation; compass headings (CW from north) may need `360 - heading` baked into the source column.
- **Per-category icons** (keying the sprite by a categorical column) are a future enhancement — today the icon is constant.
- The sublayer short id for `_subLayerProps` overrides is **`icons`**.

## Source

[packages/layers/src/layers/core/animated-icon-layer.ts](../../packages/layers/src/layers/core/animated-icon-layer.ts)
