// @poopdeck.gl/three
// SPDX-License-Identifier: MIT

/**
 * Tile-loading audit 2026-08, finding E5 — the GPU churn behind every
 * `setTiles` on the three layers, measured alongside the source-side O(N·M)
 * republish (256 arrivals → 256 materials + 256 geometries):
 *
 *  - The merged-buffer layers disposed and RECREATED their TSL material on
 *    every `setTiles`. three's `getMaterialCacheKey` would cache a swapped
 *    material fine; it is the `dispose()` that evicts the `nodeBuilderCache`
 *    entry, the program and the pipeline — a full shader rebuild per arrival.
 *    Every input to those materials is fixed at construction, so they are
 *    built ONCE (the way polygon/iso already did) and only the geometry churns.
 *  - `STTBoundingBoxLayer.setTime` resampled every track and flagged the
 *    whole capacity-sized buffer for upload on EVERY call — a repeated time
 *    (a paused clock still renders) paid it all again — and its
 *    `updateDrawRange` recomputed the bounding sphere over the full buffer
 *    capacity every frame on an object with `frustumCulled = false`, which
 *    nothing consumed.
 */

import { describe, it, expect, vi } from 'vitest';
import { LineSegments, type Mesh, type Material } from 'three';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { STTPointLayer } from '../src/layers/point-layer';
import { STTColumnLayer } from '../src/layers/column-layer';
import { STTWideLineLayer } from '../src/layers/wide-line-layer';
import { STTArcLayer } from '../src/layers/arc-layer';
import { STTTripsLayer } from '../src/layers/trips-layer';
import { STTOdLineLayer } from '../src/layers/od-line-layer';
import { STTBoundingBoxLayer } from '../src/layers/bounding-box-layer';
import type { STTLayer, STTLayerContext } from '../src/layers/layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { FLOATS_PER_BOX } from '../src/geometry/box-edges';
import { makePointTile, makeLineTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const ctx: STTLayerContext = {
  projection: new LocalEnuProjection(anchor),
  timeOrigin: 0,
};

/** Three points, offset east by `x` hundredths of a degree; tile address x. */
function pointTile(x: number): Tile {
  const lon = anchor.longitude + x * 0.01;
  return makePointTile(
    3,
    [
      lon,
      anchor.latitude,
      lon + 0.001,
      anchor.latitude,
      lon + 0.002,
      anchor.latitude,
    ],
    {
      endTimes: new Float32Array([1000, 1000, 1000]),
      numericProps: { mag: new Float32Array([1, 2, 3]) },
    },
    { id: { z: 12, x, y: 0, t: 0 } },
  );
}

/** One 3-vertex LineString heading east; tile address x. */
function lineTile(x: number): Tile {
  const lon = anchor.longitude + x * 0.01;
  return makeLineTile(
    {
      positions: new Float64Array([
        lon,
        anchor.latitude,
        lon + 0.001,
        anchor.latitude,
        lon + 0.002,
        anchor.latitude,
      ]),
      startIndices: new Uint32Array([0, 3]),
      startTimes: new Float32Array([0]),
      endTimes: new Float32Array([1000]),
      vertexTimestamps: new Float32Array([0, 500, 1000]),
    },
    { id: { z: 14, x, y: 0, t: 0 } },
  );
}

type MeshLayer = STTLayer & { object: Mesh };

const CONSTANT = { type: 'constant', color: [200, 120, 40, 255] } as const;

const cases: Array<[string, () => MeshLayer, (x: number) => Tile]> = [
  ['point-cloud', () => new STTPointLayer({ id: 'p' }), pointTile],
  [
    'column',
    () =>
      new STTColumnLayer({
        id: 'c',
        elevationProperty: 'mag',
        colorMode: CONSTANT,
      }),
    pointTile,
  ],
  [
    'wide-line',
    () => new STTWideLineLayer({ id: 'w', colorMode: CONSTANT }),
    lineTile,
  ],
  ['arc', () => new STTArcLayer({ id: 'a' }), lineTile],
  [
    'trips',
    () => new STTTripsLayer({ id: 't', colorMode: CONSTANT }),
    lineTile,
  ],
  [
    'od-line',
    () => new STTOdLineLayer({ id: 'o', colorMode: CONSTANT }),
    lineTile,
  ],
];

describe('E5 — material identity is stable across setTiles', () => {
  for (const [name, make, tileAt] of cases) {
    it(`E5: ${name} keeps ONE material across 3 setTiles calls (and an empty set)`, () => {
      const layer = make();
      layer.setTiles([tileAt(0)], ctx);
      const m1 = layer.object.material as Material;
      expect(m1).toBeTruthy();
      const disposed = vi.spyOn(m1, 'dispose');

      layer.setTiles([tileAt(0), tileAt(1)], ctx);
      layer.setTiles([tileAt(1)], ctx);
      expect(layer.object.material).toBe(m1);

      // The empty transition (selection moved, first tile not yet decoded)
      // hides the mesh but keeps the compiled material for the next set.
      layer.setTiles([], ctx);
      expect(layer.object.visible).toBe(false);
      layer.setTiles([tileAt(2)], ctx);
      expect(layer.object.visible).toBe(true);
      expect(layer.object.material).toBe(m1);
      expect(disposed).not.toHaveBeenCalled();

      // Only the layer's own teardown releases it.
      layer.dispose();
      expect(disposed).toHaveBeenCalledTimes(1);
    });
  }

  it('E5: geometry still churns per setTiles — the previous buffer is released', () => {
    const layer = new STTPointLayer({ id: 'p' });
    layer.setTiles([pointTile(0), pointTile(1)], ctx);
    const g1 = layer.object.geometry;
    expect(g1.instanceCount).toBe(6);
    const disposed = vi.spyOn(g1, 'dispose');
    layer.setTiles([pointTile(1)], ctx);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(layer.object.geometry).not.toBe(g1);
    expect(layer.object.geometry.instanceCount).toBe(3);
    layer.dispose();
  });
});

/** An object-snapshot tile: `ids.length` keyframes at `starts`, all one box size. */
function objectTile(
  ids: string[],
  starts: number[],
  lon: number[],
  lat: number[],
): Tile {
  const n = ids.length;
  const positions = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 2] = lon[i];
    positions[i * 2 + 1] = lat[i];
  }
  const cats = Array.from(new Set(ids));
  const features: BinaryFeatures = {
    featureCount: n,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions,
    featureIds: new Uint32Array(n),
    startTimes: new Float32Array(starts),
    endTimes: new Float32Array(starts),
    timeOffset: 0,
    numericProps: {
      heading: new Float32Array(n),
      length: new Float32Array(n).fill(4),
      width: new Float32Array(n).fill(2),
      height: new Float32Array(n).fill(1.6),
    },
    categoricalProps: {
      track_id: {
        indices: new Uint16Array(ids.map((t) => cats.indexOf(t))),
        categories: cats,
      },
    },
    vectorProps: {},
  };
  return {
    id: { z: 18, x: 0, y: 0, t: 0 },
    timeRange: { start: 0, end: 2000 },
    layers: [
      {
        name: 'objects',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

function edgesOf(layer: STTBoundingBoxLayer): LineSegments {
  return layer.object.children.find(
    (c) => c instanceof LineSegments,
  ) as LineSegments;
}

describe('E5 — STTBoundingBoxLayer per-frame cost', () => {
  const twoTracks = () =>
    objectTile(
      ['car', 'car', 'bus', 'bus'],
      [0, 1000, 0, 1000],
      [
        anchor.longitude,
        anchor.longitude + 0.001,
        anchor.longitude + 0.002,
        anchor.longitude + 0.003,
      ],
      [anchor.latitude, anchor.latitude, anchor.latitude, anchor.latitude],
    );

  it('E5: setTime with an unchanged time does no resample and no buffer upload', () => {
    const layer = new STTBoundingBoxLayer({
      id: 'b',
      trackIdProperty: 'track_id',
    });
    layer.setTiles([twoTracks()], ctx);
    layer.setTime(500);
    const edges = edgesOf(layer);
    expect(edges.geometry.drawRange.count).toBe(2 * (FLOATS_PER_BOX / 3));
    const pos = edges.geometry.getAttribute('position');
    const col = edges.geometry.getAttribute('color');
    const v = pos.version;
    const vc = col.version;

    // A paused clock renders the same time again: nothing to do.
    layer.setTime(500);
    expect(pos.version).toBe(v);
    expect(col.version).toBe(vc);

    // A moved time uploads ONLY the touched prefix, not the capacity.
    layer.setTime(600);
    expect(pos.version).toBe(v + 1);
    expect(pos.array.length).toBeGreaterThan(2 * FLOATS_PER_BOX); // capacity ≥ 16 boxes
    expect(pos.updateRanges).toEqual([{ start: 0, count: 2 * FLOATS_PER_BOX }]);
    expect(col.updateRanges).toEqual([{ start: 0, count: 2 * FLOATS_PER_BOX }]);

    // A new tile set invalidates the guard even at the same time.
    layer.setTiles([twoTracks()], ctx);
    layer.setTime(600);
    expect(pos.version).toBe(v + 2);
    layer.dispose();
  });

  it('E5: setTime never recomputes the bounding sphere (frustumCulled is off; nothing reads it)', () => {
    const layer = new STTBoundingBoxLayer({
      id: 'b',
      trackIdProperty: 'track_id',
      showVelocity: true,
    });
    layer.setTiles([twoTracks()], ctx);
    layer.setTime(500);
    const spies = layer.object.children
      .filter((c): c is LineSegments => c instanceof LineSegments)
      .map((l) => vi.spyOn(l.geometry, 'computeBoundingSphere'));
    layer.setTime(600);
    layer.setTime(700);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    layer.dispose();
  });
});
