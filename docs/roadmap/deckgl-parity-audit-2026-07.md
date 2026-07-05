# deck.gl ↔ @poopdeck.gl/layers Parity Audit & Implementation Backlog

_deck.gl 9.3.2 · audited 2026-07-03_

> Goal: make `@poopdeck.gl/layers` a **superset** of deck.gl's layer/prop/extension surface wherever the pre-baked **binary spatiotemporal tile** model allows, and fill the animation-diverged features with native poopdeck mechanisms (accessor-alias columns, `TimeFilterExtension`, CPU per-frame kernels).

---

## 0. Implementation status — ✅ IMPLEMENTED (2026-07-03)

All three tiers were implemented, adversarially reviewed, and are green (`@poopdeck.gl/layers` **678 tests / 45 files**; core/three/cesium/maplibre all typecheck + test green). Delivered via parallel workflows.

- **Tier 1 — prop pass-throughs:** all ~57 `missing-portable` props landed across the 8 gap-bearing layers, incl. the large `AnimatedPolygonLayer.stroked` outline sublayer. Review caught + fixed a **HIGH** ANGLE/Metal crash (data-driven `getLineWidth` under-sized the instanced draw) — and the same latent bug in the shipped sibling `AnimatedPathLayer`.
- **Tier 2 — new layers:** `AnimatedTextLayer` (`text`), `AnimatedMeshLayer` (`mesh`), `AnimatedPointCloudLayer` (`pointCloud`), `AnimatedHexagonLayer` (`hexbin`) — kinds registered in `capabilities.ts` + all four backend descriptors. `AnimatedMeshLayer` shares a new `lib/track-kernel.ts` with `AnimatedBoundingBoxLayer` (no CPU-logic duplication). Review caught + fixed **2 CRITICAL** bugs: SimpleMeshLayer ignoring per-instance orientation/scale bound as binary attributes (also fixed the same latent bug in the shipped `AnimatedBoundingBoxLayer`), and the hexbin aggregator not re-binning on `filterRange` change (frozen time animation).
- **Tier 3 — extensions:** flagship `DataFilterExtension` port ("filter by any baked column", wired into `AnimatedPointLayer` + `AnimatedPathLayer`), `CollisionFilterExtension` helper (constant passthrough wired; data-driven priority deferred), and `docs/api/extensions.md` + passthrough tests documenting Brushing/Mask/Clip/PathStyle work as-is. Skipped: FillStyle / Terrain / Fp64.

**⚠️ Needs in-browser verification** (behavior changes to shipped rendering — GPU paths untestable in jsdom): `AnimatedBoundingBoxLayer` boxes now actually rotate to heading + scale to dimensions (were silently identity); `AnimatedMeshLayer`/`AnimatedHexagonLayer`/`AnimatedTextLayer` first live drive-through.

**Deferred (noted, not blocking):** `DataFilterExtension` multi-column `filterSize` 2–4 / fp64 / integration beyond point+path; `S2SummaryLayer` + `AnimatedScreenGridLayer` (P3, gated); demo/showcase wiring + `docs/api` per-layer pages for the 4 new layers; `CollisionFilterExtension` data-driven priority attribute.

---

## 1. Executive summary

The wrapper catalog is **already very close to prop-parity** with the deck primitives it wraps. Every layer forwards the full shared-base `LayerProps` surface for free through `SpatioTemporalLayer.composeSubLayerProps → getSubLayerProps`, and the style/geometry accessors are exposed through the **accessor-alias convention** (constant _or_ baked-column-name; a JS function warns once and falls back). The residual gaps are almost entirely **secondary outline/stroke styling** on the fill-only summary and polygon layers.

**Headline counts**

| Metric | Count |
|---|---|
| Existing layers audited | 15 |
| Layers with **zero** missing-portable gaps | 6 (Point, Path, Line, Trips, Splat, Heatmap) |
| Layers with gaps | 8 |
| **Missing-portable prop gaps (Tier 1)** | **~57** distinct props (mostly trivial pass-throughs; one large item = polygon outline) |
| P1 prop gaps | 3 headline (`polygon.stroked`, `quadbin.stroked`, `tripHeads.billboard`) |
| **Recommended new layers (Tier 2)** | **4 to build** (Text P1, Mesh P1, PointCloud P2, Hexbin P2) + 2 deferred/gated (ScreenGrid P3, S2Summary P3) |
| deck layers deliberately skipped | 15 |
| **Recommended extension work (Tier 3)** | 1 flagship port (`DataFilterExtension` P1) + 1 adapt (`CollisionFilter` P2); 4 already-have (document+test); 3 skip |
| Base-prop forwarding fixes needed | **0** (all load-bearing base props already forwarded) |

