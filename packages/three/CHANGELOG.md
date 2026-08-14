# @poopdeck.gl/three

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
  - @poopdeck.gl/playback@0.6.0

## 0.4.0

### Minor Changes

- Version alignment with @poopdeck.gl/core 0.4.0 (packed formatVersion 2
  reader, CRC-32C verification, capabilities gate).

## 0.3.0

### Minor Changes

- 144cefb: SoTA geo-rendering upgrade for `@poopdeck.gl/three` (all additions are opt-in and backward-compatible):
  - **Streaming**: the viewport-driven `StreamingTileSource` (LOD selection, frustum culling, cache eviction, prefetch) is now drivable from `SttScene` / `StandaloneViewer` / `<SttCanvas>` via an opt-in `streaming` prop/option. Eager load-everything remains the default. Registers a real `TilesetBufferSource` with the playback governor for honest buffering.
  - **GPU picking + hover**: instanced point clouds are now pickable via the wired `GpuPicker` (previously only CPU ray-OBB boxes), and a new `onHover` callback fires on pointer-move (throttled). Fixed a latent bug where every GPU pick decoded feature index 0 (`readRenderTargetPixelsAsync` returns the pixels; the output-buffer arg was being misused as `textureIndex`), plus a background-sentinel and a concurrent-render race. `pickMechanism` is now `'gpu-id'`.
    - **Type change**: `SttPickInfo` is now a discriminated union `SttBoxPickInfo | SttPointPickInfo` — narrow on `kind` (`'object'` / `'ego'` are boxes; `'point'` is a cloud hit).
  - **Atmosphere / sky / day-night** (`createSttAtmosphere`, `<SttAtmosphere>`, `atmosphere` prop): physically-based sky, sun, environment IBL, and aerial perspective via `@takram/three-atmosphere/webgpu`. Opt-in, default off, WebGPU-only with a graceful WebGL2 degrade; the sun tracks the playhead date. Setup failures fall back to a plain render (never crashes a scene).
  - **3D Tiles / terrain / photorealistic** (`createStt3DTiles`, `<SttTiles3D>`, `createSttGlobeControls`): OGC 3D Tiles via `3d-tiles-renderer` — self-hosted `{ url }`, Google Photorealistic `{ google }`, or Cesium Ion `{ ion }` — plus ellipsoid-aware `GlobeControls`. Opt-in. Globe overlay co-registration requires the `GlobeProjection` `wgs84` datum.
  - **Projection-aware `<SttCanvas>`**: new optional `projection` prop (default local-ENU, unchanged) with a projection-aware camera rig and controls — Mercator (flat, exact web-mercator) and Globe (ECEF, orbit + `frameGlobe`/`setGlobeClip`), unlocking globe scenes, atmosphere, and 3D tiles in the r3f binding.

  New peer/regular dependencies: `@takram/three-atmosphere`, `@takram/three-geospatial`, `3d-tiles-renderer`.

### Patch Changes

- Updated dependencies
  - @poopdeck.gl/core@0.3.0
  - @poopdeck.gl/playback@0.3.0

## 0.2.0

### Patch Changes

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
