/**
 * SplatLayer data-shape + temporal-wiring regression guard.
 *
 * SplatLayer renders an STT point cloud as oriented anisotropic Gaussian
 * surfels: per (tile, layer) it builds a reference-stable binary `data` object
 * for one {@link SplatPrimitiveLayer} sublayer, reading the surfel columns baked
 * by `waymo_extract.py --surfel` (quaternion + in-plane extents + confidence)
 * plus camera RGB and the per-feature sample time.
 *
 * The custom-`Model` primitive needs a real GPU, so we mock it to a prop-stashing
 * stand-in (the same shape the other layer tests mock ScatterplotLayer to) and
 * assert on the binary `data.attributes` the composite hands it.
 */

import { describe, it, expect, vi } from 'vitest';
import { makePointTile } from './fake-tile';

// The primitive imports luma's Model/Geometry + deck's project/picking modules
// (no GPU here), so swap it for a constructor that just stashes its props.
vi.mock('../src/layers/internal/splat-primitive-layer', () => {
  class FakeSplatPrimitiveLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { SplatPrimitiveLayer: FakeSplatPrimitiveLayer };
});

// Shared composite-base mock (getSubLayerProps/getSubLayerClass contract).
vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

/** A point tile of `n` surfels with all the `--surfel` columns populated. */
function surfelTile(n: number, opts: { withRgb?: boolean; withSurfel?: boolean } = {}) {
  const { withRgb = true, withSurfel = true } = opts;
  const positions: number[][] = [];
  const startTimes: number[] = [];
  const endTimes: number[] = [];
  for (let i = 0; i < n; i++) {
    positions.push([(i % 10) * 0.001 - 122.4, (i % 7) * 0.001 + 37.77]);
    startTimes.push(i * 100); // relative ms (μ_t)
    endTimes.push(i * 100);
  }
  const tile = makePointTile({ positions, startTimes, endTimes, timeOffset: 1_000_000 });
  const np = tile.layers[0].features.numericProps;
  np['z'] = new Float32Array(Array.from({ length: n }, (_, i) => (i % 5) - 2));
  if (withSurfel) {
    // Identity-ish quaternions (normal = up) — unit length.
    np['qx'] = new Float32Array(n).fill(0);
    np['qy'] = new Float32Array(n).fill(0);
    np['qz'] = new Float32Array(n).fill(0);
    np['qw'] = new Float32Array(n).fill(1);
    np['s_major'] = new Float32Array(n).fill(0.3);
    np['s_minor'] = new Float32Array(n).fill(0.15);
    np['surfel_opacity'] = new Float32Array(n).fill(0.8);
  }
  if (withRgb) {
    np['r'] = new Float32Array(Array.from({ length: n }, (_, i) => i % 256));
    np['g'] = new Float32Array(n).fill(128);
    np['b'] = new Float32Array(n).fill(64);
  }
  return tile;
}

/** Minimal SplatLayer instance (Object.create + hand-rolled props/state). */
function makeSplatLayer(LayerCtor: any, tiles: any[], overrides: Record<string, any> = {}) {
  const layer = Object.create(LayerCtor.prototype);
  Object.assign(layer, {
    props: {
      id: 'surfel',
      quaternionColumns: ['qx', 'qy', 'qz', 'qw'],
      scaleColumns: ['s_major', 's_minor'],
      rgbColumns: ['r', 'g', 'b'],
      opacityColumn: 'surfel_opacity',
      elevationProperty: 'z',
      elevationScale: 1,
      fallbackColor: [200, 205, 215, 255],
      temporalSigma: 180,
      sizeScale: 1,
      gaussianFalloff: 3,
      alphaCutoff: 0.04,
      timeWindow: 2000,
      opacity: 1,
      visible: true,
      ...overrides,
    },
    state: { tiles },
    _currentTime: 0,
    boundGetTime: () => 0,
    preparedTileCache: new Map(),
    sublayerCache: new Map(),
    lastLayerPropsKey: '',
    lastTilesRef: null,
  });
  return layer;
}

describe('SplatLayer surfel sublayer architecture', () => {
  it('builds one oriented-surfel sublayer with the right binary attributes', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(4);
    const layer = makeSplatLayer(SplatLayer, [tile]);

    const sublayers = layer.renderLayers();
    expect(sublayers).toHaveLength(1);
    const attrs = sublayers[0].props.data.attributes;

    // Positions: size-3, z sourced from the `z` column (feature 2 → z = 0).
    expect(attrs.instancePositions.size).toBe(3);
    expect(attrs.instancePositions.value).toBeInstanceOf(Float64Array);
    expect(attrs.instancePositions.value[2 * 3 + 2]).toBe(0); // (2 % 5) - 2 = 0

    // Orientation + extents.
    expect(attrs.instanceQuaternions.size).toBe(4);
    expect([...attrs.instanceQuaternions.value.slice(0, 4)]).toEqual([0, 0, 0, 1]);
    expect(attrs.instanceScales.size).toBe(2);
    expect(attrs.instanceScales.value).toBeInstanceOf(Float32Array);
    expect(attrs.instanceScales.value[0]).toBeCloseTo(0.3, 5);
    expect(attrs.instanceScales.value[1]).toBeCloseTo(0.15, 5);

    // Color: rgb columns into RGB, baked confidence (0.8) → alpha 204.
    expect(attrs.instanceColors.size).toBe(4);
    expect(attrs.instanceColors.normalized).toBe(true);
    expect(attrs.instanceColors.value).toBeInstanceOf(Uint8Array);
    expect([...attrs.instanceColors.value.slice(0, 4)]).toEqual([0, 128, 64, 204]);

    // Sample times ride zero-copy as the temporal-Gaussian centres μ_t.
    expect(attrs.instanceStartTimes.value).toBe(tile.layers[0].features.startTimes);

    // Temporal wiring forwarded to the primitive.
    expect(sublayers[0].props.timeOffset).toBe(1_000_000);
    expect(sublayers[0].props.temporalSigma).toBe(180);
    expect(sublayers[0].props.sizeScale).toBe(1);
    expect(sublayers[0].props.falloff).toBe(3);
    expect(sublayers[0].props.data.length).toBe(4);
  });

  it('caches prepared data + sublayer instances across renders (stable refs)', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(3);
    const layer = makeSplatLayer(SplatLayer, [tile]);

    const first = layer.renderLayers();
    const second = layer.renderLayers();
    expect(second[0]).toBe(first[0]); // same sublayer reference → no GPU re-upload
    expect(second[0].props.data).toBe(first[0].props.data); // identity dataComparator
  });

  it('skips a tile missing the surfel columns (warns, renders nothing)', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(3, { withSurfel: false });
    const layer = makeSplatLayer(SplatLayer, [tile]);
    expect(layer.renderLayers()).toHaveLength(0);
  });

  it('falls back to fallbackColor when the rgb columns are absent', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(2, { withRgb: false });
    const layer = makeSplatLayer(SplatLayer, [tile]);

    const [sub] = layer.renderLayers();
    const c = sub.props.data.attributes.instanceColors.value;
    // RGB = fallback; alpha = baked confidence (0.8 → 204).
    expect([...c.slice(0, 4)]).toEqual([200, 205, 215, 204]);
  });
});
