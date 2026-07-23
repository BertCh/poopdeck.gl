# @poopdeck.gl/maplibre

## Unreleased

### Minor Changes

- **Four new layer kinds + path reveal (Wave M3).** The adapter now ships NINE
  layer classes:
  - `STTIconLayer` — instanced sprite billboards from an atlas
    (`iconAtlas`/`iconMapping`), with per-FEATURE sprite selection
    (`iconProperty`, past deck's single-constant-icon limit), rotation in deck
    `getAngle` degrees, `sizeUnits: 'meters'`, an **icon wake**
    (`wakeLength`/`wakeTailScale`) and opt-in **CPU motion glide**
    (`interpolate`/`idProperty`/`maxInterpolationGap`/`reducedMotion`) through
    the hoisted core track kernel.
  - `STTColumnLayer` — instanced prisms (`diskResolution`/`radius`/`elevation`
    in metres/`extruded`/`stroked`) with the **space-time cube**
    (`timeHeightScale`/`timeHeightOrigin`/`reducedMotion`). Defaults to
    `renderingMode: '3d'`, so prisms occlude one another and the basemap's own
    fill-extrusions.
  - `STTArcLayer` — real 3D origin→destination arcs tessellated in the vertex
    shader (`numSegments` costs vertices, not bytes), with `arcHeight`/
    `arcTilt` over the great-circle ground distance and an opt-in
    `greatCircle` slerp path. **Replaces the `arc → line` descriptor
    fallback.**
  - `STTTripHeadsLayer` — the moving head dot at the live end of each trip,
    CPU-interpolated per frame through the shared core kernel, pairing with
    `STTTripsLayer`. Pickable (deck's `AnimatedTripHeadsLayer` is not).
  - `STTLineLayer` gains **progressive path reveal** (`revealTrail`/
    `revealDuration`/`reducedMotion`, default OFF): the frontier SEGMENT is
    drawn partially rather than popping in whole, and unrevealed geometry is
    unpickable.

  Descriptor flips: kinds `icon`/`column`/`arc`/`tripHeads` supported,
  `capabilities.timeAsHeight: true`, and all six `maplibreLayerFeatures` bits
  (`motionInterpolation`, `iconWake`, `dataFilter`, `timeHeightScale`,
  `stableColorMapping`, `pathReveal`) now supported. `text` degrades to the
  real `icon` layer, and every degrading kind's `reason` names what is LOST.

### Patch Changes (Wave M3 review pass)

- **Picking now honours DEPTH on 3d layers.** `STTBaseLayer.pick()` renders a
  `renderingMode: '3d'` layer's id pass against a depth attachment (LEQUAL,
  depth writes on, its own cleared depth buffer) instead of resolving overlaps
  by draw order. Only `STTColumnLayer` is affected today — its visible frame is
  depth-tested, so hovering the front prism could previously return the one
  hidden behind it. 2d layers keep the colour-only, depth-less pass, which is
  exactly how their frames paint.
- **A zero-alpha feature is no longer pickable** on `STTArcLayer`,
  `STTColumnLayer` and `STTTripHeadsLayer`: their id programs now carry the
  colour surface purely to gate on its alpha, matching deck's
  `picking_filterPickingColor` and the behaviour `STTIconLayer` already had.
  This makes the standard `sourceColor: [r,g,b,0]` arc gradient — and any
  `colorMapping` entry with alpha 0 — stop painting invisible hit boxes over
  visible features.
- **`STTColumnLayer`'s `radiusUnits: 'pixels'` means DEVICE pixels**, like every
  other pixel size in the package (`gl_PointSize`, `uViewport` offsets, the
  metres→pixels conversion). It previously resolved CSS pixels, so on a Retina
  display a disk drew twice its intended size while its own `lineWidth` outline
  (device px) stayed put. `resolveColumnRadiusScale` takes the ratio as a
  trailing argument. `'meters'` is unaffected.
- **`STTIconLayer` clamps `sizeMinPixels`/`sizeMaxPixels` BEFORE the wake taper
  and the DataFilter size shrink** (deck's order, and the arc/trip-heads order).
  A `sizeMinPixels` floor no longer cancels the wake tail — icons taper again
  instead of fading at a constant size.
- **`STTTripHeadsLayer` wake mode drops the CPU appear/disappear fade.**
  `sttWakeAlpha` already ramps from the trip's start, so folding the same ramp
  in a second time both dimmed the wake (a soft window with a `fadeInDuration`
  near `wakeLength` made it invisible) and inverted the tail taper, shrinking
  the just-departed head instead of the old one. Window mode is unchanged.
- **`STTIconLayer` glide performance.** The per-frame instance upload writes the
  ACTIVE prefix into a pre-sized store (`bufferSubData`) instead of
  re-specifying peak-capacity buffers every frame, the pick provenance walk no
  longer builds per-tile attribute buffers the glide path never binds, and the
  emit loop projects allocation-free (`lngLatToMercatorInto`, now shared with
  trip-heads via `lib/projection.ts`). `STTArcLayer.drawTile` compares its VAO
  axes as fields rather than building a key string per tile per frame.
- **Descriptor honesty.** `dataFilter` records that the `icon` kind's filter
  covers the DISCRETE path only — motion glide compiles no filter kernel, and
  the layer now warns once when both are configured. The `text → icon` fallback
  reason states that the marker renders only if the caller supplies
  `iconAtlas` + `iconMapping`.

### Patch Changes (Wave M3 integration)

- `STTTripHeadsLayer`'s interpolation-gap guard is spelled
  `maxInterpolationGap` (deck's name, and the same name `STTIconLayer` uses),
  not `maxGapMs`. The setter is `setMaxInterpolationGap`. The core kernel's own
  `TrackSampleConfig.maxGapMs` field is unchanged.
- Program-cache keys are namespaced per layer (`point:`/`icon:`/`polygon:`/
  `column:`/`tripHeads:`/…). Internal — the cache is per layer INSTANCE, so no
  behaviour changes — but point/icon and polygon/column previously emitted
  identical keys, which would collide the moment a layer-group host shares one
  cache.
- Three shared kernels replace copy-paste across layers: the elevated
  projection (`shaders/globe-elevation.glsl.ts`, was transcribed in
  polygon/column/arc), the billboard disc (`shaders/billboard.glsl.ts`, was
  transcribed in four fragment stages across point/trip-heads) and metric
  sizing (`STTBaseLayer.metricPixelScale`, was re-derived in seven layers).
- The draw path no longer allocates a colour tuple per tile per frame:
  `STTBaseLayer.rgba01Uniform` refills a per-slot cache where eight layers
  called `toRgba01` inside `drawTile`/`drawPickTile`.

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
  fallback kinds this backend cannot render. (Wave M3 re-adopted `text → icon`
  once `STTIconLayer` shipped; `mesh`/`hexbin` still skip.)

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
