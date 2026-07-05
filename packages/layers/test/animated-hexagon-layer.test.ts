/**
 * AnimatedHexagonLayer tests.
 *
 * The RUNTIME hexbin delegates GPU/CPU binning + colour/elevation ramping to
 * the canonical `@deck.gl/aggregation-layers` HexagonLayer + DataFilterExtension
 * (a real WebGL2 context, exercised by tools/render-test). Here we verify the
 * CPU-side composite path that feeds it:
 *
 *   - it consolidates every visible tile's points into ONE binary sublayer
 *     (no per-tile sublayers, mirroring the heatmap), reusing the heatmap's
 *     buildConsolidatedChannelData;
 *   - the single consolidated weight buffer is aliased to BOTH getColorWeight
 *     and getElevationWeight;
 *   - a FRESH filterRange array is pushed each render (relativized against the
 *     layer time offset) so the aggregator re-runs as the window slides;
 *   - the HexagonLayer prop surface is forwarded, cells are pickable, and the
 *     DataFilterExtension animates the layer;
 *   - the weight column resolves through the accessor-alias convention.
 *
 * These exercise renderLayers() directly (via Object.create, which bypasses
 * CompositeLayer's lifecycle) with deck.gl mocks that capture constructor args.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';

// ---------------------------------------------------------------------------
// deck.gl mocks
// ---------------------------------------------------------------------------
//
// Capture the sublayer's constructor props. The @stt layer imports
// buildConsolidatedChannelData from heatmap-layer.ts, which itself imports the
// canonical HeatmapLayer — so the aggregation-layers mock exports both fakes.

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/aggregation-layers', () => {
  class FakeHexagonLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeHeatmapLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { HexagonLayer: FakeHexagonLayer, HeatmapLayer: FakeHeatmapLayer };
});

vi.mock('@deck.gl/extensions', () => {
  class FakeDataFilterExtension {
    opts: any;
    constructor(opts: any) {
      this.opts = opts;
    }
  }
  return { DataFilterExtension: FakeDataFilterExtension };
});

// Shared `@deck.gl/core` mock reproduces the real
// getSubLayerProps/getSubLayerClass contract without a deck.gl runtime / GPU.
vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake point tile of `n` features, timestamped sequentially. */
function bigPointTile(n: number, timeOffset = 0, tileId?: any) {
  const positions: number[][] = new Array(n);
  const startTimes: number[] = new Array(n);
  const endTimes: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    positions[i] = [(i % 360) - 180, (i % 180) - 90];
    startTimes[i] = i;
    endTimes[i] = i + 1;
  }
  return makePointTile({
    positions,
    startTimes,
    endTimes,
    timeOffset,
    tileId: tileId ?? { z: 12, x: 1, y: 1, t: 0 },
  });
}

