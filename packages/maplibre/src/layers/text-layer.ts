/**
 * Text geometry adapter — renders POINT-type tiles as time-filtered map LABELS,
 * one instanced quad PER CHARACTER, sampled from a caller-supplied font atlas.
 *
 * Before this kind existed the `text` layer DEGRADED to `icon`: a label became
 * a sprite and the glyphs were lost. Everything below exists to put the glyphs
 * back without giving up anything the icon layer already had.
 *
 * ── What it draws ───────────────────────────────────────────────────────────
 * Structurally this IS the icon layer with a glyph-layout stage in front of it.
 * A feature contributes N instances of the base layer's shared 4-vertex unit
 * quad (`getUnitQuad`, `(side, along) ∈ {-1,1} × {0,1}`), one per character of
 * its label. Each instance carries the character's atlas rectangle plus its
 * OFFSET FROM THE ROW ANCHOR in atlas pixels; the vertex stage scales that
 * offset to on-screen pixels, rotates the whole row rigidly about the anchor,
 * and adds it to the projected anchor in NDC. So the ROW anchors as a whole
 * (`anchorX`/`anchorY`) and the glyphs advance WITHIN it — a label never
 * "explodes" under rotation because every glyph shares one anchor and one
 * angle.
 *
 * The atlas is supplied exactly the way the icon layer takes `iconAtlas` /
 * `iconMapping`: {@link STTTextLayerOptions.fontAtlas} is a URL or a decoded
 * image-like, {@link STTTextLayerOptions.fontMapping} maps a character to
 * `{x, y, width, height, advance}` in atlas pixels. Like the icon layer, with
 * no atlas (or no mapping) this layer draws NOTHING and warns ONCE — a demo
 * whose font 404s degrades to "no labels", never to a throw and never to
 * untextured boxes.
 *
 * ── Decoding: flat, once, no row objects ────────────────────────────────────
 * Labels arrive as a categorical (dictionary-encoded) column. Decoding is done
 * ONCE per (tile, layer) at tile-upload into two FLAT typed arrays —
 * {@link buildTileCodePoints}:
 *
 *   codePoints : Uint32Array   // every row's characters, UTF-32, concatenated
 *   rowOffsets : Uint32Array   // length featureCount + 1; row i owns
 *                              // [rowOffsets[i], rowOffsets[i + 1])
 *
 * The DICTIONARY is what gets string-decoded (once per distinct category, not
 * once per row); rows are then filled by a typed-array copy. There is never a
 * per-feature row OBJECT, never an array of strings per tile, and never a
 * per-frame decode — {@link layoutTileGlyphs} consumes the flat pair and emits
 * one interleaved instance buffer. A 200k-label tile costs two typed arrays and
 * one pass, not 200k JS objects for the GC to walk every eviction.
 *
 * Surrogate pairs are decoded to real code points (a UTF-32 buffer, not UTF-16
 * units), so an astral character is ONE glyph lookup rather than two mojibake
 * halves. `\n` is a layout instruction, never a glyph.
 *
 * ── Picking: provenance is per FEATURE, not per glyph ───────────────────────
 * Every glyph of row `i` is painted the SAME id colour. `buildPickIdColors`
 * produces one triple per FEATURE and
 * `expandPickIdColors(perFeature, glyphCountsPerFeature, totalGlyphs)` fans it
 * out across that row's glyphs, so a pick anywhere on a label — the crossbar of
 * a 't' in the middle of it — resolves to that label's source row. The base's
 * provenance table is left alone precisely because of this: `cache.vertexCount`
 * stays the FEATURE count (`cache.glyphCount` is the instance count), so the
 * id range the base allocates is per feature and `resolvePick` needs no
 * override.
 *
 * The id pass reproduces the visual pass's alpha gates EXACTLY — same time
 * kernel, same DataFilter range, same glyph coverage, same `alphaCutoff` —
 * because both fragment stages come out of the one
 * {@link buildGlyphFragmentSource} builder. A label you cannot see is not
 * pickable, and the transparent gaps between glyphs are not a hit box.
 *
 * ── Feature surface ─────────────────────────────────────────────────────────
 *  - `timeFilterMode` — window (default) / wake / cumulative / trail, chosen at
 *    PROGRAM-BUILD time from `shaders/time-window.glsl.ts` (no mode uniform, no
 *    dynamic branch) and therefore part of the program-cache key. Wake tapers
 *    the label's SIZE toward `wakeTailScale` using the same alpha the kernel
 *    returned — text is type, not geography, so it is legitimately taper-able.
 *  - `filterProperty`/`filterRange`/… — the DataFilter kernel, compiled in only
 *    when `filterProperty` is named, multiplied into the same `vAlpha`.
 *  - `sizeUnits: 'meters'` — metric sizing through `lib/projection.ts`, resolved
 *    at each TILE's centre latitude and folded into `uSizeScale` (no extra
 *    program variant), then clamped by `sizeMinPixels`/`sizeMaxPixels` on the
 *    BASE size, before the wake taper and the filter shrink (deck's
 *    `DECKGL_FILTER_SIZE` ordering — clamping last would let `sizeMinPixels`
 *    cancel the taper).
 *  - per-row `anchorX`/`anchorY`, `size`/`sizeProperty`, `color`/`colorProperty`,
 *    `angle`/`angleProperty`, `lineHeight`, and an SDF `outlineWidth`.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *  - **No font rasterization.** The atlas and mapping are the CALLER's, exactly
 *    as with icons. This package has no canvas text-metrics dependency and no
 *    runtime glyph packer; that belongs upstream of the tile.
 *  - **No collision detection / label de-confliction.** deck's `CollisionFilter`
 *    is a multi-pass, layer-wide, CPU-plus-FBO affair; it is not a property of
 *    the glyph geometry and would have to arbitrate ACROSS tiles, which fights
 *    the per-tile draw loop this whole package is built on. Overlapping labels
 *    overlap.
 *  - **No text background / padding box.** That is a second geometry (a quad
 *    per ROW, not per glyph) with its own alpha gates; it belongs in a
 *    composed layer, not smuggled into the glyph program.
 *  - **No word wrapping.** `\n` breaks lines; measuring for a wrap width needs
 *    the caller's font metrics and a break-opportunity table (ICU-shaped), which
 *    is not a renderer concern. Pre-wrap in the data.
 *  - **No bidi / shaping / kerning pairs.** Layout is left-to-right advance
 *    accumulation. A shaped script needs a shaping engine; ship the shaped
 *    string.
 *  - **No colour bitmap fonts.** The bitmap path treats the atlas as a MASK and
 *    tints it; the SDF path is the recommended one.
 */

