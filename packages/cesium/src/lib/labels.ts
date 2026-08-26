// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * Pure (Cesium-free) assembly of per-feature map LABELS from decoded Point
 * tiles — the CPU builder behind `STTTextLayer.setTiles`. Structurally this is
 * `points.ts` with a label-text resolution pass bolted on: it reuses that
 * module's `collectPointLayers`, the same `GlobeProjection({datum:'wgs84'})`
 * ECEF projection, and the same rebase-to-the-first-layer time convention.
 *
 * ── THE LABEL TEXT COMES FROM A COLUMN, NEVER AN ACCESSOR ────────────────────
 * Per-feature JS function accessors do not exist in this codebase (the
 * accessor-alias convention: every styling input is a CONSTANT or a baked
 * property-COLUMN name). {@link LabelBuildOptions.textProperty} names that
 * column:
 *   - a CATEGORICAL column indexes its own `categories` array, so a 100k-feature
 *     tile over six vessel classes yields six distinct strings shared by
 *     reference — not 100k;
 *   - a NUMERIC column is formatted per feature, with
 *     {@link LabelBuildOptions.textPrecision} pinning `toFixed(n)` or (the
 *     default) the SHORTEST decimal string that round-trips back to the stored
 *     `float32` — see {@link shortestFloat32String};
 *   - an absent column falls back to {@link LabelBuildOptions.textConstant}.
 *
 * Features whose resolved text is EMPTY are dropped from the build entirely,
 * matching deck's `AnimatedTextLayer` (a label with nothing to draw should not
 * cost a primitive). Note the consequence, which the layer's picking relies on:
 * `labels[i]` is NOT `featureIndex === i`, so provenance always travels with the
 * entry rather than being recomputed from its position.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT BUILD ────────────────────────────────────
 * No UTF-32 code-point buffer, no per-row character offsets, no glyph layout.
 * deck and three carry all three because they instance one quad PER CHARACTER
 * themselves; Cesium's `LabelCollection` takes a plain `text` string and owns
 * the SDF glyph atlas, so this backend never needs them. That is a real
 * simplification of the same problem, not a reduced feature set — see the
 * header of `cesium-text-layer.ts` for the deviations that ARE feature cuts.
 *
 * Positions are ABSOLUTE f64 ECEF metres (no RTC): Cesium consumes CPU doubles
 * (`Cartesian3`), so there is no f32 buffer to protect.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { NULL_CATEGORY_INDEX, type RGBA255 } from '@poopdeck.gl/core/style';
import { featureColor, type FeatureColorMode } from './feature-color.js';
import { collectPointLayers } from './points.js';

/** Horizontal anchoring of the label about its position (deck `getTextAnchor`). */
export type LabelAnchor = 'start' | 'middle' | 'end';
/** Vertical alignment of the label about its position (deck `getAlignmentBaseline`). */
export type LabelBaseline = 'top' | 'center' | 'bottom';

/** One renderable label: absolute ECEF anchor + text + normalized base colours. */
export interface FeatureLabel {
  /** Absolute ECEF position (metres), x/y/z. */
  x: number;
  y: number;
  z: number;
  /** The resolved label text. Never empty — empty-labelled features are dropped. */
  text: string;
  /** Glyph fill colour, pre-normalized to 0..1. Alpha animates as `fillA × timeFilterAlpha`. */
  fillR: number;
  fillG: number;
  fillB: number;
  fillA: number;
  /**
   * Glyph outline colour, pre-normalized to 0..1. All zero when the build has
   * no outline mode; the layer reads {@link LabelBuild.hasOutline}, never these
   * channels, to decide whether to draw and animate an outline.
   */
  outlineR: number;
  outlineG: number;
  outlineB: number;
  outlineA: number;
  /** Per-feature size multiplier on the layer's shared `font` (Cesium `Label.scale`). */
  scale: number;
  /** Feature active window, relative to the build's `timeOrigin` (ms). */
  start: number;
  end: number;
  /** Source lon/lat (degrees) — the picking coordinate. */
  lon: number;
  lat: number;
  /** Picking provenance. */
  binary: BinaryFeatures;
  featureIndex: number;
}

/** A built label set, rebased to one scene-wide time origin. */
export interface LabelBuild {
  labels: FeatureLabel[];
  /** Absolute time origin (ms) all `start`/`end` are relative to. */
  timeOrigin: number;
  /**
   * Whether an outline colour mode was supplied. Drives the layer's
   * `LabelStyle` choice and whether `setTime` animates a second colour — a
   * build-wide decision, so it lives here rather than being re-derived per
   * entry.
   */
  hasOutline: boolean;
}

export interface LabelBuildOptions {
  /**
   * Property column NAME whose per-feature value is drawn as the label text. A
   * categorical (string) column is read by index; a numeric column is formatted
   * (see {@link textPrecision}). `null`/absent falls back to
   * {@link textConstant}.
   */
  textProperty?: string | null;
  /**
   * Label drawn for every feature when {@link textProperty} is null or absent
   * from a tile. @default '' — which drops every feature, so a build with
   * neither a resolvable column nor a constant is legitimately empty.
   */
  textConstant?: string;
  /**
   * Decimal places used when {@link textProperty} names a NUMERIC column.
   * `null` (the default) prints the shortest round-tripping decimal; a number
   * pins `toFixed(n)`. @default null
   */
  textPrecision?: number | null;
  /** Glyph fill colour. @default constant near-white */
  color?: FeatureColorMode;
  /**
   * Glyph outline (halo) colour. `null` draws no outline — the label renders
   * `LabelStyle.FILL`. @default null
   */
  outlineColor?: FeatureColorMode | null;
  /**
   * Numeric column NAME giving each label's size multiplier. Non-finite values
   * fall back to {@link scaleConstant}. @default null
   */
  scaleProperty?: string | null;
  /** Size multiplier when {@link scaleProperty} is null/absent. @default 1 */
  scaleConstant?: number;
  /**
   * Constant altitude lift in metres applied to every anchor — floats labels
   * clear of the ellipsoid (and of the geometry they annotate) instead of
   * z-fighting it. @default 0
   */
  zLift?: number;
}