**Posture.** Bulk parity is a large number of individually-trivial pass-through edits (Tier 1), dominated by the polygon/summary **outline family**. The two genuine *capability* gaps are (a) **no standalone text/label layer** and (b) **no recognizable 3D mesh layer** — both are P1 new layers that reuse machinery that already exists internally (`AnimatedBoundingBoxLayer.buildLabels` for text; the box track-pooling/interpolation/picking for mesh). The single most valuable *extension* is a general-purpose **`DataFilterExtension`** adaptation ("filter by any baked column") — the generalization of the existing time filter.

---

## 2. Tiered implementation plan

Ordered by **priority then effort**. Effort legend: trivial (one-line forward), small (prop + forward + styleKey/digest + accessor-alias), medium (new sublayer/consolidation path or aggregator verification), large (new sublayer subsystem).

### TIER 1 — Prop pass-through fills (bulk-parity win)

Every `missing-portable` prop, grouped by layer. Each is an isolated, low-risk edit: add to `defaultProps`, forward in `buildSublayer`/`composeSubLayerProps`, fold into the style/cache digest, and (for color/width accessors) route through the accessor-alias convention.

| Layer | Prop | Effort | Priority |
|---|---|---|---|
| **AnimatedPolygonLayer** | `stroked` (adds an outline PathLayer sublayer — subsumes the whole line-* family below) | large | **P1** |
| AnimatedTripHeadsLayer | `billboard` (→ `headBillboard`; camera-facing dots, matters in globe/pitched/space-time-cube) | trivial | **P1** |
| **QuadbinSummaryLayer** | `stroked` (currently forced-on black 1px border, no way to disable for clean fill) | trivial | **P1** |
| AnimatedArcLayer | `numSegments` (arc tessellation quality, pinned at 50) | trivial | P2 |
| AnimatedIconLayer | `getPixelOffset` (→ constant or size-2 column, matches getSize/getAngle) | small | P2 |
| AnimatedIconLayer | `alphaCutoff` (discard threshold for masked-icon edges) | trivial | P2 |
| AnimatedColumnLayer | `lineWidthScale` (outline width multiplier; only when `stroked:true`) | trivial | P2 |
| AnimatedColumnLayer | `lineWidthMinPixels` | trivial | P2 |
| AnimatedColumnLayer | `lineWidthMaxPixels` | trivial | P2 |
| AnimatedBoundingBoxLayer | `strokeColor` (→ `getLineColor`; distinct outline color vs inherited fill — the crisp-outline detection-box look) | small | P2 |
| AnimatedPolygonLayer | `getLineColor` (constant outline/wireframe color; **shippable standalone today** for the existing `wireframe:true` case) | small | P2 |
| AnimatedPolygonLayer | `getLineWidth` (gated on `stroked`) | small | P2 |
| AnimatedPolygonLayer | `lineWidthMinPixels` (keeps thin borders visible at low zoom) | trivial | P2 |
| AnimatedPolygonLayer | `lineWidthUnits` | trivial | P2 |
| AnimatedTripHeadsLayer | outline subsystem: `stroked`+`filled`+`getLineColor`(→`headStrokeColor`)+`getLineWidth`(→`headStrokeWidth`)+`lineWidthUnits/Scale/Min/MaxPixels` (contrast ring around moving dots) | medium | P2 |
| AnimatedTripHeadsLayer | `radiusScale` (global multiplier for emphasis animation) | trivial | P2 |
| AnimatedTripHeadsLayer | `antialiasing` (disable to reduce artifacts on dense overlapping dots) | trivial | P2 |
| H3SummaryLayer | `stroked` (hex-grid outline look) | trivial | P2 |
| H3SummaryLayer | `wireframe` (3D-hexbin prism edges, when extruded) | trivial | P2 |
| H3SummaryLayer | `lineColor` (→ `getLineColor`; sublayer stuck at default black) | small | P2 |
| H3SummaryLayer | `lineWidthMinPixels` (the lever that makes outlines visible at summary zooms) | trivial | P2 |
| QuadbinSummaryLayer | `lineColor` (→ `getLineColor` constant) | small | P2 |
| QuadbinSummaryLayer | `lineWidth` (→ `getLineWidth` constant) | small | P2 |
| QuadbinSummaryLayer | `lineWidthMinPixels` (1m borders invisible at summary zooms) | trivial | P2 |
| QuadbinSummaryLayer | `filled` (enable outline-only cells) | trivial | P2 |
| QuadbinSummaryLayer | `material` (extruded-cell lighting; GeoCellLayer already forwards it) | small | P2 |
| AnimatedPolygonLayer | `_full3d` (tesselate XYZ polygons on largest-area plane) | trivial | P3 |
| AnimatedIconLayer | `sizeBasis` (`'height'`\|`'width'`; non-square icons only) | trivial | P3 |
| AnimatedIconLayer | `textureParameters` (atlas sampler filtering/wrap/mipmaps) | trivial | P3 |
| AnimatedBoundingBoxLayer | `strokeWidthUnits` (→ `lineWidthUnits`; outline currently hardcoded 'pixels') | trivial | P3 |
| AnimatedBoundingBoxLayer | `strokeWidthMaxPixels` (→ `lineWidthMaxPixels`; no upper clamp today) | trivial | P3 |
| H3SummaryLayer | `lineWidth` (→ `getLineWidth` constant) | small | P3 |
| H3SummaryLayer | `filled` (outline-only hexgrid) | trivial | P3 |
| H3SummaryLayer | `lineWidthUnits` / `lineWidthScale` / `lineWidthMaxPixels` | trivial | P3 |
| H3SummaryLayer | `material` (extruded-hex lighting) | small | P3 |
| H3SummaryLayer | `highPrecision` (`boolean`\|`'auto'`; 'auto' already picks hi-fi) | trivial | P3 |
| QuadbinSummaryLayer | `wireframe` (extruded-cell edges) | trivial | P3 |
| QuadbinSummaryLayer | `lineWidthUnits` / `lineWidthScale` / `lineWidthMaxPixels` / `lineJointRounded` / `lineMiterLimit` / `lineDashJustified` (forward as a group once stroke styling exists) | small | P3 |