import type {
  Tile,
  STTTileLayer as STTLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';
import { GeometryType, DEFAULT_CATEGORICAL_PALETTE } from '@poopdeck.gl/core';
import { DEFAULT_WAKE_TAIL_SCALE } from '@poopdeck.gl/core/time-filter';
import {
  resolveTrailFade,
  STTFilterableLayer,
  expandPickIdColors,
  toRgba01,
  type STTBaseLayerOptions,
  type STTTimeFilterMode,
  type DrawContext,
  type TileGpuCache,
  type RGBA8,
} from '../base-layer.js';
import {
  createHostFrame,
  type HostFrame,
  type HostShaderData,
} from '../lib/host-adapter.js';
import {
  TIME_WINDOW_GLSL,
  TIME_WAKE_GLSL,
  TIME_CUMULATIVE_GLSL,
  TIME_TRAIL_GLSL,
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE,
  resolveTimeUniformLocations,
  resolveWakeTailScaleUniformLocation,
  type TimeUniformLocations,
  type WakeTailScaleUniformLocation,
} from '../shaders/time-window.glsl.js';
import { POSITION_DEQUANT_GLSL } from '../shaders/position-quantization.glsl.js';
import {
  DATA_FILTER_ATTRIBUTE_GLSL,
  DATA_FILTER_CALL_GLSL,
  DATA_FILTER_GLSL,
  DATA_FILTER_NAMES,
  DATA_FILTER_UNIFORMS_GLSL,
  extractFilterColumn,
  resolveDataFilterUniformLocations,
  resolveFilterTransformSizeUniformLocation,
  type DataFilterUniformLocations,
  type FilterTransformSizeUniformLocation,
  type STTDataFilterOptions,
} from '../shaders/data-filter.glsl.js';
import { buildGlyphFragmentSource } from '../shaders/text-glyph.glsl.js';

/** The four real time-filter modes, under this layer's name. */
export type TextTimeFilterMode = STTTimeFilterMode;

/**
 * One entry of a {@link STTTextLayerOptions.fontMapping}: where a character
 * lives in the atlas, in ATLAS PIXELS.
 *
 * Deliberately the same SHAPE as the icon layer's `IconMappingEntry` plus an
 * `advance`, so an atlas packer that already emits icon mappings emits font
 * mappings too.
 */
export interface GlyphMappingEntry {
  /** Left edge of the glyph in the atlas, in pixels. */
  x: number;
  /** Top edge of the glyph in the atlas, in pixels. */
  y: number;
  /** Glyph width in pixels. */
  width: number;
  /** Glyph height in pixels. */
  height: number;
  /**
   * Pen advance after this glyph, in atlas pixels.
   * @default width — a monospaced-ish fallback, never 0 (which would stack the
   * whole label on one spot).
   */
  advance?: number;
  /** Horizontal bearing: pen-to-glyph-left, in atlas pixels. @default 0 */
  xOffset?: number;
  /**
   * Vertical bearing: LINE TOP to glyph top, in atlas pixels, y-DOWN.
   * @default 0
   */
  yOffset?: number;
}

/** An already decoded atlas image, or anything `texImage2D` accepts. */
export interface FontAtlasImage {
  width: number;
  height: number;
  /** `<img>` completion flag; absent on `ImageBitmap`/`ImageData`/canvas. */
  complete?: boolean;
  addEventListener?: (type: string, cb: () => void) => void;
}

/** Font atlas source: a URL to fetch once, or an already decoded image. */
export type STTFontAtlasSource = string | FontAtlasImage;

/** Where a row's glyph run sits horizontally relative to the anchor. */
export type TextAnchorX = 'start' | 'middle' | 'end';
/** Where a row's line block sits vertically relative to the anchor. */
export type TextAnchorY = 'top' | 'center' | 'bottom';

export interface STTTextLayerOptions
  extends STTBaseLayerOptions, STTDataFilterOptions {
  /**
   * Font atlas — a URL string (loaded once via `Image`, CORS-anonymous) or an
   * already decoded source. Nothing is drawn until it AND {@link fontMapping}
   * resolve.
   */
  fontAtlas?: STTFontAtlasSource | null;
  /**
   * Character → atlas rectangle. Required to draw anything. Characters absent
   * from the mapping are SKIPPED (they emit no instance) rather than drawn as a
   * wrong glyph or a blank box.
   */
  fontMapping?: Record<string, GlyphMappingEntry> | null;
  /**
   * Categorical column NAME holding each feature's label. When absent, every
   * feature draws the constant {@link text}.
   */
  textProperty?: string;
  /**
   * Constant label drawn when {@link textProperty} is unset, and the fallback
   * for NULL category entries. @default ''
   */
  text?: string;
  /**
   * The atlas's em size in pixels — the layout basis. A glyph run laid out in
   * atlas pixels is scaled by `size / fontSize`, so this is what makes a 64 px
   * atlas render 12 px text. @default 64 (deck's `FontAtlas` default)
   */
  fontSize?: number;
  /** Line advance as a multiple of {@link fontSize}. @default 1.2 */
  lineHeight?: number;
  /** Label size in {@link sizeUnits}. @default 16 */
  size?: number;
  /** Numeric column NAME driving per-feature size (in {@link sizeUnits}). */
  sizeProperty?: string;
  /**
   * Unit `size` / a `sizeProperty` column is expressed in. `'pixels'` (default)
   * or `'meters'` (ground metres, resolved per tile).
   */
  sizeUnits?: 'pixels' | 'meters';
  /** Multiplier applied to every size. @default 1 */
  sizeScale?: number;
  /** Lower clamp on the on-screen size, in pixels. @default 0 */
  sizeMinPixels?: number;
  /** Upper clamp on the on-screen size, in pixels. @default Number.MAX_SAFE_INTEGER */
  sizeMaxPixels?: number;
  /** Horizontal row anchoring. @default 'middle' */
  anchorX?: TextAnchorX;
  /** Vertical row anchoring. @default 'center' */
  anchorY?: TextAnchorY;
  /** Constant RGBA fill, 0-255. @default [255, 255, 255, 255] */
  color?: RGBA8;
  /** Categorical column NAME driving per-feature colour. */
  colorProperty?: string;
  /** Palette for {@link colorProperty}. @default DEFAULT_CATEGORICAL_PALETTE */
  colorPalette?: ReadonlyArray<RGBA8>;
  /** Explicit category → colour overrides for {@link colorProperty}. */
  colorMapping?: Record<string, RGBA8> | null;
  /** Colour for categories the mapping/palette misses. */
  colorMappingDefault?: RGBA8;
  /** Constant rotation in degrees, CCW (deck `getAngle` semantics). @default 0 */
  angle?: number;
  /** Numeric column NAME driving per-feature rotation, in degrees. */
  angleProperty?: string;
  /**
   * Treat the atlas alpha as a signed distance field. @default true — an SDF
   * atlas is the only one that stays crisp across zoom, and it is what makes
   * {@link outlineWidth} possible.
   */
  sdf?: boolean;
  /** SDF edge threshold. @default 0.75 (deck's `DEFAULT_BUFFER`) */
  sdfBuffer?: number;
  /** SDF edge softness at 1:1 atlas scale. @default 0.1 (deck's smoothing) */
  sdfSmoothing?: number;
  /**
   * Outline thickness as a fraction of the SDF buffer, `0`..`1`. `0` (default)
   * is bit-identical to no outline — see `buildGlyphFragmentSource`. SDF only.
   */
  outlineWidth?: number;
  /** Outline RGBA, 0-255. @default [0, 0, 0, 255] */
  outlineColor?: RGBA8;
  /** Fragments below this composed alpha are discarded. @default 0.02 */
  alphaCutoff?: number;
  /** Time-filter mode; unset applies deck's precedence. */
  timeFilterMode?: TextTimeFilterMode;
  /** `wake` window length, ms. @default 0 */
  wakeLength?: number;
  /** Size the wake tail tapers to, as a fraction. */
  wakeTailScale?: number;
  /** `trail` window length, ms. @default 0 */
  trailLength?: number;
  /** `trail` comet blend, 0 (solid) .. 1 (comet). @default 1 */
  fadeTrail?: boolean | number;
  /** Overall opacity multiplier folded into the fill colour. @default 1 */
  opacity?: number;
}

// ── constants ───────────────────────────────────────────────────────────────

const DEFAULT_PALETTE: ReadonlyArray<RGBA8> = DEFAULT_CATEGORICAL_PALETTE;

/** Floats per glyph instance: rect(4) + anchor-relative offset(2). */
const GLYPH_STRIDE = 6;

/** `gl.TRIANGLE_STRIP` — the mock GL and WebGL agree on the literal. */
const TRIANGLE_STRIP = 0x0005;

/** `UNPACK_FLIP_Y_WEBGL` / `UNPACK_PREMULTIPLY_ALPHA_WEBGL` as literals. */
const UNPACK_FLIP_Y_WEBGL = 0x9240;
const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;

/** Newline — a layout instruction, never looked up in the mapping. */
const LF = 0x0a;
/** Carriage return — swallowed, so CRLF data lays out like LF data. */
const CR = 0x0d;

// Immutable stand-in for callers with no host frame: onContextReady's eager
// legacy link and hand-built test DrawContexts that omit `frame`.
const LEGACY_FRAME: HostFrame = createHostFrame();

// Hoisted uniform fallbacks — the hot path never allocates these.
const IDENTITY_POS_SCALE: readonly number[] = [1, 1, 1];
const ZERO_POS_OFFSET: readonly number[] = [0, 0, 0];

// ── code-point packing ──────────────────────────────────────────────────────

/** A flat UTF-32 buffer plus the per-row spans that index it. */
export interface PackedCodePoints {
  /** Every row's characters, concatenated. */
  codePoints: Uint32Array;
  /** Length `rowCount + 1`; row `i` owns `[offsets[i], offsets[i + 1])`. */
  offsets: Uint32Array;
}

/**
 * Pack an array of strings into one flat UTF-32 buffer plus row offsets.
 *
 * Iterating a string with `for…of` yields CODE POINTS, so a surrogate pair
 * becomes one entry — an astral character is one glyph lookup, not two broken
 * halves. Two passes (measure, then fill) so the output is exactly sized and no
 * intermediate array is grown.
 */
export function packCodePoints(labels: readonly string[]): PackedCodePoints {
  const offsets = new Uint32Array(labels.length + 1);
  let total = 0;
  for (let i = 0; i < labels.length; i++) {
    let n = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _ch of labels[i]) n++;
    total += n;
    offsets[i + 1] = total;
  }
  const codePoints = new Uint32Array(total);
  let w = 0;
  for (let i = 0; i < labels.length; i++) {
    for (const ch of labels[i]) codePoints[w++] = ch.codePointAt(0)!;
  }
  return { codePoints, offsets };
}

/**
 * Decode a tile's labels into the flat pair {@link layoutTileGlyphs} consumes.
 *
 * The DICTIONARY is decoded once ({@link packCodePoints} over
 * `categoricalProps[prop].categories`, which is at most a few hundred entries
 * even on a 200k-row tile); rows are then filled by a typed-array copy from
 * their category's span. A NULL entry (`0xffff`) and a category the dictionary
 * lacks both fall back to `constantText`.
 *
 * With no `textProperty` (or no such column in this tile) every row gets
 * `constantText`, which is why the constant path never allocates per row
 * either: one packed span, copied `count` times.
 */
export function buildTileCodePoints(
  features: Pick<BinaryFeatures, 'categoricalProps'>,
  count: number,
  textProperty: string | undefined,
  constantText: string,
): PackedCodePoints {
  const cat = textProperty
    ? features.categoricalProps?.[textProperty]
    : undefined;
  // The constant span always lives at dictionary slot `dict.offsets.length - 2`
  // so a missing / null category resolves without a branch on strings.
  const dictSource = cat ? [...cat.categories, constantText] : [constantText];
  const dict = packCodePoints(dictSource);
  const fallbackSlot = dictSource.length - 1;
  const slotFor = (i: number): number => {
    if (!cat) return fallbackSlot;
    const idx = cat.indices[i];
    return idx < fallbackSlot ? idx : fallbackSlot;
  };

  const offsets = new Uint32Array(count + 1);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const slot = slotFor(i);
    total += dict.offsets[slot + 1] - dict.offsets[slot];
    offsets[i + 1] = total;
  }
  const codePoints = new Uint32Array(total);
  for (let i = 0; i < count; i++) {
    const slot = slotFor(i);
    codePoints.set(
      dict.codePoints.subarray(dict.offsets[slot], dict.offsets[slot + 1]),
      offsets[i],
    );
  }
  return { codePoints, offsets };
}

// ── glyph layout ────────────────────────────────────────────────────────────

/** Layout knobs {@link layoutTileGlyphs} reads. All in ATLAS PIXELS. */
export interface GlyphLayoutOptions {
  mapping: Record<string, GlyphMappingEntry>;
  /** Atlas em size — the layout basis and the line-height unit. */
  fontSize: number;
  /** Line advance as a multiple of `fontSize`. */
  lineHeight: number;
  anchorX: TextAnchorX;
  anchorY: TextAnchorY;
}

