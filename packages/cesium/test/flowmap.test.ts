// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `lib/flowmap.ts` — the pure, Cesium-free builder behind the native `flowmap`
 * kind.
 *
 * The kind's whole reason to exist over the `line` it used to degrade to is the
 * SHAPE: a tapered ribbon with a head, offset to one side so a twin pair reads
 * as two directions. So the shape is what is pinned here:
 *
 *  - **The ribbon is metres wide, in the LOCAL ENU frame.** Measured as an ECEF
 *    distance between paired rails at latitude 60, where a degree-space
 *    perpendicular (or an identity rotation pointing at the ECEF pole) would be
 *    wrong by the graticule aspect ratio. This is the single test that would
 *    catch the classic "looks right at the equator" bug.
 *  - **It tapers, and it has a head.** Tail narrower than head base, head base
 *    wider than the shaft, apex exactly on the destination.
 *  - **The twin flips.** Reversing origin and destination puts the ribbon on
 *    the opposite side of the centreline with no pairing logic — the property
 *    that makes A→B and B→A legible.
 *  - **`minFlow` ⇒ NO ARROW.** Zero width returns `null`, not a degenerate
 *    sliver: "inactive ⇒ invisible" is the pulse.
 *  - **The fractional-bucket sampling is `flow-strokes`'.** Reused, not
 *    re-implemented, so a flowmap arrow and a flow stroke agree about "the flow
 *    at 08:37".
 *
 * Everything here runs in plain Node: the module imports no Cesium.
 */

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { bucketBlendAt, flowStrokeSubStep } from '../src/lib/flow-strokes';
import {
  DEFAULT_METERS_PER_PIXEL,
  DEFAULT_MIN_MAGNITUDE_ALPHA,
  FLOW_COLUMN_CANDIDATES,
  arrowWidthMeters,
  buildArrowRibbon,
  buildFlowmapFlows,
  flowMagnitudeAt,
  flowmapBlendAt,
  flowmapColorAt,
  resolveFlowColumn,
  type FlowmapFlow,
} from '../src/lib/flowmap';

// Byte-identical to the builder's own GLOBE — the datum is the point.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const TIME_OFFSET = 1_700_000_000_000;

interface FlowTileSpec {
  /** One entry per flow: flat `[lon, lat, lon, lat, ...]`. */
  lines: number[][];
  /** One row per GLOBAL vertex, `numBuckets` wide. Omit for a static tile. */
  matrix?: number[][];
  numBuckets?: number;
  startTimes?: number[];
  endTimes?: number[];
  timeOffset?: number;
  numericProps?: Record<string, Float32Array>;
}

function flowTile(spec: FlowTileSpec): Tile {
  const timeOffset = spec.timeOffset ?? TIME_OFFSET;
  const featureCount = spec.lines.length;
  const startIndices = new Uint32Array(featureCount + 1);
  let total = 0;
  for (let f = 0; f < featureCount; f++) {
    startIndices[f] = total;
    total += spec.lines[f].length / 2;
  }
  startIndices[featureCount] = total;

  const positions = new Float64Array(total * 2);
  let p = 0;
  for (const line of spec.lines) for (const v of line) positions[p++] = v;

  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.LineString,
    positionDimensions: 2,
    positions,
    startIndices,
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(
      spec.startTimes ?? new Array(featureCount).fill(0),
    ),
    endTimes: new Float32Array(
      spec.endTimes ?? new Array(featureCount).fill(1000),
    ),
    timeOffset,
    numericProps: spec.numericProps ?? {},
    categoricalProps: {},
    vectorProps: {},
  };

  if (spec.matrix && spec.numBuckets) {
    const flat = new Float32Array(total * spec.numBuckets);
    for (let v = 0; v < spec.matrix.length; v++) {
      for (let b = 0; b < spec.numBuckets; b++) {
        flat[v * spec.numBuckets + b] = spec.matrix[v][b];
      }
    }
    features.vertexValueMatrix = flat;
    features.vertexValueBuckets = spec.numBuckets;
  }

  return {
    id: { z: 12, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'flows',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.linestring',
      },
    ],
  } as Tile;
}

