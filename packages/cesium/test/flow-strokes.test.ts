// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `lib/flow-strokes.ts` — the pure, Cesium-free builder shared by the
 * `flowCorridor` and `flowStroke` kinds.
 *
 * It had no test. That is worth fixing on its own terms, but three of its
 * properties are load-bearing for BOTH kinds and are the kind of thing that
 * silently degrades into something plausible-looking:
 *
 *  - **`max` AFTER `blend`, never `blend` after `max`.** The cheap form
 *    (per-corridor per-column maxima, blended) is a strict upper bound, and it
 *    differs from the true value exactly when the argmax vertex migrates
 *    between adjacent columns. That is the discriminating fixture below, and
 *    both a width and a colour read the number.
 *  - **The ENU perpendicular.** A degree-space rotation looks right at the
 *    equator and skews every ribbon at latitude by the graticule aspect ratio.
 *    Pinned with a negative control against the degree-space answer.
 *  - **`minFlow` BYPASSES the `minWidthPx` floor.** "Inactive => invisible" is
 *    the whole pulse; a floor that resurrects a quiet corridor at 1 px turns
 *    the animation into a static road atlas with a flicker.
 *
 * Everything here runs in plain Node: the module imports no Cesium.
 */

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import {
  DEFAULT_OFFSET_WIDTHS,
  DEFAULT_WIDTH_EXPONENT,
  FLOW_STROKE_SUB_STEP,
  M_PER_DEG_LAT,
  axisFor,
  bucketBlendAt,
  bucketPositionAt,
  buildFlowStrokes,
  corridorPeakAt,
  enuPerpendicularShift,
  flowStrokeSubStep,
  steppedBucketPos,
  strokeWidthFromPeak,
  type FlowStrokeCorridor,
} from '../src/lib/flow-strokes';

// Byte-identical to the builder's own GLOBE: the datum is the point. The class
// default is 'sphere', which mis-registers by up to ~20 km at mid-latitudes.
const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});

const TIME_OFFSET = 1_700_000_000_000;

interface FlowTileSpec {
  /** One entry per corridor: flat `[lon, lat, lon, lat, ...]`. */
  lines: number[][];
  /** One row per GLOBAL vertex, `numBuckets` wide. */
  matrix: number[][];
  numBuckets: number;
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

  const flat = new Float32Array(total * spec.numBuckets);
  for (let v = 0; v < spec.matrix.length; v++) {
    for (let b = 0; b < spec.numBuckets; b++) {
      flat[v * spec.numBuckets + b] = spec.matrix[v][b];
    }
  }

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
    vertexValueMatrix: flat,
    vertexValueBuckets: spec.numBuckets,
  };

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

/** A bare corridor for the reduction unit tests — only the rows matter. */
function rowsCorridor(
  rows: number[][],
  numBuckets: number,
): FlowStrokeCorridor {
  const values = new Float32Array(rows.length * numBuckets);
  for (let v = 0; v < rows.length; v++) {
    for (let b = 0; b < numBuckets; b++)
      values[v * numBuckets + b] = rows[v][b];
  }
  return { values, vertexCount: rows.length } as FlowStrokeCorridor;
}

describe('axisFor', () => {
  it('derives the global bucket axis from feature 0', () => {
    const b = flowTile({
      lines: [[0, 0, 1, 0]],
      matrix: [
        [1, 2],
        [3, 4],
      ],
      numBuckets: 2,
      startTimes: [100],
      endTimes: [1100],
    }).layers[0].features;
    expect(axisFor(b)).toEqual({
      numBuckets: 2,
      bucket0Abs: TIME_OFFSET + 100,
      bucketWidth: 500,
    });
  });

  it('returns null for a degenerate or bucket-less layer', () => {
    const b = flowTile({
      lines: [[0, 0, 1, 0]],
      matrix: [
        [1, 1],
        [1, 1],
      ],
      numBuckets: 2,
      startTimes: [500],
      endTimes: [500], // zero span
    }).layers[0].features;
    expect(axisFor(b)).toBeNull();
    expect(axisFor({ ...b, vertexValueBuckets: 0 })).toBeNull();
    expect(axisFor({ ...b, startTimes: undefined })).toBeNull();
  });
});

