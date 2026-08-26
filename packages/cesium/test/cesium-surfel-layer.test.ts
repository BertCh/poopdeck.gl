// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTSurfelLayer` — the oriented anisotropic surfel kind.
 *
 * Two things are being proven here, and they are the two things that make this
 * a distinct KIND rather than a re-labelled point layer:
 *
 *  1. ORIENTATION AND ANISOTROPY are real. A surfel is an elliptical disk lying
 *     in its own surface frame with two DIFFERENT half-extents; if the frame or
 *     the extents were dropped the layer would be drawing round dots and the
 *     kind would be a lie. The frame cases below pin the quaternion → ECEF basis
 *     conversion directly.
 *  2. ALPHA comes from the shared `core/time-filter` oracle. This file is what
 *     `time-filter-oracle.test.ts`'s `PROVEN_IN_OWN_SUITE` map points at for
 *     this layer, and that map's companion case asserts this file really does
 *     assert against `timeFilterAlpha` — so weakening the sweep below breaks the
 *     package-level gate too, not just this file.
 */

import { describe, it, expect } from 'vitest';
import { Primitive, type Scene } from 'cesium';
import {
  GeometryType,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import { STTSurfelLayer } from '../src/cesium-surfel-layer';
import {
  buildSurfelEntries,
  quaternionToBasis,
  surfelFrame,
} from '../src/lib/surfels';

const TIME_OFFSET = 1_700_000_000_000;
const STARTS = [0, 120, 500, 999];
const ENDS = [40, 300, 900, 1200];

/** A Point tile carrying the LEGACY (separate-column) surfel layout. */
function surfelTile(
  count: number,
  overrides: Partial<Record<string, number[]>> = {},
  timeOffset = TIME_OFFSET,
): Tile {
  const num = (name: string, fill: number): Float32Array =>
    new Float32Array(overrides[name] ?? new Array(count).fill(fill));
  const positions = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    positions[i * 2] = -122.4 + i * 0.001;
    positions[i * 2 + 1] = 37.78;
  }
  const features: BinaryFeatures = {
    featureCount: count,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(count),
    startTimes: new Float32Array(STARTS.slice(0, count)),
    endTimes: new Float32Array(ENDS.slice(0, count)),
    timeOffset,
    numericProps: {
      // Identity rotation unless a case overrides it.
      qx: num('qx', 0),
      qy: num('qy', 0),
      qz: num('qz', 0),
      qw: num('qw', 1),
      // DIFFERENT half-extents on purpose — this is the anisotropy.
      s_major: num('s_major', 4),
      s_minor: num('s_minor', 1),
      r: num('r', 200),
      g: num('g', 100),
      b: num('b', 50),
      surfel_opacity: num('surfel_opacity', 1),
      z: num('z', 0),
    },
    categoricalProps: {},
    vectorProps: {},
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'surfels',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

function stubScene(): { scene: Scene; added: unknown[] } {
  const added: unknown[] = [];
  const scene = {
    primitives: {
      add<T>(p: T): T {
        added.push(p);
        return p;
      },
      remove(): boolean {
        return true;
      },
    },
  } as unknown as Scene;
  return { scene, added };
}

/**
 * Stand in for the GPU batch table: `getGeometryInstanceAttributes` exists only
 * after a real render, and `setTime` bails on `!primitive.ready`. The `color`
 * setter must COPY, because the layer writes ONE shared scratch for every entry
 * — a stand-in that stored the reference would report the last write for all.
 */
function armPrimitive(prim: Primitive): Map<unknown, Uint8Array> {
  const store = new Map<unknown, Uint8Array>();
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    const bytes = new Uint8Array(4);
    store.set(id, bytes);
    return {
      get color(): Uint8Array {
        return bytes;
      },
      set color(v: Uint8Array) {
        bytes.set(v);
      },
    } as never;
  };
  return store;
}

describe('surfel frame — orientation and anisotropy are real', () => {
  it('maps the identity quaternion to the identity basis', () => {
    const m = quaternionToBasis(0, 0, 0, 1);
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('rotates the tangent 90° about +z for a quarter-turn quaternion', () => {
    const h = Math.SQRT1_2; // sin(45°) = cos(45°)
    const m = quaternionToBasis(0, 0, h, h);
    // Column 0 (tangent) must land on +y.
    expect(m[0]).toBeCloseTo(0, 12);
    expect(m[1]).toBeCloseTo(1, 12);
    expect(m[2]).toBeCloseTo(0, 12);
  });

  it('produces an ORTHONORMAL ECEF basis — three unit, mutually perpendicular columns', () => {
    const f = surfelFrame(-122.4, 37.78, 0.2, -0.3, 0.1, 0.927);
    const col = (i: number): [number, number, number] => [
      f[i * 3],
      f[i * 3 + 1],
      f[i * 3 + 2],
    ];
    const dot = (a: number[], b: number[]): number =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (let i = 0; i < 3; i++) {
      expect(Math.hypot(...col(i)), `column ${i} unit`).toBeCloseTo(1, 9);
    }
    expect(dot(col(0), col(1))).toBeCloseTo(0, 9);
    expect(dot(col(1), col(2))).toBeCloseTo(0, 9);
    expect(dot(col(0), col(2))).toBeCloseTo(0, 9);
  });

  it('is LATITUDE-DEPENDENT — the same quaternion yields a different ECEF basis elsewhere', () => {
    // If the frame ignored the local ENU orientation it would be constant over
    // the globe, which is exactly the "looks right at the equator" bug.
    const a = surfelFrame(0, 0, 0, 0, 0, 1);
    const b = surfelFrame(0, 60, 0, 0, 0, 1);
    let same = true;
    for (let i = 0; i < 9; i++) if (Math.abs(a[i] - b[i]) > 1e-6) same = false;
    expect(same).toBe(false);
  });
});

describe('buildSurfelEntries', () => {
  it('keeps the two half-extents DISTINCT — a surfel is an ellipse, not a dot', () => {
    const { surfels } = buildSurfelEntries([surfelTile(2)]);
    expect(surfels).toHaveLength(2);
    expect(surfels[0].sMajor).toBeCloseTo(4, 9);
    expect(surfels[0].sMinor).toBeCloseTo(1, 9);
    expect(surfels[0].sMajor).not.toBeCloseTo(surfels[0].sMinor, 6);
  });

  it('rebases times against the build origin', () => {
    const { surfels, timeOrigin } = buildSurfelEntries([surfelTile(3)]);
    expect(timeOrigin).toBe(TIME_OFFSET);
    expect(surfels[1].start).toBeCloseTo(STARTS[1], 6);
    expect(surfels[1].end).toBeCloseTo(ENDS[1], 6);
  });

  it('joins two tiles with different timeOffsets onto ONE rebased timeline', () => {
    const later = surfelTile(2, {}, TIME_OFFSET + 5_000);
    const { surfels, timeOrigin } = buildSurfelEntries([surfelTile(2), later]);
    expect(surfels).toHaveLength(4);
    expect(timeOrigin).toBe(TIME_OFFSET);
    // The second tile's features are shifted by its own offset delta.
    expect(surfels[2].start).toBeCloseTo(STARTS[0] + 5_000, 6);
  });

  it('projects to absolute ECEF metres (not a small local frame)', () => {
    const { surfels } = buildSurfelEntries([surfelTile(1)]);
    const r = Math.hypot(surfels[0].x, surfels[0].y, surfels[0].z);
    // WGS84 radius at ~38°N, in metres. A degenerate/sphere-less build would
    // not land anywhere near this.
    expect(r).toBeGreaterThan(6_350_000);
    expect(r).toBeLessThan(6_390_000);
  });

  it('folds the baked confidence into the base alpha', () => {
    const { surfels } = buildSurfelEntries([
      surfelTile(2, { surfel_opacity: [1, 0.25] }),
    ]);
    expect(surfels[0].a).toBeCloseTo(1, 6);
    expect(surfels[1].a).toBeCloseTo(0.25, 6);
  });

  it('reads the baked per-surfel RGB', () => {
    const { surfels } = buildSurfelEntries([surfelTile(1)]);
    expect([surfels[0].r, surfels[0].g, surfels[0].b]).toEqual([200, 100, 50]);
  });

  it('returns an empty build for a tile with no surfel columns', () => {
    const bare = surfelTile(1);
    bare.layers[0].features.numericProps = {};
    expect(buildSurfelEntries([bare]).surfels).toHaveLength(0);
  });
});

describe('STTSurfelLayer.setTime derives alpha from the core oracle', () => {
  const MODES: ReadonlyArray<{
    mode: TimeFilterMode;
    params: TimeFilterParams;
  }> = [
    { mode: 'window', params: { windowHalf: 400 } },
    { mode: 'window', params: { windowHalf: 400, fadeIn: 250, fadeOut: 150 } },
    { mode: 'wake', params: { wakeLength: 900 } },
    { mode: 'cumulative', params: { fadeIn: 0 } },
    { mode: 'cumulative', params: { fadeIn: 700 } },
    { mode: 'trail', params: { trailLength: 600, trailFade: 1 } },
    { mode: 'none', params: {} },
  ];

  // A coprime stride across and beyond every feature, PLUS the exact boundary
  // instants — the stride alone never lands ON a startTime, the only place
  // wake/trail reach alpha 1.
  const PLAYHEADS: number[] = [];
  for (let t = -600; t <= 1800; t += 37) PLAYHEADS.push(TIME_OFFSET + t);
  for (const s of STARTS)
    PLAYHEADS.push(TIME_OFFSET + s, TIME_OFFSET + s + 900);
  for (const e of ENDS) PLAYHEADS.push(TIME_OFFSET + e);

  it('writes exactly `round(255 · timeFilterAlpha)` per instance, for every mode', () => {
    for (const { mode, params } of MODES) {
      const { scene, added } = stubScene();
      const layer = new STTSurfelLayer(scene, { mode, timeFilter: params });
      layer.setTiles([surfelTile(4)]);
      const prim = added[0] as Primitive;
      const store = armPrimitive(prim);

      for (const absoluteMs of PLAYHEADS) {
        layer.setTime(absoluteMs);
        const cur = absoluteMs - TIME_OFFSET;
        const bytes = [...store.entries()]
          .sort(
            (a, b) =>
              (a[0] as { featureIndex: number }).featureIndex -
              (b[0] as { featureIndex: number }).featureIndex,
          )
          .map(([, v]) => v[3]);
        expect(bytes).toHaveLength(STARTS.length);
        for (let i = 0; i < STARTS.length; i++) {
          expect(bytes[i]).toBe(
            Math.round(
              255 * timeFilterAlpha(mode, cur, STARTS[i], ENDS[i], params),
            ),
          );
        }
      }
    }
  });

  it('is not vacuous: the sweep really produces 0, 1 and a fractional alpha', () => {
    const seen = new Set<string>();
    for (const absoluteMs of PLAYHEADS) {
      const a = timeFilterAlpha(
        'window',
        absoluteMs - TIME_OFFSET,
        STARTS[1],
        ENDS[1],
        { windowHalf: 400, fadeIn: 250, fadeOut: 150 },
      );
      seen.add(a === 0 ? 'zero' : a === 1 ? 'one' : 'frac');
    }
    expect(seen).toEqual(new Set(['zero', 'one', 'frac']));
  });
});

describe('STTSurfelLayer lifecycle', () => {
  it('keeps the standing primitive when a rebuild yields nothing', () => {
    const { scene, added } = stubScene();
    const layer = new STTSurfelLayer(scene);
    layer.setTiles([surfelTile(2)]);
    expect(added).toHaveLength(1);
    const bare = surfelTile(1);
    bare.layers[0].features.numericProps = {};
    layer.setTiles([bare]);
    // Build-before-teardown: no second primitive, and the first still stands.
    expect(added).toHaveLength(1);
  });
});
