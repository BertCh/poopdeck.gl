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
function surfelTile(
  n: number,
  opts: { withRgb?: boolean; withSurfel?: boolean; dynamic?: number[] } = {},
) {
  const { withRgb = true, withSurfel = true, dynamic } = opts;
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
  // Worldbuild per-point static/dynamic column (0/1). Absent unless supplied —
  // existing surfel tiles have no such column.
  if (dynamic) np['is_dynamic'] = new Float32Array(dynamic);
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

  it('forwards the Worldbuild props (cumulative/revealFade/temporalSigmaDynamic) to the primitive', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(3);
    const layer = makeSplatLayer(SplatLayer, [tile], {
      cumulative: true,
      revealFade: 1500,
      temporalSigmaDynamic: 400,
    });
    const [sub] = layer.renderLayers();
    expect(sub.props.cumulative).toBe(true);
    expect(sub.props.revealFade).toBe(1500);
    expect(sub.props.temporalSigmaDynamic).toBe(400);
    // The static-world width still rides through unchanged.
    expect(sub.props.temporalSigma).toBe(180);
  });

  it('defaults the Worldbuild props to the non-cumulative (legacy) behaviour', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    const tile = surfelTile(2);
    const layer = makeSplatLayer(SplatLayer, [tile]);
    const [sub] = layer.renderLayers();
    // makeSplatLayer doesn't set them → they pass through as the test props
    // (undefined). The point is the sublayer is built and renders fine.
    expect(sub.props.cumulative).toBeUndefined();
    expect(sub.props.revealFade).toBeUndefined();
    expect(sub.props.temporalSigmaDynamic).toBeUndefined();
  });

  it('builds instanceIsDynamic from the is_dynamic column (0/1, one per feature)', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    // Mixed scene: features 1 and 3 are moving actors.
    const tile = surfelTile(4, { dynamic: [0, 1, 0, 1] });
    const layer = makeSplatLayer(SplatLayer, [tile], { cumulative: true });
    const [sub] = layer.renderLayers();

    const dyn = sub.props.data.attributes.instanceIsDynamic;
    expect(dyn).toBeDefined();
    expect(dyn.size).toBe(1);
    expect(dyn.value).toBeInstanceOf(Float32Array);
    expect(dyn.value.length).toBe(4);
    expect([...dyn.value]).toEqual([0, 1, 0, 1]);
  });

  it('thresholds non-0/1 is_dynamic values at 0.5', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    // Defensive: any ≥0.5 → dynamic, anything below → static.
    const tile = surfelTile(4, { dynamic: [0.2, 0.5, 0.99, 0] });
    const [sub] = makeSplatLayer(SplatLayer, [tile], { cumulative: true }).renderLayers();
    expect([...sub.props.data.attributes.instanceIsDynamic.value]).toEqual([0, 1, 1, 0]);
  });

  it('degrades gracefully to all-static when the is_dynamic column is absent', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    // Existing surfel tiles have no is_dynamic column — even under cumulative the
    // attribute is OMITTED (primitive's getIsDynamic default 0 ⇒ all static), and
    // nothing crashes.
    const tile = surfelTile(3);
    const layer = makeSplatLayer(SplatLayer, [tile], { cumulative: true });
    const sublayers = layer.renderLayers();
    expect(sublayers).toHaveLength(1);
    expect(sublayers[0].props.data.attributes.instanceIsDynamic).toBeUndefined();
    // Still a valid, length-correct splat sublayer.
    expect(sublayers[0].props.data.length).toBe(3);
    expect(sublayers[0].props.data.attributes.instancePositions.size).toBe(3);
  });

  it('auto-detects smallest-three packed quats (q_imax) and flags the sublayer', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    // Identity quaternion packed: largest = w (index 3), other three = 0.
    const tile = surfelTile(3);
    const np = tile.layers[0].features.numericProps;
    for (const c of ['qx', 'qy', 'qz', 'qw']) delete np[c];
    np['q_a'] = new Float32Array(3).fill(0);
    np['q_b'] = new Float32Array(3).fill(0);
    np['q_c'] = new Float32Array(3).fill(0);
    np['q_imax'] = new Float32Array(3).fill(3);
    const [sub] = makeSplatLayer(SplatLayer, [tile]).renderLayers();

    // Shader is told to unpack; the size-4 attribute carries [a,b,c,imax].
    expect(sub.props.packedQuaternion).toBe(true);
    expect([...sub.props.data.attributes.instanceQuaternions.value.slice(0, 4)]).toEqual([0, 0, 0, 3]);
  });

  it('legacy (qx,qy,qz,qw) bundles stay unpacked', async () => {
    vi.resetModules();
    const { SplatLayer } = (await import('../src/layers/core/splat-layer')) as any;
    const [sub] = makeSplatLayer(SplatLayer, [surfelTile(2)]).renderLayers();
    expect(sub.props.packedQuaternion).toBe(false);
  });
});

/**
 * Contract guard: the Python encoder (av_common.pack_surfel_quaternions) and the
 * GLSL unpack (splat-primitive-layer.ts unpackQuat) must agree exactly, else
 * surfel orientations silently corrupt. We mirror both in JS and assert the
 * round-trip reconstructs the rotation for arbitrary unit quaternions.
 */
describe('smallest-three quaternion pack/unpack contract', () => {
  // mirror of av_common.pack_surfel_quaternions
  function pack(q: number[]): [number, number, number, number] {
    const n = Math.hypot(q[0], q[1], q[2], q[3]);
    const c = q.map((v) => v / n);
    let m = 0;
    for (let i = 1; i < 4; i++) if (Math.abs(c[i]) > Math.abs(c[m])) m = i;
    const s = Math.sign(c[m]) || 1;
    const cc = c.map((v) => v * s);
    const abc = cc.filter((_, i) => i !== m);
    return [abc[0], abc[1], abc[2], m];
  }
  // mirror of the GLSL unpackQuat
  function unpack(p: number[]): number[] {
    const d = Math.sqrt(Math.max(0, 1 - p[0] * p[0] - p[1] * p[1] - p[2] * p[2]));
    const m = Math.round(p[3]);
    if (m === 0) return [d, p[0], p[1], p[2]];
    if (m === 1) return [p[0], d, p[1], p[2]];
    if (m === 2) return [p[0], p[1], d, p[2]];
    return [p[0], p[1], p[2], d];
  }

  it('reconstructs the rotation for arbitrary unit quaternions', () => {
    // deterministic LCG → reproducible quats (no Math.random)
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    let maxErr = 0;
    for (let i = 0; i < 1000; i++) {
      const raw = [rnd(), rnd(), rnd(), rnd()];
      const n = Math.hypot(raw[0], raw[1], raw[2], raw[3]);
      if (n < 1e-6) continue;
      const q0 = raw.map((v) => v / n);
      const q1 = unpack(pack(q0));
      // q and −q are the same rotation, so compare |dot| → 1.
      const dot = Math.abs(q0[0] * q1[0] + q0[1] * q1[1] + q0[2] * q1[2] + q0[3] * q1[3]);
      maxErr = Math.max(maxErr, 1 - dot);
    }
    // Exact (pre-quantization) round-trip — the only error is float epsilon.
    expect(maxErr).toBeLessThan(1e-9);
  });
});
