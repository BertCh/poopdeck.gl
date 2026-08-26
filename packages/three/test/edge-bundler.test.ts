import { describe, it, expect, vi, afterEach } from 'vitest';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  BUNDLING_WORK_SIZE,
  bundleEdges,
  resampleInto,
} from '@poopdeck.gl/core/edge-bundling';
import {
  BUNDLE_WORK_BUDGET,
  DEFAULT_BUNDLE_OPTIONS,
  bundleFlowEdges,
  bundleWorkUnits,
  collectFlowEndpoints,
  fromWorkBox,
  isBundlingSupported,
  resolveBundleOptions,
  toWorkBox,
} from '../src/lib/edge-bundler';
import { createBundledFlowMaterial } from '../src/tsl/bundle-material';
import { FlowArrowUniforms } from '../src/tsl/flow-arrow-material';
import { STTFlowmapLayer } from '../src/layers/flowmap-layer';
import { buildFlowmapBuffers } from '../src/lib/flowmap-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile } from './_support/features';
import type { InstancedBufferAttribute } from 'three';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);

/**
 * `n` parallel west→east OD flows stacked in latitude, each carrying a 2-bucket
 * per-vertex value matrix whose SOURCE vertex holds `flow` in bucket 0. Parallel
 * neighbours are the canonical bundling fixture: KDEEB must pull their interiors
 * together while leaving both endpoints exactly where the data put them.
 */
function parallelFlowTile(n: number, flow = 16, dLat = 0.002): Tile {
  const nb = 2;
  const positions = new Float64Array(n * 4);
  const startIndices = new Uint32Array(n + 1);
  const matrix = new Float32Array(n * 2 * nb);
  for (let i = 0; i < n; i++) {
    const lat = anchor.latitude + i * dLat;
    positions[i * 4] = anchor.longitude;
    positions[i * 4 + 1] = lat;
    positions[i * 4 + 2] = anchor.longitude + 0.02;
    positions[i * 4 + 3] = lat;
    startIndices[i] = i * 2;
    matrix[i * 2 * nb] = flow; // source vertex, bucket 0
  }
  startIndices[n] = n * 2;
  const partial: Partial<BinaryFeatures> = {
    featureCount: n,
    positions,
    startIndices,
    startTimes: new Float32Array(n),
    endTimes: new Float32Array(n).fill(nb * 1000),
    vertexValueMatrix: matrix,
    vertexValueBuckets: nb,
  };
  return makeLineTile(partial, { layerName: 'flows', z: 11 });
}

/** Fast knobs: the assertions are about the WIRING, not about tuning. */
const fast = { pointsPerEdge: 8, iterations: 4, densityResolution: 64 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectFlowEndpoints', () => {
  it('emits endpoints in buildFlowmapBuffers merged instance order', () => {
    // Two tiles, so the ORDER across tiles is exercised, not just within one.
    const tiles = [parallelFlowTile(2), parallelFlowTile(3, 16, 0.005)];
    const ends = collectFlowEndpoints(tiles);
    const buf = buildFlowmapBuffers(tiles, proj, 0, { minFlow: 0 });

    expect(ends.edgeCount).toBe(buf.count);
    expect(ends.edgeCount).toBe(5);
    // Endpoint e here must project onto flowmap instance e there (RTC-relative
    // to the same origin). This correspondence is what lets the ribbon look up
    // `buf.widths[e]` by bundled-edge index.
    for (let e = 0; e < ends.edgeCount; e++) {
      const s = proj.project(
        ends.endpoints[e * 4],
        ends.endpoints[e * 4 + 1],
        0,
      );
      const t = proj.project(
        ends.endpoints[e * 4 + 2],
        ends.endpoints[e * 4 + 3],
        0,
      );
      // f32 buffers over ~1.6 km of ENU metres: 3 decimals is sub-millimetre,
      // and is the resolution a Float32Array actually carries there.
      expect(buf.posSource[e * 3]).toBeCloseTo(s[0] - buf.origin[0], 3);
      expect(buf.posSource[e * 3 + 1]).toBeCloseTo(s[1] - buf.origin[1], 3);
      expect(buf.posTarget[e * 3]).toBeCloseTo(t[0] - buf.origin[0], 3);
      expect(buf.posTarget[e * 3 + 1]).toBeCloseTo(t[1] - buf.origin[1], 3);
    }
  });

  it('skips non-LineString layers rather than erroring', () => {
    const tile = makeLineTile(
      {
        featureCount: 1,
        positions: new Float64Array([0, 0, 1, 1]),
        startIndices: new Uint32Array([0, 2]),
      },
      { geometryType: 0 /* Point */ },
    );
    expect(collectFlowEndpoints([tile]).edgeCount).toBe(0);
  });
});

