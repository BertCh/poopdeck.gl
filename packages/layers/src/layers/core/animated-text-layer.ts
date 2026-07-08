// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedTextLayer — time-filtered map LABELS over binary POINT tiles.
 *
 * ── WHY CPU ROWS (not a binary zero-copy sublayer) ───────────────────────────
 * deck.gl's `TextLayer` is a CompositeLayer that owns a `FontAtlasManager` and
 * explodes each *string row* into N per-character `MultiIconLayer` instances at
 * layout time. It cannot consume the binary `{ length, attributes }` interface
 * the sibling animated layers hand to their leaf layers — it needs CPU string
 * ROWS with a `getText`/`getPosition` accessor, exactly like
 * {@link AnimatedBoundingBoxLayer.buildLabels} already produces internally.
 *
 * So this layer DECODES each (tile, layer) pair's categorical string column into
 * a reference-stable full row array `[{ position, text, startTime, endTime,
 * color, ... }]` ONCE (cached by a style digest), then FILTERS that row set on
 * the CPU against the playhead every frame — TextLayer is CPU-row-based, so the
 * time filter is a CPU-side membership test rather than a GPU
 * `TimeFilterExtension` uniform. A row is visible while its absolute
 * `[startTime, endTime]` overlaps the window `[now - timeWindow/2, now +
 * timeWindow/2]` — the SAME overlap test the extension's window-mode shader runs
 * (`!(endTime < now - half || startTime > now + half)`), and the same
 * `fadeInDuration`/`fadeOutDuration` alpha ramps, folded into the per-row color.
 *
 * Because the visible set changes only when the playhead crosses a row's start /
 * end, the filtered array's identity is kept STABLE frame-to-frame whenever the
 * membership signature is unchanged (and no fade is animating the alpha) — deck
 * compares `data` by reference, so an unchanged window means no glyph re-layout
 * and no GPU re-upload. Like {@link AnimatedBoundingBoxLayer} we force a
 * `renderLayers()` pass each tick (`_handleTimeUpdate`) because the animation
 * lives in a CPU-computed row set the base class would otherwise never recompute
 * (its point/path/trips siblings animate via a shader uniform).
 *
 * ── DIVERGENCE (accessor-alias convention) ───────────────────────────────────
 * Per-feature JS function accessors are NOT supported — every styling prop is a
 * CONSTANT or a baked-COLUMN-name (see lib/accessor-alias.ts). The upstream
 * `getText`/`getColor`/`getSize`/`getAngle` names are accepted as aliases with
 * that same value domain; a function value warns once and falls back. Internally
 * the decoded column values are baked into the CPU rows and read back with
 * trivial `(d) => d.field` readers — the idiom `buildLabels` already uses, and
 * the only way to feed a CPU-row TextLayer.
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
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
} from '../../lib/accessor-alias.js';
import { getFeatureProperties } from '@poopdeck.gl/core';
import type {
  Tile,
  Layer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** deck.gl's default label font — kept as our default for prop parity. */
const DEFAULT_FONT_FAMILY = 'Monaco, monospace';

/** deck TextLayer `getColor` default. */
const DEFAULT_TEXT_COLOR: Color = [0, 0, 0, 255];

/** Props added by {@link AnimatedTextLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedTextLayerProps}). */
export interface _AnimatedTextLayerProps {
  /**
   * Property column NAME whose per-feature value is drawn as each label's text.
   * Reads a categorical (string) column; a numeric column is stringified. Rows
   * whose value is absent/empty still render (as an empty string) — filter them
   * at build time if that is not wanted.
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
   * back to {@link colorMappingDefault}.
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
   * Background rectangle color (forwarded to TextLayer `getBackgroundColor`).
   * @default [255, 255, 255, 255]
   */
  backgroundColor?: Color;

  /**
   * Padding around the text for the background, `[x, y]` or
   * `[left, top, right, bottom]` in pixels — TextLayer `backgroundPadding`.
   * @default [0, 0, 0, 0]
   */
  backgroundPadding?:
    | readonly [number, number]
    | readonly [number, number, number, number];

  /**
   * Background border color (forwarded to TextLayer `getBorderColor`).
   * @default [0, 0, 0, 255]
   */
  borderColor?: Color;

  /**
   * Background border width in pixels (forwarded to TextLayer `getBorderWidth`).
   * @default 0
   */
  borderWidth?: number;

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
   * Font atlas tuning (`sdf`, `fontSize`, `buffer`, …) — TextLayer
   * `fontSettings` pass-through. Set `{ sdf: true }` to enable the
   * `outlineWidth`/`outlineColor` glyph outline.
   * @default {}
   */
  fontSettings?: Record<string, unknown>;

  /**
   * The set of characters baked into the font atlas — TextLayer `characterSet`
   * pass-through. `'auto'` derives it from the visible labels (the safe default
   * for arbitrary categorical text).
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

/** One decoded label row (the CPU unit TextLayer consumes). */
interface TextRow {
  position: [number, number, number];
  text: string;
  /** Absolute keyframe start / end (ms) — relative tile times + timeOffset. */
  startTime: number;
  endTime: number;
  /** Baked RGBA (fade == 1 in the full-tile rows; fade folded per-frame). */
  color: [number, number, number, number];
  /**
   * Per-frame appear/disappear ramp factor in [0,1] (fade mode only). Folded
   * into {@link color}'s alpha and reused to fade the background/border colours.
   */
  fade?: number;
  /** Per-feature size, only present when {@link size} names a numeric column. */
  size?: number;
  /** Per-feature angle (deg), only present when {@link angle} names a column. */
  angle?: number;
  /** Original feature index within the tile — for picking enrichment. */
  i: number;
}

/** Per-tile decoded rows, cached so the full row set is built once per style. */
interface DecodedTile {
  tileKey: string;
  styleKey: string;
  fullRows: TextRow[];
  sizeIsColumn: boolean;
  angleIsColumn: boolean;
  tile: Tile;
  features: BinaryFeatures;
  layerName: string;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/** Resolve one feature's categorical (string) column value, or '' if absent. */
function readText(binary: BinaryFeatures, prop: string, i: number): string {
  const cat = binary.categoricalProps[prop];
  if (cat) {
    const idx = cat.indices[i];
    return idx === 0xffff ? '' : (cat.categories[idx] ?? '');
  }
  const num = binary.numericProps[prop];
  if (num) {
    const v = num[i];
    return Number.isFinite(v) ? String(v) : '';
  }
  return '';
}

/** Category STRING → RGBA via colorMapping (fallback when absent/unmapped). */
function resolveColor(
  category: string,
  mapping: Record<string, Color> | null | undefined,
  fallback: Color,
): [number, number, number, number] {
  const c = (category && mapping && mapping[category]) || fallback;
  return [c[0], c[1], c[2], c[3] ?? 255];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Animated text-label layer — time-filtered CPU-row TextLayer sublayers, one per
 * resident (tile, layer) pair. See the file header for the decode-once /
 * filter-per-frame model.
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

    // Background + border.
    background: false,
    backgroundColor: { type: 'color', value: [255, 255, 255, 255] },
    backgroundPadding: { type: 'array', value: [0, 0, 0, 0], compare: true },
    borderColor: { type: 'color', value: [0, 0, 0, 255] },
    borderWidth: { type: 'number', value: 0, min: 0 },

    // SDF outline.
    outlineColor: { type: 'color', value: [0, 0, 0, 255] },
    outlineWidth: { type: 'number', value: 0, min: 0 },

    // Font.
    fontFamily: DEFAULT_FONT_FAMILY,
    fontWeight: { type: 'object', value: 'normal', compare: true },
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

    billboard: true,

    // CPU appear/disappear fade — off by default (a change re-bakes the visible
    // rows' alpha every frame; see the file header).
    fadeInDuration: { type: 'number', value: 0, min: 0 },
    fadeOutDuration: { type: 'number', value: 0, min: 0 },
  };

  /** Per-tile decoded full-row cache. Pruned to the live tile set each render. */
  private decodedCache = new Map<string, DecodedTile>();
  /** Per-tile last visible row set + membership signature, for stable refs. */
  private visibleCache = new Map<string, { sig: string; rows: TextRow[] }>();
  /**
   * Per-tile fade-mode row cache. Unlike {@link visibleCache} the alpha changes
   * every frame, but the row ARRAY + row OBJECTS (and their `color` arrays) are
   * kept reference-stable while the MEMBERSHIP (`sig`) is unchanged — only
   * `color[3]`/`fade` are mutated in place — so TextLayer's `data`-ref-triggered
   * `_updateText` glyph re-layout does NOT re-run every frame (the getColor
   * updateTrigger re-uploads just the colour).
   */
  private fadeCache = new Map<
    string,
    { sig: string; rows: TextRow[]; fulls: TextRow[] }
  >();
  /** Tile-array identity from the previous render (prune only on a real change). */
  private lastTilesRef: Tile[] | null = null;
  /** Sim-time of the last CPU re-filter; skips redundant identical ticks. */
  private lastFrameTime = NaN;

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.decodedCache.clear();
    this.visibleCache.clear();
    this.fadeCache.clear();
    this.lastTilesRef = null;
  }

  /**
   * Force a renderLayers() pass whenever sim-time advances so the CPU time
   * filter re-runs. The base class is redraw-only on time (its point/path/trips
   * siblings animate via a shader uniform); ours animates via a CPU-computed row
   * set only renderLayers() recomputes — so mirror {@link AnimatedBoundingBoxLayer}
   * and bump a state counter. `super()` keeps `_currentTime` live and the
   * tileset throttle intact.
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

  /**
   * Digest of the props that change the DECODED full-row content: which columns
   * are read (text/color/size/angle) plus the baked color palette/mapping.
   * Constant size/angle/color-render-only bits ride the sublayer props (rebuilt
   * every frame), so they are NOT in this key.
   */
  private computeStyleKey(): string {
    const textProp = this.textValue();
    const colorValue = this.colorValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const constColor = Array.isArray(colorValue) ? colorValue.join(',') : '';
    const sizeValue = this.sizeValue();
    const sizeProp = typeof sizeValue === 'string' ? sizeValue : '';
    const angleValue = this.angleValue();
    const angleProp = typeof angleValue === 'string' ? angleValue : '';
    const mapping = this.props.colorMapping;
    return [
      textProp,
      colorProp,
      constColor,
      colorProp ? (mapping ? `m${colorMappingDigest(mapping)}` : 'g') : '',
      Array.isArray(this.props.colorMappingDefault)
        ? this.props.colorMappingDefault.join(',')
        : '',
      sizeProp,
      angleProp,
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.decodedCache.clear();
      this.visibleCache.clear();
      this.fadeCache.clear();
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
      for (const key of this.fadeCache.keys()) {
        if (!live.has(key)) this.fadeCache.delete(key);
      }
      this.lastTilesRef = tiles;
    }

    const styleKey = this.computeStyleKey();
    const now = this.getCurrentTime();
    const half = (this.props.timeWindow ?? 0) / 2;
    const windowStart = now - half;
    const windowEnd = now + half;
    const fadeIn = this.props.fadeInDuration ?? 0;
    const fadeOut = this.props.fadeOutDuration ?? 0;
    const fadeActive = fadeIn > 0 || fadeOut > 0;

    const layers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const decoded = this.decodeTile(tile, tileLayer, styleKey);
        if (!decoded || decoded.fullRows.length === 0) continue;

        const { rows, sig } = this.buildVisible(
          decoded,
          windowStart,
          windowEnd,
          fadeIn,
          fadeOut,
          fadeActive,
        );
        if (rows.length === 0) continue;
        layers.push(
          this.buildTextSublayer(decoded, rows, sig, fadeActive, now),
        );
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
   * Decode a single tile's string column into the full row set once, cached by
   * `styleKey` so a re-style (or a column swap) rebuilds and everything else
   * reuses the reference-stable rows.
   */
  private decodeTile(
    tile: Tile,
    tileLayer: TileLayer,
    styleKey: string,
  ): DecodedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;
    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.decodedCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) return cached;

    const count = binary.featureCount;
    const dims = binary.positionDimensions ?? 2;
    const positions = binary.positions;
    const starts = binary.startTimes;
    const ends = binary.endTimes;
    const offset = binary.timeOffset;

    const textProp = this.textValue();

    const colorValue = this.colorValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const constColor: [number, number, number, number] = Array.isArray(
      colorValue,
    )
      ? [
          colorValue[0],
          colorValue[1],
          colorValue[2],
          (colorValue[3] ?? 255) as number,
        ]
      : [
          DEFAULT_TEXT_COLOR[0],
          DEFAULT_TEXT_COLOR[1],
          DEFAULT_TEXT_COLOR[2],
          255,
        ];
    const fallbackColor = (this.props.colorMappingDefault ?? [
      0, 0, 0, 0,
    ]) as Color;

    const sizeValue = this.sizeValue();
    const sizeProp = typeof sizeValue === 'string' ? sizeValue : '';
    const sizeCol = sizeProp ? binary.numericProps[sizeProp] : undefined;
    const sizeIsColumn = !!sizeCol;

    const angleValue = this.angleValue();
    const angleProp = typeof angleValue === 'string' ? angleValue : '';
    const angleCol = angleProp ? binary.numericProps[angleProp] : undefined;
    const angleIsColumn = !!angleCol;

    const fullRows: TextRow[] = new Array(count);
    for (let i = 0; i < count; i++) {
      const b = i * dims;
      const color: [number, number, number, number] = colorProp
        ? resolveColor(
            readText(binary, colorProp, i),
            this.props.colorMapping,
            fallbackColor,
          )
        : [constColor[0], constColor[1], constColor[2], constColor[3]];
      const row: TextRow = {
        position: [
          positions[b],
          positions[b + 1],
          dims > 2 ? positions[b + 2] : 0,
        ],
        text: readText(binary, textProp, i),
        startTime: starts[i] + offset,
        endTime: ends[i] + offset,
        color,
        i,
      };
      if (sizeCol) row.size = sizeCol[i];
      if (angleCol) row.angle = angleCol[i];
      fullRows[i] = row;
    }

    const decoded: DecodedTile = {
      tileKey,
      styleKey,
      fullRows,
      sizeIsColumn,
      angleIsColumn,
      tile,
      features: binary,
      layerName: tileLayer.name,
    };
    this.decodedCache.set(tileKey, decoded);
    // A restyle invalidated the previous visible set for this tile.
    this.visibleCache.delete(tileKey);
    this.fadeCache.delete(tileKey);
    return decoded;
  }

  /**
   * Filter a tile's full rows to those whose absolute `[startTime, endTime]`
   * overlaps the window `[windowStart, windowEnd]` (the same overlap test the
   * TimeFilterExtension window-mode shader runs), folding the appear/disappear
   * fade into a per-row color alpha when active. Returns a membership signature
   * used both for `updateTriggers` and for reference-stable reuse: when no fade
   * is animating and the membership is unchanged, the previous frame's row array
   * is returned so deck sees an identical `data` ref (no glyph re-layout).
   */
  private buildVisible(
    decoded: DecodedTile,
    windowStart: number,
    windowEnd: number,
    fadeIn: number,
    fadeOut: number,
    fadeActive: boolean,
  ): { rows: TextRow[]; sig: string } {
    // Membership pass: the visible full-rows + their signature (feature indices).
    const visibleFulls: TextRow[] = [];
    let sig = '';
    for (const r of decoded.fullRows) {
      if (r.endTime < windowStart || r.startTime > windowEnd) continue;
      sig += r.i + ',';
      visibleFulls.push(r);
    }

    if (!fadeActive) {
      // No alpha animation → the decoded rows ARE the render rows. Reference-stable
      // reuse while membership recurs (deck compares `data` by reference).
      const prev = this.visibleCache.get(decoded.tileKey);
      if (prev && prev.sig === sig) return { rows: prev.rows, sig };
      this.visibleCache.set(decoded.tileKey, { sig, rows: visibleFulls });
      return { rows: visibleFulls, sig };
    }

    // Fade active: keep the row ARRAY + row OBJECTS (+ their `color` arrays)
    // reference-stable across frames while membership is unchanged, so TextLayer
    // does NOT re-run its per-glyph `_updateText` layout (which fires on ANY
    // `data`-ref change, bypassing the getText/getPosition/getSize/getAngle
    // updateTriggers). Only `color[3]` + `fade` are mutated in place each frame;
    // the getColor/getBackgroundColor updateTriggers (carrying the clock)
    // re-upload just the colour. Rebuild only when membership (`sig`) changes.
    let cached = this.fadeCache.get(decoded.tileKey);
    if (!cached || cached.sig !== sig) {
      const rows: TextRow[] = visibleFulls.map((r) => ({
        ...r,
        // Own mutable RGBA array (base copied; alpha overwritten per frame below).
        color: [r.color[0], r.color[1], r.color[2], r.color[3] ?? 255],
        fade: 1,
      }));
      cached = { sig, rows, fulls: visibleFulls };
      this.fadeCache.set(decoded.tileKey, cached);
    }
    const { rows, fulls } = cached;
    for (let k = 0; k < rows.length; k++) {
      const f = fulls[k];
      let fade = 1;
      if (fadeIn > 0) {
        const age = windowEnd - f.startTime;
        if (age < fadeIn) fade *= clamp01(age / fadeIn);
      }
      if (fadeOut > 0) {
        const remaining = f.endTime - windowStart;
        if (remaining < fadeOut) fade *= clamp01(remaining / fadeOut);
      }
      const row = rows[k];
      row.fade = fade;
      row.color[3] = Math.round((f.color[3] ?? 255) * fade);
    }
    return { rows, sig };
  }

  /** Build one TextLayer over a tile's visible rows. */
  private buildTextSublayer(
    decoded: DecodedTile,
    rows: TextRow[],
    sig: string,
    fadeActive: boolean,
    now: number,
  ): TextLayer {
    const sizeValue = this.sizeValue();
    const angleValue = this.angleValue();
    const constSize = typeof sizeValue === 'number' ? sizeValue : 32;
    const constAngle = typeof angleValue === 'number' ? angleValue : 0;

    // getText / getPosition / getSize / getAngle depend only on membership; the
    // color changes per frame while a fade is animating, so its trigger carries
    // the clock too (keeps glyph layout stable through a pure alpha ramp — the
    // rows array + objects are reference-stable so `_updateText` does not re-run).
    const colorSig = fadeActive ? `${sig}@${now}` : sig;

    // Finding: the appear/disappear fade must also ride the background rectangle
    // and border, else (with `background:true`/`borderWidth>0`) they pop out
    // abruptly while the glyphs fade smoothly. When fade is active, feed
    // per-row readers that scale the constant bg/border alpha by each row's ramp
    // factor. (The SDF glyph `outlineColor` is a layer-level uniform, so it can't
    // be faded per-row — documented on the prop.)
    const bg = (this.props.backgroundColor ?? [255, 255, 255, 255]) as Color;
    const bd = (this.props.borderColor ?? [0, 0, 0, 255]) as Color;
    const getBackgroundColor = fadeActive
      ? (d: TextRow): [number, number, number, number] => [
          bg[0],
          bg[1],
          bg[2],
          Math.round((bg[3] ?? 255) * (d.fade ?? 1)),
        ]
      : bg;
    const getBorderColor = fadeActive
      ? (d: TextRow): [number, number, number, number] => [
          bd[0],
          bd[1],
          bd[2],
          Math.round((bd[3] ?? 255) * (d.fade ?? 1)),
        ]
      : bd;

    const extensions = this.composeExtensions([]);
    const props = this.composeSubLayerProps('text', decoded.tileKey, {
      data: rows as any,

      // CPU-row readers (the only way to feed a TextLayer; see the header).
      getText: (d: TextRow) => d.text,
      getPosition: (d: TextRow) => d.position,
      getColor: (d: TextRow) => d.color,
      // Per-feature size/angle ride a reader; constants ride the scalar prop.
      getSize: decoded.sizeIsColumn
        ? (d: TextRow) => d.size ?? constSize
        : constSize,
      getAngle: decoded.angleIsColumn
        ? (d: TextRow) => d.angle ?? constAngle
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
      getBorderColor,
      getBorderWidth: this.props.borderWidth,

      // SDF outline.
      outlineColor: this.props.outlineColor,
      outlineWidth: this.props.outlineWidth,

      // Font.
      fontFamily: this.props.fontFamily,
      fontWeight: this.props.fontWeight,
      fontSettings: this.props.fontSettings,
      characterSet: this.props.characterSet,

      // Wrapping + billboard.
      wordBreak: this.props.wordBreak,
      maxWidth: this.props.maxWidth,
      billboard: this.props.billboard,

      extensions,

      // TileLayer picking convention — the source tile + decoded columns ride on
      // the sublayer; `sttRows` maps a visible-row hit back to its feature index.
      tile: decoded.tile,
      sttFeatures: decoded.features,
      sttRows: rows,

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
   * Picking enrichment. The TextLayer `data` is a FILTERED CPU-row subset, so a
   * hit's `info.index` maps into that subset — resolve it back to the original
   * feature index via the per-row `i` and decode that feature's binary columns
   * into `info.object` (the base-class TileLayer contract, but keyed off the row
   * subset rather than the raw feature index).
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
          sttRows?: TextRow[];
        }
      | undefined;
    const tile = sp?.tile ?? null;
    out.sourceTile = tile;
    const rows = sp?.sttRows;
    if (info.index >= 0 && tile && rows) {
      out.tile = tile;
      const row = rows[info.index];
      if (row && sp?.sttFeatures) {
        out.object = getFeatureProperties(sp.sttFeatures, row.i) ?? undefined;
      }
    }
    return out;
  }
}
