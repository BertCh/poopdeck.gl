/**
 * Public-export contract for the heatmap rename (audit: the exported
 * `HeatmapLayer` shadowed `@deck.gl/aggregation-layers`' HeatmapLayer).
 * `AnimatedHeatmapLayer` is the real class; `HeatmapLayer` must remain a
 * deprecated alias of the SAME class so existing imports keep working.
 */

import { describe, it, expect } from 'vitest';

describe('heatmap rename aliases', () => {
  it('exports HeatmapLayer as an alias of AnimatedHeatmapLayer (module)', async () => {
    const mod = await import('../src/heatmap-layer');
    expect(mod.AnimatedHeatmapLayer).toBeTypeOf('function');
    expect(mod.HeatmapLayer).toBe(mod.AnimatedHeatmapLayer);
    expect((mod.AnimatedHeatmapLayer as any).layerName).toBe('AnimatedHeatmapLayer');
  });

  it('re-exports both names from the package index', async () => {
    const index = await import('../src/index');
    const mod = await import('../src/heatmap-layer');
    expect(index.AnimatedHeatmapLayer).toBe(mod.AnimatedHeatmapLayer);
    expect(index.HeatmapLayer).toBe(mod.AnimatedHeatmapLayer);
  });
});

describe('new layer exports (OD flows / icons / columns / Quadbin summary)', () => {
  it('re-exports every new layer class from the package index with a matching layerName', async () => {
    const index = (await import('../src/index')) as Record<string, any>;
    for (const name of [
      'AnimatedArcLayer',
      'AnimatedLineLayer',
      'AnimatedIconLayer',
      'AnimatedColumnLayer',
      'QuadbinSummaryLayer',
    ]) {
      expect(index[name], `index.${name}`).toBeTypeOf('function');
      expect(index[name].layerName).toBe(name);
    }
  });
});