> **Note on the polygon/summary outline family.** `AnimatedPolygonLayer` wraps **only** `SolidPolygonLayer`, so there is _no_ outline PathLayer at all — landing `stroked` is a genuine new sublayer (large) that then makes ~8 line-* props trivial forwards. The two summary layers wrap `H3HexagonLayer`/`QuadkeyLayer` which _do_ have an internal outline path, so their line-* props are pure pass-throughs (trivial/small), just never surfaced. On all three, mind the documented **tile-seam overdraw** limitation — outlines double-draw along tile boundaries exactly like the fill.

### TIER 2 — New layers

**Build these (verdict port-adapted):**

| Proposed name | Kind slug | deck base | STT mapping (short) | Effort | Priority |
|---|---|---|---|---|---|
| **AnimatedTextLayer** | `text` | `TextLayer` | Point tiles; `getText` ← categorical string column decoded once into a reference-stable `{position,text,…}` row array (CPU-string CompositeLayer needs FontAtlasManager — same pattern as `AnimatedBoundingBoxLayer.buildLabels`); time via `TimeFilterExtension` or a CPU active-set; `getColor/getSize/getAngle` + all background/outline/font/anchor/pixelOffset props as style pass-throughs. | medium | **P1** |
| **AnimatedMeshLayer** | `mesh` | `SimpleMeshLayer` | Reuse the AV `objects/` point archive verbatim (one POINT per track per keyframe: `track_id`, `category`, `heading→getOrientation`, `length/width/height→getScale`, baked start/end times). The glTF/OBJ mesh is a **static per-layer prop** (like `iconAtlas`), not a tile column. ~90% is a refactor of `AnimatedBoundingBoxLayer` (track-pool + per-frame interpolation + GPU-id picking already done); new work is mesh-asset load + splitting samples by category into per-mesh sub-instances. | medium | **P1** |
| **AnimatedPointCloudLayer** | `pointCloud` | `PointCloudLayer` | 3D point tiles; `getPosition` ← size-3 binary positions (zero-copy); `getColor` ← constant / category / `[rgba]` vectorProps column (SplatLayer's u8 path); `getNormal` ← `[nx,ny,nz]` vector column or default; time via `TimeFilterExtension`. Mirrors the `AnimatedPointLayer` binary pattern verbatim. Fills the middle ground between flat billboards (Point) and covariance-requiring surfels (Splat). | small | P2 |
| **AnimatedHexagonLayer** | `hexbin` | `HexagonLayer` | **Runtime** hexbin over the raw point tier (the discrete/pickable/extruded analog of the smooth heatmap). Reuse `AnimatedHeatmapLayer.buildConsolidatedChannelData` verbatim → `{getPosition, getWeight, getFilterValue}`; time via `DataFilterExtension.filterRange`. No baked columns; deck bins at runtime. | medium | P2 |

**Build later / gated (verdict port-adapted, but P3):**

| Proposed name | Kind slug | deck base | Why deferred | Effort | Priority |
|---|---|---|---|---|---|
| AnimatedScreenGridLayer | `screenGrid` | `ScreenGridLayer` | Near-clone of the heatmap render path; adds **pickable discrete cells** (exact per-cell count) + blocky aesthetic the heatmap can't give. Aesthetic/pickability nicety over an already-covered density need. | small | P3 |
| S2SummaryLayer | `s2Summary` | `S2Layer` | Near-verbatim clone of `QuadbinSummaryLayer` (only cell decoder + sublayer class change). **Gated on a Rust `SummaryScheme::S2` builder that does not exist** (and the Quadbin builder itself is still stubbed). Do only when an S2-native dataset lands. | medium | P3 |

**Skip (redundant or model-incompatible) — one-line reasons:**

- `SolidPolygonLayer` — already the render engine of the `polygon` kind.
- `GeoJsonLayer` — its multiplex-by-geometry job is done at build time by the STT tiler + per-kind Animated layers; input is raw GeoJSON (bypasses the binary pipeline).
- `GridCellLayer` / `GridLayer` — square cells already served by `QuadbinSummaryLayer` (baked) and `AnimatedColumnLayer(diskResolution:4)`; no square-grid summary scheme is baked.
- `ContourLayer` — contours are baked at build time (marching-squares → LineString/polygon features) and render via existing Path/Polygon layers; deck's runtime grid-aggregate model is what STT replaces.
- `GreatCircleLayer` — `@deprecated` upstream; `AnimatedArcLayer({greatCircle:true})` already is this.
- `QuadkeyLayer` — already consumed internally as `QuadbinSummaryLayer`'s sublayer.
- `GeohashLayer` / `A5Layer` — no builder scheme, no data, no adoption; trivial Quadbin clones if ever needed. Add nothing H3/Quadbin don't cover.
- `H3ClusterLayer` — needs a per-feature variable-length H3-index-array column type STT doesn't have; bake the union region as a polygon instead.
- `BitmapLayer` — raster primitive; STT tiles carry no image/raster payload. Format-level change, not a layer port.
- `TileLayer` / `MVTLayer` — STT's `SpatioTemporalLayer` base **is** the (temporal) tiler; MVT is a competing wire format STT supersedes.
- `Tile3DLayer` / `TerrainLayer` / `WMSLayer` — external raster/mesh **backdrops** consumed from stock deck.gl at the app layer; no STT column feeds them, no time axis.
- `ScenegraphLayer` — heavier PBR/rigged **superset** of the SimpleMeshLayer port over the identical mapping. Defer as an opt-in **renderer variant of the `mesh` kind**, not a second slug.

### TIER 3 — Extensions + base-prop forwarding

**Base-prop forwarding: no fixes needed.** Every load-bearing base prop is already forwarded by `composeSubLayerProps → getSubLayerProps`. The only two dropped by deck's _own_ stock `getSubLayerProps` are `colorFormat` (na — colors are baked RGBA / constant-RGBA default, so it never applies) and `transitions` (diverged — animation is shader/time-driven and per-tile sublayers churn each selection, defeating deck's prop-transition machinery). Neither is an actionable gap.

