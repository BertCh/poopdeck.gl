// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedTextLayer — time-filtered map LABELS over binary POINT tiles.
 *
 * ── DECK'S BINARY `getText` INTERFACE ────────────────────────────────────────
 * `TextLayer` is a CompositeLayer that owns a `FontAtlasManager` and explodes
 * each string row into N per-character `MultiIconLayer` instances at layout
 * time — but it does NOT need CPU string rows to do it. `TextLayer._updateText`
 * has an explicit BINARY branch (`text-layer.ts:361-379`): given
 * `data = {length, startIndices, attributes: {getText: {value: Uint8Array |
 * Uint16Array | Uint32Array}}}` it derives every label — and the auto character
 * set — straight from the code points with no per-row JS accessor, then
 * forwards `data` / `startIndices` verbatim to `MultiIconLayer`
 * (`text-layer.ts:668`) where the per-OBJECT accessors are expanded per
 * character by the attribute auto-updater.
 *
 * So this layer decodes each (tile, layer) pair ONCE (cached by a style digest)
 * into FLAT typed arrays — a UTF-32 code-point buffer + per-row char offsets,
 * xyz positions, absolute [start, end] times, RGBA colours, optional size /
 * angle — and never materializes a per-feature row OBJECT. The per-frame time
 * filter is a CPU membership test (TextLayer has no per-instance time
 * attribute), and the visible subset is handed over as deck's binary
 * `getText` payload plus index-based accessors that read the flat arrays
 * through a `Uint32Array` of feature indices.
 *
 * A row is visible while its absolute `[startTime, endTime]` overlaps
 * `[now - timeWindow/2, now + timeWindow/2]` — the SAME overlap test the
 * TimeFilterExtension's window-mode shader runs
 * (`!(endTime < now - half || startTime > now + half)`) — with the same
 * `fadeInDuration` / `fadeOutDuration` alpha ramps folded into the per-row
 * colour. When the tile declares `timesSorted`, the membership pass is two
 * binary searches over `startTimes` (widened by the tile's longest feature
 * duration) instead of a full scan.
 *
 * Membership is summarized by a CHEAP signature (a contiguous-run token, or
 * count + first/last + an FNV-1a hash of the indices) — never by concatenating
 * indices into a multi-KB string — and an early-out reuses the previous frame's
 * prepared payload whenever it is unchanged, so `updateTriggers.getText` (which
 * upstream maps onto `updateTriggers.all` for the characters sublayer,
 * `text-layer.ts:653`) holds steady and the per-glyph `transformParagraph`
 * layout does not re-run. Sublayer INSTANCES are cached on the same gate, the
 * way the sibling icon layer caches its `IconLayer`s, so an unchanged frame
 * costs zero prop diffing.
 *
 * Like {@link AnimatedBoundingBoxLayer} we force a `renderLayers()` pass each
 * tick (`_handleTimeUpdate`) because the animation lives in a CPU-computed
 * membership the base class would otherwise never recompute (its point / path /
 * trips siblings animate via a shader uniform).
 *
 * ── DEFERRED: GPU time filtering ─────────────────────────────────────────────
 * `TimeFilterExtension` cannot compose through TextLayer → MultiIconLayer as a
 * zero-copy attribute. Its `instanceStartTime` / `instanceEndTime` are
 * per-FEATURE, but MultiIconLayer instances are per-CHARACTER, and deck expands
 * a per-object binary buffer across a row's characters only through the
 * accessor auto-updater — `Attribute.setBinaryValue` short-circuits to
 * `setData` when `data.startIndices` is the same array the layer reports from
 * `getStartIndices()` (`attribute.ts:386`), which is exactly the case here, so
 * a per-feature time buffer would bind raw against a per-character attribute.
 * Feeding the times through JS accessors instead would restore correctness but
 * re-introduce the per-row accessor cost this layer exists to avoid, and the
 * extension's shader hooks would still need validating against MultiIconLayer's
 * own `vs`/`fs`. The CPU membership test above is the filter; the GPU half is
 * deferred.
 *
 * ── DIVERGENCE (accessor-alias convention) ───────────────────────────────────
 * Per-feature JS function accessors are NOT supported — every styling prop is a
 * CONSTANT or a baked-COLUMN-name (see lib/accessor-alias.ts). The upstream
 * `getText`/`getColor`/`getSize`/`getAngle`/`getBackgroundColor`/
 * `getBorderColor`/`getBorderWidth` names are accepted as aliases with that same
 * value domain; a function value warns once and falls back.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`text`** — one TextLayer
 * per resident (tile, layer) pair.
 */

import { TextLayer } from '@deck.gl/layers';
import type {
  Color,
  DefaultProps,
  GetPickingInfoParams,
  Layer,
  LayerContext,
} from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
  SpatioTemporalPickingInfo,
} from '../spatiotemporal-layer.js';
import { emit } from '../../lib/telemetry.js';
import {
  colorMappingDigest,
  inheritedPropsDigest,
  structuralDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import {
  buildLayerPropsKey,
  type PropEffects,
} from '../../lib/layer-props-key.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
} from '../../lib/accessor-alias.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
import { GeometryType, getFeatureProperties } from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** deck.gl's default label font — kept as our default for prop parity. */
const DEFAULT_FONT_FAMILY = 'Monaco, monospace';

/** deck TextLayer `getColor` default. */
const DEFAULT_TEXT_COLOR: Color = [0, 0, 0, 255];

/** deck TextLayer `lineHeight` default. */
const DEFAULT_LINE_HEIGHT = 1.0;

/** Props added by {@link AnimatedTextLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedTextLayerProps}). */
export interface _AnimatedTextLayerProps {
  /**
   * Property column NAME whose per-feature value is drawn as each label's text.
   * Reads a categorical (string) column; a numeric column is formatted (see
   * {@link textPrecision}). Rows whose value is absent/empty draw NOTHING and
   * are dropped from the visible set — they contribute no glyphs, and deck's
   * binary-text reader mis-slices a leading run of zero-length rows
   * (`startIndices[i + 1] || characterCount`, `text-layer/utils.ts:392`).
   * @default 'text'
   */
  textProperty?: string;

  /**
   * Upstream-vocabulary alias of {@link textProperty}. Accepts a property-column
   * NAME (STRING) — NOT a function accessor (STT tiles are binary columns; a
   * function warns once and falls back to `textProperty`). When set, it wins
   * over `textProperty`.
   */
  getText?: string | ((d: unknown) => unknown) | null;

  /**
   * Decimal places used when {@link textProperty} names a NUMERIC column.
   * `null` (the default) prints the SHORTEST decimal string that round-trips
   * back to the stored `float32` — without it `String(v)` renders a `1.1`
   * stored as float32 as `1.100000023841858`, which is both wrong on screen and
   * inflates the derived character set. A number pins `toFixed(n)` instead.
   * @default null
   */
  textPrecision?: number | null;

