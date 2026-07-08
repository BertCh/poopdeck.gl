# Renderer architecture — consolidated decision record (2026-07)

> Merged from `renderer-abstraction-2026-06.md`, `three-renderer-parity.md`,
> `three-renderer-sota-2026-07.md`, `deckgl-parity-audit-2026-07.md`, and the
> reference-pattern residue of `fe-hotpath-audit-2026-06.md`. This is the
> internal decision record: locked decisions, negative results, honest gaps,
> the counted-out register with revival triggers, and the open-work tail.
>
> **Normative / user-facing content lives elsewhere — never restated here:**
> kernel API → [`docs/api/render-kernel.md`](../api/render-kernel.md);
> `BackendDescriptor` / `SttRenderNode` / `Degradation` →
> [`docs/api/backend-descriptor.md`](../api/backend-descriptor.md);
> backend guides → [`docs/api/stt-three.md`](../api/stt-three.md) /
> [`docs/api/stt-cesium.md`](../api/stt-cesium.md);
> extensions → [`docs/api/extensions.md`](../api/extensions.md);
> the live machine-generated capability matrix →
> [`docs/spec/backend-capabilities.md`](../spec/backend-capabilities.md);
> the frozen op-set contract → [`docs/spec/render-spec.json`](../spec/render-spec.json).

## Status (2026-07-07)

- **Render kernel: Tier 1 + most of Tier 2 SHIPPED** (largely uncommitted on
  `main`; ~1254 tests green at the 2026-07-01 checkpoint). Kernels live as
  `@poopdeck.gl/core` sub-paths (`time-filter`, `shader-codegen`, `style`,
  `geometry`, `geo`, `picking`, `tileset-adapter`, `capabilities`, `trips`).
  The §5.1 op-set contract is a declared artifact —
  `docs/spec/render-spec.json` + `packages/core/test/render-spec-contract.test.ts`
  walks the `ALPHA_EXPR` ASTs; widening the op-set/vars/modes without a spec
  edit fails CI.
- **All four `BackendDescriptor`s authored** (deck / three / maplibre / cesium),
  each with a structural conformance gate; `backend-capabilities.md` is
  generated from them and drift-guarded.
- **`@poopdeck.gl/cesium`** scaffolded + MOVEMENT catalog (path/line/arc/trips/
  tripHeads) built 2026-07-02; `/cesium/:datasetId` showcase route exists.
- **three SoTA (2026-07):** Phase 0 streaming + GPU picking (readback bug
  fixed) DONE; Phase 1 takram atmosphere (opt-in, WebGPU-only) DONE; Phase 5
  projection-aware `<SttCanvas>` DONE. Phase 3 3D-tiles modules BUILT but
  integration OPEN; Phase 4 `SttThreeGeoViewer` BUILT but showcase wiring +
  maplibre camera-sync basemap OPEN. All uncommitted; live-render
  browser-verify OPEN (user domain). The earlier three-parity foundation IS
  committed (`5d0a9c6` AV renderer, `17789f7` geo layers).
- **deck.gl parity: Tiers 1–3 DONE 2026-07-03** (~57 props, 4 new animated
  layers, DataFilter/Collision extensions; `@poopdeck.gl/layers` 678 tests /
  45 files green; per-layer `docs/api` pages exist). In-browser verify OPEN.
  `S2SummaryLayer` + `AnimatedScreenGridLayer` remain gated on a Rust
  `SummaryScheme::S2` builder that does not exist.
- **The one live architecture decision is Decision 6 (GPU-conformance CI),
  currently BLOCKED** — GitHub Actions is dead. It gates the entire Phase-1
  shader rewire to `emitGLSL300`/`emitGLSL100`/`emitTSL`. See §5.
- Open work is enumerated in §5; everything else in this document is settled.

---

## 1. Thesis: three rendering models over one substrate

STT is **three fully-independent renderer backends over one shared substrate** —
and that independence is deliberate, not accidental. The shared seams that work
are the **decoded-tile contract** (`@poopdeck.gl/core`: `STTArchive` /
`SpatiotemporalTileset` / `BinaryFeatures` / `Tile` + the frozen wire format)
and the **framework-neutral playback clock** (`@poopdeck.gl/playback`:
`TimeController` / `PlaybackGovernor` / `BufferSource` — all backends consume
it identically, the working proof a shared seam is viable). Everything above
that seam forks on **four mutually-exclusive structural axes** baked into GPU
buffers:

1. **Rendering model.** deck = `CompositeLayer` emitting one core sublayer per
   `(tile, layer)` with `binary.positions` bound zero-copy; three = retained
   scene merging all tiles into one `InstancedMesh` with CPU-projected f32 RTC
   buffers + one TSL material; maplibre = `CustomLayerInterface` with a
   per-tile WebGL VBO cache and hand-written GLSL.