**Extensions:**

| Extension | Verdict | Effort | Priority | Action |
|---|---|---|---|---|
| **DataFilterExtension** | port-adapted | medium | **P1** | **FLAGSHIP.** Register a `filterValue` attribute from a baked tile column via accessor-alias (exactly like `TimeFilterExtension`, which is a hand-built descendant); keep `filterRange`/`filterSoftRange`/`filterEnabled` as constant uniforms. Passing it raw via `extensions` does **not** work — deck would source `getFilterValue` by running a JS accessor over binary features. Unlocks "filter vessels by speed", "filter by any baked property". `onFilteredItemsChange`/`countItems` are na (no CPU rows). |
| CollisionFilterExtension | port-adapted | medium | P2 | Common case (`collisionEnabled`/`collisionGroup`/`collisionTestProps` constants) **works today** via passthrough — great for de-cluttering `AnimatedIconLayer`/text labels. Adapt = wire `getCollisionPriority` to a baked priority column via accessor-alias for data-driven importance ranking. |
| PathStyleExtension | already-have | small | P2 | Already a dep (`flow-stroke-layer.ts` uses `{offset:true}`). Constant `getDashArray`/`getOffset` work today via `extensions`. Only per-**feature** dash/offset diverges (would need accessor-alias to a baked column, low value). Work = expose + document + test. |
| BrushingExtension | already-have | small | P2 | Self-contained; reads the layer's own baked position attributes. Brushing an STT point/arc layer works **today** via passthrough. Only `brushingTarget:'custom'` (function accessor) diverges. Document + test. |
| MaskExtension | already-have | small | P2 | `operation` **is** forwarded, so a mask layer + `maskId` geofences an STT layer **today** (e.g. clip ship traffic to a harbor polygon). Document + test. |
| ClipExtension | already-have | small | P3 | Pure uniforms (`clipBounds`/`clipByInstance`), no accessors — works **today** via passthrough. Lower value than MaskExtension. Document. |
| FillStyleExtension | skip | small | P3 | Decorative pattern-fill; constant pattern already passes through. Per-feature needs a baked pattern-index column for little payoff. |
| _TerrainExtension | skip | medium | P3 | Experimental upstream; the vertical axis is already claimed by poopdeck's `timeHeightScale` space-time-cube lift — draping and time-as-height fight over z. |
| Fp64Extension | skip | small | P3 | Deprecated upstream; poopdeck already uses per-tile `timeOffset` relativization + deck's built-in fp64 position split. Adding it is counterproductive. |

