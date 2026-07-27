# AnimatedTextLayer

The `AnimatedTextLayer` renders **time-filtered map labels** at point features — each feature's text is drawn from a categorical (string) property column and shown only while the playhead is inside its keyframe window. It draws through deck.gl's `TextLayer` (`@deck.gl/layers`), one sublayer per resident tile.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md). `TextLayer` does have a **binary** branch — given `data = { length, startIndices, attributes: { getText: { value: Uint8Array | Uint16Array | Uint32Array } } }` it derives every label (and the auto character set) straight from the code points, with no per-row JS accessor. So this layer decodes each `(tile, layer)` pair **once** (cached by a style digest) into flat typed arrays — a UTF-32 code-point buffer plus per-row char offsets, positions, times, RGBA colors, optional size/angle — and **never materializes a per-feature row object**. Only the time filter is on the CPU (`TextLayer` has no per-instance time attribute); the visible subset is handed over as deck's binary `getText` payload. See [How it works](#how-it-works).

## Installation

```typescript
import { AnimatedTextLayer } from '@poopdeck.gl/layers';
```

## Usage

```typescript
const layer = new AnimatedTextLayer({
  id: 'place-labels',
  data: '/data/places/manifest.json',
  currentTime,
  timeWindow: 24 * 3600 * 1000,
  textProperty: 'name', // string column drawn as each label
  color: 'category', // categorical column → colorMapping lookup
  colorMapping: {
    city: [255, 255, 255, 255],
    town: [180, 200, 255, 255],
  },
  size: 20,
  background: true,
  getBackgroundColor: [0, 0, 0, 160], // NOT `backgroundColor` — see the note below
  backgroundBorderRadius: 4,
  fontFamily: 'Inter, sans-serif',
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

Per-feature JS function accessors are **not** supported — every styling prop is a constant or a baked column NAME. The upstream `getText` / `getColor` / `getSize` / `getAngle` names are accepted as aliases with that same value domain; passing a function warns once and falls back to the plain prop. When an alias is set, it wins over its plain counterpart.

### Text & Data Accessors

| Property              | Type                            | Default          | Description                                                                                                                                                                                                                                                                                                                                      |
| :-------------------- | :------------------------------ | :--------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textProperty`        | `string`                        | `'text'`         | Property column NAME drawn as each label's text. Reads a categorical (string) column; a numeric column is formatted (see `textPrecision`). Rows whose value is absent/empty draw **nothing** and are dropped from the visible set — deck's binary-text reader mis-slices a leading run of zero-length rows.                                      |
| `getText`             | `string \| null`                | `null`           | Upstream-vocabulary alias of `textProperty`. Accepts a property-column NAME — not a function accessor. When set, it wins.                                                                                                                                                                                                                        |
| `textPrecision`       | `number \| null`                | `null`           | Decimal places used when `textProperty` names a NUMERIC column. `null` prints the **shortest decimal string that round-trips** back to the stored `float32` — without it `String(v)` renders a `1.1` stored as float32 as `1.100000023841858`, which is both wrong on screen and inflates the derived character set. A number pins `toFixed(n)`. |
| `color`               | `Color \| string`               | `[0, 0, 0, 255]` | Label color — a constant RGBA, or a property-column NAME resolved through `colorMapping` for categorical coloring.                                                                                                                                                                                                                               |
| `getColor`            | `Color \| string \| null`       | `null`           | Upstream-vocabulary alias of `color` (constant Color or column NAME; not a function). When set, it wins.                                                                                                                                                                                                                                         |
| `colorMapping`        | `Record<string, Color> \| null` | `null`           | Category-string → color map used when `color`/`getColor` names a column. Categories absent from the map fall back to `colorMappingDefault`.                                                                                                                                                                                                      |
| `colorMappingDefault` | `Color`                         | `[0, 0, 0, 0]`   | Color for categories not present in `colorMapping` (transparent by default, so unmapped labels disappear rather than mislead).                                                                                                                                                                                                                   |
| `size`                | `number \| string`              | `32`             | Label size — a constant number, or a numeric property-column NAME for per-feature size. Interpreted in `sizeUnits`.                                                                                                                                                                                                                              |
| `getSize`             | `number \| string \| null`      | `null`           | Upstream-vocabulary alias of `size` (constant or numeric column NAME; not a function). When set, it wins.                                                                                                                                                                                                                                        |
| `angle`               | `number \| string`              | `0`              | Label rotation in DEGREES — a constant number, or a numeric property-column NAME for per-feature angle.                                                                                                                                                                                                                                          |
| `getAngle`            | `number \| string \| null`      | `null`           | Upstream-vocabulary alias of `angle` (constant or numeric column NAME; not a function). When set, it wins.                                                                                                                                                                                                                                       |

