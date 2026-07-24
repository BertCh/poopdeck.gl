# Renderer architecture — consolidated decision record

> The internal decision record for how STT renders: locked decisions, the
> measurements behind them, the negative results, the honest gaps, and the
> counted-out register with revival triggers. Merged from the renderer-abstraction,
> three-parity, three-SoTA, deck-parity-audit, kind-parity and maplibre-parity
> records, plus the renderer slice of the naming/types audit.
>
> **This file does not describe current behaviour.** Normative and user-facing
> content lives elsewhere and is never restated here: kernel API →
> [`render-kernel.md`](../api/render-kernel.md); `BackendDescriptor` /
> `SttRenderNode` / `Degradation` →
> [`backend-descriptor.md`](../api/backend-descriptor.md); backend guides →
> [`stt-three.md`](../api/stt-three.md) /
> [`stt-maplibre.md`](../api/stt-maplibre.md) /
> [`stt-cesium.md`](../api/stt-cesium.md); extensions →
> [`extensions.md`](../api/extensions.md); per-layer props → the
> `docs/api/animated-*-layer.md` pages; **the capability matrix →
> [`docs/spec/backend-capabilities.md`](../spec/backend-capabilities.md)
> (CI-generated; see §4)**; the frozen op-set contract →
> [`render-spec.json`](../spec/render-spec.json).

---

## 0. Backend tiering — the actual contribution

Four backends that look co-equal invite the question "why four?". Four **tiered**
backends are the point. Each tier answers a different question, and only one of
them is a product.

| Tier                   | Backend                 | What it is for                                                                                                                                                                                                 | Verified state                                                                                                                         |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Supported**          | `@poopdeck.gl/layers`   | The product. Every layer kind has an answer; the reference semantics every other backend is measured against.                                                                                                  | 21 of the 23 frozen `LayerKind`s implemented natively; `isoLines` declared → `path`, `ego` composed at the app layer. All 23 answered. |
| **Research**           | `@poopdeck.gl/three`    | WebGPU/TSL. Exists to do something deck cannot, not to duplicate it.                                                                                                                                           | 17/23 native. **Time-correct GPU id-picking on WebGPU across nine pick kinds / ten layer classes** (§0.1).                             |
| **Independence proof** | `@poopdeck.gl/maplibre` | Proves the format is not deck-shaped: a native `CustomLayerInterface` backend with **zero** deck/luma dependency, for the large population of apps that already have a maplibre map and will never adopt deck. | 15 native kinds. **Feature-complete as-is** — see the routing rule below.                                                              |
| **Cost proof**         | `@poopdeck.gl/cesium`   | Measures what a green-field backend costs once the kernel exists (§2.8).                                                                                                                                       | 6 native kinds, **~2,000 lines of `src`** total.                                                                                       |

**Routing rule for new layer kinds: deck first, three second, maplibre not at
all.** maplibre is declared done at fifteen kinds. Its value is thinness, and
each additional hand-written GLSL family taxes that without proving anything new
— the independence claim is already proven at fifteen. A new kind lands in deck
(where it is the product) and optionally in three (where it exercises TSL). This
is a scope decision, not a capability judgement: the maplibre backend can absorb
more kinds and deliberately will not.

### 0.1 What the three backend does that deck does not

deck.gl's WebGL2 pipeline gets picking for free; its WebGPU path does not — deck's
own WebGPU status documentation lists picking among the features not working on
that backend. _(External claim about another project; re-check the upstream page
before quoting it in a talk.)_ The three backend runs GPU id-buffer picking on
WebGPU **and** WebGL2, and does it time-correctly:

- `lib/id-pick.ts` owns a kind-agnostic mechanism. A layer becomes pickable by
  implementing `pick()`; `isIdPickable` is a **structural** test, so the r3f mount
  auto-registers it and a new kind never touches `r3f/index.tsx`.
- Each id-material variant reuses **the same vertex-stage time/filter gates as its
  colour material**. Picking therefore cannot disagree with what is on screen —
  an out-of-window or filtered-out feature is unpickable by construction rather
  than by a parallel CPU predicate that can drift.
- Verified in tree: nine `SttIdPickKind` values (`point`, `column`, `arc`, `line`,
  `trips`, `polygon`, `path`, `icon`, `iso`) across ten layer classes
  (`WideLineLayer` + its `PathGeoLayer` subclass, `OdLineLayer`, `PointCloudLayer`,
  `ColumnLayer`, `ArcLayer`, `IconLayer`, `IsoLayer`, `PolygonLayer`,
  `TripsLayer`).
- Declared deferral: the CPU **glide** path returns `null` from `pick()` rather
  than a wrong answer (icon glide, per-track trips glide). Honest null over
  plausible lie.

---

## 1. Thesis: one substrate, several rendering models

