# BackendDescriptor

Every STT renderer backend — `@poopdeck.gl/layers` (deck.gl), `@poopdeck.gl/maplibre`,
`@poopdeck.gl/three`, `@poopdeck.gl/cesium` — publishes one `BackendDescriptor`: a
plain data object that declares what the backend supports, expressed against a
shared vocabulary owned by `@poopdeck.gl/core`. It is the single source of truth
that a hand-maintained "which backend supports what" table would otherwise drift
out of sync with: the descriptors feed a generated cross-backend matrix
([`docs/spec/backend-capabilities.md`](../spec/backend-capabilities.md)), and a
paired **over-claim gate** stops a descriptor from declaring support it cannot
back up.

This page explains the pattern itself — the shared vocabulary, the descriptor
shape, the over-claim gate, and how to read the generated matrix. For each
backend's actual layer catalog and usage, see
[`stt-maplibre.md`](./stt-maplibre.md), [`stt-cesium.md`](./stt-cesium.md),
[`stt-three.md`](./stt-three.md), and the deck.gl layer docs (starting at
[`spatiotemporal-layer.md`](./spatiotemporal-layer.md)).

## Installation

```typescript
import type {
  BackendDescriptor,
  LayerKind,
  Capability,
  LayerKindSupport,
  Degradation,
  ConformanceEvidence,
} from '@poopdeck.gl/core/capabilities';
import {
  LAYER_KINDS,
  CAPABILITIES,
  degradeRequest,
  assertDescriptorConsistent,
} from '@poopdeck.gl/core/capabilities';
import type { TimeFilterMode } from '@poopdeck.gl/core/time-filter';
```

`TimeFilterMode` is defined once in `core/time-filter` (see
[`time-filter-extension.md`](./time-filter-extension.md)) and re-exported from
`core/capabilities`, so there is exactly one animation-mode vocabulary shared
by the descriptor contract and the time-filter math itself.

## The shared vocabulary

`LayerKind`, `Capability`, and `TimeFilterMode` are frozen `as const` arrays —
plain shared TS unions, not a codegen pipeline. Renaming or removing an entry
is a `tsc` break everywhere it's consumed, which is the enforcement mechanism:
every descriptor is typed so a `Record<LayerKind, …>` or
`Record<Capability, boolean>` with a missing key fails to compile.

### `LayerKind` — the visualization layer families

```
point · path · polygon · arc · line · icon · column · trips · tripHeads ·
boundingBox · surfel · heatmap · h3Summary · quadbinSummary · flowmap ·
flowCorridor · flowStroke · isoLines · ego
```

Each concrete layer class documented elsewhere in `docs/api/` backs exactly
one of these kinds (e.g. `AnimatedPointLayer` / `PointCloudLayer` /
`STTPointLayer` / `CesiumPointLayer` all back `point` in their respective
backends).

### `Capability` — cross-cutting engine traits

| Capability           | Meaning                                                                                          |
| :------------------- | :----------------------------------------------------------------------------------------------- |
| `globe`              | Can render on a spherical/globe projection, not just flat mercator.                              |
| `picking`            | Supports feature picking (hover/click).                                                          |
| `extrude3d`          | Polygons/columns can be extruded to a 3D height.                                                 |
| `metricSizing`       | Sizes can be specified in real-world meters, not just pixels.                                    |
| `gpuHeatmap`         | Density heatmaps are computed on the GPU.                                                        |
| `liveBundling`       | Supports live (non-baked) edge bundling for flow visualizations.                                 |
| `timeAsHeight`       | Can lift geometry by time (the "space-time cube" effect).                                        |
| `interleavedBasemap` | Can interleave into a host basemap's own GL context rather than needing a synced overlay canvas. |
| `userExtensions`     | Accepts arbitrary user-supplied layer extensions/materials.                                      |
| `cameraRoll`         | The camera model has a roll (bank) axis, not just heading/pitch.                                 |

> **Globe datum.** `globe: true` says nothing about the _datum_: the deck and
> three globes are spherical by design (deck `GlobeView` parity), while Cesium's
> globe is the WGS84 ellipsoid — the two frames diverge by up to ~21 km at
> mid-latitudes. When registering STT geometry against Cesium (or any real
> WGS84 host), construct the shared `GlobeProjection` from
> `@poopdeck.gl/core/geo` with `datum: 'wgs84'`; the default `datum: 'sphere'`
> stays byte-identical to the deck/three globe output.

