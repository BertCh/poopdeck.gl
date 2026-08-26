// @poopdeck.gl/three — flowStroke
//
// The stroke kind is a flow corridor plus two things: a per-PATH width that
// breathes with the active bucket's peak volume, and a constant perpendicular
// offset that turns A→B / B→A into twin ribbons. So this suite pins
//   1. the pure width math (`src/lib/flow-stroke-widths.ts`) — peak selection,
//      the fractional-bucket blend, the exponent, the minFlow collapse;
//   2. the path/segment merge order AGAINST the corridor builder it must
//      mirror (a drift there would silently width every corridor wrongly);
//   3. the layer's sub-step gate — widths move, geometry never re-uploads.
// TSL graphs are plain JS objects in Node, so the vertex stage is inspected
// structurally (which attributes and constants it actually references) without
// a WebGPU device.

import { describe, it, expect } from 'vitest';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import {
  buildFlowStrokePaths,
  bucketBlendAt,
  pathPeakAt,
  strokeWidthFromPeak,
  computePathWidths,
  expandPathWidths,
  flowStrokeSubStep,
  steppedBucketPos,
  FLOW_STROKE_SUB_STEP,
} from '../src/lib/flow-stroke-widths';
import { buildFlowCorridorBuffers } from '../src/lib/flow-corridor-buffers';
import { STTFlowStrokeLayer } from '../src/layers/flow-stroke-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile } from './_support/features';

const anchor = { longitude: -73.57, latitude: 45.5 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };

const D = 0.001;

/**
 * Two corridors in one tile, 2 buckets:
 *
 *   path 0 — 3 vertices (⇒ 2 segments)  v0 [10, 80]  v1 [100, 4]  v2 [50, 40]
 *   path 1 — 2 vertices (⇒ 1 segment)   v3 [16,  0]  v4 [  4, 0]
 *
 * Path 0's BUSIEST vertex is v1 in bucket 0 but v0 in bucket 1 — the argmax
 * MIGRATES between the columns, which is what separates the exact
 * `max ∘ blend` (52 at the half-bucket) from the cheap `blend ∘ max` (90).
 * Path 1 goes quiet in bucket 1 (peak 0) so the minFlow collapse has a subject.
 *
 * The axis is `[0, 1000]` over 2 buckets ⇒ bucketWidth 500, so t=0 → bucket 0,
 * t=250 → bucket 0.5, t=500 → bucket 1 (the clamped last column).
 */
function strokeTile(partial: Partial<BinaryFeatures> = {}): Tile {
  const lon = anchor.longitude;
  const lat = anchor.latitude;
  // prettier-ignore
  const positions = new Float64Array([
    lon,         lat,          // v0
    lon + D,     lat,          // v1
    lon + 2 * D, lat,          // v2
    lon,         lat + D,      // v3
    lon + D,     lat + D,      // v4
  ]);
  // Globally vertex-major: matrix[vertex * numBuckets + bucket].
  // prettier-ignore
  const matrix = new Float32Array([
    10, 80,   // v0
    100, 4,   // v1
    50, 40,   // v2
    16, 0,    // v3
    4, 0,     // v4
  ]);
  return makeLineTile(
    {
      featureCount: 2,
      positions,
      startIndices: new Uint32Array([0, 3, 5]),
      featureIds: new Uint32Array([0, 1]),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([1000, 1000]),
      vertexValueMatrix: matrix,
      vertexValueBuckets: 2,
      ...partial,
    },
    { layerName: 'flow', z: 12 },
  );
}

/**
 * Walk a TSL graph collecting the attribute names and literal constants it
 * actually references. A TSL node is plain data — fluent ops wrap operands in
 * `VarNode`s whose `.node` is enumerable — so a generic own-property walk
 * reaches every operand. `parents`/`_beforeNodes` are back-references and are
 * skipped so the walk terminates.
 */