2. **Time base.** deck & maplibre keep per-tile `timeOffset` and relativize per
   draw; three rebases every feature to one scene-wide `timeOrigin` —
   f32-exact only for seconds-scale spans.
3. **Shading target.** TSL node materials compile only on Three's
   `WebGPURenderer`; deck + maplibre are WebGL2/GLSL. This is *why* three owns
   its own scene/camera and overlays rather than interleaves the basemap.
4. **Archive/camera ownership.** maplibre gives each layer its own
   archive+tileset; deck shares one tileset per composite; three's `SttScene`
   owns projection+root but explicitly not the camera.

The consistency problem was never that the backends are separate — it was that
the same *CPU decisions* and *scalar shader math* were hand-copied 3–4× and
kept "in lockstep" by comments + per-package parity tests, which **drifted in
shipped pixels** (`wakeTailScale` 0.15 vs 0.1; fade default 10%-soft vs
hard-0; divergent `colorMappingDefault`). The adopted fix — the **STT Render
Kernel** — keeps the three rendering models exactly as they are and unifies
only the CPU decisions, the codegen'd scalar alpha, and the vocabulary, with
**CI as the enforcer** instead of "// keep in lockstep" comments.

### 1.1 Decision 5 — no 1:1 composite chassis (and the Draw-IR corollary)

Do NOT port deck's `SpatioTemporalLayer` CompositeLayer to other backends.
Its renderer-agnostic duties (tileset selection, summary/overview/additive
tiers, governor `BufferSource`) go into the streaming source; each backend
keeps its thin idiomatic layer contract. Of the four candidate architectures
scored by three judges, **P2 (backend-neutral Draw-IR + mini-reconciler) had
the highest consistency ceiling AND the lowest migration cost/risk scores,
and was still disqualified** — a declarative chassis is still a chassis (it
reverses Decision 5) and double-diffs deck's own reconciler. Winner = P4
(spec-in-core + idiomatic adapters) with grafts: P2's Expr-AST codegen of the
scalar alpha, P3's `assertDescriptorConsistent` over-claim CI gate, P1's
`makeTilesetCallbacks` collapse + typed `Degradation`.

### 1.2 What cannot be unified (structural, not laziness)

- **The three rendering models.** A neutral Geometry-IR would force deck to
  discard its zero-copy tesselator path — the reason the deck backend exists.
- **Shader/material source** beyond the codegen'd scalar alpha snippet —
  vertex geometry (billboard/arc-strip/column-prism/surfel-disk/ECEF) stays
  hand-written per language.
