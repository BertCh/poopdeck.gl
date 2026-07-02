# Renderer abstraction: a consistent, extensible multi-backend render system (2026-06)

> **STATUS (2026-07-01): largely IMPLEMENTED, uncommitted, ~1254 tests green.**
> The render kernel is built and all four backends consume it. **DONE:** Phase 0
> (time-filter), 2 (color/OD), 3 (projection→core/geo + WGS84), 4a (tileset glue +
> pick scheme), 4b/4c (new picking scaffolds — three cloud + maplibre id-FBO;
> GPU parts browser-verify), 1 kernel + fade/wakeTailScale policy, 5 (capability
> contract + 4 descriptors + generated `backend-capabilities.md`), 6 **Cesium**
> backend (`@poopdeck.gl/cesium`; WebGL-three dropped) + a `/cesium/:datasetId`
> showcase demo. **REMAINING:** the Phase 1 STRUCTURAL shader rewiring (deliberately
> deferred — zero-behavior-change, browser-only), the optional `RenderRegistry`,
> full Cesium catalog parity (scaffold = `point` only), and a **browser-verify
> backlog** (Phase 2 colors, the fade-policy pixel changes, Cesium rendering, and
> both new GPU pick passes). Per-phase status is inline in §6.
>
> **TRIAGE 2026-07-01:** the §5.1 op-set contract is now a declared artifact —
> `docs/spec/render-spec.json` + `packages/core/test/render-spec-contract.test.ts`
> (walks the `ALPHA_EXPR` ASTs; widening the op-set/vars/modes without a spec
> edit fails CI). Every other remaining item is either **gated on Decision 6**
> (the GPU-conformance-CI call — which blocks the whole Phase-1 rewire and is the
> one decision worth making next) or **counted out** with its trigger recorded in
> §7. Decisions 1/2/3/4 of §7 are recorded as de-facto MADE by the
> implementation (full kernel; Cesium; fade policy in code; core sub-paths).
>
> Originally produced by a multi-agent audit of the three shipping backends.
> Companion to [`three-renderer-parity.md`](./three-renderer-parity.md) (Decision
> 5: *no 1:1 composite chassis*) and
> [`naming-types-consistency-2026-06.md`](./naming-types-consistency-2026-06.md)
> (which flagged the "MUST match by hand" drift with no enforcement).

## TL;DR

STT is **three fully-independent renderer backends over one shared substrate** —
and that independence is deliberate, not accidental. The shared seams that
already work are the **decoded-tile contract** (`@poopdeck.gl/core`:
`STTArchive` / `SpatiotemporalTileset` / `BinaryFeatures` / `Tile` + the frozen
wire format) and the **framework-neutral playback clock** (`@poopdeck.gl/playback`:
`TimeController` / `PlaybackGovernor` / `BufferSource`). Everything above that
seam forks on **four mutually-exclusive structural axes** baked into GPU buffers.

The problem is **not** that the backends are separate — it's that the same *CPU
decisions* and *scalar shader math* are hand-copied 3–4× and kept "in lockstep"
by comments + per-package parity tests, which has **already drifted in shipped
pixels**. The fix is to make **consistency automatic** (delete duplication into
core; codegen the scalar alpha; CI-gate the vocabulary + capabilities) while
**leaving the three rendering models exactly as they are**.

Recommended design: **"STT Render Kernel" — spec-in-core + codegen'd scalar
shader math + conformance-gated idiomatic adapters.** Ship the low-risk CPU
deletion tier now; gate the codegen/conformance/registry/new-backend investment
on resolving four honest gaps first.

---

## 1. Current-state architecture

### 1.1 The shared substrate (works today)

| Seam | Package | What every backend consumes |
|---|---|---|
| Data | `@poopdeck.gl/core` | `STTArchive`, `SpatiotemporalTileset` (selection engine incl. summary/overview/additive tiers), `decodeTile`→`BinaryFeatures`/`Layer`/`Tile`, `GeometryType`, `getFeatureProperties`, `DEFAULT_*_PALETTE`, `tileToLonLatBounds`. Wire format frozen. Deps: `apache-arrow`/`fflate`/`fzstd` only — **framework-free**. |
| Playback | `@poopdeck.gl/playback` | `TimeController`, `PlaybackGovernor`, `BufferSource`/`TilesetBufferSource`, `SttPlayer`. **All three backends already consume this identically** — the working proof a shared seam is viable. |
| React | `@poopdeck.gl/react` | `usePlayback`, `PlaybackControls`, `useDeckClock`, `HoverPreview`. |

### 1.2 The four fork axes (baked into buffers, mutually exclusive)

1. **Rendering model.** deck `SpatioTemporalLayer` = `CompositeLayer` emitting one
   deck core sublayer per `(tile, layer)` with `binary.positions` bound
   **zero-copy** (`packages/layers/src/layers/spatiotemporal-layer.ts`). three =
   retained scene merging **all tiles into one `InstancedMesh`** with CPU-projected
   f32 RTC buffers + one TSL material (`packages/three/src/layers/layer.ts`
   `SttLayer.setTiles/setTime/dispose`). maplibre = `CustomLayerInterface` with a
   **per-tile WebGL VBO cache** bound to hand-written GLSL, driven by
   `render(gl, matrix)` (`packages/maplibre/src/base-layer.ts`).
2. **Time base.** deck & maplibre keep per-tile `timeOffset` and relativize
   `currentTime` per draw; three rebases every feature to **one scene-wide
   `timeOrigin`** (`point-buffers.ts:144`), f32-exact **only** for seconds-scale
   spans (breaks multi-day/year ms).