### Layout & Anchoring

| Property               | Type                            | Default    | Description                                                                                   |
| :--------------------- | :------------------------------ | :--------- | :-------------------------------------------------------------------------------------------- |
| `getTextAnchor`        | `'start' \| 'middle' \| 'end'`  | `'middle'` | Horizontal anchor — `TextLayer` `getTextAnchor` pass-through (constant).                      |
| `getAlignmentBaseline` | `'top' \| 'center' \| 'bottom'` | `'center'` | Vertical alignment — `TextLayer` `getAlignmentBaseline` pass-through (constant).              |
| `getPixelOffset`       | `[number, number]`              | `[0, 0]`   | Pixel offset `[x, y]` from the anchor — `TextLayer` `getPixelOffset` pass-through (constant). |

### Background & Border

| Property                 | Type                                                   | Default                | Description                                                                                                                                                                          |
| :----------------------- | :----------------------------------------------------- | :--------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `background`             | `boolean`                                              | `false`                | Whether to render a background rectangle behind each label.                                                                                                                          |
| `backgroundColor`        | `Color`                                                | `[255, 255, 255, 255]` | Background rectangle color. ⚠️ **Read the naming note below** — this is _not_ upstream's prop of the same name. Prefer `getBackgroundColor`.                                         |
| `getBackgroundColor`     | `Color \| null`                                        | `null`                 | Upstream-vocabulary alias of `backgroundColor`. A constant Color — not a function accessor. When set, it wins.                                                                       |
| `backgroundPadding`      | `[number, number] \| [number, number, number, number]` | `[0, 0, 0, 0]`         | Padding around the text for the background, in pixels (`TextLayer` `backgroundPadding`). Only effective when no content box is set.                                                  |
| `backgroundBorderRadius` | `number \| [number, number, number, number]`           | `0`                    | Corner radius of the background rectangle in pixels — a single number for all corners, or `[bottom_right, top_right, bottom_left, top_left]` (`TextLayer` `backgroundBorderRadius`). |
| `borderColor`            | `Color`                                                | `[0, 0, 0, 255]`       | Background border color — the legacy STT name for upstream's `getBorderColor`, which is what it is forwarded as. Prefer `getBorderColor`.                                            |
| `getBorderColor`         | `Color \| null`                                        | `null`                 | Upstream-vocabulary alias of `borderColor`. A constant Color. When set, it wins.                                                                                                     |
| `borderWidth`            | `number`                                               | `0`                    | Background border width in pixels — the legacy STT name for upstream's `getBorderWidth`, which is what it is forwarded as. Prefer `getBorderWidth`.                                  |
| `getBorderWidth`         | `number \| null`                                       | `null`                 | Upstream-vocabulary alias of `borderWidth`. A constant number. When set, it wins.                                                                                                    |

