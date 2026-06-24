# `@poopdeck.gl/three` → general STT renderer (deck parity)

> Status: **W1 + all geographic layers built, verified & green (202 tests); showcase
> wiring + browser verify remain** (2026-06-23). Goal: turn the
> Three.js + TSL (WebGPU / WebGL2-fallback) renderer from an AV-cockpit-only
> engine (local ENU metric frame, eager load) into a **general** STT renderer
> with parity to the deck.gl renderer (`@poopdeck.gl/layers`): mercator + globe
> projections, viewport streaming, a toggleable basemap, and ports of the
> geographic layers so the non-AV showcase demos render in Three too.

This doc consolidates two parallel design passes: a 12-reader parity survey of
both renderers + the core format + the demo surface, and a build-vs-buy review of
the Three.js geospatial ecosystem.

---

## 0. The one fact that frames everything

Our renderer is a **single Three `WebGPURenderer`** (WebGPU backend, or its own
WebGL2 backend) because **TSL node materials only compile on the node renderer —
the classic `WebGLRenderer` cannot run them.** Those TSL materials (per-vertex /
per-feature *temporal* filtering — window / wake / cumulative / trail against one
`currentTime` uniform — over zero-copy STT columns) are the entire reason this
renderer exists.

Consequence for "buy": **every full framework and every basemap *interleave* path
in the 2025-2026 ecosystem is hard-wired to `WebGLRenderer`** (maplibre custom
layer, itowns, giro3d, three-globe data layers, threebox, react-three-map's
non-overlay mode). None can host a `WebGPURenderer` / TSL `NodeMaterial`. So we do
**not** hand our scene to a framework. We borrow small renderer-agnostic *math +
tile-loading* pieces under our own renderer, and put the basemap on a **separate
overlay canvas** (camera-synced) — not interleaved.

The good news from the parity survey: the renderer-agnostic machinery already
exists in `core`/`playback` (`STTArchive`, `SpatiotemporalTileset`,
`PlaybackGovernor`/`BufferSource`, summary/overview/additive tier selection); the
`Projection` interface is already the right seam; the time-filter node graph
(`tsl/time-filter.ts`) is **already at parity** with deck's `TimeFilterExtension`
across all four modes; and WebGPU/TSL *dissolves* deck's two worst couplings
(fp64 attribute-split and the WebGL2 16-attribute budget — no `NoPickingPathLayer`
hack needed). The hard parts are all viewport/projection-coupled: huge world
coords (f32 precision), real streaming, a metre→world sizing scale, and the loss
of a single global "up" on a globe.

---

## 1. Build-vs-buy verdict (per foundation piece)

