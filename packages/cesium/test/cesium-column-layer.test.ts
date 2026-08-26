// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTColumnLayer` — the `column` kind for CesiumJS.
 *
 * Everything except the actual GPU render pass is exercised here against a stub
 * `Scene` and REAL Cesium value types (`PrimitiveCollection`, `Primitive`,
 * `GeometryInstance`, `CylinderGeometry`, `Matrix4`), which all load and compute
 * under Node.
 *
 * Two cases carry most of the weight:
 *
 *  - "orients every prism to its LOCAL east-north-up frame" — the bug this layer
 *    is most likely to ship is an identity model matrix, which points every
 *    column at the ECEF spin axis. That is invisible at the equator and lays the
 *    columns flat at high latitude, so it is pinned at four sites with a
 *    negative control against the identity placement.
 *  - "arms the batch table lazily and skips unchanged alphas" — the per-frame
 *    contract: one shared scratch, one write per CHANGED prism, nothing before
 *    the primitive is `ready`.
 */

import { describe, it, expect } from 'vitest';
import {
  Cartesian3,
  CylinderGeometry,
  GeometryInstance,
  Matrix4,
  Primitive,
  PrimitiveCollection,
  type Scene,
} from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GlobeProjection } from '@poopdeck.gl/core/geo';
import { timeFilterAlpha } from '@poopdeck.gl/core/time-filter';
import { STTColumnLayer } from '../src/cesium-column-layer';

const GLOBE = new GlobeProjection({ longitude: 0, latitude: 0 }, undefined, {
  datum: 'wgs84',
});
const DEG2RAD = Math.PI / 180;

/** The WGS84 ellipsoid normal (unit "local up") at a geodetic lon/lat. */
function geodeticUp(lon: number, lat: number): Cartesian3 {
  const la = lat * DEG2RAD;
  const lo = lon * DEG2RAD;
  return new Cartesian3(
    Math.cos(la) * Math.cos(lo),
    Math.cos(la) * Math.sin(lo),
    Math.sin(la),
  );
}

interface StubScene {
  scene: Scene;
  added: unknown[];
  removed: unknown[];
  /** What the next `scene.pick` returns. */
  setPick(v: unknown): void;
}

function stubScene(): StubScene {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  let picked: unknown;
  const scene = {
    primitives: {
      add<T>(p: T): T {
        added.push(p);
        return p;
      },
      remove(p: unknown): boolean {
        removed.push(p);
        return true;
      },
    },
    pick(): unknown {
      return picked;
    },
  } as unknown as Scene;
  return {
    scene,
    added,
    removed,
    setPick(v: unknown) {
      picked = v;
    },
  };
}

interface ArmedAttr {
  bytes: Uint8Array;
  writes: number;
}

/**
 * Stand in for the batch table, which only exists after a real GPU render.
 * The setter COPIES (like Cesium's), which matters: the layer writes one shared
 * scratch `Uint8Array` for every prism, so a stand-in that stored the reference
 * would report the last write for all of them.
 */
function armPrimitive(prim: Primitive): Map<unknown, ArmedAttr> {
  const store = new Map<unknown, ArmedAttr>();
  Object.defineProperty(prim, 'ready', { value: true, configurable: true });
  prim.getGeometryInstanceAttributes = (id: unknown) => {
    const slot: ArmedAttr = { bytes: new Uint8Array(4), writes: 0 };
    store.set(id, slot);
    return {
      get color(): Uint8Array {
        return slot.bytes;
      },
      set color(v: Uint8Array) {
        slot.bytes.set(v);
        slot.writes++;
      },
    } as never;
  };
  return store;
}

/** The layer's single batched primitive, as the collection actually holds it. */
function primitiveOf(layer: STTColumnLayer): Primitive {
  const coll = (layer as unknown as { collection: PrimitiveCollection })
    .collection;
  expect(coll.length).toBe(1);
  return coll.get(0) as Primitive;
}

function instancesOf(layer: STTColumnLayer): GeometryInstance[] {
  const prim = primitiveOf(layer);
  return (prim as unknown as { geometryInstances: GeometryInstance[] })
    .geometryInstances;
}

