# @poopdeck.gl/layers

## 0.6.0

### Minor Changes

- 83e1260: `AnimatedScenegraphLayer` — authored glTF assets on the track kernel

  New layer: a full glTF **scenegraph** (node hierarchy, PBR materials, per-node
  animation) instanced at each tracked object's interpolated pose. It is to
  `AnimatedMeshLayer` what deck's `ScenegraphLayer` is to its `SimpleMeshLayer`,
  and the catalog now mirrors that split rather than hiding it behind a mode flag.

  It **subclasses** `AnimatedMeshLayer` and inherits the whole pipeline — the AV
  `objects/` archive, cross-tile pooling by `track_id`, binary-search + lerp,
  shortest-arc heading, quaternion slerp, fades, grow-only instance buffers, lazy
  pick rows, the geometry-kind guard. Only the engine differs, and `scenegraph` /
  `scenegraphMapping` fall back to the inherited `mesh` / `meshMapping`, so one
  props object drives either class.

  **Why:** this is the consumption end of an OpenUSD pipeline — author in Omniverse
  (or any USD DCC), export to glTF, place the asset in the geospatial time scene.

  **New props:** `scenegraph`, `scenegraphMapping`, `_lighting`,
  `_imageBasedLightingEnvironment`, `_animations`, `sizeMinPixels`,
  `sizeMaxPixels`, `getScene`, `getAnimator`, `onFirstDraw`, and
  `scenegraphLoadOptions` (a dedicated prop because the base repurposes deck's
  `loadOptions` as `SttLoadOptions` for archive HTTP and does not forward it).

  **Two deliberate divergences from the mesh sibling**
  - `scaleToDimensions` defaults to **`false`**. The inherited `true` fits a
    _unit-sized_ model to each object's `[length, width, height]` box, which would
    silently squash an authored asset — those arrive already in real metres via
    USD's `metersPerUnit`.
  - Appear/disappear fades work on a **textured** asset. `SimpleMeshLayer` lets a
    `texture` win over `getColor` and kills the CPU alpha ramp;
    `ScenegraphLayer` multiplies `getColor` into the material instead, so the
    fade, the per-category color and `opacity` all modulate a textured PBR asset.

  **Four constraints, verified against deck 9.3.2 / luma 9.3.3 / loaders 4.4.2**
  and documented on the layer (with one-time warnings where detectable): skinned
  geometry does **not** deform (deck injects its own vertex shader, which declares
  no `JOINTS_0`/`WEIGHTS_0`); rigid per-node animation does work; but it runs on
  deck's `context.timeline`, **not** the STT playhead, so it neither rewinds on a
  scrub nor stops on pause, and needs `_animate: true` on the `Deck` instance; and
  `KHR_materials_clearcoat`/`_transmission`/`_sheen`/`_ior` have no loaders.gl
  handler, with `useTangents: false` hardcoded — so author to `UsdPreviewSurface`
  and stay on core metallic-roughness. Draco/KTX2/meshopt-compressed assets need
  no extra setup.

  `AnimatedMeshLayer` is unchanged in behaviour. Internally it grew four
  `protected` engine seams (asset resolution, the missing-asset warning, the
  engine caveat warnings, the engine id/class/props triple) that the subclass
  overrides; its 42 existing tests pass untouched.

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
  - @poopdeck.gl/playback@0.6.0

## 0.4.0

### Minor Changes

- `scrubLod` prop: degrade tile selection while the user scrubs the
  timeline (spatial zoom-drop / temporal-LOD routing), preview-only and
  default off.
- `onTileError` now passes `tileId: undefined` for dataset-level failures
  instead of a sentinel tile.
- Version alignment with @poopdeck.gl/core 0.4.0 (packed v2 reader).

## 0.3.0

### Minor Changes

- deck.gl parity superset. New layers on the SpatioTemporalLayer chassis:
  `AnimatedHexagonLayer` (discrete, pickable hexbin — the analog of
  `AnimatedHeatmapLayer`), `AnimatedMeshLayer` (one interpolated glTF/OBJ instance
  per tracked object), `AnimatedPointCloudLayer` (lit, time-windowed 3D points),
  and `AnimatedTextLayer` (time-filtered map labels). Two ported extensions:
  `DataFilterExtension` (GPU range-filter by a baked numeric column) and
  `CollisionFilterExtension` (de-clutter overlapping icons/labels), each with a
  spreadable `*Props` helper; deck's constant-config extensions pass through
  unchanged. Box and mesh layers now share one factored-out track kernel
  (pooling, binary-search + lerp, shortest-arc heading, appear/disappear fade).

### Patch Changes

- Updated dependencies
  - @poopdeck.gl/core@0.3.0
  - @poopdeck.gl/playback@0.3.0

## 0.2.0

### Patch Changes

- [`b6b74a0`](https://github.com/BertCh/spatiotemporal-tiles/commit/b6b74a07d12b5d6737243f5e19b7735a26cdd211) Thanks [@BertCh](https://github.com/BertCh)! - Onboarding fixes from the second published-package field test (AIS × hurricanes demo).
  - `@poopdeck.gl/react` now ships a stylesheet: `import "@poopdeck.gl/react/styles.css"` renders `PlaybackControls`/`HoverPreview` fully styled with no Tailwind in the host app — the file carries the compiled utility classes (no preflight, so it can't touch host styles) plus defaults for the theme tokens (`--accent`, `--surface`, `--ink-900/500/400`, `--hairline`, `--accent-soft`, `--page-bg`), all overridable from your own CSS. Tailwind v4 apps can instead register the package for scanning (`@source "../node_modules/@poopdeck.gl/react/src"`), now documented.
  - `usePlayback({ initialTime, timeRange })` honours `initialTime` — the mount-time range effect used to reset the playhead to the range start, making deep-linked `?t=` views impossible without a workaround. `initialTime` is clamped into the range and applies at mount only; a later `timeRange` change still resets to the new range start.
  - `<PlaybackControls {...pb} />` now spreads straight from the hook: the hook return echoes `timeRange` and exposes the speed under `currentSpeedMultiplier`, and the `targetPlaybackSeconds` prop is optional (default 60).
  - `@poopdeck.gl/layers` re-exports the governor-wiring callback parameter types (`SpatiotemporalTileset`, `BufferSource`, `BufferedRunway`) so `onTilesetReady`/`onBufferChange` handlers can be typed without depending on `@poopdeck.gl/core`/`playback` directly.

- Updated dependencies []:
  - @poopdeck.gl/core@0.2.0
  - @poopdeck.gl/playback@0.2.0

## 0.1.1

### Patch Changes

- Correct the published READMEs: the 0.1.0 tarballs still carried the
  pre-release "Not yet published to npm — consume it from the monorepo"
  banners. Install sections now lead with the real `npm install` commands.
- Updated dependencies []:
  - @poopdeck.gl/core@0.1.1
  - @poopdeck.gl/playback@0.1.1