| Piece | Decision | How |
|---|---|---|
| Mercator projection math | **BUILD** | `local-enu.ts` is 124 lines; web-mercator is the same shape (~30 lines, no dep). `proj4` only if arbitrary CRS reprojection is ever needed. |
| Globe projection (ECEF/WGS84) | **BUY-by-copy** | Lift `Ellipsoid` from NASA `3d-tiles-renderer` (Apache-2.0, renderer-agnostic, importable standalone) **or** copy a ~10-line lat/lon→ECEF sphere formula. Do **not** adopt a framework for this. |
| Basemap (raster + vector, flat & globe) | **BUY — maplibre as a separate *overlay* canvas** | maplibre-gl (BSD-3, already shipped in the showcase) on a canvas *under* a transparent Three WebGPU canvas, camera-synced per frame. Gives raster+vector basemap, mercator+globe, and viewport tile streaming/caching for free. Our renderer already sets `alpha:true` "to let a basemap show through" — pre-anticipated. Port the camera-sync math from react-three-map's `overlay` mode. |
| Camera + controls | **BUY-by-copy** | `GlobeControls` / `EnvironmentControls` from `3d-tiles-renderer` (Apache-2.0, Object3D-based, take *our* camera/renderer, don't own the loop). Ellipsoid-aware zoom + horizon near/far is real math worth borrowing. Mercator reuses our existing `MapControls`. |
| Tile streaming / caching | **BUILD** | Extend `tile-source.ts` (117 lines, STT-specific zero-copy columns) by **wrapping the existing core `SpatiotemporalTileset`** — don't re-derive selection. Framework streamers are welded to their WebGL renderer and aren't liftable. |
| Terrain / elevation | **DEFER** | `3d-tiles-renderer` `QuantizedMeshPlugin` later; not needed for parity. |

**The trap (the obvious-looking 80% win):** *interleaving* Three into maplibre's
GL context (how our deck renderer pairs with maplibre via `interleaved:true`,
threebox, react-three-map non-overlay) mechanically requires
`new THREE.WebGLRenderer({context: gl})` — WebGL and WebGPU are non-interoperable
browser contexts, so it forces us off WebGPU/TSL and deletes our reason to exist.
The overlay's only cost vs interleaving is losing per-pixel depth-weaving between
basemap 3D (extruded buildings/terrain) and our content — Three always composites
on top. Fine for clouds/points/lines over a mostly-2D basemap.

**One spike before the globe basemap wave:** mount `3d-tiles-renderer`'s
`XYZTilesPlugin` + one TSL material under our `WebGPURenderer` to confirm its
raster-on-globe plugins compile on WebGPU (open issue #1380). If not,
`three-slippy-map-globe` (plain textured meshes) + borrowed `Ellipsoid` is the
WebGPU-friendly fallback. For globe basemap we can also just start with a single
bundled equirectangular earth texture (the 4 globe demos want an "earth sphere",
not slippy tiles).

---

## 2. Locked decisions (recommended answers adopted)

1. **Globe = ECEF mesh** (project lon/lat/alt to real 3D sphere coords; standard
   Three MVP renders it; real depth/occlusion) — not deck-style in-shader vertex
   warping. Cost: breaks global Z-up → needs a globe camera rig (radial up) +
   sphere basemap.
2. **Streaming = wrap the core `SpatiotemporalTileset`**; keep the eager
   `SttTileSource` for AV/small scenes. Per-source choice (`stream?: boolean`,
   defaulted by archive byte budget).
3. **Precision = Relative-To-Center (RTC)** per resident tile-group: f64 origin
   lives in the CPU-side `Object3D.position`, vertices are f32 *relative* to it.
   No in-shader fp64 (TSL has no double helpers). Time is likewise rebased
   **per-tile-group** under streaming — the AV "rebased seconds stay exact"
   guarantee fails for multi-day/-year ms spans.
4. **Basemap = host-owned maplibre overlay** (not hand-built slippy tiles, not a
   Three object). The `three` package stays basemap-provider-agnostic: it exposes
   the view-state seam (`cameraToViewState`/`viewStateToCamera`) + a transparent
   canvas; an **optional** thin `basemap` helper (maplibre as optional peer dep)
   wires it for convenience. The showcase puts maplibre under the Three canvas and
   the toggle adds/removes that canvas. Provider = whatever the showcase deck path
   already uses (match `basemapUrl`).
5. **No 1:1 composite chassis.** Do NOT port deck's `SpatioTemporalLayer`
   CompositeLayer. Push its renderer-agnostic duties (tileset selection, summary/
   overview/additive tiers, governor `BufferSource`) into the streaming
   `SttTileSource`; keep the thin per-geometry `SttLayer` contract.
6. **Defer/skip GPU-aggregation parity.** `AnimatedHeatmapLayer` (multi-pass FBO
   aggregation, 1 demo) and *live* KDEEB bundling (5-pass ping-pong float compute)
   are deferred. Ship `StaticBundle`/`preBundled` bundled flowmaps (deterministic
   DataTexture). Heatmap stays on deck or becomes a final optional compute wave.
7. **Wide-line TSL material is the gating dependency** for the largest demo
   cluster (~9 trip/path/corridor/flowmap demos). Build it first in Wave 2.
8. **Shared geographic view state** `{longitude, latitude, zoom, pitch, bearing}`
   drives both renderers so the existing deck↔three showcase toggle shows the same
   view (esp. on globe).

---

## 3. Parity matrix

| deck layer | geometry | three status today | port | notes |
|---|---|---|---|---|
| `SpatioTemporalLayer` (chassis) | composite | none | M | Re-express as streaming source + thin `SttLayer`, **not** a 1:1 chassis. |
| `AnimatedPointLayer` | point | `PointCloudLayer` (window/wake/cumulative, splat) | S→M | Add pixel-radius sizing, continuous color ramp; RTC origins. Largest unlock with Trips. |
| `AnimatedTripsLayer` | line/trip | none | **L** | Keystone (~9 demos). Needs the new wide-line TSL material + trail mode + per-vertex `vertexTime` + gradient + synthesized vertex times. |
| `AnimatedPathLayer` | line | `StaticPathLayer` (hairline, no width/time) | M | Same wide-line material; window mode. |
| `AnimatedLineLayer` | od-pair | none | **S** | Simplest: 2-endpoint segment + window. |
| `AnimatedArcLayer` | od-pair | none | M | Great-circle/raised-arc TSL tessellation; `od-positions` ports verbatim. |
| `AnimatedIconLayer` | point | none (billboard node exists) | M | Atlas texture + `iconMapping` UV + per-instance angle/size; pixel sizing. |
| `AnimatedColumnLayer` | point→prism | none (box `InstancedMesh` precedent) | M | Disk-prism instanced + phong. |
| `AnimatedPolygonLayer` | polygon | `StaticPolygonLayer` (lon/lat earcut, no time/extrude) | L | Earcut in projected space; window time-filter; extrude/wireframe; multi-ring holes gotcha. |
| `AnimatedBoundingBoxLayer` | point/box | `BoundingBoxLayer` (full CPU interp + pick) | S/M | Generalize box frame from projection `localFrame` + metre scale; SDF labels heaviest. |
| `AnimatedTripHeadsLayer` | trip→point | none | S/M | CPU binary-search + lerp → instanced point (reuse box-tracks). |
| `FlowCorridorLayer` | line + value-matrix | none | M (+L line) | `vertexValueMatrix` → float DataTexture, two-bucket lerp in shader (kills CPU re-expand). |
| `FlowmapLayer` | od-pair + matrix | none | L | Tapered-arrow `InstancedMesh` + node billboards; viewport-size uniform. |
| `BundledFlowmapLayer` | bundled river | none | L | Port `StaticBundle`/`preBundled` first; live KDEEB later/never. `edge-bundler.ts` math reuses. |
| `H3SummaryLayer` | h3-cell | none | M | `h3-js` decode → boundary → project → mesh; CPU ramp; summary-tier streaming. |
| `QuadbinSummaryLayer` | quadbin-cell | none | M | `quadbin-cell.ts` BigInt decode ports verbatim. |
| `AnimatedHeatmapLayer` | point→density | none | **L** | Full GPU aggregation; 1 demo → **defer/skip**. |
| `TimeFilterExtension` | cross-cut | **`time-filter.ts` at parity** | done | f32 relativization is already the core design. |
| `CategoryColorExtension` | cross-cut | partial (CPU expand) | S | Add TSL palette DataTexture only if a demo needs >palette stability. |
| `SplatExtension` | cross-cut | present in point billboard path | S | One TSL line. |
| `SplatLayer`/`SplatPrimitiveLayer` | surfel | `SurfelLayer` (full TSL port) | S (ENU) / L (globe) | Deepest ENU coupling (build-time quaternions in ENU metres); leave ENU-only. |

---

## 4. Foundation architecture (the seams)

**Projection interface** (`projection/local-enu.ts`) grows two methods, with the
ENU impl trivial (keeps the shipped AV path byte-identical):
```ts
interface Projection {
  kind; anchor; project(lon,lat,alt); unproject(x,y,z);
  metersPerWorldUnit(lon, lat): number;        // sizing scale at a location
  localFrame(lon, lat): { east; north; up };   // per-feature E/N/U world basis
}
```
- ENU: `metersPerWorldUnit = 1`, `localFrame` = constant `(X,Y,Z)`.
- Mercator (`projection/mercator.ts`, NEW): Z-up plane (ground XY, alt +Z), so
  `frameBox`/`MapControls` mostly survive; `metersPerWorldUnit` is lat-scaled.
- Globe (`projection/globe.ts`, NEW): ECEF; `localFrame` = per-position tangent
  basis (east/north tangents + radial up); `metersPerWorldUnit ≈ R`.

**RTC** generalizes `projectPositionsToEnu` → `projectPositions(proj,…)` returning
f32-relative verts **+ a per-group f64 origin** consumed into the layer/sub-buffer
`Object3D.position`. AV near-anchor case → origin `[0,0,0]` (no behavior change).

**Streaming** (`scene/streaming-tile-source.ts`, NEW) wraps core
`SpatiotemporalTileset`: drive `update({bounds,zoom,time,timeWindow})` from the
camera (frustum unproject + `zoomFromCamera`), emit added/removed tile ids, route
summary/overview/additive tiers through the tileset, and back the governor with a
real `TilesetBufferSource` (replaces the faked `createCompleteBufferSource`).
`SttLayer` grows incremental residency (`setResidentTiles`/`addTile`/`removeTile`,
per-tile sub-buffers, dispose-on-evict) — no per-frame re-merge.

**Camera/view-state** (`scene/camera.ts`, `scene/globe-camera.ts` NEW,
`projection/view-state.ts` NEW): mercator relaxes near/far; globe gets a
lon/lat/zoom/pitch/bearing→ECEF-eye rig with radial up + planet-scale near/far.
`viewStateToCamera`/`cameraToViewState` keep the deck↔three toggle in sync.

**Basemap** = host-owned maplibre overlay (see Decision 4); `scene/ground.ts`
(metric grid) stays for AV.

---

## 5. Wave plan

- **W1 — Foundation:** ✅ **DONE** (2026-06-23, 90 three-pkg tests green). Shipped:
  `Projection` interface extended with `metersPerWorldUnit` + `localFrame` (trivial
  ENU impl → AV path byte-identical); `MercatorProjection` (EPSG:3857, Z-up plane,
  `cos(lat)` scale) + `GlobeProjection` (ECEF sphere, per-position tangent frame);
  RTC `projectPositions` (f32-relative verts + f64 origin) alongside the back-compat
  `projectPositionsToEnu`; `view-state.ts` `viewStateToCamera`/`cameraToViewState`
  (mercator + globe round-trip, maplibre screen-up convention so top-down isn't
  degenerate); `scene/globe-camera.ts` `frameGlobe`/`setGlobeClip`; `SttScene` now
  takes a pluggable `projection?`. New tests: mercator/globe/view-state/project-
  positions. Deferred to W2/W3 as planned: threading RTC through the buffer
  builders + per-tile-group *time* origin (only exercised under streaming), and the
  deck-exact zoom→distance pixel match (tune when the showcase toggle is wired).
- **W2 — Wide-line material + Point/Trip/Path/OD-Line parity** on mercator with the
  eager source. The wide-line TSL material is the keystone.
- **W3 — Streaming source + real governor BufferSource + flat maplibre basemap
  overlay** (incremental residency; per-tile-group time origin lands here).
- **W4 — Globe basemap + the 4 globe demos** (drifters, currents, satellites,
  migration); great-circle arcs.
- **W5 — Summary tiers (H3/Quadbin) + Icon/Column/TripHeads + Polygon
  time/extrude + shared GPU id-color picking.**
- **W6 — Flowmap family** (flowmap, corridor, `StaticBundle` bundled) + heatmap
  decision.

Wave dependencies: W1→{W2,W3}; W2→{W3,W5,W6}; W3→{W4,W5,W6}.

---

## 6. Build log (2026-06-23)

**W1 foundation** ✅ + **all geographic layers/infra built, verified & green** (202
three-pkg tests, typecheck clean except the pre-existing `RenderPump` r3f WIP error).

Built (each = thin GPU layer + a PURE unit-tested buffer builder, RTC, the shared
time-filter nodes; GPU materials verified by an adversarial pass, not unit tests):
- **Seams**: `tsl/wide-line-material.ts` (screen-px ribbon, window/trail), continuous
  ramp in `lib/color.ts`, `geometry/segment-quad.ts`, `lib/geo-line-buffers.ts`,
  `layers/wide-line-layer.ts`.
- **Geometry layers**: Point geo-parity (pixel-radius + ramp + RTC, additive — AV
  byte-identical), Trips (trail + per-vertex time), Path, OD-Line, Arc (parabolic/
  great-circle), Icon (atlas + heading), Column (self-lit 3D prisms), Polygon
  (projected earcut + window fade + extrude), TripHeads (CPU interp).
- **Summary**: Quadbin (pure BigInt decode). *H3 in progress (needs h3-js).*
- **Flow**: Flowmap (tapered arrows + nodes), FlowCorridor (vertexValueMatrix
  DataTexture two-bucket lerp).
- **Infra**: StreamingTileSource (wraps core `SpatiotemporalTileset`) +
  `TilesetBufferSource`; `BasemapOverlay` (provider-agnostic maplibre sync);
  `makeGlobeBasemap` (ECEF earth sphere); `lib/gpu-pick.ts` (id-colour picking).
- **Wiring**: all exported from `index.ts`; r3f components (`SttTripsLayer`,
  `SttPathLayer`, `SttOdLineLayer`, `SttArcLayer`, `SttIconLayer`, `SttColumnLayer`,
  `SttPolygonLayer`, `SttTripHeadsLayer`, `SttQuadbinLayer`, `SttFlowmapLayer`,
  `SttFlowCorridorLayer`, `SttGlobeBasemap`) + a shared drawing-buffer
  viewport-push in `useEngineLayer` for pixel-width layers.

Adversarial material verification (9 materials vs the deck originals) found 5 fully
clean + **4 real bugs, all fixed**: PointCloudLayer missing `setViewport` (pixel mode
ignored the r3f viewport-push); Arc degenerate tangent → NaN at the t=1 tip; Column
needed scene lights → made self-lit; Icon atlas `flipY` unenforced. Attribute
contracts + the WGSL `select`-not-in-`varying` rule verified across all.

**Remaining**: (a) finish H3; (b) **showcase wiring** — generalize the AV-shaped
`SttCanvas`/r3f (pluggable projection + view-state camera + maplibre basemap overlay
+ globe controls) and add a Three demo path mirroring `buildDemoLayers` + a deck↔three
toggle on the demo page (touches the user's active r3f render-loop WIP — coordinate);
(c) browser visual verification of the GPU materials (user's domain); (d) the
deck-exact zoom→distance pixel match; (e) per-tile-group time origin under streaming.
