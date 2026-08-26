# @poopdeck.gl/three

## 0.7.0

### Minor Changes

- [`bfba49c`](https://github.com/BertCh/spatiotemporal-tiles/commit/bfba49c9e5abcd4d1ab301c61fe18b4788d7f18c) Thanks [@BertCh](https://github.com/BertCh)! - **The three non-deck backends render every frozen `LayerKind`.** three, maplibre
  and cesium each close the last of their gaps in one pass, and now cover all 23
  kinds — two more than deck, which still has no `ego` layer and degrades
  `isoLines` to `path`.

  Before this, "alternate renderer" meant "the movement family, and then you go
  back to deck". The gaps were not exotic: cesium had no polygon, no column and no
  summary tiers; maplibre could not draw a `path`; three fell back to `point` for
  anything heatmap-shaped. Every one of those was a demo that offered a renderer
  toggle and then drew nothing recognisable.

  ### New layers
  - **`@poopdeck.gl/cesium`** (+17) — a PRIVATE workspace package, frozen at
    0.5.0 and source-only, so it carries no version bump of its own: `STTPolygonLayer`, `STTColumnLayer`,
    `STTIconLayer`, `STTTextLayer`, `STTMeshLayer`, `STTBoundingBoxLayer`,
    `STTSurfelLayer`, `STTPointCloudLayer`, `STTHeatmapLayer`, `STTHexbinLayer`,
    `STTH3SummaryLayer`, `STTQuadbinSummaryLayer`, `STTFlowmapLayer`,
    `STTFlowCorridorLayer`, `STTFlowStrokeLayer`, `STTIsoLayer`, `STTEgoLayer`.
  - **`@poopdeck.gl/maplibre`** (+8): `STTPathLayer`, `STTTextLayer`,
    `STTMeshLayer`, `STTBoundingBoxLayer`, `STTSurfelLayer`,
    `STTPointCloudLayer`, `STTIsoLayer`, `STTEgoLayer`.
  - **`@poopdeck.gl/three`** (+6): `STTHeatmapLayer`, `STTHexbinLayer`,
    `STTTextLayer`, `STTMeshLayer`, `STTPointCloudLayer` (the new phong-lit one —
    see the separate breaking-rename entry), `STTFlowStrokeLayer`.

  ### Capabilities

  `liveBundling`, `userExtensions` and `timeAsHeight` are now true on all four
  backends; `cameraRoll` on all three non-deck ones (deck's `MapView` has no roll
  axis). Two flags stay honestly false and are not gaps to close later:

  - **cesium `gpuHeatmap`** — CesiumJS gives a primitive author no
    render-to-texture splat pipeline, so `STTHeatmapLayer` accumulates its density
    field on the CPU and uploads a raster. It renders the same image; it is not a
    GPU heatmap, and claiming the flag would be a lie a consumer could budget
    against.
  - **three `interleavedBasemap`** — structural, not unbuilt. TSL compiles to the
    renderer's own node graph; there is no seam to hand a foreign GL context.

  ### `@poopdeck.gl/core` — `./edge-bundling`

  KDEEB edge bundling (Hurter/Ersoy/Telea 2012; CUBu) is hoisted out of
  `@poopdeck.gl/layers` into a new `@poopdeck.gl/core/edge-bundling` subpath, so
  all four backends run **one** `bundleEdges` rather than four transcriptions of
  the same splat → advect → resample → smooth → anneal schedule. A bundle is a
  function of the edge SET alone — not the playhead, not the camera — which is
  what makes sharing it correct rather than merely convenient. deck keeps its GPU
  ping-pong (it already owns a luma `Device`, so the splat is free there) and
  agrees with the shared kernel on the schedule and the constants.

  `@poopdeck.gl/layers` re-exports the moved symbols from their old path, so
  nothing breaks; the copies are gone.

- [`bfba49c`](https://github.com/BertCh/spatiotemporal-tiles/commit/bfba49c9e5abcd4d1ab301c61fe18b4788d7f18c) Thanks [@BertCh](https://github.com/BertCh)! - **BREAKING (`@poopdeck.gl/three`): `STTPointCloudLayer` is renamed to `STTPointLayer`, and the `STTPointCloudLayer` name now belongs to a different layer.**

  (Declared `minor`, not `major`: the project is pre-1.0 and
  `docs/intro/status-and-support.md` states that a minor 0.x release can carry
  documented breaking changes. A `major` here would resolve to 1.0.0, which is
  a stability claim this release does not make.)

  The class that renders the `point` layer kind — flat, unlit billboards — was
  named `STTPointCloudLayer`, while `@poopdeck.gl/maplibre` and
  `@poopdeck.gl/cesium` both call that same kind `STTPointLayer`. That violated
  the one-spelling-per-kind rule stated in this package's own barrel header, and
  it left the canonical name occupied when the backend gained a real `pointCloud`
  kind (phong-lit 3D points with optional normals — deck's
  `AnimatedPointCloudLayer`).

  So:

  - `STTPointCloudLayer` → **`STTPointLayer`** (unchanged behaviour; the billboard
    point layer, moved from `layers/point-cloud-layer.ts` to `layers/point-layer.ts`).
  - `STTPointCloudLayerOptions` → **`STTPointLayerOptions`**.
  - **`STTPointCloudLayer` now names the new phong-lit `pointCloud` layer** — a
    different renderer with a different options type.

  There is deliberately **no deprecated alias**, because the old name is now taken
  by different behaviour: an alias would silently swap one renderer for another at
  runtime instead of failing at compile time. Callers must rename the import.
  The r3f wrapper `<STTPointCloudLayer>` is renamed the same way; the pre-0.5
  `SttPointCloudLayer` alias continues to resolve to the billboard point layer and
  is annotated accordingly.

### Patch Changes

- [`2ec0e4d`](https://github.com/BertCh/spatiotemporal-tiles/commit/2ec0e4ddf23c7eaa66a5fb060ccc508a95d45d77) Thanks [@BertCh](https://github.com/BertCh)! - **Onboarding fixes: a column inventory that is actually populated, a transport
  bar that works on a dark map, a precision warning that stops crying wolf, and a
  Node floor the browser packages do not need.**

  From a walk of the documented install-to-first-map path against the published
  packages and the hosted datasets.

  ### `@poopdeck.gl/core`
  - **`ArchiveMetadata.layers[].properties` is populated.** It is a typed, public,
    documented field that was hard-coded to `[]` on every archive ever opened, so a
    browser client's only route to its own column names was hand-decoding
    `manifest.schemas[].data` (base64 Arrow IPC) or installing the Rust CLIs. It is
    now derived at open from the manifest's own embedded schema templates — no tile
    fetch, no extra request — with each column classified as a string, a number or
    a boolean, plus `geometryTypes` off the CORE template's `stt:geometry` tag and
    measured `minValue`/`maxValue` when the builder recorded style hints. Fails
    soft in every direction: an unparseable template or an exotic column type drops
    that one item and leaves the rest of the metadata intact.
  - **The Float32 precision guard is scaled to the window being animated.**
    `assertRelTimeInRange` warned on a fixed 2^24 ms magnitude — an absolute
    constant of ~4.7 hours — so a dataset with a wider `timeWindow` tripped it by
    construction. The quickstart printed it on its first render, and so did the
    live showcase, both telling the reader to check a time offset that was correct.
    It now measures the actual f32 quantization step at the resolved magnitude
    against two floors: one 60 fps frame, and a fraction of the animated span. A
    genuinely mismatched `timeOffset` still reports. `assertRelTimeInRange` takes an
    optional trailing `spanMs`; `f32QuantumAt` and `RESERVED_TILE_COLUMNS` are newly
    exported.
  - `engines.node` relaxed from `>=24.0.0` to `>=20` (see below).

  ### `@poopdeck.gl/layers`
  - **`onMetadataLoad` is available on every layer**, not just the two summary
    layers. It fires once per archive init with the decoded metadata — the shortest
    path to "which column names does this dataset accept?":
    `onMetadataLoad: (meta) => console.table(meta.layers[0].properties)`.
    `H3SummaryLayer` and `QuadbinSummaryLayer` inherit it and no longer declare
    their own; behaviour there is unchanged.

  ### `@poopdeck.gl/react`
  - **The stylesheet ships a dark palette.** `styles.css` defined one light "paper"
    palette on bare `:root` with no dark variant, so the transport bar rendered
    near-black labels and a white scrubber track over the dark map every consumer
    floats it on. The same eight tokens now switch under
    `prefers-color-scheme: dark`, and `data-stt-theme="light" | "dark"` on any
    ancestor pins a mode — the case a dark map inside a light page needs. Setting
    the tokens yourself still wins over both.
  - **`PlaybackControlsProps.timeRange` is optional.** `usePlayback` echoes its
    `timeRange` option back so that `<PlaybackControls {...playback} />` "just
    works"; it worked at runtime and did not typecheck, because the echo is
    optional and the prop was required. Omitted, the bar falls back to the
    degenerate `[currentTime, currentTime]` range.

  ### All six browser packages

  `engines.node` moves from `>=24.0.0` back to `>=20`. The repository's own dev
  toolchain genuinely needs Node 24, but these packages' `dist` never executes
  under Node at all — and a floor above both the maintenance and active LTS lines
  hard-fails any consumer or CI running `engine-strict=true`, for nothing.
  `@poopdeck.gl/mcp`, which ships a `bin` and really does run under Node, stays at
  `>=24`.

- Updated dependencies [[`2ec0e4d`](https://github.com/BertCh/spatiotemporal-tiles/commit/2ec0e4ddf23c7eaa66a5fb060ccc508a95d45d77), [`4f4cd71`](https://github.com/BertCh/spatiotemporal-tiles/commit/4f4cd713a2866d4d58b68d95c2133366fa1152f4), [`bfba49c`](https://github.com/BertCh/spatiotemporal-tiles/commit/bfba49c9e5abcd4d1ab301c61fe18b4788d7f18c)]:
  - @poopdeck.gl/core@0.7.0
  - @poopdeck.gl/playback@0.7.0

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