/** The instance geometry for one tile's labels. */
export interface GlyphLayout {
  /**
   * Interleaved stride-6 per-instance data:
   * `[rectX, rectY, rectW, rectH, offsetX, offsetY]`, atlas pixels, y-DOWN,
   * `offset` measured FROM THE ROW ANCHOR.
   */
  glyphs: Float32Array;
  /** Glyphs emitted per feature — the fan-out counts picking expands by. */
  counts: Uint32Array;
  /** Total instances (`glyphs.length / 6`). */
  total: number;
}

const ANCHOR_X_FACTOR: Readonly<Record<TextAnchorX, number>> = Object.freeze({
  start: 0,
  middle: -0.5,
  end: -1,
});

const ANCHOR_Y_FACTOR: Readonly<Record<TextAnchorY, number>> = Object.freeze({
  top: 0,
  center: -0.5,
  bottom: -1,
});

/**
 * Lay a tile's packed code points out into per-glyph instance data.
 *
 * Per row: split on `\n`, measure each line by accumulating `advance`, place the
 * line block vertically by `anchorY` and each line horizontally by `anchorX`,
 * then walk the pen. Everything is in ATLAS PIXELS relative to the ROW ANCHOR —
 * the shader applies one scale and one rotation to the whole row, so the row
 * stays typographically intact under any size or angle.
 *
 * A character the mapping lacks contributes NOTHING: no instance, and no
 * advance (its width is unknown, so advancing by a guess would mis-centre every
 * following glyph). A zero/absent `advance` falls back to the glyph WIDTH; a
 * zero advance would otherwise stack an entire label on one point.
 *
 * Two passes again: measure to size the output exactly, then fill. The
 * measuring pass is pure arithmetic over a Uint32Array — no strings are
 * reconstructed and no row object is created.
 */
export function layoutTileGlyphs(
  packed: PackedCodePoints,
  count: number,
  opts: GlyphLayoutOptions,
): GlyphLayout {
  const { mapping, fontSize, lineHeight, anchorX, anchorY } = opts;
  const { codePoints, offsets } = packed;
  const counts = new Uint32Array(count);
  const chars: string[] = [];

  // Pass 1 — how many glyphs actually resolve.
  let total = 0;
  for (let i = 0; i < count; i++) {
    let n = 0;
    for (let c = offsets[i]; c < offsets[i + 1]; c++) {
      const cp = codePoints[c];
      if (cp === LF || cp === CR) continue;
      const key = chars[cp] ?? (chars[cp] = String.fromCodePoint(cp));
      if (mapping[key]) n++;
    }
    counts[i] = n;
    total += n;
  }

  const glyphs = new Float32Array(total * GLYPH_STRIDE);
  const lineStep = fontSize * lineHeight;
  let w = 0;

  // Pass 2 — place them.
  for (let i = 0; i < count; i++) {
    const from = offsets[i];
    const to = offsets[i + 1];
    if (counts[i] === 0) continue;

    // Line breaks and per-line widths, measured in one sweep.
    let lineCount = 1;
    for (let c = from; c < to; c++) if (codePoints[c] === LF) lineCount++;
    const lineWidths = new Float64Array(lineCount);
    let line = 0;
    for (let c = from; c < to; c++) {
      const cp = codePoints[c];
      if (cp === LF) {
        line++;
        continue;
      }
      if (cp === CR) continue;
      const entry =
        mapping[chars[cp] ?? (chars[cp] = String.fromCodePoint(cp))];
      if (entry) lineWidths[line] += entry.advance || entry.width;
    }

    const blockTop = ANCHOR_Y_FACTOR[anchorY] * lineCount * lineStep;
    line = 0;
    let pen = ANCHOR_X_FACTOR[anchorX] * lineWidths[0];
    for (let c = from; c < to; c++) {
      const cp = codePoints[c];
      if (cp === LF) {
        line++;
        pen = ANCHOR_X_FACTOR[anchorX] * lineWidths[line];
        continue;
      }
      if (cp === CR) continue;
      const entry =
        mapping[chars[cp] ?? (chars[cp] = String.fromCodePoint(cp))];
      if (!entry) continue;
      const o = w * GLYPH_STRIDE;
      glyphs[o] = entry.x;
      glyphs[o + 1] = entry.y;
      glyphs[o + 2] = entry.width;
      glyphs[o + 3] = entry.height;
      glyphs[o + 4] = pen + (entry.xOffset ?? 0);
      glyphs[o + 5] = blockTop + line * lineStep + (entry.yOffset ?? 0);
      pen += entry.advance || entry.width;
      w++;
    }
  }

  return { glyphs, counts, total };
}

// ── per-glyph attribute fan-out ─────────────────────────────────────────────

/**
 * Repeat each feature's `comps` floats across that feature's glyphs.
 *
 * Every per-feature attribute (position, time, size, angle, filter value) has
 * to become per-INSTANCE, because WebGL1 has no `gl_InstanceID` and therefore
 * no way for a glyph to index back to its row. This is the one memory cost the
 * per-character model imposes and it is paid once, at tile upload.
 */
export function expandFloatsPerGlyph(
  src: ArrayLike<number>,
  comps: number,
  counts: Uint32Array,
  total: number,
  out: Float32Array | Float64Array,
): void {
  let w = 0;
  for (let i = 0; i < counts.length; i++) {
    for (let n = 0; n < counts[i] && w < total; n++, w++) {
      for (let k = 0; k < comps; k++) out[w * comps + k] = src[i * comps + k];
    }
  }
}

/** {@link expandFloatsPerGlyph} for byte attributes (colours). */
export function expandBytesPerGlyph(
  src: Uint8Array,
  comps: number,
  counts: Uint32Array,
  total: number,
): Uint8Array {
  const out = new Uint8Array(total * comps);
  let w = 0;
  for (let i = 0; i < counts.length; i++) {
    for (let n = 0; n < counts[i] && w < total; n++, w++) {
      for (let k = 0; k < comps; k++) out[w * comps + k] = src[i * comps + k];
    }
  }
  return out;
}

// ── shader assembly ─────────────────────────────────────────────────────────

/** Prelude/define subset of {@link HostShaderData} the source builders consume. */
type ShaderInjection = Pick<HostShaderData, 'prelude' | 'define'>;

/**
 * What a compiled text program supports. Every field is structural (it adds
 * attributes, uniforms or statements), so each combination is its own program
 * and each must appear in the program-cache key — {@link textProgramKey}.
 */
export interface TextShaderConfig {
  /** Time-filter mode compiled into `main()`. */
  mode: TextTimeFilterMode;
  /** Compile the DataFilter attribute, uniforms and branch. */
  filter: boolean;
  /** Compile the SDF coverage path (vs plain bitmap alpha). */
  sdf: boolean;
}

/** The OFF shape: window mode, no column filter, SDF sampling. */
const DEFAULT_SHADER_CONFIG: TextShaderConfig = Object.freeze({
  mode: 'window',
  filter: false,
  sdf: true,
});

/** Kernel snippet per mode (each declares exactly its own function). */
const MODE_GLSL: Readonly<Record<TextTimeFilterMode, string>> = Object.freeze({
  window: TIME_WINDOW_GLSL,
  wake: TIME_WAKE_GLSL,
  cumulative: TIME_CUMULATIVE_GLSL,
  trail: TIME_TRAIL_GLSL,
});

/**
 * Uniforms each mode reads. Only the active mode's block is declared. The wake
 * block carries `uWakeTailScale` because a label is type, not geography: it may
 * legitimately shrink toward the tail (`sttWakeSizeScale`).
 */
const MODE_UNIFORMS: Readonly<Record<TextTimeFilterMode, string>> =
  TIME_MODE_UNIFORM_DECLS_WITH_WAKE_TAIL_SCALE;

/** The `vAlpha = …` expression per mode. */
const MODE_ALPHA: Readonly<Record<TextTimeFilterMode, string>> = Object.freeze({
  window:
    'sttTimeWindowAlpha(aTime, uWindowStart, uWindowEnd, uFadeIn, uFadeOut)',
  wake: 'sttWakeAlpha(aTime, uCurrentTime, uWakeLength)',
  cumulative: 'sttCumulativeAlpha(aTime, uCurrentTime, uFadeIn)',
  // A label sits at a single anchor point, so its "vertex time" is its start.
  trail: 'sttTrailAlpha(aTime.x, uCurrentTime, uTrailLength, uFadeTrail)',
});

// The kernel constants carry a leading newline for standalone splicing; these
// call sites paste them at a line start.
const FILTER_ATTRIBUTE = DATA_FILTER_ATTRIBUTE_GLSL.replace(/^\n/, '');
const FILTER_UNIFORMS = DATA_FILTER_UNIFORMS_GLSL.replace(/^\n/, '');

/**
 * DataFilter application, shared by the visual and id passes — deck's split: a
 * HARD-filtered feature (`0`) is hidden whatever the transform flags say, while
 * a soft-margin value only fades / shrinks when its flag is on.
 */
const FILTER_BODY = `    float filterAlpha = ${DATA_FILTER_CALL_GLSL};
    if (filterAlpha <= 0.0) {
      vAlpha = 0.0;               // hard-filtered: the FS discard hides it
    } else if (uFilterTransformColor > 0.5) {
      vAlpha *= filterAlpha;
    }
    if (uFilterTransformSize > 0.5) {
      sizePx *= filterAlpha;
    }
`;

/**
 * deck's `vs:#main-end` collapse. Keyed on the FILTER factor only — it is
 * per-FEATURE, so every glyph of a filtered row collapses to a degenerate point
 * and skips rasterization entirely (the FS discard is still the correctness
 * gate).
 */
const FILTER_COLLAPSE =
  '    if (filterAlpha <= 0.0) gl_Position = vec4(0.0);\n';

