// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * ALONG-TRACK gradient gate (deck `gradientProperty: 'vertexValues'`).
 *
 * `vertexValues` is a top-level `BinaryFeatures` channel — one scalar per PATH
 * VERTEX (drifter SST, storm temperature) — not a `numericProps` column. A ramp
 * that looked it up by name found nothing and fell through to its fallback, so
 * every track in the archive drew one flat colour: the ocean-drifters demo
 * rendered pale monochrome lines instead of the blue→red SST ribbon deck shows.
 *
 * These tests pin the per-vertex resolution end to end for both builders that
 * feed the wide-line material: each segment's endpoints (`colorA`/`colorB`) take
 * their OWN vertex's ramp colour, so the shader's A→B interpolation shades the
 * line along its length.
 */

import { describe, it, expect } from 'vitest';
import { buildTripsBuffers } from '../src/lib/trips-buffers';
import { buildLineSegmentBuffers } from '../src/lib/geo-line-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { makeLineTile } from './_support/features';
import type { RGBA } from '../src/lib/color';

const proj = new LocalEnuProjection({ longitude: 0, latitude: 0 });

/** The drifters SST stops — deliberately MID-TONE, so a colour-space slip would
 *  move them (pure 0/255 stops sit on the transfer function's fixed points). */
const RAMP: RGBA[] = [
  [44, 90, 200, 235], // 0 °C  — deep blue
  [250, 210, 90, 235], // 15 °C — yellow
  [220, 50, 47, 235], // 30 °C — red
];
const GREY: RGBA = [130, 130, 130, 170];
const DOMAIN: [number, number] = [0, 30];

/** A single 4-vertex track carrying a per-vertex SST channel. */
function trackTile(vertexValues: Float32Array) {
  return makeLineTile({
    featureCount: 1,
    positionDimensions: 2,
    positions: new Float64Array([0, 0, 0.01, 0, 0.02, 0, 0.03, 0]),
    startIndices: new Uint32Array([0, 4]),
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([1000]),
    vertexValues,
  });
}

/**
 * The 0–255 RGB a colour-buffer slot holds. These buffers stay in **sRGB** —
 * unlike the CPU-decoded summary meshes, the wide-line material decodes in the
 * shader (`srgbToWorking`), which is also what keeps the A→B interpolation in
 * the same space deck interpolates in. So the authored byte is read straight
 * back with no transfer function.
 */
function authored(buf: Float32Array, i: number): [number, number, number] {
  return [
    Math.round(buf[i * 4] * 255),
    Math.round(buf[i * 4 + 1] * 255),
    Math.round(buf[i * 4 + 2] * 255),
  ];
}

const rampMode = {
  type: 'ramp' as const,
  property: 'vertexValues',
  domain: DOMAIN,
  range: RAMP,
  fallback: GREY,
};

describe('buildTripsBuffers — per-vertex ramp shades a track along its length', () => {
  it('gives each segment endpoint its own vertex colour', () => {
    // 0 °C → blue, 15 °C → green, 30 °C → red, and 15 again.
    const buf = buildTripsBuffers(
      [trackTile(new Float32Array([0, 15, 30, 15]))],
      proj,
      0,
      {
        colorMode: rampMode,
      },
    );
    expect(buf.count).toBe(3); // 4 vertices → 3 segments

    // Segment 0 runs blue → green, segment 1 green → red, segment 2 red → green.
    expect(authored(buf.colorA, 0)).toEqual(RAMP[0].slice(0, 3));
    expect(authored(buf.colorB, 0)).toEqual(RAMP[1].slice(0, 3));
    expect(authored(buf.colorA, 1)).toEqual(RAMP[1].slice(0, 3));
    expect(authored(buf.colorB, 1)).toEqual(RAMP[2].slice(0, 3));
    expect(authored(buf.colorA, 2)).toEqual(RAMP[2].slice(0, 3));
    expect(authored(buf.colorB, 2)).toEqual(RAMP[1].slice(0, 3));
  });

  it('is NOT flat — the regression was every segment sharing one colour', () => {
    const buf = buildTripsBuffers(
      [trackTile(new Float32Array([0, 10, 20, 30]))],
      proj,
      0,
      {
        colorMode: rampMode,
      },
    );
    const distinct = new Set(
      Array.from({ length: buf.count }, (_, s) =>
        authored(buf.colorA, s).join(),
      ),
    );
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('a vertex with no reading (NaN) takes the fallback, not the ramp floor', () => {
    const buf = buildTripsBuffers(
      [trackTile(new Float32Array([0, NaN, 30, 30]))],
      proj,
      0,
      { colorMode: rampMode },
    );
    expect(authored(buf.colorB, 0)).toEqual([GREY[0], GREY[1], GREY[2]]);
    // …and the NaN does not poison its neighbours.
    expect(authored(buf.colorA, 0)).toEqual(RAMP[0].slice(0, 3));
    expect(authored(buf.colorB, 1)).toEqual(RAMP[2].slice(0, 3));
  });

  it('falls back to the flat per-feature colour when the tile has no channel', () => {
    const bare = makeLineTile({
      featureCount: 1,
      positions: new Float64Array([0, 0, 0.01, 0, 0.02, 0]),
      startIndices: new Uint32Array([0, 3]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1000]),
    });
    const buf = buildTripsBuffers([bare], proj, 0, { colorMode: rampMode });
    expect(buf.count).toBe(2);
    for (let s = 0; s < buf.count; s++) {
      expect(authored(buf.colorA, s)).toEqual([GREY[0], GREY[1], GREY[2]]);
      expect(authored(buf.colorB, s)).toEqual([GREY[0], GREY[1], GREY[2]]);
    }
  });

  it('a per-FEATURE ramp column still resolves once per feature', () => {
    const tile = makeLineTile({
      featureCount: 1,
      positions: new Float64Array([0, 0, 0.01, 0, 0.02, 0]),
      startIndices: new Uint32Array([0, 3]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1000]),
      numericProps: { temp: new Float32Array([30]) },
    });
    const buf = buildTripsBuffers([tile], proj, 0, {
      colorMode: { ...rampMode, property: 'temp' },
    });
    for (let s = 0; s < buf.count; s++) {
      expect(authored(buf.colorA, s)).toEqual(RAMP[2].slice(0, 3));
      expect(authored(buf.colorB, s)).toEqual(RAMP[2].slice(0, 3));
    }
  });
});

describe('buildLineSegmentBuffers — same per-vertex ramp for static paths', () => {
  it('gives each segment endpoint its own vertex colour', () => {
    const buf = buildLineSegmentBuffers(
      [trackTile(new Float32Array([0, 15, 30, 30]))],
      proj,
      0,
      { colorMode: rampMode },
    );
    expect(buf.count).toBe(3);
    expect(authored(buf.colorA, 0)).toEqual(RAMP[0].slice(0, 3));
    expect(authored(buf.colorB, 0)).toEqual(RAMP[1].slice(0, 3));
    expect(authored(buf.colorB, 1)).toEqual(RAMP[2].slice(0, 3));
  });
});
