/**
 * Shared outline / stroke prop-family contract for the summary layers.
 *
 * H3SummaryLayer and QuadbinSummaryLayer resolve the outline family (the
 * `lineColor` → `getLineColor` alias, the function-accessor fallback for binary
 * summary cells, and the stroke-prop cache invalidation) with byte-identical
 * logic. This `describe.each` drives that shared contract against BOTH layers so
 * neither file has to copy-paste it. The layer-UNIQUE bits stay in the sibling
 * files (H3 cell u64 round-trip; Quadbin picking / empty cases / elevation /
 * decoding / line-width column fallback).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { h3SummaryHarness, quadbinSummaryHarness } from './summary-harness';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

vi.mock('@deck.gl/geo-layers', () => {
  class FakeH3HexagonLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeQuadkeyLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { H3HexagonLayer: FakeH3HexagonLayer, QuadkeyLayer: FakeQuadkeyLayer };
});

beforeEach(() => {
  vi.resetModules();
});

describe.each([h3SummaryHarness(), quadbinSummaryHarness()])(
  '$name — shared outline / stroke forwarding',
  (h) => {
    it('lineColor constant drives getLineColor', async () => {
      const layer = await h.makeLayer({ lineColor: [10, 20, 30, 200] });
      const [sub] = layer.renderLayers() as CapturedLayer[];
      expect(sub.props.getLineColor).toEqual([10, 20, 30, 200]);
    });

    it('getLineColor alias wins over lineColor', async () => {
      const layer = await h.makeLayer({
        lineColor: [10, 20, 30, 200],
        getLineColor: [1, 2, 3, 255],
      });
      const [sub] = layer.renderLayers() as CapturedLayer[];
      expect(sub.props.getLineColor).toEqual([1, 2, 3, 255]);
    });

    it('a function-valued getLineColor falls back to the lineColor constant (no crash)', async () => {
      const layer = await h.makeLayer({
        lineColor: [7, 8, 9, 255],
        getLineColor: () => [255, 0, 0, 255],
      });
      const [sub] = layer.renderLayers() as CapturedLayer[];
      // Binary summary tiles can't run per-feature JS — the alias is ignored and
      // the constant `lineColor` is forwarded instead.
      expect(sub.props.getLineColor).toEqual([7, 8, 9, 255]);
    });

    it('a stroked toggle rebuilds the cached sublayer', async () => {
      const layer = await h.makeLayer({ stroked: true });
      const [first] = layer.renderLayers() as CapturedLayer[];
      layer.props.stroked = false;
      const [second] = layer.renderLayers() as CapturedLayer[];
      expect(second).not.toBe(first);
      expect(second.props.stroked).toBe(false);
    });

    it('a lineColor change rebuilds the cached sublayer', async () => {
      const layer = await h.makeLayer({ lineColor: [0, 0, 0, 255] });
      const [first] = layer.renderLayers() as CapturedLayer[];
      // Unchanged props → same cached instance.
      expect(layer.renderLayers()[0]).toBe(first);
      layer.props.lineColor = [1, 1, 1, 255];
      const [second] = layer.renderLayers() as CapturedLayer[];
      expect(second).not.toBe(first);
      expect(second.props.getLineColor).toEqual([1, 1, 1, 255]);
    });
  },
);