describe('bucketPositionAt / bucketBlendAt', () => {
  const axis = { numBuckets: 4, bucket0Abs: TIME_OFFSET, bucketWidth: 500 };

  it('samples bucket b at its LEADING edge', () => {
    expect(bucketPositionAt(axis, TIME_OFFSET)).toBe(0);
    expect(bucketPositionAt(axis, TIME_OFFSET + 500)).toBe(1);
    expect(bucketPositionAt(axis, TIME_OFFSET + 750)).toBe(1.5);
  });

  it('returns 0 — never NaN — for a null or degenerate axis', () => {
    // NaN here would index the matrix wildly rather than fail loudly.
    expect(bucketPositionAt(null, TIME_OFFSET)).toBe(0);
    expect(bucketPositionAt({ ...axis, bucketWidth: 0 }, TIME_OFFSET)).toBe(0);
    expect(bucketPositionAt(axis, Number.NaN)).toBe(0);
  });

  it('clamps to [0, numBuckets - 1] and degenerates at the last column', () => {
    expect(bucketBlendAt(-7, 4)).toEqual({ b0: 0, b1: 1, f: 0 });
    expect(bucketBlendAt(Number.NaN, 4)).toEqual({ b0: 0, b1: 1, f: 0 });
    expect(bucketBlendAt(1.25, 4)).toEqual({ b0: 1, b1: 2, f: 0.25 });
    // Past the end: b1 === b0, so the blend is a plain read of the last column.
    expect(bucketBlendAt(99, 4)).toEqual({ b0: 3, b1: 3, f: 0 });
    expect(bucketBlendAt(0, 0)).toEqual({ b0: 0, b1: 0, f: 0 });
  });
});

describe('corridorPeakAt', () => {
  it('takes the max OF the blend, not the blend of the column maxima', () => {
    // The argmax vertex MIGRATES between the two columns: vertex 0 owns column
    // 0, vertex 1 owns column 1. Halfway, every vertex sits at 5 — but the
    // per-column maxima are 10 and 10, so the cheap form would say 10.
    const c = rowsCorridor(
      [
        [10, 0],
        [0, 10],
      ],
      2,
    );
    const blend = bucketBlendAt(0.5, 2);
    expect(corridorPeakAt(c, 2, blend)).toBe(5);

    const columnMaxBlend = 0.5 * 10 + 0.5 * 10; // the upper bound this rejects
    expect(columnMaxBlend).toBe(10);
    expect(corridorPeakAt(c, 2, blend)).not.toBe(columnMaxBlend);
  });

  it('reads a single column when f <= 0', () => {
    const c = rowsCorridor(
      [
        [10, 0],
        [0, 10],
      ],
      2,
    );
    expect(corridorPeakAt(c, 2, { b0: 0, b1: 1, f: 0 })).toBe(10);
    expect(corridorPeakAt(c, 2, { b0: 1, b1: 1, f: 0 })).toBe(10);
  });

  it('peaks at 0 for an empty corridor or a wholly non-positive row', () => {
    expect(corridorPeakAt(rowsCorridor([], 2), 2, bucketBlendAt(0.5, 2))).toBe(
      0,
    );
    expect(
      corridorPeakAt(
        rowsCorridor(
          [
            [-3, -4],
            [-1, -2],
          ],
          2,
        ),
        2,
        bucketBlendAt(0.5, 2),
      ),
    ).toBe(0);
    expect(
      corridorPeakAt(rowsCorridor([[1, 1]], 0), 0, bucketBlendAt(0, 0)),
    ).toBe(0);
  });
});