/** Attribute slots in the SAME order as the instances, once armed. */
function slotsInOrder(
  layer: STTColumnLayer,
  store: Map<unknown, ArmedAttr>,
): ArmedAttr[] {
  return instancesOf(layer).map((gi) => {
    const slot = store.get(gi.id);
    expect(slot).toBeDefined();
    return slot as ArmedAttr;
  });
}

function pointTile(
  positions: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  const featureCount = startTimes.length;
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.Point,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    featureIds: new Uint32Array(featureCount),
    startTimes: new Float32Array(startTimes),
    endTimes: new Float32Array(endTimes),
    timeOffset,
    numericProps: {},
    categoricalProps: {},
    vectorProps: {},
    ...partial,
  };
  return {
    id: { z: 5, x: 0, y: 0, t: timeOffset },
    timeRange: { start: timeOffset, end: timeOffset + 1000 },
    layers: [
      {
        name: 'points',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.point',
      },
    ],
  };
}

const TWO = [pointTile([10, 45, 11, 46], [0, 400], [200, 600])];

describe('STTColumnLayer — construction and lifecycle', () => {
  it('registers a PrimitiveCollection into scene.primitives immediately', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene);
    expect(s.added).toHaveLength(1);
    expect(s.added[0]).toBeInstanceOf(PrimitiveCollection);
    expect(layer.id).toBe('stt-cesium-columns');
  });

  it('honours an explicit id', () => {
    const s = stubScene();
    expect(new STTColumnLayer(s.scene, { id: 'skyline' }).id).toBe('skyline');
  });

  it('dispose removes exactly the collection it added, and drops its entries', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene);
    layer.setTiles(TWO);
    layer.dispose();
    expect(s.removed).toEqual([s.added[0]]);
    expect((layer as unknown as { entries: unknown[] }).entries).toHaveLength(
      0,
    );
    expect((layer as unknown as { primitive: unknown }).primitive).toBeNull();
  });

  it('survives setTime after dispose (the clock bridge can outlive a layer)', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene);
    layer.setTiles(TWO);
    layer.dispose();
    expect(() => layer.setTime(100)).not.toThrow();
  });
});

describe('STTColumnLayer — setTiles', () => {
  it('builds ONE batched Primitive holding one instance per feature', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene);
    layer.setTiles(TWO);
    const instances = instancesOf(layer);
    expect(instances).toHaveLength(2);
    expect(instances[0].geometry).toBeInstanceOf(CylinderGeometry);
  });

  it('attaches the { layerId, binary, featureIndex } pick id to every instance', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene, { id: 'skyline' });
    layer.setTiles(TWO);
    const src = TWO[0].layers[0].features;
    expect(instancesOf(layer).map((gi) => gi.id)).toEqual([
      { layerId: 'skyline', binary: src, featureIndex: 0 },
      { layerId: 'skyline', binary: src, featureIndex: 1 },
    ]);
  });

  it('seeds every instance colour fully TRANSPARENT — the first setTime reveals', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene);
    layer.setTiles(TWO);
    for (const gi of instancesOf(layer)) {
      const attr = (gi.attributes as { color: { value: Uint8Array } }).color;
      expect(Array.from(attr.value)).toEqual([255, 140, 0, 0]);
    }
  });

  it('REPLACES on rebuild rather than accumulating', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene);
    layer.setTiles(TWO);
    layer.setTiles([pointTile([12, 47], [0], [10])]);
    expect(instancesOf(layer)).toHaveLength(1);
    expect((layer as unknown as { entries: unknown[] }).entries).toHaveLength(
      1,
    );
  });

  it('BUILDS BEFORE TEARING DOWN: an empty result leaves the old prisms standing', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene);
    layer.setTiles([
      pointTile([10, 45, 11, 46], [0, 400], [200, 600], {}, 5_000),
    ]);
    const before = primitiveOf(layer);
    // The transient every streaming backend hits: selection reports an empty
    // visible set between a viewport change and the first decoded tile.
    layer.setTiles([]);
    expect(primitiveOf(layer)).toBe(before);
    expect(instancesOf(layer)).toHaveLength(2);
    // …and the prior time origin survives too, so the animation does not jump.
    expect((layer as unknown as { timeOrigin: number }).timeOrigin).toBe(5_000);
  });

  it('also holds when EVERY feature is skipped as non-renderable', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene, { elevationProperty: 'mag' });
    layer.setTiles([
      pointTile([10, 45], [0], [10], {
        numericProps: { mag: new Float32Array([500]) },
      }),
    ]);
    const before = primitiveOf(layer);
    layer.setTiles([
      pointTile([11, 46], [0], [10], {
        numericProps: { mag: new Float32Array([-1]) }, // deck shouldRender: false
      }),
    ]);
    expect(primitiveOf(layer)).toBe(before);
  });
});