describe('the work box', () => {
  it('round-trips lon/lat through the shared BUNDLING_WORK_SIZE box', () => {
    const lonLat = new Float64Array([
      -71.05, 42.35, -71.03, 42.37, -71.04, 42.3,
    ]);
    const cosLat0 = Math.cos((42.34 * Math.PI) / 180);
    const box = toWorkBox(lonLat, 3, cosLat0);
    const back = new Float64Array(6);
    fromWorkBox(box.work, 3, box, back);
    for (let i = 0; i < 6; i++) expect(back[i]).toBeCloseTo(lonLat[i], 10);
  });

  it('fills the box on its widest axis and preserves aspect', () => {
    // 4x wider in corrected-x than in y: x must span the full box, y a quarter.
    const cosLat0 = 1;
    const lonLat = new Float64Array([0, 0, 4, 1]);
    const box = toWorkBox(lonLat, 2, cosLat0);
    expect(box.work[0]).toBeCloseTo(0, 9);
    expect(box.work[2]).toBeCloseTo(BUNDLING_WORK_SIZE, 6);
    expect(box.work[1]).toBeCloseTo(0, 9);
    expect(box.work[3]).toBeCloseTo(BUNDLING_WORK_SIZE / 4, 6);
  });
});

describe('bundleFlowEdges', () => {
  it('is EXACTLY the shared core iteration, not a second copy of it', () => {
    // The whole point of the campaign: this backend must not reimplement KDEEB.
    // Rebuild the same seed here from core's own primitives, run core's
    // `bundleEdges` directly, and demand the layer path produce the SAME
    // control points. If `edge-bundler.ts` ever grew its own advect/smooth loop,
    // or drifted on a knob, this fails.
    const tiles = [parallelFlowTile(6)];
    const ends = collectFlowEndpoints(tiles);
    const opts = resolveBundleOptions(fast);
    const P = opts.pointsPerEdge;
    const E = ends.edgeCount;

    const seed = new Float64Array(E * P * 2);
    const segment = new Float64Array(4);
    let latSum = 0;
    for (let e = 0; e < E; e++) {
      segment.set(ends.endpoints.subarray(e * 4, e * 4 + 4));
      latSum += segment[1] + segment[3];
      resampleInto(segment, 2, 0, 2, P, seed, e * P);
    }
    const cosLat0 = Math.max(
      Math.cos(((latSum / (E * 2)) * Math.PI) / 180),
      1e-6,
    );
    const box = toWorkBox(seed, E * P, cosLat0);
    const expectedWork = bundleEdges(box.work, E, P, {
      iterations: opts.iterations,
      kernelRadius: opts.kernelRadiusFraction * BUNDLING_WORK_SIZE,
      lambda: opts.lambda,
      smoothing: opts.smoothing,
      densityResolution: opts.densityResolution,
    });
    const expected = new Float64Array(E * P * 2);
    fromWorkBox(expectedWork, E * P, box, expected);

    const result = bundleFlowEdges(ends.endpoints, E, fast);
    expect(result.bundled).toBe(true);
    if (!result.bundled) return;
    expect(result.edges.edgeCount).toBe(E);
    expect(result.edges.pointsPerEdge).toBe(P);
    for (let i = 0; i < expected.length; i++) {
      expect(result.edges.lonLat[i]).toBeCloseTo(expected[i], 9);
    }
  });

  it('pins both endpoints of every edge to the source lon/lat exactly', () => {
    const ends = collectFlowEndpoints([parallelFlowTile(6)]);
    const result = bundleFlowEdges(ends.endpoints, ends.edgeCount, fast);
    expect(result.bundled).toBe(true);
    if (!result.bundled) return;
    const { pointsPerEdge: P, lonLat } = result.edges;
    for (let e = 0; e < ends.edgeCount; e++) {
      expect(lonLat[e * P * 2]).toBe(ends.endpoints[e * 4]);
      expect(lonLat[e * P * 2 + 1]).toBe(ends.endpoints[e * 4 + 1]);
      expect(lonLat[(e * P + P - 1) * 2]).toBe(ends.endpoints[e * 4 + 2]);
      expect(lonLat[(e * P + P - 1) * 2 + 1]).toBe(ends.endpoints[e * 4 + 3]);
    }
  });

  it('actually bundles: parallel neighbours converge in latitude', () => {
    // Six parallel flows 0.0005° apart — WITHIN the kernel bandwidth once the
    // box is normalized (at this fixture's 0.02° span the default 5% bandwidth
    // is ~50 work units and the neighbour gap ~34, so each flow genuinely sees
    // the next). Bundling must shrink the latitude spread of their MIDPOINTS.
    const n = 6;
    const dLat = 0.0005;
    const ends = collectFlowEndpoints([parallelFlowTile(n, 16, dLat)]);
    const result = bundleFlowEdges(ends.endpoints, n, fast);
    expect(result.bundled).toBe(true);
    if (!result.bundled) return;
    const { pointsPerEdge: P, lonLat } = result.edges;
    const mid = Math.floor(P / 2);
    let lo = Infinity;
    let hi = -Infinity;
    for (let e = 0; e < n; e++) {
      const lat = lonLat[(e * P + mid) * 2 + 1];
      if (lat < lo) lo = lat;
      if (lat > hi) hi = lat;
    }
    const straightSpread = (n - 1) * dLat;
    expect(hi - lo).toBeLessThan(straightSpread * 0.8);
  });

  it('leaves a lone pair of far-apart flows essentially alone', () => {
    // Two flows a whole degree apart: each is outside the other's bandwidth, so
    // there is nothing to attract them and the rivers must stay straight. This
    // is the counterpart to the test above — without it, "it moved" would pass
    // for "it bundled".
    const positions = new Float64Array([
      -71.05, 42.35, -71.03, 42.35, -71.05, 43.35, -71.03, 43.35,
    ]);
    const ends = { endpoints: positions, edgeCount: 2 };
    const result = bundleFlowEdges(ends.endpoints, ends.edgeCount, fast);
    expect(result.bundled).toBe(true);
    if (!result.bundled) return;
    const { pointsPerEdge: P, lonLat } = result.edges;
    const mid = Math.floor(P / 2);
    expect(lonLat[mid * 2 + 1]).toBeCloseTo(42.35, 3);
    expect(lonLat[(P + mid) * 2 + 1]).toBeCloseTo(43.35, 3);
  });
});