describe('strokeWidthFromPeak', () => {
  it('defaults to sqrt — area-proportional', () => {
    expect(DEFAULT_WIDTH_EXPONENT).toBe(0.5);
    expect(strokeWidthFromPeak(16)).toBe(4);
    expect(strokeWidthFromPeak(16, { widthScale: 2 })).toBe(8);
    expect(strokeWidthFromPeak(16, { widthExponent: 1 })).toBe(16);
  });

  it('collapses at or below minFlow, BYPASSING the minWidthPx floor', () => {
    // The pulse: a floor must never resurrect a QUIET corridor at 1 px. At or
    // below minFlow the corridor is off, and off means zero width — the floor
    // does not get a vote.
    expect(strokeWidthFromPeak(4, { minFlow: 4, minWidthPx: 3 })).toBe(0);
    expect(strokeWidthFromPeak(3.9, { minFlow: 4, minWidthPx: 3 })).toBe(0);
  });

  it('APPLIES the minWidthPx floor once the corridor is above minFlow', () => {
    // The other side of the same rule, and the reason the case above is about
    // "at or below" specifically. 4.41 is ACTIVE (> minFlow 4); its natural
    // width is sqrt(4.41) = 2.1, which is thinner than the 3 px floor, and a
    // floor exists precisely so an active-but-thin corridor stays visible.
    // Bypassing it here would make `minWidthPx` mean nothing at all.
    expect(strokeWidthFromPeak(4.41, { minFlow: 4 })).toBeCloseTo(2.1, 10);
    expect(strokeWidthFromPeak(4.41, { minFlow: 4, minWidthPx: 3 })).toBe(3);
  });

  it('collapses a non-positive peak, keeping Math.pow off its NaN branch', () => {
    expect(strokeWidthFromPeak(0)).toBe(0);
    expect(strokeWidthFromPeak(-9)).toBe(0);
    expect(strokeWidthFromPeak(Number.NaN)).toBe(0);
  });

  it('applies the pixel clamps after the scale', () => {
    expect(strokeWidthFromPeak(100, { maxWidthPx: 5 })).toBe(5);
    expect(strokeWidthFromPeak(1, { minWidthPx: 4 })).toBe(4);
  });
});

describe('flowStrokeSubStep / steppedBucketPos', () => {
  it('quantizes a continuous bucket position and round-trips it', () => {
    expect(FLOW_STROKE_SUB_STEP).toBe(0.5);
    expect(flowStrokeSubStep(0)).toBe(0);
    expect(flowStrokeSubStep(0.24)).toBe(0);
    expect(flowStrokeSubStep(0.26)).toBe(1);
    expect(steppedBucketPos(flowStrokeSubStep(1.4))).toBe(1.5);
    expect(steppedBucketPos(3, 0.25)).toBe(0.75);
  });

  it('degenerates to a single step for a non-positive step', () => {
    expect(flowStrokeSubStep(7, 0)).toBe(0);
    expect(flowStrokeSubStep(7, -1)).toBe(0);
  });
});

describe('enuPerpendicularShift', () => {
  it('shifts LEFT of the direction of travel', () => {
    // Travelling east at the equator: left is north.
    const out = enuPerpendicularShift(0, 0, 1, 0, M_PER_DEG_LAT);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(1, 12);
  });

  it('rotates in the ENU frame, not in degree space', () => {
    // Travelling NORTH at lat 60: left is west, and the westward metre delta
    // buys 1/cos(60) = 2x the longitude a degree-space rotation would give.
    const lat = 60;
    const meters = M_PER_DEG_LAT;
    const out = enuPerpendicularShift(10, lat, 0, 1, meters);
    const cos = Math.cos((lat * Math.PI) / 180);
    expect(out[0]).toBeCloseTo(10 - 1 / cos, 9);
    expect(out[1]).toBeCloseTo(lat, 12);
    // Negative control: the degree-space answer (no cos correction) is a
    // different place, and the gap grows with latitude.
    expect(out[0]).not.toBeCloseTo(10 - 1, 3);
  });

  it('puts A->B and B->A on OPPOSITE sides — the twin ribbon, with no pairing', () => {
    const fwd = enuPerpendicularShift(0, 0, 1, 0, 500);
    const rev = enuPerpendicularShift(0, 0, -1, 0, 500);
    expect(fwd[1]).toBeGreaterThan(0);
    expect(rev[1]).toBeLessThan(0);
    expect(fwd[1]).toBeCloseTo(-rev[1], 12);
  });

  it('leaves the vertex untouched for a zero offset or a degenerate tangent', () => {
    expect(enuPerpendicularShift(5, 6, 1, 1, 0)).toEqual([5, 6]);
    expect(enuPerpendicularShift(5, 6, 1, 1, Number.NaN)).toEqual([5, 6]);
    expect(enuPerpendicularShift(5, 6, 0, 0, 500)).toEqual([5, 6]);
  });

  it('stays finite at the pole', () => {
    const out = enuPerpendicularShift(0, 90, 0, 1, 500);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(Number.isFinite(out[1])).toBe(true);
  });

  it('writes into the caller-supplied out array (allocation-free hot path)', () => {
    const out: [number, number] = [0, 0];
    expect(enuPerpendicularShift(0, 0, 1, 0, M_PER_DEG_LAT, out)).toBe(out);
    expect(out[1]).toBeCloseTo(1, 12);
  });
});

