# SplatLayer

The `SplatLayer` renders a spatiotemporal point cloud — most commonly LIDAR returns — as **oriented anisotropic Gaussian surfels**: real elliptical disks lying in each point's local surface frame, evolving smoothly over time. It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

Where [`AnimatedPointLayer`](./animated-point-layer.md)'s `splat: true` draws each point as a soft, unoriented round billboard (an isotropic point splat — no surface frame), `SplatLayer` draws each feature as a true oriented ellipse tilted to match the surface it was sampled from, with a soft radial Gaussian falloff **and** a soft temporal Gaussian weight. Overlapping surfels read as a continuous, depth-correct surface rather than a field of discs — *surface splatting* (Pfister/Zwicker surfels, Zwicker's "EWA Surface Splatting"), the right formalism for splats derived from an oriented surface scan rather than a volumetric optimization (contrast 3D Gaussian Splatting, which needs a per-frame back-to-front sort — `SplatLayer` does not, see [How it draws](#how-it-draws)).

`SplatLayer` is the deck-side analogue of `@poopdeck.gl/three`'s `SurfelLayer` — same primitive, same baked columns — and powers the "Surfel" render mode of the AV cockpit demos.

## Installation

```typescript
import { SplatLayer } from "@poopdeck.gl/layers";
```

## Data requirements

Each surfel feature needs:

| Column | Shape | Role |
| :--- | :--- | :--- |
| geometry `[lng, lat]` | tile geometry (2D) | surfel centre, x/y |
| `elevationProperty` column (default `z`) | numeric, metres | surfel centre, z — scaled by `elevationScale`. Absent ⇒ z = 0 (a flat carpet). |
| `quaternionColumn` (default `surfel_quat`) | `FixedSizeList<Float32,4>` `[qx,qy,qz,qw]` | surface-frame orientation; the rotation matrix's columns are `[tangent \| bitangent \| normal]` |
| `scaleColumn` (default `surfel_scale`) | `FixedSizeList<Float32,2>` `[s_major, s_minor]` | in-plane ellipse half-extents, metres |
| `colorColumn` (default `surfel_rgba`) | `FixedSizeList<UInt8,4>` RGBA | optional per-surfel colour, with confidence pre-folded into alpha |
| the feature's start time | — | the surfel's temporal Gaussian centre, `μ_t` |
| `is_dynamic` (fixed name, numeric) | `0`/`1` | optional [Worldbuild](#worldbuild-cumulative-reconstruction) static/dynamic flag |

`quaternionColumn` and `scaleColumn` are **required**: they must be the interleaved vector columns baked at build time by `stt-build --vector-group` (e.g. `scripts/data-generation/waymo_extract.py --surfel`, which derives them from a per-sweep k-NN covariance). A tile missing either — wrong name, wrong width, or never baked — is skipped entirely (one console warning, `SplatLayer:missingSurfelColumns`), not rendered with defaults. `colorColumn` degrades more quietly: if a tile lacks the named column, or it isn't width-4, that tile's surfels silently fall back to `fallbackColor` with no warning. `is_dynamic` similarly defaults every surfel to static when absent.

## Usage

### Surfel point cloud

```typescript
import { SplatLayer } from "@poopdeck.gl/layers";

const layer = new SplatLayer({
  id: "lidar-surfels",
  data: "/data/av-scene/lidar-surfel/manifest.json",
  currentTime,
  elevationProperty: "z",
  temporalSigma: 180, // ~1-2x the sweep interval
  sizeScale: 1,
});
```

### Worldbuild (cumulative reconstruction)

```typescript
const layer = new SplatLayer({
  id: "lidar-world",
  data: "/data/av-scene/lidar-world/manifest.json",
  currentTime,
  cumulative: true, // static surfels persist once revealed
  revealFade: 300, // 300ms fade-in for a newly revealed static surfel
  temporalSigma: 1e9, // effectively infinite — statics stay full-bright once revealed
  temporalSigmaDynamic: 200, // moving actors still smear at a short window
});
```

`is_dynamic = 0` (or absent) surfels appear at their first-seen time and stay resident forever after — the scene "builds itself" as the playhead advances — while `is_dynamic = 1` surfels keep the ordinary symmetric temporal Gaussian, so moving traffic reads as a ghosted motion smear threading through the solid reconstructed world.

### Scene-split ("stage + actors")

A near-static "stage" archive (the unmoving environment) rendered dim and always-on, layered behind an "actors" archive (moving objects) rendered with a short temporal window:

```typescript
const stage = new SplatLayer({
  id: "scene-stage",
  data: stageUrl,
  currentTime,
  temporalSigma: 1e9,
  temporalSigmaDynamic: 1e9, // pin every surfel full-bright, ignore the playhead
  opacity: 0.42, // recessive backdrop
});

const actors = new SplatLayer({
  id: "scene-actors",
  data: actorsUrl,
  currentTime,
  temporalSigma: 200,
  temporalSigmaDynamic: 200,
  sizeScale: 1.4, // chunkier disks so moving actors pop against the stage
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md). `SplatLayer` does **not** use [`TimeFilterExtension`](./time-filter-extension.md) — the soft temporal Gaussian (and the Worldbuild reveal) is baked directly into the primitive's own shader instead.

### Data columns

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `quaternionColumn` | `string` | `'surfel_quat'` | VECTOR column (`FixedSizeList<Float32,4>`) holding each surfel's orientation quaternion `[qx,qy,qz,qw]`. Required; a tile missing it is skipped (warns once). |
| `scaleColumn` | `string` | `'surfel_scale'` | VECTOR column (`FixedSizeList<Float32,2>`) holding the in-plane half-extents `[s_major, s_minor]` (metres). Required; a tile missing it is skipped (warns once). |
| `colorColumn` | `string \| null` | `'surfel_rgba'` | VECTOR column (`FixedSizeList<UInt8,4>`) holding per-surfel RGBA, confidence pre-folded into alpha. When present on a tile, its surfels are painted that colour; otherwise (or when `null`) `fallbackColor` is used. |
| `elevationProperty` | `string \| null` | `'z'` | NUMERIC column holding each surfel's altitude (metres). Bound as a separate zero-copy attribute and scaled by `elevationScale` in the shader. Absent ⇒ z = 0. |
| `elevationScale` | `number` | `1` | Multiplier applied to `elevationProperty` before it becomes z. |
| `fallbackColor` | `Color` | `[200, 205, 215, 255]` | Constant RGBA used when `colorColumn` is unset, `null`, or absent from a given tile. |

### Disk shaping

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `sizeScale` | `number` | `1` | Multiplier on every surfel's baked in-plane extents (`s_major`/`s_minor`). |
| `gaussianFalloff` | `number` | `3` | Radial Gaussian tightness: `alpha *= exp(-gaussianFalloff · r²)` over the disk, `r` the normalized radius (0 at centre, 1 at rim). Higher values give a tighter, more point-like core; lower values give a softer, more spread-out disk. |
| `alphaCutoff` | `number` | `0.04` | Fragments whose final alpha falls below this are discarded before depth write — faint disk rims never occlude, only the confident core does (no halo). |

### Temporal (soft Gaussian)

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `temporalSigma` | `number` | `180` | Soft temporal Gaussian width (ms) for STATIC surfels (or every surfel, when `cumulative` is off). Each surfel's opacity is multiplied by `exp(-½·((t-μ_t)/σ)²)`, so it brightens at its own sample time and fades within ±~3σ instead of hard-popping at a window edge. Tune to ~1-2× the sweep interval (e.g. Waymo LIDAR ≈ 100ms). |
| `temporalSigmaDynamic` | `number` | `0` | Soft temporal Gaussian width (ms) for DYNAMIC surfels (`is_dynamic = 1`). `0`/unset falls back to `temporalSigma`. |

### Worldbuild (cumulative reconstruction)

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `cumulative` | `boolean` | `false` | When `true`, a STATIC surfel (`is_dynamic` `0` or absent) appears at its `start_time` and persists forever after — the world "builds itself" as the playhead advances — while a DYNAMIC surfel keeps the ordinary symmetric windowed Gaussian (using `temporalSigmaDynamic`). When `false`, every surfel uses the plain symmetric Gaussian (`temporalSigma`). |
| `revealFade` | `number` | `0` | Reveal alpha-ramp duration (ms) for a STATIC surfel once it appears under `cumulative`: alpha ramps `0→1` over this many ms after `start_time`. `0` pops in instantly. Ignored when `cumulative` is `false`. |

## How it draws

- **Instance geometry** — each surfel is a flat-top **hexagon** circumscribing the unit disk (incircle radius 1) rather than a quad: every fragment the disk actually paints (`r ≤ 1`) lies inside the hexagon, so the rendered result is pixel-identical to a quad but with roughly **13% fewer fragments** entering the shader (the quad's discarded corners are never rasterized in the first place).
- **True 3D orientation, not a billboard** — the surfel's quaternion is turned into a rotation matrix whose columns are `[tangent | bitangent | normal]`; the hexagon's `(u,v)` corners are offset `u·s_major·tangent + v·s_minor·bitangent` metres from the centre (× `sizeScale`), mapped to common space via `project_size`. The disk is a real oriented ellipse in 3-space, so it foreshortens correctly under a tilted camera — a billboard never would.
- **Depth-tested, no-sort blending** — surfels are opaque-ish patches lying ON a scanned surface, so they render with depth-write **on** (`depthCompare: 'less-equal'`) and standard `src-over` alpha blending: the z-buffer gives correct occlusion for free, with **no per-frame back-to-front sort** — the expensive part of volumetric 3D Gaussian Splatting that surface surfels don't need. `alphaCutoff` discards faint rim fragments before they can write depth, so soft edges never punch a halo into the depth buffer while the confident disk core still occludes correctly.
- **Radial Gaussian falloff** — in the fragment shader, `r² = u²+v²` (0 at centre, 1 at rim); fragments with `r² > 1` are discarded outright, and the rest get `alpha *= exp(-gaussianFalloff · r²)`.
- **Soft temporal Gaussian** — evaluated per-instance in the vertex shader, before the quaternion→matrix and double-precision centre projection, so off-time surfels skip that work entirely:
  - **Symmetric mode** (default, or a DYNAMIC surfel even under `cumulative`) — `timeWeight = exp(-½·((t - μ_t)/σ)²)` with `σ` = `temporalSigma` (or `temporalSigmaDynamic` for dynamics). Once `timeWeight` drops below ~0.0111 (~3σ from `μ_t`), the instance is collapsed to a degenerate clip position — zero fragments, effectively free.
  - **Worldbuild reveal mode** (`cumulative: true`, STATIC surfel) — hidden before `start_time`; at/after it, `timeWeight` ramps `0→1` over `revealFade` ms (or pops to `1` instantly if `revealFade` is `0`) and then stays at `1` forever — no fade-out.
- **MapView only, never antimeridian-wrapped** — the tangent-plane offset is computed in web-mercator common space; GlobeView's non-linear projection is out of scope (the AV cockpit, the layer's main consumer, is a tilted `MapView`). Surfels are also local metre-scale patches, so the primitive never wraps geometry across the antimeridian.

## Architecture & performance

- **Zero-copy per-tile binding** — the quaternion, scale, and colour columns are baked at build time as interleaved `FixedSizeList` vector columns (`stt-build --vector-group`), so each tile hands them to the GPU straight from `binary.vectorProps` with no per-surfel CPU loop or re-interleave. Positions stay the tile's 2D geometry buffer; altitude rides its own zero-copy numeric column, scaled in the shader rather than on the CPU. A new tile costs exactly one sublayer and one GPU upload.
- **Two-level cache, split by what a prop change actually invalidates**:
  - a **prepared-tile cache**, keyed by tile + a *style* digest (`quaternionColumn`, `scaleColumn`, `colorColumn`, `elevationProperty`) — these choose which raw columns get bound, so changing one rebuilds the tile's attribute set;
  - a **sublayer cache**, keyed by tile + a *layer-props* digest (`temporalSigma`, `cumulative`, `revealFade`, `temporalSigmaDynamic`, `sizeScale`, `gaussianFalloff`, `alphaCutoff`, `elevationScale`, `fallbackColor`, `timeWindow`, inherited props, update triggers) — these are shader uniforms, so changing one only rewraps already-prepared tile data in a fresh sublayer, with no re-binding of GPU attributes.
  - Both caches are pruned to the live tile set only when the tile array reference changes, not on every render.
- **Custom `Model` primitive** — [`SplatPrimitiveLayer`](../../packages/layers/src/layers/internal/splat-primitive-layer.ts) (sublayer short id **`splats`**, for `_subLayerProps` overrides) is a fully custom luma.gl `Model`-based layer, like [`FlowLinesLayer`](./flow-lines-layer.md) — it calls the `picking` module's functions directly rather than riding deck's process-wide `DECKGL_FILTER_*` hooks, so it stays bundler-agnostic. The temporal Gaussian and Worldbuild reveal logic live in this shader, not in `TimeFilterExtension`.
- **Picking** — resolves through the base `SpatioTemporalLayer.getPickingInfo`; each sublayer carries its `tile` and `sttFeatures` so a hit decodes back to the picked feature's columns.

## Source

[packages/layers/src/layers/core/splat-layer.ts](../../packages/layers/src/layers/core/splat-layer.ts)