describe('AnimatedHexagonLayer composite', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/summary/animated-hexagon-layer');
    LayerCtor = mod.AnimatedHexagonLayer as any;

    makeLayer = (opts = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — we exercise the
      // consolidated renderLayers() path directly.
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        radius: 1000,
        coverage: 1,
        extruded: true,
        elevationScale: 1,
        elevationRange: [0, 1000],
        colorRange: [
          [255, 255, 178],
          [189, 0, 38],
        ],
        colorDomain: null,
        elevationDomain: null,
        colorScaleType: 'quantize',
        elevationScaleType: 'linear',
        upperPercentile: 100,
        lowerPercentile: 0,
        elevationUpperPercentile: 100,
        elevationLowerPercentile: 0,
        material: true,
        hexagonAggregation: 'SUM',
        colorAggregation: null,
        elevationAggregation: null,
        gpuAggregation: true,
        getColorWeight: null,
        getElevationWeight: null,
        weightProperty: null,
        timeWindow: 1000,
        updateTriggers: {},
        extensions: [],
        ...opts,
      };
      layer._currentTime = 0;
      layer._cache = null;
      layer._dataFilter = {};
      layer._lastFilterUpdateWall = 0;
      return layer;
    };
  });

  it('consolidates all visible tiles into ONE binary sublayer (no per-tile fan-out)', () => {
    const layer = makeLayer();
    const a = bigPointTile(20, 0, { z: 12, x: 1, y: 2, t: 0 });
    const b = bigPointTile(15, 0, { z: 12, x: 1, y: 3, t: 0 });
    layer.state = { tiles: [a, b] };
    const sublayers = layer.renderLayers();
    expect(sublayers.length).toBe(1);
    const data = sublayers[0].props.data;
    // Binary {length, attributes} — not a real Array (which would mean wrapper
    // objects). All 35 points from both tiles land in one buffer.
    expect(Array.isArray(data)).toBe(false);
    expect(data.length).toBe(35);
    expect(data.attributes).toBeDefined();
  });

  it('returns [] when there are no visible tiles', () => {
    const layer = makeLayer();
    layer.state = { tiles: [] };
    expect(layer.renderLayers()).toEqual([]);
  });

  it('aliases the single consolidated weight buffer to BOTH getColorWeight and getElevationWeight', () => {
    const layer = makeLayer();
    layer.state = { tiles: [bigPointTile(6)] };
    const attrs = layer.renderLayers()[0].props.data.attributes;

    expect(attrs.getPosition.value).toBeInstanceOf(Float64Array);
    expect(attrs.getPosition.size).toBe(3);
    expect(attrs.getColorWeight.value).toBeInstanceOf(Float32Array);
    expect(attrs.getElevationWeight.value).toBeInstanceOf(Float32Array);
    // Same buffer reference — one weight column drives colour + elevation.
    expect(attrs.getColorWeight.value).toBe(attrs.getElevationWeight.value);
    expect(attrs.getFilterValue.value).toBeInstanceOf(Float32Array);
    // Default (no weight column) → every point weighs 1.
    expect(Array.from(attrs.getColorWeight.value)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('sources the weight from getColorWeight (accessor-alias → column name)', () => {
    const layer = makeLayer({ getColorWeight: 'mag' });
    const tile = bigPointTile(3);
    tile.layers[0].features.numericProps['mag'] = new Float32Array([10, 20, 30]);
    layer.state = { tiles: [tile] };
    const attrs = layer.renderLayers()[0].props.data.attributes;
    expect(Array.from(attrs.getColorWeight.value)).toEqual([10, 20, 30]);
    expect(attrs.getColorWeight.value).toBe(attrs.getElevationWeight.value);
  });

  it('falls back to getElevationWeight when getColorWeight is unset', () => {
    const layer = makeLayer({ getElevationWeight: 'mag' });
    const tile = bigPointTile(3);
    tile.layers[0].features.numericProps['mag'] = new Float32Array([4, 5, 6]);
    layer.state = { tiles: [tile] };
    const attrs = layer.renderLayers()[0].props.data.attributes;
    expect(Array.from(attrs.getColorWeight.value)).toEqual([4, 5, 6]);
  });

  it('pushes a relativized filterRange centered on the play head', () => {
    const layer = makeLayer({ timeWindow: 1000 });
    const offset = 1_700_000_000_000;
    layer._currentTime = offset + 5_000;
    layer.state = { tiles: [bigPointTile(4, offset)] };
    const range = layer.renderLayers()[0].props.filterRange;
    // center = currentTime - offset = 5000; half window = 500.
    expect(range).toEqual([4_500, 5_500]);
  });

  it('allocates a FRESH filterRange array each render (so the aggregator re-runs)', () => {
    const layer = makeLayer();
    layer.state = { tiles: [bigPointTile(4)] };
    const first = layer.renderLayers()[0].props.filterRange;
    const second = layer.renderLayers()[0].props.filterRange;
    // A reused array reference would freeze the animation (never seen as changed).
    expect(second).not.toBe(first);
    expect(layer.renderLayers()[0].props.filterEnabled).toBe(true);
  });

  it('wires the DataFilterExtension and appends user extensions', () => {
    const userExt = { name: 'user' };
    const layer = makeLayer({ extensions: [userExt] });
    layer.state = { tiles: [bigPointTile(4)] };
    const exts = layer.renderLayers()[0].props.extensions;
    expect(exts).toContain(layer._dataFilter);
    expect(exts).toContain(userExt);
  });

  it('renders pickable cells (unlike the density heatmap)', () => {
    const layer = makeLayer();
    layer.state = { tiles: [bigPointTile(4)] };
    expect(layer.renderLayers()[0].props.pickable).toBe(true);
  });

  it('forwards the HexagonLayer prop surface to the sublayer', () => {
    const layer = makeLayer({
      radius: 500,
      coverage: 0.8,
      extruded: false,
      elevationScale: 4,
      elevationRange: [10, 5000],
      colorDomain: [0, 100],
      elevationDomain: [0, 50],
      colorScaleType: 'quantile',
      elevationScaleType: 'quantile',
      upperPercentile: 95,
      lowerPercentile: 5,
      elevationUpperPercentile: 90,
      elevationLowerPercentile: 2,
    });
    layer.state = { tiles: [bigPointTile(4)] };
    const p = layer.renderLayers()[0].props;
    expect(p.radius).toBe(500);
    expect(p.coverage).toBe(0.8);
    expect(p.extruded).toBe(false);
    expect(p.elevationScale).toBe(4);
    expect(p.elevationRange).toEqual([10, 5000]);
    expect(p.colorDomain).toEqual([0, 100]);
    expect(p.elevationDomain).toEqual([0, 50]);
    expect(p.colorScaleType).toBe('quantile');
    expect(p.elevationScaleType).toBe('quantile');
    expect(p.upperPercentile).toBe(95);
    expect(p.lowerPercentile).toBe(5);
    expect(p.elevationUpperPercentile).toBe(90);
    expect(p.elevationLowerPercentile).toBe(2);
  });

  it('forwards gpuAggregation:true unchanged (the default GPU animation path)', () => {
    const layer = makeLayer({ gpuAggregation: true });
    layer.state = { tiles: [bigPointTile(4)] };
    expect(layer.renderLayers()[0].props.gpuAggregation).toBe(true);
  });

  it('FORCES gpuAggregation:true (and warns) when a caller disables it — the CPU aggregator ignores the time window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = makeLayer({ gpuAggregation: false });
    layer.state = { tiles: [bigPointTile(4)] };
    const p = layer.renderLayers()[0].props;
    // DataFilterExtension is GPU-only → the window would silently do nothing on
    // the CPU path, so the layer overrides gpuAggregation to true and warns once.
    expect(p.gpuAggregation).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/GPU aggregation/i);
    warn.mockRestore();
  });

  it('re-binds the weight buffers each time the window slides so the GPU aggregator re-runs', () => {
    const layer = makeLayer({ timeWindow: 1000 });
    layer.state = { tiles: [bigPointTile(6)] };
    layer._currentTime = 0;
    const d0 = layer.renderLayers()[0].props.data;
    // Same play head → same window → data + weight wrapper REUSED (no needless
    // re-aggregation on a pure camera render).
    expect(layer.renderLayers()[0].props.data).toBe(d0);

    // Advance the play head → the window slides → a FRESH `data` object + FRESH
    // weight wrapper reach the sublayer. deck's Attribute.setBinaryValue
    // short-circuits a re-bind of the SAME wrapper, so a stable wrapper would
    // freeze the aggregation (preDraw bails); a fresh wrapper re-binds
    // colorWeights/elevationWeights → onAttributeChange → setNeedsUpdate → the
    // bin sorter re-runs with the new filterRange.
    layer._currentTime = 5000;
    const d1 = layer.renderLayers()[0].props.data;
    expect(d1).not.toBe(d0);
    expect(d1.attributes.getColorWeight).not.toBe(d0.attributes.getColorWeight);
    // Both weight channels still share ONE fresh wrapper (one column drives both).
    expect(d1.attributes.getColorWeight).toBe(d1.attributes.getElevationWeight);
    // The heavy consolidated buffers are REUSED verbatim — only wrapper identity
    // changes (position + filter-value buffers stay put; bins don't move).
    expect(d1.attributes.getColorWeight.value).toBe(d0.attributes.getColorWeight.value);
    expect(d1.attributes.getPosition.value).toBe(d0.attributes.getPosition.value);
    expect(d1.attributes.getFilterValue.value).toBe(d0.attributes.getFilterValue.value);
    // filterRange follows the window.
    expect(layer.renderLayers()[0].props.filterRange).toEqual([4500, 5500]);
  });

  it('maps hexagonAggregation onto both color and elevation aggregation by default', () => {
    const layer = makeLayer({ hexagonAggregation: 'MAX' });
    layer.state = { tiles: [bigPointTile(4)] };
    const p = layer.renderLayers()[0].props;
    expect(p.colorAggregation).toBe('MAX');
    expect(p.elevationAggregation).toBe('MAX');
  });

  it('lets a specific colorAggregation/elevationAggregation override hexagonAggregation', () => {
    const layer = makeLayer({
      hexagonAggregation: 'SUM',
      colorAggregation: 'MEAN',
      elevationAggregation: 'MAX',
    });
    layer.state = { tiles: [bigPointTile(4)] };
    const p = layer.renderLayers()[0].props;
    expect(p.colorAggregation).toBe('MEAN');
    expect(p.elevationAggregation).toBe('MAX');
  });

  it('caches the consolidated data object across renders when nothing changed', () => {
    const layer = makeLayer();
    layer.state = { tiles: [bigPointTile(5)] };
    const first = layer.renderLayers()[0].props.data;
    const second = layer.renderLayers()[0].props.data;
    // Consolidated buffers are cached by visible-tile-set key — same reference.
    expect(second).toBe(first);
  });

  it('relativizes per-point filter values against the layer time offset across tiles', () => {
    const layerOffset = 1_700_000_000_000;
    const layer = makeLayer();
    const a = bigPointTile(3, layerOffset, { z: 12, x: 1, y: 2, t: 0 });
    const b = bigPointTile(3, layerOffset + 3_600_000, { z: 12, x: 1, y: 3, t: 1 });
    layer.state = { tiles: [a, b] };
    const fv = layer.renderLayers()[0].props.data.attributes.getFilterValue.value;
    expect(fv.length).toBe(6);
    // tile b feature 0 start=0 shifted by +3_600_000 ms delta.
    expect(fv[3]).toBe(3_600_000);
  });
});