describe('buildFlowStrokes', () => {
  const spec: FlowTileSpec = {
    lines: [
      [0, 0, 0.01, 0, 0.02, 0],
      [4, 51, 4.01, 51],
    ],
    matrix: [
      [10, 0],
      [4, 4],
      [0, 10],
      [1, 2],
      [3, 4],
    ],
    numBuckets: 2,
  };

  it('returns an empty build — not a throw — when no tile carries a matrix', () => {
    expect(buildFlowStrokes([])).toEqual({
      corridors: [],
      timeOrigin: 0,
      axis: null,
      numBuckets: 0,
    });
    const plain = flowTile(spec);
    plain.layers[0].features.vertexValueMatrix = undefined;
    expect(buildFlowStrokes([plain]).corridors).toHaveLength(0);
  });

  it('copies each corridor’s own vertex rows and its all-bucket refPeak', () => {
    const build = buildFlowStrokes([flowTile(spec)], { offsetWidths: 0 });
    expect(build.numBuckets).toBe(2);
    expect(build.timeOrigin).toBe(TIME_OFFSET);
    expect(build.axis).toEqual({
      numBuckets: 2,
      bucket0Abs: TIME_OFFSET,
      bucketWidth: 500,
    });
    expect(build.corridors).toHaveLength(2);
    expect(Array.from(build.corridors[0].values)).toEqual([10, 0, 4, 4, 0, 10]);
    expect(build.corridors[0].vertexCount).toBe(3);
    expect(build.corridors[0].refPeak).toBe(10);
    // The second corridor's rows start at ITS first global vertex, not at 0.
    expect(Array.from(build.corridors[1].values)).toEqual([1, 2, 3, 4]);
    expect(build.corridors[1].refPeak).toBe(4);
  });

  it('projects to absolute WGS84 ECEF metres with no offset when offsetWidths is 0', () => {
    const build = buildFlowStrokes([flowTile(spec)], { offsetWidths: 0 });
    const c = build.corridors[0];
    expect(c.offsetMeters).toBe(0);
    for (let v = 0; v < c.vertexCount; v++) {
      const [x, y, z] = GLOBE.project(v * 0.01, 0, 0);
      expect(c.positions[v * 3]).toBeCloseTo(x, 6);
      expect(c.positions[v * 3 + 1]).toBeCloseTo(y, 6);
      expect(c.positions[v * 3 + 2]).toBeCloseTo(z, 6);
    }
    // Absolute metres, not RTC: an ECEF point on the equator sits ~6.378e6 out.
    expect(
      Math.hypot(c.positions[0], c.positions[1], c.positions[2]),
    ).toBeGreaterThan(6_000_000);
  });

  it('bakes the offset from the ALL-BUCKET peak, so the ribbons hold a constant gap', () => {
    const build = buildFlowStrokes([flowTile(spec)], {
      offsetMetersPerPixel: 2,
    });
    const c = build.corridors[0];
    // refPeak 10 -> sqrt -> refWidth; offset = offsetWidths x refWidth x m/px.
    expect(c.refWidth).toBeCloseTo(Math.sqrt(10), 12);
    expect(c.offsetMeters).toBeCloseTo(
      DEFAULT_OFFSET_WIDTHS * Math.sqrt(10) * 2,
      12,
    );
    // Eastbound at the equator => the whole ribbon shifts NORTH of centre.
    const centre = GLOBE.project(0, 0, 0);
    expect(c.positions[2]).toBeGreaterThan(centre[2]);
    // The pick coordinate is the UN-offset first vertex.
    expect([c.lon, c.lat]).toEqual([0, 0]);
  });

  it('lifts the whole network by zLift', () => {
    const flat = buildFlowStrokes([flowTile(spec)], { offsetWidths: 0 });
    const lifted = buildFlowStrokes([flowTile(spec)], {
      offsetWidths: 0,
      zLift: 1000,
    });
    const r0 = Math.hypot(
      flat.corridors[0].positions[0],
      flat.corridors[0].positions[1],
      flat.corridors[0].positions[2],
    );
    const r1 = Math.hypot(
      lifted.corridors[0].positions[0],
      lifted.corridors[0].positions[1],
      lifted.corridors[0].positions[2],
    );
    expect(r1 - r0).toBeCloseTo(1000, 3);
  });

  it('skips single-vertex features — a stroke needs a tangent', () => {
    const build = buildFlowStrokes([
      flowTile({
        lines: [
          [0, 0],
          [1, 1, 1.01, 1],
        ],
        matrix: [
          [5, 5],
          [1, 1],
          [2, 2],
        ],
        numBuckets: 2,
      }),
    ]);
    expect(build.corridors).toHaveLength(1);
    expect(build.corridors[0].featureIndex).toBe(1);
    expect(build.corridors[0].refPeak).toBe(2);
  });

  it('rebases every tile’s times onto the FIRST accepted layer’s origin', () => {
    const a = flowTile({
      ...spec,
      timeOffset: TIME_OFFSET,
      startTimes: [10, 10],
    });
    const b = flowTile({
      ...spec,
      timeOffset: TIME_OFFSET + 4000,
      startTimes: [10, 10],
    });
    const build = buildFlowStrokes([a, b], { offsetWidths: 0 });
    expect(build.timeOrigin).toBe(TIME_OFFSET);
    expect(build.corridors[0].start).toBeCloseTo(10, 6);
    expect(build.corridors[2].start).toBeCloseTo(4010, 6);
  });

  it('refuses a layer whose bucket count disagrees with the first', () => {
    // A dataset bakes ONE global axis; a disagreeing layer would index the
    // matrix with the wrong stride.
    const a = flowTile(spec);
    const b = flowTile({
      lines: [[9, 9, 9.01, 9]],
      matrix: [
        [1, 1, 1],
        [1, 1, 1],
      ],
      numBuckets: 3,
    });
    const build = buildFlowStrokes([a, b], { offsetWidths: 0 });
    expect(build.numBuckets).toBe(2);
    expect(build.corridors).toHaveLength(2);
  });

  it('colours through the shared featureColor trichotomy', () => {
    const tile = flowTile({
      ...spec,
      numericProps: { volume: new Float32Array([0, 100]) },
    });
    expect(
      buildFlowStrokes([tile], {
        offsetWidths: 0,
        color: { type: 'constant', color: [1, 2, 3, 4] },
      }).corridors[0].color,
    ).toEqual([1, 2, 3, 4]);

    const ramped = buildFlowStrokes([tile], {
      offsetWidths: 0,
      color: {
        type: 'ramp',
        property: 'volume',
        domain: [0, 100],
        range: [
          [0, 0, 0, 255],
          [255, 255, 255, 255],
        ],
        fallback: [7, 7, 7, 255],
      },
    }).corridors;
    expect(ramped[0].color).toEqual([0, 0, 0, 255]);
    expect(ramped[1].color).toEqual([255, 255, 255, 255]);

    // A missing property falls back rather than throwing.
    expect(
      buildFlowStrokes([tile], {
        offsetWidths: 0,
        color: {
          type: 'ramp',
          property: 'nope',
          domain: [0, 1],
          range: [[0, 0, 0, 255]],
          fallback: [7, 7, 7, 255],
        },
      }).corridors[0].color,
    ).toEqual([7, 7, 7, 255]);
  });

  it('carries {binary, featureIndex} provenance for picking', () => {
    const tile = flowTile(spec);
    const build = buildFlowStrokes([tile], { offsetWidths: 0 });
    expect(build.corridors[1].binary).toBe(tile.layers[0].features);
    expect(build.corridors[1].featureIndex).toBe(1);
    expect([build.corridors[1].lon, build.corridors[1].lat]).toEqual([4, 51]);
  });
});
