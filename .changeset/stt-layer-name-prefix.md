---
'@poopdeck.gl/core': minor
'@poopdeck.gl/layers': minor
'@poopdeck.gl/three': minor
'@poopdeck.gl/maplibre': minor
---

One `STT` prefix for every layer class, so nothing shadows deck.gl

deck.gl is the primary backend, so a real app imports `@deck.gl/*` and
`@poopdeck.gl/*` into the same module constantly. Any name exported by both is
therefore unwritable: TypeScript rejects the duplicate identifier, and in plain
JS whichever import evaluates last wins. Through 0.5.x we shipped twelve such
names. They are renamed; **the old spellings still work** as `@deprecated`
aliases (the identical class/type, not a copy), so this release needs no code
changes from you — you just get an IDE strikethrough pointing at the new name.

**What collided, and what it is now**

| Package | 0.5.x | 0.6.0 | Collided with |
| --- | --- | --- | --- |
| `@poopdeck.gl/three` | `ArcLayer` | `STTArcLayer` | `@deck.gl/layers` |
| `@poopdeck.gl/three` | `IconLayer` | `STTIconLayer` | `@deck.gl/layers` |
| `@poopdeck.gl/three` | `ColumnLayer` | `STTColumnLayer` | `@deck.gl/layers` |
| `@poopdeck.gl/three` | `PolygonLayer` | `STTPolygonLayer` | `@deck.gl/layers` |
| `@poopdeck.gl/three` | `PointCloudLayer` | `STTPointCloudLayer` | `@deck.gl/layers` |
| `@poopdeck.gl/three` | `TripsLayer` | `STTTripsLayer` | `@deck.gl/geo-layers` |
| `@poopdeck.gl/layers` | `DataFilterExtension` | `STTDataFilterExtension` | `@deck.gl/extensions` |
| `@poopdeck.gl/core` | `Layer` | `STTTileLayer` | `@deck.gl/core` |
| `@poopdeck.gl/core` | `Position` | `STTPosition` | `@deck.gl/core` |

`DataFilterExtension` was the sharpest of these: deck's class and ours are
*different implementations with different contracts* (deck runs a JS
`getFilterValue` accessor per row; ours binds a baked binary column named by
`filterProperty`) — and `@poopdeck.gl/layers` imports both, because the heatmap
and hexagon composites drive deck's stock extension over CPU rows. Same name,
two classes, one package.

`Layer` was the most in the way: `@deck.gl/core`'s `Layer` is the base class
every deck layer extends, and every consumer inside this repo had already been
forced to write `import { Layer as TileLayer } from '@poopdeck.gl/core'`.

**Also renamed, for consistency rather than collision**

`@poopdeck.gl/maplibre` already prefixed all fifteen of its layer classes with
`STT`. `@poopdeck.gl/three` and `@poopdeck.gl/cesium` now match, so one layer
kind has one spelling on every backend and the import path — not a redundant
word inside the symbol — tells you which renderer you are on:

- `@poopdeck.gl/three`: the remaining fourteen layer classes (`SurfelLayer` →
  `STTSurfelLayer`, `WideLineLayer` → `STTWideLineLayer`, `FlowmapLayer` →
  `STTFlowmapLayer`, and so on) plus every `*LayerOptions` type. Four of these
  (`FlowmapLayer`, `FlowCorridorLayer`, `H3SummaryLayer`, `QuadbinSummaryLayer`)
  had also been shadowing `@poopdeck.gl/layers`.
- `@poopdeck.gl/cesium` (unpublished/experimental): `CesiumPointLayer` →
  `STTPointLayer`, and the same for path / arc / trips / tripHeads /
  batched-polyline.

**Deliberately NOT renamed**

- `@poopdeck.gl/layers`' `Animated*` layer family (`AnimatedPointLayer`,
  `AnimatedArcLayer`, …). The prefix already means "the time-animated variant of
  deck's X", it is already unique, and mirroring deck's vocabulary is the point.
- `CollisionFilterExtension` in `@poopdeck.gl/layers`. It re-exports deck's own
  class unchanged, so both packages hand you the identical object — nothing to
  shadow. A test asserts that identity so the exemption cannot rot.
- `Cesium*` camera/clock bridges (`CesiumView`, `attachCesiumClock`, …), which
  are named after CesiumJS concepts, not STT layer kinds.

**Removal schedule and the one real break**

The deprecated aliases are removed in **0.8.0**. Nothing was removed in this
release — every name a 0.5.x app can import still resolves.

The one non-additive change: `STTDataFilterExtension.extensionName` is now
`'STTDataFilterExtension'` (was `'DataFilterExtension'`), and the renamed
classes report their new names via `constructor.name`. Only code that compares
those strings is affected.