describe('STTColumnLayer — prism geometry', () => {
  it('sizes the cylinder from the metric radius and the resolved height', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene, {
      radius: 400,
      coverage: 0.5,
      defaultElevation: 600,
    });
    layer.setTiles([pointTile([10, 45], [0], [10])]);
    const geom = CylinderGeometry.createGeometry(
      instancesOf(layer)[0].geometry as CylinderGeometry,
    );
    // Cesium's cylinder bounding sphere is hypot(length/2, maxRadius) about the
    // LOCAL origin — a public read of both numbers at once.
    expect(geom?.boundingSphere.radius).toBeCloseTo(Math.hypot(300, 200), 6);
  });

  it("uses deck's diskResolution as the prism's side count", () => {
    const s = stubScene();
    const hex = new STTColumnLayer(s.scene, { diskResolution: 6 });
    hex.setTiles([pointTile([10, 45], [0], [10])]);
    const disk = new STTColumnLayer(stubScene().scene, {});
    disk.setTiles([pointTile([10, 45], [0], [10])]);
    const count = (l: STTColumnLayer): number =>
      CylinderGeometry.createGeometry(
        instancesOf(l)[0].geometry as CylinderGeometry,
      )!.attributes.position!.values!.length;
    // Default is deck's 20, so the smooth disk carries strictly more vertices.
    expect(count(hex)).toBeLessThan(count(disk));
  });

  it('CLAMPS an illegal resolution instead of letting Cesium throw', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene, { diskResolution: 2 });
    // Cesium throws DeveloperError below 3 slices; without the clamp this whole
    // rebuild — and the frame it happens on — would die.
    expect(() =>
      layer.setTiles([pointTile([10, 45], [0], [10])]),
    ).not.toThrow();
    const tri = CylinderGeometry.createGeometry(
      instancesOf(layer)[0].geometry as CylinderGeometry,
    );
    const three = new STTColumnLayer(stubScene().scene, { diskResolution: 3 });
    three.setTiles([pointTile([10, 45], [0], [10])]);
    const ref = CylinderGeometry.createGeometry(
      instancesOf(three)[0].geometry as CylinderGeometry,
    );
    expect(tri!.attributes.position!.values!.length).toBe(
      ref!.attributes.position!.values!.length,
    );
  });
});

