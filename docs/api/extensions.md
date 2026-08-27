# deck.gl extensions on STT layers

deck.gl ships a family of `LayerExtension`s (`@deck.gl/extensions`) that add
GPU capabilities — brushing, masking, clipping, dashed paths, data filtering,
collision de-cluttering. Most of them work on the `@poopdeck.gl/layers`
animated layers **unchanged**, because those layers append your top-level
`extensions` to their own internal set and forward each extension's scalar
props to every binary sublayer.

This page is the reference for which deck extensions work as-is, the two that
are ported or adapted, and the three that are skipped, with reasons. It
cross-references the parity decision record
([renderer-architecture.md §3.4 "Extension posture"](../roadmap/renderer-architecture.md#34-extension-posture)).

## How pass-through works

Two mechanisms combine:

1. **`composeExtensions`** — every animated layer passes an explicit
   `extensions` list to its sublayers (its internal `TimeFilterExtension` /
   `CategoryColorExtension` / …). Because an explicit sublayer list _beats_
   deck's inheritance, the layer merges your top-level `extensions` prop into
   that list. Internal extensions come first, so your shader injections
   compose _on top of_ the time-fade alpha. The merge **dedupes by class**:
   your instance is appended unless an instance of the same class is already
   installed internally (`TimeFilterExtension`, `CategoryColorExtension`,
   `STTDataFilterExtension`, …), in which case the internal one wins — it
   carries the per-tile wiring — and yours is dropped with a one-time console
   warning. Configure the internal instance through the layer's own props
   instead.
2. **Extension `getSubLayerProps` pass** — deck's `CompositeLayer` walks its
   own `extensions` and merges each `extension.getSubLayerProps()` into the
   sublayer props. That forwards the scalar props named in the extension's
   `defaultProps` (`brushingRadius`, `maskId`, `clipBounds`, …) from the
   composite down to the sublayer.

The one thing that does **not** cross this boundary is a **per-feature JS
accessor**. STT tiles arrive as binary Arrow columns; there are no per-row
objects for an accessor like `getFilterValue: d => d.speed` to run over. So the
rule is: **constant / uniform extension props pass through; data-driven ones
need a baked column** (which is exactly what the two ported extensions add).

See `packages/layers/test/extensions-passthrough.test.ts` and
`packages/layers/test/collision-filter-extension.test.ts` for the pinned
contract.

### The one family that does not forward extensions

The flowmap composites — [`FlowmapLayer`](./flowmap-layer.md) and
[`BundledFlowmapLayer`](./bundled-flowmap-layer.md) — render through
[`FlowLinesLayer`](./flow-lines-layer.md), a fully custom-`Model` layer that
calls luma's `picking` module functions directly instead of going through deck's
globally-registered `DECKGL_FILTER_*` shader hooks (those hooks live on a
process-wide `ShaderAssembler` singleton that a bundler can duplicate, leaving
them undefined and the shader uncompilable).

Extensions inject into exactly those hooks, so they have **no effect** on that
primitive. Rather than forward an inert list, those composites **strip a
forwarded `extensions` prop and warn once**.

## Works as-is (pass-through)

Add these to the top-level `extensions` prop of any STT layer. No import from
`@poopdeck.gl/layers` needed.

| Extension              | What passes through                                                                                                                                                                                                                                  | Attributes added                                                                                                                                                                            | Documented limit                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BrushingExtension**  | `brushingEnabled`, `brushingRadius`, `brushingTarget` (`'source'` / `'target'` / `'source_target'`) — GPU show/hide by pointer distance. Great on point / arc layers.                                                                                | **1** — `brushingTargets` (size 2), registered unconditionally.                                                                                                                             | `brushingTarget: 'custom'` needs `getBrushingTarget`, a per-feature accessor — no rows to bind on a binary tile. Constant targets only.                                         |
| **MaskExtension**      | `maskId`, `maskByInstance`, `maskInverted` — geofence an STT layer to another layer's geometry (e.g. clip ship traffic to a harbor polygon). The base `operation: 'mask'` prop also forwards, so the mask-defining layer can itself be an STT layer. | **0**.                                                                                                                                                                                      | None for the common case.                                                                                                                                                       |
| **ClipExtension**      | `clipBounds`, `clipByInstance` — rectangular clip. Pure uniforms, no accessors.                                                                                                                                                                      | **0**.                                                                                                                                                                                      | None.                                                                                                                                                                           |
| **PathStyleExtension** | Constant `getDashArray` (`[dash, gap]`), `getOffset`, `dashJustified`, `dashGapPickable` — dashed / offset paths (already a dep; `flow-stroke-layer.ts` uses `{ offset: true }`).                                                                    | **1–3**, by construction option — `instanceDashArrays` (size 2) under `{dash}`, `instanceDashOffsets` under `{dash, highPrecisionDash}` on a path host, `instanceOffsets` under `{offset}`. | Per-**feature** dash/offset diverges — a function `getDashArray`/`getOffset` is forwarded but binds to no rows. Constant only; a baked-column variant is low-value future work. |

Attaching one of these is not free of GPU budget. Every path-family STT layer
starts from the non-picking `PathLayer` (**12** slots) plus
`TimeFilterExtension` (**3**), against WebGL2's guaranteed **16**
vertex-attribute floor — but only one of them stops there:

- **`AnimatedPathLayer`** — 12 + 3 = **15**; it deliberately installs no
  `CategoryColorExtension`, so exactly one slot is free. Spend it on one
  attribute-registering extension _or_ on `filterProperty` _or_ on
  `pickable: true` (which swaps in the stock 13-attribute `PathLayer`) — never
  two. The layer warns once if you ask for both of the last two.
- **`AnimatedTripsLayer`** and **`FlowCorridorLayer`** — 12 + 3 + 1 for the
  internal `CategoryColorExtension` = **16**, zero headroom, so any
  attribute-registering extension overflows. Setting `filterProperty` does not
  free anything: the layer drops the (idle) `CategoryColorExtension` to pay for
  `filterValue` and stays at 16.
- **`FlowStrokeLayer`** — **16** either way. At the default `offsetWidths: 0.6`
  it trades the `CategoryColorExtension` slot for `PathStyleExtension`'s
  `instanceOffsets`; at `offsetWidths: 0` it keeps the category slot instead.

Overflow is a fatal per-pipeline link failure that renders a **blank layer, not
an error**; see
[renderer-architecture.md §2.13](../roadmap/renderer-architecture.md#213-the-webgl2-16-attribute-floor-is-a-real-ceiling-and-it-fails-silently).
Point and arc hosts have room; so does the polygon fill, but
`AnimatedPolygonLayer`'s outline sublayer is itself a non-picking `PathLayer`
and reaches 16 once `filterProperty` is set.

```ts
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import { BrushingExtension } from '@deck.gl/extensions';

new AnimatedPointLayer({
  // …tileset props…
  extensions: [new BrushingExtension()],
  brushingEnabled: true,
  brushingRadius: 5000, // metres
  brushingTarget: 'source',
});
```

```ts
// Geofence: clip an STT layer to a harbor polygon.
import { MaskExtension } from '@deck.gl/extensions';
import { GeoJsonLayer } from '@deck.gl/layers';

const harbor = new GeoJsonLayer({
  id: 'harbor',
  data: harborPolygon,
  operation: 'mask',
});
const traffic = new AnimatedPointLayer({
  /* …tileset… */
  extensions: [new MaskExtension()],
  maskId: 'harbor',
});
```

## Ported / adapted

These cannot be attached raw, because deck would try to source a data-driven
accessor by running JS over binary features. Each is adapted to source its
per-feature value from a **baked tile column** via the accessor-alias
mechanism — the same shape as the internal `TimeFilterExtension`.

| Extension                    | Status                      | Notes                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **STTDataFilterExtension**   | port-adapted (P1, flagship) | Binds `filterValue` (**1** attribute) from a baked column via accessor-alias; `filterRange` / `filterSoftRange` / `filterEnabled` stay constant uniforms. ⚠️ `filterRange` defaults to `null` (idle) here, not upstream's `[-1, 1]` (active). See [STTDataFilterExtension](./data-filter-extension.md).                                               |
| **CollisionFilterExtension** | adapted (P2)                | The constant configuration works today via pass-through; `collisionFilterProps()` bundles it into one spread and clamps the priority range. deck's class registers `collisionPriorities` (**1** attribute) on every host; per-feature priority baked from a tile column is deferred. See [CollisionFilterExtension](./collision-filter-extension.md). |

```ts
import { AnimatedIconLayer } from '@poopdeck.gl/layers';
import { collisionFilterProps } from '@poopdeck.gl/layers';

new AnimatedIconLayer({
  // …tileset / icon props…
  ...collisionFilterProps({
    collisionEnabled: true,
    collisionGroup: 'labels',
    collisionPriority: 25, // constant: rank this layer above another group
  }),
});
```

## Skipped

| Extension              | Reason                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FillStyleExtension** | Decorative pattern-fill. The constant pattern already passes through; a per-feature pattern-index column is a lot of plumbing for little payoff.                  |
| **\_TerrainExtension** | Experimental upstream, and the vertical axis is already claimed by poopdeck's `timeHeightScale` space-time-cube lift — draping and time-as-height fight over `z`. |
| **Fp64Extension**      | Deprecated upstream. poopdeck.gl already relativizes time per-tile (`timeOffset`) and uses deck's built-in fp64 position split; adding it is counterproductive.   |

## See also

- [`TimeFilterExtension`](./time-filter-extension.md) — the internal,
  hand-built descendant of `STTDataFilterExtension` that filters/fades by time.
- [`CategoryColorExtension`](./category-color-extension.md) — GPU categorical
  color, another baked-column extension.
- [`ChevronFlowExtension`](./chevron-flow-extension.md) — poopdeck-native
  directional chevrons for `PathLayer`-family hosts. It inspects the host's
  capabilities and degrades any option the host cannot support, with a one-time
  warning, rather than emitting an undeclared GLSL identifier.
- [`SplatExtension`](./splat-extension.md) — soft-gaussian point splatting.
- Parity decision record: [renderer-architecture.md §3.4 "Extension posture"](../roadmap/renderer-architecture.md#34-extension-posture).