### `TimeFilterMode` — animation modes

`none` · `window` · `wake` · `cumulative` · `trail` — see
[`time-filter-extension.md`](./time-filter-extension.md#modes) for what each
mode does; a descriptor declares only the subset it implements.

## The `BackendDescriptor` shape

```typescript
interface BackendDescriptor {
  readonly id: string;
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly timeFilterModes: readonly TimeFilterMode[];
  readonly layerKinds: Readonly<Record<LayerKind, LayerKindSupport>>;
  readonly projectsOnCpu: boolean;
  readonly tilesetOwnership: 'per-layer' | 'shared';
  readonly pickMechanism: 'gpu-id' | 'cpu-ray' | 'id-fbo' | 'host' | 'none';
  readonly interleavedBasemap: boolean;
  readonly basemapProjection: 'mercator' | 'globe';
}
```

| Field                | Description                                                                                                                                                                                                                                                                                                                                        |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | Short backend identifier (`'deck'`, `'maplibre'`, `'three'`, `'cesium'`); the column header in the generated matrix.                                                                                                                                                                                                                               |
| `capabilities`       | One boolean per `Capability` — exhaustive, `tsc`-enforced.                                                                                                                                                                                                                                                                                         |
| `timeFilterModes`    | The `TimeFilterMode`s this backend implements.                                                                                                                                                                                                                                                                                                     |
| `layerKinds`         | One `LayerKindSupport` per `LayerKind` — exhaustive, `tsc`-enforced.                                                                                                                                                                                                                                                                               |
| `projectsOnCpu`      | Whether lon/lat → world projection happens on the CPU (three, Cesium) vs. on the GPU against a host viewport (deck).                                                                                                                                                                                                                               |
| `tilesetOwnership`   | `'shared'` — one tileset feeds every layer (deck, three, Cesium) — vs. `'per-layer'` — each layer class owns its own archive (MapLibre).                                                                                                                                                                                                           |
| `pickMechanism`      | How picking resolves: `'gpu-id'` (an id color buffer), `'cpu-ray'` (ray/OBB intersection), `'id-fbo'` (a dedicated id framebuffer pass — defined for a future backend, not used by any of the four today), `'host'` (delegated to the host engine, e.g. Cesium's `scene.pick`), or `'none'`.                                                       |
| `interleavedBasemap` | Whether STT geometry can share the basemap's own GL/scene context vs. needing a camera-synced overlay canvas. Mirrored inside `capabilities.interleavedBasemap`, which is the value the over-claim gate actually checks; this top-level field is the same fact exposed as a direct trait for code that branches on it without a capability lookup. |
| `basemapProjection`  | The projection the backend's basemap integration assumes: `'mercator'` or `'globe'`.                                                                                                                                                                                                                                                               |

## `LayerKindSupport` — native, fallback, or unsupported

```typescript
type LayerKindSupport =
  | { supported: true }
  | { supported: false; fallbackKind?: LayerKind; reason: string };
```

Every `LayerKind` must appear in a descriptor's `layerKinds` map — there is no
"absent means unsupported" shortcut, so a newly added `LayerKind` forces every
backend's descriptor to make an explicit decision (a missing key is a `tsc`
error against `Record<LayerKind, LayerKindSupport>`):

- **`{ supported: true }`** — native. The backend renders this kind directly
  (rendered as `✅` in the generated matrix).
- **`{ supported: false, fallbackKind, reason }`** — degrades to a different,
  supported kind (rendered as `↳ <fallbackKind>`). Example: MapLibre has no
  arc geometry, so `arc` degrades to `line`; `@poopdeck.gl/three` has no GPU
  heatmap, so `heatmap` degrades to `point` density.
- **`{ supported: false, reason }`** (no `fallbackKind`) — genuinely
  unsupported, with no in-backend substitute (rendered as `—`). Example: the
  deck.gl backend has no dedicated `ego` layer — AV cockpits compose it from
  point/icon layers at the application level instead.

`reason` is required on every unsupported entry (`supported: false`) and is a
plain human-readable string, not part of the machine-checked contract.

## Resolving a request: `degradeRequest`

```typescript
function degradeRequest(
  d: BackendDescriptor,
  kind: LayerKind,
  mode?: TimeFilterMode, // default 'window'
): Degradation | null;
```

Given a requested `(kind, mode)`, `degradeRequest` returns `null` when the
backend fully supports the request as-is, or a typed `Degradation` describing
how it doesn't:

1. **Kind checked first** (an unsupported kind can't render regardless of
   mode). If `layerKinds[kind].supported` is false: returns
   `{ action: 'fallback', toKind, lost: [] }` when a `fallbackKind` is
   declared, otherwise `{ action: 'skip', reason }`.
2. **Mode checked second.** If the kind is supported but `mode` is not in
   `timeFilterModes`: returns `{ action: 'fallbackMode', fromMode, toMode,
lost: [] }`, preferring `'window'` as the fallback mode when the backend
   supports it, else the first mode the backend declares.

The `Degradation` union also defines a `throw` action (`{ action: 'throw',
reason }`) for callers that want to hard-fail on an unresolvable request;
`degradeRequest` itself never returns it — it always prefers a typed fallback
or skip over throwing.

## The over-claim gate

```typescript
function assertDescriptorConsistent(
  d: BackendDescriptor,
  proven: ConformanceEvidence,
): string[]; // [] means consistent
```

```typescript
interface ConformanceEvidence {
  capabilities: ReadonlySet<Capability>;
  layerKinds: ReadonlySet<LayerKind>;
  timeFilterModes: ReadonlySet<TimeFilterMode>;
}
```

A `BackendDescriptor` is a self-declaration — nothing stops it from claiming a
capability the backend doesn't actually have. `assertDescriptorConsistent`
closes that gap: it walks every `Capability`, `LayerKind`, and declared
`TimeFilterMode` the descriptor claims `true`/`supported`/present, and reports
a violation string for each one that has no matching entry in `proven`. A
descriptor that claims _less_ than it proves is fine (that's just a backend
choosing to degrade something it could technically support); claiming _more_
than it proves is what fails.

Each backend package supplies its own `test/backend-descriptor.test.ts`
against this gate, building `ConformanceEvidence` from the package's own
reality:

- **Layer-kind evidence is structural**: for every `LayerKind` the descriptor
  claims `supported: true`, the test maps it to the concrete class expected to
  back it (e.g. `point` → `AnimatedPointLayer` for deck.gl, `PointCloudLayer`
  for three) and checks that class is a real, live export from the package's
  `src/index.ts`. A renamed or deleted export drops that kind out of the
  proven set and trips the gate — this is the mechanism that stops the
  descriptor from silently drifting away from the code.
- **Capability and time-filter-mode evidence** is currently built from the
  descriptor's own claimed `true` capabilities and declared modes (i.e. it
  documents the backend's shipped reality rather than being independently
  proven by a dedicated conformance case per capability/mode) — the exported
  layer catalog is the part of the contract with real teeth today.