---

## 3. Per-layer detail (canonical divergence ledger)

### AnimatedPointLayer — ScatterplotLayer · **0 gaps**
- **Divergences:** `data` (archive URL, no DataT); `getPosition` (baked binary positions, size-3, optional elevation z); `getFillColor`/`getRadius`/`getLineColor`/`getLineWidth` (accessor-alias: constant or column-name; function warns once); `strokeWidth` (deliberately retained as legacy constant-or-column despite deck deprecation); `transitions` (na — baked time + TimeFilterExtension). Adds beyond deck: `splat`, `rgbColorColumns`, `colorVectorColumn`, `colorMapping/Palette`, `radiusTransform`, `elevationProperty/Scale`, `wakeLength`, `fadeIn/OutDuration`, `cumulative`, `use3D`.

### AnimatedPathLayer — PathLayer · **0 gaps**
- **Divergences:** `getPath` (zero-copy positions attr, optional XYZ lift); `getColor`/`getWidth` (accessor-alias; default color `[0,150,255,255]` vs deck `[0,0,0,255]`, default width 3 vs 1); `_pathType` (forced `'open'`); `positionFormat` (forced per-tile XY/XYZ); `widthUnits` (default `'pixels'`, TS omits `'common'` but value forwards); `data`/`loadOptions`/`onDataLoad` (binary/archive/tile-lifecycle).