- **Buffer merge granularity + time base**; camera ownership + render loop;
  vertex-level projection execution (deck projects on GPU against a host
  viewport and can never take a CPU `Projection`); deck's GPU palette-texture
  fast path; `colorMappingDefault` **as a per-layer value** (deck point
  transparent, deck path grey `[120,120,120,255]`, three box its own —
  unifying to one value regresses deck's own path layer); pick mechanism
  (id-buffer vs ray); basemap integration mode; per-layer-archive vs shared
  tileset; maplibre's native paint/layout expression idiom; full catalog
  parity (maplibre stays a declared 5-of-19 subset with typed fallbacks).

---

## 2. Locked decisions & negative results

### 2.1 WebGPU/TSL interleave trap → overlay basemap

TSL node materials compile **only** on Three's node renderer — the classic
`WebGLRenderer` cannot run them, and every basemap *interleave* path in the
2025–2026 ecosystem (maplibre custom layer, itowns, giro3d, three-globe,
threebox, react-three-map non-overlay) mechanically requires
`new THREE.WebGLRenderer({context: gl})`. WebGL and WebGPU are
non-interoperable browser contexts, so interleaving forces us off WebGPU/TSL
and deletes the renderer's reason to exist. **Locked: basemap = host-owned
maplibre on a separate camera-synced canvas under a transparent Three canvas.**
The only cost vs interleaving is losing per-pixel depth-weaving with basemap
3D (extruded buildings/terrain) — Three always composites on top; fine for
clouds/points/lines over a mostly-2D basemap. The `three` package stays
basemap-provider-agnostic: it exposes the view-state seam
(`cameraToViewState`/`viewStateToCamera`) + a transparent canvas.

### 2.2 Globe = ECEF mesh, not shader warp

Project lon/lat/alt to real 3D sphere coordinates and let the standard Three
MVP render it (real depth/occlusion) — not deck-style in-shader vertex
warping. Cost: breaks the global Z-up → needs a globe camera rig (radial up:
`frameGlobe`/`setGlobeClip`) + a sphere basemap (`makeGlobeBasemap`, single
ECEF earth-texture sphere — the slippy-raster-on-globe spike became obsolete
once this covered all 4 globe demos).

### 2.3 `GlobeProjection` sphere ≠ WGS84 (~20 km)

`globe.ts:20`: *"Sphere (not ellipsoid) is intentional for v1."* Feeding
sphere-ECEF into a WGS84 frame (Cesium, 3D-tiles) mis-registers geometry —
~0.19° latitude ≈ **~20 km at mid-latitudes**, plus radial height error (the
same class as the shipped Google-3D-Tiles float-up bug). Fixed 2026-06-30:
`GlobeProjection` gained `datum: 'sphere' | 'wgs84'` (sphere byte-identical;
WGS84 via Bowring) and the descriptor records the datum. **3D-tiles overlay
co-registration requires the globe scene on `datum:'wgs84'`** — a one-time
console warning fires on the sphere datum. Radius is parameterizable
(`metersPerWorldUnit`) because globe.gl-style worlds are ~100 units, not
`EARTH_RADIUS` metres.

### 2.4 Precision = RTC; no in-shader fp64

Relative-To-Center per resident tile-group: the f64 origin lives in the
CPU-side `Object3D.position`, vertices are f32 *relative* to it. TSL has no
double helpers, so there is no in-shader fp64 path. Time is likewise rebased —
the f32 guard `MAX_RELATIVE_TIME_MS = 16_777_216` (+ `assertRelTimeInRange`)
was hoisted from deck (previously the only backend with it) into
`core/time-filter`. The AV "rebased seconds stay exact" guarantee fails for
multi-day/-year ms spans under a single scene-wide `timeOrigin` — hence the
per-tile-group time origin item in §5 (only bites under real streaming).

### 2.5 Merged-buffer pick identity → `InstanceProvenance`

three's merge of all tiles into one `InstancedMesh` destroys the
`{tileId, featureIndex}` identity that `SttPickResult.index` needs; at audit
time `GpuPicker` was exported but never instantiated (0 call sites) and the
only wired picker was CPU ray-OBB (boxes only). **The shared merge contract
now includes a per-instance provenance buffer** (`InstanceProvenance`,
`core/picking`; `buildPointBuffers` emits it). Until a merged backend emits
provenance, `index` is optional and it returns `worldPoint`-only picks.

### 2.6 Codegen op-set = linear alpha only (surfel excluded)

The adversarial critic's highest-impact confirmed hole: `surfel-material.ts`
computes `exp(dt·dt·-0.5)` (:149), `exp(-falloff·r²)` (:181) and `sqrt` (:89)
— and `exp/pow/sqrt/smoothstep` are **not** in the codegen op-set.
**Decision:** `ALPHA_EXPR` covers **linear alpha only**
(window/wake/cumulative/trail); the surfel/splat Gaussian temporal weight and
`wakeSizeScale` **vertex-stage** math are explicitly excluded from codegen and
stay per-backend, pinned to the CPU oracle by parity tests. This is stated in
`docs/spec/render-spec.json`, not discovered later. The surfel hero material
(line-for-line TSL port of deck's `splat-primitive-layer.ts`: smallest-three
quaternion unpack, hexagon disk envelope ~13% fewer fragments than a quad,
`alphaTest` no-halo depth discipline, off-time collapse to a zero-area
triangle) **stays hand-written**, ENU-only.

### 2.7 Fade-default + `wakeTailScale` policy

DECIDED & IN CODE 2026-07-01: **hard-0 fade default +
`DEFAULT_WAKE_TAIL_SCALE = 0.15`**, single-sourced in `core/time-filter`.
three's three 0.1 sites moved to 0.15; maplibre's fade default flipped
soft→hard (soft only on explicit `softTimeWindow: true`). This changed shipped
maplibre pixels (loses the default soft edge) + the three wake tail — part of
the browser-verify backlog.

### 2.8 Cesium green-field proof: the extension surface is thin

`@poopdeck.gl/cesium` was built ENTIRELY from the kernel — `core/geo`
`GlobeProjection({datum:'wgs84'})`, `core/style` color, `core/time-filter`
alpha oracle, `core/picking` result shape, `makeTilesetCallbacks` streaming —
plus a pure `ViewState`⇄Cesium camera bridge (first `roll` consumer).
**A new backend = a descriptor + a camera bridge + one layer, ZERO change to
shared code.** Demand then arrived 2026-07-02 and the MOVEMENT catalog was
built (path/line/arc/trips/tripHeads); the trip CPU kernel was lifted out of
three into `core/trips` (third consumer triggered the move — the Tier-1
pattern). Documented deviations, not silent ones: one colour per feature (OD
gradients collapse to source colour; trips tail fade is arc-length, not
vertex-time), constant width/size per layer. Aggregation kinds stay
demand-driven with typed fallbacks.

### 2.9 Five-tier enforcement ladder + its honest ceiling

1. **Deletion** for pure CPU logic (the `DEFAULT_*_PALETTE` precedent).
2. **Codegen** for scalar GPU alpha (one `ALPHA_EXPR`; `evalExpr` oracle;
   emitters are machine translations; op-set frozen small).
3. **Vocabulary + tsc** — `LayerKind`/`Capability`/`TimeFilterMode` are frozen
   `as const` unions; renaming a token is a compile break everywhere. (NO
   codegen pipeline for this — the critic flagged that as over-machined.)
4. **Conformance vectors** — `TIME_FILTER_VECTORS` through each backend's real
   compiled shader in a headless 1×1 readback, equal within 1/255.
5. **Over-claim + doc gates** — `assertDescriptorConsistent` fails CI on a
   capability/kind/mode claim with no passing evidence;
   `backend-capabilities.md` regenerated + drift-guarded.

**Honest ceiling (no proposal escapes it):** tiers 1–4 prove *scalar* math and
*generated-GLSL numeric* parity, but **cannot prove compiled-shader pixels**
(billboard sizing, depth, blend, the WGSL `select()`-in-`varying()` crash
class — which already shipped black screens). **Browser visual verification
stays a mandatory manual gate**, consistent with the project's visual-verify
preference.

### 2.10 Build-vs-buy verdict for three (the SoTA plug-ins)

The renderer is WebGPU/TSL + `moduleResolution: NodeNext`; that decides what
can plug in:

| Piece | Verdict |
|---|---|
| `@takram/three-atmosphere` | **plugged in** — native `/webgpu` TSL path; opt-in, default OFF, WebGPU-only, wrapped so a runtime failure degrades to a plain render (can never crash a scene); sun tracks the playhead via `getSunDirectionECEF`; takram's `Geodetic.toECEF` axes are identical to STT's `GlobeProjection` (no axis swap) |
| NASA-AMMOS `3d-tiles-renderer` | **plugged in** — renderer-agnostic meshes + `GlobeControls`; sources = url / Google Photorealistic (needs `dracoDecoderPath`) / Cesium ion (assetId 1 = World Terrain, 2 = Bing, 96188 = OSM buildings); reuses the atmosphere module's `computeWorldToEcef` as single source of truth |
| `geo-three`, `three-geo` | reference only — GLSL `ShaderMaterial` won't compile on `WebGPURenderer` |
| Giro3D / iTowns | reference only — own renderer + loop, can't co-host |
| Spark (Gaussian splatting) | deferred — WebGPU path exists, no demand yet |

Earlier foundational verdicts (all held): mercator projection = BUILD (~30
lines); globe ellipsoid math = BUY-by-copy; basemap = BUY (maplibre overlay,
§2.1); camera/controls = BUY-by-copy (`GlobeControls`/`EnvironmentControls`
take *our* camera and don't own the loop); tile streaming = BUILD by wrapping
core `SpatiotemporalTileset` (framework streamers are welded to their WebGL
renderers); terrain = DEFER.

### 2.11 Adversarial material verification — 4 real bugs

The three geographic-layer wave verified 9 GPU materials against the deck
originals adversarially (not unit tests). 5 fully clean, **4 real bugs, all
fixed**: `PointCloudLayer` missing `setViewport` (pixel-radius mode ignored
the r3f viewport-push); Arc degenerate tangent → NaN at the t=1 tip; Column
needed scene lights → made self-lit; Icon atlas `flipY` unenforced. Attribute
contracts + the WGSL `select`-not-in-`varying` rule verified across all. This
is the template for any future material port: a pure unit-tested buffer
builder + an adversarial GPU-material pass + user browser-verify.

### 2.12 GpuPicker readback bug (negative result worth remembering)

When GPU picking was finally wired (2026-07), it exposed a latent bug in the
never-instantiated `GpuPicker`: it passed its output buffer as the
`textureIndex` argument to the unified renderer's
`readRenderTargetPixelsAsync` (which *returns* the pixels) — so **every GPU
pick decoded index 0**. Also fixed: a background-sentinel bug (black clear ==
feature 0) and a concurrent-render race. `pickMechanism` is now `'gpu-id'`,
and `SttPickInfo` became a discriminated union
`SttBoxPickInfo | SttPointPickInfo` (consumers narrow on `kind`). Moral:
"exported but 0 call sites" code is unverified code.

---

## 3. deck.gl parity (audited vs deck.gl 9.3.2, 2026-07-03)

### 3.1 Posture

Goal: make `@poopdeck.gl/layers` a **superset** of deck.gl's
layer/prop/extension surface wherever the pre-baked binary spatiotemporal tile
model allows. The audit found the catalog already close: 15 layers audited, 6
with zero missing-portable gaps (Point, Path, Line, Trips, Splat, Heatmap),
~57 missing-portable props across the other 8 (dominated by the
polygon/summary outline family; `AnimatedPolygonLayer.stroked` was the one
genuinely large item — no outline PathLayer existed at all), 4 new layers to
build (Text, Mesh, PointCloud, Hexbin), 0 base-prop forwarding fixes needed.
All three tiers were implemented 2026-07-03. **The user has since mandated a
FULL superset of deck.gl 9.3 layer props — this audit is the record of what
was measured and shipped, not the scope ceiling.** Per-layer prop semantics
live in the `docs/api/animated-*-layer.md` pages; the canonical per-layer
divergence ledger from the audit is subsumed there.

Known intentional divergences worth keeping visible:

- **Arc categorical path:** a category column drives a SINGLE unified arc
  color — deck's independent per-endpoint interpolation is not reproduced
  (constant colors still take the per-endpoint path).
- **Trips `trailLength` unit diverges — milliseconds** (default 180000) vs
  deck's raw `getTimestamps` units.
- Retained-despite-deprecation: `AnimatedPointLayer.strokeWidth` stays as a
  legacy constant-or-column prop.
- Tile-seam overdraw: polygon/summary outlines double-draw along tile
  boundaries exactly like the fill (documented limitation).

### 3.2 The accessor-alias convention (the core intentional divergence)

Every deck `get*` JS-function accessor is replaced by the **accessor-alias
convention: a constant _or_ a baked-column-name; a JS function warns once and
falls back.** This is a design decision, not a defect — binary features never
materialize CPU rows for an accessor to run over.

### 3.3 Universally N/A under the pre-baked binary model

Not gaps, by construction:

- **Raw-data pipeline:** `data` (→ archive URL), `dataComparator`, `_dataDiff`,
  `dataTransform`, `dataFormat`, `loaders`, `fetch`, `numInstances`,
  `startIndices`, `onDataLoad` (→ `onTileLoad`/`onViewportLoad`/
  `onTilesetReady`), `onError` (→ `onTileError`).
- **`transitions`:** defeated by zero-copy binary attributes + per-tile
  sublayer churn; animation comes from baked time columns +
  `TimeFilterExtension`.
- **`colorFormat`:** dropped by deck's *own* stock `getSubLayerProps`; colors
  are baked RGBA / constant-RGBA default.
- **`loadOptions`:** repurposed at the base as `SttLoadOptions` (only
  `loadOptions.fetch` consumed for archive HTTP), not forwarded to sublayers.

### 3.4 Skip-list (one-line reasons + revival triggers)

| deck layer | Reason / trigger |
|---|---|
| SolidPolygonLayer | Already the `polygon` kind's render engine. |
| GeoJsonLayer | Multiplex-by-geometry is done at build time by the tiler; raw-GeoJSON input bypasses the binary model. |
| GridCellLayer / GridLayer | Square cells covered by QuadbinSummary (baked) + `AnimatedColumnLayer(diskResolution:4)`; no baked square-grid scheme. |
| ContourLayer | Contours baked at build time (marching-squares → line/polygon) → existing Path/Polygon layers; deck's runtime aggregation is what STT replaces. |
| GreatCircleLayer | `@deprecated` upstream; `AnimatedArcLayer({greatCircle:true})` already is it. |
| QuadkeyLayer | Already `QuadbinSummaryLayer`'s internal sublayer. |
| GeohashLayer / A5Layer | No builder scheme, no data, no adoption; trivial Quadbin clones **if a dataset ever demands one**. |
| H3ClusterLayer | Needs a per-feature H3-index-array column STT lacks; bake the union region as a polygon instead. |
| BitmapLayer | STT tiles carry no raster payload — a format-level change, not a layer port. |
| TileLayer / MVTLayer | `SpatioTemporalLayer` **is** the (temporal) tiler; MVT is a competing wire format STT supersedes. |
| Tile3DLayer / TerrainLayer / WMSLayer | External backdrops consumed from stock deck.gl at the app layer; no STT column, no time axis. |
| ScenegraphLayer | Heavier PBR/rigged superset of the SimpleMeshLayer mapping; **revive as a renderer variant of the `mesh` kind**, not a second slug. |
| S2SummaryLayer (deferred, not skipped) | Near-verbatim `QuadbinSummaryLayer` clone, **gated on a Rust `SummaryScheme::S2` builder that does not exist** (the Quadbin builder itself is still stubbed); do when an S2-native dataset lands. |
| AnimatedScreenGridLayer (deferred) | Near-clone of the heatmap render path; adds pickable discrete cells + a blocky aesthetic — a nicety over an already-covered density need. |

### 3.5 Latent bugs the parity work found in *shipped* layers

The implementation review caught bugs beyond its own scope — the strongest
argument for the superset exercise:

- **HIGH — ANGLE/Metal crash:** data-driven `getLineWidth` under-sized the
  instanced draw; the same latent bug existed in the shipped
  `AnimatedPathLayer` and was fixed there too.
- **CRITICAL — SimpleMeshLayer ignored per-instance orientation/scale** bound
  as binary attributes; the same latent bug in the shipped
  `AnimatedBoundingBoxLayer` meant boxes silently rendered identity (never
  rotated to heading or scaled to dimensions). Both fixed — this is a shipped
  *pixel-behavior change* awaiting browser verify.
- **CRITICAL — hexbin aggregator didn't re-bin on `filterRange` change** →
  frozen time animation. Fixed.

### Tier 3 — extensions

The definitive extension posture (referenced by
[`docs/api/extensions.md`](../api/extensions.md)):

- **`DataFilterExtension` — FLAGSHIP port-adapt (done).** "Filter by any baked
  column": register a `filterValue` attribute from a tile column via the
  accessor-alias convention, exactly like `TimeFilterExtension` (which is a
  hand-built descendant of it); `filterRange`/`filterSoftRange`/
  `filterEnabled` stay constant uniforms. Passing it raw via `extensions` does
  **not** work — deck would source `getFilterValue` by running a JS accessor
  over binary features. `onFilteredItemsChange`/`countItems` are n/a (no CPU
  rows). Wired into `AnimatedPointLayer` + `AnimatedPathLayer`; multi-column
  `filterSize` 2–4 / fp64 / wider integration deferred.
- **`CollisionFilterExtension` — port-adapt (helper done).** The common case
  (`collisionEnabled`/`collisionGroup`/`collisionTestProps` constants) works
  via passthrough; data-driven `getCollisionPriority` from a baked priority
  column is the deferred adapt.
- **Already-have via passthrough (documented + tested):** `PathStyleExtension`
  (already a dep — `flow-stroke-layer.ts` uses `{offset:true}`),
  `BrushingExtension` (reads the layer's own baked position attributes; only
  `brushingTarget:'custom'` diverges), `MaskExtension` (`operation` is
  forwarded, so mask + `maskId` geofences an STT layer today),
  `ClipExtension` (pure uniforms).
- **Skipped:** `FillStyleExtension` (decorative; per-feature needs a baked
  pattern-index column for little payoff); `_TerrainExtension` (experimental
  upstream, and the vertical axis is already claimed by `timeHeightScale`'s
  space-time-cube lift — draping and time-as-height fight over z);
  `Fp64Extension` (deprecated upstream; per-tile `timeOffset` relativization +
  deck's built-in fp64 position split already cover it — adding it is
  counterproductive).

---

## 4. Reusable gotchas & reference patterns

- **NodeNext extensionless-`.d.ts` shim.** `type: module` deps that ship
  extensionless `.d.ts` re-exports don't resolve under
  `moduleResolution: NodeNext` ("has no exported member") even though the
  runtime JS import is fine. `@takram/three-atmosphere` hit this;
  `3d-tiles-renderer` did not (explicit `.js` extensions). Fix: a local
  ambient `declare module` shim authored as a tracked **`.ts`** file — NOT
  `.d.ts`, because `.gitignore` excludes `src/**/*.d.ts` and `skipLibCheck`
  would hide errors inside a `.d.ts`. Pattern:
  `packages/three/src/types/takram-atmosphere.ts`.
- **Framework-free guard = a vitest test, not eslint.** The repo has NO eslint
  (no config, not even a dependency — the `lint` scripts are inert), so the
  "core stays framework-free" rule is
  `core/test/kernel-framework-free.test.ts`, which scans `core/src` for
  renderer imports — matching the repo's real enforcement idiom
  (`manifest-schema.test.ts` / `palette-parity.test.ts`).
- **Hot-path reference patterns** (survivors of the closed 2026-06 frontend
  hot-path audit — the models new layers should copy):
  - **SplatLayer prepared-data caching** — caches by `tileKey + styleKey` and
    preserves object identity so deck.gl's `dataComparator: (a,b) => a===b`
    skips GPU re-uploads.
  - **AnimatedPointLayer zero-copy elevation fallback** — returns
    `binary.positions` directly when there is no elevation override.
  - **HeatmapLayer wall-clock flush gating** — `FILTER_UPDATE_HZ = 30` gates
    the `filterRange` state flush; the model for any per-frame layer.
- **Accepted hot-path deferral (MED-3):**
  `packages/layers/src/lib/od-positions.ts` `deriveSourceTargetPositions`
  allocates two buffers per arc/line tile arrival. Cold path, already
  well-optimized — **revisit only under a measured dense-OD stall.**

---

## 5. Open work

### 5.1 Decision 6 — GPU-conformance CI (the one live decision; BLOCKED)

Is a WebGPU-capable CI runner available for the nightly `emitTSL`
smoke-compile + 1px `TIME_FILTER_VECTORS` readback, or does the three gate
fall back to CPU-mirror-vs-oracle with manual browser verify as the only
pixel gate? **Currently BLOCKED: GitHub Actions is dead**, so the question
can't even be posed to real infrastructure. Everything in the Phase-1 rewire
queue is counted out until it is answered: rewiring deck's
`TimeFilterExtension` inject strings → `emitGLSL300(ALPHA_EXPR[mode])`,
maplibre's `TIME_WINDOW_GLSL` → `emitGLSL100`, three's TSL node → `emitTSL`,
plus per-backend headless conformance. The kernel already de-dupes the math
via the CPU oracle, so the rewire is structural dedup with real pixel risk
(generated GLSL differs textually + in FP association from hand-tuned source
on all three backends) and no automated pixel gate to catch regressions.

### 5.2 three backend — integration tail

- **3D-tiles integration:** `createStt3DTiles` + `createSttGlobeControls` are
  built and tested in isolation; wiring them into a live showcase surface is
  open.
- **`SttThreeGeoViewer` showcase wiring:** the component exists (maps each
  demo's deck layer config to `@poopdeck.gl/three/r3f` layers, ~30 flat
  demos) but the DemoPage `deck | maplibre | three` selector path +
  **maplibre camera-sync basemap** need to land and be exercised.
- Folded into that wiring, not standalone tasks: **deck-exact zoom→distance
  pixel match** (a tuning task with no reference surface until the demo-page
  toggle exists; `distanceForScale` machinery is in place) and the
  **per-tile-group time origin under streaming** (only bites multi-day spans
  in f32 ms under real streaming; layers currently rebase all tiles to one
  scene `timeOrigin`, and `setTiles` is replace-all by design).
- **Browser-verify checklist** (no GPU/network in CI; user domain):
  - Streaming: pan/zoom a large dataset on the three backend → tiles
    LOD-refine + evict; the buffered bar reflects real coverage.
  - GPU pick/hover: hover/click a LIDAR cloud decodes the correct feature on
    WebGPU **and** WebGL2; no background flash.
  - Atmosphere: sky/sun/aerial render, sun aligns with the globe; check the
    sphere-vs-wgs84 datum note at the horizon; confirm the WebGL2 degrade.
  - 3D tiles: url / Google / Ion each fetch + render; GlobeControls
    navigation; token/CORS (Google needs a Map Tiles API key +
    `dracoDecoderPath`; Ion needs a token + assetId).
  - Showcase geo viewer: transparent WebGPU canvas over the maplibre basemap;
    alignment on bixi (Montréal) + nyc-taxi (NYC); per-demo point sizing /
    corridor ramps.

### 5.3 deck.gl parity — verify tail

In-browser verification of the shipped pixel-behavior changes (GPU paths are
untestable in jsdom): `AnimatedBoundingBoxLayer` boxes now actually rotate to
heading + scale to dimensions (were silently identity);
`AnimatedMeshLayer` / `AnimatedHexagonLayer` / `AnimatedTextLayer` first live
drive-through + demo/showcase wiring. Deferred feature tails:
`DataFilterExtension` multi-column/fp64/wider integration and
`CollisionFilterExtension` data-driven priority (§3, Tier 3);
`AnimatedTripHeadsLayer` aligned picking via `instanceFeatureIndex`.

### 5.4 Counted-out register (each with its revival trigger)

| Item | Trigger to revive |
|---|---|
| `RenderRegistry.mount` app-facing seam | A runtime backend-toggle product need appears (direct-consumer path works today). |
| `hostApiRange` on descriptors | maplibre v5/globe (or mapbox) support is actually attempted (`base-layer.ts:450` documents the v3/v4-only `render(gl,matrix)` break). |
| Bundle-size guard test (per-subpath `exports` + `sideEffects:false` proof) | The npm-publish packaging pass; resolve lockstep-vs-separate-package first. |
| Cross-package regenerate-and-diff meta-test for `backend-capabilities.md` | Needs a test home that may import all four backends; gen script is deterministic, drift risk low. |
| Constructor-level capability assertions (`degrade()` only fires via the optional registry) | Fold into whichever of registry/publish lands first. |
| Elevation metres→world-units reconciliation (deck true-metre vs three world-Z vs maplibre `DEFAULT_ALTITUDE_SCALE = 1e-7`) | `metersPerWorldUnit()` exists in `core/geo`; wire maplibre through it + a column-height golden vector with the next maplibre pixel-verified change, not standalone. |
| Cesium catalog beyond MOVEMENT (heatmap/summary/flow family) | Demand-driven with typed fallbacks — a Cesium consumer asks for it. |
| three `AnimatedHeatmapLayer` GPU-aggregation parity | 1 demo; descriptor declares the honest fallback; revive on demand. |
| three `BundledFlowmapLayer` (`StaticBundle`/`preBundled` port) | Showcase wiring surfaces a bundled demo on the three backend (`edge-bundler.ts` math reuses). |
| Live KDEEB bundling (5-pass ping-pong float compute) | Explicitly "later/never". |
| three `CategoryColorExtension` palette DataTexture | A demo needs better palette stability than CPU expansion. |
| Terrain/elevation (`QuantizedMeshPlugin`) | A terrain-needing demo; not needed for parity. |
| `SurfelLayer` globe port | Stays ENU-only — deepest coupling (build-time quaternions in ENU metres). |
| Spark Gaussian splatting for the AV/point-cloud path | Deferred; WebGPU path exists upstream. |
| Native in-engine TSL raster basemap (quadtree LOD, XYZ/WMTS) | **DROPPED** in favor of maplibre camera-sync — would take a reversal of the basemap decision, not a trigger. |
| Vector-tile basemap, labels/GPU text, draping/clamp-to-ground, antimeridian wrapping | Deferred from the SoTA pass; product demand. |
| Incremental (non-replace-all) streaming residency + r3f streaming-source cache | Measured churn cost under the wired streaming path. |
| Globe slippy-raster-tiles-on-WebGPU spike | Obsolete — `makeGlobeBasemap` earth-texture sphere covers the 4 globe demos; revisit only if slippy-on-globe becomes a want. |
| maplibre expression-alias vocabulary layer | A maplibre-idiom consumer demands one (deck-shaped canon stands). |

---

## Appendix: canonical concept map (deck ↔ three ↔ maplibre)

The three parity-targeted renderers fork vocabulary for shared concepts. The
per-ecosystem *prefix* schemes are **intentional idiom** and stay: deck
`Animated*Layer`, three bare `*Layer`, maplibre `STT*Layer`. This table is the
canonical map (empty cell = not ported to that renderer); it is referenced by
[`docs/api/stt-three.md`](../api/stt-three.md):

| concept | deck (`@poopdeck.gl/layers`) | three (`@poopdeck.gl/three`) | maplibre (`@poopdeck.gl/maplibre`) | notes |
|---|---|---|---|---|
| points | `AnimatedPointLayer` | `PointCloudLayer` | `STTPointLayer` | |
| trips / trails | `AnimatedTripsLayer` | `TripsLayer` | `STTTripsLayer` | |
| line / path | `AnimatedPathLayer`, `AnimatedLineLayer` | `PathGeoLayer` / `StaticPathLayer`, `OdLineLayer` | `STTLineLayer` | |
| polygon | `AnimatedPolygonLayer` | `PolygonLayer` / `StaticPolygonLayer` | `STTPolygonLayer` | |
| heatmap | `AnimatedHeatmapLayer` | *(deferred)* | `STTHeatmapLayer` | GPU-aggregation parity deferred in three (Decision 6). |
| surface-splat primitive | `SplatLayer` / `SplatPrimitiveLayer` | `SurfelLayer` | *(none)* | **One primitive, two names** — three's `SurfelLayer` is "the Three analogue of deck's `SplatLayer`", reading the same `--surfel` columns. |
| **time-filter window** | `timeWindow` (**full** width, ms) | `windowHalf` (**half** width, default `250`) | `timeWindow` (**full** width, ms) | **2× magnitude trap**: copying `timeWindow: 86_400_000` onto a three layer is an unknown prop → silent fallback to `windowHalf = 250`. Same knob, different name *and* half-vs-full semantics. |
| fade-in ramp | `fadeInDuration` | `fadeIn` (but `BoundingBoxLayer` uses `fadeInDuration`) | `fadeInDuration` | three is internally inconsistent — box layer already uses the deck/maplibre name. |
| fade-out ramp | `fadeOutDuration` | `fadeOut` | `fadeOutDuration` | same fork as fade-in. |
| categorical color | `fillColor` / `getFillColor` + keyed `colorMapping` + `colorMappingDefault` (+ positional `colorPalette`) | `colorProperty` + keyed `colorMapping` + `colorMappingDefault` | `colorProperty` + positional `colorPalette` only | maplibre can't express stable category→color *by name*; a tile-local category reorder silently recolors. Color accessor also forks: deck `getFillColor` vs three/maplibre `colorProperty`. |