  /**
   * Label color — a constant {@link Color}, or a property-column NAME resolved
   * through {@link colorMapping} for categorical coloring.
   * @default [0, 0, 0, 255]
   */
  color?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link color}. Accepts a constant Color OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `color`). When set, it wins over `color`.
   */
  getColor?: ColorAccessorValue | null;

  /**
   * Category → color map used when {@link color}/{@link getColor} names a column.
   * Keyed by the raw category string value. Categories absent from the map fall
   * back to {@link colorMappingDefault}. Resolution costs ONE lookup per
   * distinct CATEGORY per tile, not one per feature.
   */
  colorMapping?: Record<string, Color> | null;

  /**
   * Color for categories not present in {@link colorMapping} (and whenever a
   * column color path finds no match). Transparent by default so unmapped
   * labels disappear rather than render a misleading color.
   * @default [0, 0, 0, 0]
   */
  colorMappingDefault?: Color;

  /**
   * Label size — a constant number, or a property-column NAME for per-feature
   * size (numeric column). Interpreted in {@link sizeUnits}.
   * @default 32
   */
  size?: number | string;

  /**
   * Upstream-vocabulary alias of {@link size}. Accepts a constant number OR a
   * property-column NAME — NOT a function accessor (warns once + falls back to
   * `size`). When set, it wins over `size`.
   */
  getSize?: NumericAccessorValue | null;

  /**
   * Label rotation in DEGREES — a constant number, or a property-column NAME for
   * per-feature angle (numeric column).
   * @default 0
   */
  angle?: number | string;

  /**
   * Upstream-vocabulary alias of {@link angle}. Accepts a constant number OR a
   * property-column NAME — NOT a function accessor (warns once + falls back to
   * `angle`). When set, it wins over `angle`.
   */
  getAngle?: NumericAccessorValue | null;

  /**
   * Horizontal anchor — TextLayer `getTextAnchor` pass-through (constant).
   * @default 'middle'
   */
  getTextAnchor?: 'start' | 'middle' | 'end';

  /**
   * Vertical alignment — TextLayer `getAlignmentBaseline` pass-through (constant).
   * @default 'center'
   */
  getAlignmentBaseline?: 'top' | 'center' | 'bottom';

  /**
   * Pixel offset `[x, y]` from the anchor — TextLayer `getPixelOffset`
   * pass-through (constant).
   * @default [0, 0]
   */
  getPixelOffset?: readonly [number, number];

  /**
   * Whether to render a background rectangle behind each label.
   * @default false
   */
  background?: boolean;

  /**
   * Background rectangle color. NAMING NOTE: upstream's `backgroundColor` is a
   * DEPRECATED alias of `background` + `getBackgroundColor`; this prop is the
   * legacy STT name for the modern `getBackgroundColor` accessor and is
   * forwarded there (never as `backgroundColor`, which would trip deck's
   * deprecation path). Prefer {@link getBackgroundColor}.
   * @default [255, 255, 255, 255]
   */
  backgroundColor?: Color;

  /**
   * Upstream-vocabulary alias of {@link backgroundColor}. A constant Color —
   * NOT a function accessor (a function warns once and falls back). When set,
   * it wins over `backgroundColor`.
   */
  getBackgroundColor?: ColorAccessorValue | null;

  /**
   * Padding around the text for the background, `[x, y]` or
   * `[left, top, right, bottom]` in pixels — TextLayer `backgroundPadding`.
   * Only effective when no content box is set.
   * @default [0, 0, 0, 0]
   */
  backgroundPadding?:
    | readonly [number, number]
    | readonly [number, number, number, number];

  /**
   * Corner radius of the background rectangle in pixels — a single number for
   * all corners, or `[bottom_right, top_right, bottom_left, top_left]`.
   * TextLayer `backgroundBorderRadius` pass-through.
   * @default 0
   */
  backgroundBorderRadius?: number | readonly [number, number, number, number];

  /**
   * Background border color — the legacy STT name for upstream's
   * `getBorderColor` accessor, which is what it is forwarded as.
   * Prefer {@link getBorderColor}.
   * @default [0, 0, 0, 255]
   */
  borderColor?: Color;

  /**
   * Upstream-vocabulary alias of {@link borderColor}. A constant Color — NOT a
   * function accessor. When set, it wins over `borderColor`.
   */
  getBorderColor?: ColorAccessorValue | null;

  /**
   * Background border width in pixels — the legacy STT name for upstream's
   * `getBorderWidth` accessor, which is what it is forwarded as.
   * Prefer {@link getBorderWidth}.
   * @default 0
   */
  borderWidth?: number;

  /**
   * Upstream-vocabulary alias of {@link borderWidth}. A constant number — NOT a
   * function accessor. When set, it wins over `borderWidth`.
   */
  getBorderWidth?: NumericAccessorValue | null;

  /**
   * SDF outline color around glyphs — TextLayer `outlineColor` pass-through.
   * Only effective when `fontSettings.sdf` is true. NOTE: this is a layer-level
   * uniform, so unlike the glyph/background/border colours it is NOT faded by
   * {@link fadeInDuration}/{@link fadeOutDuration} — a faded SDF outline would
   * need a custom per-instance uniform.
   * @default [0, 0, 0, 255]
   */
  outlineColor?: Color;

  /**
   * SDF outline width (relative to text size) — TextLayer `outlineWidth`
   * pass-through. Only effective when `fontSettings.sdf` is true.
   * @default 0
   */
  outlineWidth?: number;

  /**
   * CSS font family — TextLayer `fontFamily` pass-through.
   * @default 'Monaco, monospace'
   */
  fontFamily?: string;

  /**
   * CSS font weight — TextLayer `fontWeight` pass-through.
   * @default 'normal'
   */
  fontWeight?: number | string;

  /**
   * Unitless multiplier of the text size that sets the LINE HEIGHT of a wrapped
   * / multi-line label — TextLayer `lineHeight` pass-through. Without it,
   * multi-line labels (see {@link maxWidth}) are unstylable.
   * @default 1
   */
  lineHeight?: number;

  /**
   * Font atlas tuning (`sdf`, `fontSize`, `buffer`, …) — TextLayer
   * `fontSettings` pass-through. Set `{ sdf: true }` to enable the
   * `outlineWidth`/`outlineColor` glyph outline.
   * @default {}
   */
  fontSettings?: Record<string, unknown>;

  /**
   * The set of characters baked into the font atlas — TextLayer `characterSet`
   * pass-through.
   *
   * DELIBERATE DIVERGENCE from upstream's ASCII 32-127 default: STT label
   * columns hold arbitrary text (place names, vessel names, CJK), so `'auto'`
   * is the safe default. Unlike deck's own `'auto'` — which re-derives the set
   * from the currently VISIBLE rows, handing `_updateFontAtlas` a fresh `Set`
   * on every membership change and bumping `styleVersion` (a full glyph
   * re-layout) each time — this layer derives the EXACT set from the tile's
   * distinct label values once at decode and reuses that array reference, so
   * the atlas settles after the first update. Pass an explicit set to pin it.
   * @default 'auto'
   */
  characterSet?: string | string[] | Set<string> | 'auto';

  /**
   * Text size multiplier — TextLayer `sizeScale` pass-through.
   * @default 1
   */
  sizeScale?: number;

  /**
   * Units for {@link size} — TextLayer `sizeUnits` pass-through.
   * @default 'pixels'
   */
  sizeUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Minimum on-screen size in pixels — TextLayer `sizeMinPixels` pass-through.
   * @default 0
   */
  sizeMinPixels?: number;

  /**
   * Maximum on-screen size in pixels — TextLayer `sizeMaxPixels` pass-through.
   * @default Number.MAX_SAFE_INTEGER
   */
  sizeMaxPixels?: number;

  /**
   * Line-wrap strategy (`'break-word'` | `'break-all'`) — TextLayer `wordBreak`
   * pass-through. Requires a valid {@link maxWidth}.
   * @default 'break-word'
   */
  wordBreak?: 'break-word' | 'break-all';

  /**
   * Width limit (multiples of text size) before wrapping — TextLayer `maxWidth`
   * pass-through. `-1` disables wrapping.
   * @default -1
   */
  maxWidth?: number;

  /**
   * Clipping box for every label, as meter offsets from its anchor:
   * `[x, y, width, height]`. Characters that overflow it are not drawn; a
   * negative width/height disables clipping. TextLayer `getContentBox`
   * pass-through — CONSTANT only, per the accessor-alias convention (a function
   * warns once and falls back).
   * @default [0, 0, -1, -1]
   */
  getContentBox?:
    | readonly [number, number, number, number]
    | ((d: unknown) => unknown)
    | null;

  /**
   * Minimum visible extent of the content box in screen pixels, `[width,
   * height]`. A label whose visible box falls below either is hidden entirely,
   * which keeps clipped labels readable. TextLayer `contentCutoffPixels`
   * pass-through.
   * @default [0, 0]
   */
  contentCutoffPixels?: readonly [number, number];

  /**
   * Horizontal alignment of the text within the VISIBLE region of the content
   * box — TextLayer `contentAlignHorizontal` pass-through.
   * @default 'none'
   */
  contentAlignHorizontal?: 'none' | 'start' | 'center' | 'end';

  /**
   * Vertical alignment of the text within the VISIBLE region of the content
   * box — TextLayer `contentAlignVertical` pass-through.
   * @default 'none'
   */
  contentAlignVertical?: 'none' | 'start' | 'center' | 'end';

  /**
   * Whether labels always face the camera — TextLayer `billboard` pass-through.
   * @default true
   */
  billboard?: boolean;

  /**
   * Fade-in duration (ms of playhead time) as a label enters the window — a CPU
   * alpha ramp folded into the per-row glyph color AND (when set) the
   * background/border colours so they fade in lock-step. `0` pops in. (The SDF
   * glyph {@link outlineColor} is a uniform and does not fade.)
   * @default 0
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration (ms of playhead time) as a label leaves the window — a CPU
   * alpha ramp folded into the per-row glyph + background/border colours. `0`
   * pops out.
   * @default 0
   */
  fadeOutDuration?: number;
}