The shared seams that work are the **decoded-tile contract** (`@poopdeck.gl/core`:
`STTArchive` / `SpatiotemporalTileset` / `BinaryFeatures` / `Tile` + the frozen
wire format) and the **framework-neutral playback clock** (`@poopdeck.gl/playback`:
`TimeController` / `PlaybackGovernor` / `BufferSource` — every backend consumes it
identically, the working proof that a shared seam is viable). Everything above
that seam forks on structural axes baked into GPU buffers: the **rendering model**
(deck = `CompositeLayer` per `(tile, layer)` with `binary.positions` bound
zero-copy; three = retained scene merging all tiles into one `InstancedMesh` with
CPU-projected f32 RTC buffers; maplibre = `CustomLayerInterface` with a per-tile
VBO cache and hand-written GLSL; cesium = primitives in the host's WGS84 scene);
the **time base** (deck and maplibre relativize a per-tile `timeOffset` per draw,
three rebases everything to one scene-wide `timeOrigin`, f32-exact only for
seconds-scale spans); the **shading target** (TSL compiles only on
`WebGPURenderer`, which is _why_ three overlays rather than interleaves); and
**archive/camera ownership**.

The consistency problem was never that the backends are separate — it was that the
same _CPU decisions_ and _scalar shader math_ were hand-copied 3–4× and kept "in
lockstep" by comments + per-package parity tests, which **drifted in shipped
pixels** (`wakeTailScale` 0.15 vs 0.1; fade default 10%-soft vs hard-0; divergent
`colorMappingDefault`). The adopted fix — the **STT Render Kernel** — keeps the
rendering models exactly as they are and unifies only the CPU decisions, the
codegen'd scalar alpha, and the vocabulary, with **CI as the enforcer** instead of
"// keep in lockstep" comments.

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

- **The rendering models.** A neutral Geometry-IR would force deck to discard its
  zero-copy tesselator path — the reason the deck backend exists.
- **Shader/material source** beyond the codegen'd scalar alpha snippet — vertex
  geometry (billboard/arc-strip/column-prism/surfel-disk/ECEF) stays hand-written
  per language.
- **Buffer merge granularity + time base**; camera ownership + render loop;
  vertex-level projection execution (deck projects on GPU against a host viewport
  and can never take a CPU `Projection`); deck's GPU palette-texture fast path;
  `colorMappingDefault` **as a per-layer value** (deck point transparent, deck path
  grey `[120,120,120,255]`, three box its own — unifying to one value regresses
  deck's own path layer); pick mechanism (id-buffer vs ray vs host `scene.pick`);
  basemap integration mode; per-layer-archive vs shared tileset; maplibre's native
  paint/layout expression idiom.

#### Reversal: "maplibre stays a declared 5-of-19 subset" is dead

**This section previously listed catalog parity as un-unifiable and recorded
maplibre as an intentional 5-of-19 subset. That was wrong twice.** The vocabulary
has been **23** frozen `LayerKind`s, not 19, since the kind-parity work; and the
maplibre backend now ships **fifteen** native kinds (point, line, polygon, trips,
heatmap, icon, column, arc, tripHeads, h3Summary, quadbinSummary, hexbin,
flowCorridor, flowStroke, flowmap), all four time-filter modes, DataFilter on
every kind, metric sizing, id-FBO picking on every kind with feature identity,
native globe on v5+ hosts, a shared tileset source, and an `STTLayerGroup`
composite host. Verify against `packages/maplibre/src/backend-descriptor.ts`.

**Why the reversal was right.** The claim being defended was not "a thin backend
cannot render fifteen kinds" — it was "the shader source cannot be unified", and
that claim survives intact: every one of those kinds is hand-written GLSL, and the
summary + flow wave was the single largest render-code wave of the campaign
precisely because none of it could be shared. What the subset posture actually
encoded was a scope guess about demand, dressed as an architectural limit.
**"We chose not to" is a scope decision a campaign can reverse; "it cannot be
unified" is a structural fact a campaign cannot.** Only the second belongs in this
section. The scope decision has been re-made in the other direction and re-frozen
at fifteen (§0). The globe half of the reversal has a live defect attached (§4.2).

---

## 2. Locked decisions & negative results

### 2.1 WebGPU/TSL interleave trap → overlay basemap

TSL node materials compile **only** on Three's node renderer — the classic
`WebGLRenderer` cannot run them, and every basemap _interleave_ path in the
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

`globe.ts`: _"Sphere (not ellipsoid) is intentional for v1."_ Feeding sphere-ECEF
into a WGS84 frame (Cesium, 3D-tiles) mis-registers geometry — ~0.19° latitude ≈
**~20 km at mid-latitudes**, plus radial height error (the same class as the
shipped Google-3D-Tiles float-up bug). Fixed 2026-06-30: `GlobeProjection` gained
`datum: 'sphere' | 'wgs84'` (sphere byte-identical; WGS84 via Bowring) and the
descriptor records the datum. **3D-tiles overlay co-registration requires the globe
scene on `datum:'wgs84'`** — a one-time console warning fires on the sphere datum.
Radius is parameterizable (`metersPerWorldUnit`) because globe.gl-style worlds are
~100 units, not `EARTH_RADIUS` metres.

### 2.4 Precision = RTC; no in-shader fp64

Relative-To-Center per resident tile-group: the f64 origin lives in the
CPU-side `Object3D.position`, vertices are f32 _relative_ to it. TSL has no
double helpers, so there is no in-shader fp64 path. Time is likewise rebased —
the f32 guard `MAX_RELATIVE_TIME_MS = 16_777_216` (+ `assertRelTimeInRange`)
was hoisted from deck (previously the only backend with it) into
`core/time-filter`. The AV "rebased seconds stay exact" guarantee fails for
multi-day/-year ms spans under a single scene-wide `timeOrigin` — hence the
per-tile-group time origin item in §5 (only bites under real streaming).

fp64 shader emulation stays **counted out permanently**: deck's own history says
no, and RTC + f64 matrix composition in JS (JS numbers are doubles, so composing
modelView CPU-side lets the large terms cancel) wins on both accuracy and cost.

### 2.5 Merged-buffer pick identity → `InstanceProvenance`

three's merge of all tiles into one `InstancedMesh` destroys the
`{tileId, featureIndex}` identity that `SttPickResult.index` needs; at audit time
`GpuPicker` was exported but never instantiated (0 call sites) and the only wired
picker was CPU ray-OBB (boxes only). **The shared merge contract now includes a
per-instance provenance buffer** (`InstanceProvenance`, `core/picking`;
`buildPointBuffers` emits it, and it is the template every later id-pickable
builder copied). Until a merged backend emits provenance, `index` is optional and
it returns `worldPoint`-only picks.

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

**hard-0 fade default + `DEFAULT_WAKE_TAIL_SCALE = 0.15`**, single-sourced in
`core/time-filter`. three's three 0.1 sites moved to 0.15; maplibre's fade default
flipped soft→hard (soft only on explicit `softTimeWindow: true`). This changed
shipped maplibre pixels (loses the default soft edge) and the three wake tail —
part of the browser-verify backlog.

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

**Measured cost:** `packages/cesium/src` is ~2,000 lines total, with ~830 lines of
tests. That number is the whole point of the tier — it is what a fourth rendering
backend costs once the kernel exists, and it is why "add a backend" is not treated
as a strategic decision in this project.

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

**Honest ceiling (no proposal escapes it):** tiers 1–4 prove _scalar_ math and
_generated-GLSL numeric_ parity, but **cannot prove compiled-shader pixels**
(billboard sizing, depth, blend, the WGSL `select()`-in-`varying()` crash
class — which already shipped black screens). **Browser visual verification
stays a mandatory manual gate**, consistent with the project's visual-verify
preference.

Two limits of tier 3, load-bearing and easy to over-trust. **First: tier 3 is only
a `tsc` break _within_ a package.** `@poopdeck.gl/three` and
`@poopdeck.gl/maplibre` deliberately do not depend on `@poopdeck.gl/layers`, so
each redeclares the `LAYER_FEATURES` vocabulary locally; keeping the three lists
identical is a **review obligation, not a type one**, and the per-package gate only
asserts exhaustiveness against that package's own list. **Second: generated docs
that are not diff-gated re-rot exactly like hand-maintained ones.** Any codegen or
spec-table generation must ship with its `--check` CI gate in the same change or it
buys nothing — hence `gen-capabilities-doc.mjs --check` in the `typescript` job
(§4), and hence the CLI-flag documentation gate shipping as per-binary unit tests
that introspect the clap `Command` rather than as full clap→markdown codegen: the
gate delivers the anti-rot property without the churn, and caught 6 undocumented
flags on its first run.

### 2.10 Build-vs-buy for the three backend

The renderer is WebGPU/TSL + `moduleResolution: NodeNext`; that decides what can
plug in.

| Piece                          | Verdict                                                                                                                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@takram/three-atmosphere`     | **plugged in** — native `/webgpu` TSL path; opt-in, default OFF, WebGPU-only, wrapped so a runtime failure degrades to a plain render (can never crash a scene); sun tracks the playhead; takram's `Geodetic.toECEF` axes are identical to STT's `GlobeProjection` (no axis swap)                        |
| NASA-AMMOS `3d-tiles-renderer` | **plugged in** — renderer-agnostic meshes + `GlobeControls`; reuses the atmosphere module's `computeWorldToEcef` as single source of truth. Caveat: its shader-patching plugins (imagery overlay) are WebGL-only, colliding with our WebGPU-first posture — any native-imagery path must capability-gate |
| `geo-three`, `three-geo`       | reference only — GLSL `ShaderMaterial` won't compile on `WebGPURenderer`                                                                                                                                                                                                                                 |
| Giro3D / iTowns                | reference only — own renderer + loop, can't co-host; adopting either wholesale fights the render-kernel architecture                                                                                                                                                                                     |
| harp.gl                        | reference only — the only styled vector-geometry engine ever built on three, archived 2023; its text/label engine is the reference if we ever build GPU text                                                                                                                                             |
| threebox / three-globe         | ignore — pinned to three r132 / no LOD or precision model                                                                                                                                                                                                                                                |
| Spark (Gaussian splatting)     | deferred — WebGPU path exists, no demand yet                                                                                                                                                                                                                                                             |

Earlier foundational verdicts (all held): mercator projection = BUILD (~30 lines);
globe ellipsoid math = BUY-by-copy; basemap = BUY (maplibre overlay, §2.1);
camera/controls = BUY-by-copy (`GlobeControls`/`EnvironmentControls` take _our_
camera and don't own the loop); tile streaming = BUILD by wrapping core
`SpatiotemporalTileset` (framework streamers are welded to their WebGL renderers);
terrain = DEFER.

**Measured negative results from the same survey — do not re-litigate without new
numbers:** interleaved vertex buffers measured **~no fps win** with sharp edges
(trigger: a measured upload-bandwidth bottleneck); deck↔three interop does not
exist in any form; MapLibre-interleaved globe is **impossible** for a WebGPU
renderer inside a WebGL context, which independently re-derives §2.1 from the
opposite direction.

**Why the three backend is not a me-too port:** no open three.js project does
streamed, time-windowed, animated vector layers. harp.gl is archived; iTowns
renders MVT statically; 3DTilesRendererJS _rasterizes_ MVT/PMTiles into drape
textures; CesiumJS remains WebGL2-only. The niche is empty, which is the whole
argument for keeping a research tier at all.

### 2.11 Adversarial material verification — the standing template

The three geographic-layer wave verified 9 GPU materials against the deck originals
adversarially (not unit tests). 5 fully clean, **4 real bugs, all fixed**:
`PointCloudLayer` missing `setViewport` (pixel-radius mode ignored the r3f
viewport-push); Arc degenerate tangent → NaN at the t=1 tip; Column needed scene
lights → made self-lit; Icon atlas `flipY` unenforced. Attribute contracts + the
WGSL `select`-not-in-`varying` rule verified across all. **This is the template for
any future material port:** a pure unit-tested buffer builder + an adversarial GPU-
material pass + user browser-verify.

### 2.12 GpuPicker readback bug (negative result worth remembering)

When GPU picking was finally wired, it exposed a latent bug in the
never-instantiated `GpuPicker`: it passed its output buffer as the
`textureIndex` argument to the unified renderer's `readRenderTargetPixelsAsync`
(which _returns_ the pixels) — so **every GPU pick decoded index 0**. Also fixed: a
background-sentinel bug (black clear == feature 0) and a concurrent-render race.
`pickMechanism` is now `'gpu-id'`, and `SttPickInfo` became a discriminated union
(`SttBoxPickInfo | SttIdPickInfo`; consumers narrow on `kind`).
**Moral: "exported but 0 call sites" code is unverified code.**

### 2.13 The WebGL2 16-attribute floor is a real ceiling, and it fails silently

Three separate confirmed findings landed on the same wall. Recorded together
because the shape repeats and the failure mode is a **blank layer, not an error**.

**HIGH (real, latent) — trips `filterProperty` overflowed the WebGL2 16-attribute
floor → blank trips on 16-attr GPUs (Apple Silicon / Intel UHD / software WebGL).**
The DataFilter sweep appended `DataFilterExtension` to `AnimatedTripsLayer` WITHOUT
dropping the always-inert `CategoryColorExtension` (trips hardwires
`gpuPalette = null` and CPU-expands categorical color into `getColor`, but the
extension still declares `in float instanceCategoryIndex;` unconditionally → costs
a slot). Non-pickable trips was 12 (`NoPickingPathLayer`) + 3 (TimeFilter) + 1
(category) + 1 (filter) = **17** → fatal shader-link failure. The sibling
`AnimatedPathLayer` had already solved the identical conflict by dropping the idle
category extension when filtering; trips had not. **Fixed:** trips drops
`CategoryColorExtension` when `filterProperty` is set → net 16, no lost colour (it
was never colouring anything). Latent — no shipped demo wires trips+filter, so
nothing visible was broken; the capability now works on 16-attr GPUs.

Two adjacent budgets are pinned at the wall on purpose and must not be spent:

- The polygon **outline** sublayer sits at exactly 16: `NoPickingPathLayer` (12) +
  TimeFilterExtension (3) + `filterValue` (1).
- The **arc** fill sits at 15/16 with fp64 + categorical + filter all active —
  safe, **zero headroom** for a future per-instance attribute.

**The bug this prevents:** adding one per-instance attribute to a layer that
already carries TimeFilter + one extension does not degrade — it links-fails, and
the layer renders nothing on exactly the hardware most reviewers own. Any change
that adds an attribute must count the slots for the **non-pickable** variant of
every affected sublayer, and prefer trading an inert extension away over adding.

### 2.14 Two more confirmed review findings (silent-wrongness class)

**MEDIUM (real, latent) — path-reveal "persist" trail constant too small + misleading
comment.** `REVEAL_PERSIST_TRAIL_MS` was 4 years, fed as `trailLength`; the shader
culls any vertex older (in per-feature DATA time) than `currentTime - trailLength`,
so a single path feature whose own span exceeds 4 y sheds its oldest vertices —
"persist" erasing the line start. The repo's own drifters span **43 y**. **Fixed:**
bumped to 250 y (clears every shipped dataset) and the comment rewritten to be
honest — the bound is per-feature data-time, and multi-decade single features are
anyway outside `TimeFilterExtension`'s float32 ±2^24-ms envelope, so
reveal-persist's real target is short timeless-line datasets like flight/taxi
paths.

**LOW / integrity (shared point+icon) — glide + a categorical color COLUMN + no
`colorMapping` silently renders every marker TRANSPARENT.** The CPU glide path
resolves colour through the string-keyed `colorMapping`; with a colour column but
no mapping every track falls to the transparent `colorMappingDefault`
(`[0,0,0,0]`) — whereas the GPU window path auto-palettes it, so flipping
`interpolate` on silently blanks a working demo. **Fixed:** symmetric `warnOnce` on
both layers' glide config. No behaviour change — a loud warning replacing a silent
blank.

### 2.15 Glide gap policy: the teleport band is arithmetic, not taste

Per-entity motion interpolation ("glide") is an **opt-in CPU `renderLayers()`
path**, not a shader mode and not a GPU sibling extension. The architectural reason
is decisive: a shader cannot gather the two arbitrary rows (often in different
tiles) of the _same_ entity that bracket the playhead. It reuses the track kernel
(group-by-id, rebase to absolute epoch-ms so cross-tile samples share a timeline,
sort/dedup, binary-search + lerp, shortest-arc heading, singleton hold, fade),
hoisted to `@poopdeck.gl/core` when maplibre became its third consumer.

Locked grafts, each an integrity rule rather than a nicety: **`maxInterpolationGap`
holds the last sample** instead of fabricating straight-line motion through a data
hole; **degrees-aware angle lerp**, because `IconLayer.getAngle` is DEGREES while
`track-kernel.lerpAngle` is RADIANS (caught as a real bug during design, before
implementation); **never pair on `binary.featureIds`/`id`**, which are per-row
unique and would produce one singleton track per sample; and **group only on an
exact categorical id** — `flights` was ready with no rebuild (`icao24` is
`Dictionary(UInt16,Utf8)` → `categoricalProps`) while `ais-all-us` was not, because
`mmsi` exists only as a lossy quantized `UInt16` that **collides distinct
vessels**. The kernel is deliberately NOT extended to group on a numeric id, so the
quantization-collision trap is impossible by construction.

**The gap/window coupling (the shipped invariant).** To glide smoothly across a gap
of duration `G`, both bracketing samples must stay resident the whole way, which
needs `timeWindow >= 2·G` (the loader keeps tiles within ±`timeWindow`/2 of the
playhead). **The visible teleport band is exactly `(maxInterpolationGap,
timeWindow/2]`**, so the rule is to pin `maxInterpolationGap === timeWindow / 2`
and collapse it: every gap the window can bracket is glided, and anything longer
falls outside the window, so the entity fades out and back in rather than drawing a
line it never flew. `flights` ships `timeWindow: 1_200_000` ms (20 min) with
`maxInterpolationGap: 600_000` ms (10 min). _(An earlier pass set a flat 3-minute
gap; the window-coupled form supersedes it — a fixed gap unrelated to the window
re-opens the teleport band.)_ **The bug this prevents:** a too-tight hold produces
the "big zip" — freeze at the coverage-exit point, then jump to the re-entry point.

### 2.16 D10 — maplibre elevation reconciliation (BREAKING)

The maplibre backend used a flat `DEFAULT_ALTITUDE_SCALE = 1e-7` for
altitude→mercator-z. **Measured: that is 4.003× larger than the correct equatorial
value**, so every extrusion built on it stood ~4× too tall. Replaced with
latitude-correct `mercatorZFromAltitude(meters, latDeg)`, honouring the conformal-z
contract (a box with equal x/y/z mercator lengths renders as a cube, because the
same `1/(circumference·cos lat)` factor scales all three axes).

**BREAKING:** `STTPolygonLayer.altitudeScale` now defaults to `1` and means a
**dimensionless exaggeration**; the metres→mercator-z conversion is the projection
module's job, not the caller's. The old constant survives only as
`DEPRECATED_ALTITUDE_SCALE`, read by nothing, kept as the citable anchor for the
4.003 figure. **Reviewers: extrusions getting ~4× shorter is the fix, not a
regression.**

Measured granularity of the per-tile approximation (`altitudeScale` reaches the
shader as a uniform, so a layer converts once per draw at the tile's centre
latitude). Worst-case within-tile relative error is
`max(|cos(latEdge)/cos(latCentre) − 1|)`; its first-order form `≈ π·sin(lat)/2^z`
gives **~0.9% at z8** and **~0.2% at z10** — negligible wherever extrusion is
legible — but **~14% at z4/45°**, where per-vertex baking is the exact option.
That linearization collapses for an equator-straddling tile: at z0 the centre
latitude is 0, so the formula reads 0% while the true spread across that one tile
is `cos(85.0511°)` = **8.6%** of the centre value — **11.6× at the poleward edge**.
Use the exact form whenever an archive is tiled from z0/z1 and extrusion matters at
world view.

### 2.17 maplibre backend decisions that stay locked

- **D1 — stay native.** No deck/luma dependency. deck 9.3 interleaved attaches
  luma to the shared context and **monkey-patches every GL state setter** (taxing
  the basemap's own calls), plus per-pass push/pop, plus the map's own
  per-custom-layer `setDirty`; our hand-written layer pays only the last item.
  Users who want deck already have the deck backend. _(deck's `MapboxLayerGroup`
  bucketing is still the right **grouping** idea, and `STTLayerGroup` adopts it.)_
- **D3 — projection via the host's injected prelude on v5+.** Vertex shaders take
  `args.shaderData.vertexShaderPrelude` + `define` and call `projectTile` /
  `projectTileFor3D`, one cached program per `shaderData.variantName`; the ≤v4 /
  mapbox path keeps the `uMatrix` shader as the `'legacy'` variant, and the
  quantization stage is unchanged. **This one change unlocked v5, v6, and globe
  together.** Globe correctness rules that ride with it: subdivide long edges to
  the projection's granularity (chords get horizon-clipped), skip `wrap !== 0`
  tiles, and use `projectTileFor3D` for real 3D because `projectTile`
  **overwrites z** for horizon clipping.
- **D5 — mapbox is a secondary, mercator-first target; mapbox globe is
  DEFERRED.** Mapbox ships no injected prelude, so its globe means hand-rolling
  ECEF from the passed render params — contained but real, taken only on demand;
  mapbox users at globe zooms see the basemap's own globe→mercator transition
  cover most practical zooms. Also declined: terrain draping via `renderToTile` +
  `shouldRerenderTiles`, because animated layers would redrape every frame. Mapbox
  is proprietary — never vendor or fork it, token-gate any CI use, maplibre stays
  the documented and CI-tested target.
- **Lifecycle is not optional.** `setStyle` diff preserves custom layers only when
  the diff succeeds; a fallback rebuild destroys them silently, so idempotent
  re-add on `style.load`/`styledata` is mandatory. MapLibre explicitly states it
  **cannot restore custom layers after WebGL context loss** — we must invalidate
  and rebuild the tile GPU cache and programs. Read `fov` from the render args
  (v4.6+/v5+) rather than assuming 36.87° for any CPU matrix math.
- **Declared fallbacks, deliberate and conformance-tested:** `liveBundling` is a
  **permanent** fallback (`STTFlowmapLayer` draws static bundles; porting the GPU
  KDEEB bundler off luma transform-feedback is not worth it); `text → icon` (only
  when the caller supplies `iconAtlas` + `iconMapping`); `pointCloud → point`
  (flat billboards, per-point elevation lost). The proposal to implement real
  `boundingBox` + `pointCloud` was **not taken**.

---

## 3. deck.gl parity posture

Goal: `@poopdeck.gl/layers` is a **superset** of deck.gl's layer/prop/extension
surface wherever the pre-baked binary spatiotemporal tile model allows. The audit
against deck.gl 9.3.2 measured the catalog as already close: 15 layers audited, 6
with zero missing-portable gaps (Point, Path, Line, Trips, Splat, Heatmap), ~57
missing-portable props across the other 8 (dominated by the polygon/summary outline
family), 4 new layers to build (Text, Mesh, PointCloud, Hexbin), 0 base-prop
forwarding fixes needed. All of it shipped. Per-layer prop semantics live in the
`docs/api/animated-*-layer.md` pages.

### 3.1 The accessor-alias convention (the core intentional divergence)

Every deck `get*` JS-function accessor is replaced by the **accessor-alias
convention: a constant _or_ a baked-column-name; a JS function warns once and falls
back.** This is a design decision, not a defect — binary features never materialize
CPU rows for an accessor to run over. The per-backend accessor fork
(`getFillColor` on deck vs `colorProperty` on three/maplibre) is **counted out
permanently**: per-backend idiom stays, the capabilities table records the
vocabulary, and no alias layer ships unless a maplibre-idiom consumer demands one.

Other intentional divergences worth keeping visible: an Arc categorical column
drives a SINGLE unified arc colour (deck's independent per-endpoint interpolation
is not reproduced; constant colours still take the per-endpoint path); Trips
`trailLength` is in **milliseconds** (default 180000) vs deck's raw
`getTimestamps` units; `AnimatedPointLayer.strokeWidth` is retained as a legacy
constant-or-column prop despite deprecation.

### 3.2 Universally N/A under the pre-baked binary model

Not gaps, by construction. The whole **raw-data pipeline** (`data` → archive URL,
`dataComparator`, `_dataDiff`, `dataTransform`, `dataFormat`, `loaders`, `fetch`,
`numInstances`, `startIndices`, `onDataLoad` → the tile callbacks, `onError` →
`onTileError`); **`transitions`**, defeated by zero-copy binary attributes +
per-tile sublayer churn (animation comes from baked time columns +
`TimeFilterExtension`); **`colorFormat`**, dropped by deck's _own_ stock
`getSubLayerProps`; and **`loadOptions`**, repurposed at the base as
`SttLoadOptions` (only `loadOptions.fetch` is consumed, for archive HTTP) rather
than forwarded to sublayers.

### 3.3 Skip-list (reason + revival trigger)

| deck layer                             | Reason / trigger                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SolidPolygonLayer                      | Already the `polygon` kind's render engine.                                                                                                                                                                        |
| GeoJsonLayer                           | Multiplex-by-geometry is done at build time by the tiler; raw-GeoJSON input bypasses the binary model.                                                                                                             |
| GridCellLayer / GridLayer              | Square cells covered by QuadbinSummary (baked) + `AnimatedColumnLayer(diskResolution:4)`; no baked square-grid scheme.                                                                                             |
| ContourLayer                           | Contours baked at build time (marching-squares → line/polygon) → existing Path/Polygon layers; deck's runtime aggregation is what STT replaces.                                                                    |
| GreatCircleLayer                       | `@deprecated` upstream; `AnimatedArcLayer({greatCircle:true})` already is it.                                                                                                                                      |
| QuadkeyLayer                           | Already `QuadbinSummaryLayer`'s internal sublayer.                                                                                                                                                                 |
| GeohashLayer / A5Layer                 | No builder scheme, no data, no adoption; trivial Quadbin clones **if a dataset ever demands one**.                                                                                                                 |
| H3ClusterLayer                         | Needs a per-feature H3-index-array column STT lacks; bake the union region as a polygon instead.                                                                                                                   |
| BitmapLayer                            | STT tiles carry no raster payload — a format-level change, not a layer port.                                                                                                                                       |
| TileLayer / MVTLayer                   | `SpatioTemporalLayer` **is** the (temporal) tiler; MVT is a competing wire format STT supersedes.                                                                                                                  |
| Tile3DLayer / TerrainLayer / WMSLayer  | External backdrops consumed from stock deck.gl at the app layer; no STT column, no time axis.                                                                                                                      |
| ScenegraphLayer                        | Heavier PBR/rigged superset of the SimpleMeshLayer mapping; **revive as a renderer variant of the `mesh` kind**, not a second slug.                                                                                |
| S2SummaryLayer (deferred, not skipped) | Near-verbatim `QuadbinSummaryLayer` clone, **gated on a Rust `SummaryScheme::S2` builder that does not exist** — the enum has exactly `H3` and `Quadbin`, both implemented. Do it when an S2-native dataset lands. |
| AnimatedScreenGridLayer (deferred)     | Near-clone of the heatmap render path; adds pickable discrete cells + a blocky aesthetic — a nicety over an already-covered density need.                                                                          |

### 3.4 Extension posture

- **`DataFilterExtension` — FLAGSHIP port-adapt.** "Filter by any baked column":
  register a `filterValue` attribute from a tile column via the accessor-alias
  convention, exactly like `TimeFilterExtension` (a hand-built descendant of it);
  `filterRange`/`filterSoftRange`/`filterEnabled` stay constant uniforms. Passing
  deck's raw extension via `extensions` does **not** work — deck would source
  `getFilterValue` by running a JS accessor over binary features.
  `onFilteredItemsChange`/`countItems` are n/a (no CPU rows). `filterSize` is fixed
  at **1**; multi-column (2–4, `vec4` range, min-reduce) and fp64 remain deferred.
- **`CollisionFilterExtension`** — the constants case works via passthrough;
  data-driven `getCollisionPriority` from a baked priority column is deferred.
- **Already-have via passthrough (documented + tested):** `PathStyleExtension`,
  `BrushingExtension` (reads the layer's own baked position attributes; only
  `brushingTarget:'custom'` diverges), `MaskExtension` (`operation` is forwarded,
  so mask + `maskId` geofences an STT layer today), `ClipExtension`.
- **Skipped:** `FillStyleExtension` (decorative; per-feature needs a baked
  pattern-index column for little payoff); `_TerrainExtension` (experimental
  upstream, and the vertical axis is already claimed by `timeHeightScale`'s
  space-time-cube lift — draping and time-as-height fight over z); `Fp64Extension`
  (deprecated upstream; per-tile `timeOffset` relativization + deck's built-in fp64
  position split already cover it — adding it is counterproductive).

### 3.5 Latent bugs the parity work found in _shipped_ layers

The strongest argument for doing the superset exercise at all: the review caught
bugs outside its own scope. **HIGH — ANGLE/Metal crash:** data-driven
`getLineWidth` under-sized the instanced draw; the same latent bug existed in the
shipped `AnimatedPathLayer`. **CRITICAL — SimpleMeshLayer ignored per-instance
orientation/scale** bound as binary attributes; the same latent bug in the shipped
`AnimatedBoundingBoxLayer` meant boxes silently rendered identity (never rotated to
heading or scaled to dimensions). **CRITICAL — hexbin aggregator didn't re-bin on
`filterRange` change** → frozen time animation. All fixed; the first two are
shipped _pixel-behavior changes_.

### 3.6 Delivered per-layer feature matrix (deck)

The six prop families the kind-parity work added are finer than a whole layer kind
and don't map onto a cross-cutting `Capability`, so they carry their own frozen
`LAYER_FEATURES` vocabulary. Deck's declaration, proven by a conformance gate that
walks each layer's real merged `defaultProps`:

| feature               | prop              | deck kinds                              |
| --------------------- | ----------------- | --------------------------------------- |
| `motionInterpolation` | `interpolate`     | point, icon                             |
| `iconWake`            | `wakeLength`      | icon                                    |
| `dataFilter`          | `filterProperty`  | arc, line, trips, column, polygon, icon |
| `timeHeightScale`     | `timeHeightScale` | column, polygon                         |
| `stableColorMapping`  | `colorMapping`    | arc, line, column, icon                 |
| `pathReveal`          | `revealTrail`     | path                                    |

Both other backends declare the same six. three declares all six `supported: true`;
maplibre declares all six with **honestly narrower `kinds` sets** than deck's —
`motionInterpolation` on `{icon, tripHeads}` (not `point`), `timeHeightScale` on
`{column}` only, `pathReveal` on `{line}` because it has no separate `path` kind.
Naming a kind a backend does not render fails its gate, which is the entire point.

---

## 4. The capability matrix is a generated artifact — stop hand-counting

[`docs/spec/backend-capabilities.md`](../spec/backend-capabilities.md) is
**machine-generated end to end** by `scripts/gen-capabilities-doc.mjs` from the
four `BackendDescriptor`s, and `node scripts/gen-capabilities-doc.mjs --check`
runs in CI (the `typescript` job, right after the turbo build) as a **byte-exact**
comparison. A descriptor edit without a regeneration fails the build. Do not
hand-edit or re-align its tables — regenerate. _(It is listed in `.oxfmtrc.json`'s
`ignorePatterns` because oxfmt formats markdown and would re-align the tables into
a permanent standoff with the gate; keep that entry if the path ever moves.)_

**It is the authority. This document is not, and neither is any hand count.**

### 4.1 KNOWN ISSUE — native vs declared-with-fallback is not legible

Three separate auditors hand-counted the cesium backend's coverage and reported
**three different numbers (6, 8, and 12 of 23)**. None of them was lying; the
descriptor shape admits several defensible readings, and nothing in the rendered
table forces the reader to pick one. The tree-verified breakdown for cesium is:

- **6 native** (`point`, `path`, `line`, `arc`, `trips`, `tripHeads`),
- **9 declared with a `fallbackKind`** (`surfel`→point, `flowmap`/`flowCorridor`/
  `flowStroke`→line, `isoLines`→path, `text`→icon, `mesh`→boundingBox,
  `pointCloud`→point, `hexbin`→h3Summary),
- **8 bare deck referrals** with a reason and no fallback.

Any of "6", "15", or "23" is a true sentence about that data, which is exactly the
problem. **This is a reporting defect in the generated doc, not a backend defect.**
The fix is for the generator to render the three classes as distinct columns with
their counts, so a reader cannot construct a number by choosing a definition. Until
it does, quote the breakdown, never a single figure.

**A second-order consequence, already real:** three of cesium's nine declared
fallbacks name a target cesium does not itself render — `mesh → boundingBox`,
`text → icon`, `hexbin → h3Summary`. They were copied from the three descriptor,
where those targets ARE supported. `degradeRequest` therefore hands the caller a
second unrenderable answer instead of the honest "skip, go to deck" the `reason`
intends. maplibre's conformance suite has the gate that catches exactly this —
_"(c) every declared `fallbackKind` is itself a kind this backend renders"_ — and
cesium's suite does not. **Port gate (c) to the cesium and three suites, then fix
the three cesium entries.** (three's own fallbacks are all currently valid, so it
would pass today; the gate is there to keep it that way.)

### 4.2 KNOWN FALSE CLAIM — maplibre `globe: true` silently no-ops on the deployed site

`packages/maplibre/src/backend-descriptor.ts` declares `capabilities.globe: true`.
That claim is true **only on a maplibre-gl v5+ host**, because globe rides the
injected projection prelude (D3), which v5 introduced. The declaration carries no
host qualifier.

**The showcase pins `maplibre-gl: ^3.6.0` and resolves 3.6.2.** On v3 there is no
`setProjection`, and `MaplibreRenderer.tsx` calls it optionally
(`(map as any).setProjection?.({ type: projection })`) inside a try/catch, so the
globe toggle **silently does nothing** on the deployed site. The descriptor says
globe; the deployment cannot do globe; nothing fails.

**Fix:** bump the showcase to maplibre-gl **v5** — that is where globe landed and
where the prelude path the backend already implements is exercised. Do **not** jump
to v6: it shipped 2026-07-22, is ESM-only and WebGL2-only, and adopting it here
bundles a packaging migration into a defect fix. The layer code is already v6-ready
via runtime shape detection, so v6 can follow once the ecosystem settles.
_(`packages/maplibre` declares peer `^3 || ^4 || ^5 || ^6` and devDeps `^4.7.0`;
only the showcase pin is wrong.)_

**Structural fix, same defect:** capability resolution is not host-aware. The
`hostApiRange` idea was counted out "until maplibre v5/globe is actually
attempted" — that trigger has fired and `hostApiRange` still does not exist in the
tree. A boolean `globe` cannot express "true on v5+": either the descriptor gains a
host-range qualifier, or `globe` is declared `false` with the v5 capability
documented separately. **A capability that is true only on a host the deployment
does not run is an over-claim the over-claim gate cannot see** —
`assertDescriptorConsistent` checks claims against evidence inside the package, and
the package's tests run against a mock, not the app's resolved version.

---

## 5. Open work

### 5.1 Decision 6 — GPU-conformance CI (the one live decision; BLOCKED)

Is a WebGPU-capable CI runner available for the nightly `emitTSL` smoke-compile +
1px `TIME_FILTER_VECTORS` readback, or does the three gate fall back to
CPU-mirror-vs-oracle with manual browser verify as the only pixel gate?

**Still blocked.** Every job in `.github/workflows/ci.yml` runs on `ubuntu-latest`;
none is GPU-backed. The one browser job installs a headless browser to probe that
all showcase demos load — a liveness check, not a pixel gate. Everything in the
Phase-1 rewire queue is counted out until this is answered: rewiring deck's
`TimeFilterExtension` inject strings → `emitGLSL300(ALPHA_EXPR[mode])`, maplibre's
`TIME_WINDOW_GLSL` → `emitGLSL100`, three's TSL node → `emitTSL`, plus per-backend
headless conformance. The kernel already de-dupes the math via the CPU oracle, so
the rewire is **structural dedup with real pixel risk** (generated GLSL differs
textually and in FP association from hand-tuned source on all three backends) and
no automated pixel gate to catch regressions. Shader work therefore stays
oracle/JS-reference-based, and no campaign may couple itself to the rewire.

### 5.2 three backend — integration tail

_(Anchor `#52-three-backend--integration-tail` is linked from
`docs/api/stt-three.md:384`. Keep this heading text and number, or fix that link in
the same change.)_

- **`SttThreeGeoViewer` wiring: landed, verification open.** The component exists
  and `DemoPageImpl.tsx` ships the `deck | maplibre | three` selector. _(Earlier
  drafts listed the selector itself as unbuilt — stale.)_ What remains is the
  maplibre camera-sync basemap under the transparent three canvas.
- **3D-tiles integration:** `createStt3DTiles` + `createSttGlobeControls` are built
  and tested in isolation and are still zero-consumer exports — §2.12's moral
  applies.
- Folded into that wiring, not standalone tasks: **deck-exact zoom→distance pixel
  match** (`distanceForScale` is in place; a tuning task with no reference surface
  until the toggle is exercised) and the **per-tile-group time origin** (three
  rebases all resident tiles to one scene `timeOrigin` and `setTiles` is
  replace-all by design; only bites multi-day/multi-year spans in f32 ms under real
  streaming — `drifters` 1979–2022 is the proof dataset).
- **Browser-verify checklist** (no GPU/network in CI; user domain): streaming
  pan/zoom on a large dataset → tiles LOD-refine + evict; GPU pick/hover on a
  LiDAR cloud decodes the correct feature on WebGPU **and** WebGL2 with no
  background flash; atmosphere sun aligned to the globe, sphere-vs-wgs84 datum
  checked at the horizon, WebGL2 degrade confirmed; 3D tiles url / Google / Ion
  each fetch + render (Google needs a Map Tiles API key + `dracoDecoderPath`; Ion
  needs a token + assetId); geo viewer alignment on bixi (Montréal) and nyc-taxi.

### 5.3 Render-side verify tail

- **Polygon tile-seam overdraw — half-shipped, and a docstring now lies.** The
  ratified design was two-phase, sequenced render-first. **Phase 1's decode half
  shipped:** `extractGeometry` in `packages/core/src/tile.ts` surfaces per-ring
  sub-indices as `BinaryFeatures.ringIndices` (registered in
  `tile-transferables.ts` for zero-copy transfer). **Phase 1's render half did
  not:** `AnimatedPolygonLayer.buildOutlineSublayer` still feeds the outline
  `PathLayer` per-**feature** `startIndices` with `_pathType:'loop'`, so a holed or
  multi-ring polygon still draws the spurious bridge segment and leaves holes
  un-outlined — and its docstring still asserts the tile format "does not currently
  carry" per-ring sub-indices, which is now false. Closing this is render-side on
  already-built archives, zero rebuild. Closed-ring gotcha: drop the trailing
  duplicate vertex before `_pathType:'loop'`. **Phase 2** (an optional, additive
  per-vertex clip-edge-flag column from the Sutherland–Hodgman clipper, gated by a
  new `stt:has_clip_edges` metadata key, absent on seam-free tiles so they stay
  byte-identical) is unstarted and needs a rebuild. Cross-tile
  `SolidPolygonLayer` consolidation was **explicitly REJECTED**: clip is
  irreversible, tiles fetch and evict independently, and fills already abut —
  matching mapbox stencil / tippecanoe keep-clipped / deck MVTLayer never-reunion.
- **In-browser verification of shipped pixel-behavior changes** (GPU paths are
  untestable in jsdom): `AnimatedBoundingBoxLayer` boxes now actually rotate to
  heading and scale to dimensions (were silently identity); `AnimatedMeshLayer` /
  `AnimatedHexagonLayer` / `AnimatedTextLayer` first live drive-through; the
  flights aesthetic change (comet wake → smooth glide dots); any `timeHeightScale`
  surface, since `reducedMotion` is threaded to the point layer only and the
  polygon/column lift gate is unexercised by any demo.
- **Three capabilities exist with no demo instantiating them:**
  `AnimatedIconLayer` (wake + glide + stable `colorMapping` + DataFilter all
  shipped; the only in-tree reference outside the package is a docs manifest entry
  — ship-traffic and flights are both `type: 'point'`); `revealTrail` path reveal
  (needs a window-fix dataset rebuild); and the earthquakes DataFilter live slider
  (layer + full-domain `filterProperty: 'magnitude'` range are wired; the slider
  was deferred to avoid a 60 Hz-rebuild-risk UI change).

### 5.4 Counted-out register (each with its revival trigger)

**Layer catalog — the ratified adopt-or-cut pass.** A surveyor produced initial
verdicts; an adversarial challenger contested 5 of 7. The reconciled table below is
the ratified one. Its net effect: the challenger pushed the campaign **away** from
cosmetic and near-duplicate adopts and **toward** the two genuinely cheap wins that
were already wired.

| Orphan                      | Reconciled verdict            | Reason / trigger                                                                                                                                                                                 |
| --------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AnimatedHexagonLayer`      | **DEFER**                     | Near-duplicate of the shipped earthquakes points **and** extruded-column demos; nyc-taxi weights are pre-aggregated, not raw. Trigger: a genuinely different pickable-per-cell dataset.          |
| `AnimatedTextLayer`         | **DEFER**                     | Rests on an **unverified** string-column prerequisite and drags in CollisionFilter. Trigger: `describe_dataset` confirms a shipped archive with a string column.                                 |
| `AnimatedMeshLayer`         | **DEFER**                     | Re-skinning existing AV boxes is **zero new information** plus permanent bundle cost. Trigger: a non-AV moving-mesh dataset where shape carries meaning (ships over AIS, aircraft over flights). |
| `AnimatedLineLayer`         | **DEFER**                     | Flat clone of the arc hero over identical geometry. Trigger: a genuinely dense OD matrix lands.                                                                                                  |
| `type:'point-cloud'` branch | **Keep dormant — do NOT cut** | Cutting forces deleting a designed VizBadge glyph, and the AV composite cannot show a _bare_ cloud. Dormant costs ~nothing; adopt by pointing it at an existing standalone lidar sweep.          |
| `AnimatedPathLayer`         | **ADOPT (cheap)**             | A real catalog-reach gap, not an orphan: the `path` case is already wired and a window-fix rebuild gives it a hero cheaply.                                                                      |
| `DataFilterExtension`       | **ADOPT now**                 | Its trigger already existed — a point hero with a numeric column, wiring done (magnitude on earthquakes).                                                                                        |
| `CollisionFilterExtension`  | **DEFER**                     | Rides the Text demo.                                                                                                                                                                             |

**Architecture and engine.**

| Item                                                                                                                                                                                               | Trigger to revive                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RenderRegistry.mount` app-facing seam                                                                                                                                                             | A runtime backend-toggle product need appears (the direct-consumer path works today).                                                                                                                                                                                                                                                                                                                                                                                   |
| `hostApiRange` on descriptors                                                                                                                                                                      | **TRIGGER FIRED, NOT DONE** — v5/globe was attempted and shipped. See §4.2; this is now a defect, not a backlog item.                                                                                                                                                                                                                                                                                                                                                   |
| Bundle-size guard test (per-subpath `exports` + `sideEffects:false` proof)                                                                                                                         | The npm-publish packaging pass; resolve lockstep-vs-separate-package first.                                                                                                                                                                                                                                                                                                                                                                                             |
| Cross-package regenerate-and-diff meta-test for `backend-capabilities.md`                                                                                                                          | Superseded by the CI `--check` gate (§4). Only revive if a test home that may import all four backends is wanted for other reasons.                                                                                                                                                                                                                                                                                                                                     |
| Constructor-level capability assertions (`degrade()` only fires via the optional registry)                                                                                                         | Fold into whichever of registry/publish lands first.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| maplibre expression-alias vocabulary layer                                                                                                                                                         | A maplibre-idiom consumer demands one (the deck-shaped canon stands).                                                                                                                                                                                                                                                                                                                                                                                                   |
| maplibre catalog beyond fifteen kinds                                                                                                                                                              | **Routed away by policy** (§0), not by a trigger. New kinds go to deck, then three.                                                                                                                                                                                                                                                                                                                                                                                     |
| Cesium catalog beyond MOVEMENT (heatmap/summary/flow family)                                                                                                                                       | Demand-driven with typed fallbacks — a Cesium consumer asks for it.                                                                                                                                                                                                                                                                                                                                                                                                     |
| three `AnimatedHeatmapLayer` GPU aggregation                                                                                                                                                       | 1 demo; the descriptor declares the honest fallback. A TSL compute-aggregation experiment is the sanctioned shape if it revives.                                                                                                                                                                                                                                                                                                                                        |
| three `BundledFlowmapLayer` (`StaticBundle`/`preBundled` port)                                                                                                                                     | Showcase wiring surfaces a bundled demo on the three backend (`edge-bundler.ts` math reuses).                                                                                                                                                                                                                                                                                                                                                                           |
| Live KDEEB bundling (5-pass ping-pong float compute)                                                                                                                                               | Explicitly "later/never"; `liveBundling: false` is permanent on maplibre and three.                                                                                                                                                                                                                                                                                                                                                                                     |
| three `CategoryColorExtension` palette DataTexture                                                                                                                                                 | A demo needs better palette stability than CPU expansion.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SurfelLayer` globe port                                                                                                                                                                           | Stays ENU-only — deepest coupling (build-time quaternions in ENU metres).                                                                                                                                                                                                                                                                                                                                                                                               |
| Spark Gaussian splatting for the AV/point-cloud path                                                                                                                                               | Deferred; WebGPU path exists upstream.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Native in-engine TSL raster basemap (quadtree LOD, XYZ/WMTS)                                                                                                                                       | **DROPPED** in favour of maplibre camera-sync — reviving it takes a reversal of §2.1, not a trigger.                                                                                                                                                                                                                                                                                                                                                                    |
| Globe slippy-raster-tiles-on-WebGPU spike                                                                                                                                                          | Obsolete — `makeGlobeBasemap`'s earth-texture sphere covers the 4 globe demos; revisit only if slippy-on-globe becomes a want.                                                                                                                                                                                                                                                                                                                                          |
| Vector-tile basemap, labels/GPU text, draping/clamp-to-ground, antimeridian wrapping                                                                                                               | Deferred from the SoTA pass; product demand.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Wave 3 — native globe basemap + terrain** (`GeneratedSurfacePlugin` ellipsoid + XYZ/WMTS imagery, `QuantizedMeshPlugin`, `GlobeControls` as default rig, RenderBundles for the static substrate) | Trigger: a globe demo whose imagery needs exceed the earth-texture sphere. **Blocked on an upstream conflict:** 3DTilesRendererJS imagery compositing is WebGL-only, against our WebGPU-first posture — budget a minimal own drape pass if upstream stalls. Reversed-Z is a prerequisite with **conflicting upstream evidence** (r183 notes claim basic support; maintainer + tracking issue say WebGL-only) — resolve empirically before building on it, never assume. |
| **Wave 4 — remaining kinds + composite reach** (`hexbin`, `flowStroke`, lit `pointCloud`, SDF `text`, composite multi-archive demos on three)                                                      | Trigger: a demo that toggles to three and loses something a user notices. Not a scheduled plan.                                                                                                                                                                                                                                                                                                                                                                         |
| Pooled/incremental residency + upload throttling on three                                                                                                                                          | **HELD deliberately** — wants a measurement spike + steer, not a blind rewrite. `BatchedMesh` has documented per-member pathologies, so tiles-as-members only, never features-as-members; spike `BatchedMesh` vs a manual free-list per kind before committing.                                                                                                                                                                                                         |
| Worker buffer-build on three (projection + expansion off-thread)                                                                                                                                   | Touches core scheduler ownership — needs a short design doc + review before code.                                                                                                                                                                                                                                                                                                                                                                                       |
| `compileAsync` pipeline pre-warm                                                                                                                                                                   | Small, additive, browser-verified benefit; the last remaining item from the picking wave.                                                                                                                                                                                                                                                                                                                                                                               |
| Terrain vector draping                                                                                                                                                                             | Build-it-yourself territory (nothing adoptable exists). Trigger: the first demo that needs vectors ON terrain, not at height 0.                                                                                                                                                                                                                                                                                                                                         |
| Compute software-rasterized points (Schütz-style)                                                                                                                                                  | 10–100× on huge clouds, but WebGPU lacks 64-bit atomics (hi/lo workaround) at real cost. Trigger: a >50M-point demo that misses budget.                                                                                                                                                                                                                                                                                                                                 |
| Indirect compute dispatch                                                                                                                                                                          | Not exposed in three core; revisit when it lands.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `userExtensions` seam for three                                                                                                                                                                    | TSL materials have no injection contract. Trigger: a real external consumer asks.                                                                                                                                                                                                                                                                                                                                                                                       |
| OffscreenCanvas whole-renderer-in-worker                                                                                                                                                           | Wrong trade for a UI-heavy showcase.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Elevation metres→world-units reconciliation across backends                                                                                                                                        | maplibre is now correct (§2.16). What remains is reconciling deck true-metre vs three world-Z: `metersPerWorldUnit()` exists in `core/geo` — wire three through it plus a column-height golden vector with the next three pixel-verified change, not standalone.                                                                                                                                                                                                        |
| `AnimatedTripHeadsLayer` aligned picking via `instanceFeatureIndex`                                                                                                                                | Demand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `od-positions.ts` `deriveSourceTargetPositions` two-buffer-per-tile allocation                                                                                                                     | Cold path, already well-optimized — **revisit only under a measured dense-OD stall.**                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 6. Reusable gotchas & reference patterns

- **NodeNext extensionless-`.d.ts` shim.** `type: module` deps that ship
  extensionless `.d.ts` re-exports don't resolve under `moduleResolution: NodeNext`
  ("has no exported member") even though the runtime JS import is fine.
  `@takram/three-atmosphere` hit this; `3d-tiles-renderer` did not (explicit `.js`
  extensions). Fix: a local ambient `declare module` shim authored as a tracked
  **`.ts`** file — NOT `.d.ts`, because `.gitignore` excludes `src/**/*.d.ts` and
  `skipLibCheck` would hide errors inside a `.d.ts`. Pattern:
  `packages/three/src/types/takram-atmosphere.ts`.
- **Framework-free guard = a vitest test, not eslint.** The repo has NO eslint (no
  config, not even a dependency), so the "core stays framework-free" rule is
  `packages/core/test/kernel-framework-free.test.ts`, which scans `core/src` for
  renderer imports — matching the repo's real enforcement idiom
  (`manifest-schema.test.ts` / `palette-parity.test.ts`).
- **Explicitly-passed `undefined` shadows `defaultProps`.** Prop-plumbing sweeps
  must not spread optional props blindly, and any boolean that gates an
  accessibility behaviour (`reducedMotion`) must be resolved to a **concrete**
  boolean before it reaches a layer — otherwise the gate is bypassable by a
  spread.
- **Hot-path reference patterns** (survivors of the closed frontend hot-path audit
  — the models new layers should copy). **SplatLayer prepared-data caching**:
  caches by `tileKey + styleKey` and preserves object identity so deck.gl's
  `dataComparator: (a,b) => a===b` skips GPU re-uploads. **AnimatedPointLayer
  zero-copy elevation fallback**: returns `binary.positions` directly when there is
  no elevation override. **HeatmapLayer wall-clock flush gating**:
  `FILTER_UPDATE_HZ = 30` gates the `filterRange` state flush — the model for any
  per-frame layer.
- **`TrackIndexMaintainer` incremental index.** The glide path originally rebuilt
  the ENTIRE track index whenever the tile array changed identity
  (`buildTrackIndex` is O(all resident snapshots): 9 array-pushes per feature + a
  per-track sort + reorder). The flights demo plays a full day through a sliding
  window in ~60 s, so tiles churn constantly and that rebuild fired inside a render
  frame repeatedly — a reported **120→30 fps** burst. The maintainer diffs incoming
  vs absorbed tile keys: only ADDED tiles pooled, only REMOVED tiles dropped, **only
  affected tracks re-sorted**, per-frame buffers reused grow-only. Cost per churn:
  O(all snapshots) → O(changed tiles + affected tracks). `buildTrackIndex` was left
  unchanged so the box and mesh layers could not regress.

---

## Appendix: canonical concept map (deck ↔ three ↔ maplibre)

The parity-targeted renderers fork vocabulary for shared concepts. The per-ecosystem
_prefix_ schemes are **intentional idiom** and stay: deck `Animated*Layer`, three
bare `*Layer`, maplibre `STT*Layer`. This table is the canonical map (empty cell =
not ported to that renderer); it is referenced by
[`docs/api/stt-three.md`](../api/stt-three.md).

| concept                 | deck (`@poopdeck.gl/layers`)                                                                              | three (`@poopdeck.gl/three`)                                             | maplibre (`@poopdeck.gl/maplibre`)         | notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| points                  | `AnimatedPointLayer`                                                                                      | `PointCloudLayer`                                                        | `STTPointLayer`                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| trips / trails          | `AnimatedTripsLayer`                                                                                      | `TripsLayer`                                                             | `STTTripsLayer`                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| line / path             | `AnimatedPathLayer`, `AnimatedLineLayer`                                                                  | `PathGeoLayer` / `StaticPathLayer`, `OdLineLayer`                        | `STTLineLayer`                             | maplibre has no separate `path` kind — `pathReveal` lives on the line layer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| polygon                 | `AnimatedPolygonLayer`                                                                                    | `PolygonLayer` / `StaticPolygonLayer`                                    | `STTPolygonLayer`                          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| heatmap                 | `AnimatedHeatmapLayer`                                                                                    | _(deferred — declared fallback to `point`)_                              | `STTHeatmapLayer`                          | three's GPU-aggregation parity is counted out, not missing by accident.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| surface-splat primitive | `SplatLayer` / `SplatPrimitiveLayer`                                                                      | `SurfelLayer`                                                            | _(none)_                                   | **One primitive, two names** — three's `SurfelLayer` is "the Three analogue of deck's `SplatLayer`", reading the same `--surfel` columns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **time-filter window**  | `timeWindow` (**full** width, ms)                                                                         | `timeWindow` (**full**) **or** `windowHalf` (**half**)                   | `timeWindow` (**full** width, ms)          | **Bridged** by `resolveTimeWindow` (`packages/three/src/lib/time-window.ts`): every three layer ALSO accepts the deck/maplibre full-width `timeWindow` (→ `windowHalf = timeWindow / 2`). The three-native `windowHalf` stays a lower-level alias and **wins when both are set**. This alias is a HARD INVARIANT: dropping it, or halving incorrectly, silently gives existing three users a **2×-wider window** — the trap this bridge exists to close. `PointCloudLayer`'s historical `defaultWindowHalf` is 250 ms, so an unbridged `timeWindow: 86_400_000` copied from a deck demo would have collapsed to a 250 ms window. |
| fade-in / fade-out ramp | `fadeInDuration` / `fadeOutDuration`                                                                      | `fadeInDuration`/`fadeOutDuration` (parity) or native `fadeIn`/`fadeOut` | `fadeInDuration` / `fadeOutDuration`       | Same bridge, same precedence rule: the native name wins when both are set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| categorical color       | `fillColor` / `getFillColor` + keyed `colorMapping` + `colorMappingDefault` (+ positional `colorPalette`) | `colorProperty` + keyed `colorMapping` + `colorMappingDefault`           | `colorProperty` + **keyed `colorMapping`** | All three now express stable category→colour **by name**. _(This row previously said maplibre was positional-palette-only, which would mean a tile-local category reorder silently recolours — that was fixed and the row was stale.)_ The colour **accessor** still forks by design: deck `getFillColor` vs three/maplibre `colorProperty`, counted out permanently in §3.1.                                                                                                                                                                                                                                                    |
