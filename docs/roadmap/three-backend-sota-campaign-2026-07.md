# three.js backend SoTA campaign — 2026-07

**Status: IN EXECUTION (2026-07-23).** Drafted 2026-07-22 from a four-agent deep-research
pass: (1) working-tree gap audit of `packages/three` vs `packages/layers`, (2) three.js
geospatial-ecosystem survey, (3) TSL/WebGPURenderer deep dive, (4) large-scale
spatiotemporal rendering techniques. This doc is the synthesis of record; the full reports
live in the session transcript.

**Progress log.**
- **2026-07-23 — Wave 0 DONE** (agents, all integrated-green: three 340→ tests, core 535,
  layers 800): streaming-knob parity (`StreamingTileSource` now forwards debounce/prefetch/
  overviewPreload/summaryZoomRange/scrubLod; summary-tier auto-dispatch via an additive
  `makeTilesetCallbacks(archive, metadata)`; `setInteractive` scrub-LOD plumb; r3f pump
  couples the render `timeWindow` into tile selection). Descriptor/doc-truth (icon added to
  dataFilter degrade list, timeWindow-trap appendix marked resolved; `pickMechanism` drift
  was already fixed upstream by `eab4bd7`). three peer floor `>=0.171`→`>=0.183`.
- **2026-07-23 — Wave 1 substrate DONE** (§5 Wave 1 #1): fragment-`discard` time filtering
  replaced with **vertex-stage collapse** across 8 materials (point/icon/column/arc/
  wide-line/flow-corridor/polygon/iso-line; surfel already did it; flow-arrow has no time
  filter). New `timeFilterVisibleNode` + per-mode visible nodes, CPU mirror in lockstep;
  safe invariant is one-directional (`visible=0 ⟹ alpha=0`), fade look preserved.
- **2026-07-23 — Wave 1 COMPLETE: all six feature families `supported: true`**
  (three 483 tests green, dist rebuilt; core 535 / layers 800 green — deck unaffected;
  36 files, +3174/−185; 6 new src modules + 13 new test files). By family:
  `motionInterpolation` {point,icon} (GPU data-texture keyframes via `lib/track-keyframes.ts`
  + `tsl/motion-glide.ts`, `reducedMotion`-gated; ⚠ glide-picking returns null — deferred);
  `dataFilter` {arc,line,trips,column,polygon} (`tsl/data-filter.ts` + `sttFilterValue` attr;
  **icon pending** — the one kind still degrading); `timeHeightScale` {column,polygon}
  (`sttLift` per-instance/vertex; `capabilities.timeAsHeight` flipped `true` in lockstep);
  `iconWake` {icon} (reuses shared wake nodes); `pathReveal` {path} (reuses the pre-existing
  trail gate + synthesized arc-length reveal times); `stableColorMapping` {arc,line,column,icon}
  (`lib/palette.ts` deterministic label→slot + `tsl/palette.ts` GPU palette texture). Every
  family opt-in and byte-identical when off; animated ones (glide/wake/reveal) `reducedMotion`-gated.
  Also closed the last dataFilter gap — **icon** now filterable (static path; icon+glide filter a
  documented no-op) → dataFilter on all six deck kinds.
- **2026-07-23 — Wave 2 (additive slice): GPU picking catalog COMPLETE** (three 557 tests green,
  build clean, layers 800 unaffected; campaign total 40 files, +5337/−501, 7 new src modules +
  19 new test suites). Generalized GPU id-picking from point-only to a kind-agnostic mechanism
  (`lib/id-pick.ts`): layers **auto-register** via a structural `isIdPickable` test (a `pick()`
  method), so `r3f/index.tsx` needs no per-kind change; `PickController` runs one id-pass over all
  registrants. Pickable now: point, column, arc, line, od-line, trips, path, icon, polygon, iso —
  each id-material reuses the SAME vertex-stage gates as its colour material, so **picking is
  time/filter-correct** (glide-pick deferred → null, consistent). Merged-mesh (polygon/iso) via
  per-vertex id-colour keyed to per-feature provenance; `resolveIdPick` needed no extension.
  **Held (trigger-gated, §8):** pooled/incremental residency + upload throttling — want a
  measurement spike + steer, not a blind rewrite. **Remaining additive:** frame-budget
  `compileAsync` pipeline pre-warm (small, browser-verified benefit). See §5 for the wave plan.

**Relations.** [renderer-architecture.md](./renderer-architecture.md) holds the locked
decisions this plan builds ON (render-kernel thesis / no shared chassis, ECEF globe, RTC,
overlay-canvas basemap, codegen op-set = linear alpha only); nothing here re-opens them
except where explicitly flagged (§C-2 native globe basemap, which *extends* the overlay
decision rather than reversing it). Supersedes roadmap-README register item 3 ("three
backend integration tail") — that tail becomes Track C here. Extends the
[kind-parity campaign](./kind-parity-campaign-2026-07.md): its six feature families were
built deck-side; Track A ports them to three.

---

## 1. Why now

Three findings make this the right moment to close the deck↔three gap:

1. **The niche is confirmed white space.** No open three.js project does streamed,
   time-windowed animated vector layers. harp.gl — the only styled vector-geometry engine
   ever built on three — was archived in 2023; iTowns renders MVT statically;
   NASA-AMMOS 3DTilesRendererJS *rasterizes* MVT/PMTiles into drape textures (v0.4.25+);
   CesiumJS is only now planning `GeoJsonPrimitive`/`MVTDataProvider` and remains
   WebGL2-only ("WebGPU: longer-term explore"). A three backend at deck parity is a
   category-of-one artifact, not a me-too port.
2. **The WebGPU inflection point passed.** Safari 26 shipped WebGPU on by default
   (Sept 2025) completing all-major-browser coverage (~83% global, plus Chrome 146
   compatibility mode for GLES-class hardware). three.js r183–r185 delivered the missing
   platform pieces: `RenderPipeline` node post-processing (r183), shared bind-group
   hashing + 3× faster node-material compile (r184), UBO/GC churn fixes (r185).
   WebGPU-first with a WebGL2 tail is now a coverage strategy, not a bet.
3. **The convergent 2026 stack is two-thirds ours already.** The strongest open three.js
   geo stacks converge on: three r183+ (reversed-Z, TSL) + NASA-AMMOS 3DTilesRendererJS
   (globe surface, imagery, terrain, controls, shared tile scheduling) + takram
   three-geospatial (atmosphere/clouds, TSL rewrite complete for atmosphere) + custom TSL
   domain layers. We already ship takram atmosphere and have 3d-tiles modules built but
   unconsumed; the plan is *deeper adoption of what we already orbit*, not new deps.

Baseline packages: three dev/showcase pin `^0.184.0`, peer floor a stale `>=0.171.0`
(`packages/three/package.json:51,72`); current release r185 (2026-07-01).

## 2. Baseline — where `packages/three` actually stands (audited 2026-07-22)

### 2.1 Capability summary

- **Kinds:** deck native on 21/23, three on 17/23. Deck-only: `heatmap`, `flowStroke`,
  `text`, `mesh`, `pointCloud` (lit), `hexbin` (all declared with fallbacks in
  `packages/three/src/backend-descriptor.ts:42-85`). Three-only wins: `isoLines`, `ego`.
- **Feature families: 0/6.** Every 2026-07 kind-parity family — `dataFilter`,
  `motionInterpolation`, `stableColorMapping`, `pathReveal`, `iconWake`,
  `timeHeightScale` — is `supported:false` in `threeLayerFeatures`
  (`backend-descriptor.ts:156-198`). Demos that toggle deck→three silently lose flights
  glide, earthquake sliders, path reveal, GPU palettes.
- **Picking:** GPU id-pass exists only for `PointCloudLayer`
  (`layers/point-cloud-layer.ts:301-395`); CPU ray-OBB only for boxes. Paths, trips,
  arcs, columns, polygons, icons, summaries: unpickable (`r3f/index.tsx:677-723`).
- **Streaming knobs (cheapest gap):** core tileset already implements summary-tier auto
  dispatch, scrub-LOD, `tileLoadTimeWindow`, prefetch shaping — `StreamingTileSource`
  just doesn't forward them (`scene/streaming-tile-source.ts:218-235`), and the r3f pump
  never passes the render `timeWindow` into tile selection (`r3f/index.tsx:487`), so
  render-window > selection-window under-selects.
- **Governor:** real parity when streaming — `TilesetBufferSource` forwards runway/cost/
  fairness/run-ahead (`streaming-tile-source.ts:521-573`). Eager path uses a declared
  fake always-complete source (`r3f/index.tsx:401-408`).
- **Showcase reach:** 40/52 demos get the three toggle (`SttThreeGeoViewer.tsx:88-100`);
  excluded: heatmap, lightning, radar, weather, storm-4d composites. No hover/pick UX,
  no perf HUD, no camera feedback on the three branch.

### 2.2 Architectural strengths (keep; several exceed deck)

Pure Three-free buffer builders with a deliberate tested/untested seam (~2.5k LOC);
merge-per-layer single-draw-call model; honest `TilesetBufferSource`; one TSL graph
compiling to WGSL *and* GLSL with automatic WebGL2 fallback; high-limit device request
(>256 MB buffers); real ECEF globe + WGS84 datum + takram atmosphere; `resolveTimeWindow`
bridging deck's timeWindow vocabulary; CPU scalar mirror of shader alpha math.

### 2.3 Structural debts (the engine gaps this campaign exists for)

| debt | evidence | consequence |
|---|---|---|
| Replace-all residency rebuild | `streaming-tile-source.ts:13-15` — every tile change re-projects/re-expands ALL resident tiles | dominant hitch risk under pan/zoom streaming; deck uploads only the new tile |
| Fragment-`discard` time filtering | alpha-cutoff discard in ~12 TSL materials (`tsl/point-material.ts:67`, `arc-material.ts:67`, …) | out-of-window features keep full raster cost; deck's own DataFilter hit 3–4fps this way ([deck.gl #7509](https://github.com/visgl/deck.gl/issues/7509)); breaks early-Z |
| Scene-wide f32 time origin | `layers/layer.ts:12-19`, `MAX_RELATIVE_TIME_MS` | precision loss on multi-year archives (drifters 1979–2022, earthquakes 5y) — correctness, not perf |
| CPU per-frame track sampling | `TripHeadsLayer.sampleHeads`, `BoundingBoxLayer.sampleTracks`; full `buildTrackIndex` per `setTiles` (`bounding-box-layer.ts:186`) | deck already moved to incremental `TrackIndexMaintainer` (`track-kernel.ts:798`); three re-sorts everything on tile churn |
| No upload/parse budgeting | no compileAsync pre-warm, no staged uploads | pipeline-compile + upload hitches on first reveal and on churn |
| Zero GPU test gate | all 308 tests node-env; 12 TSL materials untested as shaders; 2.2k-LOC r3f binding untested | regression risk scales with every wave; GPU-CI (Decision 6) still blocked on dead Actions |
| Doc/descriptor drift | `docs/spec/backend-capabilities.md` stale (`cpu-ray` vs shipped `gpu-id`); `threeLayerFeatures.dataFilter.kinds` omits `icon`; renderer-architecture appendix still describes the fixed timeWindow 2×-trap | capabilities surface lies to integrators |

## 3. External SoTA — verdicts

**ADOPT** (dependency or direct pattern):

- **NASA-AMMOS 3DTilesRendererJS v0.5.0** (Apache-2.0, releases ~monthly): `GlobeControls`
  + `CameraTransitionManager` (best open globe controls); `GeneratedSurfacePlugin` (bare
  ellipsoid surface) + XYZ/TMS/WMTS/WMS imagery plugins; `QuantizedMeshPlugin` terrain;
  WGS84 `Ellipsoid` math; shared-by-default LRU/priority queues (v0.5.0) — the reference
  tile-scheduler shape (downloadQueue 25 / parseQueue few / byte-capped LRU with
  per-frame `unloadPercent`). Watch: shader-patching plugins (ImageOverlayPlugin) are
  WebGL-only — [#1380](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1380).
- **takram three-geospatial** (already shipped): TSL rewrite complete for atmosphere +
  core; WebGPU entry requires three ≥ r182; clouds port WIP — track.
- **TripsLayer pattern** (deck): timestamps baked as vertex attributes, ONE `currentTime`
  uniform, zero per-frame CPU writes — extended with **vertex-stage collapse** for the
  hard window cut (zero-size primitive, dies at assembly; fragment alpha only for the
  soft fade band).
- **Pooled per-kind buffers, tiles as sub-range leases**: BatchedMesh tiles-as-members
  (never features-as-members — 100k members is a documented pathology,
  [#28776](https://github.com/mrdoob/three.js/issues/28776); set
  `perObjectFrustumCulled=false`, `sortObjects=false`) or manual free-list +
  drawRange/multi-draw (proven at 1M-line scale).
- **Worker decode + transferables**: build attribute arrays off-thread, transfer
  zero-copy (deck binary-data path, Cesium standing architecture).
- **Frame-budget kit**: parse queue ~1 tile/frame, per-frame GPU upload budget,
  `renderer.compileAsync()` pre-warm (~70% fewer startup hitches), byte-capped LRU with
  amortized eviction (~5%/frame).
- **Precision**: RTC-per-tile + f64 matrix composition in JS (JS numbers are doubles —
  compose modelView CPU-side so large terms cancel); TSL `highpModelViewMatrix`;
  horizon culling on globe (~15% fewer tiles, ~a day); **reversed-Z when the WebGPU
  backend supports it** (status conflicted — see §7); skip fp64 emulation and log-depth
  as end states.
- **Point/line idioms**: instanced billboarded quads for points on BOTH backends (WebGPU
  points are 1px by spec; we already do this); `three/addons/lines/webgpu/Line2` or
  custom TSL segment extrusion; SDF edge AA + MSAA 4×, no post-AA on animated content.
- **Storage-buffer keyframes** (WebGPU) / data-texture keyframes (WebGL2) for GPU track
  interpolation — `instancedArray` (r171+), fixed-rate resample for O(1) lookup.
- **GPU id-picking everywhere**: on-demand id pass (same time-collapse shaders → picking
  is automatically time-correct), small readback region, async on WebGPU with sync WebGL
  fallback.
- **RenderBundles** (`BundleGroup static:true`) for the static substrate (basemap,
  terrain, static polygons) under animated layers.

**EXPERIMENT**: compute-culling → `IndirectStorageBufferAttribute` indirect draws
(r174+/r182; WebGPU-only; opaque-only today — threejs-blocks `ComputeBatchCulling`
proves feasibility); GPU heatmap via TSL compute aggregation (would close the deferred
kind); three-geojson-style ellipsoid polygon triangulation (vendor candidate, same
maintainer as 3DTilesRendererJS, not on npm).

**REFERENCE only**: CesiumJS (imagery layer stack, `TimeDynamicPointCloud` rate-aware
temporal prefetch, quantized-mesh + skirts), harp.gl (dead; text/label engine + worker
tessellation design), iTowns/giro3d (GIS-grade CRS + planar layering), MapGPU
(WebGPU-native GIS signal; PolyForm NC license), react-three-map.

**IGNORE**: geo-three (unmaintained), threebox (pinned r132), three-globe (no
LOD/precision model), deck↔three interop (none exists; keep parallel backends), fp64
shader emulation, OffscreenCanvas renderer-in-worker, interleaved buffers (measured ~no
win), MapLibre-interleaved globe (a WebGPU three renderer cannot share MapLibre's WebGL
context — validates our overlay/native-basemap posture).

## 4. Campaign tracks

- **Track A — Feature & interaction parity**: the six feature families, full-catalog GPU
  picking, missing kinds, streaming-knob forwarding. Closes "toggling to three loses
  things silently."
- **Track B — Engine SoTA**: vertex-collapse filtering, pooled incremental residency,
  GPU keyframe animation, worker decode, frame-budget kit, per-tile-group time origin,
  two-tier time culling + horizon culling. Closes "three hitches where deck doesn't."
- **Track C — Platform & ecosystem**: three ≥ r183 floor (target r185), reversed-Z
  adoption gate, 3DTilesRendererJS deep adoption (controls, native globe basemap/imagery,
  terrain), takram tracking, RenderBundles, compute-culling experiment. Closes "the
  ecosystem moved and we're not riding it."
- **Track D — Reach, observability & verification**: composite-demo wiring, hover/pick
  UX, GPU timestamp HUD, shader-dump tooling, spec-doc regen, test additions, GPU-CI
  posture. Closes "we can't see or prove any of it."

## 5. Execution waves

Wave order respects dependencies: 0 is free wins; 1 builds the shader substrate the
families need; 2 touches every buffer builder once (pooling + provenance together); 3
is globe/basemap; 4 is kinds + reach + verify. Each wave ends with suites green + dists
rebuilt (showcase consumes dist).

### Wave 0 — Free wins (S; adapter/config/doc only, no shader changes)

1. Forward streaming knobs in `StreamingTileSource`: summary-tier callbacks
   (`getSummaryTiles` into `makeTilesetCallbacks` — needs the small core adapter
   extension), `tileLoadTimeWindow`/render-window coupling (pass `viewport.timeWindow`
   from the r3f pump), `scrubLod`, `prefetchAhead`/`prefetchSteps`/`overviewPreload`,
   `debounceTime`.
2. Version hygiene: peer floor three `>=0.183`, dev/showcase `^0.185`; verify takram
   WebGPU floor (≥ r182) still satisfied.
3. Descriptor + doc truth: add `icon` to three `dataFilter.kinds` degrade declaration;
   regen `docs/spec/backend-capabilities.md`; fix renderer-architecture appendix
   (timeWindow trap is bridged by `resolveTimeWindow`).
4. Observability floor: `resolveTimestampsAsync(RENDER|COMPUTE)` behind a Safari guard
   feeding the showcase perf HUD on the three branch; debug command dumping
   `renderer.debug.getShaderAsync()` with `.toVar()`-labeled nodes.
5. Wire existing point picking into `SttThreeGeoViewer` (`onHover`/`onPick` already
   exposed by `SttCanvas`); label the eager fake buffer source honestly in code.

**DoD:** summary demos auto-dispatch tiers on three; scrub-LOD reachable; capabilities
doc truthful; HUD shows GPU ms on three.

### Wave 1 — Shader substrate + the six families (M–L; Track A core + B correctness)

1. **Shared TSL feature-time module** (one parameterized graph per layer kind, style via
   uniforms — never per-variant graphs): vertex-stage window collapse replacing
   alpha-cutoff discard for time filtering across all ~12 materials (keep discard only
   for SDF edge AA); soft-band fade stays fragment-side. CPU scalar mirror updated in
   lockstep (`tsl/time-filter-math.ts` contract).
2. **Per-tile-group time origin** (u32 rebase per group instead of scene-wide f32) —
   fixes multi-year-archive precision (roadmap §2.4 tail).
3. **dataFilter** family: `filterProperty/filterRange/filterSoftRange/filterEnabled` as
   per-instance attribute + uniforms in the shared module; wire the kinds deck declares
   (arc, line, trips, column, polygon, icon, point, path).
4. **timeHeightScale** (column, polygon): z-lift from time column in vertex stage; flip
   `timeAsHeight` capability.
5. **pathReveal** (path) + **iconWake** (icon): arc-length/timestamp machinery already
   half-present (points have wake); port deck semantics.
6. **stableColorMapping**: GPU palette lookup (uniformArray or small palette texture) +
   deck-identical positional auto-assignment stability.
7. **motionInterpolation** (point, icon): GPU keyframe glide — fixed-rate-resampled
   tracks in `instancedArray` storage (WebGPU) / data texture (WebGL2), interpolated in
   `positionNode` from the time uniform; port deck's incremental `TrackIndexMaintainer`
   keyed by tile for index maintenance; retire full-rebuild `buildTrackIndex` in boxes
   too.

**DoD:** `threeLayerFeatures` 6/6 `supported:true` for deck-matching kinds; descriptor
conformance green on both backends; flights (glide) and earthquakes (slider) toggle to
three with zero silent loss; drifters renders correctly (time-origin proof).

### Wave 2 — Engine core: residency, workers, picking catalog (L; Track B + A-picking)

Touch every buffer builder exactly once for three concerns:

1. **Pooled residency**: per-kind pooled mega-buffers, tile = sub-range lease with
   free-list return; incremental add/evict replaces the replace-all `setTiles` rebuild.
   Choose BatchedMesh-tiles-as-members vs manual pool per kind by spike (see risks).
2. **Provenance + id materials**: every builder emits `InstanceProvenance` (point
   builder is the template); id-pass material variant per kind; on-demand pick pass +
   async readback (WebGPU) / sync fallback (WebGL2); one coalesced pick per rAF stays.
3. **Worker buffer-build**: projection + expansion in a worker with transferable
   attribute arrays; main thread does upload only. Design doc first — it touches core
   scheduler ownership.
4. **Frame-budget kit**: parse/upload queues (≈1 tile parse/frame, N-MB upload budget),
   `compileAsync` pre-warm of the full material set at mount (few pipelines — a tile
   engine reuses one graph per kind × mode), amortized eviction aligned with the
   playhead-tier evictor.
5. **Culling**: whole-tile time-interval skip (visible=false when tile∩window=∅);
   horizon culling on globe; keep CPU per-tile frustum culling (never per-feature).

**DoD:** pan/zoom churn on a streaming demo shows no replace-all rebuild in profile
(measured hitch budget met); every visible kind hover/pickable in showcase; suites green
incl. new pool/lease + provenance unit tests.

### Wave 3 — Globe & basemap: ride the ecosystem (M–L; Track C)

1. **GlobeControls + CameraTransitionManager** as the default globe rig (our
   `createSttGlobeControls` adapter exists, zero consumers today).
2. **Native globe basemap**: `GeneratedSurfacePlugin` ellipsoid + XYZ/WMTS imagery
   plugins replacing the static earth-texture sphere; overlay-canvas basemap stays for
   mercator mode (locked decision untouched). WebGPU caveat: imagery compositing is
   WebGL-only upstream ([#1380](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1380))
   — ship behind capability detection; fall back to current textured sphere on WebGPU
   until upstream TSL port or our own drape pass.
3. **Terrain opt-in**: `QuantizedMeshPlugin` substrate; vector draping deferred (two-mode
   plan: height-sampled conformance for points/paths; TSL depth-projected decal for
   polygons — nothing adoptable exists, build-it-yourself, trigger below).
4. **Reversed-Z gate**: verify WebGPU-backend status on current release at wave start
   (see §7); adopt if landed; else measure log-depth vs status-quo for globe near/far.
5. **RenderBundles** for the static substrate (basemap/terrain/static polygons).
6. **3D-tiles showcase integration**: `SttTiles3D` (built + tested, zero consumers) gets
   a real demo (context tiles under an animated dataset).

**DoD:** globe demo with slippy imagery + inertial controls live in showcase; no jitter
at z15+ (RTC + f64 composition verified); atmosphere still gates by capability;
`SttTiles3D`/`createSttGlobeControls` no longer zero-consumer exports.

### Wave 4 — Kinds, composites, verification (M–L; Track A remainder + D)

1. **Cheap kinds**: `hexbin` (near-clone of h3 path), `flowStroke` (corridor variant),
   `pointCloud` lit variant. **Medium**: `text` (SDF glyph atlas — harp.gl reference),
   static `BundledFlowmapLayer` port (reuse `edge-bundler.ts`; live KDEEB stays
   deck-only). **Experiment**: GPU `heatmap` via TSL compute aggregation (WebGPU) —
   closes the last big showcase exclusion; CPU-aggregation fallback or keep point
   fallback on WebGL2. `mesh` stays fallback (trigger: a demo needs it).
2. **Composite reach**: wire multi-archive composites (weather, radar, lightning,
   storm-4d) through `renderGeoLayers`; per-demo cache scaling + overlay gating already
   reconcile via shared source ids.
3. **Perf baselines**: HUD A/B (deck vs three fps/GPU-ms per demo); record in the demo
   meta like the weather campaign did.
4. **Tests**: pool/lease, provenance, keyframe-resample, feature-family CPU mirrors;
   GPU-CI posture unchanged (Decision 6 still blocked on Actions — browser-verify
   remains the gate, so every wave ends with a user visual pass).

**DoD:** three native ≥21/23 kinds; showcase toggle ≥50/52 demos with no silent feature
loss; composite demos run on three; baseline table published.

## 6. Target end-state matrix

| axis | today | end of campaign |
|---|---|---|
| native kinds | 17/23 | ≥21/23 (mesh deferred w/ trigger; heatmap = compute experiment) |
| feature families | 0/6 | 6/6 (deck-matching kinds) |
| picking | points only | full catalog, time-correct GPU id-pick |
| streaming knobs | 4 forwarded | full parity incl. summary tiers + scrubLod |
| residency | replace-all rebuild | pooled sub-range leases, incremental |
| time filtering | fragment discard | vertex-stage collapse |
| per-frame CPU anim | trip-heads/boxes lerp + rebuild | GPU keyframes + incremental index |
| time precision | scene-wide f32 origin | per-tile-group origin (multi-year safe) |
| globe basemap | static earth texture | slippy imagery on ellipsoid + GlobeControls |
| showcase reach | 40/52, degraded silently | ≥50/52, no silent loss, HUD parity |

## 7. Risks & watch items

- **Reversed-Z on WebGPU — conflicting evidence.** r183 notes say "basic reversed depth
  buffer support"; the maintainer statement (Oct 2025) + tracking issue
  [#31998](https://github.com/mrdoob/three.js/issues/31998) say WebGL-only and
  incomplete. Resolve empirically at Wave 3 start; do not build on it before.
- **WebGPU async readback bugs** ([#31658](https://github.com/mrdoob/three.js/issues/31658),
  [#31654](https://github.com/mrdoob/three.js/issues/31654)) — picking keeps a WebGL-path
  fallback and a sync escape hatch; verify on current release.
- **3DTilesRendererJS ImageOverlayPlugin is WebGL-only** ([#1380]) — the native globe
  imagery path must capability-gate; our WebGPU-first posture collides with their
  WebGL-first plugins. Budget for a minimal own drape pass if upstream stalls.
- **BatchedMesh pathologies**: per-member CPU cost ([#28776]), `multiDraw*Instanced`
  regression ([#31935](https://github.com/mrdoob/three.js/issues/31935)) — spike
  BatchedMesh vs manual pool per kind before committing Wave 2; tiles-as-members only.
- **WebGPURenderer per-object overhead** ([#30560](https://github.com/mrdoob/three.js/issues/30560))
  — our merged/instanced discipline is the mitigation; never regress to per-feature
  objects.
- **Worker decode touches core ownership** (scheduler, decode pipeline are core's) —
  Wave 2 item 3 needs a short design doc + review before code.
- **takram is beta and mid-rewrite** (clouds TSL WIP) — pin exact versions, keep
  degrade-safe gating as today.
- **No GPU test gate until Actions revives** — every wave's DoD includes the user
  browser-verify pass; keep the CPU scalar mirrors in lockstep as the proxy.

## 8. Counted out (with revival triggers)

- **userExtensions seam for three** — TSL materials have no injection contract; trigger:
  a real external consumer asks.
- **OffscreenCanvas whole-renderer-in-worker** — wrong trade for a UI-heavy showcase.
- **fp64 shader emulation** — deck's own history says no; RTC + f64 CPU composition wins.
- **Interleaved buffers** — measured ~no fps win, sharp edges; trigger: measured upload
  bandwidth bottleneck.
- **Compute software-rasterized points** (Schütz-style) — 10–100× on huge clouds but
  WebGPU lacks 64-bit atomics (hi/lo workaround), big cost; trigger: a >50M-point demo
  that misses budget after Waves 1–2.
- **MapLibre-interleaved globe** — impossible for a WebGPU renderer in a WebGL context;
  the native basemap (Wave 3) is the answer.
- **Terrain vector draping** — build-it-yourself territory; trigger: first demo that
  needs vectors ON terrain (not at height 0).
- **Indirect compute dispatch** — not exposed in three core; revisit when it lands.
- **Adopting iTowns/giro3d wholesale** — fights the render-kernel architecture.

## 9. Principle compliance

No-thinning: everything here is lossless at the base tier (pooling, additive selection
discipline, quantized attributes carried through — never inflate to f32 on decode);
declared reduced tiers remain the only sanctioned LOD per the 2026-07-10 amendment.
Reduced-motion: any new showcase animated surface (globe imagery transitions, atmosphere
toggles) gates via `useReducedMotion()` as established.