/** Complete props accepted by {@link AnimatedTextLayer}. */
export type AnimatedTextLayerProps = _AnimatedTextLayerProps &
  SpatioTemporalLayerProps;

/**
 * Sublayer-cache effect of every own prop, exhaustive by type: a prop added to
 * {@link _AnimatedTextLayerProps} without an entry here fails to compile.
 *
 * `'sublayer'` — read by {@link AnimatedTextLayer.buildTextSublayer}, so a
 * cached `TextLayer` freezes the value (deck never diffs the props of a layer
 * instance handed back unchanged) and a change must drop the sublayer cache.
 * The fade durations count: they feed the per-row ramp the colour accessors
 * close over.
 *
 * `'prepare'` — read only by `decodeTile`, where the value is baked into the
 * tile's flat columns. Each is a component of
 * {@link AnimatedTextLayer.computeStyleKey} (`textProperty`/`getText` via
 * `textValue()`, `color`/`getColor` as both the column name and the constant,
 * `colorMapping` via `colorMappingDigest`, `colorMappingDefault` verbatim), and
 * a decode replaces the tile's visible-set identity, which is what invalidates
 * its sublayer. Moving one of these to `'sublayer'` is safe; moving a
 * `'sublayer'` prop here is only safe while `styleKey` genuinely contains it.
 *
 * The accessor-alias props (`size`, `angle`, `backgroundColor`, `borderColor`,
 * `borderWidth`, `getContentBox`) are keyed on their RESOLVED value, and
 * `characterSet` on a `Set`-aware digest, through the `overrides` channel — see
 * {@link AnimatedTextLayer.computeLayerPropsKey}.
 */
const TEXT_PROP_EFFECTS: PropEffects<_AnimatedTextLayerProps> = {
  textProperty: 'prepare',
  getText: 'prepare',
  textPrecision: 'prepare',
  color: 'prepare',
  getColor: 'prepare',
  colorMapping: 'prepare',
  colorMappingDefault: 'prepare',
  size: 'sublayer',
  getSize: 'sublayer',
  angle: 'sublayer',
  getAngle: 'sublayer',
  getTextAnchor: 'sublayer',
  getAlignmentBaseline: 'sublayer',
  getPixelOffset: 'sublayer',
  background: 'sublayer',
  backgroundColor: 'sublayer',
  getBackgroundColor: 'sublayer',
  backgroundPadding: 'sublayer',
  backgroundBorderRadius: 'sublayer',
  borderColor: 'sublayer',
  getBorderColor: 'sublayer',
  borderWidth: 'sublayer',
  getBorderWidth: 'sublayer',
  outlineColor: 'sublayer',
  outlineWidth: 'sublayer',
  fontFamily: 'sublayer',
  fontWeight: 'sublayer',
  lineHeight: 'sublayer',
  fontSettings: 'sublayer',
  characterSet: 'sublayer',
  sizeScale: 'sublayer',
  sizeUnits: 'sublayer',
  sizeMinPixels: 'sublayer',
  sizeMaxPixels: 'sublayer',
  wordBreak: 'sublayer',
  maxWidth: 'sublayer',
  getContentBox: 'sublayer',
  contentCutoffPixels: 'sublayer',
  contentAlignHorizontal: 'sublayer',
  contentAlignVertical: 'sublayer',
  billboard: 'sublayer',
  fadeInDuration: 'sublayer',
  fadeOutDuration: 'sublayer',
};

/**
 * One tile decoded into FLAT columns — no per-feature row objects. Cached by a
 * style digest so a re-style (or a column swap) rebuilds and everything else
 * reuses the same arrays.
 */
interface DecodedTile {
  tileKey: string;
  styleKey: string;
  count: number;
  /** `[x, y, z]` per feature (`count * 3`). */
  positions: Float64Array;
  /** Absolute keyframe times (relative tile times + `timeOffset`). */
  startTimes: Float64Array;
  endTimes: Float64Array;
  /** Longest `end - start` in the tile — widens the sorted-path lower bound. */
  maxDuration: number;
  /** Tile declares its rows stable-sorted by `start_time` (spec §5.2.3). */
  timesSorted: boolean;
  /** Base RGBA per feature (`count * 4`), from a per-CATEGORY colour table. */
  colors: Uint8Array;
  /** Per-feature size / angle, only when the prop names a numeric column. */
  sizes: Float32Array | null;
  angles: Float32Array | null;
  /** Flat UTF-32 code points; row `i` spans `[charStarts[i], charStarts[i+1])`. */
  codePoints: Uint32Array;
  charStarts: Uint32Array;
  /** Exact glyph set for this tile, or null when the caller pinned `characterSet`. */
  characterSet: string[] | null;
  tile: Tile;
  features: BinaryFeatures;
  layerName: string;
}

