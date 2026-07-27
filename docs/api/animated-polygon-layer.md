# AnimatedPolygonLayer

The `AnimatedPolygonLayer` renders time-series polygon data (e.g., county boundaries, zones). It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md) and provides GPU time-based visibility filtering for polygon features, with one `SolidPolygonLayer` sublayer per tile.

## Installation

```typescript
import { AnimatedPolygonLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
import { AnimatedPolygonLayer } from '@poopdeck.gl/layers';

const layer = new AnimatedPolygonLayer({
  id: 'covid-counties',
  data: 'https://example.com/covid-counties/manifest.json',
  currentTime: 1672531200000,
  timeWindow: 86400000 * 30, // 30 days
  fillColor: 'status', // categorical property name
  colorPalette: [
    [255, 255, 178, 180],
    [254, 204, 92, 180],
    [253, 141, 60, 180],
    [240, 59, 32, 180],
    [189, 0, 38, 180],
  ],
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Render Options

| Property             | Type               | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                             |
| :------------------- | :----------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filled`             | `boolean`          | `true`  | Whether to fill polygons.                                                                                                                                                                                                                                                                                                                                                                                               |
| `extruded`           | `boolean`          | `false` | Whether to extrude polygons in 3D.                                                                                                                                                                                                                                                                                                                                                                                      |
| `elevationScale`     | `number`           | `1`     | GPU multiplier applied to every elevation value (constant and column-driven). Only takes effect when `extruded`.                                                                                                                                                                                                                                                                                                        |
| `baseElevation`      | `number \| string` | `0`     | FLOOR of the extrusion, in the same metres as `elevation` — the polygon floats between this altitude and `elevation` instead of rising from the ground. Constant, or a numeric property name for a per-feature floor. Only takes effect when `extruded`. See [Floating extrusions](#floating-extrusions).                                                                                                               |
| `elevationThickness` | `number \| null`   | `null`  | Constant-thickness SHELL: extrude DOWNWARD from `elevation` by this many metres, so each feature's floor is its own `elevation - elevationThickness`. Wins over `baseElevation`; `0` leaves a flat sheet at altitude (top face only). Only takes effect when `extruded`.                                                                                                                                                |
| `wireframe`          | `boolean`          | `false` | Draw the edges of extruded polygons as a wireframe (SolidPolygonLayer pass-through), colored by `getLineColor`. Only takes effect when `extruded`.                                                                                                                                                                                                                                                                      |
| `seamWalls`          | `boolean`          | `false` | Raise side walls on the SYNTHETIC edges the tiler laid along tile boundaries when it clipped a polygon into per-tile pieces. `false` suppresses them — and the ring-closure walls deck would otherwise stitch from a polygon's exterior into its first hole — so the tile grid does not print through an extruded surface. `true` restores deck's raw `SolidPolygonLayer` behaviour. Only takes effect when `extruded`. |
| `material`           | `Material`         | `true`  | Lighting material for extruded polygons: `true` for the default phong material, `false` to disable lighting, or `{ambient, diffuse, shininess, specularColor}`.                                                                                                                                                                                                                                                         |
| `fadeInDuration`     | `number`           | `500`   | Duration (ms) for polygons to fade in.                                                                                                                                                                                                                                                                                                                                                                                  |
| `fadeOutDuration`    | `number`           | `500`   | Duration (ms) for polygons to fade out.                                                                                                                                                                                                                                                                                                                                                                                 |

### Data Accessors

| Property              | Type                            | Default              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| :-------------------- | :------------------------------ | :------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fillColor`           | `Color \| string`               | `[255, 140, 0, 180]` | Fill color: constant RGBA, or a property name for categorical coloring. Deliberate default drift from deck's opaque-black `getFillColor` — see [Deliberate default drift](#deliberate-default-drift).                                                                                                                                                                                                                                                                                                                                                                         |
| `getFillColor`        | `Color \| string \| null`       | `null`               | Upstream-vocabulary alias of `fillColor`. Accepts a constant or a property-column NAME — NOT a function accessor (binary tiles can't run per-feature JS; a function warns once and falls back). When set, it wins.                                                                                                                                                                                                                                                                                                                                                            |
| `elevation`           | `number \| string`              | `0`                  | Elevation for extruded polygons: constant, or a numeric property name. A column name the tile does **not** carry falls back to this layer's `0`, with a one-time console warning — it is never allowed through to deck's `SolidPolygonLayer.getElevation` default of `1000`, so a typo'd column name cannot silently extrude the whole archive a kilometre.                                                                                                                                                                                                                   |
| `getElevation`        | `number \| string \| null`      | `null`               | Upstream-vocabulary alias of `elevation` (same domain rules).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `colorPalette`        | `Color[]`                       | 10-color palette     | Palette for categorical `fillColor` (GPU lookup, up to 4096 entries).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `colorMapping`        | `Record<string, Color> \| null` | `null`               | Explicit category-string → color map. When set together with a string `fillColor`, each tile resolves its own category dictionary through this map into a per-tile palette, so a category keeps the same color across tiles whose dictionaries differ in order or subset — the bare `colorPalette` assigns colors by first-seen category index and drifts tile to tile. Stays on the GPU `CategoryColorExtension` path (the mapping only changes how the per-tile palette is built, not how it's sampled). Categories absent from the map fall back to `colorMappingDefault`. |
| `colorMappingDefault` | `Color`                         | `[0, 0, 0, 0]`       | Fallback color for categories absent from `colorMapping` (transparent by default).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Floating extrusions

deck's `SolidPolygonLayer` extrudes from the polygon's own vertex z
(`pos.z += elevations * elevationScale`), and STT polygon geometry is 2D, so a
plain `extruded` polygon is always a **prism standing on the ground**. When the
elevation column describes a surface in the air — a cloud-top height, a sea
surface, a canopy — that prism hangs a full-height curtain from the basemap up
to the surface, and the shape reads as a wall rather than a sheet.

`baseElevation` and `elevationThickness` give the extrusion a floor, so the
walls span exactly `[floor, elevation]`:

```ts
new AnimatedPolygonLayer({
  extruded: true,
  elevation: 'top_alt_m', // metres MSL, per feature
  elevationThickness: 300, // 300 m-thick shell hugging each band's own top
  elevationScale: 4, // shared vertical exaggeration
});
```

- **`elevationThickness`** hugs each feature's own top, so nested bands read as
  separate floating shelves you can see between. Use it for data that carries
  only a top surface.
- **`baseElevation`** sets an absolute floor: a constant gives every polygon the
  same base (nested bands fuse into one terraced mesa), a column name gives each
  feature its own (a true base-to-top slab, e.g. a cloud base).

The floor is baked into the tile's vertex z once per tile, **pre-multiplied by
`elevationScale`** (the shader scales only the thickness above the floor), and
elevation is rewritten to `top - floor`. Two consequences: the tile pays one
1.5× position-buffer copy instead of the zero-copy geometry path, and
`elevationScale` re-prepares tiles instead of being a live uniform — so animate
it only on layers that are not floating. An inverted floor (`base > top`) clamps
to zero thickness rather than extruding downward. With `stroked: true` the
outline rides the floor plane.

### Outline pass

Set `stroked: true` to draw an outline. This emits a **second sublayer** per
tile — a `PathLayer` on the polygon ring geometry (`_pathType: 'loop'`), drawn
over the fill. The outline is only constructed when `stroked` is true. For a
standalone outline with no fill, set `filled: false` and `stroked: true`.

**One path per RING.** The outline is fed from the tile's
[`ringIndices`](./binary-features.md) — the per-ring vertex offsets the decoder
surfaces alongside the feature-level `startIndices` — so holes and MultiPolygon
parts are each outlined, and no bridge segment is drawn from a polygon's
exterior into its first hole. (The fill's `startIndices` collapse a feature's
rings into one contiguous run; stroking those directly used to draw a diagonal
slash across every lake or burn scar and leave the holes un-outlined.) Archives
predating the `ringIndices` column fall back to `startIndices`, i.e. the old
one-loop-per-feature behaviour.

**`stroked` and `extruded`.** Following upstream `PolygonLayer`, the stroke is
**ignored for ground-anchored extrusion**: an extruded polygon's ring stroke
stays at the geometry's own `z`, which for STT's 2D polygon geometry is 0 — a
ghost ring lying on the basemap under each prism. The one deliberate divergence
is **floating** extrusion (`baseElevation` / `elevationThickness`), which lifts
the vertices themselves to the floor plane: there the outline rides the slab
with the fill and is kept. When the fill is extruded the outline is emitted
**before** it (upstream's extruded ordering), so translucent slabs blend the way
deck's do; for a flat fill the outline is emitted after, drawing on top.

| Property             | Type                               | Default                   | Description                                                                                                                                                                                                                                                                                         |
| :------------------- | :--------------------------------- | :------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroked`            | `boolean`                          | `false`                   | Draw a `PathLayer` outline on each polygon's rings (a second sublayer per tile). Deliberate default drift from upstream `PolygonLayer.stroked: true` — see [Deliberate default drift](#deliberate-default-drift). Ignored for ground-anchored extrusion (see above).                                |
| `getLineColor`       | `Color \| null`                    | `[0, 0, 0, 255]`          | Outline color: a **constant** RGBA only (not a column name, not a function accessor — a function warns once and falls back to the default). Also sets the `wireframe: true` extruded-edge color, which otherwise stays black.                                                                       |
| `getLineWidth`       | `number \| string \| null`         | `1`                       | Outline width: a constant or a numeric property-column name. Interpreted in `lineWidthUnits`, multiplied by `lineWidthScale`, clamped by `lineWidthMinPixels` / `lineWidthMaxPixels`. Only takes effect when `stroked`.                                                                             |
| `lineWidthUnits`     | `'pixels' \| 'meters' \| 'common'` | `'meters'`                | Units for `getLineWidth` (PathLayer pass-through).                                                                                                                                                                                                                                                  |
| `lineWidthScale`     | `number`                           | `1`                       | Global multiplier applied to every outline width (PathLayer `widthScale`, mirroring deck's `PolygonLayer.lineWidthScale`) — thicken or thin a whole layer's borders without touching per-feature widths.                                                                                            |
| `lineWidthMinPixels` | `number`                           | `0`                       | Clamp the outline to at least this many on-screen pixels so thin borders stay visible at low zoom.                                                                                                                                                                                                  |
| `lineWidthMaxPixels` | `number`                           | `Number.MAX_SAFE_INTEGER` | Clamp the outline to at most this many on-screen pixels (PathLayer `widthMaxPixels`). Load-bearing with the deck-matching `lineWidthUnits: 'meters'` default: without an upper clamp a metres-unit border grows without bound as you zoom in, until the outline is a slab covering its own polygon. |
| `lineJointRounded`   | `boolean`                          | `false`                   | Rounded outline joints (`PathLayer.jointRounded`).                                                                                                                                                                                                                                                  |
| `lineMiterLimit`     | `number`                           | `4`                       | Miter-joint length cap (multiples of line width); applies when `lineJointRounded` is false.                                                                                                                                                                                                         |
| `lineDashJustified`  | `boolean`                          | `false`                   | Justify outline dashes to segment endpoints (deck parity). Inert unless a `PathStyleExtension` dash is also supplied via `extensions`.                                                                                                                                                              |

### Geometry interpretation (escape hatches)

These are `SolidPolygonLayer` pass-throughs whose defaults **are** the zero-copy
tile path. Changing either of the last two is a per-dataset decision, not a
styling knob.

| Property        | Type            | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| :-------------- | :-------------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_full3d`       | `boolean`       | `false` | Tesselate XYZ polygons on their largest-area plane. **Currently inert against every archive the toolchain emits**, and surfaced only so the prop is already in place when that changes: the STT polygon decoder emits `positionDimensions: 2` unconditionally (no z to tesselate on), and any multi-ring tile ships pre-baked `triangles`, which bypasses deck's tesselator — the only place upstream reads this prop.                                                                                                                                    |
| `_windingOrder` | `'CW' \| 'CCW'` | `'CCW'` | Ring winding order of the tile geometry; effective only while `_normalize` is false. Drives deck's `RING_WINDING_ORDER_CW` define, which flips the extruded **side-wall normal** — i.e. whether walls are lit from outside or inside. Fills are unaffected. The Rust builder only normalizes winding on the antimeridian-split path, so a source wound the other way survives into the archive as-is (the shipped **wildfires** dataset is exactly that: ArcGIS-native clockwise exteriors, so it needs `'CW'`). There is no per-tile way to detect this. |
| `_normalize`    | `boolean`       | `false` | Hand the tile geometry back to deck's `PolygonTesselator`. **Escape hatch, not a supported render mode**, and it warns once when enabled: it re-runs earcut per tile (dropping the pre-baked `triangles`, which index the pre-normalization vertex order), makes `_windingOrder` inert, and — the real hazard — normalization need not preserve the tile's vertex order or count, while this layer's per-vertex time / category / filter / elevation buffers are all expanded against it. Surfaced for deck parity and hand-built non-STT data.           |

### Space-time cube

| Property          | Type      | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| :---------------- | :-------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeHeightScale` | `number`  | `0`     | Metres of altitude per simulation millisecond ([`TimeFilterExtension`](./time-filter-extension.md) pass-through). Non-zero raises every polygon vertex by `(featureStartTime - timeHeightOrigin) * timeHeightScale`, standing a flat choropleth up into a stack. **Window mode**: polygons rise by their per-feature start time, not per vertex. A single GPU uniform, so animating the flat-map ⇄ cube morph costs nothing per frame. `0` is a byte-identical flat render. |
| `reducedMotion`   | `boolean` | `false` | Honor `prefers-reduced-motion`: forces `timeHeightScale` to 0 so the map stays flat (no rise, no squash morph). Time playback and fades are unaffected.                                                                                                                                                                                                                                                                                                                     |

`timeHeightOrigin` (the absolute time mapped to altitude 0) is inherited from
[`SpatioTemporalLayer`](./spatiotemporal-layer.md).

### Column range filter

Installs [`STTDataFilterExtension`](./data-filter-extension.md) when — and only
when — `filterProperty` is set; unset means zero attribute, zero uniform, zero
shader change. The per-feature value is expanded per-vertex like the time
attributes, so a polygon filters as a whole; the `stroked` outline reuses the
same buffer and clips/fades in lock-step with the fill. Composes **with** the
time filter and the categorical fill path (`SolidPolygonLayer`'s non-instanced
fill has attribute headroom the tight `PathLayer` family does not).

| Property          | Type                       | Default | Description                                                                                                                                                                                                                                                                                    |
| :---------------- | :------------------------- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filterProperty`  | `string \| null`           | `null`  | Name of a baked **numeric** column to filter by. Accessor-alias of deck's `getFilterValue`: a column NAME, not a function. A categorical column warns once and is ignored; a tile that lacks the column renders unfiltered.                                                                    |
| `filterRange`     | `[number, number] \| null` | `null`  | Inclusive `[min, max]` bounds. `null` idles the filter (renders all) while keeping the column bound, so a range set later animates by uniform with no tile re-preparation. Note this differs from upstream deck's `[-1, 1]` default — see [`DataFilterExtension`](./data-filter-extension.md). |
| `filterSoftRange` | `[number, number] \| null` | `null`  | Optional soft `[min, max]` for a fade instead of a hard clip.                                                                                                                                                                                                                                  |
| `filterEnabled`   | `boolean`                  | `true`  | Enable/disable the filter without dropping the bound attribute.                                                                                                                                                                                                                                |

### Deliberate default drift

Two defaults intentionally differ from upstream deck.gl's composite
`PolygonLayer`:

| Property    | STT default          | deck default     | Why                                                                                                                                                                                                                     |
| :---------- | :------------------- | :--------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fillColor` | `[255, 140, 0, 180]` | `[0, 0, 0, 255]` | STT polygons are almost always a translucent overlay on a basemap, where opaque black reads as "the map failed to load". Pass `[0, 0, 0, 255]` for byte-exact deck parity.                                              |
| `stroked`   | `false`              | `true`           | Upstream draws one composite per dataset; this layer draws one per (tile, layer), so an outline nobody asked for would double the sublayer count and the draw calls on every tiled archive. Set `true` for deck's look. |

## Architecture & performance

- **Geometry-kind guard**: before preparing a tile the layer checks the tile
  layer's `geometryType` and **skips** any layer that is not `Polygon`,
  emitting one named console warning. `startIndices` alone does not identify a
  polygon tile — LineString tiles carry it too, and used to sail into this path
  to be tesselated as degenerate polygons. Tiles that predate the geometry-kind
  tag (`geometryType: undefined`) are trusted, not rejected.
- **GPU time filtering**: the shared
  [`TimeFilterExtension`](./time-filter-extension.md) runs directly on
  `SolidPolygonLayer` — polygons upload once per tile and time-window
  changes only update uniforms.
- **Categorical fill, flat vs extruded**: with `extruded: false` (the default)
  categorical fills lift to the GPU via
  [`CategoryColorExtension`](./category-color-extension.md) at zero CPU cost.
  With `extruded: true` the palette is instead **expanded on the CPU** into a
  per-vertex `getFillColor` buffer (4 bytes/vertex, once per tile prep).
  `SolidPolygonLayer` computes phong lighting in the _vertex_ shader and the
  fragment shader only forwards it, so the extension's `DECKGL_FILTER_COLOR`
  hook — which replaces rgb — would discard the lighting and render every prism
  flat and unlit. Feeding the color in through the attribute puts it where
  deck's own `getFillColor` accessor would have, so lighting survives.
- **Per-vertex attribute expansion**: `SolidPolygonLayer`'s fill model is
  non-instanced, so the extension attributes resolve to per-vertex there
  and the layer expands start/end times, category indices, and per-feature
  elevations across each feature's vertex range — once per tile prep,
  cached, never on the draw path.
- **Pre-baked triangles (MLT-style)**: when the tile carries a `triangles`
  index buffer it feeds `SolidPolygonLayer` directly through the binary
  `indices` attribute, skipping deck.gl's CPU earcut at tile-arrival time
  entirely. Sublayers run with `_normalize: false` by default, so deck's
  re-normalization pass is bypassed either way. This is also the path that
  renders **polygon holes** correctly: the fill's `startIndices` collapse a
  feature's rings into one contiguous run, and the exterior/hole structure
  rides the baked indices instead. `stt-build` bakes them for the whole layer
  whenever `--pre-tessellate` is passed **or** any feature in it is multi-ring
  (a hole, or a MultiPolygon), so holed archives get correct fills without the
  flag; `--pre-tessellate` only extends the sidecar to simple single-ring
  polygons. (Per-ring _outlines_ come from `ringIndices` instead — see
  [Outline pass](#outline-pass).)
- **Extruded tile seams**: `stt-build` clips polygon coverage to each tile rect
  exactly, so a polygon spanning a boundary arrives as two pieces whose fills
  abut watertight — flat fills show no seam. Extrusion is the case that did
  show one, because deck grows a side wall on every ring edge including the
  synthetic ones the clipper laid along the tile boundary; the layer now
  supplies its own `instanceVertexValid` wall mask to suppress those. See
  [`seamWalls`](#render-options) to opt back into deck's raw behaviour.
- **Known limitation (tile-seam overdraw)**: polygons spanning a tile
  boundary are split across tiles and drawn by separate sublayers. With
  `opacity < 1` the two halves blend twice along the seam; extruded
  polygons can z-fight. The `stroked` outline has the same limitation (the
  ring is split across sublayers, so it double-draws along the seam). Prefer
  fully-opaque fills.

The sublayer short ids for `_subLayerProps` overrides are **`polygons`** (the fill) and **`outline`** (the `stroked` `PathLayer`): `_subLayerProps: { polygons: { type: MyLayer, ... }, outline: { ... } }`.

## Source

[packages/layers/src/layers/core/animated-polygon-layer.ts](../../packages/layers/src/layers/core/animated-polygon-layer.ts)