3. **Shading target.** TSL node materials compile **only** on Three's
   `WebGPURenderer` (WebGL2 fallback); deck + maplibre are WebGL2/GLSL. This is
   *why* three owns its own scene/camera and pushes the basemap onto a **separate
   camera-synced overlay canvas** instead of interleaving.
4. **Archive/camera ownership.** maplibre gives **each layer its own
   archive+tileset**; deck shares one tileset per composite; three's `SttScene`
   owns projection+root but **explicitly not the camera**.

### 1.3 Capability matrix

| Capability | deck.gl | three (TSL) | maplibre | Unifiability |
|---|---|---|---|---|
| Layer contract | `CompositeLayer`→sublayers (props) | `SttLayer {setTiles,setTime,dispose}` (imperative) | `CustomLayerInterface` `render(gl,matrix)` (GL callback) | **must-stay-per-backend** |
| Tile loading | core `SpatiotemporalTileset` | own `StreamingTileSource`/`SttTileSource` (wraps core) | core tileset, **per-layer archive** | **contract-unifiable** (glue re-copied) |
| Projection & camera | GPU in deck-core; app owns camera | CPU pluggable `Projection` (ENU/mercator/globe-sphere); host owns camera | CPU→mercator **unit-square**; Map owns matrix | **partly** (view-state vocab is the only bridge) |
| Time base | per-tile `timeOffset` | merged `timeOrigin` | per-tile `timeOffset` | **partly** (rule shared, plumbing not) |
| Time-window alpha | GLSL inject; `wakeTailScale 0.15`; fade default **0** | CPU ref + TSL mirror; `wakeTailScale 0.1`; fade default 0 | GLSL ES 1.00 + JS ref; fade default **10%-soft**; no wake/cumulative | **contract-unifiable** ⚠️ *drifted* |
| Color resolution | `CategoryColorExtension` GPU + CPU path; default `[0,0,0,0]`/grey path | `lib/color.ts`→f32; per-layer non-transparent defaults | `base-layer.expandCategoricalColors`→u8; `toRgba01` auto-detect | **partly** ⚠️ *drifted* |
| Geometry building | deck tesselators (zero-copy) | ~15 `buildXxxBuffers` (merged RTC) | per-tile VBOs; **earcut fallback ignores pre-baked triangles** | **partly** |
| Picking | GPU id-buffer + `getPickingInfo` enrich, every family | CPU ray-OBB (boxes only); `GpuPicker` exists but **0 call sites** | **none** (`CustomLayerInterface` invisible to `queryRenderedFeatures`) | **partly** (result shape + id scheme shareable) |
| Extension mechanism | deck `LayerExtension` GLSL hooks | TSL node graph | hand GLSL strings | **must-stay-per-backend** |
| Catalog coverage | full ~19 families | ~19 (defers GPU heatmap + live bundling) | **5 only** (point/line/polygon/trips/heatmap) | **partly** |
| Playback wiring | `@poopdeck.gl/playback` | same | same | **fully-unifiable ✅ (already is)** |

### 1.4 Duplication hotspots (ranked by drift cost)

1. **Time-window alpha math — FOUR copies.** deck GLSL inject
   (`time-filter-extension.ts:337-443`), maplibre GLSL (`time-window.glsl.ts`) +
   a JS copy, three CPU ref (`tsl/time-filter-math.ts`) + TSL mirror
   (`tsl/time-filter.ts`). **Already drifted:** `wakeTailScale` 0.15 vs 0.1; fade
   default 10%-soft (maplibre) vs hard-0 (deck/three).
2. **Categorical/ramp color — QUADRUPLICATED.** `maplibre base-layer.ts:718`,
   `three lib/color.ts`, `deck animated-point-layer.ts:990`, + a 4th private copy
   `three box-tracks.ts:111`. `colorMappingDefault` diverges (transparent vs
   grey/blue) — a **live cross-backend parity bug**.
3. **Polygon tessellation.** three + deck honor pre-baked `binary.triangles`;
   maplibre's **earcut fallback** single-rings a concatenated multi-ring →
   spanning-triangle "holes" bug (only the fallback path; the pre-baked path at
   `maplibre polygon-layer.ts:396` already works).
4. **Mercator/ECEF/ENU projection math** — three reimplements what deck's
   viewport + maplibre's `lngLatToMercator` each compute (three incompatible
   output spaces, so no single helper serves all, but the CPU lib is duplicable
   across CPU-projecting backends).
5. **Pure per-feature reductions across packages** — `deriveSourceTargetPositions`
   (the *function* matches across `layers`/`three`, but the **files have diverged**:
   77 vs 213 LoC), `featureColor`, per-tile time rebasing.
6. **Tileset callback glue** — `streaming-tile-source.ts` re-wires the exact
   `getAvailableTiles/getTileData/getTileDataBatch/getTileByteSize/getThroughput`
   bundle deck's tileset wiring also provides. A `makeTilesetCallbacks(archive)`
   collapses both.
7. **Camera→viewport/zoom derivation** — three's `cameraToViewport`/`zoomFromCamera`
   reimplement metres-per-pixel↔zoom that deck's viewport yields for free.
8. **f32 time-precision guard** — `MAX_RELATIVE_TIME_MS = 16_777_216` + `warnOnce`
   lives **only in deck** (`time-filter-extension.ts:231`); three + maplibre
   silently quantize a too-wide span. The guard belongs in core.

### 1.5 The true "backend extension surface" today

