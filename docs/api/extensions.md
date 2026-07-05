# deck.gl extensions on STT layers

deck.gl ships a family of `LayerExtension`s (`@deck.gl/extensions`) that add
GPU capabilities — brushing, masking, clipping, dashed paths, data filtering,
collision de-cluttering. Most of them work on the `@poopdeck.gl/layers`
animated layers **unchanged**, because those layers append your top-level
`extensions` to their own internal set and forward each extension's scalar
props to every binary sublayer.

This page is the reference for **which deck extensions work as-is**, the **two
that are ported/adapted**, and the **three we skip** (with reasons). It
cross-references the parity audit
(`docs/roadmap/deckgl-parity-audit-2026-07.md`, §Tier 3).

## How pass-through works

Two mechanisms combine:

1. **`composeExtensions`** — every animated layer passes an explicit
   `extensions` list to its sublayers (its internal `TimeFilterExtension` /
   `CategoryColorExtension` / …). Because an explicit sublayer list *beats*
   deck's inheritance, the layer merges your top-level `extensions` prop into
   that list so your extension is never dropped. Internal extensions come
   first, so your shader injections compose *on top of* the time-fade alpha.
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

## Works as-is (pass-through)

Add these to the top-level `extensions` prop of any STT layer. No import from
`@poopdeck.gl/layers` needed.

| Extension | What passes through | Documented limit |
| --- | --- | --- |
| **BrushingExtension** | `brushingEnabled`, `brushingRadius`, `brushingTarget` (`'source'` / `'target'` / `'source_target'`) — GPU show/hide by pointer distance. Great on point / arc layers. | `brushingTarget: 'custom'` needs `getBrushingTarget`, a per-feature accessor — no rows to bind on a binary tile. Constant targets only. |
| **MaskExtension** | `maskId`, `maskByInstance`, `maskInverted` — geofence an STT layer to another layer's geometry (e.g. clip ship traffic to a harbor polygon). The base `operation: 'mask'` prop also forwards, so the mask-defining layer can itself be an STT layer. | None for the common case. |
| **ClipExtension** | `clipBounds`, `clipByInstance` — rectangular clip. Pure uniforms, no accessors. | None. |
| **PathStyleExtension** | Constant `getDashArray` (`[dash, gap]`), `getOffset`, `dashJustified`, `dashGapPickable` — dashed / offset paths (already a dep; `flow-stroke-layer.ts` uses `{ offset: true }`). | Per-**feature** dash/offset diverges — a function `getDashArray`/`getOffset` is forwarded but binds to no rows. Constant only; a baked-column variant is low-value future work. |

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

const harbor = new GeoJsonLayer({ id: 'harbor', data: harborPolygon, operation: 'mask' });
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

| Extension | Status | Notes |
| --- | --- | --- |
| **DataFilterExtension** | port-adapted (P1, flagship) | Register a `filterValue` attribute from a baked column via accessor-alias (exactly like `TimeFilterExtension`, its hand-built descendant); keep `filterRange` / `filterSoftRange` / `filterEnabled` as constant uniforms. Passing it raw does **not** work — deck would run a JS accessor over binary features. Unlocks "filter vessels by speed", "filter by any baked property". `onFilteredItemsChange` / `countItems` are n/a (no CPU rows). See [DataFilterExtension](./data-filter-extension.md) for the full option/prop surface. |
| **CollisionFilterExtension** | adapted (P2) | The **constant** case (`collisionEnabled` / `collisionGroup` / `collisionTestProps`, plus a constant `collisionPriority` that ranks a whole layer) works today via pass-through — great for de-cluttering `AnimatedIconLayer` / text labels. The `collisionFilterProps()` helper in `extensions/collision-filter-extension.ts` makes that one import and adds range-clamping. **Data-driven** priority (`collisionPriorityProperty`, a per-feature baked column) is **deferred**: it needs a `collisionPriorities` instanced attribute emitted by the layers (a layer-level change), so passing it warns once and falls back to the constant priority — we ship the honest helper rather than force a broken accessor. See [CollisionFilterExtension](./collision-filter-extension.md). |

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

| Extension | Reason |
| --- | --- |
| **FillStyleExtension** | Decorative pattern-fill. The constant pattern already passes through; a per-feature pattern-index column is a lot of plumbing for little payoff. |
| **_TerrainExtension** | Experimental upstream, and the vertical axis is already claimed by poopdeck's `timeHeightScale` space-time-cube lift — draping and time-as-height fight over `z`. |
| **Fp64Extension** | Deprecated upstream. Poopdeck already relativizes time per-tile (`timeOffset`) and uses deck's built-in fp64 position split; adding it is counterproductive. |

## See also

- [`TimeFilterExtension`](./time-filter-extension.md) — the internal,
  hand-built descendant of `DataFilterExtension` that filters/fades by time.
- [`CategoryColorExtension`](./category-color-extension.md) — GPU categorical
  color, another baked-column extension.
- Parity audit: `docs/roadmap/deckgl-parity-audit-2026-07.md`, §Tier 3.
