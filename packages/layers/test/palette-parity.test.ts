/**
 * Cross-package parity for the shared default palettes (audit F2).
 *
 * The categorical / heatmap default palettes used to be hand-copied into every
 * deck layer AND every maplibre layer behind `// (matches deck.gl)` comments,
 * with nothing enforcing they stayed equal. They now live once in
 * `@poopdeck.gl/core` (`palettes.ts`); this test:
 *
 *   1. pins the canonical values of the shared source (so retuning a default is
 *      a single, test-visible edit rather than a silent multi-package drift),
 *      and
 *   2. proves each deck layer's `defaultProps` palette IS the shared
 *      `@poopdeck.gl/core` array (not a re-introduced local copy).
 *
 * The maplibre adapter imports the same `@poopdeck.gl/core` exports (verified by
 * compile — a rename would fail `tsc`), so pinning the core source pins both.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CATEGORICAL_PALETTE,
  DEFAULT_LINE_PALETTE,
  DEFAULT_POLYGON_PALETTE,
  DEFAULT_TRIPS_PALETTE,
  DEFAULT_HEATMAP_COLOR_RANGE,
  DEFAULT_SUMMARY_COLOR_RANGE,
} from '@poopdeck.gl/core';

/** deck stores array default props either raw or as `{ value }`; read either. */
function readArrayDefault(prop: unknown): unknown {
  if (Array.isArray(prop)) return prop;
  if (prop && typeof prop === 'object' && 'value' in (prop as any)) {
    return (prop as any).value;
  }
  return prop;
}

describe('shared default palettes — canonical values', () => {
  it('tab10 categorical (point/icon)', () => {
    expect(DEFAULT_CATEGORICAL_PALETTE).toEqual([
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
    ]);
  });

  it('line/path/arc categorical (bright-blue lead)', () => {
    expect(DEFAULT_LINE_PALETTE).toEqual([
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
    ]);
    // Differs from tab10 only in the lead color (alpha aside).
    expect(DEFAULT_LINE_PALETTE.slice(1)).toEqual(
      DEFAULT_CATEGORICAL_PALETTE.slice(1),
    );
  });

  it('polygon categorical (orange lead, 180 alpha)', () => {
    expect(DEFAULT_POLYGON_PALETTE).toEqual([
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
    ]);
    // Fills are semi-transparent so stacked polygons stay legible.
    expect(DEFAULT_POLYGON_PALETTE.every((c) => c[3] === 180)).toBe(true);
  });

  it('trips categorical (5-color, warm lead)', () => {
    expect(DEFAULT_TRIPS_PALETTE).toEqual([
      [253, 128, 93, 255],
      [0, 150, 255, 255],
      [44, 160, 44, 255],
      [214, 39, 40, 255],
      [148, 103, 189, 255],
    ]);
  });

  it('OrRd-7 heatmap ramp', () => {
    expect(DEFAULT_HEATMAP_COLOR_RANGE).toEqual([
      [255, 255, 178, 255],
      [254, 217, 118, 255],
      [254, 178, 76, 255],
      [253, 141, 60, 255],
      [252, 78, 42, 255],
      [227, 26, 28, 255],
      [177, 0, 38, 255],
    ]);
  });

  it('YlGnBu-6 summary-tier density ramp', () => {
    expect(DEFAULT_SUMMARY_COLOR_RANGE).toEqual([
      [255, 255, 204, 220],
      [199, 233, 180, 230],
      [127, 205, 187, 235],
      [65, 182, 196, 240],
      [44, 127, 184, 245],
      [37, 52, 148, 255],
    ]);
  });
});

describe('deck layer defaults consume the shared @poopdeck.gl/core palettes', () => {
  it('AnimatedPointLayer / AnimatedIconLayer → tab10 categorical', async () => {
    const { AnimatedPointLayer, AnimatedIconLayer } = await import('../src/index');
    expect(readArrayDefault(AnimatedPointLayer.defaultProps.colorPalette)).toEqual(
      DEFAULT_CATEGORICAL_PALETTE,
    );
    expect(readArrayDefault(AnimatedIconLayer.defaultProps.colorPalette)).toEqual(
      DEFAULT_CATEGORICAL_PALETTE,
    );
  });

  it('AnimatedLineLayer / AnimatedPathLayer / AnimatedArcLayer → line palette', async () => {
    const { AnimatedLineLayer, AnimatedPathLayer, AnimatedArcLayer } =
      await import('../src/index');
    expect(readArrayDefault(AnimatedLineLayer.defaultProps.colorPalette)).toEqual(
      DEFAULT_LINE_PALETTE,
    );
    expect(readArrayDefault(AnimatedPathLayer.defaultProps.colorPalette)).toEqual(
      DEFAULT_LINE_PALETTE,
    );
    expect(readArrayDefault(AnimatedArcLayer.defaultProps.colorPalette)).toEqual(
      DEFAULT_LINE_PALETTE,
    );
  });

  it('AnimatedPolygonLayer → polygon palette', async () => {
    const { AnimatedPolygonLayer } = await import('../src/index');
    expect(readArrayDefault(AnimatedPolygonLayer.defaultProps.colorPalette)).toEqual(
      DEFAULT_POLYGON_PALETTE,
    );
  });

  it('AnimatedTripsLayer → trips palette', async () => {
    const { AnimatedTripsLayer } = await import('../src/index');
    expect(readArrayDefault(AnimatedTripsLayer.defaultProps.colorPalette)).toEqual(
      DEFAULT_TRIPS_PALETTE,
    );
  });

  it('AnimatedHeatmapLayer → OrRd-7 ramp', async () => {
    const { AnimatedHeatmapLayer } = await import('../src/index');
    expect(readArrayDefault(AnimatedHeatmapLayer.defaultProps.colorRange)).toEqual(
      DEFAULT_HEATMAP_COLOR_RANGE,
    );
  });

  it('H3SummaryLayer / QuadbinSummaryLayer → shared YlGnBu-6 summary ramp', async () => {
    const { H3SummaryLayer, QuadbinSummaryLayer } = await import('../src/index');
    expect(readArrayDefault(H3SummaryLayer.defaultProps.colorRange)).toEqual(
      DEFAULT_SUMMARY_COLOR_RANGE,
    );
    expect(readArrayDefault(QuadbinSummaryLayer.defaultProps.colorRange)).toEqual(
      DEFAULT_SUMMARY_COLOR_RANGE,
    );
  });
});