To add a new backend right now you must implement **all** of: (1) consume core
archive/decode; (2) streaming glue (eager or wrap `SpatiotemporalTileset`) +
resident-set diff; (3) playback `BufferSource` + `setTime`; (4) projection into
your render space (no shared vertex-level projection exists) + f32 precision
strategy; (5) camera + `{longitude,latitude,zoom,pitch,bearing}` view-state
round-trip; (6) geometry emission per topology family **honoring pre-baked
triangles**; (7) time-filter shading (window/wake/cumulative/trail) math-matched
to the CPU reference + vocabulary resolution + the fade-default policy;
(8) color resolution matching `colorMappingDefault` + 0-255↔0-1 convention;
(9) picking with the 24-bit id scheme joined via `getFeatureProperties`;
(10) your own material/extension mechanism; (11) basemap integration
(interleaved vs overlay); (12) vocabulary aliasing. **Items 1–3 + 5 + part of 7
are the only ones with any shared code today.**

### 1.6 The consistency contract (invariants any backend must honor)

Wire format frozen (never rename columns; times absolute Int64 Unix-ms; coords
OGC:CRS84 f64 lon/lat); same z/x/y tile grid; **time-window alpha == the CPU
reference** for a given `(mode, windowHalf, fade, wakeTailScale, trail…,
currentTime, start, end, vertexTime)`, with full-width `timeWindow == 2× windowHalf`
and a **consistent fade-default policy** (currently violated); **color semantics**
(keyed → default → palette → transparent; same unmapped default across backends —
currently violated); **pre-baked triangles honored** (maplibre violates);
**pick result carries a feature index joinable via `getFeatureProperties`** + the
24-bit id packing; single playback clock; view-state is the camera lingua franca;
elevation/altitude interpreted with a documented shared scale (currently deck
true-metre vs three world-Z vs maplibre `1e-7`-crushed — a unit divergence).

---

## 2. What cannot be unified (and why)

These are **structural**, not laziness — the design must preserve them:

- **The three rendering models.** Composite-sublayer (deck, zero-copy) vs
  merged-InstancedMesh (three) vs per-tile-VBO (maplibre). A neutral Geometry-IR
  would force deck to discard its zero-copy tesselator path — the reason the deck
  backend exists. **Decision 5 holds.**
- **Shader/material source** beyond the codegen'd scalar alpha snippet — vertex
  geometry (billboard/arc-strip/column-prism/surfel-disk/ECEF-warp) stays
  hand-written per language. TSL compiles only on WebGPU; the WGSL
  `select()`-in-`varying()` trap already shipped black screens.