describe('STTColumnLayer — model matrices (local up, not the spin axis)', () => {
  const SITES: Array<[string, number, number]> = [
    ['equator', 0, 0],
    ['mid-latitude', 10, 45],
    ['Reykjavik', -21.9, 64.1],
    ['southern', 151.2, -33.9],
  ];

  it('orients every prism to its LOCAL east-north-up frame', () => {
    for (const [, lon, lat] of SITES) {
      const layer = new STTColumnLayer(stubScene().scene, {
        defaultElevation: 2000,
      });
      layer.setTiles([pointTile([lon, lat], [0], [10])]);
      const m = instancesOf(layer)[0].modelMatrix;
      const up = geodeticUp(lon, lat);

      // Column 2 is the prism's own axis: CylinderGeometry extrudes along
      // local +Z, so this column IS which way the column points.
      const axis = Matrix4.getColumn(m, 2, new Cartesian3());
      expect(axis.x).toBeCloseTo(up.x, 9);
      expect(axis.y).toBeCloseTo(up.y, 9);
      expect(axis.z).toBeCloseTo(up.z, 9);

      // Column 0 is local EAST at angle 0: horizontal, and perpendicular to up.
      const east = Matrix4.getColumn(m, 0, new Cartesian3());
      expect(east.z).toBeCloseTo(0, 9);
      expect(Cartesian3.dot(east, up)).toBeCloseTo(0, 9);
    }
  });

  it('raises the prism by HALF its height, so the FOOT sits on the data', () => {
    for (const [, lon, lat] of SITES) {
      const height = 2000;
      const layer = new STTColumnLayer(stubScene().scene, {
        defaultElevation: height,
      });
      layer.setTiles([pointTile([lon, lat], [0], [10])]);
      const t = Matrix4.getTranslation(
        instancesOf(layer)[0].modelMatrix,
        new Cartesian3(),
      );
      const [fx, fy, fz] = GLOBE.project(lon, lat, 0);
      const up = geodeticUp(lon, lat);
      // Cesium's cylinder is CENTRED on its origin; the data is at the foot.
      expect(t.x).toBeCloseTo(fx + up.x * (height / 2), 6);
      expect(t.y).toBeCloseTo(fy + up.y * (height / 2), 6);
      expect(t.z).toBeCloseTo(fz + up.z * (height / 2), 6);
    }
  });

  it('NEGATIVE CONTROL: an identity matrix would only be right at the equator', () => {
    // Column 2 of IDENTITY is ECEF +Z — the spin axis. Prove the layer's matrix
    // diverges from it away from the equator, and that the divergence is the
    // co-latitude, i.e. exactly the lean the bug would produce.
    for (const [, lon, lat] of SITES) {
      const layer = new STTColumnLayer(stubScene().scene);
      layer.setTiles([pointTile([lon, lat], [0], [10])]);
      const axis = Matrix4.getColumn(
        instancesOf(layer)[0].modelMatrix,
        2,
        new Cartesian3(),
      );
      const lean = Math.acos(Math.min(1, Math.abs(axis.z))) / DEG2RAD;
      expect(lean).toBeCloseTo(90 - Math.abs(lat), 4);
    }
  });

  it('spins the cross-section about the prism axis for a non-zero angle', () => {
    const [lon, lat] = [10, 45];
    const spun = new STTColumnLayer(stubScene().scene, { angle: 90 });
    spun.setTiles([pointTile([lon, lat], [0], [10])]);
    const flat = new STTColumnLayer(stubScene().scene, { angle: 0 });
    flat.setTiles([pointTile([lon, lat], [0], [10])]);

    const spunX = Matrix4.getColumn(
      instancesOf(spun)[0].modelMatrix,
      0,
      new Cartesian3(),
    );
    const flatY = Matrix4.getColumn(
      instancesOf(flat)[0].modelMatrix,
      1,
      new Cartesian3(),
    );
    // A 90 degree spin sends local +X onto local +Y (east onto north)…
    expect(spunX.x).toBeCloseTo(flatY.x, 9);
    expect(spunX.y).toBeCloseTo(flatY.y, 9);
    expect(spunX.z).toBeCloseTo(flatY.z, 9);
    // …and leaves the axis, and therefore the placement, untouched.
    const spunZ = Matrix4.getColumn(
      instancesOf(spun)[0].modelMatrix,
      2,
      new Cartesian3(),
    );
    const flatZ = Matrix4.getColumn(
      instancesOf(flat)[0].modelMatrix,
      2,
      new Cartesian3(),
    );
    expect(Cartesian3.equalsEpsilon(spunZ, flatZ, 1e-12)).toBe(true);
  });

  it('gives every instance its OWN Matrix4 (Cesium holds them by reference)', () => {
    const layer = new STTColumnLayer(stubScene().scene);
    layer.setTiles(TWO);
    const [a, b] = instancesOf(layer);
    expect(a.modelMatrix).not.toBe(b.modelMatrix);
    expect(Matrix4.equals(a.modelMatrix, b.modelMatrix)).toBe(false);
  });
});