### AnimatedLineLayer — LineLayer · **0 gaps**
- **Divergences:** `getSourcePosition`/`getTargetPosition` (derived from each LineString's first/last vertex; intermediate vertices dropped); `getColor`/`getWidth` (accessor-alias); `positionFormat` (per-tile from dims); `data` (binary). LineLayer's entire own surface is 4 width props — all forwarded.

### AnimatedArcLayer — ArcLayer · **1 gap**
- **Gaps:** `numSegments` (trivial, P2) — arc tessellation quality pinned at 50; add own prop + forward alongside `greatCircle`.
- **Divergences:** `getSourcePosition`/`getTargetPosition` (first/last vertex, derived once per tile); `getSourceColor`/`getTargetColor` (accessor-alias; **on the categorical path a category column drives a SINGLE unified arc color — deck's independent per-endpoint interpolation is not reproduced**; constant colors still take the per-endpoint path); `getWidth` (constant or column); `getHeight`/`getTilt` (constant-only, scene-wide multipliers); `positionFormat` (forced XY/XYZ).

### AnimatedIconLayer — IconLayer · **4 gaps**
- **Gaps:** `getPixelOffset` (small, P2); `alphaCutoff` (trivial, P2); `sizeBasis` (trivial, P3); `textureParameters` (trivial, P3).
- **Divergences:** `getIcon` (constant `() => icon` — single atlas entry for all features; deck's auto-packing UnpackedIcon unsupported; per-category icons a noted future enhancement); `getPosition` (baked); `getColor`/`getSize`/`getAngle` (accessor-alias — `getAngle` is the headline heading/cog rotation path); `iconMapping` (type narrowed to `Record<string,IconMappingEntry>|null`, deck's URL-string form typed out though value forwards); `onIconError` (largely inert on the pre-packed path).

### AnimatedColumnLayer — ColumnLayer · **3 gaps**
- **Gaps:** `lineWidthScale` / `lineWidthMinPixels` / `lineWidthMaxPixels` (all trivial, P2) — outline-width scale/clamp trio; only take effect when `stroked:true` (off by default). `lineWidthUnits` and constant `lineWidth`/`lineColor` are already wired, so the fix is symmetric.
- **Divergences:** `getPosition` (baked, z = column base altitude); `getFillColor` (accessor-alias, categorical GPU); `getElevation` (accessor-alias, per-feature size-1 attribute, instanced-at-points); `getLineColor`/`getLineWidth` (constant-only accessor-alias); `getColor` (deprecated combined accessor — not exposed, split into fill/line); `data`/`loadOptions`. Defaults diverge: `radius` 100 vs deck 1000.

### AnimatedPolygonLayer — SolidPolygonLayer · **11 gaps (1 P1 large)**
- **Gaps:** `stroked` (**large, P1** — no outline PathLayer exists at all; wraps SolidPolygonLayer only; subsumes `getLineColor`/`getLineWidth`/`lineWidth*`/`lineJointRounded`/`lineMiterLimit`/`lineDashJustified`); `getLineColor` (small, P2 — **shippable standalone now** for the existing `wireframe:true` case, whose edge color is locked at black); `getLineWidth` (small, P2, gated on `stroked`); `lineWidthMinPixels` (trivial, P2); `lineWidthUnits` (trivial, P2); `_full3d` (trivial, P3).
- **Divergences:** `getPolygon` (zero-copy binary positions + startIndices, `_normalize:false`); `getFillColor` (accessor-alias, categorical GPU); `getElevation` (accessor-alias, per-vertex expanded); `_normalize` (forced false); `_windingOrder` (forced 'CCW'); `onError` (→ base `onTileError`); animation (baked start/end time columns + TimeFilterExtension).

### AnimatedBoundingBoxLayer — ColumnLayer + SimpleMeshLayer (custom) · **3 gaps**
- **Gaps:** `strokeColor` (→ `getLineColor`, small, P2 — 12-edge outline hardcoded to inherit fill×fade; a distinct bright-outline-over-dim-fill is the common detection-box look); `strokeWidthUnits` (→ `lineWidthUnits`, trivial, P3 — hardcoded 'pixels'); `strokeWidthMaxPixels` (→ `lineWidthMaxPixels`, trivial, P3 — no upper clamp).
- **Divergences:** Custom layer — filled box = SimpleMeshLayer over CubeGeometry, stroked = 12-edge LineLayer, plus optional labels/velocity sublayers. Most ColumnLayer disk props (`diskResolution`, `vertices`, `offset`, `coverage`, `extruded`, `flatShading`, `radiusUnits`, `elevationScale`) are **na** (cuboid mesh). `getPosition` (per-frame CPU-interpolated Float64 from pooled track keyframes); `getFillColor` (colorProperty + colorMapping → per-instance RGBA); size (baked `length/width/height` × sizeScale → getScale); `angle` (data-driven `headingProperty` → getOrientation slot 1); `getTranslation` (fixed ground-lift); `filled+stroked` both-false falls back to filled; **animation: no TimeFilterExtension — visibility implicit while the playhead lies within a track's keyframe span**, motion CPU-interpolated per tick.

### AnimatedTripsLayer — TripsLayer · **0 gaps**
- **Divergences:** `getPath` (baked Float64 positions attr, fp64 hi/lo split); `getTimestamps` (baked `vertexTimestamps` column → `instanceVertexTime`, or distance-interpolated fallback); `currentTime` (TimeController + base prop, applied every draw by TimeFilterExtension — no layer recreation); `getColor`/`getWidth` (accessor-alias, per-vertex CPU-expanded); `_pathType` (forced 'open'); `trailLength` (supported but **unit diverges — milliseconds** default 180000 vs deck's raw getTimestamps units); `positionFormat` (per-tile). `fadeTrail` newly wired through to the extension.

### AnimatedTripHeadsLayer — ScatterplotLayer (CPU kernel) · **~11 gaps (1 P1)**
- **Gaps:** `billboard` (trivial, **P1** — matters in globe/pitched/space-time-cube modes this layer supports); the **entire outline subsystem** `stroked`+`filled`+`getLineColor`(→`headStrokeColor`)+`getLineWidth`(→`headStrokeWidth`)+`lineWidth*` (medium, P2 — currently hardcoded `stroked:false`/`filled:true`); `radiusScale` (trivial, P2); `antialiasing` (trivial, P2).
- **Divergences:** `data`/`getPosition` (CPU binary-search + lerp along each active trip's baked path per frame → size-3 fp64 attribute); `getFillColor` (single constant `headColor` — **no categorical color, unlike sibling TripsLayer**); `getRadius` (constant `headRadius`/`headRadiusPixels`); `pickable` (forced false — active-only output buffer reorders instance indices; aligned picking via `instanceFeatureIndex` is a noted follow-up); animation (re-run `renderLayers` per frame via `headFrame` counter).

### SplatLayer — PointCloudLayer (bespoke surfel) · **0 gaps**
- **Divergences:** Bespoke oriented-anisotropic-Gaussian surfel primitive. `sizeUnits`/`pointSize` (surfel half-extents are intrinsically metres via baked `scaleColumn`; only global knob is own `sizeScale`); `material` (unlit by design — radial + temporal Gaussian + baked confidence alpha); `getPosition` (baked 2D + elevation column); `getNormal` (derived from baked orientation quaternion's 3rd rotation column); `getColor` (baked RGBA vector column or `fallbackColor`); `highlightedObjectIndex` (na — per-tile sublayers, no stable global index). Adds: `quaternionColumn`, `scaleColumn`, `colorColumn`, `temporalSigma(Dynamic)`, `cumulative`, `revealFade`, `gaussianFalloff`, `alphaCutoff`.

### AnimatedHeatmapLayer — HeatmapLayer · **0 gaps**
- **Divergences:** `getPosition` (consolidated Float64 size-3 buffer from all visible tiles); `getWeight` (accessor-alias column-name, alias of `weightProperty`); `data` (consolidated per-channel binary payload, globally normalized, no per-tile seams); `pickable` (forced false — density pixels have no identity; animation via `DataFilterExtension.filterRange` recomputed each frame). Adds: stacked categorical `channels` (≤4), archive-metadata auto-domain, `fadeIn/OutDuration`. Minor default divergences: `radiusPixels` 30 vs 50 (no max cap vs deck's 100); `colorRange` custom default.

### H3SummaryLayer — H3HexagonLayer · **11 gaps (all P2/P3 outline/refinement)**
- **Gaps:** `stroked` (trivial, P2); `wireframe` (trivial, P2); `lineColor`→`getLineColor` (small, P2); `lineWidthMinPixels` (trivial, P2 — the practical visibility lever); `lineWidth`→`getLineWidth` (small, P3); `filled` (trivial, P3); `lineWidthUnits/Scale/MaxPixels` (trivial, P3); `material` (small, P3); `highPrecision` (trivial, P3). **`lineJointRounded`/`lineMiterLimit`/`lineDashJustified` are `na`** — in the .d.ts but `H3HexagonLayer._getForwardProps` never forwards them (inert even upstream).
- **Divergences:** `getFillColor` (colorRange + colorDomain + weightProperty ramp — no color callback); `getElevation` (weight × elevationScale when extruded); `getHexagon` (baked UInt64 `id` column → `splitLongToH3Index`); `data`/`fetch`/`onDataLoad`. Defaults diverge intentionally: `extruded` false vs true, `coverage` 0.92 vs 1.

### QuadbinSummaryLayer — QuadkeyLayer → GeoCellLayer → PolygonLayer · **13 gaps (1 P1)**
- **Gaps:** `stroked` (trivial, **P1** — PolygonLayer defaults `stroked:true` so every cell has an un-disable-able black 1px outline; a clean heatmap-style fill needs it off); `lineColor`→`getLineColor` (small, P2); `lineWidth`→`getLineWidth` (small, P2); `lineWidthMinPixels` (trivial, P2 — 1m borders invisible at summary zoom); `filled` (trivial, P2); `material` (small, P2); `wireframe` (trivial, P3); `lineWidthUnits/Scale/MaxPixels`+`lineJointRounded`+`lineMiterLimit`+`lineDashJustified` (small, P3 group).
- **Divergences:** `getFillColor` (rampColor via colorRange/Domain/weightProperty); `getElevation` (weight × elevationScale when extruded); `getQuadkey` (baked UInt64 `id` → quadkey string via `quadkeyFromTile`); `data`; `transitions` (na).

---

## 4. Skipped / N/A appendix

### deck layers deliberately not ported
| Layer | Reason |
|---|---|
| SolidPolygonLayer | Already the `polygon` kind's render engine. |
| GeoJsonLayer | Multiplex-by-geometry done at build time by the tiler + per-kind Animated layers; raw-GeoJSON input bypasses the binary model. |
| GridCellLayer / GridLayer | Square cells covered by QuadbinSummary (baked) + AnimatedColumn(diskResolution:4); no baked square-grid scheme. |
| ContourLayer | Contours baked at build time (marching-squares → line/polygon features) → existing Path/Polygon layers; deck's runtime aggregation model is what STT replaces. |
| GreatCircleLayer | `@deprecated`; `AnimatedArcLayer({greatCircle:true})` already is it. |
| QuadkeyLayer | Already the internal sublayer of QuadbinSummaryLayer. |
| GeohashLayer / A5Layer | No builder scheme, no data, no adoption; trivial Quadbin clones if ever needed. |
| H3ClusterLayer | Needs a per-feature H3-index-array column STT lacks; bake union region as a polygon instead. |
| BitmapLayer | Raster primitive; STT tiles carry no image payload (format-level change, not a port). |
| TileLayer | STT's `SpatioTemporalLayer` base **is** the (temporal) tiler. |
| MVTLayer | Competing vector-tile wire format with no time model; STT tiles supersede it. |
| Tile3DLayer / TerrainLayer / WMSLayer | External raster/mesh backdrops from stock deck.gl; no STT column feeds them, no time axis. |
| ScenegraphLayer | Heavier PBR/rigged superset of the SimpleMeshLayer port over the identical mapping; defer as a renderer **variant** of the `mesh` kind. |

### Prop categories universally N/A under the pre-baked binary model
Across every layer these are consistently na/diverged and are **not** gaps:
- **Raw-data pipeline:** `data` (→ archive URL), `dataComparator`, `_dataDiff`, `dataTransform`, `dataFormat`, `loaders`, `fetch` (inert on sublayers — binary data never fetched), `numInstances`, `startIndices`, `onDataLoad` (→ `onTileLoad`/`onViewportLoad`/`onTilesetReady`), `onError` (→ `onTileError`).
- **Accessor functions:** all `get*` JS-function accessors — replaced by the **accessor-alias convention** (constant _or_ baked-column-name; a function warns once and falls back). This is the core intentional divergence, not a defect.
- **Geometry accessors:** `getPosition`/`getPath`/`getPolygon`/`getSource|TargetPosition` — bound zero-copy from baked binary buffers.
- **`transitions`:** deck's prop-transition system — defeated by zero-copy binary attributes + per-tile sublayer churn; animation comes from baked time columns + `TimeFilterExtension` instead.
- **`colorFormat`:** dropped by deck's _own_ stock `getSubLayerProps`; colors are baked RGBA / constant-RGBA default, so it never applies.
- **`loadOptions`:** repurposed at the base to `SttLoadOptions` (only `loadOptions.fetch` consumed for archive HTTP), not forwarded to sublayers.