/** The visible subset of one tile, rebuilt only when MEMBERSHIP changes. */
interface VisibleSet {
  /** Cheap membership signature (see {@link AnimatedTextLayer.buildVisible}). */
  sig: string;
  /** Source feature index per visible row. */
  indices: Uint32Array;
  n: number;
  /** Per-row appear/disappear ramp in [0,1]; rewritten in place each frame. */
  fades: Float32Array;
  /** True while at least one row's ramp is below 1 THIS frame. */
  anyFading: boolean;
  /** deck's binary `getText` payload for this subset (reference-stable). */
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: { getText: { value: Uint32Array } };
  };
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Shortest decimal string that round-trips back to the same `float32`.
 *
 * `numericProps` are `Float32Array`, so `String(v)` prints the float64 widening
 * of the stored float32 — a `1.1` label renders as `1.100000023841858`, and
 * every one of those digits lands in the derived character set. Search
 * precisions 1-9 (float32 needs at most 9 significant digits to round-trip) and
 * take the first that survives `Math.fround`; `Number(...)` then normalizes
 * `"1.100"` to `1.1`.
 */
function shortestFloat32String(v: number): string {
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(v.toPrecision(p));
    if (Math.fround(candidate) === v) return String(candidate);
  }
  return String(v);
}

/** Append `s`'s code points to `out`, recording its glyphs in `chars`. */
function pushCodePoints(
  s: string,
  out: Uint32Array,
  at: number,
  chars: Set<string> | null,
): number {
  let w = at;
  for (const ch of s) {
    out[w++] = ch.codePointAt(0) as number;
    if (chars) chars.add(ch);
  }
  return w;
}

/** Number of CODE POINTS in `s` (surrogate pairs count once). */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) i++;
    n++;
  }
  return n;
}

/**
 * Content digest of a `characterSet` prop. A `Set` has no own enumerable keys,
 * so the generic `structuralDigest` collapses every Set to `{}` — swapping one
 * pinned set for another would then never rebuild the sublayers and the new set
 * would never reach deck.
 */
function characterSetDigest(
  cs: string | string[] | Set<string> | 'auto' | null | undefined,
): string {
  if (cs === null || cs === undefined) return '';
  if (typeof cs === 'string') return cs;
  if (Array.isArray(cs)) return cs.join(' ');
  if (cs instanceof Set) return Array.from(cs).join(' ');
  return structuralDigest(cs);
}