> ⚠️ **`backgroundColor` is a name collision, not a pass-through.** In upstream
> deck.gl, `TextLayer.backgroundColor` is a **deprecated alias of a different
> thing** — `background` + `getBackgroundColor` combined. Here it is the legacy
> STT name for the modern `getBackgroundColor` accessor, and it is forwarded to
> the sublayer as `getBackgroundColor`, never as `backgroundColor` (which would
> trip deck's deprecation path). If you are reading upstream docs, the prop you
> want here is **`getBackgroundColor`**; use `background: true` to turn the
> rectangle on.

### SDF Outline

| Property       | Type     | Default          | Description                                                                                                                                                                                              |
| :------------- | :------- | :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outlineColor` | `Color`  | `[0, 0, 0, 255]` | SDF outline color around glyphs (`TextLayer` `outlineColor`). Only effective when `fontSettings.sdf` is `true`. This is a layer-level uniform, so it is NOT faded by `fadeInDuration`/`fadeOutDuration`. |
| `outlineWidth` | `number` | `0`              | SDF outline width relative to text size (`TextLayer` `outlineWidth`). Only effective when `fontSettings.sdf` is `true`.                                                                                  |

### Font

| Property       | Type                                          | Default               | Description                                                                                                                                                                               |
| :------------- | :-------------------------------------------- | :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fontFamily`   | `string`                                      | `'Monaco, monospace'` | CSS font family (`TextLayer` `fontFamily`).                                                                                                                                               |
| `fontWeight`   | `number \| string`                            | `'normal'`            | CSS font weight (`TextLayer` `fontWeight`).                                                                                                                                               |
| `lineHeight`   | `number`                                      | `1`                   | Unitless multiplier of the text size that sets the LINE HEIGHT of a wrapped / multi-line label (`TextLayer` `lineHeight`). Without it, multi-line labels (see `maxWidth`) are unstylable. |
| `fontSettings` | `Record<string, unknown>`                     | `{}`                  | Font atlas tuning (`sdf`, `fontSize`, `buffer`, …) — `TextLayer` `fontSettings`. Set `{ sdf: true }` to enable the `outlineWidth`/`outlineColor` glyph outline.                           |
| `characterSet` | `string \| string[] \| Set<string> \| 'auto'` | `'auto'`              | Characters baked into the font atlas (`TextLayer` `characterSet`). **Diverges from upstream's ASCII 32–127 default** — see below.                                                         |

**`characterSet: 'auto'` is a deliberate divergence.** Upstream `TextLayer`
defaults to ASCII 32–127; STT label columns hold arbitrary text (place names,
vessel names, CJK), so `'auto'` is the safe default here. And unlike deck's own
`'auto'` — which re-derives the set from the currently _visible_ rows, handing
`_updateFontAtlas` a fresh `Set` on every membership change and bumping
`styleVersion` (a full glyph re-layout) each time — this layer derives the
**exact** set from the tile's distinct label values once at decode and reuses
that array reference, so the atlas settles after the first update. Pass an
explicit set to pin it.

### Size System

| Property        | Type                               | Default            | Description                                                     |
| :-------------- | :--------------------------------- | :----------------- | :-------------------------------------------------------------- |
| `sizeScale`     | `number`                           | `1`                | Text size multiplier (`TextLayer` `sizeScale`).                 |
| `sizeUnits`     | `'pixels' \| 'meters' \| 'common'` | `'pixels'`         | Units for `size` (`TextLayer` `sizeUnits`).                     |
| `sizeMinPixels` | `number`                           | `0`                | Minimum on-screen size in pixels (`TextLayer` `sizeMinPixels`). |
| `sizeMaxPixels` | `number`                           | `MAX_SAFE_INTEGER` | Maximum on-screen size in pixels (`TextLayer` `sizeMaxPixels`). |

### Wrapping & Billboard

| Property    | Type                          | Default        | Description                                                                                            |
| :---------- | :---------------------------- | :------------- | :----------------------------------------------------------------------------------------------------- |
| `wordBreak` | `'break-word' \| 'break-all'` | `'break-word'` | Line-wrap strategy (`TextLayer` `wordBreak`). Requires a valid `maxWidth`.                             |
| `maxWidth`  | `number`                      | `-1`           | Width limit (multiples of text size) before wrapping (`TextLayer` `maxWidth`). `-1` disables wrapping. |
| `billboard` | `boolean`                     | `true`         | Whether labels always face the camera (`TextLayer` `billboard`).                                       |

### Content box (per-label clipping & alignment)

| Property                 | Type                                       | Default          | Description                                                                                                                                                                                                                                                                                                                              |
| :----------------------- | :----------------------------------------- | :--------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getContentBox`          | `[number, number, number, number] \| null` | `[0, 0, -1, -1]` | Clipping box for every label, as **meter offsets from its anchor**: `[x, y, width, height]`. Characters that overflow it are not drawn; a negative width/height disables clipping (the default). `TextLayer` `getContentBox` pass-through — **constant only**, per the accessor-alias convention (a function warns once and falls back). |
| `contentCutoffPixels`    | `[number, number]`                         | `[0, 0]`         | Minimum visible extent of the content box in screen pixels, `[width, height]`. A label whose visible box falls below either is hidden entirely, which keeps clipped labels readable.                                                                                                                                                     |
| `contentAlignHorizontal` | `'none' \| 'start' \| 'center' \| 'end'`   | `'none'`         | Horizontal alignment of the text within the **visible region** of the content box.                                                                                                                                                                                                                                                       |
| `contentAlignVertical`   | `'none' \| 'start' \| 'center' \| 'end'`   | `'none'`         | Vertical alignment of the text within the visible region of the content box.                                                                                                                                                                                                                                                             |

### Time Fades

| Property          | Type     | Default | Description                                                                                                                                                                |
| :---------------- | :------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fadeInDuration`  | `number` | `0`     | Fade-in duration (ms of playhead time) as a label enters the window — a CPU alpha ramp folded into the per-row glyph AND (when set) background/border colors. `0` pops in. |
| `fadeOutDuration` | `number` | `0`     | Fade-out duration (ms of playhead time) as a label leaves the window — a CPU alpha ramp folded into the per-row glyph + background/border colors. `0` pops out.            |

## How it works

- **Point tiles only**: tile layers whose `geometryType` is not `Point` are skipped with one named console warning.
- **Decode once, filter per frame**: each resident `(tile, layer)` pair is decoded a single time (cached by a style digest) into **flat typed arrays** — a UTF-32 code-point buffer + per-row char offsets, xyz positions, absolute `[start, end]` times, RGBA colors, optional size/angle. No per-feature row object is ever built. That set is then filtered on the CPU against the playhead every frame — a row is visible while its absolute `[startTime, endTime]` overlaps the window `[now - timeWindow/2, now + timeWindow/2]`, the same overlap test the [`TimeFilterExtension`](./time-filter-extension.md) window-mode shader runs.
- **Binary search when the tile is sorted**: when the tile declares [`timesSorted`](./binary-features.md#row-ordering-timessorted), the membership pass is two binary searches over `startTimes` (widened by the tile's longest feature duration) instead of a full scan.
- **Cheap membership signature**: the visible set is summarized by a contiguous-run token, or count + first/last + an FNV-1a hash of the indices — never by concatenating indices into a multi-KB string. An early-out reuses the previous frame's prepared payload whenever the signature is unchanged, so `updateTriggers.getText` (which upstream maps onto `updateTriggers.all` for the characters sublayer) holds steady and the per-glyph `transformParagraph` layout does not re-run. Sublayer instances are cached on the same gate, so an unchanged frame costs zero prop diffing.
- **GPU time filtering is deferred**: `TimeFilterExtension` cannot compose through `TextLayer` → `MultiIconLayer` as a zero-copy attribute — its `instanceStartTime`/`instanceEndTime` are per-FEATURE while `MultiIconLayer` instances are per-CHARACTER, and deck expands a per-object binary buffer across a row's characters only through the accessor auto-updater, which `Attribute.setBinaryValue` short-circuits past when `data.startIndices` is the array the layer already reports.
- **Fades**: when `fadeInDuration`/`fadeOutDuration` is active, the appear/disappear ramp is folded into each row's glyph color alpha and applied in lock-step to the background and border colors. The SDF glyph `outlineColor` is a layer-level uniform and does not fade.
- **Picking**: `getPickingInfo` maps a hit's index in the filtered row subset back to the original feature index and decodes that feature's binary columns into `info.object`.
- The sublayer short id for `_subLayerProps` overrides is **`text`** — one `TextLayer` per resident `(tile, layer)` pair.

## Source

[packages/layers/src/layers/core/animated-text-layer.ts](../../packages/layers/src/layers/core/animated-text-layer.ts)
