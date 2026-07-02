// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * Default color palettes — the single source of truth shared by every STT
 * renderer.
 *
 * These are **pure data** (no framework/runtime deps) so both the deck.gl
 * adapter (`@poopdeck.gl/layers`) and the MapLibre adapter
 * (`@poopdeck.gl/maplibre`) can import the *same* arrays instead of
 * hand-copying them behind `// (matches deck.gl)` comments. Retuning a default
 * here retunes both renderers at once, and a cross-package test asserts the
 * imports are literally the shared references.
 *
 * All colors are `[r, g, b, a]` in the **0–255** convention (the deck.gl
 * `Color` convention and what maplibre's `colorPalette` / `RGBA8` uses).
 */

/** RGBA tuple in the 0–255 range. */
export type PaletteRGBA = [number, number, number, number];

/**
 * Default categorical palette for **point** layers — Matplotlib `tab10`, with
 * the canonical blue `[31,119,180]` lead. Used by deck's `AnimatedPointLayer`
 * and maplibre's `STTPointLayer`.
 */
export const DEFAULT_CATEGORICAL_PALETTE: PaletteRGBA[] = [
  [31, 119, 180, 255],
  [255, 127, 14, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
  [140, 86, 75, 255],
  [227, 119, 194, 255],
  [127, 127, 127, 255],
  [188, 189, 34, 255],
  [23, 190, 207, 255],
];

/**
 * Default categorical palette for **line / path** layers — `tab10` with a
 * brighter `[0,150,255]` blue lead (reads better as a stroke than tab10's
 * muted blue). Used by deck's `AnimatedLineLayer` / `AnimatedPathLayer` and
 * maplibre's `STTLineLayer`.
 */
export const DEFAULT_LINE_PALETTE: PaletteRGBA[] = [
  [0, 150, 255, 255],
  [255, 127, 14, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
  [140, 86, 75, 255],
  [227, 119, 194, 255],
  [127, 127, 127, 255],
  [188, 189, 34, 255],
  [23, 190, 207, 255],
];

/**
 * Default categorical palette for **polygon** fills — `tab10` reordered to an
 * orange `[255,140,0]` lead, at 180/255 alpha so stacked fills stay legible.
 * Used by deck's `AnimatedPolygonLayer` and maplibre's `PolygonLayer`.
 */
export const DEFAULT_POLYGON_PALETTE: PaletteRGBA[] = [
  [255, 140, 0, 180],
  [31, 119, 180, 180],
  [44, 160, 44, 180],
  [214, 39, 40, 180],
  [148, 103, 189, 180],
  [140, 86, 75, 180],
  [227, 119, 194, 180],
  [127, 127, 127, 180],
  [188, 189, 34, 180],
  [23, 190, 207, 180],
];

/**
 * Default categorical palette for **trips** — a 5-color subset with a warm
 * `[253,128,93]` lead. Used by deck's `AnimatedTripsLayer` and maplibre's
 * `STTTripsLayer`.
 */
export const DEFAULT_TRIPS_PALETTE: PaletteRGBA[] = [
  [253, 128, 93, 255],
  [0, 150, 255, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
];

/**
 * Default **heatmap** color ramp — ColorBrewer `OrRd`, 7 stops, low → high
 * density. Used by deck's `HeatmapLayer` (`colorRange`) and maplibre's
 * `STTHeatmapLayer` (`colorRange`).
 */
export const DEFAULT_HEATMAP_COLOR_RANGE: PaletteRGBA[] = [
  [255, 255, 178, 255],
  [254, 217, 118, 255],
  [254, 178, 76, 255],
  [253, 141, 60, 255],
  [252, 78, 42, 255],
  [227, 26, 28, 255],
  [177, 0, 38, 255],
];

/**
 * Default OD-**arc** endpoint colors — a bright-blue source flowing to a `tab10`
 * orange target. Used by deck's `AnimatedArcLayer` (`getSourceColor` /
 * `getTargetColor`) and three's arc buffers; shared so the gradient ends can't
 * silently drift between backends.
 */
export const DEFAULT_ARC_SOURCE_COLOR: PaletteRGBA = [0, 150, 255, 255];
export const DEFAULT_ARC_TARGET_COLOR: PaletteRGBA = [255, 127, 14, 255];

/**
 * Default **summary-tier** density ramp (H3 / Quadbin cell count) — ColorBrewer
 * `YlGnBu`, 6 stops, low → high count. Used by deck's `H3SummaryLayer` and
 * `QuadbinSummaryLayer` (`colorRange`); shared so the two summary layers can't
 * silently drift apart.
 */
export const DEFAULT_SUMMARY_COLOR_RANGE: PaletteRGBA[] = [
  [255, 255, 204, 220],
  [199, 233, 180, 230],
  [127, 205, 187, 235],
  [65, 182, 196, 240],
  [44, 127, 184, 245],
  [37, 52, 148, 255],
];