/**
 * Assemble a text vertex shader.
 *
 * Legacy hosts (empty prelude) project the anchor through `uMatrix`; v5+ hosts
 * get the injected prelude + define prepended (maplibre's documented order) and
 * project through `projectTile` — a label is 2d content, so `projectTile`'s z
 * overwrite (horizon clipping) is exactly right. The anchor is a single point,
 * so no globe edge subdivision is needed.
 *
 * `vAlpha` is computed BEFORE the size so wake's tail shrink and the DataFilter
 * size transform can both read it — deck's `vs:#main-start` →
 * `DECKGL_FILTER_SIZE` ordering.
 *
 * ⚠ ORDER OF THE CLAMP. `sizeMinPixels`/`sizeMaxPixels` clamp the BASE size,
 * BEFORE the wake taper and the filter shrink, matching the icon/arc/trip-heads
 * layers here and deck's `icon-layer-vertex.glsl`. Clamping last would let
 * `sizeMinPixels` cancel the taper, so a wake tail would fade without ever
 * shrinking.
 *
 * ⚠ ONE ANCHOR, ONE ANGLE, PER ROW. The rotation is applied to the glyph's
 * anchor-relative offset, not to a per-glyph position, which is why a rotated
 * label stays a rigid run of type instead of a scatter of characters.
 */
function buildTextVs(
  shader: ShaderInjection,
  cfg: TextShaderConfig,
  kind: 'main' | 'id',
): string {
  const usesPrelude = shader.prelude.length > 0;
  const head = usesPrelude ? `${shader.prelude}\n${shader.define}\n` : '';
  const isMain = kind === 'main';
  const projection = usesPrelude
    ? '    vec4 anchor = projectTile(mercator.xy);'
    : '    vec4 anchor = uMatrix * vec4(mercator.x, mercator.y, 0.0, 1.0);';
  const idAttribute = isMain
    ? ''
    : '  attribute vec3 aIdColor;    // per-FEATURE encoded id, fanned out per glyph\n';
  const legacyUniforms = usesPrelude ? '' : '  uniform mat4 uMatrix;\n';
  const wakeSize =
    cfg.mode === 'wake'
      ? '    sizePx *= sttWakeSizeScale(vAlpha, uWakeTailScale);\n'
      : '';
  const idVarying = isMain ? '' : '  varying vec3 vIdColor;\n';
  const idAssign = isMain ? '' : '    vIdColor = aIdColor;\n';
  // The SDF band narrows as the text grows: one atlas texel covers fewer screen
  // pixels, so the edge should get sharper. `uSdfSmoothing` is the band at 1:1.
  const gammaVarying = cfg.sdf ? '  varying float vGamma;\n' : '';
  const gammaAssign = cfg.sdf
    ? '    vGamma = uSdfSmoothing * uFontSize / max(sizePx, 0.001);\n'
    : '';
  const gammaUniform = cfg.sdf ? '  uniform float uSdfSmoothing;\n' : '';

  return `${head}
  precision highp float;
  attribute vec2 aCorner;     // (side, along) ∈ {-1,1} × {0,1}, per-vertex unit quad
  attribute vec3 aMercator;   // per-glyph row anchor — see sttDecodeMercatorPos
  attribute vec2 aTime;       // [startTime, endTime], per-glyph (from its row), tile-relative
  attribute vec4 aGlyphRect;  // per-glyph atlas rect (x, y, w, h) in atlas pixels
  attribute vec2 aGlyphOffset;// per-glyph offset FROM THE ROW ANCHOR, atlas pixels, y-down
  attribute float aSize;      // per-glyph row size (when uUseFeatureSize=1)
  attribute float aAngle;     // per-glyph row rotation in degrees (when uUseFeatureAngle=1)
  attribute vec4 aColor;      // per-glyph row RGBA in 0..1 (when uUseFeatureColor=1)
${idAttribute}${cfg.filter ? FILTER_ATTRIBUTE : ''}${legacyUniforms}  uniform vec3 uPosScale;
  uniform vec3 uPosOffset;
  uniform vec2 uViewport;     // drawing-buffer size in DEVICE pixels
  uniform vec2 uAtlasSize;    // atlas texture size in pixels
  uniform float uFontSize;    // atlas em size — the layout basis
  uniform float uSize;
  uniform float uSizeScale;
  uniform float uUseFeatureSize;
  uniform float uSizeMinPixels;
  uniform float uSizeMaxPixels;
  uniform float uAngle;
  uniform float uUseFeatureAngle;
  uniform float uUseFeatureColor;
  uniform vec4 uColor;
${gammaUniform}${MODE_UNIFORMS[cfg.mode]}${
    cfg.filter ? FILTER_UNIFORMS : ''
  }  varying float vAlpha;
  varying vec2 vUv;
  varying vec4 vColor;
${gammaVarying}${idVarying}${MODE_GLSL[cfg.mode]}${POSITION_DEQUANT_GLSL}${
    cfg.filter ? DATA_FILTER_GLSL : ''
  }
  void main() {
    vec3 mercator = sttDecodeMercatorPos(aMercator, uPosScale, uPosOffset);
${projection}
    vAlpha = ${MODE_ALPHA[cfg.mode]};
    float sizePx = (uUseFeatureSize > 0.5 ? aSize : uSize) * uSizeScale;
    sizePx = clamp(sizePx, uSizeMinPixels, uSizeMaxPixels);
${wakeSize}${cfg.filter ? FILTER_BODY : ''}${gammaAssign}
    // Atlas pixels → device pixels. uFontSize is the em the layout was measured
    // in, so this one factor carries both the glyph quad and the pen advances.
    float scale = sizePx / max(uFontSize, 0.001);
    vec2 uv01 = vec2(aCorner.x * 0.5 + 0.5, aCorner.y);
    vec2 glyphPx = vec2(uv01.x * aGlyphRect.z, uv01.y * aGlyphRect.w);
    vec2 layoutPx = (aGlyphOffset + glyphPx) * scale;
    float angleRad = radians(uUseFeatureAngle > 0.5 ? aAngle : uAngle);
    float ca = cos(angleRad);
    float sa = sin(angleRad);
    // deck IconLayer's rotate_by_angle followed by its y flip: the net effect is
    // a COUNTER-CLOCKWISE on-screen rotation of a y-down layout space.
    vec2 offsetPx = vec2(ca * layoutPx.x + sa * layoutPx.y, sa * layoutPx.x - ca * layoutPx.y);
    gl_Position = anchor;
    gl_Position.xy += (offsetPx / (0.5 * uViewport)) * anchor.w;
${cfg.filter ? FILTER_COLLAPSE : ''}    vUv = (aGlyphRect.xy + glyphPx) / uAtlasSize;
    vColor = (uUseFeatureColor > 0.5) ? aColor : uColor;
${idAssign}  }
`;
}

/** Visual vertex source for a host shader variant + feature configuration. */
export function buildTextVertexSource(
  shader: ShaderInjection,
  cfg: TextShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildTextVs(shader, cfg, 'main');
}

/** Id-pick counterpart of {@link buildTextVertexSource}. */
export function buildTextIdVertexSource(
  shader: ShaderInjection,
  cfg: TextShaderConfig = DEFAULT_SHADER_CONFIG,
): string {
  return buildTextVs(shader, cfg, 'id');
}

/**
 * Program-cache key for one pass + feature configuration. `getOrCreateProgram`
 * appends `::${variantName}` (the HOST variant) only, so two configurations
 * sharing a base key would collide on one program.
 */
export function textProgramKey(
  pass: 'main' | 'pick',
  cfg: TextShaderConfig,
): string {
  return `text:${pass}:${cfg.mode}${cfg.sdf ? ':sdf' : ':bitmap'}${
    cfg.filter ? ':filter' : ''
  }`;
}

/**
 * Resolve the compiled time-filter mode from the option surface, applying
 * deck's precedence (`cumulative > wake > trail > window`) when `mode` is unset
 * and the "a degenerate length lights nothing" guard when it is set.
 */
export function resolveTextTimeFilterMode(
  mode: TextTimeFilterMode | undefined,
  wakeLength: number,
  trailLength: number,
): TextTimeFilterMode {
  if (mode === 'cumulative') return 'cumulative';
  if (mode === 'wake') return wakeLength > 0 ? 'wake' : 'window';
  if (mode === 'trail') return trailLength > 0 ? 'trail' : 'window';
  if (mode === 'window') return 'window';
  if (wakeLength > 0) return 'wake';
  if (trailLength > 0) return 'trail';
  return 'window';
}

// ── handles + cache ─────────────────────────────────────────────────────────

/**
 * Locations every text program shares. Resolved once per program; absent
 * uniforms come back null (a no-op for `gl.uniform*`) and absent attributes come
 * back -1, which is exactly how a mode/filter combination that doesn't declare
 * them reads.
 */
interface TextSharedHandles
  extends
    TimeUniformLocations,
    WakeTailScaleUniformLocation,
    DataFilterUniformLocations,
    FilterTransformSizeUniformLocation {
  program: WebGLProgram;
  usesPrelude: boolean;
  aCorner: number;
  aMercator: number;
  aTime: number;
  aGlyphRect: number;
  aGlyphOffset: number;
  aSize: number;
  aAngle: number;
  aColor: number;
  /** Canonical DataFilter attribute location; -1 when no filter compiled in. */
  aFilterValue: number;
  uMatrix: WebGLUniformLocation | null;
  uPosScale: WebGLUniformLocation | null;
  uPosOffset: WebGLUniformLocation | null;
  uViewport: WebGLUniformLocation | null;
  uAtlasSize: WebGLUniformLocation | null;
  uFontSize: WebGLUniformLocation | null;
  uSize: WebGLUniformLocation | null;
  uSizeScale: WebGLUniformLocation | null;
  uUseFeatureSize: WebGLUniformLocation | null;
  uSizeMinPixels: WebGLUniformLocation | null;
  uSizeMaxPixels: WebGLUniformLocation | null;
  uAngle: WebGLUniformLocation | null;
  uUseFeatureAngle: WebGLUniformLocation | null;
  uUseFeatureColor: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uAtlas: WebGLUniformLocation | null;
  uAlphaCutoff: WebGLUniformLocation | null;
  uSdfBuffer: WebGLUniformLocation | null;
  uSdfSmoothing: WebGLUniformLocation | null;
  uOutlineBuffer: WebGLUniformLocation | null;
  uOutlineColor: WebGLUniformLocation | null;
}