/** A bare flow for the geometry unit tests — only the endpoints matter. */
function odFlow(
  srcLon: number,
  srcLat: number,
  tgtLon: number,
  tgtLat: number,
  magnitudes: number[] = [1],
): FlowmapFlow {
  return {
    srcLon,
    srcLat,
    srcAlt: 0,
    tgtLon,
    tgtLat,
    tgtAlt: 0,
    magnitudes: new Float32Array(magnitudes),
    refMagnitude: Math.max(...magnitudes),
    start: 0,
    end: 1000,
    color: [10, 20, 30, 200],
    lon: srcLon,
    lat: srcLat,
    binary: null as unknown as BinaryFeatures,
    featureIndex: 0,
  };
}

function vertexAt(pos: Float64Array, i: number): [number, number, number] {
  return [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
}

function dist3(pos: Float64Array, i: number, j: number): number {
  const a = vertexAt(pos, i);
  const b = vertexAt(pos, j);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('buildFlowmapFlows — the animated (matrix) path', () => {
  const TILE = flowTile({
    lines: [
      [10, 45, 11, 46],
      [12, 47, 13, 48],
    ],
    numBuckets: 3,
    // vertex rows: f0 = [4,9,1] & [2,3,5]  → max [4,9,5]
    //              f1 = [1,0,0] & [0,0,0]  → max [1,0,0]
    matrix: [
      [4, 9, 1],
      [2, 3, 5],
      [1, 0, 0],
      [0, 0, 0],
    ],
  });

  it('reduces each flow to the per-bucket MAX over its own vertices', () => {
    const build = buildFlowmapFlows([TILE]);
    expect(build.flows).toHaveLength(2);
    expect(build.numBuckets).toBe(3);
    expect(Array.from(build.flows[0].magnitudes)).toEqual([4, 9, 5]);
    expect(Array.from(build.flows[1].magnitudes)).toEqual([1, 0, 0]);
  });

  it('carries the all-bucket reference magnitude (the flow rush hour)', () => {
    const build = buildFlowmapFlows([TILE]);
    expect(build.flows[0].refMagnitude).toBe(9);
    expect(build.flows[1].refMagnitude).toBe(1);
  });

  it('takes the FIRST vertex as origin and the LAST as destination', () => {
    const f = buildFlowmapFlows([TILE]).flows[0];
    expect([f.srcLon, f.srcLat]).toEqual([10, 45]);
    expect([f.tgtLon, f.tgtLat]).toEqual([11, 46]);
    // The pick coordinate is the origin.
    expect([f.lon, f.lat]).toEqual([10, 45]);
  });

  it('derives the bucket axis from feature 0 and rebases to the first layer', () => {
    const build = buildFlowmapFlows([TILE]);
    expect(build.timeOrigin).toBe(TIME_OFFSET);
    expect(build.axis).toEqual({
      numBuckets: 3,
      bucket0Abs: TIME_OFFSET,
      bucketWidth: 1000 / 3,
    });
    expect(build.flows[0].start).toBe(0);
    expect(build.flows[0].end).toBe(1000);
  });

  it('rebases a later tile onto the first tile time origin', () => {
    const later = flowTile({
      lines: [[20, 50, 21, 51]],
      numBuckets: 3,
      matrix: [
        [1, 1, 1],
        [1, 1, 1],
      ],
      timeOffset: TIME_OFFSET + 5000,
    });
    const build = buildFlowmapFlows([TILE, later]);
    expect(build.timeOrigin).toBe(TIME_OFFSET);
    expect(build.flows[2].start).toBe(5000);
  });

  it('skips a single-vertex feature — an OD flow needs both ends', () => {
    const build = buildFlowmapFlows([
      flowTile({
        lines: [
          [10, 45],
          [11, 46, 12, 47],
        ],
        numBuckets: 1,
        matrix: [[3], [4], [5]],
      }),
    ]);
    expect(build.flows).toHaveLength(1);
    expect(build.flows[0].featureIndex).toBe(1);
  });
});

describe('buildFlowmapFlows — the static (column) path', () => {
  it('broadcasts a per-feature column when there is no bucket matrix', () => {
    const build = buildFlowmapFlows([
      flowTile({
        lines: [[10, 45, 11, 46]],
        numericProps: { trips: new Float32Array([7]) },
      }),
    ]);
    expect(build.numBuckets).toBe(1);
    expect(build.axis).toBeNull(); // no axis → the layer bakes geometry ONCE
    expect(Array.from(build.flows[0].magnitudes)).toEqual([7]);
    expect(build.flows[0].refMagnitude).toBe(7);
  });

  it('skips a layer that offers no magnitude at all', () => {
    const build = buildFlowmapFlows([flowTile({ lines: [[10, 45, 11, 46]] })]);
    expect(build.flows).toEqual([]);
    expect(build.numBuckets).toBe(0);
  });

  it('resolveFlowColumn honours flowProperty over the candidate probe', () => {
    const b = (
      flowTile({
        lines: [[10, 45, 11, 46]],
        numericProps: {
          trips: new Float32Array([1]),
          bespoke: new Float32Array([9]),
        },
      }).layers[0] as { features: BinaryFeatures }
    ).features;
    expect(resolveFlowColumn(b, 'bespoke')?.[0]).toBe(9);
    // The probe order is the compatibility contract with deck's FlowmapLayer.
    expect(FLOW_COLUMN_CANDIDATES.indexOf('trips')).toBeGreaterThanOrEqual(0);
    expect(resolveFlowColumn(b, null)?.[0]).toBe(1);
    expect(resolveFlowColumn(b, 'absent')).toBeNull();
  });
});

describe('fractional-bucket sampling (reused from flow-strokes)', () => {
  const FLOW = odFlow(0, 0, 1, 0, [10, 30, 30]);

  it('blends the two adjacent columns', () => {
    expect(flowMagnitudeAt(FLOW, 3, { b0: 0, b1: 1, f: 0 })).toBe(10);
    expect(flowMagnitudeAt(FLOW, 3, { b0: 0, b1: 1, f: 0.5 })).toBe(20);
    expect(flowMagnitudeAt(FLOW, 3, { b0: 0, b1: 1, f: 1 })).toBe(30);
  });

  it('clamps a past-the-end blend rather than reading off the row', () => {
    expect(flowMagnitudeAt(FLOW, 3, bucketBlendAt(99, 3))).toBe(30);
    expect(flowMagnitudeAt(FLOW, 3, bucketBlendAt(-99, 3))).toBe(10);
  });

  it('flowmapBlendAt walks absolute ms → bucket position → clamped blend', () => {
    const build = buildFlowmapFlows([
      flowTile({
        lines: [[10, 45, 11, 46]],
        numBuckets: 4,
        matrix: [
          [1, 2, 3, 4],
          [0, 0, 0, 0],
        ],
      }),
    ]);
    // bucketWidth = 1000/4 = 250; half a bucket in is f = 0.5.
    const mid = flowmapBlendAt(build, TIME_OFFSET + 125);
    expect(mid).toEqual({ b0: 0, b1: 1, f: 0.5 });
    expect(flowMagnitudeAt(build.flows[0], 4, mid)).toBe(1.5);
  });

  it('a null axis pins every playhead to bucket 0 — a static flowmap bakes once', () => {
    const build = buildFlowmapFlows([
      flowTile({
        lines: [[10, 45, 11, 46]],
        numericProps: { flow: new Float32Array([5]) },
      }),
    ]);
    for (const t of [0, TIME_OFFSET, TIME_OFFSET + 1e9]) {
      expect(flowStrokeSubStep(0)).toBe(0);
      expect(flowmapBlendAt(build, t)).toEqual({ b0: 0, b1: 0, f: 0 });
    }
  });
});

describe('arrowWidthMeters', () => {
  it('converts the shared pixel-width curve to world metres', () => {
    // strokeWidthFromPeak(4) with the default sqrt exponent = 2 px.
    expect(arrowWidthMeters(4)).toBe(2 * DEFAULT_METERS_PER_PIXEL);
    expect(arrowWidthMeters(4, { metersPerPixel: 10 })).toBe(20);
  });

  it('returns EXACTLY 0 at or below minFlow — the floor must not resurrect it', () => {
    expect(arrowWidthMeters(0.5, { minFlow: 1, minWidthPx: 4 })).toBe(0);
    expect(arrowWidthMeters(0)).toBe(0);
    expect(arrowWidthMeters(-3)).toBe(0);
  });
});

describe('buildArrowRibbon — the shape that `line` was throwing away', () => {
  const OPTS = { shaftSegments: 4, tailWidthRatio: 0.25, headWidthRatio: 3 };

  it('emits shaft quads plus ONE head triangle', () => {
    const r = buildArrowRibbon(odFlow(10, 45, 10.2, 45), 100, OPTS)!;
    expect(r).not.toBeNull();
    // 2 rails × (segs + 1) shaft rungs, + 2 head-base corners + 1 apex.
    expect(r.positions.length / 3).toBe(2 * (4 + 1) + 3);
    // 2 triangles per quad + 1 head triangle.
    expect(r.indices.length).toBe(4 * 6 + 3);
    expect(Math.max(...r.indices)).toBe(r.positions.length / 3 - 1);
  });

  it('places every vertex on the WGS84 ellipsoid in absolute ECEF metres', () => {
    const r = buildArrowRibbon(odFlow(10, 45, 10.2, 45), 100, OPTS)!;
    for (let i = 0; i < r.positions.length / 3; i++) {
      const [x, y, z] = vertexAt(r.positions, i);
      const radius = Math.hypot(x, y, z);
      expect(radius).toBeGreaterThan(6_350_000);
      expect(radius).toBeLessThan(6_390_000);
    }
  });

  it('is exactly `widthMeters` wide at the head base — the LOCAL ENU frame, at latitude', () => {
    // Latitude 60 is where a degree-space perpendicular (or an identity
    // rotation, which points at the ECEF pole) diverges hardest from the truth:
    // a degree of longitude is half a degree of latitude there.
    const r = buildArrowRibbon(odFlow(10, 60, 10.4, 60), 200, OPTS)!;
    // The last shaft rung is the full-width one: rails 2*segs and 2*segs+1.
    expect(dist3(r.positions, 8, 9)).toBeCloseTo(200, 0);
  });

  it('tapers: the tail rung is narrower than the head-base rung', () => {
    const r = buildArrowRibbon(odFlow(10, 45, 10.4, 45), 200, OPTS)!;
    const tail = dist3(r.positions, 0, 1);
    const headBase = dist3(r.positions, 8, 9);
    expect(tail).toBeCloseTo(200 * 0.25, 0);
    expect(tail).toBeLessThan(headBase);
  });

  it('gives the head a base WIDER than the shaft and an apex ON the destination', () => {
    const r = buildArrowRibbon(odFlow(10, 45, 10.4, 45), 200, OPTS)!;
    const shaft = dist3(r.positions, 8, 9);
    const headBase = dist3(r.positions, 10, 11);
    // ±0.2 %: the head base spans 600 m, and the ENU→lon/lat hop uses a mean
    // metres-per-degree, so the ECEF chord runs a metre short of the arc.
    expect(headBase).toBeGreaterThan(595);
    expect(headBase).toBeLessThan(605);
    expect(headBase).toBeGreaterThan(shaft);
    const apex = vertexAt(r.positions, 12);
    const target = GLOBE.project(10.4, 45, 0);
    expect(
      Math.hypot(apex[0] - target[0], apex[1] - target[1], apex[2] - target[2]),
    ).toBeLessThan(1);
  });

  it('caps the head so a SHORT flow is not all arrowhead', () => {
    // A 200 m-wide arrow wants a 600 m head base and a ~690 m head; the flow
    // itself is only ~800 m long, so maxHeadFraction has to bite.
    const short = odFlow(10, 45, 10.01, 45);
    const r = buildArrowRibbon(short, 200, { ...OPTS, maxHeadFraction: 0.4 })!;
    const origin = GLOBE.project(10, 45, 0);
    const apex = vertexAt(r.positions, 12);
    const headBaseMid = vertexAt(r.positions, 8);
    const total = Math.hypot(
      apex[0] - origin[0],
      apex[1] - origin[1],
      apex[2] - origin[2],
    );
    const shaftEnd = Math.hypot(
      headBaseMid[0] - origin[0],
      headBaseMid[1] - origin[1],
      headBaseMid[2] - origin[2],
    );
    expect(shaftEnd / total).toBeGreaterThan(0.5); // ≥ 60 % of the flow is still shaft
  });

  it('flips the twin: reversing origin/destination lands on the OTHER side', () => {
    const gap = 300;
    const fwd = buildArrowRibbon(odFlow(10, 45, 10.4, 45), 100, OPTS, gap)!;
    const rev = buildArrowRibbon(odFlow(10.4, 45, 10, 45), 100, OPTS, gap)!;
    // Both mid-shafts sit `gap` off the shared centreline, in OPPOSITE
    // directions — no pairing logic, just a sign flip in the tangent.
    const centre = GLOBE.project(10.2, 45, 0);
    const fwdMid = vertexAt(fwd.positions, 4); // rail A of the middle rung
    const revMid = vertexAt(rev.positions, 4);
    const sep = Math.hypot(
      fwdMid[0] - revMid[0],
      fwdMid[1] - revMid[1],
      fwdMid[2] - revMid[2],
    );
    expect(sep).toBeGreaterThan(gap); // they are apart, not on top of each other
    // and each is genuinely off the centreline
    expect(
      Math.hypot(
        fwdMid[0] - centre[0],
        fwdMid[1] - centre[1],
        fwdMid[2] - centre[2],
      ),
    ).toBeGreaterThan(gap * 0.5);
  });

  it('returns null rather than a degenerate sliver', () => {
    expect(buildArrowRibbon(odFlow(10, 45, 10.4, 45), 0, OPTS)).toBeNull();
    expect(buildArrowRibbon(odFlow(10, 45, 10.4, 45), -5, OPTS)).toBeNull();
    // A self-loop has no tangent to be perpendicular to.
    expect(buildArrowRibbon(odFlow(10, 45, 10, 45), 100, OPTS)).toBeNull();
  });
});

describe('flowmapColorAt', () => {
  const FLOW = odFlow(0, 0, 1, 0, [2, 8]);

  it('keeps the RGB and scales only the alpha with the magnitude share', () => {
    const quiet = flowmapColorAt(FLOW, 0, { minMagnitudeAlpha: 0.5 });
    const busy = flowmapColorAt(FLOW, 8, { minMagnitudeAlpha: 0.5 });
    expect([quiet[0], quiet[1], quiet[2]]).toEqual([10, 20, 30]);
    expect(quiet[3]).toBe(Math.round(200 * 0.5));
    expect(busy[3]).toBe(200);
  });

  it('floors a quiet-but-present arrow instead of half-vanishing it', () => {
    const c = flowmapColorAt(FLOW, 0.0001);
    expect(c[3]).toBeCloseTo(200 * DEFAULT_MIN_MAGNITUDE_ALPHA, 0);
  });

  it('clamps above the reference magnitude', () => {
    expect(flowmapColorAt(FLOW, 1e6)[3]).toBe(200);
  });
});
