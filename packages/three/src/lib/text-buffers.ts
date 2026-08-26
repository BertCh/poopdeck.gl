// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of merged TEXT-LABEL glyph buffers — the Three port
 * of deck's `AnimatedTextLayer`, feeding {@link createTextMaterial}. Structurally
 * this is `icon-buffers.ts` with a glyph-layout pass in front of it: one
 * instanced billboard quad PER CHARACTER, each sampling its own sub-rectangle of
 * a caller-supplied SDF / bitmap font atlas, exactly the way the icon builder
 * samples its icon atlas.
 *
 * ── THE DATA RULE (inherited verbatim from the deck layer) ───────────────────
 * NEVER materialize a per-feature row OBJECT. Each `(tile, layer)` pair is
 * decoded ONCE into FLAT typed arrays — a UTF-32 {@link TextBuffers.codePoints}
 * buffer plus per-row {@link TextBuffers.charStarts} offsets, xyz positions,
 * `[start,end]` times rebased to `timeOrigin`, RGBA colours, optional
 * size / angle / filter columns — and every glyph is laid out from those. A
 * categorical label column transcodes once per distinct CATEGORY and blits, so a
 * 100k-feature tile over 6 vessel classes costs 6 transcodes, not 100k. The
 * flat code-point buffer is also the shape deck's own binary `getText` interface
 * takes, so the two backends decode a tile identically.
 *
 * ── WHAT WE BAKE PER GLYPH ───────────────────────────────────────────────────
 *   • `centers`      vec3 world coords, RTC-relative to a shared `origin` (the
 *                    layer writes `object.position = origin`). Every glyph of a
 *                    row carries the SAME centre — the row's anchor point — and
 *                    the glyphs fan out from it in screen space.
 *   • `glyphOffsets` vec2 layout offset of the glyph's quad CENTRE from the row
 *                    anchor, in EM units (1.0 = the label's on-screen `size`).
 *                    This is where the per-character advance layout, the
 *                    `anchor` (start|middle|end, per ROW) and `baseline`
 *                    (top|center|bottom, per PARAGRAPH) alignment, and
 *                    multi-line stacking all land — resolved on the CPU once, so
 *                    the shader only rotates and scales.
 *   • `glyphExtents` vec2 HALF-extent of the glyph quad, also in EM units, so a
 *                    proportional font's `.` and `W` draw at their true widths.
 *   • `uvRects`      vec4 `[u0,v0,u1,v1]` sub-rectangle of the font atlas this
 *                    glyph samples (0..1 atlas texture coords, v origin at the
 *                    TOP — the image convention the material's UV mapping
 *                    assumes).
 *   • `sizes`        per-glyph on-screen EM size in pixels (the material clamps
 *                    to `[sizeMinPixels, sizeMaxPixels]`).
 *   • `angles`       per-glyph rotation in RADIANS. deck measures `getAngle` in
 *                    DEGREES, CCW from up — converted once here.
 *   • `colors`       vec4 tint 0..1. Text glyphs are always MASK sprites (deck's
 *                    `MultiIconLayer` forces mask mode), so the tint supplies the
 *                    colour and the atlas supplies the coverage.
 *   • `starts`/`ends`  the ROW's `[startTime,endTime]` rebased to `timeOrigin`,
 *                    repeated across the row's glyphs — a label appears and
 *                    disappears as one.
 *
 * ── PROVENANCE IS PER FEATURE, NOT PER GLYPH ─────────────────────────────────
 * Every glyph of row `i` pushes the SAME `(tileKey, i)` into
 * {@link TextBuffers.provenance}, so `provenance.length === count` (the GLYPH
 * count) while `resolve()` always lands on the LABEL. A pick anywhere on a
 * label — on its first character or its last — therefore resolves to that
 * label's feature. This is the one place this kind's provenance rule differs
 * from every other layer, where instance and feature are 1:1.
 *
 * ── MULTI-LINE ANCHORING FOLLOWS DECK PER *ROW* ──────────────────────────────
 * Explicit `\n` IS honoured: a paragraph stacks by `lineHeight`, and the whole
 * block is aligned VERTICALLY against the paragraph's total height. HORIZONTALLY
 * each row is anchored against ITS OWN width, not the paragraph's widest row —
 * deck's `TextLayer.getIconOffsets` is
 * `((anchorX - 1) * rowWidth[i]) / 2 + x[i]` (`text-layer.js:90`), where
 * `rowWidth[i]` is the width of the row character `i` sits in and `height` (the
 * paragraph's) drives only the vertical term. So `anchor: 'middle'` CENTRES every
 * row over the feature and `'end'` right-aligns every row, instead of
 * left-aligning them inside one anchored block. Single-line labels — the common
 * case — are identical either way, which is exactly why getting this wrong is
 * invisible until a `\n` shows up.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
 * No word wrapping (`maxWidth`/`wordBreak`), no background/border rectangles, no
 * per-label content-box clipping, and no font-atlas GENERATION — the caller owns
 * the atlas and its mapping. (Unlike {@link STTIconLayer}, whose `atlas` is a
 * REQUIRED prop, this kind's is optional and its absence warns once — see
 * `text-layer.ts`.) A code point absent from `fontMapping` draws nothing and
 * consumes no advance, where deck draws an empty box and advances a fixed
 * `MISSING_CHAR_WIDTH`.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import type { Projection } from '../projection/local-enu.js';
import {
  resolveCategoryColor,
  type RGBA,
  type CategoricalColorSpec,
} from './color.js';
import { featureTileKey } from './id-pick.js';

const DEG2RAD = Math.PI / 180;
/** U+000A — the one control character the layout pass interprets. */
const NEWLINE = 0x0a;
/** deck `fontSettings.fontSize` default: the atlas-pixel height of one EM. */
const DEFAULT_FONT_HEIGHT = 64;

/**
 * One entry of a `fontMapping` — the sub-rectangle of the font atlas a single
 * CHARACTER occupies (in atlas pixels), plus its typographic advance. Mirrors
 * the shape deck's `FontAtlasManager` hands `MultiIconLayer` (and the shape of
 * this package's {@link import('./icon-buffers.js').IconMappingEntry}), so an
 * atlas generated for either backend drops straight in.
 */
export interface TextGlyphMappingEntry {
  /** Left edge of the glyph in the atlas (pixels). */
  x: number;
  /** Top edge of the glyph in the atlas (pixels). */
  y: number;
  /** Glyph width (pixels). */
  width: number;
  /** Glyph height (pixels). */
  height: number;
  /**
   * Horizontal pen advance (pixels) — how far the next character starts from
   * this one. @default `width` (a tight, monospace-ish atlas)
   */
  advance?: number;
  /**
   * Left bearing (pixels): where the glyph BOX starts inside its advance box.
   * @default 0 (the glyph fills its advance)
   */
  xOffset?: number;
  /**
   * Vertical bearing (pixels), POSITIVE DOWN (the atlas convention), applied
   * relative to the line's vertical centre. Negated on the way into world space,
   * where +y is up. @default 0 (the glyph is centred in its line box)
   */
  yOffset?: number;
}

export type TextColorMode =
  | { type: 'constant'; color: RGBA }
  | ({ type: 'categorical' } & CategoricalColorSpec);

/** Horizontal anchoring of a label about its feature position (deck `getTextAnchor`). */
export type TextAnchor = 'start' | 'middle' | 'end';
/** Vertical alignment of a label about its feature position (deck `getAlignmentBaseline`). */
export type TextAlignmentBaseline = 'top' | 'center' | 'bottom';

export interface TextBufferOptions {
  /** Atlas pixel dimensions — used to normalize `fontMapping` rects to 0..1 UV. */
  atlasWidth: number;
  atlasHeight: number;
  /** Named sub-rectangles into the atlas, keyed by the CHARACTER they draw. */
  fontMapping: Record<string, TextGlyphMappingEntry>;
  /**
   * Atlas-pixel height of one EM — the denominator that turns the atlas-pixel
   * mapping into the size-relative layout the shader scales. deck's
   * `fontSettings.fontSize`. @default 64
   */
  fontHeight?: number;
  /** Line box height as a multiple of the EM (deck `lineHeight`). @default 1 */
  lineHeight?: number;

  /**
   * Property column NAME whose per-feature value is drawn as the label. A
   * categorical (string) column is transcoded per CATEGORY; a numeric column is
   * formatted (see {@link textPrecision}). `null` (or a column that is absent on
   * a tile) falls back to {@link textConstant}.
   */
  textProperty: string | null;
  /**
   * Constant label drawn for every feature when {@link textProperty} is null or
   * absent from a tile. @default '' (those rows draw nothing)
   */
  textConstant?: string;
  /**
   * Decimal places used when {@link textProperty} names a NUMERIC column. `null`
   * (the default) prints the SHORTEST decimal string that round-trips back to
   * the stored `float32` — without it a `1.1` stored as float32 renders as
   * `1.100000023841858`. A number pins `toFixed(n)` instead. @default null
   */
  textPrecision?: number | null;

  /** Horizontal anchor of the whole label about its position. @default 'middle' */
  anchor?: TextAnchor;
  /** Vertical alignment of the whole label about its position. @default 'center' */
  baseline?: TextAlignmentBaseline;

  /** Per-feature label size: a numeric column name (pixels) or null. */
  sizeProperty: string | null;
  /** Constant on-screen EM size (pixels) when `sizeProperty` is null/absent. @default 32 */
  sizeConstant?: number;

  /** Per-feature rotation: a numeric column name (degrees, CCW from up) or null. */
  angleProperty: string | null;
  /** Constant rotation (degrees) when `angleProperty` is null/absent. @default 0 */
  angleConstant?: number;

  /** Glyph tint resolution. */
  colorMode: TextColorMode;

  /** Altitude column (metres), per feature. @default null (use geometry z) */
  elevationProperty?: string | null;
  elevationScale?: number;

  /**
   * Numeric column feeding the GPU DataFilter (`sttFilterValue`, per GLYPH — the
   * row's value repeated across its glyphs, so a filtered-out label vanishes
   * whole). When set, `filterValues` is emitted (0 where a tile lacks the
   * column, deck's constant fallback). @default null (no filter attribute)
   */
  filterProperty?: string | null;
}

export interface TextBuffers {
  /** GLYPH instance count — the merged draw count, NOT the label count. */
  count: number;
  /** Number of source features decoded (labelled or not). */
  rowCount: number;
  centers: Float32Array; // vec3, RTC-local — the row anchor, shared by its glyphs
  glyphOffsets: Float32Array; // vec2, EM units, quad centre relative to the anchor
  glyphExtents: Float32Array; // vec2, EM units, quad HALF-extent
  uvRects: Float32Array; // vec4 [u0,v0,u1,v1] (0..1)
  sizes: Float32Array; // float, on-screen EM size in pixels
  angles: Float32Array; // float, RADIANS (CCW from up)
  colors: Float32Array; // vec4 0..1
  starts: Float32Array; // float relative to timeOrigin
  ends: Float32Array; // float relative to timeOrigin
  /** float, per-glyph DataFilter value; 0-length when no `filterProperty`. */
  filterValues: Float32Array;
  /**
   * Flat UTF-32 code points for EVERY decoded row, in merge order — the deck
   * binary-`getText` payload shape. Row `r` spans
   * `[charStarts[r], charStarts[r + 1])`. Kept on the result (rather than thrown
   * away after layout) because it is the decoded truth a caller can re-lay-out,
   * diff, or derive a character set from without touching the tiles again — and
   * kept even when NO glyph rendered (`count === 0` because `fontMapping` maps
   * none of them), which is the case a character-set derivation exists for.
   * Empty only when no feature merged at all.
   */
  codePoints: Uint32Array;
  /** Per-row offsets into {@link codePoints}; length `rowCount + 1`. */
  charStarts: Uint32Array;
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * Per-merged-GLYPH provenance (the GPU picking-catalog identity buffer). Every
   * glyph of a label repeats that label's `(tileKey, featureIndex)`, so a decoded
   * GPU id resolves to the FEATURE the glyph belongs to rather than to the
   * character. Populated in the EXACT order instances are written. Empty when
   * `count === 0`.
   */
  provenance: InstanceProvenance;
  /**
   * `tileKey` → the source layer's {@link BinaryFeatures}, so a resolved
   * provenance entry can be joined back to columns via
   * `getFeatureProperties(binary, featureIndex)`. Built from the SAME iteration
   * (and the same {@link featureTileKey}) as {@link provenance}, so keys align.
   */
  binaryByTileKey: Map<string, BinaryFeatures>;
}

/** A `fontMapping` entry resolved once into the EM-space numbers layout needs. */
interface ResolvedGlyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Quad half-extents in EM units. */
  halfW: number;
  halfH: number;
  /** Pen advance in EM units. */
  advance: number;
  /** Quad centre offset inside the advance box, EM units (x right, y up). */
  dx: number;
  dy: number;
}

function featureColor(b: BinaryFeatures, f: number, mode: TextColorMode): RGBA {
  if (mode.type === 'constant') return mode.color;
  const cat = b.categoricalProps[mode.property];
  const label =
    cat && cat.indices[f] !== 0xffff
      ? cat.categories[cat.indices[f]]
      : undefined;
  return resolveCategoryColor(label, mode.mapping, mode.fallback);
}

function collectPointLayers(tiles: Tile[]): {
  parts: Array<{ b: BinaryFeatures; tileKey: string }>;
  total: number;
} {
  const parts: Array<{ b: BinaryFeatures; tileKey: string }> = [];
  let total = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (!b.featureCount || b.geometryType !== GeometryType.Point) continue;
      parts.push({ b, tileKey: featureTileKey(tile.id, tl.name) });
      total += b.featureCount;
    }
  }
  return { parts, total };
}