/** First index in `[0, n)` whose value is `>= v`; `n` when none is. */
function lowerBound(a: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index in `[0, n)` whose value is `> v`; `n` when none is. */
function upperBound(a: Float64Array, n: number, v: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Animated text-label layer — time-filtered TextLayer sublayers over deck's
 * binary `getText` interface, one per resident (tile, layer) pair. See the file
 * header for the decode-once / filter-per-frame model.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`text`**.
 */
export class AnimatedTextLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_AnimatedTextLayerProps>> {
  static layerName = 'AnimatedTextLayer';

  static defaultProps: DefaultProps<AnimatedTextLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    // Plain-string default (deck's DefaultProps typing has no 'string'
    // descriptor; a bare value IS the default).
    textProperty: 'text',
    // Accessor-named alias: unset by default so `textProperty` wins unless the
    // caller opts into the upstream vocabulary. Permissive descriptor — legally
    // holds a column-name string OR (rejected) a function.
    getText: { type: 'object', value: null, optional: true, compare: true },
    textPrecision: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },

    // Color: constant Color OR column name — permissive descriptor
    // ({type:'object'}), which the 'color' validator would reject for a string.
    color: { type: 'object', value: DEFAULT_TEXT_COLOR, compare: true },
    getColor: { type: 'object', value: null, optional: true, compare: true },
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    colorMappingDefault: { type: 'color', value: [0, 0, 0, 0] },

    // Size / angle: constant OR column name — permissive descriptor.
    size: { type: 'object', value: 32, compare: true },
    getSize: { type: 'object', value: null, optional: true, compare: true },
    angle: { type: 'object', value: 0, compare: true },
    getAngle: { type: 'object', value: null, optional: true, compare: true },

    // Constant TextLayer accessor pass-throughs.
    getTextAnchor: 'middle',
    getAlignmentBaseline: 'center',
    getPixelOffset: { type: 'array', value: [0, 0], compare: true },

    // Background + border. The upstream accessor NAMES are aliases of the
    // legacy STT names (permissive descriptors — they may hold a Color or, when
    // misused, a function that warns once).
    background: false,
    backgroundColor: { type: 'color', value: [255, 255, 255, 255] },
    getBackgroundColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    backgroundPadding: { type: 'array', value: [0, 0, 0, 0], compare: true },
    backgroundBorderRadius: { type: 'object', value: 0, compare: true },
    borderColor: { type: 'color', value: [0, 0, 0, 255] },
    getBorderColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    borderWidth: { type: 'number', value: 0, min: 0 },
    getBorderWidth: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },

    // SDF outline.
    outlineColor: { type: 'color', value: [0, 0, 0, 255] },
    outlineWidth: { type: 'number', value: 0, min: 0 },

    // Font.
    fontFamily: DEFAULT_FONT_FAMILY,
    fontWeight: { type: 'object', value: 'normal', compare: true },
    lineHeight: { type: 'number', value: DEFAULT_LINE_HEIGHT, min: 0 },
    fontSettings: { type: 'object', value: {}, compare: true },
    characterSet: { type: 'object', value: 'auto', compare: true },

    // Size system.
    sizeScale: { type: 'number', value: 1, min: 0 },
    sizeUnits: 'pixels',
    sizeMinPixels: { type: 'number', value: 0, min: 0 },
    sizeMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },

    // Wrapping.
    wordBreak: 'break-word',
    maxWidth: { type: 'number', value: -1 },

    // Content box (per-label clipping + alignment).
    getContentBox: {
      type: 'object',
      value: [0, 0, -1, -1],
      compare: true,
    },
    contentCutoffPixels: { type: 'array', value: [0, 0], compare: true },
    contentAlignHorizontal: 'none',
    contentAlignVertical: 'none',

    billboard: true,

    // CPU appear/disappear fade — off by default (while a row is actually
    // ramping, its colour re-uploads every frame; see buildTextSublayer).
    fadeInDuration: { type: 'number', value: 0, min: 0 },
    fadeOutDuration: { type: 'number', value: 0, min: 0 },
  };

  /** Per-tile decoded flat-column cache. Pruned to the live tile set each render. */
  private decodedCache = new Map<string, DecodedTile>();
  /** Per-tile visible subset + membership signature. Rebuilt only on a real change. */
  private visibleCache = new Map<string, VisibleSet>();
  /**
   * Per-tile sublayer-instance cache — the discipline the sibling icon layer
   * uses. Without it every tile built a fresh TextLayer + fresh accessor
   * closures + a fresh `updateTriggers` object per FRAME, and deck compares
   * function props by identity, so `propsChanged` was truthy every frame and a
   * full `updateState` cascade ran across TextLayer + MultiIconLayer +
   * TextBackgroundLayer. Gated on the visible-set identity, the layer-level
   * prop digest AND the colour signature (which advances only while a row is
   * actually fading).
   */
  private sublayerCache = new Map<
    string,
    {
      layer: TextLayer;
      visible: VisibleSet;
      layerPropsKey: string;
      colorSig: string;
    }
  >();
  /** Digest of every prop baked into a sublayer at construction time. */
  private lastLayerPropsKey = '';
  /** Tile-array identity from the previous render (prune only on a real change). */
  private lastTilesRef: Tile[] | null = null;
  /** Sim-time of the last CPU re-filter; skips redundant identical ticks. */
  private lastFrameTime = NaN;

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.decodedCache.clear();
    this.visibleCache.clear();
    this.sublayerCache.clear();
    this.lastTilesRef = null;
  }

  /**
   * Force a renderLayers() pass whenever sim-time advances so the CPU time
   * filter re-runs. The base class is redraw-only on time (its point/path/trips
   * siblings animate via a shader uniform); ours animates via a CPU-computed
   * membership only renderLayers() recomputes — so mirror
   * {@link AnimatedBoundingBoxLayer} and bump a state counter. The pass itself
   * early-outs when membership is unchanged. `super()` keeps `_currentTime` live
   * and the tileset throttle intact.
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    const { tiles } = this.state;
    if (tiles && tiles.length > 0 && time !== this.lastFrameTime) {
      this.lastFrameTime = time;
      this.setState({ textFrame: ((this.state as any).textFrame || 0) + 1 });
    }
  }

  /* ── Accessor-alias resolution (audit B1) ──────────────────────────────── */

  private textValue(): string {
    return resolveAccessorAlias<string>(
      'AnimatedTextLayer',
      'getText',
      this.props.getText,
      this.props.textProperty ?? 'text',
    );
  }

  private colorValue(): Color | string {
    return resolveAccessorAlias<Color | string>(
      'AnimatedTextLayer',
      'getColor',
      this.props.getColor,
      this.props.color ?? DEFAULT_TEXT_COLOR,
    );
  }

  private sizeValue(): number | string {
    return resolveAccessorAlias<number | string>(
      'AnimatedTextLayer',
      'getSize',
      this.props.getSize,
      this.props.size ?? 32,
    );
  }

  private angleValue(): number | string {
    return resolveAccessorAlias<number | string>(
      'AnimatedTextLayer',
      'getAngle',
      this.props.getAngle,
      this.props.angle ?? 0,
    );
  }

  private backgroundColorValue(): Color {
    return resolveAccessorAlias<Color>(
      'AnimatedTextLayer',
      'getBackgroundColor',
      this.props.getBackgroundColor as Color | null | undefined,
      (this.props.backgroundColor ?? [255, 255, 255, 255]) as Color,
    );
  }

  private borderColorValue(): Color {
    return resolveAccessorAlias<Color>(
      'AnimatedTextLayer',
      'getBorderColor',
      this.props.getBorderColor as Color | null | undefined,
      (this.props.borderColor ?? [0, 0, 0, 255]) as Color,
    );
  }

  private borderWidthValue(): number {
    return resolveAccessorAlias<number>(
      'AnimatedTextLayer',
      'getBorderWidth',
      this.props.getBorderWidth as number | null | undefined,
      this.props.borderWidth ?? 0,
    );
  }

  private contentBoxValue(): readonly [number, number, number, number] {
    return resolveAccessorAlias<readonly [number, number, number, number]>(
      'AnimatedTextLayer',
      'getContentBox',
      this.props.getContentBox as
        | readonly [number, number, number, number]
        | null
        | undefined,
      [0, 0, -1, -1],
    );
  }

  /**
   * Digest of the props that change the DECODED columns: which columns are read
   * (text/color/size/angle), the numeric text formatting, the baked colour
   * mapping, and whether the character set is derived or pinned. Constant
   * render-only bits ride {@link computeLayerPropsKey} instead.
   */
  private computeStyleKey(): string {
    const colorValue = this.colorValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const constColor = Array.isArray(colorValue) ? colorValue.join(',') : '';
    const sizeValue = this.sizeValue();
    const angleValue = this.angleValue();
    const mapping = this.props.colorMapping;
    return [
      this.textValue(),
      this.props.textPrecision ?? '',
      colorProp,
      constColor,
      colorProp ? (mapping ? `m${colorMappingDigest(mapping)}` : 'g') : '',
      Array.isArray(this.props.colorMappingDefault)
        ? this.props.colorMappingDefault.join(',')
        : '',
      typeof sizeValue === 'string' ? sizeValue : '',
      typeof angleValue === 'string' ? angleValue : '',
      // The derived character set is baked into the decoded tile, so pinning /
      // un-pinning `characterSet` has to re-decode.
      this.props.characterSet === 'auto' ? 'auto' : 'pinned',
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  /**
   * Digest of every layer-level prop baked into a sublayer at construction
   * time. A change here throws away the whole sublayer-instance cache — without
   * that, a restyle would only reach tiles that happened to rebuild.
   *
   * Which props participate is decided by {@link TEXT_PROP_EFFECTS} rather than
   * by an enumeration here, so a new prop cannot silently miss the key. The
   * remaining inputs are not props of this layer at all — the inherited
   * composite/time props ride the positional `extra` channel.
   */
  private computeLayerPropsKey(): string {
    return buildLayerPropsKey<_AnimatedTextLayerProps>(
      this.props,
      TEXT_PROP_EFFECTS,
      {
        overrides: {
          // The sublayer is built from the RESOLVED alias value, so the key has
          // to track it: keying the raw prop leaves every cached sublayer stale
          // when only the alias changes.
          size: this.sizeValue(),
          angle: this.angleValue(),
          backgroundColor: this.backgroundColorValue(),
          borderColor: this.borderColorValue(),
          borderWidth: this.borderWidthValue(),
          getContentBox: this.contentBoxValue(),
          // A `Set` has no own enumerable keys, so a generic structural digest
          // collapses every pinned set to the same token and a swap would never
          // reach deck.
          characterSet: characterSetDigest(this.props.characterSet),
        },
        extra: [
          // Composite props getSubLayerProps bakes into every sublayer, plus
          // the user's updateTriggers.
          inheritedPropsDigest(this.props),
          updateTriggersDigest(this.props.updateTriggers),
          // Inherited time prop that sizes the CPU membership window.
          this.props.timeWindow,
        ],
      },
    );
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.decodedCache.clear();
      this.visibleCache.clear();
      this.sublayerCache.clear();
      this.lastTilesRef = null;
      return [];
    }

    // Prune caches only when the tile-array ref actually changed (mirrors the
    // point layer): the same `state.tiles` instance means the live and cached
    // sets are identical by construction.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tileLayer of tile.layers)
          live.add(makeTileKey(tile, tileLayer));
      }
      for (const key of this.decodedCache.keys()) {
        if (!live.has(key)) this.decodedCache.delete(key);
      }
      for (const key of this.visibleCache.keys()) {
        if (!live.has(key)) this.visibleCache.delete(key);
      }
      for (const key of this.sublayerCache.keys()) {
        if (!live.has(key)) this.sublayerCache.delete(key);
      }
      this.lastTilesRef = tiles;
    }

    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastLayerPropsKey) {
      this.lastLayerPropsKey = layerPropsKey;
      this.sublayerCache.clear();
    }

    const styleKey = this.computeStyleKey();
    const now = this.getCurrentTime();
    const half = (this.props.timeWindow ?? 0) / 2;
    const windowStart = now - half;
    const windowEnd = now + half;
    const fadeIn = this.props.fadeInDuration ?? 0;
    const fadeOut = this.props.fadeOutDuration ?? 0;

    const layers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const decoded = this.decodeTile(tile, tileLayer, styleKey);
        if (!decoded || decoded.count === 0) continue;

        const visible = this.buildVisible(decoded, windowStart, windowEnd);
        if (!visible) continue;
        // The ramp is re-evaluated every frame (alpha is a function of the
        // playhead) but only signals a colour re-upload while a row is ACTUALLY
        // mid-ramp — `fadeIn > 0 || fadeOut > 0` is a prop-level flag, and with
        // the default 24h `timeWindow` every row sits at fade === 1.
        this.applyFade(
          decoded,
          visible,
          windowStart,
          windowEnd,
          fadeIn,
          fadeOut,
        );
        const colorSig = visible.anyFading
          ? `${visible.sig}@${now}`
          : visible.sig;

        const cached = this.sublayerCache.get(decoded.tileKey);
        if (
          cached &&
          cached.visible === visible &&
          cached.layerPropsKey === layerPropsKey &&
          cached.colorSig === colorSig
        ) {
          layers.push(cached.layer);
          continue;
        }
        const layer = this.buildTextSublayer(decoded, visible, colorSig);
        this.sublayerCache.set(decoded.tileKey, {
          layer,
          visible,
          layerPropsKey,
          colorSig,
        });
        layers.push(layer);
      }
    }

    emit('renderLayers', {
      layer: 'AnimatedTextLayer',
      tiles: tiles.length,
      sublayers: layers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedTextLayer: ${tiles.length} tiles → ${layers.length} sublayers`,
      );
    }
    return layers;
  }

  /**
   * Decode a single tile into flat columns once, cached by `styleKey`.
   *
   * The categorical paths expand PER CATEGORY, not per feature: the colour
   * table is one `colorMapping` lookup per distinct value, and the label code
   * points are transcoded once per distinct value and then blitted. A tile of
   * 100k features over 6 categories costs 6 lookups and 6 transcodes.
   */
  private decodeTile(
    tile: Tile,
    tileLayer: TileLayer,
    styleKey: string,
  ): DecodedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;
    // Labels are anchored ONE PER FEATURE at `positions[i]`; a linestring /
    // polygon layer would silently read the first `featureCount` VERTICES of a
    // flattened vertex run and stack every label onto the first few paths.
    if (
      !expectGeometry(
        binary.geometryType,
        [GeometryType.Point],
        this.props.id,
        tileLayer.name,
      )
    ) {
      return null;
    }
    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.decodedCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) return cached;

    const count = binary.featureCount;
    const dims = binary.positionDimensions ?? 2;
    const src = binary.positions;
    const offset = binary.timeOffset;

    // Positions padded to xyz once; times rebased to absolute once.
    const positions = new Float64Array(count * 3);
    const startTimes = new Float64Array(count);
    const endTimes = new Float64Array(count);
    let maxDuration = 0;
    for (let i = 0; i < count; i++) {
      const b = i * dims;
      const o = i * 3;
      positions[o] = src[b];
      positions[o + 1] = src[b + 1];
      positions[o + 2] = dims > 2 ? src[b + 2] : 0;
      const s = binary.startTimes[i] + offset;
      const e = binary.endTimes[i] + offset;
      startTimes[i] = s;
      endTimes[i] = e;
      const d = e - s;
      if (d > maxDuration) maxDuration = d;
    }

    const chars = this.props.characterSet === 'auto' ? new Set<string>() : null;
    const { codePoints, charStarts } = this.decodeLabels(binary, count, chars);

    const sizeValue = this.sizeValue();
    const sizeProp = typeof sizeValue === 'string' ? sizeValue : '';
    const angleValue = this.angleValue();
    const angleProp = typeof angleValue === 'string' ? angleValue : '';

    const decoded: DecodedTile = {
      tileKey,
      styleKey,
      count,
      positions,
      startTimes,
      endTimes,
      maxDuration,
      timesSorted: binary.timesSorted === true,
      colors: this.decodeColors(binary, count),
      sizes: sizeProp ? (binary.numericProps[sizeProp] ?? null) : null,
      angles: angleProp ? (binary.numericProps[angleProp] ?? null) : null,
      codePoints,
      charStarts,
      // A reference-STABLE array: deck's `_updateFontAtlas` compares
      // `characterSet` by identity, so re-deriving it per frame (which deck's
      // own 'auto' does) bumps `styleVersion` and re-runs the whole glyph
      // layout every update.
      characterSet: chars ? Array.from(chars).sort() : null,
      tile,
      features: binary,
      layerName: tileLayer.name,
    };
    this.decodedCache.set(tileKey, decoded);
    // A restyle invalidated the previous visible set / sublayer for this tile.
    this.visibleCache.delete(tileKey);
    this.sublayerCache.delete(tileKey);
    return decoded;
  }

  /**
   * Transcode the label column into a flat UTF-32 buffer plus per-row offsets —
   * deck's binary `getText` payload shape. A categorical column transcodes once
   * per distinct CATEGORY and blits; a numeric column formats per row (see
   * {@link _AnimatedTextLayerProps.textPrecision}); a missing column yields
   * zero-length rows, which the visible pass drops.
   */
  private decodeLabels(
    binary: BinaryFeatures,
    count: number,
    chars: Set<string> | null,
  ): { codePoints: Uint32Array; charStarts: Uint32Array } {
    const prop = this.textValue();
    const charStarts = new Uint32Array(count + 1);

    const cat = binary.categoricalProps[prop];
    if (cat) {
      const K = cat.categories.length;
      const perCategory: Uint32Array[] = new Array(K);
      for (let k = 0; k < K; k++) {
        const value = cat.categories[k] ?? '';
        const codes = new Uint32Array(codePointLength(value));
        pushCodePoints(value, codes, 0, chars);
        perCategory[k] = codes;
      }
      let total = 0;
      for (let i = 0; i < count; i++) {
        charStarts[i] = total;
        const idx = cat.indices[i];
        total += idx === 0xffff || idx >= K ? 0 : perCategory[idx].length;
      }
      charStarts[count] = total;
      const codePoints = new Uint32Array(total);
      for (let i = 0; i < count; i++) {
        const idx = cat.indices[i];
        if (idx === 0xffff || idx >= K) continue;
        codePoints.set(perCategory[idx], charStarts[i]);
      }
      return { codePoints, charStarts };
    }

    const num = binary.numericProps[prop];
    if (num) {
      const precision = this.props.textPrecision;
      const labels: string[] = new Array(count);
      let total = 0;
      for (let i = 0; i < count; i++) {
        const v = num[i];
        const s = !Number.isFinite(v)
          ? ''
          : typeof precision === 'number'
            ? v.toFixed(precision)
            : shortestFloat32String(v);
        labels[i] = s;
        charStarts[i] = total;
        total += codePointLength(s);
      }
      charStarts[count] = total;
      const codePoints = new Uint32Array(total);
      let w = 0;
      for (let i = 0; i < count; i++) {
        w = pushCodePoints(labels[i], codePoints, w, chars);
      }
      return { codePoints, charStarts };
    }

    return { codePoints: new Uint32Array(0), charStarts };
  }

  /**
   * Base RGBA per feature. A constant colour fills once; a categorical column
   * builds a `(K + 1) × 4` table — ONE `colorMapping` lookup per distinct
   * value, with the last slot the `colorMappingDefault` used for the NULL
   * sentinel — and then blits, instead of a string-keyed lookup per feature.
   */
  private decodeColors(binary: BinaryFeatures, count: number): Uint8Array {
    const out = new Uint8Array(count * 4);
    const colorValue = this.colorValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const cat = colorProp ? binary.categoricalProps[colorProp] : undefined;

    if (!colorProp || !cat) {
      const c = (
        Array.isArray(colorValue) ? colorValue : DEFAULT_TEXT_COLOR
      ) as Color;
      const r = c[0];
      const g = c[1];
      const b = c[2];
      const a = (c[3] ?? 255) as number;
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
      }
      return out;
    }

    const mapping = this.props.colorMapping;
    const fallback = (this.props.colorMappingDefault ?? [0, 0, 0, 0]) as Color;
    const K = cat.categories.length;
    const table = new Uint8Array((K + 1) * 4);
    for (let k = 0; k <= K; k++) {
      const value = k < K ? cat.categories[k] : '';
      const c = ((value && mapping && mapping[value]) || fallback) as Color;
      const o = k * 4;
      table[o] = c[0];
      table[o + 1] = c[1];
      table[o + 2] = c[2];
      table[o + 3] = (c[3] ?? 255) as number;
    }
    for (let i = 0; i < count; i++) {
      const idx = cat.indices[i];
      const s = (idx === 0xffff || idx >= K ? K : idx) * 4;
      const o = i * 4;
      out[o] = table[s];
      out[o + 1] = table[s + 1];
      out[o + 2] = table[s + 2];
      out[o + 3] = table[s + 3];
    }
    return out;
  }

  /**
   * Resolve the visible subset of a tile for the window `[windowStart,
   * windowEnd]` — the same overlap test the TimeFilterExtension's window-mode
   * shader runs.
   *
   * Pass 1 computes only a MEMBERSHIP SIGNATURE and allocates nothing: a
   * contiguous run collapses to `r<first>:<n>`, anything else to `count`,
   * first, last plus an FNV-1a hash of the indices. (A hash rather than the
   * indices themselves: the old signature concatenated every index into a
   * multi-KB throwaway string per tile per FRAME. A 32-bit collision would hold
   * one stale membership until the next change — the accepted trade for an
   * O(1)-comparison key.) An unchanged signature returns the previous frame's
   * payload untouched, so `updateTriggers.getText` — which upstream maps onto
   * `updateTriggers.all` for the characters sublayer — holds steady and the
   * per-glyph layout does not re-run.
   *
   * When the tile declares `timesSorted`, the candidate range is two binary
   * searches over `startTimes`: rows with `startTime > windowEnd` cannot
   * overlap, and rows with `startTime < windowStart - maxDuration` cannot
   * either (their end is at most `startTime + maxDuration`). For instantaneous
   * labels (`maxDuration === 0`, the common case) that range is EXACT and the
   * whole pass is O(log n).
   *
   * Zero-length labels are excluded: they draw no glyphs, and deck's binary
   * reader mis-slices a leading run of them.
   */
  private buildVisible(
    decoded: DecodedTile,
    windowStart: number,
    windowEnd: number,
  ): VisibleSet | null {
    const { count, startTimes, endTimes, charStarts } = decoded;
    let from = 0;
    let to = count;
    if (decoded.timesSorted) {
      from = lowerBound(startTimes, count, windowStart - decoded.maxDuration);
      to = upperBound(startTimes, count, windowEnd);
    }

    let n = 0;
    let first = -1;
    let last = -1;
    let hash = 0x811c9dc5 | 0;
    for (let i = from; i < to; i++) {
      if (endTimes[i] < windowStart || startTimes[i] > windowEnd) continue;
      if (charStarts[i + 1] === charStarts[i]) continue;
      if (first < 0) first = i;
      last = i;
      n++;
      hash = Math.imul(hash ^ i, 0x01000193);
    }
    if (n === 0) {
      this.visibleCache.delete(decoded.tileKey);
      return null;
    }

    const contiguous = last - first + 1 === n;
    const sig = contiguous
      ? `r${first}:${n}`
      : `s${n}:${first}:${last}:${hash >>> 0}`;

    const prev = this.visibleCache.get(decoded.tileKey);
    if (prev && prev.sig === sig) return prev;

    const visible = this.materializeVisible(
      decoded,
      from,
      to,
      windowStart,
      windowEnd,
      n,
      sig,
      contiguous,
      first,
    );
    this.visibleCache.set(decoded.tileKey, visible);
    return visible;
  }

  /**
   * Pass 2 of {@link buildVisible} — runs ONLY when membership actually
   * changed. Materializes the feature-index list plus deck's binary `getText`
   * payload; a contiguous run shares the decoded code-point buffer zero-copy.
   */
  private materializeVisible(
    decoded: DecodedTile,
    from: number,
    to: number,
    windowStart: number,
    windowEnd: number,
    n: number,
    sig: string,
    contiguous: boolean,
    first: number,
  ): VisibleSet {
    const { startTimes, endTimes, charStarts, codePoints } = decoded;
    const indices = new Uint32Array(n);
    let w = 0;
    for (let i = from; i < to; i++) {
      if (endTimes[i] < windowStart || startTimes[i] > windowEnd) continue;
      if (charStarts[i + 1] === charStarts[i]) continue;
      indices[w++] = i;
    }

    const startIndices = new Uint32Array(n + 1);
    let total = 0;
    for (let k = 0; k < n; k++) {
      const i = indices[k];
      startIndices[k] = total;
      total += charStarts[i + 1] - charStarts[i];
    }
    startIndices[n] = total;

    let value: Uint32Array;
    if (contiguous) {
      const base = charStarts[first];
      value = codePoints.subarray(base, base + total);
    } else {
      value = new Uint32Array(total);
      for (let k = 0; k < n; k++) {
        const i = indices[k];
        value.set(
          codePoints.subarray(charStarts[i], charStarts[i + 1]),
          startIndices[k],
        );
      }
    }

    const fades = new Float32Array(n).fill(1);
    return {
      sig,
      indices,
      n,
      fades,
      anyFading: false,
      data: { length: n, startIndices, attributes: { getText: { value } } },
    };
  }

  /**
   * Recompute the per-row appear/disappear ramp for the current playhead and
   * set {@link VisibleSet.anyFading}.
   *
   * The flag is the point: with fade merely CONFIGURED (say `fadeInDuration:
   * 300` under the default 24-hour `timeWindow`) every row sits at `fade === 1`
   * and nothing visually changes, yet a prop-level `fadeIn > 0 || fadeOut > 0`
   * would still advance the colour signature every frame — invalidating
   * `getColor` on MultiIconLayer and both background accessors, an
   * O(characters) accessor sweep plus a GPU re-upload per tile per frame.
   */
  private applyFade(
    decoded: DecodedTile,
    visible: VisibleSet,
    windowStart: number,
    windowEnd: number,
    fadeIn: number,
    fadeOut: number,
  ): void {
    const { fades, indices, n } = visible;
    if (fadeIn <= 0 && fadeOut <= 0) {
      if (visible.anyFading) {
        fades.fill(1);
        visible.anyFading = false;
      }
      return;
    }
    const { startTimes, endTimes } = decoded;
    let anyFading = false;
    for (let k = 0; k < n; k++) {
      const i = indices[k];
      let fade = 1;
      if (fadeIn > 0) {
        const age = windowEnd - startTimes[i];
        if (age < fadeIn) fade *= clamp01(age / fadeIn);
      }
      if (fadeOut > 0) {
        const remaining = endTimes[i] - windowStart;
        if (remaining < fadeOut) fade *= clamp01(remaining / fadeOut);
      }
      fades[k] = fade;
      if (fade < 1) anyFading = true;
    }
    visible.anyFading = anyFading;
  }

  /**
   * Build one TextLayer over a tile's visible rows, feeding deck's binary
   * `getText` interface. Every other accessor is index-based over the flat
   * decoded columns (`objectInfo.index` → `indices[index]` → column offset),
   * writing into deck's reusable `target` array — so no per-feature row object
   * exists anywhere in this layer.
   */
  private buildTextSublayer(
    decoded: DecodedTile,
    visible: VisibleSet,
    colorSig: string,
  ): TextLayer {
    const sizeValue = this.sizeValue();
    const angleValue = this.angleValue();
    const constSize = typeof sizeValue === 'number' ? sizeValue : 32;
    const constAngle = typeof angleValue === 'number' ? angleValue : 0;
    const { indices, fades } = visible;
    const { positions, colors, sizes, angles } = decoded;
    const sig = visible.sig;

    const getPosition = (_: unknown, { index, target }: AccessorCtx) => {
      const o = indices[index] * 3;
      target[0] = positions[o];
      target[1] = positions[o + 1];
      target[2] = positions[o + 2];
      return target;
    };
    const getColor = (_: unknown, { index, target }: AccessorCtx) => {
      const o = indices[index] * 4;
      const fade = fades[index];
      target[0] = colors[o];
      target[1] = colors[o + 1];
      target[2] = colors[o + 2];
      target[3] = fade === 1 ? colors[o + 3] : Math.round(colors[o + 3] * fade);
      return target;
    };

    // The appear/disappear fade must also ride the background rectangle and
    // border, else (with `background:true`/`borderWidth>0`) they pop out
    // abruptly while the glyphs fade smoothly. Constants when nothing is
    // ramping — deck uploads a constant attribute instead of sweeping the rows.
    const bg = this.backgroundColorValue();
    const bd = this.borderColorValue();
    const fading = visible.anyFading;
    const getBackgroundColor = fading
      ? (_: unknown, { index, target }: AccessorCtx) => {
          target[0] = bg[0];
          target[1] = bg[1];
          target[2] = bg[2];
          target[3] = Math.round(((bg[3] ?? 255) as number) * fades[index]);
          return target;
        }
      : bg;
    const getBorderColor = fading
      ? (_: unknown, { index, target }: AccessorCtx) => {
          target[0] = bd[0];
          target[1] = bd[1];
          target[2] = bd[2];
          target[3] = Math.round(((bd[3] ?? 255) as number) * fades[index]);
          return target;
        }
      : bd;

    const extensions = this.composeExtensions([]);
    const props = this.composeSubLayerProps('text', decoded.tileKey, {
      // deck's binary interface: code points + per-row offsets. `_updateText`
      // takes its binary branch and derives every label with no JS accessor.
      data: visible.data as any,

      getPosition,
      getColor,
      // Per-feature size/angle read the numeric column through the index map;
      // constants ride the scalar prop. A NaN cell falls back to the constant
      // (deck's own default would be its layer default, not ours).
      getSize: sizes
        ? (_: unknown, { index }: AccessorCtx) => {
            const v = sizes[indices[index]];
            return Number.isFinite(v) ? v : constSize;
          }
        : constSize,
      getAngle: angles
        ? (_: unknown, { index }: AccessorCtx) => {
            const v = angles[indices[index]];
            return Number.isFinite(v) ? v : constAngle;
          }
        : constAngle,

      // Constant accessor pass-throughs.
      getTextAnchor: this.props.getTextAnchor,
      getAlignmentBaseline: this.props.getAlignmentBaseline,
      getPixelOffset: this.props.getPixelOffset,

      // Size system.
      sizeScale: this.props.sizeScale,
      sizeUnits: this.props.sizeUnits,
      sizeMinPixels: this.props.sizeMinPixels,
      sizeMaxPixels: this.props.sizeMaxPixels,

      // Background + border (faded per-row alongside the glyphs when active).
      background: this.props.background,
      getBackgroundColor,
      backgroundPadding: this.props.backgroundPadding,
      backgroundBorderRadius: this.props.backgroundBorderRadius,
      getBorderColor,
      getBorderWidth: this.borderWidthValue(),

      // SDF outline.
      outlineColor: this.props.outlineColor,
      outlineWidth: this.props.outlineWidth,

      // Font.
      fontFamily: this.props.fontFamily,
      fontWeight: this.props.fontWeight,
      lineHeight: this.props.lineHeight,
      fontSettings: this.props.fontSettings,
      // The tile's EXACT glyph set (reference-stable) when `characterSet` is
      // left on 'auto'; the caller's value otherwise.
      characterSet: decoded.characterSet ?? this.props.characterSet,

      // Wrapping + billboard.
      wordBreak: this.props.wordBreak,
      maxWidth: this.props.maxWidth,
      billboard: this.props.billboard,

      // Per-label content box (clipping + in-box alignment).
      getContentBox: this.contentBoxValue(),
      contentCutoffPixels: this.props.contentCutoffPixels,
      contentAlignHorizontal: this.props.contentAlignHorizontal,
      contentAlignVertical: this.props.contentAlignVertical,

      extensions,

      // TileLayer picking convention — the source tile + decoded columns ride on
      // the sublayer; `sttRowIndices` maps a visible-row hit back to its feature
      // index. (The picking walk hands the PARENT its direct child, so these
      // land on `sourceLayer.props` — see getPickingInfo.)
      tile: decoded.tile,
      sttFeatures: decoded.features,
      sttRowIndices: visible.indices,

      updateTriggers: {
        getText: sig,
        getPosition: sig,
        getSize: sig,
        getAngle: sig,
        getColor: colorSig,
        // Background/border colours carry the per-row fade too — re-upload them
        // on the same clock so they fade in lock-step with the glyphs.
        getBackgroundColor: colorSig,
        getBorderColor: colorSig,
      },
    });
    const SubLayerClass = this.getSubLayerClass('text', TextLayer);
    return new SubLayerClass(props as any);
  }

  /**
   * Picking enrichment. The TextLayer `data` is a FILTERED subset, so a hit's
   * `info.index` indexes that subset — resolve it back to the original feature
   * index through `sttRowIndices` and decode that feature's binary columns into
   * `info.object` (the base-class TileLayer contract, keyed off the row subset
   * rather than the raw feature index).
   */
  getPickingInfo({
    info,
    sourceLayer,
  }: GetPickingInfoParams): SpatioTemporalPickingInfo {
    const out = info as SpatioTemporalPickingInfo;
    const sp = sourceLayer?.props as
      | {
          tile?: Tile | null;
          sttFeatures?: BinaryFeatures;
          sttRowIndices?: Uint32Array;
        }
      | undefined;
    const tile = sp?.tile ?? null;
    out.sourceTile = tile;
    const rowIndices = sp?.sttRowIndices;
    if (
      info.index >= 0 &&
      tile &&
      rowIndices &&
      info.index < rowIndices.length
    ) {
      out.tile = tile;
      if (sp?.sttFeatures) {
        out.object =
          getFeatureProperties(sp.sttFeatures, rowIndices[info.index]) ??
          undefined;
      }
    }
    return out;
  }
}

/**
 * deck's accessor context. `target` is a per-update scratch array the attribute
 * updater reuses, so writing into it (instead of returning a fresh literal) is
 * what keeps these accessors allocation-free.
 */
interface AccessorCtx {
  index: number;
  target: number[];
}