function walkGraph(root: unknown): {
  attributes: Set<string>;
  constants: Set<number>;
} {
  const attributes = new Set<string>();
  const constants = new Set<number>();
  const seen = new Set<unknown>();
  const visit = (v: any): void => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (v.isNode !== true) return;
    if (typeof v._attributeName === 'string') attributes.add(v._attributeName);
    if (v.isConstNode === true && typeof v.value === 'number') {
      constants.add(v.value);
    }
    for (const [key, child] of Object.entries(v)) {
      if (key === 'parents' || key === '_beforeNodes') continue;
      visit(child);
    }
  };
  visit(root);
  return { attributes, constants };
}

/** Layer options that make the width math read as raw volume (exponent 1). */
const identityWidth = {
  domain: [0, 100] as [number, number],
  ramp: [
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ] as [number, number, number, number][],
  widthExponent: 1,
  widthScale: 1,
  minWidthPx: 0,
  maxWidthPx: 1000,
};

describe('buildFlowStrokePaths', () => {
  it('packs each corridor’s vertex rows and maps segments to their path', () => {
    const paths = buildFlowStrokePaths([strokeTile()]);

    expect(paths.pathCount).toBe(2);
    expect(paths.segmentCount).toBe(3); // 2 + 1
    expect(paths.numBuckets).toBe(2);
    // Vertex rows are packed path-major, aligned with the source matrix.
    expect(Array.from(paths.vertexStart)).toEqual([0, 3, 5]);
    expect(Array.from(paths.values.slice(0, 4))).toEqual([10, 80, 100, 4]);
    expect(Array.from(paths.values.slice(6, 10))).toEqual([16, 0, 4, 0]);
    // Segment instances 0,1 belong to path 0; instance 2 to path 1.
    expect(Array.from(paths.segmentPath)).toEqual([0, 0, 1]);
  });

  it('mirrors the corridor builder’s merge order and bucket axis exactly', () => {
    // If these two ever drift, `segmentPath` would index a different set of
    // instances than the ones the corridor uploaded — every width on the wrong
    // corridor, silently. This is the guard, and it runs over TWO tiles: a
    // single-tile fixture cannot catch a per-tile cursor drift (a `p`/`vOut`
    // that resets per layer instead of running across the whole merge).
    const tiles = [strokeTile(), strokeTile()];
    const buf = buildFlowCorridorBuffers(tiles, proj, 0, {});
    const paths = buildFlowStrokePaths(tiles);
    expect(paths.segmentCount).toBe(buf.count);
    expect(paths.segmentCount).toBe(6);
    expect(paths.pathCount).toBe(4);
    expect(paths.numBuckets).toBe(buf.numBuckets);
    expect(paths.axis).toEqual(buf.axis);
    expect(paths.axis).toEqual({
      numBuckets: 2,
      bucket0Abs: 0,
      bucketWidth: 500,
    });
    // The second tile's corridors are DISTINCT paths that own the trailing
    // instances, and their vertex rows are packed after the first tile's.
    expect(Array.from(paths.segmentPath)).toEqual([0, 0, 1, 2, 2, 3]);
    expect(Array.from(paths.vertexStart)).toEqual([0, 3, 5, 8, 10]);
  });

  it('agrees with the corridor VALUE MATRIX segment for segment', () => {
    // The strongest cross-builder lock available without a GPU: the corridor
    // uploads, per merged instance `s`, that segment's two endpoint values per
    // bucket (RG). A path's peak must therefore be exactly the max over the
    // endpoint values of the instances `segmentPath` assigns to it. If either
    // builder reordered, renumbered or mis-strided, this diverges — whereas a
    // count check alone would still pass.
    const tiles = [strokeTile(), strokeTile()];
    const buf = buildFlowCorridorBuffers(tiles, proj, 0, {});
    const paths = buildFlowStrokePaths(tiles);
    const nb = buf.numBuckets;
    for (const bucket of [0, 1]) {
      const perPath = new Float64Array(paths.pathCount).fill(-Infinity);
      for (let s = 0; s < buf.count; s++) {
        const row = s * nb * 2 + bucket * 2;
        const p = paths.segmentPath[s];
        perPath[p] = Math.max(
          perPath[p],
          buf.valueMatrix[row],
          buf.valueMatrix[row + 1],
        );
      }
      for (let p = 0; p < paths.pathCount; p++) {
        expect(perPath[p]).not.toBe(-Infinity); // every path owns instances
        expect(pathPeakAt(paths, p, bucketBlendAt(bucket, nb))).toBeCloseTo(
          perPath[p],
          6,
        );
      }
    }
  });

  it('is empty for a line tile with no value matrix', () => {
    const tile = makeLineTile(
      {
        positions: new Float64Array([anchor.longitude, anchor.latitude]),
        startIndices: new Uint32Array([0, 1]),
      },
      { layerName: 'flow' },
    );
    const paths = buildFlowStrokePaths([tile]);
    expect(paths.pathCount).toBe(0);
    expect(paths.segmentCount).toBe(0);
    expect(paths.numBuckets).toBe(0);
    expect(paths.axis).toBeNull();
    expect(paths.values.length).toBe(0);
  });

  it('ignores tiles whose bucket count disagrees with the first matrix tile', () => {
    const odd = makeLineTile(
      {
        positions: new Float64Array([
          anchor.longitude,
          anchor.latitude + 0.01,
          anchor.longitude + D,
          anchor.latitude + 0.01,
        ]),
        startIndices: new Uint32Array([0, 2]),
        startTimes: new Float32Array([0]),
        endTimes: new Float32Array([1000]),
        vertexValueMatrix: new Float32Array([1, 2, 3, 4, 5, 6]),
        vertexValueBuckets: 3, // mismatched
      },
      { layerName: 'flow' },
    );
    const paths = buildFlowStrokePaths([strokeTile(), odd]);
    expect(paths.numBuckets).toBe(2);
    expect(paths.pathCount).toBe(2); // only the 2-bucket tile's corridors
    expect(paths.segmentCount).toBe(3);
  });
});

