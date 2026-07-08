/**
 * Public-export contract for the heatmap layer. `AnimatedHeatmapLayer` is the
 * canonical class (named so it does not shadow `@deck.gl/aggregation-layers`'
 * `HeatmapLayer`). The old `HeatmapLayer` alias has been removed.
 */

import { describe, it, expect } from 'vitest';

describe('heatmap layer export (rename complete)', () => {
  it('exports AnimatedHeatmapLayer as the canonical class (module)', async () => {
    const mod = (await import('../src/layers/summary/heatmap-layer')) as Record<
      string,
      any
    >;
    expect(mod.AnimatedHeatmapLayer).toBeTypeOf('function');
    expect((mod.AnimatedHeatmapLayer as any).layerName).toBe(
      'AnimatedHeatmapLayer',
    );
    // The deprecated `HeatmapLayer` alias was removed.
    expect(mod.HeatmapLayer).toBeUndefined();
  });

  it('re-exports AnimatedHeatmapLayer from the package index (and not the old alias)', async () => {
    const index = (await import('../src/index')) as Record<string, any>;
    const mod = await import('../src/layers/summary/heatmap-layer');
    expect(index.AnimatedHeatmapLayer).toBe(mod.AnimatedHeatmapLayer);
    expect(index.HeatmapLayer).toBeUndefined();
  });
});