/** Id-pass handles: the shared set plus the per-feature id colour attribute. */
interface TextIdProgramHandles extends TextSharedHandles {
  aIdColor: number;
}

/**
 * Per-tile GPU state.
 *
 * ⚠ `vertexCount` is the FEATURE count, `glyphCount` the INSTANCE count. The
 * base's pick provenance allocates one id per `vertexCount`, and provenance is
 * per feature here — see the file header. `drawTile` uses `glyphCount`.
 */
interface TextGpuCache extends TileGpuCache {
  /** Instances drawn — one per resolved character across the whole tile. */
  glyphCount: number;
  /** Glyphs per feature; the fan-out `expandPickIdColors` needs. */
  glyphCounts: Uint32Array;
  /** Interleaved stride-6 rect + anchor-relative offset. */
  glyphBuffer?: WebGLBuffer;
  sizeBuffer?: WebGLBuffer;
  angleBuffer?: WebGLBuffer;
  colorBuffer?: WebGLBuffer;
  filterBuffer?: WebGLBuffer;
  hasFilterColumn?: boolean;
  /** Program identity the cached VAO recorded against. */
  vaoVariant?: string;
}

type AtlasState = 'idle' | 'loading' | 'decoded' | 'ready' | 'failed';

/**
 * Time-filtered map labels over POINT tiles: one instanced quad per character,
 * sampled from a caller-supplied SDF (or bitmap) font atlas.
 *
 * See the file header for the design rationale, the flat-decode contract and
 * the per-FEATURE picking model.
 */
export class STTTextLayer extends STTFilterableLayer {
  private textOpts: {
    fontAtlas: STTFontAtlasSource | null;
    fontMapping: Record<string, GlyphMappingEntry> | null;
    textProperty?: string;
    text: string;
    fontSize: number;
    lineHeight: number;
    size: number;
    sizeProperty?: string;
    sizeUnits: 'pixels' | 'meters';
    sizeScale: number;
    sizeMinPixels: number;
    sizeMaxPixels: number;
    anchorX: TextAnchorX;
    anchorY: TextAnchorY;
    color: RGBA8;
    colorProperty?: string;
    colorPalette: ReadonlyArray<RGBA8>;
    colorMapping: Record<string, RGBA8> | null;
    colorMappingDefault?: RGBA8;
    angle: number;
    angleProperty?: string;
    sdf: boolean;
    sdfBuffer: number;
    sdfSmoothing: number;
    outlineWidth: number;
    outlineColor: RGBA8;
    alphaCutoff: number;
    timeFilterMode?: TextTimeFilterMode;
    wakeLength: number;
    wakeTailScale: number;
    trailLength: number;
    fadeTrail: number;
    opacity: number;
  };

  private shaderConfig: TextShaderConfig;
  private mainKey: string;
  private pickKey: string;
  /** Program identity a freshly recorded visual VAO belongs to. */
  private mainVaoKey = '';

  private handles?: TextSharedHandles;
  private handlesVariant?: string;
  private idHandles?: TextIdProgramHandles;
  private idHandlesVariant?: string;

  private readonly warned = new Set<string>();

  private atlasState: AtlasState = 'idle';
  private atlasImage?: FontAtlasImage;
  private atlasTexture?: WebGLTexture;
  private atlasWidth = 0;
  private atlasHeight = 0;
  private atlasUrl?: string;

  /** Reused RGBA 0..1 scratch — the hot path never allocates. */
  private readonly fillRgba01 = new Float32Array(4);
  private readonly outlineRgba01 = new Float32Array(4);

  constructor(opts: STTTextLayerOptions) {
    super(opts);
    // Every default uses `??`: 0, '' and false are all legitimate caller values
    // and an explicit `undefined` forwarded from a React prop must still land on
    // the default.
    this.textOpts = {
      fontAtlas: opts.fontAtlas ?? null,
      fontMapping: opts.fontMapping ?? null,
      textProperty: opts.textProperty,
      text: opts.text ?? '',
      fontSize: opts.fontSize ?? 64,
      lineHeight: opts.lineHeight ?? 1.2,
      size: opts.size ?? 16,
      sizeProperty: opts.sizeProperty,
      sizeUnits: opts.sizeUnits ?? 'pixels',
      sizeScale: opts.sizeScale ?? 1,
      sizeMinPixels: opts.sizeMinPixels ?? 0,
      sizeMaxPixels: opts.sizeMaxPixels ?? Number.MAX_SAFE_INTEGER,
      anchorX: opts.anchorX ?? 'middle',
      anchorY: opts.anchorY ?? 'center',
      color: opts.color ?? [255, 255, 255, 255],
      colorProperty: opts.colorProperty,
      colorPalette: opts.colorPalette ?? DEFAULT_PALETTE,
      colorMapping: opts.colorMapping ?? null,
      colorMappingDefault: opts.colorMappingDefault,
      angle: opts.angle ?? 0,
      angleProperty: opts.angleProperty,
      sdf: opts.sdf ?? true,
      sdfBuffer: opts.sdfBuffer ?? 0.75,
      sdfSmoothing: opts.sdfSmoothing ?? 0.1,
      outlineWidth: opts.outlineWidth ?? 0,
      outlineColor: opts.outlineColor ?? [0, 0, 0, 255],
      alphaCutoff: opts.alphaCutoff ?? 0.02,
      timeFilterMode: opts.timeFilterMode,
      wakeLength: opts.wakeLength ?? 0,
      wakeTailScale: opts.wakeTailScale ?? DEFAULT_WAKE_TAIL_SCALE,
      trailLength: opts.trailLength ?? 0,
      fadeTrail: resolveTrailFade(opts.fadeTrail),
      opacity: opts.opacity ?? 1,
    };
    this.shaderConfig = {
      mode: this.resolveMode(),
      filter: Boolean(this.filterOpts.filterProperty),
      sdf: this.textOpts.sdf,
    };
    this.mainKey = textProgramKey('main', this.shaderConfig);
    this.pickKey = textProgramKey('pick', this.shaderConfig);
    this.refreshColors();
  }

  /** The mode the shader will actually compile, after degradation. */
  private resolveMode(): TextTimeFilterMode {
    const o = this.textOpts;
    return resolveTextTimeFilterMode(
      o.timeFilterMode,
      o.wakeLength,
      o.trailLength,
    );
  }