// One WGS84 globe for every build — Cesium's native frame (§5.2: datum matters).
// Byte-identical to the point/polyline builders' GLOBE; `project` is
// anchor-independent, so the duplication costs nothing and keeps this module
// self-contained.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

/** Near-white: legible against both a dark globe and a satellite basemap. */
const DEFAULT_FILL: RGBA255 = [245, 247, 250, 255];

/** Placeholder outline channels for a build with no outline mode. */
const NO_OUTLINE: RGBA255 = [0, 0, 0, 0];

/**
 * Shortest decimal string that round-trips back to the same `float32` — the
 * same helper deck's `AnimatedTextLayer` and three's `text-buffers.ts` use, so a
 * numeric label prints IDENTICALLY on all three backends. `numericProps` are
 * `Float32Array`, so a plain `String(v)` prints the float64 widening of the
 * stored float32 and renders a `1.1` as `1.100000023841858`. float32 needs at
 * most 9 significant digits to round-trip.
 */
export function shortestFloat32String(v: number): string {
  for (let p = 1; p <= 9; p++) {
    const candidate = Number(v.toPrecision(p));
    if (Math.fround(candidate) === v) return String(candidate);
  }
  return String(v);
}

/**
 * Format one numeric-column value as label text. Non-finite values (a NaN
 * sentinel, an absent measurement) produce `''` and so drop the feature —
 * drawing `NaN` on a map is worse than drawing nothing.
 */
export function formatNumericLabel(
  v: number,
  precision: number | null | undefined,
): string {
  if (!Number.isFinite(v)) return '';
  return typeof precision === 'number'
    ? v.toFixed(precision)
    : shortestFloat32String(v);
}

/**
 * Build one label per Point feature whose text resolves to a non-empty string
 * (geometry z used when the tile is 3-D, plus `zLift`). Times are rebased to
 * the first Point layer's `timeOffset`. Returns an empty build
 * (`timeOrigin: 0`) when there is nothing to draw — the layer checks
 * `labels.length` before adopting `timeOrigin`, so an empty rebuild leaves the
 * previous origin untouched.
 */
export function buildLabelEntries(
  tiles: Tile[],
  opts: LabelBuildOptions = {},
): LabelBuild {
  const hasOutline = opts.outlineColor != null;
  const pointLayers = collectPointLayers(tiles);
  if (pointLayers.length === 0)
    return { labels: [], timeOrigin: 0, hasOutline };

  const timeOrigin = pointLayers[0].timeOffset;
  const fillMode: FeatureColorMode = opts.color ?? {
    type: 'constant',
    color: DEFAULT_FILL,
  };
  const outlineMode = opts.outlineColor ?? null;
  const constant = opts.textConstant ?? '';
  const scaleConstant = opts.scaleConstant ?? 1;
  const zLift = opts.zLift ?? 0;
  const labels: FeatureLabel[] = [];

  for (const b of pointLayers) {
    const dims = b.positionDimensions ?? 2;
    const rebase = b.timeOffset - timeOrigin;
    // Resolve the label column ONCE per layer. A categorical column wins over a
    // numeric one of the same name (a column is only ever one of the two); when
    // neither resolves, every feature shares the constant string by reference.
    const prop = opts.textProperty ?? null;
    const cat = prop ? b.categoricalProps[prop] : undefined;
    const num = prop && !cat ? b.numericProps[prop] : undefined;
    const scaleCol = opts.scaleProperty
      ? b.numericProps[opts.scaleProperty]
      : undefined;

    for (let i = 0; i < b.featureCount; i++) {
      let text: string;
      if (cat) {
        const idx = cat.indices[i];
        text =
          idx === NULL_CATEGORY_INDEX || idx >= cat.categories.length
            ? ''
            : (cat.categories[idx] ?? '');
      } else if (num) {
        text = formatNumericLabel(num[i], opts.textPrecision);
      } else {
        text = constant;
      }
      if (text === '') continue; // nothing to draw → no primitive, no entry

      const lon = b.positions[i * dims];
      const lat = b.positions[i * dims + 1];
      const alt = (dims > 2 ? b.positions[i * dims + 2] : 0) + zLift;
      const [x, y, z] = GLOBE.project(lon, lat, alt);
      // Normalize colour channels to 0..1 ONCE here so the per-frame setTime
      // loop never re-divides by 255.
      const fill = featureColor(b, i, fillMode);
      const outline = outlineMode
        ? featureColor(b, i, outlineMode)
        : NO_OUTLINE;
      const rawScale = scaleCol ? scaleCol[i] : scaleConstant;

      labels.push({
        x,
        y,
        z,
        text,
        fillR: fill[0] / 255,
        fillG: fill[1] / 255,
        fillB: fill[2] / 255,
        fillA: (fill[3] ?? 255) / 255,
        outlineR: outline[0] / 255,
        outlineG: outline[1] / 255,
        outlineB: outline[2] / 255,
        outlineA: (outline[3] ?? 255) / 255,
        scale: Number.isFinite(rawScale) ? rawScale : scaleConstant,
        start: b.startTimes[i] + rebase,
        end: b.endTimes[i] + rebase,
        lon,
        lat,
        binary: b,
        featureIndex: i,
      });
    }
  }

  return { labels, timeOrigin, hasOutline };
}