/**
 * Shortest decimal string that round-trips back to the same `float32` — the
 * exact helper the deck layer uses, so both backends print a numeric label
 * identically. `numericProps` are `Float32Array`, so `String(v)` prints the
 * float64 widening of the stored float32 and a `1.1` label renders as
 * `1.100000023841858`. float32 needs at most 9 significant digits to round-trip.
 */
function shortestFloat32String(v: number): string {
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(v.toPrecision(p));
    if (Math.fround(candidate) === v) return String(candidate);
  }
  return String(v);
}

/** Number of CODE POINTS in `s` (a surrogate pair counts once). */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) i++;
    n++;
  }
  return n;
}

/** Append `s`'s code points to `out` at `at`; returns the new write cursor. */
function pushCodePoints(s: string, out: Uint32Array, at: number): number {
  let w = at;
  for (const ch of s) out[w++] = ch.codePointAt(0) as number;
  return w;
}

/**
 * Transcode ONE tile layer's label column into a flat UTF-32 buffer plus per-row
 * offsets — never a per-row string object beyond the transient formatting of a
 * numeric column. A categorical column transcodes once per distinct CATEGORY and
 * blits; a missing column falls back to the constant label (blitted once).
 */
function decodeLabels(
  b: BinaryFeatures,
  opts: TextBufferOptions,
): { codePoints: Uint32Array; charStarts: Uint32Array } {
  const count = b.featureCount;
  const charStarts = new Uint32Array(count + 1);
  const prop = opts.textProperty;

  const cat = prop ? b.categoricalProps[prop] : undefined;
  if (cat) {
    const K = cat.categories.length;
    const perCategory: Uint32Array[] = new Array(K);
    for (let k = 0; k < K; k++) {
      const value = cat.categories[k] ?? '';
      const codes = new Uint32Array(codePointLength(value));
      pushCodePoints(value, codes, 0);
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

  const num = prop ? b.numericProps[prop] : undefined;
  if (num) {
    const precision = opts.textPrecision;
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
    for (let i = 0; i < count; i++)
      w = pushCodePoints(labels[i], codePoints, w);
    return { codePoints, charStarts };
  }

  // No column resolved on this tile → the constant label, transcoded ONCE.
  const constant = opts.textConstant ?? '';
  if (!constant) {
    charStarts[count] = 0;
    return { codePoints: new Uint32Array(0), charStarts };
  }
  const one = new Uint32Array(codePointLength(constant));
  pushCodePoints(constant, one, 0);
  const codePoints = new Uint32Array(one.length * count);
  for (let i = 0; i < count; i++) {
    charStarts[i] = i * one.length;
    codePoints.set(one, charStarts[i]);
  }
  charStarts[count] = one.length * count;
  return { codePoints, charStarts };
}

/**
 * Resolve `fontMapping` (keyed by CHARACTER, measured in atlas pixels) into a
 * code-point-keyed table of EM-space layout numbers. Done ONCE per build, so the
 * per-glyph loops are two Map lookups deep at worst.
 */
function resolveGlyphTable(
  opts: TextBufferOptions,
): Map<number, ResolvedGlyph> {
  const table = new Map<number, ResolvedGlyph>();
  const { atlasWidth: aw, atlasHeight: ah } = opts;
  if (aw <= 0 || ah <= 0) return table;
  const em = opts.fontHeight ?? DEFAULT_FONT_HEIGHT;
  if (!(em > 0)) return table;
  for (const ch of Object.keys(opts.fontMapping)) {
    const e = opts.fontMapping[ch];
    const cp = ch.codePointAt(0);
    if (cp === undefined || !e) continue;
    const advance = (e.advance ?? e.width) / em;
    table.set(cp, {
      // Atlas v origin is the TOP (image convention); the material maps the
      // quad's +y (top) back through v0, so top→v0, bottom→v1.
      u0: e.x / aw,
      v0: e.y / ah,
      u1: (e.x + e.width) / aw,
      v1: (e.y + e.height) / ah,
      halfW: e.width / em / 2,
      halfH: e.height / em / 2,
      advance,
      // The quad's centre inside its advance box: the left bearing plus half the
      // glyph's own width.
      dx: ((e.xOffset ?? 0) + e.width / 2) / em,
      // Atlas y grows DOWN, world y grows UP.
      dy: -(e.yOffset ?? 0) / em,
    });
  }
  return table;
}

export function buildTextBuffers(
  tiles: Tile[],
  projection: Projection,
  timeOrigin: number,
  opts: TextBufferOptions,
): TextBuffers {
  const { parts, total: rowTotal } = collectPointLayers(tiles);
  const provenance = new InstanceProvenance();
  const binaryByTileKey = new Map<string, BinaryFeatures>();
  const empty = (): TextBuffers => ({
    count: 0,
    rowCount: 0,
    centers: new Float32Array(0),
    glyphOffsets: new Float32Array(0),
    glyphExtents: new Float32Array(0),
    uvRects: new Float32Array(0),
    sizes: new Float32Array(0),
    angles: new Float32Array(0),
    colors: new Float32Array(0),
    starts: new Float32Array(0),
    ends: new Float32Array(0),
    filterValues: new Float32Array(0),
    codePoints: new Uint32Array(0),
    charStarts: new Uint32Array(1),
    origin: [0, 0, 0],
    bbox: null,
    provenance,
    binaryByTileKey,
  });
  if (rowTotal === 0) return empty();

  // ── Decode every (tile, layer)'s label column ONCE into flat UTF-32 ──────────
  const perPart = parts.map((p) => decodeLabels(p.b, opts));
  const charStarts = new Uint32Array(rowTotal + 1);
  let charTotal = 0;
  for (const d of perPart) charTotal += d.codePoints.length;
  const codePoints = new Uint32Array(charTotal);
  {
    let row = 0;
    let at = 0;
    for (let p = 0; p < parts.length; p++) {
      const d = perPart[p];
      const n = parts[p].b.featureCount;
      for (let i = 0; i < n; i++) charStarts[row + i] = at + d.charStarts[i];
      codePoints.set(d.codePoints, at);
      at += d.codePoints.length;
      row += n;
    }
    charStarts[rowTotal] = at;
  }

  // ── Count the DRAWABLE glyphs (mapped, non-newline) — the instance count ─────
  const glyphs = resolveGlyphTable(opts);
  let total = 0;
  for (let c = 0; c < charTotal; c++) {
    const cp = codePoints[c];
    if (cp === NEWLINE) continue;
    if (glyphs.has(cp)) total++;
  }
  // Features merged but nothing renderable (no label column, an atlas that maps
  // none of the characters): the all-empty DRAW shape, never null — the layer
  // branches on `count === 0`, and a stale pick must resolve to null. The decoded
  // labels still ride out on `codePoints`/`charStarts`, because "the atlas maps
  // none of these characters" is precisely the case where a host wants to derive
  // its character set from them — returning nothing there would make the field's
  // documented purpose unreachable.
  if (total === 0) {
    return { ...empty(), rowCount: rowTotal, codePoints, charStarts };
  }

  const elevScale = opts.elevationScale ?? 1;
  const angleConstant = opts.angleConstant ?? 0;
  const sizeConstant = opts.sizeConstant ?? 32;
  const lineHeight = opts.lineHeight ?? 1;
  const anchor = opts.anchor ?? 'middle';
  const baseline = opts.baseline ?? 'center';

  // RTC origin = first feature of the first layer, projected (absolute world).
  const first = parts[0].b;
  const fdims = first.positionDimensions ?? 2;
  const firstElev = opts.elevationProperty
    ? first.numericProps[opts.elevationProperty]
    : undefined;
  const firstAlt = firstElev
    ? firstElev[0] * elevScale
    : fdims > 2
      ? first.positions[2]
      : 0;
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    firstAlt,
  );
  const [ox, oy, oz] = origin;

  const centers = new Float32Array(total * 3);
  const glyphOffsets = new Float32Array(total * 2);
  const glyphExtents = new Float32Array(total * 2);
  const uvRects = new Float32Array(total * 4);
  const sizes = new Float32Array(total);
  const angles = new Float32Array(total);
  const colors = new Float32Array(total * 4);
  const starts = new Float32Array(total);
  const ends = new Float32Array(total);
  const wantFilter = !!opts.filterProperty;
  const filterValues = wantFilter
    ? new Float32Array(total)
    : new Float32Array(0);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  // Scratch line boundaries + widths, reused across rows (a label is laid out
  // twice: once to measure its paragraph, once to place its glyphs). Grown in
  // lockstep on demand, never allocated per row.
  let lineEnd: Uint32Array = new Uint32Array(4);
  let lineWidth: Float32Array = new Float32Array(4);

  let g = 0; // merged glyph cursor — the GPU id a pick decodes
  let row = 0; // merged row cursor into charStarts
  for (const part of parts) {
    const b = part.b;
    binaryByTileKey.set(part.tileKey, b);
    const count = b.featureCount;
    const dims = b.positionDimensions ?? fdims;
    const elev = opts.elevationProperty
      ? b.numericProps[opts.elevationProperty]
      : undefined;
    const angleCol = opts.angleProperty
      ? b.numericProps[opts.angleProperty]
      : undefined;
    const sizeCol = opts.sizeProperty
      ? b.numericProps[opts.sizeProperty]
      : undefined;
    const filterCol =
      wantFilter && opts.filterProperty
        ? b.numericProps[opts.filterProperty]
        : undefined;
    const rebase = b.timeOffset - timeOrigin;

    for (let i = 0; i < count; i++, row++) {
      const cs = charStarts[row];
      const ce = charStarts[row + 1];
      if (ce <= cs) continue; // an unlabelled row draws — and picks — nothing

      // ── Pass 1: measure the paragraph (per-line widths + line count) ─────────
      let lines = 0;
      let width = 0;
      for (let c = cs; c <= ce; c++) {
        const cp = c < ce ? codePoints[c] : NEWLINE; // sentinel closes the last line
        if (cp === NEWLINE) {
          if (lines >= lineEnd.length) {
            const grownEnd = new Uint32Array(lineEnd.length * 2);
            grownEnd.set(lineEnd);
            lineEnd = grownEnd;
            const grownWidth = new Float32Array(lineWidth.length * 2);
            grownWidth.set(lineWidth);
            lineWidth = grownWidth;
          }
          lineEnd[lines] = c;
          lineWidth[lines] = width;
          lines++;
          width = 0;
          continue;
        }
        const gl = glyphs.get(cp);
        if (gl) width += gl.advance;
      }

      // The VERTICAL alignment is against the whole paragraph's height (deck:
      // `((anchorY - 1) * height) / 2`); the HORIZONTAL anchor is applied PER ROW
      // against that row's own width (deck: `((anchorX - 1) * rowWidth[i]) / 2`,
      // `text-layer.js:90`) and is resolved inside the per-line loop below.
      const blockHeight = lines * lineHeight;
      // World +y is up, so a 'top'-aligned block hangs BELOW the anchor.
      const topY =
        baseline === 'top'
          ? 0
          : baseline === 'bottom'
            ? blockHeight
            : blockHeight / 2;

      // ── Per-feature values, resolved once and repeated across the glyphs ─────
      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = elev
        ? elev[i] * elevScale
        : dims > 2
          ? b.positions[i * dims + 2]
          : 0;
      const [x, y, z] = projection.project(lon, lat, alt);
      const px = x - ox,
        py = y - oy,
        pz = z - oz;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (pz < minZ) minZ = pz;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      if (pz > maxZ) maxZ = pz;

      const angle = (angleCol ? angleCol[i] : angleConstant) * DEG2RAD;
      const size = sizeCol ? sizeCol[i] : sizeConstant;
      const rgba = featureColor(b, i, opts.colorMode);
      const cr = rgba[0] / 255;
      const cg = rgba[1] / 255;
      const cb = rgba[2] / 255;
      const ca = (rgba[3] ?? 255) / 255;
      const s0 = (b.startTimes ? b.startTimes[i] : 0) + rebase;
      const e0 = (b.endTimes ? b.endTimes[i] : 0) + rebase;
      const fv = wantFilter ? (filterCol ? filterCol[i] : 0) : 0;

      // ── Pass 2: place every glyph, line by line ──────────────────────────────
      let c = cs;
      for (let ln = 0; ln < lines; ln++) {
        const stop = lineEnd[ln];
        // Per-ROW horizontal anchor (deck's convention): 'middle' centres THIS
        // row over the feature and 'end' right-aligns it, rather than sliding a
        // left-aligned block sized by the paragraph's widest row.
        const rowWidth = lineWidth[ln];
        let pen =
          anchor === 'start' ? 0 : anchor === 'end' ? -rowWidth : -rowWidth / 2;
        const centreY = topY - (ln + 0.5) * lineHeight;
        for (; c < stop; c++) {
          const gl = glyphs.get(codePoints[c]);
          if (!gl) continue;
          // Provenance is per FEATURE: every glyph of this label pushes the SAME
          // (tileKey, i), so a pick on any character resolves to the label.
          provenance.push(part.tileKey, i);
          centers[g * 3] = px;
          centers[g * 3 + 1] = py;
          centers[g * 3 + 2] = pz;
          glyphOffsets[g * 2] = pen + gl.dx;
          glyphOffsets[g * 2 + 1] = centreY + gl.dy;
          glyphExtents[g * 2] = gl.halfW;
          glyphExtents[g * 2 + 1] = gl.halfH;
          uvRects[g * 4] = gl.u0;
          uvRects[g * 4 + 1] = gl.v0;
          uvRects[g * 4 + 2] = gl.u1;
          uvRects[g * 4 + 3] = gl.v1;
          sizes[g] = size;
          angles[g] = angle;
          colors[g * 4] = cr;
          colors[g * 4 + 1] = cg;
          colors[g * 4 + 2] = cb;
          colors[g * 4 + 3] = ca;
          starts[g] = s0;
          ends[g] = e0;
          if (wantFilter) filterValues[g] = fv;
          pen += gl.advance;
          g++;
        }
        c = stop + 1; // step over the newline that closed this line
      }
    }
  }

  return {
    count: total,
    rowCount: rowTotal,
    centers,
    glyphOffsets,
    glyphExtents,
    uvRects,
    sizes,
    angles,
    colors,
    starts,
    ends,
    filterValues,
    codePoints,
    charStarts,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    provenance,
    binaryByTileKey,
  };
}

export type { RGBA };
