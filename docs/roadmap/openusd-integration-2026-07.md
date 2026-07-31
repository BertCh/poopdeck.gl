# OpenUSD integration — the spatiotemporal tile pyramid as scene description (2026-07)

Status: **PLAN, except §8.5a's layer half, which shipped 2026-07-29**
(`AnimatedScenegraphLayer` — see that section; U1–U4 remain unbuilt).
Authored 2026-07-27 from two research passes:
first the data model and time semantics (OpenUSD release + dev docs, AOUSD
working-group register and forum, Cesium for Omniverse, NVIDIA Omniverse/USDRT),
then the format and plugin layer (Sdf file formats, dynamic file formats, Ar 2.0,
crate/USDZ specification status, `usdAbc` as prior art). The second pass changed
the plan: §8.3 replaced "export to USD" as the centre of the campaign. A third
pass on 2026-07-28 assessed NVIDIA's `nanousd` (§8.6), which reshaped the U5
gate in §9.1 from a licence question into three engineering ones. Every external
claim carries its source and the date it was checked, because each one is
load-bearing for a verdict — this is not a survey, and it should not be allowed to
become one.

## 1. Intent

Two positions, one campaign:

- **STT contributes the axis OpenUSD does not have.** USD has a mature temporal
  model and no spatial index. STT is a spatial index crossed with a temporal one.
  The mapping is not an analogy — it is an isomorphism (§5), and assembling USD's
  existing primitives into a spatiotemporal tile pyramid is a thing nobody has
  shipped. The mechanisms USD provides for reaching an external format — a lazy
  file format plugin, a dynamic payload, a URI resolver doing range reads — mean
  the end state is not an export but a **layer type**: `.stt` opened natively,
  streaming, by any USD application (§8.3).
- **poopdeck becomes the web experience USD does not have.** The state of the art
  for viewing USD in a browser is weak enough that the community's own recommended
  path is an offline, lossy conversion to glTF (§9.2).

The scope discipline that keeps this from becoming a 3D-engine project is §7. The
seam that keeps it from becoming a rewrite is §6.

## 2. The gap

|                                       | Spatial index                  | Time axis                             | Artist / scene layer |
| ------------------------------------- | ------------------------------ | ------------------------------------- | -------------------- |
| OpenUSD                               | none                           | value clips, time samples, velocities | mature               |
| 3D Tiles 2.0 vector (Cesium, 2026-06) | quadtree / octree / k-d / DGGS | **none proposed**                     | via glTF             |
| STT                                   | WebMercatorQuad + temporal LOD | `(z, x, y, bucket)` crossed           | none                 |

