/**
 * The maplibre-backend CORRECTNESS CONTRACT (campaign Wave M5, testing item 4).
 *
 * This is the single place that states, as executable assertions, the numeric
 * invariants a MapLibre/Mapbox STT renderer MUST satisfy — the properties with
 * EXACT answers, checked against golden values that do not come from the code
 * under test (`test/golden/fixtures.ts`). The per-feature suites
 * (`time-window`, `data-filter`, `projection`, `cell-geometry`, `flow-kernel`,
 * `time-modes`, …) prove parity against deck/core across wide sweeps; this file
 * CONSOLIDATES their load-bearing guarantees into one contract, imports the
 * same JS reference impls the GLSL mirrors, and fills the gaps those suites
 * leave (filter×time composition, the ground-metre size of the quantization
 * error, one seam-containment check).
 *
 * ── Why no pixel goldens ─────────────────────────────────────────────────────
 * The repo ships no headless GL context (searched every package test dir — only
 * the `mock-gl` recorder exists) and adding a native `gl`/`headless-gl` dep
 * is out of scope, so there is no GPU to rasterise against. Per the project
 * rule, AESTHETICS stay human-verified in the browser. What is testable without
 * a GPU is the MATH the shaders run — every kernel ships a JS reference the
 * GLSL is written to mirror line-for-line — plus the CPU-side geometry and the
 * mount/teardown lifecycle. That is exactly the invariant surface below. This
 * is the acceptable "invariant-contract instead of pixel-golden" outcome the
 * task allows.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Tile } from '@poopdeck.gl/core';

// ── kernels under contract (the same JS refs the GLSL mirrors) ──────────────
import {
  timeWindowAlphaJS,
  trailAlphaJS,
  wakeAlphaJS,
  wakeSizeScaleJS,
  cumulativeAlphaJS,
} from '../src/shaders/time-window.glsl';
import { dataFilterAlphaJS } from '../src/shaders/data-filter.glsl';
import {
  projectPositions,
  quantizePositionsToUint16,
} from '../src/lib/projection';
import {
  h3CellToMercatorRing,
  quadbinCellToMercatorRing,
  quadbinToTile,
  quadbinTileToMercatorBounds,
  ringSignedArea2,
  orientRingPositive,
  cellRingToTriangles,
  type H3CellToBoundary,
} from '../src/lib/cell-geometry';
import {
  packValueMatrix,
  sampleFlowMatrixJS,
  deriveFlowAxis,
  bucketPositionAt,
} from '../src/lib/flow-kernel';

// ── golden fixtures + harness ───────────────────────────────────────────────
import {
  TIME_WINDOW_GOLDENS,
  TRAIL_GOLDENS,
  WAKE_GOLDENS,
  CUMULATIVE_GOLDENS,
  QUANTIZATION_CLUSTER,
  QUANTIZATION_GROUND_EPSILON_M,
  QUANTIZATION_EXTREMES,
  DATA_FILTER_GOLDENS,
  H3_SF,
  H3_ANTIMERIDIAN,
  QUADBIN_ROOT,
  QUADBIN_ROOT_TILE,
  QUADBIN_ROOT_BOUNDS,
  QUADBIN_CHILD_TILE,
  QUADBIN_CHILD_BOUNDS,
  POSITIVE_SQUARE,
  POSITIVE_SQUARE_AREA2,
  FLOW_MATRIX_ROWS,
  FLOW_MATRIX_COLS,
  FLOW_MATRIX_VALUES,
  FLOW_SAMPLE_GOLDENS,
  FLOW_AXIS,
  FLOW_AXIS_GOLDENS,
} from './golden/fixtures';
import {
  windowEdges,
  inspectRing,
  quantizationRoundTrip,
} from './golden/runner';

// ── real layer kinds + mocks for the lifecycle integration test ─────────────
import { STTPointLayer } from '../src/layers/point-layer';
import { STTLineLayer } from '../src/layers/line-layer';
import { STTPolygonLayer } from '../src/layers/polygon-layer';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { tileKey } from '../src/lib/streaming-source';
import { makeMockGl } from './mock-gl';
import { MockMap } from './mock-map';
import {
  makePointTile,
  makeLineTile,
  makePolygonTile,
  makeTripsTile,
} from './fixtures';

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 1 — time-window discard + fade
// ════════════════════════════════════════════════════════════════════════════

describe('INVARIANT: a feature outside [t − w/2, t + w/2] contributes zero alpha', () => {
  it.each(TIME_WINDOW_GOLDENS)('$name', (g) => {
    const [start, end] = windowEdges(g.currentTime, g.timeWindow);
    const alpha = timeWindowAlphaJS(
      g.startTime,
      g.endTime,
      start,
      end,
      g.fadeIn,
      g.fadeOut,
    );
    expect(alpha).toBeCloseTo(g.expected, 12);
  });

  it('the discard is symmetric: sweeping the playhead past a feature lights then extinguishes it', () => {
    // A feature at [1000, 1000] (an instant) with a 200 ms window: lit only
    // while the playhead is within 100 ms of it, dark on both sides.
    const feature = { start: 1000, end: 1000 };
    const w = 200;
    const lit: boolean[] = [];
    for (let t = 800; t <= 1200; t += 50) {
      const [s, e] = windowEdges(t, w);
      lit.push(timeWindowAlphaJS(feature.start, feature.end, s, e, 0, 0) > 0);
    }
    // t = 800(no) 850(no) 900(edge:yes) 950 1000 1050 1100(edge:yes) 1150(no) 1200(no)
    expect(lit).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 2 — all four time modes honour their discard boundaries
// ════════════════════════════════════════════════════════════════════════════

describe('INVARIANT: trail / wake / cumulative modes discard exactly at their edges', () => {
  it.each(TRAIL_GOLDENS)('trail — $name', (g) => {
    expect(
      trailAlphaJS(g.vertexTime, g.currentTime, g.trailLength, g.fadeTrail),
    ).toBeCloseTo(g.expected, 12);
  });
  it.each(WAKE_GOLDENS)('wake — $name', (g) => {
    expect(wakeAlphaJS(g.startTime, g.currentTime, g.wakeLength)).toBeCloseTo(
      g.expected,
      12,
    );
  });
  it.each(CUMULATIVE_GOLDENS)('cumulative — $name', (g) => {
    expect(cumulativeAlphaJS(g.startTime, g.currentTime, g.fadeIn)).toBeCloseTo(
      g.expected,
      12,
    );
  });

  it('wake size scale shrinks the tail toward wakeTailScale and keeps the head full', () => {
    // alpha 1 (head) ⇒ full size; alpha 0 (tail) ⇒ wakeTailScale.
    expect(wakeSizeScaleJS(1, 0.15)).toBeCloseTo(1, 12);
    expect(wakeSizeScaleJS(0, 0.15)).toBeCloseTo(0.15, 12);
    expect(wakeSizeScaleJS(0.5, 0.15)).toBeCloseTo(0.575, 12);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 3 — quantized position decode round-trips within epsilon
// ════════════════════════════════════════════════════════════════════════════

describe('INVARIANT: uint16-quantized positions decode back within one quantization step', () => {
  it('a dense city-block tile reconstructs sub-millimetre on the ground', () => {
    const rt = quantizationRoundTrip(QUANTIZATION_CLUSTER);
    // Per axis: never worse than one quantization step (scale / 65535).
    for (let a = 0; a < 3; a++) {
      expect(rt.maxAxisMercator[a]).toBeLessThanOrEqual(
        rt.stepMercator[a] + 1e-15,
      );
    }
    // And that step, on the ground, is far under the no-visible-loss epsilon.
    expect(rt.maxGroundMeters).toBeLessThan(QUANTIZATION_GROUND_EPSILON_M);
  });

  it('maps the per-axis bbox extremes to 0 and 65535 exactly', () => {
    const { quantized } = quantizePositionsToUint16(QUANTIZATION_EXTREMES);
    // Vertex 0 is the min on every axis, vertex 1 the max.
    expect(Array.from(quantized.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(quantized.subarray(3, 6))).toEqual([65535, 65535, 65535]);
  });

  it('round-trips through the real projection stage (lon/lat → mercator → uint16 → decode)', () => {
    // The whole geometry path a point tile takes: project a small cluster, then
    // quantize+decode it, and confirm nothing drifts more than a step.
    const lonLat = new Float64Array([
      -122.4, 37.7, -122.3999, 37.7001, -122.4001, 37.6999,
    ]);
    const projected = projectPositions(lonLat, 2);
    const rt = quantizationRoundTrip(projected);
    expect(rt.maxGroundMeters).toBeLessThan(QUANTIZATION_GROUND_EPSILON_M);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 4 — DataFilter hard/soft ramp exact values
// ════════════════════════════════════════════════════════════════════════════

describe('INVARIANT: DataFilter produces exact hard-step / smoothstep-ramp factors', () => {
  it.each(DATA_FILTER_GOLDENS)('$name', (g) => {
    expect(dataFilterAlphaJS(g.value, g.range, g.soft, g.enabled)).toBeCloseTo(
      g.expected,
      12,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 5 — filter alpha composes multiplicatively with the time filter
//   (the gap the per-feature suites leave: neither tests the COMBINATION, but
//    the data-filter kernel doc promises the two commute as independent 0..1
//    multipliers — `vAlpha *= sttDataFilterAlpha(...)`.)
// ════════════════════════════════════════════════════════════════════════════

describe('INVARIANT: time-filter alpha and DataFilter alpha multiply independently', () => {
  it('a half-lit fade times a half-lit soft margin yields their product', () => {
    // Time: fade-in golden gives 0.4; filter: soft-margin midpoint gives 0.5.
    const [ws, we] = windowEdges(1000, 200);
    const timeAlpha = timeWindowAlphaJS(1080, 1090, ws, we, 50, 0);
    const filterAlpha = dataFilterAlphaJS(1, [0, 10], [2, 8], true);
    expect(timeAlpha).toBeCloseTo(0.4, 12);
    expect(filterAlpha).toBeCloseTo(0.5, 12);
    // The composed vertex alpha a layer uploads.
    expect(timeAlpha * filterAlpha).toBeCloseTo(0.2, 12);
  });

  it('either factor at zero blanks the vertex regardless of the other', () => {
    const [ws, we] = windowEdges(1000, 200);
    const outOfWindow = timeWindowAlphaJS(0, 800, ws, we, 0, 0); // discarded
    const inRange = dataFilterAlphaJS(5, [0, 10], [0, 10], true); // 1
    expect(outOfWindow * inRange).toBe(0);

    const inWindow = timeWindowAlphaJS(950, 1050, ws, we, 0, 0); // 1
    const outOfRange = dataFilterAlphaJS(99, [0, 10], [0, 10], true); // 0
    expect(inWindow * outOfRange).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 6 — summary/cell rings close and wind canonically
// ════════════════════════════════════════════════════════════════════════════

describe('INVARIANT: cell rings are closed, positively wound, and seam-contiguous', () => {
  /** Inject the golden boundary as h3-js's `cellToBoundary` (absent peer here). */
  const cellToBoundary: H3CellToBoundary = (index) => {
    const src = index === H3_ANTIMERIDIAN.index ? H3_ANTIMERIDIAN : H3_SF;
    return src.boundary.map((p) => [p[0], p[1]]);
  };

  it('an H3 cell far from the seam closes, winds positive, and stays inside the unit square', () => {
    const ring = h3CellToMercatorRing(H3_SF.index, cellToBoundary);
    const facts = inspectRing(ring);
    expect(facts).not.toBeNull();
    expect(facts!.closed).toBe(true);
    expect(facts!.rimVertices).toBe(H3_SF.rimVertices);
    expect(facts!.positiveWinding).toBe(true);
    expect(facts!.withinUnitSquare).toBe(true);
  });

  it('a seam-crossing H3 cell stays CONTIGUOUS (no smear across the world)', () => {
    // The whole reason the unwrap machinery exists: a naive projection would
    // put some vertices near x≈0 and others near x≈1 (xSpan ≈ 1). A contiguous
    // ring keeps xSpan small (a cell is a fraction of a degree wide) even
    // though its x may leave [0, 1].
    const ring = h3CellToMercatorRing(H3_ANTIMERIDIAN.index, cellToBoundary);
    const facts = inspectRing(ring);
    expect(facts).not.toBeNull();
    expect(facts!.closed).toBe(true);
    expect(facts!.positiveWinding).toBe(true);
    expect(facts!.xSpan).toBeLessThan(0.01); // contiguous, not smeared
  });

  it('a Quadbin root cell decodes to (0,0,0) and covers the whole unit square', () => {
    expect(quadbinToTile(QUADBIN_ROOT)).toEqual(QUADBIN_ROOT_TILE);
    expect(quadbinTileToMercatorBounds(QUADBIN_ROOT_TILE)).toEqual(
      QUADBIN_ROOT_BOUNDS,
    );
    const ring = quadbinCellToMercatorRing(QUADBIN_ROOT);
    const facts = inspectRing(ring);
    expect(facts).not.toBeNull();
    expect(facts!.closed).toBe(true);
    expect(facts!.rimVertices).toBe(4);
    expect(facts!.positiveWinding).toBe(true);
    expect(facts!.withinUnitSquare).toBe(true);
  });

  it('a Quadbin child tile has exact fractional mercator bounds', () => {
    expect(quadbinTileToMercatorBounds(QUADBIN_CHILD_TILE)).toEqual(
      QUADBIN_CHILD_BOUNDS,
    );
  });

  it('winding detection + orientation are correct against a known-orientation square', () => {
    const positive = Float64Array.from(POSITIVE_SQUARE);
    // Reverse the ring by VERTEX (not by float — that would reverse each coord
    // pair too) to get the opposite, negative-area winding.
    const reversedByVertex = new Float64Array(POSITIVE_SQUARE.length);
    const n = POSITIVE_SQUARE.length >> 1;
    for (let i = 0; i < n; i++) {
      reversedByVertex[i * 2] = POSITIVE_SQUARE[(n - 1 - i) * 2];
      reversedByVertex[i * 2 + 1] = POSITIVE_SQUARE[(n - 1 - i) * 2 + 1];
    }

    expect(ringSignedArea2(positive)).toBeCloseTo(POSITIVE_SQUARE_AREA2, 12);
    expect(ringSignedArea2(reversedByVertex)).toBeCloseTo(
      -POSITIVE_SQUARE_AREA2,
      12,
    );
    // orientRingPositive returns the SAME array untouched when already positive,
    // and flips a negative ring in place to positive.
    expect(orientRingPositive(positive)).toBe(positive);
    const fixed = orientRingPositive(reversedByVertex);
    expect(ringSignedArea2(fixed)).toBeGreaterThanOrEqual(0);
  });

  it('a cell ring triangulates into a valid centroid fan', () => {
    const ring = h3CellToMercatorRing(H3_SF.index, cellToBoundary)!;
    const tri = cellRingToTriangles(ring);
    expect(tri).not.toBeNull();
    const rim = H3_SF.rimVertices;
    // n rim vertices ⇒ n fan triangles from n+1 positions (centroid at index 0).
    expect(tri!.indices.length).toBe(rim * 3);
    expect(tri!.positions.length).toBe((rim + 1) * 2);
    // Every triangle references the centroid and two consecutive rim vertices;
    // no index escapes the vertex list.
    for (let t = 0; t < rim; t++) {
      expect(tri!.indices[t * 3]).toBe(0); // centroid
    }
    for (const idx of tri!.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(rim);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 7 — flow value-matrix sampling at/between timesteps
// ════════════════════════════════════════════════════════════════════════════

describe('INVARIANT: flow value-matrix samples exactly at columns and blends between them', () => {
  const packed = packValueMatrix(
    FLOW_MATRIX_VALUES,
    FLOW_MATRIX_ROWS,
    FLOW_MATRIX_COLS,
    { format: 'float32' },
  );

  it('packs to a power-of-two-width texture that fits the matrix', () => {
    expect(packed).not.toBeNull();
    // texWidth is a power of two; the texture holds >= rows*cols texels.
    const w = packed!.texWidth;
    expect(w & (w - 1)).toBe(0);
    expect(packed!.texWidth * packed!.texHeight).toBeGreaterThanOrEqual(
      FLOW_MATRIX_ROWS * FLOW_MATRIX_COLS,
    );
  });

  it.each(FLOW_SAMPLE_GOLDENS)('$name', (g) => {
    expect(sampleFlowMatrixJS(packed!, g.row, g.bucket)).toBeCloseTo(
      g.expected,
      6,
    );
  });

  it('the unorm16 packing decodes the same goldens within its fixed-point step', () => {
    const packed16 = packValueMatrix(
      FLOW_MATRIX_VALUES,
      FLOW_MATRIX_ROWS,
      FLOW_MATRIX_COLS,
      { format: 'unorm16' },
    )!;
    const step = packed16.valueSpan / 65535;
    for (const g of FLOW_SAMPLE_GOLDENS) {
      const got = sampleFlowMatrixJS(packed16, g.row, g.bucket);
      // Within one fixed-point step of the exact float answer (plus the linear
      // blend of two such quantised endpoints, hence 2×).
      expect(Math.abs(got - g.expected)).toBeLessThanOrEqual(2 * step + 1e-6);
    }
  });

  it('the bucket axis maps a playhead to a clamped continuous column', () => {
    for (const g of FLOW_AXIS_GOLDENS) {
      expect(bucketPositionAt(FLOW_AXIS, g.absTimeMs)).toBeCloseTo(
        g.expected,
        12,
      );
    }
  });

  it('deriveFlowAxis reconstructs the golden axis from a tile feature span', () => {
    // A flow feature's [start, end] spans the whole tile range; columns divide
    // it evenly. start rel 0, end rel 300, timeOffset 1000, 3 buckets ⇒ the
    // golden axis (width 100, origin 1000).
    const axis = deriveFlowAxis({
      vertexValueBuckets: FLOW_AXIS.numBuckets,
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([300]),
      timeOffset: 1000,
    });
    expect(axis).toEqual(FLOW_AXIS);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INTEGRATION — mock-map lifecycle across MULTIPLE real layer kinds at once
//   (the integration-level companion to the per-feature unit tests: mount →
//    play → styledata rebuild → context loss → restore → unmount, four kinds
//    sharing one map, asserting no throws and correct re-init.)
// ════════════════════════════════════════════════════════════════════════════

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** The archive surface `initTileset` consumes (mirrors base-lifecycle's stub). */
function makeStubArchive() {
  return {
    getMetadata: vi.fn(async () => ({
      minZoom: 0,
      maxZoom: 5,
      temporalBucketMs: 3_600_000,
    })),
    getTileIdsInBounds: vi.fn(() => []),
    getTile: vi.fn(async () => null),
    getTiles: vi.fn(async (ids: unknown[]) => ids.map(() => null)),
    getTileByteSize: vi.fn(() => 4096),
    getThroughputEstimate: vi.fn(() => ({ bytesPerMs: 5, samples: 3 })),
    finalize: vi.fn(),
  };
}

interface MountedKind {
  id: string;
  layer: any;
  tile: Tile;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const mat16 = () => Array.from({ length: 16 }, (_, i) => i);

describe('INTEGRATION: multi-kind mock-map lifecycle survives the full mount→unmount cycle', () => {
  function mountAll(): MountedKind[] {
    const specs = [
      { id: 'stt-pt', Cls: STTPointLayer, tile: makePointTile() },
      { id: 'stt-ln', Cls: STTLineLayer, tile: makeLineTile() },
      { id: 'stt-pg', Cls: STTPolygonLayer, tile: makePolygonTile() },
      { id: 'stt-tr', Cls: STTTripsLayer, tile: makeTripsTile() },
    ] as const;
    return specs.map((s) => {
      const layer = new s.Cls({ ...baseOpts, id: s.id } as any) as any;
      layer.archive = makeStubArchive();
      return { id: s.id, layer, tile: s.tile };
    });
  }

  /** Load each kind's matching tile and render one frame; returns draw count. */
  function renderFrame(gl: any, kinds: MountedKind[]): number {
    for (const k of kinds) {
      k.layer.loadedTiles.set(tileKey(k.tile), k.tile);
    }
    gl.drawCalls.length = 0;
    for (const k of kinds) k.layer.render(gl, mat16());
    return gl.drawCalls.length;
  }

  it('mount → play → styledata rebuild → context loss → restore → unmount, no throws, correct re-init', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const kinds = mountAll();

    // ── MOUNT ──────────────────────────────────────────────────────────────
    expect(() => {
      for (const k of kinds) k.layer.attach(map as any);
    }).not.toThrow();
    await tick();
    expect(map.getLayerOrder()).toHaveLength(4);
    for (const k of kinds) {
      expect(map.getLayer(k.id)).toBeDefined();
      expect(k.layer.getTileset()).toBeDefined();
      expect(k.layer.archive.getMetadata).toHaveBeenCalledTimes(1);
    }

    // ── PLAY: advance the playhead, then draw a real frame ───────────────────
    map.triggerRepaint.mockClear();
    expect(() => {
      for (const k of kinds)
        k.layer.setCurrentTime(baseOpts.currentTime + 2000);
    }).not.toThrow();
    // autoRepaint (default) drives the canvas as the playhead moves.
    expect(map.triggerRepaint).toHaveBeenCalled();

    let draws = 0;
    expect(() => {
      draws = renderFrame(gl, kinds);
    }).not.toThrow();
    // The four kinds' pipelines actually issued GPU draw calls end-to-end.
    expect(draws).toBeGreaterThan(0);

    // ── STYLEDATA REBUILD (diff-fallback destroys custom layers) ─────────────
    expect(() => map.simulateStyleRebuild()).not.toThrow();
    // The attach() guard idempotently re-added every kind.
    for (const k of kinds) expect(map.getLayer(k.id)).toBeDefined();
    await tick();
    // Correct re-init: metadata re-read (second call), tileset rebuilt.
    for (const k of kinds) {
      expect(k.layer.archive.getMetadata).toHaveBeenCalledTimes(2);
      expect(k.layer.getTileset()).toBeDefined();
    }

    // ── CONTEXT LOSS ─────────────────────────────────────────────────────────
    expect(() => map.getCanvas().dispatch('webglcontextlost')).not.toThrow();
    for (const k of kinds) {
      expect(k.layer.contextLost).toBe(true);
      expect(k.layer.tileGpuCache.size).toBe(0);
      expect(k.layer.programCache.size).toBe(0);
    }
    // Rendering on a dead context is an inert no-op, never a throw.
    expect(() => {
      for (const k of kinds) k.layer.render(gl, mat16());
    }).not.toThrow();

    // ── RESTORE ──────────────────────────────────────────────────────────────
    map.triggerRepaint.mockClear();
    expect(() =>
      map.getCanvas().dispatch('webglcontextrestored'),
    ).not.toThrow();
    for (const k of kinds) expect(k.layer.contextLost).toBe(false);
    expect(map.triggerRepaint).toHaveBeenCalled();
    // The caches rebuild lazily: a fresh frame draws again without error.
    let redraws = 0;
    expect(() => {
      redraws = renderFrame(gl, kinds);
    }).not.toThrow();
    expect(redraws).toBeGreaterThan(0);

    // ── UNMOUNT ──────────────────────────────────────────────────────────────
    expect(() => {
      for (const k of kinds) k.layer.detach();
    }).not.toThrow();
    for (const k of kinds) expect(map.getLayer(k.id)).toBeUndefined();
    // Nothing resurrects a detached layer on later style churn.
    map.fire('styledata');
    expect(() => map.simulateStyleRebuild()).not.toThrow();
    for (const k of kinds) expect(map.getLayer(k.id)).toBeUndefined();
  });

  it('map.remove() tears every mounted kind down (finalize + listener detach), no throws', async () => {
    const gl = makeMockGl();
    const map = new MockMap(gl);
    const kinds = mountAll();
    for (const k of kinds) k.layer.attach(map as any);
    await tick();
    const tilesets = kinds.map((k) => k.layer.getTileset());
    for (const ts of tilesets) expect(ts).toBeDefined();
    const finalizeSpies = tilesets.map((ts) => vi.spyOn(ts, 'finalize'));

    expect(() => map.remove()).not.toThrow();

    kinds.forEach((k, i) => {
      expect(finalizeSpies[i]).toHaveBeenCalledTimes(1);
      expect(k.layer.archive.finalize).toHaveBeenCalledTimes(1);
      expect(k.layer.getTileset()).toBeUndefined();
      expect(k.layer.loadedTiles.size).toBe(0);
      // A stray context-loss after teardown must not touch the dead layer.
      expect(() => k.layer.detach()).not.toThrow();
    });
    // The canvas listeners were all detached.
    const removed = map
      .getCanvas()
      .removeEventListener.mock.calls.map((c: unknown[]) => c[0]);
    expect(removed).toContain('webglcontextlost');
    expect(removed).toContain('webglcontextrestored');
  });
});
