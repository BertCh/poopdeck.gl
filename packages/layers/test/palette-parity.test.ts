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

describe('deck layer defaults consume the shared @poopdeck.gl/core palettes', () => {
  it('AnimatedPointLayer / AnimatedIconLayer → tab10 categorical', async () => {
    const { AnimatedPointLayer, AnimatedIconLayer } =
      await import('../src/index');
    expect(
      readArrayDefault(AnimatedPointLayer.defaultProps.colorPalette),
    ).toEqual(DEFAULT_CATEGORICAL_PALETTE);
    expect(
      readArrayDefault(AnimatedIconLayer.defaultProps.colorPalette),
    ).toEqual(DEFAULT_CATEGORICAL_PALETTE);
  });

  it('AnimatedLineLayer / AnimatedPathLayer / AnimatedArcLayer → line palette', async () => {
    const { AnimatedLineLayer, AnimatedPathLayer, AnimatedArcLayer } =
      await import('../src/index');
    expect(
      readArrayDefault(AnimatedLineLayer.defaultProps.colorPalette),
    ).toEqual(DEFAULT_LINE_PALETTE);
    expect(
      readArrayDefault(AnimatedPathLayer.defaultProps.colorPalette),
    ).toEqual(DEFAULT_LINE_PALETTE);
    expect(
      readArrayDefault(AnimatedArcLayer.defaultProps.colorPalette),
    ).toEqual(DEFAULT_LINE_PALETTE);
  });

  it('AnimatedPolygonLayer → polygon palette', async () => {
    const { AnimatedPolygonLayer } = await import('../src/index');
    expect(
      readArrayDefault(AnimatedPolygonLayer.defaultProps.colorPalette),
    ).toEqual(DEFAULT_POLYGON_PALETTE);
  });

  it('AnimatedTripsLayer → trips palette', async () => {
    const { AnimatedTripsLayer } = await import('../src/index');
    expect(
      readArrayDefault(AnimatedTripsLayer.defaultProps.colorPalette),
    ).toEqual(DEFAULT_TRIPS_PALETTE);
  });

  it('AnimatedHeatmapLayer → OrRd-7 ramp', async () => {
    const { AnimatedHeatmapLayer } = await import('../src/index');
    expect(
      readArrayDefault(AnimatedHeatmapLayer.defaultProps.colorRange),
    ).toEqual(DEFAULT_HEATMAP_COLOR_RANGE);
  });

  it('H3SummaryLayer / QuadbinSummaryLayer → shared YlGnBu-6 summary ramp', async () => {
    const { H3SummaryLayer, QuadbinSummaryLayer } =
      await import('../src/index');
    expect(readArrayDefault(H3SummaryLayer.defaultProps.colorRange)).toEqual(
      DEFAULT_SUMMARY_COLOR_RANGE,
    );
    expect(
      readArrayDefault(QuadbinSummaryLayer.defaultProps.colorRange),
    ).toEqual(DEFAULT_SUMMARY_COLOR_RANGE);
  });
});
