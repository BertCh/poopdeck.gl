# BundledFlowmapLayer

The `BundledFlowmapLayer` is [`FlowmapLayer`](./flowmap-layer.md) with **GPU kernel-density edge bundling**. Instead of drawing one straight tapered arrow per origin→destination pair, it relaxes geometrically-close flows into smooth **bundled rivers** — so a dense overview reads as flowing channels instead of a hairball of crossing arrows. The bundling runs **entirely on the GPU**, in the same ping-pong-float-texture style [cosmos.gl](https://github.com/cosmosgl/graph) uses for its force graph, and the bundled geometry never leaves the GPU.

It's a **drop-in superset** of `FlowmapLayer`: it consumes the same OD `vertexValueMatrix` tiles (`stt-generate bixi`), honors all the same `flow*` styling props, and keeps the same node-circle overlay. On a device that can't additively blend into a float texture, or for a tile with more edges than `maxBundledEdges`, it transparently falls back to `FlowmapLayer`'s straight arrows.

## How it works

The bundler implements **KDEEB** (Kernel-Density Edge Bundling — Hurter, Ersoy & Telea 2012) with a **CUBu**-style GPU pipeline (van der Zwan & Telea 2016) — the method behind the smooth, river-like bundles in the classic edge-bundling figures. (We prototyped force-directed bundling first, but its pairwise spring/electrostatic forces are O(E²) and look kinky; KDEEB is both smoother and GPU-native.)

Each edge is resampled to `subdivisionPoints` control points, then **15 annealed iterations** run on the GPU, one per frame so the rivers visibly settle:

1. **Splat** — additively rasterize an Epanechnikov kernel of bandwidth `h` at every control point into a density texture (a kernel-density estimate of where edges are).
2. **Advect** — move each interior control point a step along the **normalized density gradient** (toward where neighbouring edges already are — this is mean-shift).
3. **Resample** — redistribute each edge's points to uniform spacing (advection bunches them).
4. **Smooth** — one 1D Laplacian pass along each edge. *This is what makes the bundles smooth* — advection alone is jagged.
5. **Anneal** — shrink the kernel bandwidth and repeat, progressively tightening the bundles.

The bundle is a **stable spatial skeleton**: computed once per tile from the fixed edge set (not weighted by the playhead, so the rivers don't writhe as you scrub) and kept resident on the GPU. As the time slider moves, only each ribbon's **width** animates — sampled on the GPU from a per-tile `vertexValueMatrix` texture at the live playhead, so the edges need zero per-frame CPU work. Direction reads from a source→target **color gradient** along each river. Node circles keep `FlowmapLayer`'s cheap CPU aggregation.

Because the control points are seeded from each feature's **full polyline**, a 2-vertex OD pair bundles as a straight edge while an N-vertex routed trip / trajectory keeps its curve.

## Installation

```typescript
import { BundledFlowmapLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new BundledFlowmapLayer({
  id: 'bixi-flowmap-bundled',
  data: '/data/bixi-flowmap/manifest.json',
  currentTime,                       // driven live from the TimeController
  timeController,
  // FlowmapLayer styling (identical):
  widthScale: 1.1,
  widthMaxPixels: 14,
  sourceColor: [56, 196, 232, 235],
  targetColor: [255, 142, 64, 245],
  gap: 0.5,
  nodeRadiusScale: 1.3,
  minFlow: 0.5,
  // KDEEB bundling tuning:
  subdivisionPoints: 48,             // control points per edge (smoother curves)
  kernelRadius: 0.05,                // kernel bandwidth as a fraction of the tile
  bundlingIterations: 15,            // density-advection iterations
  smoothingStrength: 0.5,            // per-iteration Laplacian smoothing
});
```

## Properties

Inherits everything from [`FlowmapLayer`](./flowmap-layer.md) (and therefore [`SpatioTemporalLayer`](./spatiotemporal-layer.md)) — all `widthScale` / `sourceColor` / `gap` / `nodeRadius*` / `minFlow` props apply unchanged.

### Bundling (KDEEB)

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `subdivisionPoints` | `number` | `48` | Control points per edge (P). Higher = smoother, more sharply-defined rivers; more GPU work. |
| `kernelRadius` | `number` | `0.05` | Initial kernel bandwidth as a fraction of the tile's extent — the headline knob. Larger bundles flows together more aggressively (the CUBu literature default is 5%). |
| `bundlingIterations` | `number` | `15` | Number of density-advection iterations. More = tighter bundles (10–15 converges). |
| `smoothingStrength` | `number` | `0.5` | Per-iteration Laplacian smoothing strength in `[0,1]`. Higher = smoother (but over-smoothing washes out structure). |
| `maxBundledEdges` | `number` | `4000` | Above this many edges per tile, skip bundling and render straight arrows (keeps the per-frame density splat bounded). |

## Baked bundling (`preBundled`)

By default the bundling runs **live on the GPU** every time the visible tile set
changes. Alternatively you can **bake** the bundling into the tiles at build time
and have this layer render the precomputed geometry — set `preBundled: true` and
point it at tiles built with `stt-generate bixi --bake-bundling`:

```typescript
const layer = new BundledFlowmapLayer({
  id: 'bixi-flowmap-baked',
  data: '/data/bixi-flowmap-baked/manifest.json',
  preBundled: true,
  subdivisionPoints: 24,   // MUST match the build's --bundle-points
  // …all the same flow* styling props
});
```

In this mode the build relaxes each zoom's clustered hub-pair corridors with a
**deterministic CPU KDEEB** pass (one global density field per zoom — never
per-tile, which would seam) and stores the rivers as ordinary multi-vertex
polylines. The layer skips the GPU bundler entirely: it uploads the baked control
points once (`StaticBundle`) and renders them. `kernelRadius`,
`bundlingIterations`, `smoothingStrength`, and `maxBundledEdges` are ignored.

| | Live (default) | Baked (`preBundled`) |
|---|---|---|
| Bundling cost | per-frame relaxation (~15 frames to settle) | none — final on load |
| Device support | needs `EXT_float_blend` (else straight-arrow fallback) | needs only float-texture **sampling** (`isStaticBundleSupported`) — works on more mobile GPUs |
| Stability | re-bundles when the visible tile set changes | fixed at build time — stable under pan/zoom |
| Tuning | interactive (`kernelRadius` etc.) | fixed at build (`--bundle-*` flags) |
| Reproducible | n/a | yes (uniform step, pinned density resolution) |
| Wire size | small (2-vertex OD tiles) | larger (multi-vertex polylines) |

`subdivisionPoints` must equal the build's `--bundle-points` so each baked vertex
is sampled exactly. When the device can't sample a float texture the layer
degrades to straight endpoint-to-endpoint arrows (the baked curve collapses to its
origin/destination), so the demo still renders.

## When to use it vs `FlowmapLayer`

Reach for `BundledFlowmapLayer` at **overview zooms with many crossing corridors**, where straight arrows pile into visual clutter — bundling reveals the dominant flow structure. At deep zooms (few corridors per tile) the straight-arrow `FlowmapLayer` is clearer and cheaper; this layer falls back to exactly that above `maxBundledEdges`.

## Device support

The density splat additively blends into a float texture, which needs the WebGL2 `EXT_color_buffer_float` + `EXT_float_blend` capabilities (luma.gl features `float32-renderable-webgl` + `texture-blend-float-webgl`). Universal on desktop WebGL2 but absent on some mobile GPUs; there the layer degrades gracefully to straight arrows. The capability gate is exported as `isBundlingSupported(device)`, and the bundling engine itself as `EdgeBundler` for callers who want to bundle their own OD edges directly.
