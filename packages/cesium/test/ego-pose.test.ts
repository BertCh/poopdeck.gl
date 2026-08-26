// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * The pure ego-pose kernel: build a single track from the pose stream, then
 * sample ONE interpolated pose at the play head.
 *
 * The two things that make this a kind rather than a point layer with one
 * feature are both asserted here:
 *   - exactly ONE pose comes back regardless of how many keyframes are
 *     resident (a per-keyframe layer would leave a trail of markers behind the
 *     vehicle — the bug the deck bounding-box layer was rewritten to kill), and
 *   - heading interpolates SHORTEST-ARC, so 350° → 10° crosses 0 rather than
 *     sweeping backwards through 180°.
 */

import { describe, it, expect } from 'vitest';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  buildEgoTrack,
  sampleEgoPose,
  lerpAngle,
  wrapAngle,
  normalizeHeading,
} from '../src/lib/ego-pose';

const TIME_OFFSET = 1_700_000_000_000;
const DEG = Math.PI / 180;

/** A Point tile of ego poses: one feature per timestamp. */
function egoTile(
  times: number[],
  headingsDeg: number[],
  timeOffset = TIME_OFFSET,
): Tile {
  const n = times.length;
  const positions = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = -122.4 + i * 0.01;
    positions[i * 2 + 1] = 37.78;
  }
  const features: BinaryFeatures = {
    featureCount: n,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(n),
    startTimes: new Float32Array(times),
    endTimes: new Float32Array(times),
    timeOffset,
    numericProps: {
      heading: new Float32Array(headingsDeg.map((d) => d * DEG)),
      length: new Float32Array(new Array(n).fill(4.5)),
      width: new Float32Array(new Array(n).fill(2)),
      height: new Float32Array(new Array(n).fill(1.5)),
    },
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 10_000 },
    layers: [
      {
        name: 'ego',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

describe('angle helpers', () => {
  it('wraps into (−π, π]', () => {
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapAngle(0)).toBe(0);
  });

  it('lerpAngle takes the SHORT way across the 350°→10° seam', () => {
    const a = 350 * DEG;
    const b = 10 * DEG;
    // Midpoint must be 0°, not 180°.
    expect(wrapAngle(lerpAngle(a, b, 0.5))).toBeCloseTo(0, 6);
    // And it must be monotone across the seam.
    expect(wrapAngle(lerpAngle(a, b, 0.25)) / DEG).toBeCloseTo(-5, 4);
    expect(wrapAngle(lerpAngle(a, b, 0.75)) / DEG).toBeCloseTo(5, 4);
  });

  it('lerpAngle returns the endpoints exactly', () => {
    const a = 1.1;
    const b = -2.2;
    expect(wrapAngle(lerpAngle(a, b, 0))).toBeCloseTo(wrapAngle(a), 9);
    expect(wrapAngle(lerpAngle(a, b, 1))).toBeCloseTo(wrapAngle(b), 9);
  });

  it('normalizeHeading is a no-op on an already-ENU radian heading', () => {
    expect(normalizeHeading(0.5, 'radians', 'enu')).toBeCloseTo(0.5, 9);
  });
});

describe('buildEgoTrack + sampleEgoPose — ONE pose, never a trail', () => {
  it('collapses a 5-keyframe track to a SINGLE pose at any play head', () => {
    const track = buildEgoTrack([
      egoTile([0, 1000, 2000, 3000, 4000], [0, 0, 0, 0, 0]),
    ]);
    expect(track.keyframes).toHaveLength(5);
    for (const t of [0, 250, 1500, 3999, 4000]) {
      const pose = sampleEgoPose(track, t);
      expect(pose, `t=${t}`).not.toBeNull();
      // `sampleEgoPose` returns a single object, not a list — the type itself
      // is the guarantee, and this is the case that would catch a regression to
      // "emit every active keyframe".
      expect(Array.isArray(pose)).toBe(false);
    }
  });

  it('interpolates POSITION between the bracketing keyframes', () => {
    const track = buildEgoTrack([egoTile([0, 1000], [0, 0])]);
    const a = sampleEgoPose(track, 0)!;
    const b = sampleEgoPose(track, 1000)!;
    const mid = sampleEgoPose(track, 500)!;
    expect(mid.lon).toBeCloseTo((a.lon + b.lon) / 2, 9);
    expect(mid.lon).not.toBeCloseTo(a.lon, 6);
  });

  it('interpolates HEADING shortest-arc through the seam', () => {
    const track = buildEgoTrack([egoTile([0, 1000], [350, 10])]);
    const mid = sampleEgoPose(track, 500)!;
    expect(wrapAngle(mid.heading) / DEG).toBeCloseTo(0, 4);
  });

  it('CLAMPS outside the span instead of extrapolating', () => {
    const track = buildEgoTrack([egoTile([0, 1000], [0, 90])]);
    const before = sampleEgoPose(track, -5000)!;
    const after = sampleEgoPose(track, 99_000)!;
    const first = sampleEgoPose(track, 0)!;
    const last = sampleEgoPose(track, 1000)!;
    expect(before.lon).toBeCloseTo(first.lon, 9);
    expect(after.lon).toBeCloseTo(last.lon, 9);
    expect(before.t).toBe(first.t);
    expect(after.t).toBe(last.t);
  });

  it('handles a single-keyframe track deterministically', () => {
    const track = buildEgoTrack([egoTile([0], [0])]);
    const pose = sampleEgoPose(track, 12_345)!;
    expect(pose).not.toBeNull();
    expect(Number.isFinite(pose.heading)).toBe(true);
  });

  it('returns null for an empty track rather than a fabricated pose', () => {
    const empty = egoTile([0], [0]);
    empty.layers[0].features.featureCount = 0;
    const track = buildEgoTrack([empty]);
    expect(sampleEgoPose(track, 0)).toBeNull();
  });

  it('joins two tiles with different timeOffsets onto ONE rebased timeline', () => {
    const later = egoTile([0, 1000], [0, 0], TIME_OFFSET + 5_000);
    const track = buildEgoTrack([egoTile([0, 1000], [0, 0]), later]);
    expect(track.keyframes).toHaveLength(4);
    const ts = track.keyframes.map((k) => k.t);
    // Sorted, and the second tile's samples carry its offset delta.
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    expect(ts[ts.length - 1]).toBeCloseTo(6000, 6);
  });

  it('carries provenance so pick() can name the source feature', () => {
    const track = buildEgoTrack([egoTile([0, 1000], [0, 0])]);
    const pose = sampleEgoPose(track, 900)!;
    expect(pose.binary).toBeDefined();
    expect(pose.featureIndex).toBeGreaterThanOrEqual(0);
  });
});