describe('bucketBlendAt', () => {
  it('resolves the two adjacent columns and the blend fraction', () => {
    expect(bucketBlendAt(0, 4)).toEqual({ b0: 0, b1: 1, f: 0 });
    expect(bucketBlendAt(1.25, 4)).toEqual({ b0: 1, b1: 2, f: 0.25 });
  });

  it('degenerates to a plain read at the last column and clamps outside', () => {
    expect(bucketBlendAt(3, 4)).toEqual({ b0: 3, b1: 3, f: 0 });
    expect(bucketBlendAt(99, 4)).toEqual({ b0: 3, b1: 3, f: 0 });
    expect(bucketBlendAt(-5, 4)).toEqual({ b0: 0, b1: 1, f: 0 });
    expect(bucketBlendAt(Number.NaN, 4)).toEqual({ b0: 0, b1: 1, f: 0 });
    expect(bucketBlendAt(1, 0)).toEqual({ b0: 0, b1: 0, f: 0 });
  });
});

describe('pathPeakAt', () => {
  const paths = buildFlowStrokePaths([strokeTile()]);

  it('picks the BUSIEST vertex of the corridor, not its endpoints', () => {
    // Bucket 0: v0=10, v1=100, v2=50 → the middle vertex wins.
    expect(pathPeakAt(paths, 0, bucketBlendAt(0, 2))).toBe(100);
    expect(pathPeakAt(paths, 1, bucketBlendAt(0, 2))).toBe(16);
  });

  it('blends the two adjacent columns before reducing (max ∘ blend)', () => {
    // At the half-bucket the per-vertex blends are v0=45, v1=52, v2=45.
    // The cheap `blend ∘ max` would say 0.5·100 + 0.5·80 = 90 — the argmax
    // MIGRATES from v1 to v0 between the columns, and 52 is the honest peak.
    expect(pathPeakAt(paths, 0, bucketBlendAt(0.5, 2))).toBeCloseTo(52, 6);
    expect(pathPeakAt(paths, 0, bucketBlendAt(0.5, 2))).not.toBeCloseTo(90, 6);
    // A quarter of the way across: v0=27.5, v1=76, v2=47.5.
    expect(pathPeakAt(paths, 0, bucketBlendAt(0.25, 2))).toBeCloseTo(76, 6);
  });

  it('reads the last column alone once the playhead clamps to it', () => {
    // Bucket 1: v0=80, v1=4, v2=40 → the peak moves to the far endpoint.
    expect(pathPeakAt(paths, 0, bucketBlendAt(1, 2))).toBe(80);
    expect(pathPeakAt(paths, 1, bucketBlendAt(1, 2))).toBe(0);
  });

  it('peaks at 0 for an out-of-range path', () => {
    expect(pathPeakAt(paths, 7, bucketBlendAt(0, 2))).toBe(0);
    expect(pathPeakAt(paths, -1, bucketBlendAt(0, 2))).toBe(0);
  });
});

