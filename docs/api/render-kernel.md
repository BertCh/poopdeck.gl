# Render Kernel (`@poopdeck.gl/core`)

`@poopdeck.gl/core` has two halves. One is the **reader** — `STTArchive`,
`SpatioTemporalTileset`, `decodeTile` — documented in
[Tile decoding](./stt-loader.md), [SpatioTemporalTileset](./spatiotemporal-tileset.md),
and [Binary Features](./binary-features.md). This page documents the other
half: the **render kernel**, a set of framework-free modules under
`packages/core/src/render/` and `packages/core/src/geo/` that hold the CPU
logic every renderer backend (`@poopdeck.gl/layers` on deck.gl,
`@poopdeck.gl/three`, `@poopdeck.gl/maplibre`, `@poopdeck.gl/cesium`) needs
and would otherwise hand-copy: time-filter alpha math (plus a second,
independently-authored expression-AST oracle for it), color expansion,
geometry reductions, geographic projection, picking id encoding, tileset
fetch-callback glue, and the capability-declaration vocabulary.

None of it is re-exported from the package root (`@poopdeck.gl/core`) —
each module is its own `exports` sub-path in `packages/core/package.json`,
so a backend imports only the pieces it needs and bundlers tree-shake the
rest:

| Sub-path                             | Source file                                                                        | Consumed by                                          |
| :----------------------------------- | :--------------------------------------------------------------------------------- | :--------------------------------------------------- |
| `@poopdeck.gl/core/time-filter`      | [`render/time-filter.ts`](../../packages/core/src/render/time-filter.ts)           | layers, three, cesium                                |
| `@poopdeck.gl/core/shader-codegen`   | [`render/shader-codegen.ts`](../../packages/core/src/render/shader-codegen.ts)     | backend conformance tests; one unwired cesium export |
| `@poopdeck.gl/core/style`            | [`render/style.ts`](../../packages/core/src/render/style.ts)                       | layers, three, maplibre, cesium                      |
| `@poopdeck.gl/core/geometry`         | [`render/geometry.ts`](../../packages/core/src/render/geometry.ts)                 | layers, three, maplibre                              |
| `@poopdeck.gl/core/geo`              | [`geo/index.ts`](../../packages/core/src/geo/index.ts)                             | three, cesium                                        |
| `@poopdeck.gl/core/picking`          | [`render/picking.ts`](../../packages/core/src/render/picking.ts)                   | three, maplibre, cesium                              |
| `@poopdeck.gl/core/tileset-adapter`  | [`render/tileset-adapter.ts`](../../packages/core/src/render/tileset-adapter.ts)   | layers, three, maplibre                              |
| `@poopdeck.gl/core/capabilities`     | [`render/capabilities.ts`](../../packages/core/src/render/capabilities.ts)         | layers, three, maplibre, cesium                      |
| `@poopdeck.gl/core/capabilities-doc` | [`render/capabilities-doc.ts`](../../packages/core/src/render/capabilities-doc.ts) | doc generation only                                  |

A repo test (`packages/core/test/kernel-framework-free.test.ts`) statically
scans every file under `packages/core/src` and fails the build if it imports
`three`, `@deck.gl/*`, `@luma.gl/*`, `maplibre-gl`, `mapbox-gl`, `cesium`, or
`@react-three/*` — the enforcement mechanism that keeps this package
renderer-agnostic. For the design rationale behind the kernel's boundaries,
see [renderer-architecture.md](../roadmap/renderer-architecture.md);
for what each backend claims to support on top of it, see
[backend-capabilities.md](../spec/backend-capabilities.md).

## `core/time-filter`