describe('the fallback gates', () => {
  it('supports a runtime with no renderer in hand, and one with a backend', () => {
    expect(isBundlingSupported()).toBe(true);
    expect(isBundlingSupported(null)).toBe(true);
    expect(isBundlingSupported({ backend: {} })).toBe(true);
  });

  it('refuses a renderer that reports no backend', () => {
    expect(isBundlingSupported({ backend: null })).toBe(false);
    const ends = collectFlowEndpoints([parallelFlowTile(4)]);
    const result = bundleFlowEdges(ends.endpoints, ends.edgeCount, fast, {
      backend: null,
    });
    expect(result.bundled).toBe(false);
    if (result.bundled) return;
    expect(result.reason).toMatch(/backend/);
  });

  it('refuses fewer than two edges — nothing to bundle toward', () => {
    const ends = collectFlowEndpoints([parallelFlowTile(1)]);
    const result = bundleFlowEdges(ends.endpoints, ends.edgeCount, fast);
    expect(result.bundled).toBe(false);
    if (result.bundled) return;
    expect(result.reason).toMatch(/at least 2 edges/);
  });

  it('refuses an edge set over maxEdges, naming the knob', () => {
    const ends = collectFlowEndpoints([parallelFlowTile(4)]);
    const result = bundleFlowEdges(ends.endpoints, ends.edgeCount, {
      ...fast,
      maxEdges: 2,
    });
    expect(result.bundled).toBe(false);
    if (result.bundled) return;
    expect(result.reason).toMatch(/maxEdges/);
  });

  it('refuses an edge set over the CPU work budget, naming the knobs', () => {
    // Never actually runs the iteration — the estimate rejects it first, which
    // is the entire point (the alternative is a frozen tab).
    const opts = resolveBundleOptions({});
    const overBudget =
      Math.ceil(BUNDLE_WORK_BUDGET / bundleWorkUnits(1, opts)) + 1;
    expect(overBudget).toBeLessThanOrEqual(DEFAULT_BUNDLE_OPTIONS.maxEdges);
    const result = bundleFlowEdges(
      new Float64Array(overBudget * 4),
      overBudget,
    );
    expect(result.bundled).toBe(false);
    if (result.bundled) return;
    expect(result.reason).toMatch(/budget/);
    expect(result.reason).toMatch(/kernelRadiusFraction/);
  });

  it('estimates work as the exact annealed splat footprint', () => {
    const opts = resolveBundleOptions({
      pointsPerEdge: 8,
      iterations: 2,
      densityResolution: 100, // cell = 10 work units
      kernelRadiusFraction: 0.05, // h0 = 50 → 5 cells; h1 = 42.5 → 5 cells
      lambda: 0.85,
    });
    // Σ (2·5+1)² + (2·5+1)² = 242 cells per control point.
    expect(bundleWorkUnits(3, opts)).toBe(3 * 8 * 242);
    expect(bundleWorkUnits(0, opts)).toBe(0);
  });
});