- **Buffer merge granularity + time base**, camera ownership + render loop,
  vertex-level projection execution (deck projects on GPU against a host
  viewport, can never take a CPU `Projection`), deck's GPU palette-texture fast
  path, `colorMappingDefault` **as a per-layer value** (deck point transparent,
  deck path grey `[120,120,120,255]`, three box its own — unifying to one value
  regresses deck's own path layer), pick mechanism (id-buffer vs ray), basemap
  integration mode, per-layer-archive vs shared-tileset, maplibre's native
  paint/layout expression idiom, full catalog parity (maplibre stays a declared
  5-of-19 subset with typed fallbacks).

---

## 3. Candidate designs + verdict

Four architectures were designed independently and scored by three judges
(maintainer/drift lens, extensibility lens, migration/risk lens):

| Design | Consistency | Extensibility | Migration | Risk | Verdict |
|---|---|---|---|---|---|
| **P4 Spec-in-core + idiomatic adapters** | high | high | **highest** | **highest** | **Winner (2/3 judges)** |
| P1 Thin-adapter + shared substrate + GeometryIR | high | **highest** | high | high | Won extensibility lens |
| P3 Capability registry + spec-codegen conformance | high | high | high | high | Co-runner-up |
| P2 Backend-neutral Draw-IR + mini-reconciler | **highest ceiling** | high | **lowest** | **lowest** | **Disqualified** — reverses Decision 5 (a declarative chassis is still a chassis; double-diffs deck's own reconciler) |

**Recommendation = P4 backbone + grafts:** P2's Expr-AST **codegen of the scalar
alpha** (the one thing that *eliminates* rather than test-catches shader copies),
P3's **`assertDescriptorConsistent` over-claim CI gate** + vocabulary codegen,
P1's **`makeTilesetCallbacks`** collapse + typed `Degradation` + `interleavedBasemap`
descriptor flag.

---

## 4. Recommended architecture — "STT Render Kernel"

**Thesis:** keep the three rendering models; unify only the CPU decisions and the
scalar shader math; make CI the enforcer instead of "// keep in lockstep" comments.

### 4.1 Three strata (zero new *runtime* packages — kernels land as `core` sub-paths, reusing the `DEFAULT_*_PALETTE` precedent)

**Layer 0 — data/playback substrate** (frozen, unchanged): `@poopdeck.gl/core` +
`@poopdeck.gl/playback` as today.

**Layer 1 — shared render-model & vocabulary contract** (NEW, framework-free,
`core` sub-paths + one dev-only conformance package):
- `core/time-filter` — **move** `three/tsl/time-filter-math.ts` verbatim (it is
  already the documented "unit-tested spec, verbatim deck port") + generalize
  `resolveTimeFilterParams` (three `resolveTimeWindow` + deck inline + maplibre
  `resolveFadeDurations`) + hoist `relativizeTime`/`MAX_RELATIVE_TIME_MS`/`assertRelTimeInRange` (currently deck-only).
- `core/shader-codegen` — `ALPHA_EXPR: Record<TimeFilterMode, Expr>` as one scalar
  AST; `evalExpr` = CPU oracle; `emitGLSL300`/`emitGLSL100` = pure string emitters
  (deck's inject strings + maplibre's `TIME_WINDOW_GLSL` become **output**);
  `emitTSL` lives in `@poopdeck.gl/three`, consuming the same `Expr`.
- `core/style` — one `expandCategoricalColors`/`expandRampColors`/`resolveCategoryColor`
  (`out: 'u8'|'f32'`); `colorMappingDefault` stays a **per-call arg**.
- `core/geometry` — `deriveSourceTargetPositions` (function extraction),
  `tessellateFeature(b,f,project,{preferPrebaked})`, `rebaseFeatureTimes`.
- `core/geo` — `Projection` interface + `LocalEnu`/`Mercator`/`Globe` + `projectPositions` RTC + `ViewState` round-trip (**moved** from `three/projection/*`).
- `core/picking` — `SttPickResult` shape + `encodePickId`/`decodePickId`/`MAX_PICK_ID`.
- `core/tileset-adapter` — `makeTilesetCallbacks(archive)`.
- `core/capabilities` — `BackendDescriptor` + `degradeMode` + optional `RenderRegistry` (app-facing mount seam, **not** a render chassis).
- `packages/conformance` (NEW, dev-only, unpublished) — `runConformance(adapter)`,
  `assertDescriptorConsistent`, `TIME_FILTER_VECTORS`, headless 1×1 readback
  harnesses. An eslint `no-restricted-imports` rule bans three/deck/maplibre/luma
  from `core` so the kernel stays framework-free.

**Layer 2 — per-backend adapters** (existing packages, slimmed to *call* kernels
+ emit *generated* shaders; each publishes a `BackendDescriptor` and satisfies a
tiny duck-typed `SttRenderNode` — never a shared base class).

### 4.2 The defining interfaces

```ts
// The ONLY shared runtime shape — duck-typed, NOT a base class.
interface SttRenderNode {
  readonly id: string;
  setTime(absoluteMs: number): void;
  setViewState?(v: ViewState): void;
  pick?(cssX: number, cssY: number, o?: {mode?:'hover'|'click'}): SttPickResult | null | Promise<SttPickResult|null>;
  dispose(): void;
}

// Declare-and-prove: CI fails if a descriptor claims a capability/kind/mode
// with no passing conformance case.
interface BackendDescriptor {
  readonly id: 'deck'|'three'|'maplibre'|string;
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly timeFilterModes: readonly TimeFilterMode[];
  readonly layerKinds: Readonly<Record<LayerKind, LayerKindSupport>>;
  readonly projectsOnCpu: boolean;
  readonly tilesetOwnership: 'per-layer'|'shared';
  readonly pickMechanism: 'gpu-id'|'cpu-ray'|'id-fbo'|'host'|'none';
  readonly interleavedBasemap: boolean;
  readonly basemapProjection: 'mercator'|'globe';   // (graft: critic gap)
  mount(spec: LayerSpec, ctx: MountContext): SttRenderNode;
  degrade(spec: LayerSpec): Degradation | null;
}
type Degradation =
  | { action: 'fallback'; toKind: LayerKind; lost: Capability[] }
  | { action: 'fallbackMode'; fromMode: TimeFilterMode; toMode: TimeFilterMode; lost: Capability[] } // (graft: critic gap)
  | { action: 'skip'; reason: string }
  | { action: 'throw'; reason: string };

// core/shader-codegen — author the scalar alpha ONCE, machine-emit each dialect.
type Expr = {op:'uniform'|'attr';name:string} | {op:'const';value:number}
  | {op:'add'|'sub'|'mul'|'div'|'min'|'max'|'step';a:Expr;b:Expr}
  | {op:'clamp01';a:Expr} | {op:'select';c:Expr;t:Expr;f:Expr};
const ALPHA_EXPR: Record<TimeFilterMode, Expr>;   // LINEAR modes only — see §5.1
function evalExpr(e: Expr, env: Record<string,number>): number;   // CPU oracle
function emitGLSL300(e: Expr): string;            // deck inject output
function emitGLSL100(e: Expr): string;            // maplibre output
```

### 4.3 Consistency enforcement (five tiers, each with an in-repo precedent)

1. **Deletion** for pure CPU logic — one function in core; drift impossible
   (exactly the `DEFAULT_*_PALETTE` move, guarded by `palette-parity.test.ts`).
2. **Codegen** for scalar GPU alpha — one `ALPHA_EXPR`; `evalExpr` oracle;
   `emitGLSL300`/`emitGLSL100`/`emitTSL` are machine translations. Op-set frozen
   small; adding an op is gated on all emitters compiling.
3. **Vocabulary codegen + tsc** — `LayerKind`/`Capability`/`TimeFilterMode` unions
   generated from `spec/render-spec.json`; renaming a token is a compile break
   everywhere (the `palette-parity` rename-fails-tsc trick, applied to the whole
   vocabulary; `gen --check` golden guard modeled on `manifest-schema.test.ts`).
4. **Conformance vectors** — `TIME_FILTER_VECTORS` (from the oracle,
   combinatorially over modes × boundary params) pushed through each backend's
   **real compiled shader** in a headless 1×1 readback, asserted equal within 1/255.
5. **Over-claim + doc gates** — `assertDescriptorConsistent` fails CI if a
   descriptor claims a capability/kind/mode with no passing case; `docs/spec/backend-capabilities.md` regenerated from descriptors + drift-guarded.

**Honest ceiling (no proposal escapes it):** tiers 1–4 prove *scalar* math and
*generated-GLSL numeric* parity, but **cannot** prove compiled-shader **pixels**
(billboard sizing, depth, blend, the WGSL `select()`-in-`varying()` crash class).
**Browser visual verification stays a mandatory manual gate** (consistent with
the visual-verify preference), and `emitTSL` output is smoke-*compiled* nightly
wherever a WebGPU adapter exists.

---

## 5. Honest gaps (verified against code) — scope corrections

The adversarial critic found real holes; three of the highest-impact are
**confirmed against source** and materially change scope:

### 5.1 The codegen op-set cannot express the modes that most need it — CONFIRMED
`surfel-material.ts:149` computes the temporal weight `exp(dt·dt·-0.5)`, `:181`
the radial falloff `exp(-falloff·r²)`, `:89` uses `sqrt`. `exp/pow/sqrt/smoothstep`
are **not** in the proposed op-set. **Decision:** `ALPHA_EXPR` covers **linear
alpha only (window/wake/cumulative/trail)**; surfel/splat Gaussian temporal
weight + `wakeSizeScale` **vertex-stage** math are **explicitly excluded from
codegen** and stay per-backend, pinned to the CPU oracle by parity tests (as
today). This must be stated in `spec/render-spec.json`, not discovered later.

### 5.2 `GlobeProjection` is a sphere, not WGS84 ellipsoid — CONFIRMED
`globe.ts:20`: *"Sphere (not ellipsoid) is intentional for v1."* The "Cesium
reuses `GlobeProjection` unchanged" worked example is **wrong** — feeding
sphere-ECEF into Cesium's WGS84 frame mis-registers geometry (~0.19° latitude →
~20 km at mid-latitudes, plus radial height error — the same class as the shipped
Google-3D-Tiles float-up bug). **A WGS84 ellipsoid variant must land before any
globe-host (Cesium/globe.gl) reuse claim**, and the descriptor must record the datum.

### 5.3 three's merged buffer destroys the pick identity `SttPickResult.index` needs — CONFIRMED
three merges all tiles into one `InstancedMesh` and its only wired picker is CPU
ray-OBB (boxes only); `GpuPicker` is **exported but never instantiated** (0 call
sites). There is no per-instance `{tileId, featureIndex}` provenance after the
merge. **The shared merge contract must include a per-instance provenance buffer**
before `SttPickResult.index` is satisfiable for any merged-buffer backend;
until then, `index` is optional and merged backends return `worldPoint`-only picks.

### 5.4 "`@poopdeck.gl/three`" secretly means "three-on-WebGPU-via-TSL"
`emitTSL` is useless to the entire **WebGL-three** ecosystem (three-globe /
globe.gl / threebox / react-three-map non-overlay), which would need `emitGLSL300`
+ its own scene model. **Reframe the backend axis as `(rendering-model ×
shading-language)`**, not per-library. `emitGLSL300` is the WebGL-three/Babylon-GLSL
path; `emitTSL` serves WebGPU-three only. (Also: `GlobeProjection` radius must be
parameterizable — globe.gl's world is ~100 units, not `EARTH_RADIUS` metres.)

### 5.5 Other confirmed corrections folded in
- Degradation needs a **`fallbackMode`** axis (maplibre lacks wake/cumulative).
- `degrade()` only fires via the **optional** registry → push a capability
  assertion into the idiomatic constructors too, else direct consumers still get
  silent no-ops.
- **Phase 1 changes compiled shaders on all three backends** (generated GLSL/TSL
  differs textually + in FP association from hand-tuned source), not just maplibre
  → full visual re-verify + a golden-string snapshot of emitted GLSL.
- **Phase 4 picking is net-new feature work** (three cloud picking + maplibre
  id-FBO both don't exist), not a refactor → split from the id-scheme hoist.
- **Elevation scale** (`maplibre DEFAULT_ALTITUDE_SCALE = 1e-7`) is flagged as an
  invariant but never reconciled — needs an explicit `metres→world-units` resolver
  in `core/geo` + a column-height golden vector.
- `ViewState` needs optional **roll + altitude/height** for Cesium's 3-DOF camera
  + documented up-axis/handedness (three Z-up RH, Babylon Y-up LH); maplibre
  **v5/globe + mapbox** are unhandled (`base-layer.ts:450` already documents the
  v3/v4-only `render(gl,matrix)` break) → descriptor needs `hostApiRange`.
- **Tree-shakeability**: `core` sub-paths need per-subpath `exports` +
  `sideEffects:false` + a bundle-size test so decode-only/SSR consumers don't pull
  in projection/codegen/picking. Phase 5 makes the lockstep-vs-independent-release
  question irreversible — **resolve it first**.

---

## 6. Migration plan

**Non-negotiable split: ship Tier-1 now; gate Tier-2 on the §5 resolutions.**

### Tier 1 — safe, incremental, high-value (do now; each phase independently shippable)

- **Phase 0 — pure move + re-export (zero behavior change). ✅ DONE 2026-06-30.**
  Moved `time-filter-math.ts` → `@poopdeck.gl/core/time-filter` sub-path
  (`core/src/render/time-filter.ts`); `three/tsl/time-filter-math.ts` is now a
  re-export shim (all relative importers + the unit test stay byte-identical).
  Hoisted deck's `relativizeTime`/`MAX_RELATIVE_TIME_MS` to core (deck
  re-exports; `layers` barrel unchanged); added `assertRelTimeInRange` (shared
  f32 guard, dormant until three/maplibre adopt it in Phase 1/4a) +
  `resolveTimeFilterParams` (three's `resolveTimeWindow` now delegates,
  byte-identical). Added the `./time-filter` export to core's `exports` map.
  **Plan correction:** the repo has NO eslint (no config, not even a dependency —
  the `lint` scripts are inert), so the "core stays framework-free" guard is a
  **vitest test** (`core/test/kernel-framework-free.test.ts`) that scans
  `core/src` for renderer imports — matching the repo's real enforcement idiom
  (`manifest-schema.test.ts` / `palette-parity.test.ts`). Verified green: core
  243, layers 426, three 217, maplibre, playback 135, react 34; typecheck 4/4.
- **Phase 2 — color + OD dedup (gated to protect shipped R2 demos). SCOPED, ready
  to execute.** Add `core/style`; delete the 4 copies; keep `colorMappingDefault` a
  **per-layer explicit prop**; **extract** `deriveSourceTargetPositions` as a
  function. Add color golden fixtures. Ends in a browser-verify color gate (user).

  The 4 copies, fully mapped, with the **traps** the unified `core/style` must
  preserve exactly:
  - `three/src/lib/color.ts` — `resolveCategoryColor(label, mapping, fallback)`,
    `expandCategoricalColors(binary, spec)` → **Float32 0..1**; when the prop is
    **absent it fills `fallback` for every feature**; also `expandRgbColumns`,
    `rampColorAt`, `expandRampColors`. NULL index `0xffff`.
  - `maplibre/src/base-layer.ts:718` — `expandCategoricalColors(binary, prop,
    palette, colorMapping?, colorMappingDefault?)` → **Uint8**; keyed-OR-positional-
    palette chain (keyed → default → palette → `[0,0,0,0]`); **returns `null`** when
    the prop is absent. `toRgba01` 0-255↔0-1 auto-detect stays maplibre-side.
  - `layers/src/layers/core/animated-point-layer.ts:478` — `expandMappedColors(
    indices, categories, count, mapping, fallback)` → **Uint8**, **keyed-only**;
    only *called* when the prop is present; the palette path is the **separate GPU
    `CategoryColorExtension`** (`instanceCategoryIndex` + palette texture) which
    **must NOT be unified**. Plus an inline numeric-column stringify branch.
  - `three/src/layers/box-tracks.ts:111` — `resolveColor(category, mapping,
    fallback)`; treats `''` (idx `0xffff`/missing) as fallback.

  Proposed unified surface: `resolveCategoryColor(label: string|undefined, mapping,
  fallback)` + `expandCategoricalColors(binary, spec, out: 'u8'|'f32')` where
  `spec = { property; colorMapping?; palette?; colorMappingDefault }` and the
  **absent-property return is a spec flag** (`null` vs fill-fallback) so both the
  maplibre and three call sites keep their exact behavior; `expandRampColors` +
  `rampColorAt` move too (deck has no ramp-CPU path — three-only consumer). OD:
  move `deriveSourceTargetPositions` + `SourceTargetPositions` to `core/geometry`
  (byte-identical in both packages — verified); three keeps
  `buildOdLineSegmentBuffers`/`featureColor`/`collectOdLayers` (they use three's
  `Projection`/`RGBA`).

  **✅ DONE 2026-06-30.** `@poopdeck.gl/core/style` + `/geometry` created (+ golden
  tests: style 17, geometry 3). All 4 color copies now single-sourced:
  maplibre `expandCategoricalColors` delegates (u8, `onMissing:'null'` +
  `requireMappingOrPalette`); deck deleted `expandMappedColors`, its keyed CPU
  branch delegates (GPU `CategoryColorExtension` untouched); three `color.ts`
  delegates (f32, `onMissing:'fill'`; kept local `expandRgbColumns` — its 0..1
  alpha semantics differ); `box-tracks.resolveColor` delegates. `deriveSourceTarget
  Positions` extracted (three re-exports; keeps its OD segment builders).
  `colorMappingDefault` stays a per-call arg. Rewired by 3 parallel agents (one
  per package). Verified: **1146 tests green** across all libs; tsc clean. Behavior
  byte-identical (deck length-3 `Color` → same `c[3] ?? 255`). **Browser color-
  verify is the user's gate** (correctness locked by golden tests + byte-identity).
- **Phase 3 — projection move + the real holes fix.**
  - **3a ✅ DONE 2026-06-30.** Moved `three/projection/{local-enu,mercator,globe}.ts`
    → `@poopdeck.gl/core/geo` (three files now re-export shims; 26 importers
    unchanged). `view-state.ts` split — `ViewState` + pure zoom helpers to core, the
    `PerspectiveCamera` binding stays three-side. Extended: `GlobeProjection` gained
    a `datum:'sphere'|'wgs84'` option (sphere byte-identical; WGS84 via Bowring — the
    §5.2 fix) + scale-aware `metersPerWorldUnit` (globe.gl radius); `ViewState` gained
    optional `roll`+`altitude` (§5.5). `geo.test.ts` (11) proves it. three 217 green.
  - **3b ✅ DONE 2026-06-30.** `core/geometry.tessellateFeature` added (`earcut`
    promoted core devDep→dep; pre-baked slice when present, else single-ring earcut,
    global-shifted; golden tests). maplibre `polygon-layer` now dispatches through it
    (both pre-baked + fallback), deleting its local earcut. Nuance (documented,
    non-blocking): the kernel earcuts raw lon/lat vs the old mercator-projected coords
    — topology-invariant under the conformal mercator map, so identical fill. maplibre
    62 green. (The multi-ring holes bug was already fixed in prod via build-time baking.)
- **Phase 4a ✅ DONE 2026-06-30.** `@poopdeck.gl/core/tileset-adapter.makeTilesetCallbacks`
  now consumed by three `StreamingTileSource`, deck `SpatioTemporalLayer`, AND maplibre
  `base-layer` (all three re-wrote the identical 5-callback glue by hand — verified
  byte-equivalent, deck kept `getAvailableSummaryTiles` inline). `@poopdeck.gl/core/picking`
  hoisted `encodePickId`/`decodePickId`/`MAX_PICK_ID`/`buildIdColors` (three re-exports
  as `encodeId`/`decodeId`, keeps its `GpuPicker`) + defined `SttPickResult` + the
  `InstanceProvenance` merged-buffer contract (§5.3). Wired by 3 parallel agents.
  Golden tests (picking 5). NOTE: emitting provenance in three's builders + using
  `SttPickResult` end-to-end is Phase 4b.

### Tier 2 — gated investment (only after §5.1–5.4 are resolved)

- **Phase 1 — codegen the scalar alpha.** ⏳ KERNEL DONE, rewiring pending.
  `@poopdeck.gl/core/shader-codegen` landed (`Expr` AST + `ALPHA_EXPR` for the
  LINEAR modes only — window/wake/cumulative/trail; surfel `exp()`/`sqrt()`
  Gaussian + `wakeSizeScale` vertex-stage explicitly excluded per §5.1) +
  `evalExpr` oracle + `emitGLSL100`/`emitGLSL300` (a GLSL ternary for `select`
  keeps the fade `div`-guard NaN-free without an epsilon). Conformance test
  proves `evalExpr(ALPHA_EXPR[mode])` == the `time-filter` oracle within 1e-6
  over 8000 random envs + boundary cases; emitters are deterministic + balanced.
  **Policy DECIDED + APPLIED 2026-07-01: hard-0 fade default + `wakeTailScale`
  0.15.** `DEFAULT_WAKE_TAIL_SCALE = 0.15` is now single-sourced in
  `core/time-filter`; three's three 0.1 sites + deck's literals reference it (deck
  unchanged, three 0.1→0.15); maplibre's fade default flipped soft→hard (soft only
  on explicit `softTimeWindow: true`). maplibre test updated to the new policy
  (63 green). **Changes shipped maplibre pixels (loses default soft edge) + three
  wake tail → user browser-verify.**
  STILL TODO (deferred — the single highest-risk change; math already unified via
  the oracle so this is structural dedup, needs full-backend browser-verify):
  rewire deck's `TimeFilterExtension` inject strings → `emitGLSL300(ALPHA_EXPR[mode])`,
  maplibre's `TIME_WINDOW_GLSL` → `emitGLSL100`, three's TSL node → `emitTSL`
  (three-side); add headless 1px `TIME_FILTER_VECTORS` conformance per backend.
- **Phase 4b/4c — NEW picking. ✅ SCAFFOLDS DONE 2026-07-01 (GPU parts
  browser-verify).** three: `buildPointBuffers` now emits an `InstanceProvenance`
  (closes the §5.3 merged-buffer identity gap — CPU-tested), `resolvePointPick`
  (pure/tested), `PointCloudLayer.pick(picker,camera,…)` via the now-wired
  `GpuPicker` + a `createPointIdMaterial` that follows the WGSL discipline (raw
  inputs varied, `select()` recomputed in fragment — dodges the black-screen
  trap). maplibre: an id-FBO scaffold in `STTBaseLayer` (`pick()` + FBO
  alloc/readback/decode + `PickProvenanceEntry` id-range allocator + `resolvePick`,
  all CPU-tested) with a `point-layer` id-shader opt-in; other families report
  `pick()→null`. `maplibreBackend.picking` stays `false` until the GPU round-trip
  is browser-verified (honest over-claim gate). three 232 / maplibre 88 green;
  the GPU render+readback on both is the browser-verify.
- **Phase 5 — vocabulary + capability contract.** ⏳ CORE SUBSTRATE DONE.
  `@poopdeck.gl/core/capabilities` landed: `LAYER_KINDS`/`CAPABILITIES` frozen
  `as const` unions + `TimeFilterMode` (single-sourced) — plain shared TS + `tsc`
  break-on-rename per the palette-parity idiom (NO codegen pipeline — the critic
  flagged that as over-machined); `BackendDescriptor` (+ `basemapProjection`,
  `tilesetOwnership`, `pickMechanism`, `interleavedBasemap`), `LayerKindSupport`,
  the typed `Degradation` union WITH the `fallbackMode` axis (§5.5 gap),
  `SttRenderNode` duck-type, `degradeRequest`, and the `assertDescriptorConsistent`
  over-claim gate + `ConformanceEvidence`. Tests (capabilities 9). STILL TODO:
  author a `BackendDescriptor` per backend (retro-documenting reality), a
  conformance harness feeding `assertDescriptorConsistent`, generate
  `docs/spec/backend-capabilities.md`, and the optional `RenderRegistry.mount`
  seam. Resolve lockstep-vs-separate-package before publishing.

  **✅ DONE 2026-07-01 (except optional registry).** All 3 `BackendDescriptor`s
  authored (`deckBackend`/`threeBackend`/`maplibreBackend`, exported from each
  barrel) by 3 parallel agents, each with a **structural conformance gate**
  (`test/backend-descriptor.test.ts`: every supported `LayerKind` maps to a real
  exported layer class; `assertDescriptorConsistent` == [] with evidence built
  from actual exports — a real over-claim gate, not circular). No flips needed —
  every claim verified against reality. `renderCapabilitiesMarkdown` +
  `docs/spec/backend-capabilities.md` generated (`scripts/gen-capabilities-doc.mjs`,
  esbuild-bundle-then-node). deck 448 / three 223 / maplibre 71 green. DEFERRED
  (optional): `RenderRegistry.mount` app-facing seam + wiring the showcase toggle
  through it, and a cross-package meta-test that regenerates + diffs the doc (needs
  a home that can import all 3 backends — core can't, per kernel-purity).
- **Phase 6 — green-field new backend.** ✅ CESIUM SCAFFOLD DONE 2026-07-01
  (WebGL-three **dropped** — it's the classic-`WebGLRenderer`/globe.gl slice, a
  separate backend from the WebGPU-TSL `@poopdeck.gl/three`, not needed now). NEW
  package `@poopdeck.gl/cesium` (CesiumJS is Apache-2.0/free; STT needs no ion
  token): `cesiumBackend` descriptor + a worked `CesiumPointLayer` (`SttRenderNode`)
  built ENTIRELY from the kernel — `core/geo` `GlobeProjection({datum:'wgs84'})`
  positions (Cesium's native frame), `core/style` color, `core/time-filter`
  `timeFilterAlpha` oracle (per-frame CPU), `scene.pick`→`getFeatureProperties`→
  `SttPickResult`, `makeTilesetCallbacks` streaming — plus a pure `ViewState`⇄Cesium
  camera bridge (first `roll` consumer) and `timeFilterAlphaGlsl` (=`emitGLSL300`)
  ready for a GPU-appearance path. **This validated the extension surface is thin:
  a new backend = a descriptor + a camera bridge + one layer, ZERO new shared code.**
  tsc clean + 12 tests (descriptor/camera/shaders — the pure parts); the layer +
  camera-apply are **browser-verify-only** (need a live Cesium Scene). Scaffold =
  `point` only; full catalog parity is follow-up. `backend-capabilities.md`
  regenerated with the cesium column. **Showcase wiring:** a `/cesium/:datasetId`
  route (`CesiumDemoPage` + `CesiumRenderer`) mounts a Cesium `Viewer` (ion
  disabled, assets via CDN `CESIUM_BASE_URL` — no Vite plugin), eager-loads a
  point dataset's tiles, and drives the layer from the shared playback clock.
  Showcase typecheck-green; the globe render is the browser-verify.

---

## 7. Decisions — status as of 2026-07-01

Five of the six "need a human" decisions are now settled (four de-facto by the
implementation, one counted out); **Decision 6 is the only live one**, and it
gates the entire Phase-1 rewire.

1. **Scope — DECIDED by action: full kernel.** Tier-1 shipped AND the Tier-2
   kernels (shader-codegen + spec contract, capabilities, picking, Cesium) are
   built; only the highest-risk *rewiring* (Phase 1) stays deferred behind
   Decision 6.
2. **Target backend — DECIDED: Cesium.** `@poopdeck.gl/cesium` is scaffolded with
   a `/cesium/:datasetId` showcase route. Catalog parity beyond `point` was
   counted out as demand-driven; **demand arrived 2026-07-02 and the MOVEMENT
   catalog is now built**: `path`+`line` (`CesiumPathLayer`, batched
   `Primitive`+`PolylineColorAppearance`, per-instance batch-table colour
   animation), `arc` (`CesiumArcLayer`, same great-circle parametrization as
   three's globe arc material), `trips` (`CesiumTripsLayer`, CPU trail trim
   into `PolylineCollection` + arc-length fade material), `tripHeads`
   (`CesiumTripHeadsLayer`). The trip CPU kernel was LIFTED out of three into
   `core/trips` (`buildTripIndex`+`sampleHead` + `synthesizeVertexTimes` +
   NEW `trimTrail`, `'f32'|'f64'` precision option; three's `lib/trip-heads`
   is now a re-export shim — the Tier-1 "CPU logic into core" pattern, third
   consumer triggered the move). Showcase `buildCesiumLayer` factory maps
   dataset types onto the catalog; `backend-capabilities.md` regenerated.
   Documented deviations (not silent): one colour per feature (OD gradients
   collapse to source colour; trips tail fade is arc-length not vertex-time),
   constant width/size per layer. Aggregation kinds (heatmap/summary/flow
   family) stay demand-driven with typed fallbacks.
3. **Fade-default + `wakeTailScale` policy — DECIDED & IN CODE** (this list was
   stale vs. the Phase-1 note): `DEFAULT_WAKE_TAIL_SCALE = 0.15` single-sourced in
   `core/render/time-filter.ts`, consumed by deck + three; maplibre flipped to
   hard-0 unless `softTimeWindow: true`. Only the maplibre-pixel browser verify
   remains (it's in the verify backlog).
4. **Package placement — DECIDED by action: `core` sub-paths** (per-subpath
   `exports` + `sideEffects: false`). Revisit lockstep-vs-separate-package only
   at npm-publish time.
5. **Vocabulary canon — COUNTED OUT in its open form:** deck-shaped canon stands
   (descriptors/`LAYER_KINDS`/`CAPABILITIES` are deck-shaped); no maplibre
   expression-alias layer unless a maplibre-idiom consumer demands one.
6. **GPU conformance infra — THE live decision.** Is a WebGPU-capable CI runner
   available for the nightly `emitTSL` smoke-compile + 1px readback
   (`TIME_FILTER_VECTORS`), or does the three gate fall back to
   CPU-mirror-vs-oracle with manual browser verify as the only pixel gate?
   **Everything in the Phase-1 rewire queue (deck/maplibre/three shader rewires
   + per-backend conformance) is counted out until this is answered** — the
   kernel already de-dupes the math via the CPU oracle, so the rewire is
   structural dedup with real pixel risk and no automated pixel gate to catch it.

**Also counted out 2026-07-01** (small items, triggers recorded): the optional
`RenderRegistry.mount` seam (direct-consumer path works; build only if a runtime
backend-toggle product need appears); `hostApiRange` on descriptors (add when
maplibre v5/globe support is actually attempted); the bundle-size guard test
(add at npm-publish alongside the packaging pass); the cross-package
regenerate-and-diff meta-test for `backend-capabilities.md` (needs a test home
that may import all four backends; gen script is deterministic, drift-risk low);
constructor-level capability assertions (fold into whichever of registry/publish
lands first); the §5.5 elevation metres→world-units reconciliation (the resolver
primitive `metersPerWorldUnit()` exists in core/geo — wiring maplibre's
`DEFAULT_ALTITUDE_SCALE` through it + a column-height golden vector goes with the
next maplibre pixel-verified change, not standalone).