describe('STTColumnLayer — time as height', () => {
  it('lifts each foot along LOCAL UP by (start - origin) x scale', () => {
    const [lon, lat] = [-21.9, 64.1]; // where a Z offset would be visibly wrong
    const layer = new STTColumnLayer(stubScene().scene, {
      timeHeightScale: 2,
      defaultElevation: 100,
    });
    layer.setTiles([pointTile([lon, lat, lon, lat], [0, 500], [10, 510])]);
    const ups = instancesOf(layer).map((gi) =>
      Matrix4.getTranslation(gi.modelMatrix, new Cartesian3()),
    );
    const up = geodeticUp(lon, lat);
    // Both prisms share a lon/lat, so the whole separation is the cube axis.
    const d = Cartesian3.subtract(ups[1], ups[0], new Cartesian3());
    expect(Cartesian3.magnitude(d)).toBeCloseTo(1000, 6); // 500 ms x 2 m/ms
    const unit = Cartesian3.normalize(d, new Cartesian3());
    expect(Cartesian3.dot(unit, up)).toBeCloseTo(1, 9);
  });

  it('is flat at scale 0 — co-located features stack at one altitude', () => {
    const layer = new STTColumnLayer(stubScene().scene);
    layer.setTiles([pointTile([10, 45, 10, 45], [0, 500], [10, 510])]);
    const [a, b] = instancesOf(layer).map((gi) =>
      Matrix4.getTranslation(gi.modelMatrix, new Cartesian3()),
    );
    expect(Cartesian3.equalsEpsilon(a, b, 1e-9)).toBe(true);
  });
});

describe('STTColumnLayer — setTime', () => {
  const MODES = [
    { mode: 'window' as const, params: { windowHalf: 400 } },
    {
      mode: 'window' as const,
      params: { windowHalf: 400, fadeIn: 250, fadeOut: 150 },
    },
    { mode: 'wake' as const, params: { wakeLength: 900 } },
    { mode: 'cumulative' as const, params: { fadeIn: 700 } },
    { mode: 'trail' as const, params: { trailLength: 600, trailFade: 0.35 } },
    { mode: 'none' as const, params: {} },
  ];

  it('does NOTHING before the primitive is ready (no batch table yet)', () => {
    const layer = new STTColumnLayer(stubScene().scene);
    layer.setTiles(TWO);
    // `ready` is false until the first real render; touching the batch table
    // there throws inside Cesium.
    expect(() => layer.setTime(100)).not.toThrow();
    expect((layer as unknown as { attrsCached: boolean }).attrsCached).toBe(
      false,
    );
  });

  it('writes the base RGB plus the oracle alpha, per prism', () => {
    const layer = new STTColumnLayer(stubScene().scene, {
      mode: 'window',
      timeFilter: { windowHalf: 400 },
      color: { type: 'constant', color: [10, 20, 30, 255] },
    });
    layer.setTiles(TWO);
    const store = armPrimitive(primitiveOf(layer));
    layer.setTime(400);
    const slots = slotsInOrder(layer, store);
    for (const [i, start] of [0, 400].entries()) {
      const end = [200, 600][i];
      const expected = Math.round(
        timeFilterAlpha('window', 400, start, end, { windowHalf: 400 }) * 255,
      );
      expect(Array.from(slots[i].bytes)).toEqual([10, 20, 30, expected]);
    }
  });

  it('agrees with the timeFilterAlpha oracle across modes and playheads', () => {
    const starts = [0, 120, 500, 999];
    const ends = [40, 300, 900, 1200];
    const positions = starts.flatMap((_, i) => [10 + i, 45]);
    const tiles = [pointTile(positions, starts, ends)];
    for (const { mode, params } of MODES) {
      const layer = new STTColumnLayer(stubScene().scene, {
        mode,
        timeFilter: params,
        color: { type: 'constant', color: [1, 2, 3, 255] },
      });
      layer.setTiles(tiles);
      const store = armPrimitive(primitiveOf(layer));
      // A coprime stride across and past every feature, PLUS the exact start
      // instants — the stride alone never lands ON a startTime, the only place
      // wake/trail reach alpha 1.
      const playheads = [...starts, ...ends];
      for (let t = -200; t <= 1600; t += 37) playheads.push(t);
      for (const t of playheads) {
        layer.setTime(t);
        const slots = slotsInOrder(layer, store);
        for (let i = 0; i < starts.length; i++) {
          expect(slots[i].bytes[3]).toBe(
            Math.round(
              timeFilterAlpha(mode, t, starts[i], ends[i], params) * 255,
            ),
          );
        }
      }
    }
  });

  it('rebases the playhead onto the build time origin', () => {
    const origin = 1_700_000_000_000;
    const layer = new STTColumnLayer(stubScene().scene, {
      mode: 'window',
      timeFilter: { windowHalf: 100 },
    });
    layer.setTiles([pointTile([10, 45], [500], [500], {}, origin)]);
    const store = armPrimitive(primitiveOf(layer));
    layer.setTime(origin + 500); // dead centre of the window
    expect(slotsInOrder(layer, store)[0].bytes[3]).toBe(255);
    layer.setTime(origin + 5_000); // far outside it
    expect(slotsInOrder(layer, store)[0].bytes[3]).toBe(0);
  });

  it('multiplies the oracle alpha by the base colour alpha', () => {
    const layer = new STTColumnLayer(stubScene().scene, {
      mode: 'none',
      color: { type: 'constant', color: [9, 9, 9, 128] },
    });
    layer.setTiles([pointTile([10, 45], [0], [10])]);
    const store = armPrimitive(primitiveOf(layer));
    layer.setTime(5);
    expect(slotsInOrder(layer, store)[0].bytes[3]).toBe(128);
  });

  it('SKIPS unchanged alphas — a settled prism costs one compare, not a write', () => {
    const layer = new STTColumnLayer(stubScene().scene, {
      mode: 'window',
      timeFilter: { windowHalf: 50 },
    });
    layer.setTiles(TWO);
    const store = armPrimitive(primitiveOf(layer));

    layer.setTime(0); // frame 1: lastAlpha is NaN, so BOTH prisms write
    const slots = slotsInOrder(layer, store);
    expect(slots.map((s) => s.writes)).toEqual([1, 1]);

    layer.setTime(0); // identical playhead → nothing to dirty
    layer.setTime(1); // still outside both windows for feature 1, in for 0
    expect(slots[1].writes).toBe(1);

    layer.setTime(400); // feature 1 (start 400) enters its window
    expect(slots[1].writes).toBe(2);
  });

  it('gives each prism its OWN bytes — the shared scratch never leaks across', () => {
    const layer = new STTColumnLayer(stubScene().scene, {
      mode: 'window',
      timeFilter: { windowHalf: 1 },
    });
    layer.setTiles(TWO);
    const store = armPrimitive(primitiveOf(layer));
    layer.setTime(0); // feature 0 fully on, feature 1 fully off
    const slots = slotsInOrder(layer, store);
    expect(slots[0].bytes[3]).toBe(255);
    expect(slots[1].bytes[3]).toBe(0);
    expect(slots[0].bytes).not.toBe(slots[1].bytes);
  });

  it('re-arms the batch table after a rebuild', () => {
    const layer = new STTColumnLayer(stubScene().scene, { mode: 'none' });
    layer.setTiles(TWO);
    armPrimitive(primitiveOf(layer));
    layer.setTime(0);
    layer.setTiles([pointTile([12, 47], [0], [10])]);
    expect((layer as unknown as { attrsCached: boolean }).attrsCached).toBe(
      false,
    );
    const store = armPrimitive(primitiveOf(layer));
    layer.setTime(0);
    expect(slotsInOrder(layer, store)[0].bytes[3]).toBe(255);
  });
});

