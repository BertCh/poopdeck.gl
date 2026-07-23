# @poopdeck.gl/maplibre

## Unreleased

### Minor Changes

- **Host-adaptive rendering (Waves M0–M1).** The peer range widens to
  `^3 || ^4 || ^5 || ^6`. On maplibre v5/v6 the layers compile the host's
  injected projection prelude and project through `projectTile*`, so **globe
  renders natively** (including the globe↔mercator transition); maplibre ≤v4
  and mapbox v3 keep the legacy `uMatrix` path byte-for-byte. Programs are
  cached per `shaderData.variantName`. Adds globe chord subdivision, styledata
  re-add + context-loss hardening, and an opt-in `SharedTilesetSource` so N
  layers can share one archive.
- **Feature parity on the five kinds (Wave M2).** All four time-filter modes
  (`timeFilterMode: window | wake | cumulative | trail`) on point/line/polygon/
  heatmap and trail/wake on trips; a GPU `DataFilter`
  (`filterProperty`/`filterRange`/`filterSoftRange`/`filterEnabled`/
  `filterTransformSize`/`filterTransformColor`) on all five; metric sizing
  (`radiusUnits: 'meters'` on points, `widthUnits: 'meters'` on line/trips);
  and id-FBO **picking** (`layer.pick(x, y)`) on point/line/polygon/trips.
  Descriptor flips: `globe`, `picking` (`pickMechanism: 'id-fbo'`),
  `metricSizing`, all four `timeFilterModes`.

### BREAKING

- **`STTPolygonLayer.altitudeScale` changed meaning (campaign D10).** It was
  the raw elevation-units→mercator-z factor defaulting to `1e-7`, a flat,
  latitude-blind approximation **4.003× larger** than the correct equatorial
  value — extrusions stood ~4× too tall. It is now a **dimensionless
  exaggeration multiplier defaulting to `1`**, and the metres→mercator-z
  conversion is done per tile at that tile's own latitude.
  - `extruded: true` layers on the default `altitudeScale` get ~4× SHORTER (and
    latitude-correct) prisms. That shrink is the fix.
  - Apps that explicitly passed `altitudeScale: 1e-7` **must drop the prop** (or
    pass a real exaggeration factor). Keeping it now multiplies the correct
    factor by 1e-7 and flattens every prism to nothing.
  - `extruded: false` (the default) and `elevation: 0` (the default) are
    unaffected.
- **A non-positive `trailLength` no longer means "reveal the whole past".** It
  now resolves ONE way package-wide, matching deck: layers with a window kernel
  (point/line/polygon/heatmap) degrade `timeFilterMode: 'trail'` to `'window'`,
  and `STTTripsLayer` (which has no window kernel) draws nothing. Previously
  line/polygon/heatmap lit every past feature at full alpha.
- `STTLineLayer`'s defaulted `wakeLength`/`trailLength` and
  `STTHeatmapLayer`'s defaulted `trailLength` now TRACK `setTimeWindow()`
  instead of snapshotting the constructor's `timeWindow`. Explicitly-passed
  lengths are unchanged.

### Patch Changes

- `pick()` now captures and restores BLEND/DEPTH_TEST, the clear colour and the
  bound vertex array, and runs its id pass on the default VAO. Picking from a
  `mousemove` handler (outside the host render pass) no longer corrupts the
  basemap's cached GL state or its vertex arrays.
- Trail mode without a baked `vertex_time` column now synthesizes per-vertex
  times by cumulative DISTANCE (the shared `@poopdeck.gl/core/trips` kernel)
  rather than by vertex index, so a long leg no longer flashes past at a short
  leg's rate.
- Polygon geometry is subdivided only on GLOBE frames (mercator, legacy or v5,
  is affine and needs none); `STTTripsLayer.drawPickTile` resets its attribute
  divisors; the descriptor's `text`/`mesh`/`hexbin` entries no longer name
  fallback kinds this backend cannot render.

## 0.4.0

### Minor Changes

- Version alignment with @poopdeck.gl/core 0.4.0 (packed formatVersion 2
  reader, CRC-32C verification, capabilities gate).

## 0.3.0

### Patch Changes

- Backend descriptors now enumerate the new layer kinds (`text`, `mesh`,
  `pointCloud`, `hexbin`) with their documented fallbacks, keeping the
  cross-backend capability matrix complete.
- Updated dependencies
  - @poopdeck.gl/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @poopdeck.gl/core@0.2.0

## 0.1.1

### Patch Changes

- Correct the published READMEs: the 0.1.0 tarballs still carried the
  pre-release "Not yet published to npm — consume it from the monorepo"
  banners. Install sections now lead with the real `npm install` commands.
- Updated dependencies []:
  - @poopdeck.gl/core@0.1.1