describe('createBundledFlowMaterial', () => {
  it('builds a ribbon graph that shares the arrow material uniforms', () => {
    const bundle = createBundledFlowMaterial();
    expect(bundle.material.vertexNode).toBeTruthy();
    expect(bundle.material.colorNode).toBeTruthy();
    expect(bundle.material.opacityNode).toBeTruthy();
    // Same uniform holder as the straight path, so `updateFlowArrowUniforms`
    // drives both and the two cannot drift.
    expect(bundle.arrow).toBeInstanceOf(FlowArrowUniforms);
    expect(bundle.material.transparent).toBe(true);
    bundle.material.dispose();
  });

  it('honours the blending / depth options', () => {
    const additive = createBundledFlowMaterial({
      additive: true,
      depthWrite: true,
      alphaCutoff: 0.5,
    });
    expect(additive.material.depthWrite).toBe(true);
    expect(additive.material.alphaTest).toBe(0.5);
    additive.material.dispose();
  });
});

describe('STTFlowmapLayer bundling wiring', () => {
  const ctx = { projection: proj, timeOrigin: 0 };

  it('draws straight arrows by default (one instance per flow)', () => {
    const layer = new STTFlowmapLayer({ id: 'plain', minFlow: 0 });
    layer.setTiles([parallelFlowTile(4)], ctx);
    const arrows = layer.object.children[1] as {
      geometry: { instanceCount: number; getAttribute(n: string): unknown };
    };
    expect(arrows.geometry.instanceCount).toBe(4);
    expect(arrows.geometry.getAttribute('sttEndpointOffsets')).toBeTruthy();
    expect(arrows.geometry.getAttribute('sttBundleT')).toBeUndefined();
    layer.dispose();
  });

  it('draws E×(P-1) ribbon segments when bundling is on', () => {
    const layer = new STTFlowmapLayer({
      id: 'bundled',
      minFlow: 0,
      bundling: fast,
    });
    layer.setTiles([parallelFlowTile(4)], ctx);
    const arrows = layer.object.children[1] as {
      geometry: {
        instanceCount: number;
        getAttribute(n: string): InstancedBufferAttribute | undefined;
      };
    };
    const segs = fast.pointsPerEdge - 1;
    expect(arrows.geometry.instanceCount).toBe(4 * segs);
    const t = arrows.geometry.getAttribute('sttBundleT');
    expect(t).toBeTruthy();
    // First segment of edge 0 spans [0, 1/segs]; last spans [(segs-1)/segs, 1].
    expect(t!.array[0]).toBeCloseTo(0, 6);
    expect(t!.array[1]).toBeCloseTo(1 / segs, 6);
    expect(t!.array[(segs - 1) * 2 + 1]).toBeCloseTo(1, 6);
    layer.dispose();
  });

  it('fans one edge width across all of that edge on a playhead move', () => {
    const layer = new STTFlowmapLayer({
      id: 'bundled-time',
      minFlow: 0,
      widthScale: 1,
      bundling: fast,
    });
    layer.setTiles([parallelFlowTile(3, 16)], ctx);
    // Bucket 0 holds 16 for every flow → width = √16 = 4 on every segment.
    layer.setTime(0);
    const arrows = layer.object.children[1] as {
      geometry: {
        getAttribute(n: string): InstancedBufferAttribute | undefined;
      };
    };
    const widths = arrows.geometry.getAttribute('sttWidth')!;
    const segs = fast.pointsPerEdge - 1;
    expect(widths.array.length).toBe(3 * segs);
    for (let i = 0; i < widths.array.length; i++) {
      expect(widths.array[i]).toBeCloseTo(4, 5);
    }
    layer.dispose();
  });

  it('falls back to straight arrows and says so ONCE when over budget', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const layer = new STTFlowmapLayer({
      id: 'over-budget',
      minFlow: 0,
      // 3 control points is legal; maxEdges 1 is what rejects a 4-flow set.
      bundling: { ...fast, maxEdges: 1 },
    });
    layer.setTiles([parallelFlowTile(4)], ctx);
    const arrows = layer.object.children[1] as {
      geometry: {
        instanceCount: number;
        getAttribute(n: string): InstancedBufferAttribute | undefined;
      };
    };
    expect(arrows.geometry.instanceCount).toBe(4); // straight arrows
    expect(arrows.geometry.getAttribute('sttBundleT')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/maxEdges/);
    // A second tile load must NOT warn again.
    layer.setTiles([parallelFlowTile(4)], ctx);
    expect(warn).toHaveBeenCalledTimes(1);
    layer.dispose();
  });

  it('keeps the RTC origin identical whichever path draws', () => {
    const tiles = [parallelFlowTile(4)];
    const plain = new STTFlowmapLayer({ id: 'origin-plain', minFlow: 0 });
    const bundled = new STTFlowmapLayer({
      id: 'origin-bundled',
      minFlow: 0,
      bundling: fast,
    });
    plain.setTiles(tiles, ctx);
    bundled.setTiles(tiles, ctx);
    expect(bundled.object.position.x).toBeCloseTo(plain.object.position.x, 9);
    expect(bundled.object.position.y).toBeCloseTo(plain.object.position.y, 9);
    expect(bundled.object.position.z).toBeCloseTo(plain.object.position.z, 9);
    plain.dispose();
    bundled.dispose();
  });
});