describe('STTColumnLayer — pick', () => {
  it('returns null when nothing is under the cursor', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene);
    layer.setTiles(TWO);
    s.setPick(undefined);
    expect(layer.pick(10, 20)).toBeNull();
  });

  it("returns null for ANOTHER layer's primitive", () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene, { id: 'skyline' });
    layer.setTiles(TWO);
    const src = TWO[0].layers[0].features;
    s.setPick({
      id: { layerId: 'someone-else', binary: src, featureIndex: 0 },
    });
    expect(layer.pick(10, 20)).toBeNull();
  });

  it('resolves feature props, index and the source lon/lat', () => {
    const s = stubScene();
    const layer = new STTColumnLayer(s.scene, { id: 'skyline' });
    layer.setTiles([
      pointTile([10, 45, 11, 46], [0, 400], [200, 600], {
        numericProps: { mag: new Float32Array([3, 7]) },
      }),
    ]);
    const src = instancesOf(layer)[1].id as { binary: BinaryFeatures };
    s.setPick({ id: { ...src, layerId: 'skyline', featureIndex: 1 } });
    const hit = layer.pick(12, 34);
    expect(hit).not.toBeNull();
    expect(hit!.layerId).toBe('skyline');
    expect(hit!.index).toBe(1);
    expect(hit!.coordinate).toEqual([11, 46]);
    expect(hit!.screen).toEqual([12, 34]);
    expect(hit!.object).toMatchObject({ mag: 7 });
  });
});