## Reading the generated matrix

`docs/spec/backend-capabilities.md` is produced by
`renderCapabilitiesMarkdown` (`@poopdeck.gl/core`'s
`render/capabilities-doc.ts`) from the four live descriptors, run via:

```bash
node scripts/gen-capabilities-doc.mjs
```

(after building `core` and the four backend packages — see that script's
header comment for the exact bundling invocation). The file is a checked-in
snapshot, not something computed at doc-build time: there is no automated test
that regenerates and diffs it against the live descriptors, so keeping it
current after a `BackendDescriptor` change is a manual regenerate-and-commit
step.

The generated file has four sections, one row group per `id` column
(`deck`/`three`/`maplibre`/`cesium` today):

| Section               | Rows                                                                                            | Cell meaning                                                                                                                           |
| :-------------------- | :---------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| **Traits**            | `projectsOnCpu`, `tilesetOwnership`, `pickMechanism`, `interleavedBasemap`, `basemapProjection` | The raw field value (`yes`/`no`, or the literal union value).                                                                          |
| **Capabilities**      | every `Capability`                                                                              | `✅` when `capabilities[cap]` is true, else `—`.                                                                                       |
| **Time-filter modes** | every `TimeFilterMode`                                                                          | `✅` when the mode is in `timeFilterModes`, else `—`.                                                                                  |
| **Layer kinds**       | every `LayerKind`                                                                               | `✅` native, `↳ <kind>` fallback, `—` unsupported — see [`LayerKindSupport`](#layerkindsupport--native-fallback-or-unsupported) above. |

Reading it top to bottom answers, in order: how does this backend project and
own tiles (Traits), what can it do at all (Capabilities), what animation
vocabulary does it accept (Time-filter modes), and what will it actually
render for a given layer kind, natively or via fallback (Layer kinds).

## The four concrete descriptors

| Backend     | Package                 | `id`       | Descriptor file                                                                                    |
| :---------- | :---------------------- | :--------- | :------------------------------------------------------------------------------------------------- |
| deck.gl     | `@poopdeck.gl/layers`   | `deck`     | [`packages/layers/src/backend-descriptor.ts`](../../packages/layers/src/backend-descriptor.ts)     |
| MapLibre GL | `@poopdeck.gl/maplibre` | `maplibre` | [`packages/maplibre/src/backend-descriptor.ts`](../../packages/maplibre/src/backend-descriptor.ts) |
| Three.js    | `@poopdeck.gl/three`    | `three`    | [`packages/three/src/backend-descriptor.ts`](../../packages/three/src/backend-descriptor.ts)       |
| CesiumJS    | `@poopdeck.gl/cesium`   | `cesium`   | [`packages/cesium/src/backend-descriptor.ts`](../../packages/cesium/src/backend-descriptor.ts)     |

deck.gl is the reference backend (full catalog, GPU id-buffer picking, all
four time-filter modes, interleaves into the basemap's GL context). The other
three each degrade a documented subset relative to it — see each file's own
header comment for what it does and doesn't cover, and
[`stt-cesium.md`'s "Backend descriptor" section](./stt-cesium.md#backend-descriptor)
for a worked walkthrough of one descriptor's fields end to end.

## Adding a fifth backend

1. Import `BackendDescriptor`, `LayerKind`, `Capability`, `LayerKindSupport`,
   `LAYER_KINDS`, and `CAPABILITIES` from `@poopdeck.gl/core/capabilities`.
2. Build an exhaustive `layerKinds` record — either `satisfies
Record<LayerKind, LayerKindSupport>` on a literal object, or
   `Object.fromEntries(LAYER_KINDS.map(...))` — so a `LayerKind` missing from
   the record is a `tsc` error. Give every `supported: false` entry a `reason`
   and, where a substitute exists, a `fallbackKind`.
3. Declare all ten `capabilities` booleans and the subset of
   `timeFilterModes` the backend actually implements.
4. Fill in the five traits (`projectsOnCpu`, `tilesetOwnership`,
   `pickMechanism`, `interleavedBasemap`, `basemapProjection`) honestly
   against how the backend actually works, not aspirationally.
5. Export the descriptor (conventionally `<name>Backend`) from the package's
   `src/index.ts`.
6. Add a `test/backend-descriptor.test.ts` mirroring the existing four: for
   every `LayerKind` claimed `supported: true`, map it to the concrete class
   backing it and assert that class is a real export; assert every
   unsupported kind carries a `reason`; then build a `ConformanceEvidence`
   from those real exports (plus the descriptor's claimed capabilities/modes)
   and assert `assertDescriptorConsistent(...)` returns `[]`.
7. Add the new descriptor to the import list and array in
   [`scripts/gen-capabilities-doc.mjs`](../../scripts/gen-capabilities-doc.mjs)
   and regenerate `docs/spec/backend-capabilities.md`.

## Source

[packages/core/src/render/capabilities.ts](../../packages/core/src/render/capabilities.ts) ·
[packages/core/src/render/capabilities-doc.ts](../../packages/core/src/render/capabilities-doc.ts) ·
[packages/core/src/render/time-filter.ts](../../packages/core/src/render/time-filter.ts) ·
[packages/layers/src/backend-descriptor.ts](../../packages/layers/src/backend-descriptor.ts) ·
[packages/maplibre/src/backend-descriptor.ts](../../packages/maplibre/src/backend-descriptor.ts) ·
[packages/three/src/backend-descriptor.ts](../../packages/three/src/backend-descriptor.ts) ·
[packages/cesium/src/backend-descriptor.ts](../../packages/cesium/src/backend-descriptor.ts) ·
[scripts/gen-capabilities-doc.mjs](../../scripts/gen-capabilities-doc.mjs) ·
generated matrix: [docs/spec/backend-capabilities.md](../spec/backend-capabilities.md)
