# AnimatedTextLayer

The `AnimatedTextLayer` renders **time-filtered map labels** at point features — each feature's text is drawn from a categorical (string) property column and shown only while the playhead is inside its keyframe window. It draws through deck.gl's `TextLayer` (`@deck.gl/layers`), one sublayer per resident tile.

It extends [`SpatioTemporalLayer`](./spatiotemporal-layer.md). Unlike its instanced siblings ([`AnimatedPointLayer`](./animated-point-layer.md), [`AnimatedIconLayer`](./animated-icon-layer.md)), `TextLayer` cannot consume the binary `{ length, attributes }` interface — it needs CPU string rows. So this layer decodes each tile's string column into a reference-stable row set **once** (cached by a style digest) and filters that set against the playhead on the **CPU** every frame. See [How it works](#how-it-works) for the decode-once / filter-per-frame model.

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
  backgroundColor: [0, 0, 0, 160],
  fontFamily: 'Inter, sans-serif',
});
```

## Properties

Inherits all properties from [`SpatioTemporalLayer`](./spatiotemporal-layer.md).

Per-feature JS function accessors are **not** supported — every styling prop is a constant or a baked column NAME. The upstream `getText` / `getColor` / `getSize` / `getAngle` names are accepted as aliases with that same value domain; passing a function warns once and falls back to the plain prop. When an alias is set, it wins over its plain counterpart.

### Text & Data Accessors

| Property              | Type                            | Default          | Description                                                                                                                                                                              |
| :-------------------- | :------------------------------ | :--------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `textProperty`        | `string`                        | `'text'`         | Property column NAME drawn as each label's text. Reads a categorical (string) column; a numeric column is stringified. Rows whose value is absent/empty still render as an empty string. |
| `getText`             | `string \| null`                | `null`           | Upstream-vocabulary alias of `textProperty`. Accepts a property-column NAME — not a function accessor. When set, it wins.                                                                |
| `color`               | `Color \| string`               | `[0, 0, 0, 255]` | Label color — a constant RGBA, or a property-column NAME resolved through `colorMapping` for categorical coloring.                                                                       |
| `getColor`            | `Color \| string \| null`       | `null`           | Upstream-vocabulary alias of `color` (constant Color or column NAME; not a function). When set, it wins.                                                                                 |
| `colorMapping`        | `Record<string, Color> \| null` | `null`           | Category-string → color map used when `color`/`getColor` names a column. Categories absent from the map fall back to `colorMappingDefault`.                                              |
| `colorMappingDefault` | `Color`                         | `[0, 0, 0, 0]`   | Color for categories not present in `colorMapping` (transparent by default, so unmapped labels disappear rather than mislead).                                                           |
| `size`                | `number \| string`              | `32`             | Label size — a constant number, or a numeric property-column NAME for per-feature size. Interpreted in `sizeUnits`.                                                                      |
| `getSize`             | `number \| string \| null`      | `null`           | Upstream-vocabulary alias of `size` (constant or numeric column NAME; not a function). When set, it wins.                                                                                |
| `angle`               | `number \| string`              | `0`              | Label rotation in DEGREES — a constant number, or a numeric property-column NAME for per-feature angle.                                                                                  |
| `getAngle`            | `number \| string \| null`      | `null`           | Upstream-vocabulary alias of `angle` (constant or numeric column NAME; not a function). When set, it wins.                                                                               |

### Layout & Anchoring

| Property               | Type                            | Default    | Description                                                                                   |
| :--------------------- | :------------------------------ | :--------- | :-------------------------------------------------------------------------------------------- |
| `getTextAnchor`        | `'start' \| 'middle' \| 'end'`  | `'middle'` | Horizontal anchor — `TextLayer` `getTextAnchor` pass-through (constant).                      |
| `getAlignmentBaseline` | `'top' \| 'center' \| 'bottom'` | `'center'` | Vertical alignment — `TextLayer` `getAlignmentBaseline` pass-through (constant).              |
| `getPixelOffset`       | `[number, number]`              | `[0, 0]`   | Pixel offset `[x, y]` from the anchor — `TextLayer` `getPixelOffset` pass-through (constant). |

### Background & Border

| Property            | Type                                                   | Default                | Description                                                                              |
| :------------------ | :----------------------------------------------------- | :--------------------- | :--------------------------------------------------------------------------------------- |
| `background`        | `boolean`                                              | `false`                | Whether to render a background rectangle behind each label.                              |
| `backgroundColor`   | `Color`                                                | `[255, 255, 255, 255]` | Background rectangle color (`TextLayer` `getBackgroundColor`).                           |
| `backgroundPadding` | `[number, number] \| [number, number, number, number]` | `[0, 0, 0, 0]`         | Padding around the text for the background, in pixels (`TextLayer` `backgroundPadding`). |
| `borderColor`       | `Color`                                                | `[0, 0, 0, 255]`       | Background border color (`TextLayer` `getBorderColor`).                                  |
| `borderWidth`       | `number`                                               | `0`                    | Background border width in pixels (`TextLayer` `getBorderWidth`).                        |

### SDF Outline

| Property       | Type     | Default          | Description                                                                                                                                                                                              |
| :------------- | :------- | :--------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outlineColor` | `Color`  | `[0, 0, 0, 255]` | SDF outline color around glyphs (`TextLayer` `outlineColor`). Only effective when `fontSettings.sdf` is `true`. This is a layer-level uniform, so it is NOT faded by `fadeInDuration`/`fadeOutDuration`. |
| `outlineWidth` | `number` | `0`              | SDF outline width relative to text size (`TextLayer` `outlineWidth`). Only effective when `fontSettings.sdf` is `true`.                                                                                  |