The CPU reference for the per-feature/per-vertex temporal alpha every backend
animates against, plus the time-relativization scheme and a vocabulary
resolver. This is the numeric oracle. **Every backend's GPU shader is
hand-written** — deck's `TimeFilterExtension` inject strings, maplibre's
GLSL snippets, three's TSL node graph — and each implements these four modes
independently in its own dialect. What keeps them from drifting is not code
generation but a conformance contract: each backend's shader math is pinned
by test to this oracle _and_ to `core/shader-codegen`'s independently-authored
`evalExpr` (see [`core/shader-codegen`](#coreshader-codegen) below).

```typescript
type TimeFilterMode = 'window' | 'wake' | 'cumulative' | 'trail' | 'none';

interface TimeFilterParams {
  windowHalf?: number; // half-width of the symmetric window (ms) — window mode
  fadeIn?: number; // leading-edge fade ramp (ms) — window / cumulative
  fadeOut?: number; // trailing-edge fade ramp (ms) — window
  wakeLength?: number; // wake length behind the playhead (ms) — wake mode
  trailLength?: number; // trail length behind the playhead (ms) — trail mode
  trailFade?: number; // 1 = head→tail fade, 0 = solid trail — trail mode
}
```

### Per-mode alpha functions

| Function          | Signature                                                                    | Semantics                                                                                                                                                    |
| :---------------- | :--------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `windowAlpha`     | `(currentTime, startTime, endTime, windowHalf, fadeIn?, fadeOut?) => number` | Visible while `[startTime, endTime]` overlaps `[currentTime ± windowHalf]`, with optional leading/trailing fade ramps.                                       |
| `wakeAlpha`       | `(currentTime, startTime, wakeLength) => number`                             | Visible only in `[0, wakeLength]` ms behind the playhead, fading linearly to 0 at the tail.                                                                  |
| `cumulativeAlpha` | `(currentTime, startTime, fadeIn?) => number`                                | Appears at `startTime` and persists forever after ("draw and persist"); optional `fadeIn` ramps 0→1.                                                         |
| `trailAlpha`      | `(currentTime, vertexTime, trailLength, trailFade) => number`                | Per-vertex: visible while `vertexTime ∈ [currentTime - trailLength, currentTime]`; `trailFade` blends a solid trail (0) against a head→tail linear fade (1). |
| `wakeSizeScale`   | `(alpha, wakeTailScale) => number`                                           | The wake-mode tail point-size multiplier (`wakeTailScale` at the tail, full size at the head) — mirrors deck's `DECKGL_FILTER_SIZE` wake branch.             |
| `timeFilterAlpha` | `(mode, currentTime, startTime, endTime, params?, vertexTime?) => number`    | Dispatches to the function above matching `mode`; `'none'` always returns `1`.                                                                               |

`DEFAULT_WAKE_TAIL_SCALE = 0.15` is the single-sourced default tail size
multiplier for wake mode.

### Relativization scheme

```typescript
const MAX_RELATIVE_TIME_MS = 16_777_216; // 2^24 — f32 mantissa exact-integer bound

function relativizeTime(absoluteTime: number, offset: number): number; // absoluteTime - offset

function assertRelTimeInRange(
  relativeTime: number,
  mode: TimeFilterMode,
  key?: string,
): void;
```

Every time value the kernel compares is relative to a per-tile/per-scene
offset (absolute epoch-ms minus the offset), so both sides of a shader
comparison stay small enough to survive an exact f32 round-trip.
`relativizeTime` is the single source of truth for that subtraction;
`assertRelTimeInRange` warns once per `key` when a resolved relative time
exceeds `MAX_RELATIVE_TIME_MS` in a non-cumulative mode (cumulative
intentionally spans years and tolerates the coarser quantization). See
[TimeFilterExtension § The timeOffset contract](./time-filter-extension.md#the-timeoffset-contract-f32-precision)
for the worked deck.gl example — the scheme is identical here.

### Vocabulary resolver

```typescript
interface TimeFilterVocabulary {
  timeWindow?: number; // FULL-width window (ms) — deck/maplibre
  fadeInDuration?: number; // deck/maplibre
  fadeOutDuration?: number; // deck/maplibre
  softTimeWindow?: boolean; // maplibre legacy soft-ramp flag
  windowHalf?: number; // HALF-width window (ms) — three-native; wins over timeWindow
  fadeIn?: number; // three-native; wins over fadeInDuration
  fadeOut?: number; // three-native; wins over fadeOutDuration
  wakeLength?: number;
  trailLength?: number;
  trailFade?: number;
}

interface ResolveTimeFilterPolicy {
  defaultWindowHalf?: number;
  softDefaultFraction?: number; // undefined = hard-0 fade default (deck/three); set = maplibre-style soft ramp
}

function resolveTimeFilterParams(
  v: TimeFilterVocabulary,
  policy?: ResolveTimeFilterPolicy,
): TimeFilterParams;
```

`resolveTimeFilterParams` normalizes the union of vocabularies deck/maplibre
(full-width `timeWindow` + `fadeInDuration`/`fadeOutDuration`) and three
(half-width `windowHalf` + `fadeIn`/`fadeOut`) accept, into one
`TimeFilterParams`. When both forms of a knob are supplied, the half-width
form wins. Today `@poopdeck.gl/three`'s `lib/time-window.ts` calls it
directly; maplibre still resolves its own fade durations locally
(`base-layer.ts`'s `resolveFadeDurations`) rather than through this
function.

## `core/shader-codegen`

The scalar time-filter alpha authored a **second** time, as a branchless
expression AST, independently of `core/time-filter`'s CPU functions.

The module name is historical and oversells it: **nothing that ships is
generated from this AST.** All four backends hand-write their own shader
math (see the table below). What the module actually buys is a _second
oracle_ — `evalExpr` is a separate, differently-shaped implementation of the
same four modes, so a backend's math can be pinned against two
independently-authored references instead of one. A transcription slip in
either implementation shows up as a failing test rather than as drifted
pixels. Read it as a conformance oracle, not a compiler.

```typescript
type Expr =
  | { op: 'uniform'; name: string }
  | { op: 'attr'; name: string }
  | { op: 'const'; value: number }
  | {
      op: 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max' | 'step';
      a: Expr;
      b: Expr;
    }
  | { op: 'clamp01'; a: Expr }
  | { op: 'select'; c: Expr; t: Expr; f: Expr };
```

The frozen op-set is exactly: `uniform`, `attr`, `const`, `add`, `sub`,
`mul`, `div`, `min`, `max`, `step`, `clamp01`, `select`. `select(c, t, f)` is
`c != 0 ? t : f`, evaluated lazily (and emitted as a GLSL ternary), so a fade
`div` guarded by `select` never evaluates a zero-denominator branch. This
op-set is deliberately scoped to the four **linear** modes (`window`, `wake`,
`cumulative`, `trail`) — the surfel/splat temporal-Gaussian weight, the
radial falloff, and the `wakeSizeScale` vertex-stage multiplier use
transcendentals outside the set, so they have no second oracle and are pinned
to `core/time-filter` alone by per-backend parity tests.

```typescript
const ALPHA_EXPR: Record<'window' | 'wake' | 'cumulative' | 'trail', Expr>;

function evalExpr(e: Expr, env: Record<string, number>): number;

const TIME_FILTER_VARS: {
  currentTime: 'currentTime';
  startTime: 'startTime';
  endTime: 'endTime';
  vertexTime: 'vertexTime';
  windowHalf: 'windowHalf';
  fadeIn: 'fadeIn';
  fadeOut: 'fadeOut';
  wakeLength: 'wakeLength';
  trailLength: 'trailLength';
  trailFade: 'trailFade';
};
```

- `ALPHA_EXPR[mode]` is the frozen per-mode AST.
- `evalExpr` is the second oracle: it must equal `core/time-filter`'s
  `timeFilterAlpha` numerically for every mode — asserted by a 2000-sample
  randomized conformance sweep in `packages/core/test/shader-codegen.test.ts`.
  This is the function the backend conformance tests import.
- `TIME_FILTER_VARS` is the canonical identifier set an AST refers to. It is
  the vocabulary each backend maps onto its own shader variable names by hand.

### Backend conformance obligations

No backend consumes an emitted string. Each hand-writes its shader in its own
dialect and is pinned by test to _both_ oracles — `core/time-filter`'s
`timeFilterAlpha` and this module's `evalExpr`:

| Backend                 | What ships                                                          | Dialect                                                        | Pinned by                                                                   |
| :---------------------- | :------------------------------------------------------------------ | :------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| `@poopdeck.gl/layers`   | hand-written inject strings (`extensions/time-filter-extension.ts`) | GLSL ES 3.00 (`layout(std140) uniform`, `in`/`out`)            | `packages/layers/test/` time-filter conformance                             |
| `@poopdeck.gl/maplibre` | hand-written snippets (`shaders/time-window.glsl.ts`)               | GLSL ES 1.00 (`attribute`; `linkProgram` is WebGL1-compatible) | `packages/maplibre/test/time-modes.test.ts` (the three-way statement of it) |
| `@poopdeck.gl/three`    | hand-written TSL node graph (`tsl/time-filter.ts`)                  | TSL node graph (WebGPU / WebGL2)                               | `packages/three/test/tsl-time-filter-conformance.test.ts` (graph executed)  |
| `@poopdeck.gl/cesium`   | **no shader** — per-frame CPU alpha writes into the batch table     | —                                                              | `packages/cesium/test/` (direct oracle calls)                               |

For the GLSL backends the pin has the same shape, because GLSL cannot be
executed in a headless unit test: the package keeps a JS reference
implementation of its shader math, the tests assert that reference equals
`timeFilterAlpha` **and** `evalExpr(ALPHA_EXPR[mode], env)` over a dense sweep
including every boundary, and the shipped GLSL is locked to the reference
structurally (the formula lines are asserted verbatim, so editing one without
the other fails). `packages/maplibre/test/time-modes.test.ts` states this
contract explicitly and is the model for the others.

**Three is pinned harder**, because TSL is the one dialect that _can_ run
headless. A TSL graph is a plain object tree (`ConstNode`/`UniformNode` carry
`.value`; `OperatorNode` carries `.op`; `MathNode` carries `.method`;
`ConditionalNode` carries its branches), so no `NodeBuilder`, GPU, or WebGPU
renderer is needed to walk and evaluate it. `tsl-time-filter-conformance.test.ts`
therefore executes the **shipped graph itself** against both oracles rather
than a hand-kept mirror of it — there is no reference to drift. Its evaluator
throws on any unknown node class or operator, so a graph rewritten with a new
op fails loudly instead of silently passing. Compiled-shader
_pixels_ remain outside what any of this proves — see
[renderer-architecture.md §2.9](../roadmap/renderer-architecture.md#29-five-tier-enforcement-ladder--its-honest-ceiling).

> **There is no GLSL emitter any more, by decision.** `emitGLSL300` and its
> only caller, `@poopdeck.gl/cesium`'s `timeFilterAlphaGlsl`, were removed at
> the 0.6.0 cut; `emitGLSL100` had gone earlier. None of them was ever in a
> render path — every backend hand-writes its shader in its own dialect, and
> Cesium CPU-filters through `timeFilterAlpha`. What the kernel exports is the
> AST and its evaluator, because conformance compares the alpha VALUE, not the
> shader TEXT. Re-add an emitter when something compiles its output.

There is **no `emitTSL`**, in this package or in `@poopdeck.gl/three`, and
there never was. Where the name still appears — in
[renderer-architecture.md §5.1](../roadmap/renderer-architecture.md#51-decision-6--gpu-conformance-ci-the-one-live-decision-blocked)'s
open question — it is a proposal, not a function. three's TSL alpha
(`@poopdeck.gl/three`'s `tsl/time-filter.ts`) is a hand-written node-graph
mirror of `core/time-filter`.

## `core/style`

Framework-free color resolution: categorical (keyed or positional-palette)
lookup, RGB-numeric-column expansion, and continuous ramp sampling, each
able to emit either `Uint8Array` (0–255) or `Float32Array` (0..1) output so
one implementation serves both a GPU-attribute convention (deck: `u8`) and
another (three: `f32`).

```typescript
type RGBA255 = readonly [number, number, number, number];
type ColorOut = 'u8' | 'f32';
const NULL_CATEGORY_INDEX = 0xffff; // sentinel "no category" in categoricalProps.indices

function resolveCategoryColor(
  label: string | undefined,
  mapping: Record<string, RGBA255> | null | undefined,
  fallback: RGBA255,
): RGBA255;
```

```typescript
interface CategoricalColorSpec {
  property: string;
  colorMapping?: Record<string, RGBA255> | null;
  palette?: readonly RGBA255[]; // positional fallback (maplibre)
  colorMappingDefault?: RGBA255; // default undefined ⇒ transparent [0,0,0,0]
  onMissing?: 'null' | 'fill'; // property absent from tile: null (maplibre) or fill (three). default 'null'
  requireMappingOrPalette?: boolean; // maplibre guard: null when nothing to paint. default false
}

function expandCategoricalColors(
  binary: BinaryFeatures,
  spec: CategoricalColorSpec,
  out: ColorOut,
): Uint8Array | Float32Array | null;
```

`expandCategoricalColors` is a superset of the color-resolution patterns
each backend needs (three's `lib/color.ts`, maplibre's `base-layer.ts`,
deck's `animated-point-layer.ts`, three's `box-tracks.ts` scalar
`resolveColor`); `out`, `onMissing`, `requireMappingOrPalette`, and the
positional `palette` argument reproduce each call site's exact behavior.
Per-feature resolution order when a categorical property
is present: `colorMapping[label] ?? colorMappingDefault`, then
`palette[idx % palette.length]` if still unset, then transparent. Note deck's
GPU `CategoryColorExtension` (a palette texture sampled by
`instanceCategoryIndex`, see [CategoryColorExtension](./category-color-extension.md))
is **not** part of this kernel — only the palette data and category-index
attribute builder are shared; `expandCategoricalColors` is deck's CPU
`colorMapping` fallback path, not its GPU hot path.

```typescript
function expandRgbColumns(
  binary: BinaryFeatures,
  columns: readonly [string, string, string], // r, g, b numeric property names (0–255)
  out: ColorOut,
  alpha?: number, // default 255
  fallback?: RGBA255, // default [200, 205, 215, 255]
): Uint8Array | Float32Array;
```

```typescript
interface RampColorSpec {
  property: string;
  domain: readonly [number, number];
  range: readonly RGBA255[]; // ≥1 evenly-spaced gradient stops
  fallback: RGBA255;
}

function rampColorAt(
  value: number,
  domain: readonly [number, number],
  range: readonly RGBA255[],
): RGBA255;
function expandRampColors(
  binary: BinaryFeatures,
  spec: RampColorSpec,
  out: ColorOut,
): Uint8Array | Float32Array;
```

`rampColorAt` clamps `value` into `domain`, maps it to `[0, 1]`, and
linearly interpolates across `range`'s evenly-spaced stops (including
alpha); `expandRampColors` applies it per-feature, falling back to a
constant color when the numeric property is absent from the tile.

## `core/geometry`

Backend-neutral geometry reductions.

```typescript
interface SourceTargetPositions {
  source: Float64Array; // featureCount * dims — feature i's FIRST vertex
  target: Float64Array; // featureCount * dims — feature i's LAST vertex
  dims: number; // 2 or 3
}

function deriveSourceTargetPositions(
  binary: BinaryFeatures,
): SourceTargetPositions;
```

Derives dense source/target endpoint buffers from a LineString tile's
`startIndices` — the source→target representation OD flow layers (deck
`ArcLayer`/`LineLayer`, three's OD-line rendering) need. STT stores OD flows
as LineString features; each feature collapses to its first vertex (source)
and last vertex (target), dropping any intermediate vertices. Output is
`Float64Array` so deck's fp64 position attribute populates hi/lo correctly.
Requires `binary.startIndices`; callers gate on `featureCount > 0`.

```typescript
function tessellateFeature(
  binary: BinaryFeatures,
  featureIndex: number,
  opts?: { preferPrebaked?: boolean }, // default true
): Uint32Array | null;
```

The single tessellation dispatch every backend shares: when the tile
carries pre-baked `triangles`/`triangleOffsets` (built with
`stt-build --pre-tessellate`) and `preferPrebaked` is not explicitly
disabled, returns a zero-copy `subarray` of that feature's slice — the
holes-correct, multi-ring-correct path. Otherwise falls back to `earcut`-ing
the feature's single ring (`startIndices[f] … startIndices[f+1]`), matching
maplibre's original fallback; this path cannot handle holes/multi-ring
polygons (see [Binary Features § Polygon rings](./binary-features.md#polygon-rings)).
Returns `null` when the feature has no polygon geometry, or (non-prebaked
path) fewer than 3 ring vertices.

## `core/geo`

A pluggable lon/lat(+altitude) ↔ world-space projection, for the CPU-side
projecting backends (three today; Cesium and a future WebGL-three next).
deck.gl projects entirely on the GPU against a host `WebMercatorViewport`/
`GlobeViewport` and does not consume this module.

```typescript
interface GeoAnchor {
  longitude: number;
  latitude: number;
}

interface LocalFrame {
  east: [number, number, number]; // unit world vector, local east
  north: [number, number, number]; // unit world vector, local north
  up: [number, number, number]; // unit world vector, local up
}

interface Projection {
  readonly kind: string;
  readonly anchor: GeoAnchor;
  project(
    longitude: number,
    latitude: number,
    altitude?: number,
  ): [number, number, number];
  unproject(x: number, y: number, z?: number): [number, number, number];
  metersPerWorldUnit(longitude: number, latitude: number): number;
  localFrame(longitude: number, latitude: number): LocalFrame;
}

const METERS_PER_DEG_LAT = 111_320;
const EARTH_RADIUS = 6_378_137; // WGS84 semi-major axis (m)
```

Three implementations share this contract:

| Class                | `kind`        | World axes                                              | Notes                                                                                                                                                                                                                                                                                      |
| :------------------- | :------------ | :------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalEnuProjection` | `'local-enu'` | Z-up metric ENU, 1 world unit = 1 m                     | Equirectangular about a fixed anchor; east scale frozen at `cos(anchor.latitude)` — the exact inverse of the AV dataset build-time `av_common.local_to_lonlat` georeferencing.                                                                                                             |
| `MercatorProjection` | `'mercator'`  | Z-up, world units = mercator metres                     | Standard Web-Mercator (EPSG:3857); clamps latitude to `MAX_MERCATOR_LAT` (`85.05112877980659`); altitude divided by `metersPerWorldUnit` so vertical scale matches horizontal. Absolute coordinates run ~±2e7, so batches route through the RTC helper below.                              |
| `GlobeProjection`    | `'globe'`     | ECEF (+X → lon 0/lat 0, +Y → lon 90°E, +Z → north pole) | `datum: 'sphere'` (default, a true sphere) or `'wgs84'` (real ellipsoid, via `WGS84_F`/first-eccentricity and Bowring's closed-form inverse for `unproject`). `radius` sets the semi-major-axis world-unit length (default `EARTH_RADIUS`; e.g. pass `100` for a unit-sphere-scale globe). |

```typescript
function projectPositionsToEnu(
  proj: Projection,
  positions: Float64Array,
  count: number,
  dims: 2 | 3,
  elevation?: Float32Array,
  elevScale?: number,
): Float32Array; // interleaved world [x, y, z] triples

interface ProjectedPositions {
  positions: Float32Array; // f32, RELATIVE to origin
  origin: [number, number, number]; // f64 world-space origin
}

function projectPositions(
  proj: Projection,
  positions: Float64Array,
  count: number,
  dims: 2 | 3,
  opts?: {
    elevation?: Float32Array;
    elevScale?: number;
    origin?: [number, number, number];
  },
): ProjectedPositions;
```

`projectPositions` is the precision-safe ("Relative-To-Center") batch
projector for mercator/globe frames, where absolute world coordinates
overflow f32: it writes each vertex as an f32 offset from a high-precision
`origin` (defaulting to the first projected point), and the caller parents
the geometry under an object placed at that origin. Passing
`origin: [0, 0, 0]` reproduces `projectPositionsToEnu`'s behavior.

### View state + zoom helpers

```typescript
interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number; // Web-Mercator zoom (world is 512·2^zoom px around)
  pitch?: number; // degrees, 0 = top-down
  bearing?: number; // degrees, 0 = north up
  roll?: number; // degrees; ignored by backends whose camera lacks a roll DOF
  altitude?: number; // metres, alternative to zoom for height-driven cameras (Cesium)
}

const TILE_SIZE = 512;
const WORLD_CIRCUMFERENCE: number; // 2π · EARTH_RADIUS

function worldUnitsPerPixel(
  proj: Projection,
  zoom: number,
  latitude: number,
): number;
function zoomForWorldUnitsPerPixel(
  proj: Projection,
  wupp: number,
  latitude: number,
): number;
```

`ViewState` is the deck-compatible lingua franca for cross-renderer camera
sync; the three-specific `viewStateToCamera`/`cameraToViewState` bridge
(which touches a Three `PerspectiveCamera`) lives in `@poopdeck.gl/three`
and consumes this type plus the two zoom helpers.
`worldUnitsPerPixel`/`zoomForWorldUnitsPerPixel` convert between zoom and
ground resolution: mercator world units are constant mercator-metres per
zoom, globe world units are true metres so ground resolution additionally
shrinks by `cos(latitude)`.

## `core/picking`

The framework-free pieces every backend's hit-testing shares: a normalized
result shape, 24-bit id-color packing so any id-buffer backend is
interoperable, and a provenance ledger for backends that merge many tiles'
geometry into one draw buffer.

```typescript
const MAX_PICK_ID = 0xffffff; // 16,777,215

function encodePickId(index: number): [number, number, number]; // big-endian, throws if out of range
function decodePickId(rgb: readonly [number, number, number]): number;
function buildIdColors(featureCount: number): Float32Array; // normalized [0,1] RGB triples, one per feature
```

```typescript
interface SttPickResult {
  object: Record<string, unknown> | null;
  index: number; // feature index within its (tile, layer) BinaryFeatures, or -1
  tileId?: TileId;
  layerId: string;
  coordinate?: [number, number]; // geographic [lng, lat]
  screen?: [number, number]; // CSS [x, y]
  worldPoint?: [number, number, number]; // renderer-frame world space
  meta?: Record<string, unknown>; // backend/domain-specific extras (e.g. AV trackId, speed)
}
```

`index` joins back to columns via `getFeatureProperties(binary, index)`
(see [Binary Features § Reading one feature back](./binary-features.md#reading-one-feature-back)).

```typescript
interface InstanceProvenanceEntry {
  tileKey: string; // stable z/x/y/t::layer key
  featureIndex: number; // index within that (tile, layer)'s BinaryFeatures
}

class InstanceProvenance {
  push(tileKey: string, featureIndex: number): void;
  get length(): number;
  resolve(instanceIndex: number): InstanceProvenanceEntry | null;
}
```

`InstanceProvenance` accumulates one entry per instance as a merged-buffer
builder emits it, so a decoded pick index resolves back to the originating
`(tile, layer, feature)`. This matters specifically for `@poopdeck.gl/three`,
which merges resident tiles into one `InstancedMesh` per layer — the merge
builders push provenance in the same order they emit instances. deck.gl
answers picking through its own upstream picking-color attribute mechanism
(GPU render + readback) and does not need this ledger, since each visible
tile there keeps its own sublayer with intact per-tile feature indices.
The GPU render/readback itself (three's `GpuPicker`, a CPU ray-OBB test,
Cesium's id-buffer) stays per-backend outside this kernel.

## `core/tileset-adapter`

```typescript
type TilesetFetchCallbacks = Pick<
  SpatioTemporalTilesetOptions,
  | 'getAvailableTiles'
  | 'getTileData'
  | 'getTileDataBatch'
  | 'getTileByteSize'
  | 'getThroughput'
>;

function makeTilesetCallbacks(archive: STTArchive): TilesetFetchCallbacks;
```

The single adapter that wires an `STTArchive` onto the fetch-callback subset
of `SpatioTemporalTilesetOptions` (see [SpatioTemporalTileset](./spatiotemporal-tileset.md)):
`getAvailableTiles` routes through the archive's bulk range coalescer
(`getTileIdsInBounds`); `getTileData`/`getTileDataBatch` forward the batch
hooks (`onTileReady`, `fetchPriority`, `playheadTime`, `playheadDirection`)
so the shared request scheduler can rank range-groups comparably across
archives; `getTileByteSize`/`getThroughput` proxy directly. All three
renderer backends (`@poopdeck.gl/layers`'s `SpatioTemporalLayer`,
`@poopdeck.gl/three`'s `StreamingTileSource`, `@poopdeck.gl/maplibre`'s
`STTBaseLayer`) call this and then spread the result into their own
`SpatioTemporalTileset` options alongside the layout/lifecycle fields it
does not cover — `minZoom`/`maxZoom`, `refinementStrategy`,
`onTileLoad`/`onTileUnload`, `onBufferChange`, and so on.

## `core/capabilities`

The cross-backend vocabulary — layer kinds, cross-cutting capabilities,
time-filter modes — plus the declare-and-prove machinery every backend's
`backend-descriptor.ts` is built from. The vocabulary is a frozen `as const`
array/union pair per axis, so renaming a token is a compile break in every
backend rather than a silent drift; `TimeFilterMode` is re-exported from
`core/time-filter` so there is exactly one definition of the animation
modes.

```typescript
const LAYER_KINDS = [
  'point',
  'path',
  'polygon',
  'arc',
  'line',
  'icon',
  'column',
  'trips',
  'tripHeads',
  'boundingBox',
  'surfel',
  'heatmap',
  'h3Summary',
  'quadbinSummary',
  'flowmap',
  'flowCorridor',
  'flowStroke',
  'isoLines',
  'ego',
] as const;
type LayerKind = (typeof LAYER_KINDS)[number];

const CAPABILITIES = [
  'globe',
  'picking',
  'extrude3d',
  'metricSizing',
  'gpuHeatmap',
  'liveBundling',
  'timeAsHeight',
  'interleavedBasemap',
  'userExtensions',
  'cameraRoll',
] as const;
type Capability = (typeof CAPABILITIES)[number];

type LayerKindSupport =
  | { supported: true }
  | { supported: false; fallbackKind?: LayerKind; reason: string };

type Degradation =
  | { action: 'fallback'; toKind: LayerKind; lost: Capability[] }
  | {
      action: 'fallbackMode';
      fromMode: TimeFilterMode;
      toMode: TimeFilterMode;
      lost: Capability[];
    }
  | { action: 'skip'; reason: string }
  | { action: 'throw'; reason: string };
```

```typescript
interface BackendDescriptor {
  readonly id: string;
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly timeFilterModes: readonly TimeFilterMode[];
  readonly layerKinds: Readonly<Record<LayerKind, LayerKindSupport>>;
  readonly projectsOnCpu: boolean; // three/Cesium: true; deck: false
  readonly tilesetOwnership: 'per-layer' | 'shared'; // deck/three: shared; maplibre: per-layer
  readonly pickMechanism: 'gpu-id' | 'cpu-ray' | 'id-fbo' | 'host' | 'none';
  readonly interleavedBasemap: boolean;
  readonly basemapProjection: 'mercator' | 'globe';
}
```

Each of the four packages (`@poopdeck.gl/layers`, `@poopdeck.gl/three`,
`@poopdeck.gl/maplibre`, `@poopdeck.gl/cesium`) ships its own
`backend-descriptor.ts` implementing one `BackendDescriptor` against this
contract; the generated matrix at
[backend-capabilities.md](../spec/backend-capabilities.md) is produced from
those four descriptors by `core/capabilities-doc`'s
`renderCapabilitiesMarkdown`.

```typescript
interface SttRenderNode {
  readonly id: string;
  setTime(absoluteMs: number): void;
  setViewState?(v: ViewState): void;
  pick?(
    cssX: number,
    cssY: number,
    o?: { mode?: 'hover' | 'click' },
  ): SttPickResult | null | Promise<SttPickResult | null>;
  dispose(): void;
}
```

`SttRenderNode` is the one shared runtime shape — duck-typed, not a base
class. A three `STTLayer`, a deck sublayer wrapper, a maplibre
`STTBaseLayer`, and a Cesium `Primitive` all satisfy it.

```typescript
function degradeRequest(
  d: BackendDescriptor,
  kind: LayerKind,
  mode?: TimeFilterMode,
): Degradation | null;

interface ConformanceEvidence {
  capabilities: ReadonlySet<Capability>;
  layerKinds: ReadonlySet<LayerKind>;
  timeFilterModes: ReadonlySet<TimeFilterMode>;
}

function assertDescriptorConsistent(
  d: BackendDescriptor,
  proven: ConformanceEvidence,
): string[];
```

`degradeRequest` resolves how a backend handles a requested
`(kind, mode)`: `null` when fully supported; otherwise a typed
`Degradation` (kind is checked first — an unsupported kind can't render
regardless of mode). `assertDescriptorConsistent` is the over-claim gate: it
returns one violation string per capability/kind/mode a descriptor claims
that has no passing entry in the supplied `ConformanceEvidence`, so a
descriptor cannot silently drift ahead of what its backend's test suite
actually proves.

## Import surface

Every sub-path above resolves through `packages/core/package.json`'s
`exports` map to a `dist/render/*` or `dist/geo/*` build output — none of
them are re-exported from the package's `.` entry point (`@poopdeck.gl/core`
itself only exports the reader surface: `STTArchive`, `SpatioTemporalTileset`,
`decodeTile`, the default palettes, and so on). Import the sub-path
directly:

```typescript
import { timeFilterAlpha, relativizeTime } from '@poopdeck.gl/core/time-filter';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { expandCategoricalColors } from '@poopdeck.gl/core/style';
```

## See also

- [System overview § `@poopdeck.gl/core` render kernel](../architecture/system-overview.md) — where this kernel sits relative to the reader half and each renderer backend.
- [renderer-architecture.md](../roadmap/renderer-architecture.md) — the design rationale, fork axes, and consistency-enforcement tiers behind this kernel's boundaries.
- [backend-capabilities.md](../spec/backend-capabilities.md) — the generated capability matrix (`core/capabilities-doc`'s output) across all four backends.
- [TimeFilterExtension](./time-filter-extension.md) — deck.gl's consumer of `core/time-filter`'s relativization scheme.
- [Binary Features](./binary-features.md) — the `BinaryFeatures` shape `core/style` and `core/geometry` operate on.

## Source

- [`packages/core/src/render/time-filter.ts`](../../packages/core/src/render/time-filter.ts)
- [`packages/core/src/render/shader-codegen.ts`](../../packages/core/src/render/shader-codegen.ts)
- [`packages/core/src/render/style.ts`](../../packages/core/src/render/style.ts)
- [`packages/core/src/render/geometry.ts`](../../packages/core/src/render/geometry.ts)
- [`packages/core/src/geo/index.ts`](../../packages/core/src/geo/index.ts), [`local-enu.ts`](../../packages/core/src/geo/local-enu.ts), [`mercator.ts`](../../packages/core/src/geo/mercator.ts), [`globe.ts`](../../packages/core/src/geo/globe.ts), [`view-state.ts`](../../packages/core/src/geo/view-state.ts)
- [`packages/core/src/render/picking.ts`](../../packages/core/src/render/picking.ts)
- [`packages/core/src/render/tileset-adapter.ts`](../../packages/core/src/render/tileset-adapter.ts)
- [`packages/core/src/render/capabilities.ts`](../../packages/core/src/render/capabilities.ts), [`capabilities-doc.ts`](../../packages/core/src/render/capabilities-doc.ts)
- Framework-free enforcement: [`packages/core/test/kernel-framework-free.test.ts`](../../packages/core/test/kernel-framework-free.test.ts)
