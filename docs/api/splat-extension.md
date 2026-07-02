# SplatExtension

The `SplatExtension` is a deck.gl layer extension that renders `ScatterplotLayer` points as soft gaussian "splats" instead of hard antialiased disks. It multiplies each fragment's alpha by a radial gaussian falloff from the point's center, so a disk fades to nothing at its rim. Overlapping splats blend into continuous surfaces, which reads as a colored point-cloud / "poor-man's-photogrammetry" look rather than a field of discs.

It is a pure fragment-stage effect — no extra attributes, no uniforms, no CPU cost, and no configuration props.

## Installation

```typescript
import { SplatExtension } from '@poopdeck.gl/layers';
```

## Usage

`AnimatedPointLayer` installs it internally when `splat: true` (see [`AnimatedPointLayer.splat`](./animated-point-layer.md)), but it can be applied to any `ScatterplotLayer` directly:

```typescript
import { ScatterplotLayer } from '@deck.gl/layers';
import { SplatExtension } from '@poopdeck.gl/layers';

const layer = new ScatterplotLayer({
  id: 'splat-points',
  data: myData,

  extensions: [new SplatExtension()],

  getPosition: d => d.coordinates,
  getRadius: 8,
  billboard: true,
});
```

It is stateless — a single shared instance can serve every sublayer of a family.

## How it works

- The fragment shader reads `geometry.uv`, deck.gl's unit position within the point sprite (0 at the center, 1 at the disk edge), and computes `r² = dot(geometry.uv, geometry.uv)`.
- Alpha is multiplied — never replaced — by `exp(-3.0 · r²)`. At the disk edge (`r² = 1`) that factor is ≈ 0.05 (nearly transparent rim), giving a soft but still legible dot. The falloff constant is fixed and not exposed as a prop.
- Because it multiplies into the existing alpha, it composes with whatever alpha earlier extensions in the list already wrote — the temporal fade/wake alpha from [`TimeFilterExtension`](./time-filter-extension.md) and the categorical alpha from [`CategoryColorExtension`](./category-color-extension.md) both survive underneath the splat shaping. Install it **after** those extensions in the layer's `extensions` list so it shapes the final alpha.

## Pairs well with

- `rgbColorColumns` / `colorVectorColumn` (per-point camera RGB) — overlapping splats colored from projected camera returns read like a photograph sprayed onto the 3D structure.
- A slightly larger `radius` and a touch of transparency (lower `opacity` or alpha in `fillColor`).
- `billboard: true`, so every splat faces the camera.

## Limitations

- Relies on `geometry.uv` semantics, so it only applies to `ScatterplotLayer` (and layers built on it, like `AnimatedPointLayer`'s point sublayers) — not path, polygon, or arc layers.
- The gaussian falloff constant is fixed at build time; there is no prop to tune softness per layer instance.

## Source

[packages/layers/src/extensions/splat-extension.ts](../../packages/layers/src/extensions/splat-extension.ts)