  protected acceptsGeometry(type: GeometryType): boolean {
    return type === GeometryType.Point;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[${this.id}] ${message}`);
  }

  /** Fold `opacity` into the fill alpha once, not per draw. */
  private refreshColors(): void {
    const o = this.textOpts;
    const fill = toRgba01(o.color);
    this.fillRgba01.set(fill);
    this.fillRgba01[3] = fill[3] * o.opacity;
    this.outlineRgba01.set(toRgba01(o.outlineColor));
  }

  // ── setters ──────────────────────────────────────────────────────────────

  /** Swap the constant label. Rebuilds tile caches — the text IS geometry. */
  setText(text: string): void {
    if (this.textOpts.text === text) return;
    this.textOpts.text = text;
    this.rebuildTileCaches();
  }

  /**
   * Swap the font atlas. Drops the texture and restarts the load state machine;
   * the mapping (and therefore the baked layout) is untouched.
   */
  setFontAtlas(atlas: STTFontAtlasSource | null): void {
    if (this.textOpts.fontAtlas === atlas) return;
    this.textOpts.fontAtlas = atlas;
    this.releaseAtlasTexture(this.gl);
    this.atlasImage = undefined;
    this.atlasUrl = undefined;
    this.atlasState = 'idle';
    this.map?.triggerRepaint();
  }

  /**
   * Swap the character mapping. Glyph layout is baked at tile-upload time, so
   * this rebuilds the tile caches — a UI-scale operation, not a per-frame one.
   */
  setFontMapping(mapping: Record<string, GlyphMappingEntry> | null): void {
    this.textOpts.fontMapping = mapping;
    this.rebuildTileCaches();
  }

  /** Constant fill colour, 0-255 RGBA. Uniform-only. */
  setColor(color: RGBA8): void {
    this.textOpts.color = color;
    this.refreshColors();
    this.map?.triggerRepaint();
  }

  /** Constant label size, in `sizeUnits`. Uniform-only. */
  setSize(size: number): void {
    if (this.textOpts.size === size) return;
    this.textOpts.size = size;
    this.map?.triggerRepaint();
  }

  /** Constant rotation, degrees CCW. Uniform-only. */
  setAngle(angle: number): void {
    if (this.textOpts.angle === angle) return;
    this.textOpts.angle = angle;
    this.map?.triggerRepaint();
  }

  /** Row anchoring. Rebuilds tile caches — anchoring is baked into the layout. */
  setAnchor(anchorX: TextAnchorX, anchorY: TextAnchorY): void {
    if (
      this.textOpts.anchorX === anchorX &&
      this.textOpts.anchorY === anchorY
    ) {
      return;
    }
    this.textOpts.anchorX = anchorX;
    this.textOpts.anchorY = anchorY;
    this.rebuildTileCaches();
  }

  /**
   * Switch time-filter mode at runtime. The mode is compiled in, so this links a
   * second program on the next frame (cached from then on) and re-records every
   * tile VAO against it.
   */
  setTimeFilterMode(mode: TextTimeFilterMode): void {
    this.textOpts.timeFilterMode = mode;
    this.applyShaderConfig();
  }

  /** `wake` length in ms; `0` degrades the compiled mode back to `window`. */
  setWakeLength(wakeLength: number): void {
    this.textOpts.wakeLength = wakeLength;
    this.applyShaderConfig();
  }

  /** `trail` length in ms; `0` degrades the compiled mode back to `window`. */
  setTrailLength(trailLength: number): void {
    this.textOpts.trailLength = trailLength;
    this.applyShaderConfig();
  }

  /** SDF outline thickness (0..1 of the SDF buffer) and colour. Uniform-only. */
  setOutline(width: number, color?: RGBA8): void {
    this.textOpts.outlineWidth = width;
    if (color) this.textOpts.outlineColor = color;
    this.refreshColors();
    this.map?.triggerRepaint();
  }

  /** Recompile when a structural axis moved; repaint when it didn't. */
  private applyShaderConfig(): void {
    const mode = this.resolveMode();
    const filter = Boolean(this.filterOpts.filterProperty);
    const sdf = this.textOpts.sdf;
    const c = this.shaderConfig;
    if (mode === c.mode && filter === c.filter && sdf === c.sdf) {
      this.map?.triggerRepaint();
      return;
    }
    this.shaderConfig = { mode, filter, sdf };
    this.mainKey = textProgramKey('main', this.shaderConfig);
    this.pickKey = textProgramKey('pick', this.shaderConfig);
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
    this.map?.triggerRepaint();
  }

  /** A `filterProperty` arriving/leaving flips a compiled axis. */
  protected override onFilterChanged(): void {
    if (Boolean(this.filterOpts.filterProperty) !== this.shaderConfig.filter) {
      // The filter COLUMN is baked per tile, so the caches go too.
      this.applyShaderConfig();
      this.rebuildTileCaches();
      return;
    }
    super.onFilterChanged();
  }

  // ── atlas ────────────────────────────────────────────────────────────────

  /**
   * Gate every draw on "we have something to sample". Mirrors the icon layer:
   * missing mapping or missing atlas warns ONCE and draws nothing — never a
   * throw, never an untextured quad.
   */
  private ensureAtlas(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): boolean {
    if (!this.textOpts.fontMapping) {
      this.warnOnce(
        'mapping',
        'fontMapping is required to draw text — nothing will be drawn until it is set',
      );
      return false;
    }
    if (this.atlasState === 'ready' && this.atlasTexture) return true;
    if (this.atlasState === 'failed') return false;
    if (this.atlasState === 'idle') this.resolveAtlasSource();
    if (this.atlasState === 'decoded') return this.uploadAtlas(gl);
    return false;
  }

  /**
   * First look at `fontAtlas`: a string starts a one-shot `Image` load; an
   * already decoded source moves straight to 'decoded'; a source still decoding
   * (an `<img>` with `complete === false`) gets a load listener.
   */
  private resolveAtlasSource(): void {
    const src = this.textOpts.fontAtlas;
    if (!src) {
      this.warnOnce(
        'atlas',
        'fontAtlas is required to draw text — nothing will be drawn until it is set',
      );
      this.atlasState = 'failed';
      return;
    }
    if (typeof src === 'string') {
      this.loadAtlasUrl(src);
      return;
    }
    if (src.complete === false && typeof src.addEventListener === 'function') {
      this.atlasState = 'loading';
      src.addEventListener('load', () => {
        this.atlasImage = src;
        this.atlasState = 'decoded';
        this.map?.triggerRepaint();
      });
      src.addEventListener('error', () => {
        this.atlasState = 'failed';
        this.warnOnce('atlas-decode', 'fontAtlas image failed to decode');
      });
      return;
    }
    this.atlasImage = src;
    this.atlasState = 'decoded';
  }

  /** One-shot CORS-anonymous `Image` load, guarded for non-DOM runtimes. */
  private loadAtlasUrl(url: string): void {
    if (this.atlasUrl === url && this.atlasState === 'loading') return;
    this.atlasUrl = url;
    if (typeof Image === 'undefined') {
      this.atlasState = 'failed';
      this.warnOnce(
        'atlas-env',
        'fontAtlas was given a URL but this runtime has no Image — pass a decoded image instead',
      );
      return;
    }
    this.atlasState = 'loading';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // A later setFontAtlas may have superseded this load.
      if (this.atlasUrl !== url) return;
      this.atlasImage = img as unknown as FontAtlasImage;
      this.atlasState = 'decoded';
      this.map?.triggerRepaint();
    };
    img.onerror = () => {
      if (this.atlasUrl !== url) return;
      this.atlasState = 'failed';
      this.warnOnce('atlas-load', `fontAtlas failed to load: ${url}`);
    };
    img.src = url;
  }

  /**
   * Upload the decoded atlas to a texture.
   *
   * ⚠ `UNPACK_FLIP_Y_WEBGL` is forced OFF and `UNPACK_PREMULTIPLY_ALPHA_WEBGL`
   * too: the mapping's rectangles are in top-left-origin ATLAS pixels, and the
   * fragment stage multiplies coverage by colour itself, so a premultiplied
   * upload would double-multiply and halo every glyph. Both are RESTORED after
   * the upload — maplibre caches pixel-store state and would not repair it.
   */
  private uploadAtlas(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): boolean {
    const img = this.atlasImage;
    if (!img) {
      this.atlasState = 'failed';
      return false;
    }
    const tex = gl.createTexture();
    if (!tex) {
      this.atlasState = 'failed';
      return false;
    }
    const prevFlip = gl.getParameter(UNPACK_FLIP_Y_WEBGL);
    const prevPremul = gl.getParameter(UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      img as unknown as TexImageSource,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(UNPACK_FLIP_Y_WEBGL, prevFlip);
    gl.pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL, prevPremul);
    this.atlasTexture = tex;
    this.atlasWidth = img.width;
    this.atlasHeight = img.height;
    this.atlasState = 'ready';
    return true;
  }

  /** Drop the atlas texture (context loss, source swap, removal). */
  private releaseAtlasTexture(
    gl: WebGLRenderingContext | WebGL2RenderingContext | undefined | null,
  ): void {
    if (this.atlasTexture && gl) gl.deleteTexture(this.atlasTexture);
    this.atlasTexture = undefined;
    if (this.atlasState === 'ready') this.atlasState = 'decoded';
  }

  // ── programs ─────────────────────────────────────────────────────────────

  protected onContextReady(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    // Eagerly link the legacy variant so the first frame doesn't compile.
    this.handles = this.getOrCreateProgram(
      gl,
      this.mainKey,
      LEGACY_FRAME,
      (g, s) => this.buildMainHandles(g, s),
    );
    this.handlesVariant = LEGACY_FRAME.shader.variantName;
    this.mainVaoKey = `${this.mainKey}::${this.handlesVariant}`;
    this.idHandles = this.getOrCreateProgram(
      gl,
      this.pickKey,
      LEGACY_FRAME,
      (g, s) => this.buildIdHandles(g, s),
    );
    this.idHandlesVariant = LEGACY_FRAME.shader.variantName;
  }

  protected onContextLost(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
  ): void {
    this.releaseAtlasTexture(gl);
    this.atlasTexture = undefined;
    this.handles = undefined;
    this.handlesVariant = undefined;
    this.idHandles = undefined;
    this.idHandlesVariant = undefined;
    this.mainVaoKey = '';
  }

  /** Resolve every location a text program can carry. */
  private resolveSharedHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    program: WebGLProgram,
    shader: ShaderInjection,
  ): TextSharedHandles {
    return {
      program,
      usesPrelude: shader.prelude.length > 0,
      aCorner: gl.getAttribLocation(program, 'aCorner'),
      aMercator: gl.getAttribLocation(program, 'aMercator'),
      aTime: gl.getAttribLocation(program, 'aTime'),
      aGlyphRect: gl.getAttribLocation(program, 'aGlyphRect'),
      aGlyphOffset: gl.getAttribLocation(program, 'aGlyphOffset'),
      aSize: gl.getAttribLocation(program, 'aSize'),
      aAngle: gl.getAttribLocation(program, 'aAngle'),
      aColor: gl.getAttribLocation(program, 'aColor'),
      aFilterValue: gl.getAttribLocation(program, DATA_FILTER_NAMES.attribute),
      uMatrix: gl.getUniformLocation(program, 'uMatrix'),
      uPosScale: gl.getUniformLocation(program, 'uPosScale'),
      uPosOffset: gl.getUniformLocation(program, 'uPosOffset'),
      uViewport: gl.getUniformLocation(program, 'uViewport'),
      uAtlasSize: gl.getUniformLocation(program, 'uAtlasSize'),
      uFontSize: gl.getUniformLocation(program, 'uFontSize'),
      uSize: gl.getUniformLocation(program, 'uSize'),
      uSizeScale: gl.getUniformLocation(program, 'uSizeScale'),
      uUseFeatureSize: gl.getUniformLocation(program, 'uUseFeatureSize'),
      uSizeMinPixels: gl.getUniformLocation(program, 'uSizeMinPixels'),
      uSizeMaxPixels: gl.getUniformLocation(program, 'uSizeMaxPixels'),
      uAngle: gl.getUniformLocation(program, 'uAngle'),
      uUseFeatureAngle: gl.getUniformLocation(program, 'uUseFeatureAngle'),
      uUseFeatureColor: gl.getUniformLocation(program, 'uUseFeatureColor'),
      uColor: gl.getUniformLocation(program, 'uColor'),
      uAtlas: gl.getUniformLocation(program, 'uAtlas'),
      uAlphaCutoff: gl.getUniformLocation(program, 'uAlphaCutoff'),
      uSdfBuffer: gl.getUniformLocation(program, 'uSdfBuffer'),
      uSdfSmoothing: gl.getUniformLocation(program, 'uSdfSmoothing'),
      uOutlineBuffer: gl.getUniformLocation(program, 'uOutlineBuffer'),
      uOutlineColor: gl.getUniformLocation(program, 'uOutlineColor'),
      ...resolveTimeUniformLocations(gl, program),
      ...resolveWakeTailScaleUniformLocation(gl, program),
      ...resolveDataFilterUniformLocations(gl, program),
      ...resolveFilterTransformSizeUniformLocation(gl, program),
    };
  }

  /** Link the visual program for a variant and resolve its locations. */
  private buildMainHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): TextSharedHandles {
    const program = this.linkProgram(
      gl,
      buildTextVertexSource(shader, this.shaderConfig),
      buildGlyphFragmentSource('main', this.shaderConfig.sdf),
    );
    return this.resolveSharedHandles(gl, program, shader);
  }

  /** Link the id-pick program for a variant and resolve its locations. */
  private buildIdHandles(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    shader: ShaderInjection,
  ): TextIdProgramHandles {
    const program = this.linkProgram(
      gl,
      buildTextIdVertexSource(shader, this.shaderConfig),
      buildGlyphFragmentSource('id', this.shaderConfig.sdf),
    );
    return {
      ...this.resolveSharedHandles(gl, program, shader),
      aIdColor: gl.getAttribLocation(program, 'aIdColor'),
    };
  }

  /** Fetch (or link) the visual handles for this frame's host variant. */
  private mainHandlesFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
  ): TextSharedHandles {
    const variant = frame.shader.variantName;
    let h = this.handles;
    if (!h || this.handlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.mainKey, frame, (g, s) =>
        this.buildMainHandles(g, s),
      );
      this.handles = h;
      this.handlesVariant = variant;
      this.mainVaoKey = `${this.mainKey}::${variant}`;
    }
    return h;
  }

  /** Fetch (or link) the id-pass handles for this frame's host variant. */
  private idHandlesFor(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    frame: HostFrame,
  ): TextIdProgramHandles {
    const variant = frame.shader.variantName;
    let h = this.idHandles;
    if (!h || this.idHandlesVariant !== variant) {
      h = this.getOrCreateProgram(gl, this.pickKey, frame, (g, s) =>
        this.buildIdHandles(g, s),
      );
      this.idHandles = h;
      this.idHandlesVariant = variant;
    }
    return h;
  }

  // ── tile upload ──────────────────────────────────────────────────────────

  /**
   * Decode, lay out and upload one tile's labels.
   *
   * The whole per-character expansion happens HERE, once, and never again: the
   * dictionary is string-decoded once, the flat UTF-32 buffer is laid out once,
   * and every per-feature attribute is fanned out to per-glyph once. A tile that
   * resolves zero glyphs (no mapping hits, empty labels) returns null, which the
   * base caches as a permanent no-op rather than retrying every frame.
   */
  protected buildTileGpuCache(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    _tile: Tile,
    layer: STTLayer,
  ): TextGpuCache | null {
    if (!this.instSupport.enabled) {
      this.warnOnce(
        'instancing',
        'runtime lacks ANGLE_instanced_arrays / WebGL2; STTTextLayer requires instancing',
      );
      return null;
    }
    const mapping = this.textOpts.fontMapping;
    if (!mapping) return null;
    const f = layer.features;
    if (!f.positions?.length) return null;

    const dims: 2 | 3 = f.positionDimensions === 3 ? 3 : 2;
    const featureCount = f.positions.length / dims;

    const packed = buildTileCodePoints(
      f,
      featureCount,
      this.textOpts.textProperty,
      this.textOpts.text,
    );
    const layout = layoutTileGlyphs(packed, featureCount, {
      mapping,
      fontSize: this.textOpts.fontSize,
      lineHeight: this.textOpts.lineHeight,
      anchorX: this.textOpts.anchorX,
      anchorY: this.textOpts.anchorY,
    });
    if (layout.total === 0) return null;

    const { counts, total } = layout;
    const extras: WebGLBuffer[] = [];

    // Positions: fan out, then quantize the EXPANDED array so the shared
    // dequant chunk (and the base's posScale/posOffset contract) still applies.
    const positions = new Float64Array(total * dims);
    expandFloatsPerGlyph(f.positions, dims, counts, total, positions);
    const { buffer, scale, offset } = this.projectAndUpload(
      gl,
      positions,
      dims,
    );

    const times = new Float32Array(total * 2);
    {
      // Interleave [start, end] per FEATURE, then fan out in the same pass by
      // writing straight into the per-glyph slot.
      let w = 0;
      for (let i = 0; i < counts.length; i++) {
        const s = f.startTimes[i];
        const e = f.endTimes[i];
        for (let n = 0; n < counts[i] && w < total; n++, w++) {
          times[w * 2] = s;
          times[w * 2 + 1] = e;
        }
      }
    }
    const timeBuffer = this.uploadArrayBuffer(gl, times);

    const cache: TextGpuCache = {
      positionBuffer: buffer,
      posScale: scale,
      posOffset: offset,
      timeBuffer,
      // FEATURE count — the base's pick provenance allocates one id per row.
      vertexCount: featureCount,
      indexCount: 0,
      timeOffset: f.timeOffset,
      glyphCount: total,
      glyphCounts: counts,
    };

    cache.glyphBuffer = this.uploadArrayBuffer(gl, layout.glyphs);
    extras.push(cache.glyphBuffer);

    if (this.textOpts.colorProperty) {
      const colors = this.expandCategoricalColors(
        f,
        this.textOpts.colorProperty,
        this.textOpts.colorPalette,
        this.textOpts.colorMapping,
        this.textOpts.colorMappingDefault,
      );
      if (colors) {
        cache.colorBuffer = this.uploadArrayBuffer(
          gl,
          expandBytesPerGlyph(colors, 4, counts, total),
        );
        extras.push(cache.colorBuffer);
      }
    }

    if (this.textOpts.sizeProperty) {
      const sizes = this.getNumericProperty(f, this.textOpts.sizeProperty);
      if (sizes) {
        const out = new Float32Array(total);
        expandFloatsPerGlyph(sizes, 1, counts, total, out);
        cache.sizeBuffer = this.uploadArrayBuffer(gl, out);
        extras.push(cache.sizeBuffer);
      }
    }

    if (this.textOpts.angleProperty) {
      const angles = this.getNumericProperty(f, this.textOpts.angleProperty);
      if (angles) {
        const out = new Float32Array(total);
        expandFloatsPerGlyph(angles, 1, counts, total, out);
        cache.angleBuffer = this.uploadArrayBuffer(gl, out);
        extras.push(cache.angleBuffer);
      }
    }

    if (this.filterOpts.filterProperty) {
      const col = extractFilterColumn(f, this.filterOpts.filterProperty);
      if (col.categorical) this.warnCategoricalFilterOnce();
      cache.hasFilterColumn = col.hasColumn;
      if (col.values) {
        const out = new Float32Array(total);
        expandFloatsPerGlyph(col.values, 1, counts, total, out);
        cache.filterBuffer = this.uploadArrayBuffer(gl, out);
        extras.push(cache.filterBuffer);
      }
    }

    cache.extraBuffers = extras;
    return cache;
  }

  // ── uniforms ─────────────────────────────────────────────────────────────

  /**
   * The `uSizeScale` value for one tile. In `'pixels'` it is the plain
   * `sizeScale` multiplier; in `'meters'` the metres→device-pixels factor at the
   * TILE CENTRE's latitude and the map's FRACTIONAL zoom is folded in, so a
   * ground-metre label grows continuously rather than stepping at integer zooms.
   */
  private sizeScaleForTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    ctx: DrawContext,
  ): number {
    const { sizeScale, sizeUnits } = this.textOpts;
    if (sizeUnits !== 'meters') return sizeScale;
    return sizeScale * this.metricPixelScale(gl, tile, ctx);
  }

  /**
   * Projection uniforms for the frame's host variant: the injected prelude owns
   * projection on v5+, `uMatrix` on legacy hosts. Labels are 2d, so
   * `projectTile`'s z overwrite is exactly what we want.
   */
  private setProjectionUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: TextSharedHandles,
    ctx: DrawContext,
    frame: HostFrame,
  ): void {
    if (h.usesPrelude) this.setPreludeProjectionUniforms(gl, h.program, frame);
    else gl.uniformMatrix4fv(h.uMatrix, false, ctx.matrix);
  }

  /**
   * Sizing / atlas / colour uniforms — everything the visual and id passes set
   * IDENTICALLY, so the pickable glyph always matches the drawn one.
   */
  private setStyleUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: TextSharedHandles,
    sizeScale: number,
    useFeatureSize: boolean,
    useFeatureAngle: boolean,
    useFeatureColor: boolean,
  ): void {
    const o = this.textOpts;
    gl.uniform2f(h.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform2f(h.uAtlasSize, this.atlasWidth || 1, this.atlasHeight || 1);
    gl.uniform1f(h.uFontSize, o.fontSize);
    gl.uniform1f(h.uSize, o.size);
    gl.uniform1f(h.uSizeScale, sizeScale);
    gl.uniform1f(h.uUseFeatureSize, useFeatureSize ? 1 : 0);
    gl.uniform1f(h.uSizeMinPixels, o.sizeMinPixels);
    gl.uniform1f(h.uSizeMaxPixels, o.sizeMaxPixels);
    gl.uniform1f(h.uAngle, o.angle);
    gl.uniform1f(h.uUseFeatureAngle, useFeatureAngle ? 1 : 0);
    gl.uniform4fv(h.uColor, this.fillRgba01);
    gl.uniform1f(h.uUseFeatureColor, useFeatureColor ? 1 : 0);
    gl.uniform1f(h.uAlphaCutoff, o.alphaCutoff);
    if (this.shaderConfig.sdf) {
      gl.uniform1f(h.uSdfBuffer, o.sdfBuffer);
      gl.uniform1f(h.uSdfSmoothing, o.sdfSmoothing);
      // outlineWidth 0 ⇒ outlineBuffer === sdfBuffer ⇒ the fill mix and the
      // coverage term collapse to one value: bit-identical to no outline.
      const outline = Math.max(
        0,
        o.sdfBuffer - Math.max(0, Math.min(1, o.outlineWidth)) * o.sdfBuffer,
      );
      gl.uniform1f(h.uOutlineBuffer, outline);
      gl.uniform4fv(h.uOutlineColor, this.outlineRgba01);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture ?? null);
    gl.uniform1i(h.uAtlas, 0);
  }

  /**
   * Upload the uniforms of the COMPILED time-filter mode. Only the active mode's
   * uniforms exist in the program. `uCurrentTime` is TILE-RELATIVE (the
   * package-wide convention).
   */
  private setTimeUniforms(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: TextSharedHandles,
    cache: TextGpuCache,
    ctx: DrawContext,
  ): void {
    const o = this.textOpts;
    switch (this.shaderConfig.mode) {
      case 'wake':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uWakeLength, o.wakeLength);
        gl.uniform1f(h.uWakeTailScale, o.wakeTailScale);
        break;
      case 'cumulative':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uFadeIn, this.resolveFadeDurations().fadeIn);
        break;
      case 'trail':
        gl.uniform1f(h.uCurrentTime, ctx.currentTime - cache.timeOffset);
        gl.uniform1f(h.uTrailLength, o.trailLength);
        gl.uniform1f(h.uFadeTrail, o.fadeTrail);
        break;
      default: {
        gl.uniform1f(h.uWindowStart, ctx.windowStart);
        gl.uniform1f(h.uWindowEnd, ctx.windowEnd);
        const { fadeIn, fadeOut } = this.resolveFadeDurations();
        gl.uniform1f(h.uFadeIn, fadeIn);
        gl.uniform1f(h.uFadeOut, fadeOut);
      }
    }
  }

  // ── attribute binding ────────────────────────────────────────────────────

  /** Bind one instanced attribute (divisor 1). */
  private bindInstanced(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    loc: number,
    buffer: WebGLBuffer,
    size: number,
    type: number,
    normalized: boolean,
    stride = 0,
    offset = 0,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, type, normalized, stride, offset);
    this.instSupport.vertexAttribDivisor(loc, 1);
  }

  /** Bind every per-instance attribute a glyph draw needs. */
  private bindTileAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: TextSharedHandles,
    c: TextGpuCache,
  ): void {
    gl.bindBuffer(gl.ARRAY_BUFFER, this.getUnitQuad(gl));
    gl.enableVertexAttribArray(h.aCorner);
    gl.vertexAttribPointer(h.aCorner, 2, gl.FLOAT, false, 0, 0);
    this.instSupport.vertexAttribDivisor(h.aCorner, 0);

    this.bindInstanced(
      gl,
      h.aMercator,
      c.positionBuffer,
      3,
      gl.UNSIGNED_SHORT,
      true,
    );
    if (h.aTime >= 0) {
      this.bindInstanced(gl, h.aTime, c.timeBuffer, 2, gl.FLOAT, false);
    }
    if (c.glyphBuffer && h.aGlyphRect >= 0) {
      // One interleaved stride-6 buffer feeds both glyph attributes.
      const stride = GLYPH_STRIDE * 4;
      this.bindInstanced(
        gl,
        h.aGlyphRect,
        c.glyphBuffer,
        4,
        gl.FLOAT,
        false,
        stride,
        0,
      );
      if (h.aGlyphOffset >= 0) {
        this.bindInstanced(
          gl,
          h.aGlyphOffset,
          c.glyphBuffer,
          2,
          gl.FLOAT,
          false,
          stride,
          16,
        );
      }
    }
    if (c.sizeBuffer && h.aSize >= 0) {
      this.bindInstanced(gl, h.aSize, c.sizeBuffer, 1, gl.FLOAT, false);
    }
    if (c.angleBuffer && h.aAngle >= 0) {
      this.bindInstanced(gl, h.aAngle, c.angleBuffer, 1, gl.FLOAT, false);
    }
    if (c.colorBuffer && h.aColor >= 0) {
      this.bindInstanced(
        gl,
        h.aColor,
        c.colorBuffer,
        4,
        gl.UNSIGNED_BYTE,
        true,
      );
    }
    if (c.filterBuffer && h.aFilterValue >= 0) {
      this.bindInstanced(
        gl,
        h.aFilterValue,
        c.filterBuffer,
        1,
        gl.FLOAT,
        false,
      );
    }
  }

  // ── draw ─────────────────────────────────────────────────────────────────

  protected drawTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
  ): void {
    if (!this.instSupport.enabled) return;
    if (!this.ensureAtlas(gl)) return;
    const c = cache as TextGpuCache;
    const count = c.glyphCount; // one instance per CHARACTER
    if (!count) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const h = this.mainHandlesFor(gl, frame);

    gl.useProgram(h.program);
    this.setProjectionUniforms(gl, h, ctx, frame);
    gl.uniform3fv(h.uPosScale, c.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, c.posOffset ?? ZERO_POS_OFFSET);
    this.setStyleUniforms(
      gl,
      h,
      this.sizeScaleForTile(gl, tile, ctx),
      Boolean(c.sizeBuffer) && h.aSize >= 0,
      Boolean(c.angleBuffer) && h.aAngle >= 0,
      Boolean(c.colorBuffer) && h.aColor >= 0,
    );
    this.setTimeUniforms(gl, h, c, ctx);
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, c.hasFilterColumn === true);
    }

    // A VAO records attribute locations against ONE program — drop it when the
    // host flipped shader variants or the layer flipped compiled mode.
    if (c.vao && c.vaoVariant !== this.mainVaoKey) {
      this.vaoSupport.delete(c.vao);
      c.vao = null;
    }
    if (this.vaoSupport.enabled && c.vao) {
      this.vaoSupport.bind(c.vao);
    } else {
      this.bindVaoOrSetup(c, () => this.bindTileAttributes(gl, h, c));
    }
    c.vaoVariant = this.mainVaoKey;

    this.instSupport.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count);
  }

  /**
   * Draw this tile's labels into the id-pick FBO.
   *
   * ⚠ PROVENANCE IS PER FEATURE. `buildPickIdColors(featureCount, idBase)`
   * produces one triple per ROW; `expandPickIdColors` fans each triple across
   * that row's glyphs, so every character of label `i` paints the same colour
   * and a pick anywhere on it — including the counter of an 'o' — decodes to
   * row `i`. The base's provenance table therefore needs no override.
   *
   * Every alpha gate matches {@link drawTile} exactly: same time kernel, same
   * DataFilter uniforms, same size clamps, same coverage and `alphaCutoff`
   * (one fragment-source builder emits both stages).
   */
  protected drawPickTile(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    tile: Tile,
    _layer: STTLayer,
    cache: TileGpuCache,
    ctx: DrawContext,
    idBase: number,
  ): void {
    if (!this.instSupport.enabled) return;
    if (!this.ensureAtlas(gl)) return;
    const c = cache as TextGpuCache;
    const count = c.glyphCount;
    if (!count) return;
    const frame = ctx.frame ?? LEGACY_FRAME;
    const h = this.idHandlesFor(gl, frame);

    const idBuffer = this.uploadArrayBuffer(
      gl,
      expandPickIdColors(
        this.buildPickIdColors(c.vertexCount, idBase),
        c.glyphCounts,
        count,
      ),
    );

    gl.useProgram(h.program);
    this.setProjectionUniforms(gl, h, ctx, frame);
    gl.uniform3fv(h.uPosScale, c.posScale ?? IDENTITY_POS_SCALE);
    gl.uniform3fv(h.uPosOffset, c.posOffset ?? ZERO_POS_OFFSET);
    this.setStyleUniforms(
      gl,
      h,
      this.sizeScaleForTile(gl, tile, ctx),
      Boolean(c.sizeBuffer) && h.aSize >= 0,
      Boolean(c.angleBuffer) && h.aAngle >= 0,
      Boolean(c.colorBuffer) && h.aColor >= 0,
    );
    this.setTimeUniforms(gl, h, c, ctx);
    if (this.shaderConfig.filter) {
      this.uploadDataFilterUniforms(gl, h, c.hasFilterColumn === true);
    }

    // Raw attribute binds (no VAO): picking is a rare user-initiated pass and
    // the id buffer is per-pass, so a cached VAO would just go stale.
    this.bindTileAttributes(gl, h, c);
    this.bindInstanced(gl, h.aIdColor, idBuffer, 3, gl.UNSIGNED_BYTE, true);

    this.instSupport.drawArraysInstanced(TRIANGLE_STRIP, 0, 4, count);

    this.releasePickAttributes(gl, h);
    gl.deleteBuffer(idBuffer);
  }

  /**
   * Leave the default-VAO attribute slate clean and every divisor back at 0, so
   * the next visual frame's VAO recording starts from a known state. Leave a
   * divisor at 1 and the next non-instanced draw on that slot reads one element
   * per INSTANCE instead of per vertex.
   */
  private releasePickAttributes(
    gl: WebGLRenderingContext | WebGL2RenderingContext,
    h: TextIdProgramHandles,
  ): void {
    const locs = [
      h.aCorner,
      h.aMercator,
      h.aTime,
      h.aGlyphRect,
      h.aGlyphOffset,
      h.aSize,
      h.aAngle,
      h.aColor,
      h.aFilterValue,
      h.aIdColor,
    ];
    for (const loc of locs) {
      if (loc < 0) continue;
      gl.disableVertexAttribArray(loc);
      this.instSupport.vertexAttribDivisor(loc, 0);
    }
  }
}