### Font

| Property       | Type                                          | Default               | Description                                                                                                                                                       |
| :------------- | :-------------------------------------------- | :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fontFamily`   | `string`                                      | `'Monaco, monospace'` | CSS font family (`TextLayer` `fontFamily`).                                                                                                                       |
| `fontWeight`   | `number \| string`                            | `'normal'`            | CSS font weight (`TextLayer` `fontWeight`).                                                                                                                       |
| `fontSettings` | `Record<string, unknown>`                     | `{}`                  | Font atlas tuning (`sdf`, `fontSize`, `buffer`, …) — `TextLayer` `fontSettings`. Set `{ sdf: true }` to enable the `outlineWidth`/`outlineColor` glyph outline.   |
| `characterSet` | `string \| string[] \| Set<string> \| 'auto'` | `'auto'`              | Characters baked into the font atlas (`TextLayer` `characterSet`). `'auto'` derives it from the visible labels — the safe default for arbitrary categorical text. |

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

### Time Fades

| Property          | Type     | Default | Description                                                                                                                                                                |
| :---------------- | :------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fadeInDuration`  | `number` | `0`     | Fade-in duration (ms of playhead time) as a label enters the window — a CPU alpha ramp folded into the per-row glyph AND (when set) background/border colors. `0` pops in. |
| `fadeOutDuration` | `number` | `0`     | Fade-out duration (ms of playhead time) as a label leaves the window — a CPU alpha ramp folded into the per-row glyph + background/border colors. `0` pops out.            |

## How it works

- **Decode once, filter per frame**: each resident `(tile, layer)` pair's categorical string column is decoded into a full row array `[{ position, text, startTime, endTime, color, ... }]` a single time, cached by a style digest. That row set is then filtered on the CPU against the playhead every frame — a row is visible while its absolute `[startTime, endTime]` overlaps the window `[now - timeWindow/2, now + timeWindow/2]`, the same overlap test the [`TimeFilterExtension`](./time-filter-extension.md) window-mode shader runs.
- **Reference-stable rows**: the visible set changes only when the playhead crosses a row's start or end. While the membership signature is unchanged (and no fade is animating the alpha), the filtered array's identity is kept stable frame-to-frame, so deck.gl compares `data` by reference and skips glyph re-layout and GPU re-upload.
- **Fades**: when `fadeInDuration`/`fadeOutDuration` is active, the appear/disappear ramp is folded into each row's glyph color alpha and applied in lock-step to the background and border colors. The SDF glyph `outlineColor` is a layer-level uniform and does not fade.
- **Picking**: `getPickingInfo` maps a hit's index in the filtered row subset back to the original feature index and decodes that feature's binary columns into `info.object`.
- The sublayer short id for `_subLayerProps` overrides is **`text`** — one `TextLayer` per resident `(tile, layer)` pair.

## Source

[packages/layers/src/layers/core/animated-text-layer.ts](../../packages/layers/src/layers/core/animated-text-layer.ts)