describe('strokeWidthFromPeak', () => {
  it('√-scales by default so width is area-proportional', () => {
    expect(strokeWidthFromPeak(100)).toBeCloseTo(10, 6);
    expect(strokeWidthFromPeak(16)).toBeCloseTo(4, 6);
  });

  it('honours the exponent', () => {
    expect(strokeWidthFromPeak(100, { widthExponent: 1 })).toBe(100);
    expect(strokeWidthFromPeak(100, { widthExponent: 0 })).toBe(1);
    expect(strokeWidthFromPeak(9, { widthExponent: 2 })).toBeCloseTo(81, 6);
  });

  it('applies widthScale after the exponent, then the pixel clamp', () => {
    expect(strokeWidthFromPeak(16, { widthScale: 3 })).toBeCloseTo(12, 6);
    expect(
      strokeWidthFromPeak(16, { widthScale: 3, maxWidthPx: 8 }),
    ).toBeCloseTo(8, 6);
    expect(strokeWidthFromPeak(0.01, { minWidthPx: 1 })).toBe(1);
  });

  it('collapses to EXACTLY 0 at or below minFlow, bypassing minWidthPx', () => {
    // The per-hour pulse: a quiet corridor disappears, it does not shrink to
    // the floor. `toBe(0)` on purpose — 1e-9 would still rasterise.
    expect(strokeWidthFromPeak(5, { minFlow: 5, minWidthPx: 4 })).toBe(0);
    expect(strokeWidthFromPeak(4.9, { minFlow: 5, minWidthPx: 4 })).toBe(0);
    expect(
      strokeWidthFromPeak(5.1, { minFlow: 5, minWidthPx: 4 }),
    ).toBeGreaterThan(0);
    // Default minFlow 0 ⇒ a zero-volume corridor is invisible.
    expect(strokeWidthFromPeak(0, { minWidthPx: 2 })).toBe(0);
  });

  it('never returns NaN for a non-positive or NaN peak', () => {
    expect(strokeWidthFromPeak(-4, { minFlow: -10 })).toBe(0);
    expect(strokeWidthFromPeak(Number.NaN)).toBe(0);
  });
});

describe('computePathWidths / expandPathWidths', () => {
  const paths = buildFlowStrokePaths([strokeTile()]);
  const opts = { widthExponent: 1, maxWidthPx: 1000 };

  it('is one width per path, broadcast onto that path’s segments', () => {
    const perPath = computePathWidths(paths, 0, opts);
    expect(Array.from(perPath)).toEqual([100, 16]);
    const perSegment = expandPathWidths(paths, perPath);
    // Uniform along the path — deck's PathLayer semantics — NOT a taper.
    expect(Array.from(perSegment)).toEqual([100, 100, 16]);
  });

  it('breathes with the bucket and collapses the quiet corridor', () => {
    expect(Array.from(computePathWidths(paths, 1, opts))).toEqual([80, 0]);
    const half = computePathWidths(paths, 0.5, opts);
    expect(half[0]).toBeCloseTo(52, 5);
    expect(half[1]).toBeCloseTo(8, 5);
  });

  it('reuses a caller-supplied output array (no per-sub-step allocation)', () => {
    const out = new Float32Array(paths.pathCount);
    expect(computePathWidths(paths, 0, opts, out)).toBe(out);
    const seg = new Float32Array(paths.segmentCount);
    expect(expandPathWidths(paths, out, seg)).toBe(seg);
    expect(Array.from(seg)).toEqual([100, 100, 16]);
  });
});