Cesium announced points, lines and polygons as native 3D Tiles primitives on
2026-06-29 — glTF encoding, centimetre-to-millimetre precision, the same spatial
indexing that carries their meshes and point clouds. The announcement discusses no
temporal support of any kind.
([source](https://cesium.com/blog/2026/06/29/help-shape-vector-data-support-in-3d-tiles/),
checked 2026-07-27.)

So the incumbent geospatial format is arriving in STT's data types without a time
axis, and the incumbent scene format has a time axis without a spatial index.
**Time-varying geospatial vector data is unclaimed.** That is the whole basis for
this campaign, and it is the claim to re-check before spending on it.

## 3. What USD structurally cannot do

These are constraints on the design, not complaints. Each one is why a naive
"just export a stage" approach fails.

### 3.1 Geometry points are single-precision, permanently for now

`UsdGeomPointBased.points` is typed `point3f[]`. There is no double-precision
point type in any USD schema. Pixar's position on the AOUSD forum is that leaf
geometry is single-precision by design and hierarchical transforms carry the
double precision; optional `point3d[]` / `point3d[] velocitiesd` attributes were
floated and remain "queued for discussion" with no timeline (thread last active
April 2024, [source](https://forum.aousd.org/t/double-support-in-geometry-data/808),
checked 2026-07-27). Geometry **extents** are float32 as well, which compounds
when combining extents at large scale.

Consequence: absolute geographic coordinates cannot be stored in USD geometry.
Any georeferenced USD data must be rebased to a local origin. This is not a
poopdeck problem to solve — it is a constraint every participant already lives
under (§4).

### 3.2 There is no geospatial standard, and no working group writing one

AOUSD's working groups are Core Specification, Materials, Geometry (chartered for
CAD interoperability), Physics, and Marketing. None covers geospatial,
geolocation, or CRS ([source](https://aousd.org/working-groups/), checked
2026-07-27). Esri joined as a general member in 2025 explicitly to contribute CRS
expertise, and a geolocation proposal was floated to the Geometry WG; nothing is
ratified.

Consequence: **the georeferencing vocabulary is a vendor extension today.** Cesium
for Omniverse defines `CesiumGeoreference` (a stage-origin lat/lon/height) and
`CesiumGlobeAnchorAPI` (applied to any `Xformable`, positioning it by
lat/lon/height or double-precision ECEF). Their own guidance is to stay within
**roughly 100 km of the stage origin** for un-anchored prims, because "the down
direction changes by roughly 0.01 degrees for every kilometre"
([source](https://cesium.com/learn/omniverse/omniverse-placing-objects/), checked
2026-07-27) — a curvature limit stacked on top of the precision limit in §3.1.

**Verdict: align to Cesium's vocabulary, do not invent a competing one.** Being
the second implementer of an unratified schema is a contribution; being the
second author of a competing one is noise. Revisit only if AOUSD charters a
geospatial WG and the shape it lands on differs.

### 3.3 Splines are authored but not resolved

`Ts` splines serialize in `usda`/`usdc` today, but the USD Anim status page states
the project "is still in development and not ready for general use": Bezier only
(no Hermite), no editing or query API, and **attribute value resolution via
splines is not yet implemented** — it is listed as the final piece of work
([source](https://openusd.org/dev/api/page_ts_status.html), checked 2026-07-27).

Consequence: emit time samples, never splines. Re-evaluate when the status page
reports value resolution as implemented.

### 3.4 Animated values do not compose sparsely

The strongest layer holding _any_ time sample for an attribute is the source of
_all_ time samples for it. Samples at `[1, 30]` in one reference and `[40, 70]` in
another compose to `[1, 30]` only — there is no union
([source](https://openusd.org/dev/user_guides/time_and_animated_values.html),
checked 2026-07-27). Value clips exist substantially to route around this.

Consequence: this is the strongest available evidence for the standing rule that
STT keeps composition out of the byte format. An immutable, content-addressed
archive whose bytes determine its content cannot also be a layered-opinion system;
USD's own experience is that the layered-opinion system then needs a second
mechanism bolted underneath it to handle scale.

### 3.5 There is no normative binary container specification

The crate format (`.usdc`) is deliberately undocumented at byte level "to allow
for internal optimization"; the public documentation describes its _properties_
(lazy index on open, mmap zero-copy array access with POD alignment, lossless
round-trip with `usda`) but not its layout. AOUSD **Core Specification 1.0**
(released 2025-12) covers the core algorithms and data model — how scenes are
constructed, composed and resolved — not a binary encoding
([source](https://aousd.org/news/core-spec-announcement/), checked 2026-07-27).
The only byte-level USD specification that exists is
[USDZ](https://openusd.org/release/spec_usdz.html), which is a zip container
profile, not an encoding.

Two consequences, one for each direction:

- **Emitting `usda` is safe and fully specified. Emitting `usdc` is not.** A
  `usdc` writer means either the C++ implementation or a reverse-engineered one
  (the Rust crates in §8.4 are reverse-engineered). Default to `usda` for
  interchange artifacts and treat `usdc` as an optimization requiring a
  dependency decision.
- **STT has what USD does not.** `docs/spec/stt-packed-format.md` is a normative,
  1,487-line container specification with a stability promise and a changelog.
  When §1 says STT contributes to the data-formats space, this is a concrete part
  of what it contributes — not just an axis, but an axis that is _specified_.

## 4. Why STT fits by construction

Tiling solves §3.1 for free, and this is the load-bearing property of the whole
campaign.

A tile covers a bounded extent. Rebase its contents to a tile-local origin and
float32's relative step of ~1.2e-7 gives, at the far edge of a tile:

| zoom | tile width (equator) | worst-case float32 step |
| ---- | -------------------- | ----------------------- |
| z10  | ~39.1 km             | ~4.7 mm                 |
| z6   | ~626 km              | ~7.5 cm                 |
| z4   | ~2,505 km            | ~30 cm                  |
| z0   | ~40,075 km           | ~4.8 m                  |

(Arithmetic only, no measurement: equatorial WebMercatorQuad tile width is
40,075,016.686 m / 2^z — the matrix set STT profiles in
[`tile-matrix-set.json`](../spec/tile-matrix-set.json), which references it by URI
rather than enumerating it — against the IEEE-754 binary32 mantissa step of
2^-23 ≈ 1.2e-7 relative.)

STT already quantizes coordinates to a per-tile step, so quantized tile-local
coordinates drop into `point3f[]` **without a lossy step** at every zoom the
demos use. The precision ceiling that forces every other participant into a
workaround is one STT never approaches.

Three independent systems converged on the same trick — 3D Tiles' `RTC_CENTER`,
Cesium's globe anchors, and `LocalEnuProjection` / `computeWorldToEcef` in
`packages/three`. STT gets it as a side effect of being a tile format.

## 5. The isomorphism

USD already has every primitive needed to express a spatiotemporal tile pyramid.
No one has assembled them into one.

| STT concept                | USD mechanism                                                    |
| -------------------------- | ---------------------------------------------------------------- |
| spatial tile `(z, x, y)`   | a prim with a **payload** — declared cheaply, loaded on demand   |
| temporal bucket            | a **value clip** within that prim's clip set                     |
| the directory              | the **clip manifest** — the index that avoids opening every clip |
| `cover_t_min` / `time_end` | clip `active` ranges + `interpolateMissingClipValues`            |
| temporal LOD tier          | a **named clip set**, selected by a **variant set**              |
| content-addressed pack     | a clip `assetPath`                                               |
| `--time-origin` rebasing   | **LayerOffset** (`stageTime = layerTime × scale + offset`)       |

The manifest correspondence is the sharpest one. USD's clip manifest exists so
that "value resolution [does not] open every clip to determine attribute
availability"; STT's paged directory carries per-leaf `[t_min, t_max]` descriptors
so a cold reader prunes whole leaf pages before fetching them
([time-model.md §5](../spec/time-model.md)). Same problem, same shape, arrived at
independently.

### 5.1 Layer-kind mapping

| STT layer kind         | USD prim                                                       |
| ---------------------- | -------------------------------------------------------------- |
| points                 | `UsdGeomPoints` (`points`, `widths`, `ids`, `velocities`)      |
| paths / LineString     | `UsdGeomBasisCurves`, linear basis                             |
| polygons               | `UsdGeomMesh` (triangulated — USD meshes have no hole concept) |
| trips / moving objects | `UsdGeomPointInstancer` with prototypes                        |
| summary (H3/Quadbin)   | `UsdGeomMesh` or `PointInstancer`                              |

### 5.2 Selection maps at composition granularity, not frame granularity

USD payloads are deferred loads, not camera-driven LOD — but the mapping is
richer than "no selection." **Dynamic file formats** let a layer's contents be
generated from values composed on the prim that includes it: a plugin implementing
`PcpDynamicFileFormatInterface` supplies
`ComposeFieldsForFileFormatArguments()`, Pcp registers a dependency on every field
read there, and changing such a field invalidates the prim index and regenerates
the layer
([source](https://openusd.org/dev/api/_usd__page__dynamic_file_format.html),
checked 2026-07-27).

So `sttZoom = 10` or a time-window field authored on a prim _can_ drive which
tiles materialise. Four constraints bound it, and all four are load-bearing:

- **Payloads only** — dynamic composition does not work through references,
  because payloads are the weakest arcs that read layer files and are the only
  ones that can be loaded and unloaded.
- **Only registered plugin metadata fields** (declared in `plugInfo.json` under
  `SdfMetadata`) or uniform attribute defaults can drive it. Builtin fields such
  as `variantSelection` cannot.
- **Invalidation is Pcp recomposition**, not a buffer swap. `CanFieldChange-
AffectFileFormatArguments()` exists precisely to suppress needless recomposition,
  which tells you how expensive the un-suppressed case is.
- Therefore it is a **coarse selector** — zoom tier, time window, dataset variant
  — and emphatically **not a per-frame streaming mechanism**. Driving it from a
  camera at 60 Hz would recompose the stage at 60 Hz.

This sharpens §6 rather than softening it. USD composition is the _coarse_
selector; STT's runtime remains the _per-frame_ streamer. The two are different
tiers of the same decision, and the boundary between them is the seam.

### 5.3 Prior art: `usdAbc`

Alembic is the closest existing analogue — a time-sampled geometry cache reached
through a USD file format plugin — and it carries two transferable lessons.

- **`alembicReader.cpp` assumes a fixed 24 FPS**
  ([issue #940](https://github.com/PixarAnimationStudios/OpenUSD/issues/940)).
  A shipped, long-lived, silent time-base bug in exactly the layer this campaign
  proposes to build. It is the strongest possible argument that `--time-origin`
  (§8.4) must be explicit and must never acquire a default.
- **Alembic underperforms native USD partly for a lock reason**: giving a
  multithreaded client lockless data access requires opening an Ogawa archive
  redundantly, once per thread. STT's packs are immutable and content-addressed
  and are read by `(count, offset)`, so concurrent readers need no coordination at
  all. STT behind a file format plugin should not inherit Alembic's ceiling — and
  if it appears to, that is a bug in the plugin, not an inherited limit.

## 6. Architecture verdict — where the seam goes

**USD is the scene description. STT is the streaming path. Do not push tiles
through USD composition.**

This is not a hedge; it is the architecture the two largest players in this exact
problem already chose:

- **NVIDIA Earth-2** — global-scale, time-varying, built on Omniverse and OpenUSD
  — streams its full-scale environment with **3D Tiles**, not USD composition
  ([source](https://www.nvidia.com/en-us/high-performance-computing/earth-2/demo/),
  checked 2026-07-27).
- **Omniverse's own streaming path is Fabric, not USD prims.** Cesium for
  Omniverse writes through the Fabric Scene Delegate, and NVIDIA's docs describe
  authoring directly to Fabric for cases "where USD data persistence is not
  required," with HyperScale going further and bypassing USD population entirely
  ([source](https://docs.omniverse.nvidia.com/kit/docs/usdrt/latest/docs/fabricsd/intro.html),
  checked 2026-07-27).

The difference in STT's favour is that Fabric is an in-memory runtime store and
STT is an open, content-addressed, temporally-indexed file format. The seam is the
same; the artifact on the streaming side is durable.

## 7. The direction rule

**poopdeck consumes and emits USD. It never authors USD.**

Accept a stage as input, emit a clip set as output, render one as a guest. This is
the rule that keeps a mapping project from becoming a DCC tool, and it should be
cited when scope is argued.

Explicit non-goals, each a counted-out item with its trigger in §10: material
authoring or MaterialX editing, rigging or `UsdSkel` authoring, a keyframe
timeline UI, scene assembly or layer-stack editing, and any implementation of
USD's composition engine.

## 8. Tracks

Ordered so that each track has something to check it against, not by size or
visibility: U1 produces the oracle, U2 the vocabulary, U3 the product, U4 closes
the loop, U5 is the demo. Sequenced behind B1–B3 in [README.md](./README.md) —
this campaign touches the format's external contract, and doing that while a byte
break is unlanded and the fleet is unrepublished would be sequencing two churn
events on top of each other.

### 8.1 U1 — static export to a clip set (the mapping oracle)

Emit an STT archive as a self-contained USD clip set per §5: `usda` per §3.5, one
clip per temporal bucket, a generated manifest, `active` ranges from the bucket
boundaries.

This is deliberately the _simple_ version, and it is first for two reasons that
are not "it is easiest." It **needs no plugin installed**, so it is the only path
that works in a stock `usdview`, a locked-down DCC, or a WASM build. And it is
the **conformance oracle for U3**: a byte-diffable artifact that the native plugin
must reproduce. Building the clever thing first leaves nothing to check it
against.

Open questions: `upAxis` and `metersPerUnit` declaration; whether polygon
triangulation is emitted or deferred; how the temporal LOD tiers are named as
clip sets.

**Accept:** a published STT archive opens in `usdview`, animates on its own clock,
and round-trips through U4 with no geometry or time drift.

### 8.2 U2 — the georeferencing + tiling schema (codeless)

Codeless schemas — `skipCodeGeneration = True`, USD v21.08+ — emit only
`generatedSchema.usda` and `plugInfo.json`, register at runtime, and require no
C++ compilation or linking
([source](https://openusd.org/dev/api/_usd__page__generating_schemas.html),
checked 2026-07-27). That means an STT schema ships as **pure data**: no build
step, no ABI, and it works anywhere USD runs including the WASM builds.

Content: mirror Cesium's georeference/globe-anchor semantics per §3.2, and declare
the tiling and temporal structure (§5) that Cesium's schema has no concept of.
State the tile-local-origin precision property (§4) normatively, since it is the
reason the schema is sound.

**Accept:** the schema registers in a stock USD build from data alone, an emitted
stage validates against it, and the georeference half is demonstrably compatible
with a Cesium-anchored stage.

### 8.3 U3 — `.stt` as a native USD layer (the contribution)

Not an export target — a **layer type**. `usdview archive.stt` opens it; Houdini
and Omniverse `payload @archive.stt@` it; nothing materialises until asked. Three
mechanisms, all verified to exist (2026-07-27):

- **`SdfFileFormat` + a lazy `SdfAbstractData` adapter.** The Sdf docs are
  explicit that deriving only from `SdfFileFormat` means the file's entire
  contents are translated and cached at open, and that a format wanting lazy
  access — "as most binary file formats are designed to do" — must also supply an
  `SdfAbstractData` adapter, which declares itself via `StreamsData`
  ([source](https://openusd.org/dev/api/_sdf__page__file_format_plugin.html)).
  This is the mechanism that keeps an 800 MB archive from being materialised on
  open.
- **`PcpDynamicFileFormatInterface`** for the coarse selector in §5.2 — zoom tier
  and time window composed from prim fields, with dependency-tracked
  invalidation.
- **An `stt://` URI resolver.** Ar 2.0 dispatches resolvers by URI scheme,
  declared as `uriSchemes` in `plugInfo.json`, and `ArAsset::Read(buffer, count,
offset)` performs range reads without requiring the asset in memory
  ([source](https://openusd.org/release/api/class_ar_asset.html)). That is exactly
  STT's existing access pattern, so packs on R2 are readable in place — no
  localisation, no duplication, one artifact serving both the web runtime and
  every USD application.

**The cost, stated plainly: this is C++, and the codeless-schema argument does not
apply to it.** `SdfFileFormat`, `SdfAbstractData` and `PcpDynamicFileFormat-
Interface` are C++ base classes; U2 ships as data, U3 ships as a compiled artifact
per USD version, platform and ABI. That distribution burden is the single largest
argument against this track and must be priced before it is scoped. Precedent
exists (`usdAbc`, `usdDraco`, `usdMtlx`) and NVIDIA publishes build scaffolding
for exactly this shape
([OpenUSD-plugin-samples](https://github.com/NVIDIA-Omniverse/OpenUSD-plugin-samples)),
but precedent is not the same as cheap.

**`nanousd` does not reduce this cost** — the plugin interfaces are OpenUSD
architecture rather than Core Specification, so this track targets OpenUSD
specifically. See §8.6 for why that turns out to be the right split rather than a
limitation.

**Accept:** `usdview archive.stt` renders and animates a published archive read
over `stt://` with no local copy; the composed stage is equivalent to U1's export
for the same selection; and the memory high-water mark on open is bounded by the
directory, not the archive.

### 8.4 U4 — USD → `stt-build` (ingest)

A fourth input adaptor alongside GeoParquet, PostGIS and DuckDB. Reads
time-sampled `Xformable`s, `UsdGeomPoints` and `PointInstancer` (carrying
`velocities`, `ids`, `invisibleIds` through — see §11), resolves the
`timeCodesPerSecond` precedence chain and composed LayerOffsets, and tiles the
result.

Implementation note: pure-Rust USD readers exist ([mxpv/openusd](https://github.com/mxpv/openusd)
covers `usda`/`usdc`/`usdz` with no C++ dependency; [openusd-rs](https://github.com/FloatyMonkey/openusd-rs)
is earlier), and `scripts/data-generation/` is already Python, where `pxr` is
first-party. A third option arrived 2026-07: **`nanousdapi` over Rust FFI**
(§8.6) — a C11 ABI is ordinary FFI where OpenUSD's C++ is not, and it puts a real
USD implementation in-process in `stt-build`.

The cheap first cut is Python; the durable one is Rust over one of the two Rust
paths. Decide on evidence, not preference — and price in §3.5 when doing so: any
non-`pxr` `usdc` reader is implemented against a format with no public byte-level
specification, so it carries a silent-drift risk that `pxr` does not. nanousd
narrows that risk (better-resourced, spec-derived test suites) without eliminating
it, since the Core Specification does not specify the crate encoding either.

**Required, not optional:** a `--time-origin` flag. USD timeCodes are unitless and
relative; [time-model.md §1](../spec/time-model.md) mandates absolute non-negative
Unix-ms. There is no defensible default mapping — and §5.3 records what happens
when one is assumed anyway: `usdAbc` has shipped a silent 24-FPS assumption for
years.

**Accept:** an Omniverse/Isaac/CARLA-authored stage tiles into a `.stt` that
validates, and a U1 round-trip is byte-stable.

### 8.5 U5 — rendering USD, split by what is actually being asked

"Render USD" is two products with different homes. Conflating them is what makes
the track look bigger than it is.

#### 8.5a Placing USD-authored **assets** in the geospatial time scene — deck; the layer half is BUILT

`AnimatedMeshLayer` (`packages/layers/src/layers/core/animated-mesh-layer.ts`)
already instances an arbitrary glTF/OBJ mesh at each tracked object's interpolated
pose via `SimpleMeshLayer`, sharing the track kernel with
`AnimatedBoundingBoxLayer`: cross-tile keyframe pooling, binary-search + lerp,
shortest-arc heading, quaternion slerp, appear/disappear fade, GPU-id picking,
per-category mesh mapping. The mesh is a static per-layer prop, not a tile column.

**Shipped 2026-07-29: `AnimatedScenegraphLayer`**
(`packages/layers/src/layers/core/animated-scenegraph-layer.ts`, 27 tests,
[docs/api](../api/animated-scenegraph-layer.md)) — deck's `ScenegraphLayer` as a
second engine behind the same track machinery, for **authored** assets rather than
primitives: node hierarchy, PBR materials, per-node animation. It subclasses
`AnimatedMeshLayer` and overrides four `protected` engine seams; `scenegraph` /
`scenegraphMapping` fall back to `mesh` / `meshMapping`, so one props object
drives either class. Zero new dependencies — `@deck.gl/mesh-layers` is already a
peer dep and ships both engines.

This deliberately **supersedes** `renderer-architecture.md` §3.3's
"revive as a renderer variant of the `mesh` kind, not a second slug." A separate
layer class mirrors deck's own `SimpleMeshLayer` / `ScenegraphLayer` split, which
is the catalog's organising principle; it is **not** a second `LayerKind` — the
frozen `mesh` kind still covers both, and `backend-descriptor.ts` needed no change.

**What the earlier draft of this section got wrong.** It said "the only missing
piece is USD → glTF at the front." The conversion is indeed available and
scriptable (`omni.kit.asset_converter` has a documented Python async API), but
four deck-level constraints were verified against the installed deck 9.3.2 /
luma 9.3.3 / loaders.gl 4.4.2 and each one silently changes what an asset looks
like in the browser versus in the DCC. They are now documented on the layer, with
one-time warnings where detectable:

1. **Skinned geometry does not deform.** `scenegraph-layer-vertex.glsl` declares
   `positions`/`texCoords`/`normals` only — no `JOINTS_0`/`WEIGHTS_0` — and
   `_getModelOptions()` injects deck's own shaders into every glTF model,
   replacing luma's generated one. luma.gl itself has skinning; deck's instanced
   path does not reach it. A rigged pedestrian renders in bind pose.
2. **Rigid per-node animation works** — `GLTFAnimator` drives node TRS into a
   per-model `sceneModelMatrix`.
3. **…on deck's clock, not the playhead.** `draw()` calls
   `animator.setTime(context.timeline.getTime())`, so `_animations` neither
   rewinds on a scrub nor stops on pause, and needs `_animate: true` on the Deck
   instance (a continuous redraw — mind the reduced-motion gate). This is the same
   class of silent time-base bug as `usdAbc`'s 24 FPS (§5.3), which is why it is
   warned about rather than left to be discovered.
4. **Materials are filtered twice.** Omniverse's exporter emits only OmniPBR /
   `UsdPreviewSurface` / `gltf.mdl`; then loaders.gl has no handler for
   `KHR_materials_clearcoat`/`_transmission`/`_sheen`/`_ior` and deck hardcodes
   `useTangents: false`. Author to `UsdPreviewSurface`, stay on core
   metallic-roughness. Draco / KTX2 / meshopt **do** work with no extra setup.

Two divergences from the mesh sibling are deliberate: `scaleToDimensions`
defaults to **`false`** (the inherited `true` fits a _unit_ model to the object's
bbox and would squash an asset that already carries real metres via
`metersPerUnit`), and the CPU appear/disappear fade **survives a textured asset**
(`ScenegraphLayer` multiplies `getColor` into the material — `vColor *
pbr_filterColor(...)` — where `SimpleMeshLayer` lets a `texture` defeat it).

**Remaining for this track:** a `scripts/data-generation/` USD → glb converter
driving `omni.kit.asset_converter` headlessly; wiring one demo (see below); and,
if wanted, playhead-locked asset animation, which needs a `draw()` override to
substitute the timeline and is counted out of this pass.

**Demo candidate.** The generative AV corpora are the natural first consumer,
because Omniverse is the native authoring surface for that content and the
category vocabulary is already a clean per-asset mapping key
(`car`/`truck`/`bus`/`trailer`/`construction_vehicle`/`pedestrian`/`bicycle`/
`motorcycle`/`traffic_cone`/`barrier` in `datasets.ts`). Two cautions: the
**wireframe box look is deliberate** — `buildWorldsLayers.ts` and
`buildDemoLayers.ts` both set `filled:false, stroked:true` so LiDAR returns inside
each box stay visible (the streetscape.gl / nuScenes-devkit style), so solid
assets are a _variant_, not a replacement; and the `/worlds` gallery is 300
scenarios on one clock and already zoom-gates its boxes, so the first assets
belong on the `/drive` cockpit (single scene) and the flown-into hero world, not
the whole grid.

The front half remains **USD → glTF**, which §9.3 records as the USD community's
own pragmatic recommendation. Lossy and static, and for this use — drop authored
vehicles, buildings, machines into a time-aware geospatial scene — those are the
right trade-offs. It lands in deck, where the product is, at close to zero
marginal render cost.

#### 8.5b Rendering an arbitrary USD **stage** — three, and only three

`STTScene` does not own the renderer, camera or loop; the host adds its `root`
group to its own scene (`packages/three/src/scene/stt-three-scene.ts`), and
`scene/tiles-3d.ts` is the established precedent for co-registering an external
library's `THREE.Group` behind a dynamic import. A USD stage group follows that
shape exactly.

**Why not deck — three independent answers already in
[renderer-architecture.md](./renderer-architecture.md):**

1. **§1.2 lists as structurally un-unifiable** that "deck projects on GPU against a
   host viewport and can never take a CPU `Projection`," along with camera
   ownership and the render loop. A USD stage is a nested transform hierarchy in
   its own metric frame carrying its own cameras. Hosting one in deck means
   fighting precisely the thing deck will not give.
2. **§0 defines the three backend as existing "to do something deck cannot, not to
   duplicate it."** Hosting a general scene graph with arbitrary transforms,
   materials and lights _is_ that something. The routing rule "deck first, three
   second" governs new STT `LayerKind`s; a USD stage is not a layer kind, so the
   rule does not reach this decision.
3. **§2.10's own empty-niche test.** The three backend earned BUILD because "no
   open three.js project does streamed, time-windowed, animated vector layers —
   the niche is empty." USD rendering fails that test badly: Hydra Storm, Autodesk
   Aurora, `hdJavaScript`, and nanousd's own Vulkan/OpenGL/Metal viewers all
   exist. By the record's standard a deck USD renderer would be a me-too port.

**The constraint that makes this choice matter more than it looks:** §2.10 records
as a measured negative result that **"deck↔three interop does not exist in any
form."** So a USD stage cannot sit in three while STT layers render in deck on the
same canvas — whichever backend hosts the USD also hosts the STT layers beside it.
That is the real argument for 8.5a: it is not a consolation prize, it is the only
way USD-authored content reaches the deck layer catalog, which is the product.

Ranked last despite being the most visible, because it is gated on the §9
externals and because U1–U4 are what make the claim in §1 true. This is the demo;
U1–U4 are the contribution — and note that **U3 needs no renderer at all**, so
none of this is on the critical path for the actual contribution.

**Accept (8.5a):** a USD-authored asset converted to glTF renders through
`AnimatedScenegraphLayer` on a live archive with correct pose and picking. The
layer is done and unit-tested; the accept is **not** met until a real
Omniverse-exported asset has been through it in a browser, because every one of
the four constraints above is invisible to a unit test.
**Accept (8.5b):** a static `.usdc` renders as a `THREE.Group` inside an
`STTScene` on the existing ENU rig with an STT tile layer over it, correctly
registered, and the bundle cost of the WASM payload is measured and recorded here.

### 8.6 `nanousd` — a shared dependency across U3–U5

NVIDIA published [nanousd](https://github.com/NVIDIA-Omniverse/omniverse-labs/tree/main/projects/nanousd-labs)
under Omniverse Labs: an independent implementation of the USD **Core
Specification** with a C++17 core behind a stable C11 ABI (`nanousdapi`), reading
and writing `usda`, `usdc` and `usdz`. **Apache 2.0** for code, CC-BY-4.0 for
documentation. It is explicitly a data layer — "out of scope: Hydra, imaging, and
GPU rendering pipelines" — sized to embed where the full OpenUSD stack cannot go.
(Checked 2026-07-28.)

**Where it helps.**

- **U5, decisively in shape if not yet in fact.** The licence problem in §9.1 was
  never USD — it was that the available browser options _bundle_ a data layer with
  a renderer, and the bundle carried the bad licence. nanousd unbundles along
  exactly the line poopdeck needs: we already own the renderer
  (`packages/three`), so what is missing is a permissively-licensed USD **data**
  layer in the browser. That is what this is. See §9.1 for what remains unproven.

  One cost this shifts rather than removes: nanousd has **no Hydra**, by design.
  Autodesk's route supplies a Hydra delegate (`hdJavaScript`) that emits three.js
  objects; the nanousd route means writing the USD-data→three translation
  ourselves. Not obviously worse — there is no Hydra to learn, and the fleet's own
  Vulkan/OpenGL/Metal renderers are the template for consuming the C ABI directly
  — but it is work we would own rather than adopt, and none of those backends
  targets the web. Price it as part of U5, not as a freebie.

- **U4, as a third ingest option.** `nanousdapi` is C11, and binding C11 from Rust
  is ordinary FFI — categorically cheaper than binding OpenUSD's C++. That makes
  "a real USD implementation, in-process, in `stt-build`" a live option alongside
  the reverse-engineered Rust crates and Python `pxr`.

**Where it does not help, and this is the important half.** `SdfFileFormat`,
`SdfAbstractData`, `PcpDynamicFileFormatInterface` and `ArResolver` are **OpenUSD
implementation architecture, not Core Specification** — and the nanousd
documentation mentions no plugins, no file-format extensibility, and no asset
resolvers. **U3 therefore targets OpenUSD and gains nothing here.** The resulting
split is clean rather than awkward, and worth stating as the intended end state:

- **OpenUSD, on the desktop and in DCCs** — `.stt` is a native layer via the U3
  plugin.
- **nanousd, in the browser** — reads USD; poopdeck reads `.stt` natively; the two
  meet in the three scene, neither needing to understand the other's format.

**The risk, stated plainly.** nanousd is pre-1.0 with "no stability or support
guarantees," and it is AI-generated from the specification — the project's own
framing ("specs are durable, agents are elastic") makes the methodology the
deliverable and the code a proof point. There is also a **documented gap between
the README's feature list and the fleet's own status page**: the README claims
full LIVERPS, time samples, splines and value clips, while `STATE-OF-THE-FLEET.md`
places layer composition, **value resolution**, variants, schemas, instancing and
`usdz` packaging in "defined, generation in progress," and warns that "any one
feature generates well on its own; making them work together is the hard part."
Those describe two parallel tracks — a prompt-generated library and a skillgraph
regeneration — meeting at a shared C interface.

**Verdict: evaluate, do not assume.** Any track that leans on nanousd must first
verify the specific feature it needs against a build, not against the README —
value clips especially, since §5 makes them load-bearing. Apache 2.0 plus a narrow
C ABI means the dependency is forkable and vendorable if it stalls, which is what
makes the risk acceptable rather than disqualifying.

**Adjacent, not actionable:** the nanousd bet is that a sufficiently precise
specification is _generative_ — implementations regenerate from it, validated by
spec-derived test suites. STT has a normative container specification (§3.5), so
that bet is testable here. Counted out for now; the trigger is a second
independent STT reader being wanted for conformance reasons.

## 9. Gates

### 9.1 The browser USD question changed shape; the open part is now WASM, not licensing

The original blocker: Needle's `usd-viewer` — the most complete browser USD
viewer, built on Autodesk's WASM bindings with a three.js Hydra render delegate —
is **PolyForm Noncommercial 1.0.0**, unusable in the MIT-licensed `@poopdeck.gl`
packages ([source](https://github.com/needle-tools/usd-viewer), checked
2026-07-27). OpenUSD itself is modified Apache 2.0 and was never the problem;
Autodesk's `usd-wasm` and `hdJavaScript` licences remain unverified.

**`nanousd` (§8.6) makes that line of enquiry mostly moot.** The bad licence was
attached to a _bundle_ of data layer plus renderer. poopdeck does not need the
renderer half — `packages/three` is the renderer. nanousd is Apache 2.0, is a data
layer by design, and has a C ABI. It is the right shape.

What is now unproven, and what U5 must establish first:

- **nanousd has no WebAssembly or Emscripten target today** — none is mentioned in
  its build documentation (checked 2026-07-28). Compiling a self-contained C++17
  library with a C11 surface under Emscripten is ordinary work, and is a
  categorically smaller problem than the full OpenUSD stack (which is precisely
  why the Autodesk fork is "quite large as a web deliverable," §9.3). But
  "ordinary" is not "done," and nobody has published a build.
- **Whether the features U5 needs actually work**, per the README-vs-status gap in
  §8.6. Verify against a build.
- **Whether §9.2 still binds.** The COOP/COEP requirement came from
  `SharedArrayBuffer` in the existing WASM builds. A different, smaller build may
  not need threads at all — which would remove a site-wide deployment constraint.
  Check this early; it is cheap to check and expensive to discover late.

The gate is unchanged in force — do not scope U5 before these are answered — but
it is now three tractable engineering questions instead of one licence question we
do not control.

### 9.2 Cross-origin isolation is a site-wide constraint

The USD WASM build requires `SharedArrayBuffer`, which requires COOP/COEP
cross-origin isolation. Under COEP every cross-origin subresource needs a
`Cross-Origin-Resource-Policy` header — including `tiles.poopdeck.gl` and the 266
`/worlds` videos. This is a deployment change to the Cloudflare Pages site, not a
package change, and it is the failure most likely to surface late. Mitigation:
scope isolation to a single route.

### 9.3 State of the art for web USD viewing (why §1's second claim holds)

The AOUSD forum's own assessment: the Autodesk WASM fork is the most complete
option but is large as a web deliverable and exposes only a limited JS API subset;
TinyUSDZ is lighter, more actively maintained, and incomplete; three.js's
`USDZLoader` is missing proper transform hierarchy and has no animation support.
The pragmatic recommendation is offline conversion to glTF, which is lossy
([source](https://forum.aousd.org/t/state-of-the-art-for-viewing-usdz-on-web/2344),
checked 2026-07-27).

This is the evidence for the positioning claim, and it is also the thing most
likely to change under us — OpenUSD maintainers describe WASM support as moving
toward the primary repository. **Re-check before committing to U5.**

### 9.4 The standardisation window is open now, and it closes

Core Specification 1.0 shipped 2025-12 and explicitly **does not define animation
semantics**. Core Specification 1.1, targeting **2026**, is stated to add
animation features and "scaling capabilities for massive and complex scenes," with
feedback routed through `forum.aousd.org` for the working group to fold into the
1.1+ roadmap; the AOUSD chair frames 1.0 as "the critical first step toward ISO
standardization"
([source](https://aousd.org/news/core-spec-announcement/), checked 2026-07-27).

Those are precisely this campaign's two topics — animation semantics, and scaling
to scenes too large to hold — and they are being specified **right now**, by a
group with no geospatial working group (§3.2) and no member who has built a
spatiotemporal tile pyramid.

This is a gate in the sense that it is time-bound, not in the sense that it blocks
work. It does not change the ordering in §8 — arriving with an argument and no
implementation is the failure mode §10 counts out — but it does mean the cost of
U1–U3 slipping is not just late delivery. Arguing _into_ an open specification and
arguing _against_ a ratified one are different activities, and only one of them
works. **Re-read this section whenever U1–U3 slip a quarter.**

## 10. Counted out, with revival triggers

- **Writing our own _Hydra_ render delegate.** Only if §9.1 resolves against us
  _and_ U1–U4 have shipped and demand it. A delegate is a large, ongoing surface
  and is not on the path to the contribution in §1. Note this is a narrower
  exclusion than it was: the nanousd route in §8.6 needs a USD-data→three
  translator, which is **not** a Hydra delegate and is not counted out — it is
  scoped inside U5.
- **A USD renderer built in deck.gl.** Counted out on the three grounds in §8.5b,
  the strongest being the record's own empty-niche test — USD rendering is
  heavily served, so building one here is a me-too port by the standard that
  justified the three backend. **Trigger:** deck gains a CPU-`Projection` /
  camera-ownership escape hatch (which would reverse a §1.2 structural entry, not
  a scope decision), _or_ 8.5a proves insufficient for a demand we can name. Note
  what is _not_ counted out: 8.5a itself, which is deck work and nearly built.
- **Materials / MaterialX.** Out of scope under §7. Trigger: a consumer needs
  material fidelity that the guest delegate does not already supply.
- **Splines (`Ts`).** Blocked on §3.3. Trigger: the USD Anim status page reports
  attribute value resolution via splines as implemented.
- **USD as an authoring surface** (any write path driven by user editing rather
  than by build output). No trigger — this is the §7 rule, and reversing it is a
  change of project identity, not a feature.
- **Fabric / USDRT interop.** Trigger: a concrete Omniverse deployment that needs
  live mutation rather than file interchange. Until then §6 says the file is the
  interchange.
- **Proposing a schema or a layered spec to AOUSD.** Trigger: U1 and U2 shipped
  and in use by at least one external consumer. Proposing a standard before having
  an implementation anyone uses is the failure mode to avoid — but see §9.4: this
  trigger is racing a 2026 specification cycle that covers exactly these topics,
  so "not yet" is a defensible answer and "not for a while" is not.

## 11. What this borrows back into STT proper

These stand on their own merits even if every track above is dropped, and each
belongs to the format record rather than to this one once acted on.

- **Per-feature velocity columns.** `PointInstancer` carries `velocities`,
  `angularVelocities` and `accelerations`, and the resolution rule is that _if
  velocities are authored, positions are not interpolated between samples at all_
  — because instance populations change between samples and interpolating arrays
  of different lengths is meaningless. That is exactly STT's varying-feature-set
  problem. Velocity extrapolation is population-independent, gives smooth motion
  without shrinking `temporal_bucket_ms`, and is therefore a byte win as well as a
  correctness one.
- **A time-varying visibility mask.** USD's `invisibleIds` expresses "present but
  hidden now" without duplicating geometry. STT has feature ids; it has no cheap
  masking channel.
- **Value blocks as explicit absence.** USD distinguishes "no value here" (`None`
  authored at a time) from "no sample authored." In STT a feature absent from a
  bucket is ambiguous between gone and not-sampled.
- **Advisory bounds, stated normatively.** USD specifies that `startTimeCode` /
  `endTimeCode` set the timeline range and explicitly **do not** restrict value
  resolution. That is the same shape as the `metadata.bounds` centroid-vs-vertex
  trap ([tile-loading-3d-2026-07.md](./tile-loading-3d-2026-07.md)): a metadata
  field that reads like a bound and is not one. USD made the advisory nature
  normative rather than leaving it inferred; the bounds fix riding B2 should do
  the same.
