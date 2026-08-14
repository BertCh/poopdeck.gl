# @poopdeck.gl/maplibre

## 0.6.0

### Minor Changes

- d5163aa: Packed `formatVersion: 3` — tiles are addressed by variant, not just by `(z,x,y,t)`

  A raw tile and a summary (H3/Quadbin) tile could occupy the same
  `(zoom, x, y, time-bucket)` address, because that address had no room to say
  _which product_ it named. The two collided in the directory and in every client
  cache keyed on it. v3 adds the missing axis:
  - **`manifest.variants` is a required registry.** Every directory entry's
    `variant_id` resolves to exactly one entry in it. Variant 0 is always `raw`;
    the canonical summary variant is 1.
  - **Directory codec v6** carries `variant_id` per entry, and object magic moves
    to version byte 3.
  - **Sparse archives now pick the single-frame directory automatically** and
    archives with ≥ 8,192 entries page by default, instead of the previous fixed
    choice.

  **Readers open v2; writers only emit v3.** The window is deliberately
  asymmetric and read-only: a published archive is a durable artifact and several
  have no reproducible source, so a read-side cutover would strand them rather
  than migrate them. A v2 manifest has no `variants` key, which is not missing
  information — it _is_ the implicit raw-only registry, and its directory decodes
  every entry to variant 0. v1 is refused. There is no transcode path in either
  direction, and v2 forks in the container only, never below the layer frame.
  Both reference implementations pin the window as
  `MIN_PACKED_FORMAT_VERSION ..= PACKED_FORMAT_VERSION`.

  **Tile keys carry the variant.** The canonical key is now
  `z/x/y/t#<variant>` (plus the existing `@<bucketMs>` suffix on a temporal-LOD
  tile), and `parseTileKey` reports `variantId` back. This string is embedded in
  the OPFS cache key, so **the first load after upgrading is cold** — previously
  cached tiles are orphaned, not corrupted. If you built keys by hand anywhere,
  switch to `tileKey`/`parseTileKey`: a hand-spelled `z/x/y/t` now aliases a
  summary tile onto its raw twin, which is the collision this release exists to
  remove.

  **What you have to do.** Nothing, to keep reading what you already publish. To
  publish _new_ archives, rebuild with the 0.6.0 `stt-build` — the output is v3.

- 2a58eb4: One `STT` prefix for every layer class, so nothing shadows deck.gl

  deck.gl is the primary backend, so a real app imports `@deck.gl/*` and
  `@poopdeck.gl/*` into the same module constantly. Any name exported by both is
  therefore unwritable: TypeScript rejects the duplicate identifier, and in plain
  JS whichever import evaluates last wins. Through 0.5.x we shipped twelve such
  names. They are renamed, and **the old spellings are gone** — this is a clean
  break rather than a deprecation window, taken while the project is still
  pre-1.0. Update any import of a name in the table below to its new spelling.

  **What collided, and what it is now**

  | Package               | 0.5.x                 | 0.6.0                    | Collided with         |
  | --------------------- | --------------------- | ------------------------ | --------------------- |
  | `@poopdeck.gl/three`  | `ArcLayer`            | `STTArcLayer`            | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `IconLayer`           | `STTIconLayer`           | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `ColumnLayer`         | `STTColumnLayer`         | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `PolygonLayer`        | `STTPolygonLayer`        | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `PointCloudLayer`     | `STTPointCloudLayer`     | `@deck.gl/layers`     |
  | `@poopdeck.gl/three`  | `TripsLayer`          | `STTTripsLayer`          | `@deck.gl/geo-layers` |
  | `@poopdeck.gl/layers` | `DataFilterExtension` | `STTDataFilterExtension` | `@deck.gl/extensions` |
  | `@poopdeck.gl/core`   | `Layer`               | `STTTileLayer`           | `@deck.gl/core`       |
  | `@poopdeck.gl/core`   | `Position`            | `STTPosition`            | `@deck.gl/core`       |

  `DataFilterExtension` was the sharpest of these: deck's class and ours are
  _different implementations with different contracts_ (deck runs a JS
  `getFilterValue` accessor per row; ours binds a baked binary column named by
  `filterProperty`) — and `@poopdeck.gl/layers` imports both, because the heatmap
  and hexagon composites drive deck's stock extension over CPU rows. Same name,
  two classes, one package.

  `Layer` was the most in the way: `@deck.gl/core`'s `Layer` is the base class
  every deck layer extends, and every consumer inside this repo had already been
  forced to write `import { Layer as TileLayer } from '@poopdeck.gl/core'`.

  **Also renamed, for consistency rather than collision**

  `@poopdeck.gl/maplibre` already prefixed all fifteen of its layer classes with
  `STT`. `@poopdeck.gl/three` and `@poopdeck.gl/cesium` now match, so one layer
  kind has one spelling on every backend and the import path — not a redundant
  word inside the symbol — tells you which renderer you are on:
  - `@poopdeck.gl/three`: the remaining fourteen layer classes (`SurfelLayer` →
    `STTSurfelLayer`, `WideLineLayer` → `STTWideLineLayer`, `FlowmapLayer` →
    `STTFlowmapLayer`, and so on) plus every `*LayerOptions` type. Four of these
    (`FlowmapLayer`, `FlowCorridorLayer`, `H3SummaryLayer`, `QuadbinSummaryLayer`)
    had also been shadowing `@poopdeck.gl/layers`.
  - `@poopdeck.gl/cesium` (unpublished/experimental): `CesiumPointLayer` →
    `STTPointLayer`, and the same for path / arc / trips / tripHeads /
    batched-polyline.

  **Deliberately NOT renamed**
  - `@poopdeck.gl/layers`' `Animated*` layer family (`AnimatedPointLayer`,
    `AnimatedArcLayer`, …). The prefix already means "the time-animated variant of
    deck's X", it is already unique, and mirroring deck's vocabulary is the point.
  - `CollisionFilterExtension` in `@poopdeck.gl/layers`. It re-exports deck's own
    class unchanged, so both packages hand you the identical object — nothing to
    shadow. A test asserts that identity so the exemption cannot rot.
  - `Cesium*` camera/clock bridges (`CesiumView`, `attachCesiumClock`, …), which
    are named after CesiumJS concepts, not STT layer kinds.

  **Breaking changes**

  Every 0.5.x spelling in the table above has been removed; import the `STT*`
  name instead. A test (`deck-name-collisions.test.ts`) asserts none of them can
  be reintroduced and re-shadow deck.

  Also non-additive: `STTDataFilterExtension.extensionName` is now
  `'STTDataFilterExtension'` (was `'DataFilterExtension'`), and the renamed
  classes report their new names via `constructor.name`. Only code that compares
  those strings is affected.

### Patch Changes

- Updated dependencies [d5163aa]
- Updated dependencies [2c020da]
- Updated dependencies [d5163aa]
- Updated dependencies [a7b57dc]
- Updated dependencies [d5163aa]
- Updated dependencies [2a58eb4]
  - @poopdeck.gl/core@0.6.0

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