describe('flowStrokeSubStep', () => {
  it('quantizes the playhead to deck’s cross-fade sub-step', () => {
    expect(FLOW_STROKE_SUB_STEP).toBe(0.5);
    expect(flowStrokeSubStep(0)).toBe(0);
    expect(flowStrokeSubStep(0.2)).toBe(0); // same sub-step ⇒ no recompute
    expect(flowStrokeSubStep(0.3)).toBe(1);
    expect(flowStrokeSubStep(1)).toBe(2);
    expect(steppedBucketPos(1)).toBe(0.5);
    expect(steppedBucketPos(2)).toBe(1);
  });
});

describe('STTFlowStrokeLayer', () => {
  const makeLayer = (extra: Record<string, unknown> = {}) =>
    new STTFlowStrokeLayer({ ...identityWidth, ...extra });

  it('defaults its id to the kind name and stays hidden until tiles arrive', () => {
    const layer = makeLayer();
    expect(layer.id).toBe('flow-stroke');
    expect(layer.object.name).toBe('flow-stroke');
    expect(layer.object.visible).toBe(false);
    layer.dispose();
  });

  it('is NOT id-pickable (a merged corridor has no single feature to pick)', () => {
    const layer = makeLayer();
    expect(
      typeof (layer as unknown as { pick?: unknown }).pick === 'function',
    ).toBe(false);
    layer.dispose();
  });

  it('binds one uniform width per path onto the corridor instances', () => {
    const layer = makeLayer();
    layer.setTiles([strokeTile()], ctx);
    layer.setTime(0);

    const geometry = layer.object.geometry;
    expect(geometry.instanceCount).toBe(3);
    const attr = geometry.getAttribute('sttStrokeWidth');
    expect(attr).toBeTruthy();
    expect(attr.itemSize).toBe(1);
    expect(Array.from(attr.array as Float32Array)).toEqual([100, 100, 16]);
    layer.dispose();
  });

  it('re-widths on a sub-step crossing WITHOUT touching the geometry', () => {
    const layer = makeLayer();
    const tile = strokeTile();
    const paths = buildFlowStrokePaths([tile]);
    layer.setTiles([tile], ctx);
    layer.setTime(0);

    const geometry = layer.object.geometry;
    const posA = geometry.getAttribute('sttPosA');
    const width = geometry.getAttribute('sttStrokeWidth');
    const posAVersion = posA.version;
    const posASnapshot = Array.from(posA.array as Float32Array);
    const widthVersion = width.version;

    // Same sub-step (bucket 0.2 → sub-step 0): the gate must swallow it. The
    // UNGATED width there is 80.8, so this really is quantization — not a
    // position whose width happened to be unchanged.
    expect(
      computePathWidths(paths, 0.2, { widthExponent: 1, maxWidthPx: 1000 })[0],
    ).toBeCloseTo(80.8, 4);
    layer.setTime(100);
    expect(width.version).toBe(widthVersion);
    expect(Array.from(width.array as Float32Array)).toEqual([100, 100, 16]);

    // Crossing into sub-step 1 (bucket 0.5) re-expands the widths…
    layer.setTime(250);
    expect(width.version).toBeGreaterThan(widthVersion);
    const half = Array.from(width.array as Float32Array);
    expect(half[0]).toBeCloseTo(52, 4);
    expect(half[2]).toBeCloseTo(8, 4);

    // …and the last column collapses the quiet corridor to exactly 0.
    layer.setTime(500);
    expect(Array.from(width.array as Float32Array)).toEqual([80, 80, 0]);

    // The geometry itself never moved: same object, same buffers, same version.
    expect(layer.object.geometry).toBe(geometry);
    expect(geometry.getAttribute('sttPosA')).toBe(posA);
    expect(posA.version).toBe(posAVersion);
    expect(Array.from(posA.array as Float32Array)).toEqual(posASnapshot);
    layer.dispose();
  });

  it('collapses corridors at or below minFlow to width 0', () => {
    const layer = makeLayer({ minFlow: 50 });
    layer.setTiles([strokeTile()], ctx);
    layer.setTime(0);
    // path 0 peaks at 100 (> 50, drawn); path 1 peaks at 16 (≤ 50, gone).
    expect(
      Array.from(
        layer.object.geometry.getAttribute('sttStrokeWidth')
          .array as Float32Array,
      ),
    ).toEqual([100, 100, 0]);
    layer.dispose();
  });

  it('drives the vertex stage from the per-instance width attribute', () => {
    const layer = makeLayer();
    layer.setTiles([strokeTile()], ctx);
    const material = layer.object.material as { vertexNode?: unknown };
    const graph = walkGraph(material.vertexNode);
    // The stroke expansion reads the corridor endpoints AND the width buffer —
    // the parent's texture-derived width is gone from the vertex stage.
    expect(graph.attributes.has('sttPosA')).toBe(true);
    expect(graph.attributes.has('sttPosB')).toBe(true);
    expect(graph.attributes.has('sttStrokeWidth')).toBe(true);
    layer.dispose();
  });

  it('bakes the twin-ribbon offset into the graph, and compiles it out at 0', () => {
    // The bias baked into `side` is 2 × offsetWidths, NOT offsetWidths: `off`
    // divides by the viewport and NDC-per-pixel is 2/viewport, so `side·width`
    // is a ±width/2 PIXEL displacement (which is what makes the ribbon exactly
    // `sttStrokeWidth` px wide). A constant `c` on `side` therefore moves the
    // centreline by c/2 RENDERED widths — so an offset of `offsetWidths`
    // widths, deck's `PathStyleExtension({offset:true})` unit, needs 2×. Baking
    // the raw 0.75 would separate the twin ribbons by only 0.375 widths and
    // overlap them; this assertion is the only place that catches it.
    const offset = makeLayer({ offsetWidths: 0.75 });
    offset.setTiles([strokeTile()], ctx);
    const withOffset = walkGraph(
      (offset.object.material as { vertexNode?: unknown }).vertexNode,
    );
    expect(withOffset.constants.has(1.5)).toBe(true);
    expect(withOffset.constants.has(0.75)).toBe(false);
    offset.dispose();

    // The DEFAULT really reaches the graph (0.6 → 1.2), so the twin ribbons
    // are separated out of the box rather than only when a caller opts in.
    const def = makeLayer();
    def.setTiles([strokeTile()], ctx);
    const defaulted = walkGraph(
      (def.object.material as { vertexNode?: unknown }).vertexNode,
    );
    expect(defaulted.constants.has(1.2)).toBe(true);
    def.dispose();

    const flat = makeLayer({ offsetWidths: 0 });
    flat.setTiles([strokeTile()], ctx);
    const noOffset = walkGraph(
      (flat.object.material as { vertexNode?: unknown }).vertexNode,
    );
    // 0 must DISABLE the offset, not fall through to the default (the classic
    // `offsetWidths || DEFAULT` bug, which `has(0.75)` alone cannot see).
    expect(noOffset.constants.has(1.2)).toBe(false);
    expect(noOffset.constants.has(1.5)).toBe(false);
    // The width attribute is still there — only the offset term is gone.
    expect(noOffset.attributes.has('sttStrokeWidth')).toBe(true);
    flat.dispose();
  });

  it('widths a tileset that arrives mid-playback at the CURRENT hour', () => {
    const layer = makeLayer();
    layer.setTime(500); // playhead moved before any tile landed
    layer.setTiles([strokeTile()], ctx);
    expect(
      Array.from(
        layer.object.geometry.getAttribute('sttStrokeWidth')
          .array as Float32Array,
      ),
    ).toEqual([80, 80, 0]);
    // …and the INHERITED colour lands on the same hour. The parent ends its
    // `setTiles` with a push at the time ORIGIN, so without the subclass
    // restoring the playhead the value texture would be sampled at bucket 0
    // (hour 0 colours) under bucket-1 widths for a frame. `bucketPos` is the
    // one uniform that carries it; reaching the private bundle is the only way
    // to observe it without a device.
    const bucketPos = (
      layer as unknown as {
        bundle: { flow: { bucketPos: { value: number } } } | null;
      }
    ).bundle?.flow.bucketPos.value;
    expect(bucketPos).toBe(1);
    layer.dispose();
  });

  it('pushes the stroke’s OWN time-filter uniforms on setTiles, not just setTime', () => {
    // The re-installed vertex stage gates on a SECOND `TimeFilterUniforms`
    // holder (the parent's lives in a private bundle). If `setTiles` pushed the
    // parent's and not this one, a `windowFilter` stroke would spend the frame
    // after a tile load hard-collapsing against the constructor defaults
    // (`windowHalf` 0) while the inherited fragment alpha ran the real window —
    // the hard cut killing everything the soft alpha meant to draw.
    const layer = makeLayer({ windowFilter: true, timeWindow: 2000 });
    layer.setTiles([strokeTile()], ctx);
    const strokeTime = (
      layer as unknown as {
        strokeTime: { windowHalf: { value: number } };
      }
    ).strokeTime;
    expect(strokeTime.windowHalf.value).toBe(1000); // timeWindow / 2, not 0
    layer.dispose();
  });

  it('drops the width state when a later tileset merges nothing', () => {
    // The stale-state trap: widths bound against the PREVIOUS geometry must not
    // survive into an empty one, or a sub-step crossing would write into a
    // buffer no longer on the mesh (and `refreshWidths` would keep paying for
    // paths that are gone).
    const layer = makeLayer();
    layer.setTiles([strokeTile()], ctx);
    layer.setTime(0);
    expect(layer.object.visible).toBe(true);
    layer.setTiles([], ctx);
    expect(layer.object.visible).toBe(false);
    expect(
      layer.object.geometry.getAttribute('sttStrokeWidth'),
    ).toBeUndefined();
    // A playhead move on the emptied layer is a no-op, not a crash.
    layer.setTime(500);
    expect(layer.object.visible).toBe(false);
    layer.dispose();
  });

  it('survives a tileset with nothing to merge', () => {
    const layer = makeLayer();
    const bare = makeLineTile(
      {
        positions: new Float64Array([anchor.longitude, anchor.latitude]),
        startIndices: new Uint32Array([0, 1]),
      },
      { layerName: 'flow' },
    );
    layer.setTiles([bare], ctx);
    layer.setTime(0);
    expect(layer.object.visible).toBe(false);
    expect(
      layer.object.geometry.getAttribute('sttStrokeWidth'),
    ).toBeUndefined();
    layer.dispose();
  });
});

describe('setViewport', () => {
  it('pushes the CSS viewport into the stroke uniform', () => {
    // Stroke width breathes in SCREEN PIXELS, so the material needs the live
    // viewport; without this the widths are computed against a stale size and
    // every corridor is the wrong thickness after a resize. (Folded in from an
    // agent probe file during the 2026-08-25 parity campaign.)
    const layer = new STTFlowStrokeLayer({
      domain: [0, 100],
      ramp: [
        [0, 0, 0, 255],
        [255, 255, 255, 255],
      ],
    });
    expect(() => layer.setViewport(800, 600)).not.toThrow();
    const sv = (
      layer as unknown as {
        strokeViewport: { value: { x: number; y: number } };
      }
    ).strokeViewport;
    expect(sv.value.x).toBe(800);
    expect(sv.value.y).toBe(600);
    layer.dispose();
  });
});
