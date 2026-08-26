// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT

/**
 * `STTPolygonLayer` — the `polygon` kind for CesiumJS.
 *
 * Everything except the actual GPU render pass runs here against a stub `Scene`
 * and REAL Cesium value types (`PrimitiveCollection`, `Primitive`,
 * `GeometryInstance`, `PolygonGeometry`, `PolygonHierarchy`), all of which load
 * and compute under Node.
 *
 * Four cases carry most of the weight:
 *
 *  - "emits one instance per PART with DISTINCT id objects" — Cesium's batch
 *    table looks instance ids up by `===`, so a MultiPolygon that shares one id
 *    object across its islands would give them one shared colour slot and
 *    animate only whichever Cesium found first.
 *  - "holds the previous polygons when the new set is empty" — the replace-all
 *    ordering rule. Tearing down before the build turns the gap between a
 *    viewport change and the first decoded tile into a blank frame.
 *  - "arms the batch table lazily and skips unchanged alphas" — the per-frame
 *    contract: nothing before `ready`, one shared scratch, one write per
 *    CHANGED feature.
 *  - "flat fills keep per-vertex height; extruded ones span two scalars" — the
 *    two geometry shapes, and the documented deviation between them.
 */

import { describe, it, expect } from 'vitest';
import {
  GeometryInstance,
  PerInstanceColorAppearance,
  PolygonGeometry,
  Primitive,
  PrimitiveCollection,
  type Scene,
} from 'cesium';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { timeFilterAlpha } from '@poopdeck.gl/core/time-filter';
import { STTPolygonLayer } from '../src/cesium-polygon-layer';

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
 * scratch `Uint8Array` for every feature, so a stand-in that stored the
 * reference would report the last write for all of them.
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
function primitiveOf(layer: STTPolygonLayer): Primitive {
  const coll = (layer as unknown as { collection: PrimitiveCollection })
    .collection;
  expect(coll.length).toBe(1);
  return coll.get(0) as Primitive;
}

function instancesOf(layer: STTPolygonLayer): GeometryInstance[] {
  return (
    primitiveOf(layer) as unknown as { geometryInstances: GeometryInstance[] }
  ).geometryInstances;
}

function appearanceOf(layer: STTPolygonLayer): PerInstanceColorAppearance {
  return (
    primitiveOf(layer) as unknown as { appearance: PerInstanceColorAppearance }
  ).appearance;
}

/** Cesium sorts the pair, so the roof lands in `_height`. */
interface GeomInternals {
  _height: number;
  _extrudedHeight: number;
  _perPositionHeight: boolean;
  _polygonHierarchy: { positions: unknown[]; holes: unknown[] };
}

function geomOf(gi: GeometryInstance): GeomInternals {
  return gi.geometry as unknown as GeomInternals;
}

/** Attribute slots in the SAME order as the instances, once armed. */
function slotsInOrder(
  layer: STTPolygonLayer,
  store: Map<unknown, ArmedAttr>,
): ArmedAttr[] {
  return instancesOf(layer).map((gi) => {
    const slot = store.get(gi.id);
    expect(slot).toBeDefined();
    return slot as ArmedAttr;
  });
}

function polygonTile(
  positions: number[],
  startIndices: number[],
  startTimes: number[],
  endTimes: number[],
  partial: Partial<BinaryFeatures> = {},
  timeOffset = 0,
): Tile {
  const featureCount = startTimes.length;
  const features: BinaryFeatures = {
    featureCount,
    geometryType: GeometryType.Polygon,
    positionDimensions: 2,
    positions: new Float64Array(positions),
    startIndices: new Uint32Array(startIndices),
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
        name: 'polygons',
        extent: 0,
        features,
        geometryExtensionName: 'geoarrow.polygon',
      },
    ],
  };
}

/** A CLOSED ring (last vertex repeats the first), as the wire format writes it. */
function ring(lon: number, lat: number, size = 1): number[] {
  return [
    lon,
    lat,
    lon + size,
    lat,
    lon + size,
    lat + size,
    lon,
    lat + size,
    lon,
    lat,
  ];
}

const A = ring(10, 45);
const B = ring(-70, -30);

/** Two independent single-ring features. */
const TWO = [
  polygonTile([...A, ...B], [0, 5, 10], [0, 400], [200, 600], {
    ringIndices: new Uint32Array([0, 5, 10]),
    partIndices: new Uint32Array([0, 5, 10]),
  }),
];

/** ONE MultiPolygon feature with two disjoint members. */
const MULTI = [
  polygonTile([...A, ...B], [0, 10], [0], [500], {
    ringIndices: new Uint32Array([0, 5, 10]),
    partIndices: new Uint32Array([0, 5, 10]),
  }),
];

/** ONE polygon with a hole. */
const HOLED = [
  polygonTile([...ring(10, 45, 4), ...ring(11, 46, 1)], [0, 10], [0], [500], {
    ringIndices: new Uint32Array([0, 5, 10]),
    partIndices: new Uint32Array([0, 10]),
  }),
];

const OPAQUE = { type: 'constant' as const, color: [10, 20, 30, 255] as const };
/** A mode whose alpha actually VARIES across the fixture's two windows — a
 * plain window with no fade is 1 everywhere inside it, which would make the
 * "different features, different alphas" and "skip unchanged" checks vacuous. */
const WAKE = { wakeLength: 900 };

describe('STTPolygonLayer — construction and lifecycle', () => {
  it('registers a PrimitiveCollection into scene.primitives immediately', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene);
    expect(s.added).toHaveLength(1);
    expect(s.added[0]).toBeInstanceOf(PrimitiveCollection);
    expect(layer.id).toBe('stt-cesium-polygons');
  });

  it('honours an explicit id', () => {
    const s = stubScene();
    expect(new STTPolygonLayer(s.scene, { id: 'floods' }).id).toBe('floods');
  });

  it('dispose empties the collection AND unregisters it from the scene', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene);
    layer.setTiles(TWO);
    const coll = s.added[0] as PrimitiveCollection;
    expect(coll.length).toBe(1);
    layer.dispose();
    expect(coll.length).toBe(0); // the batched Primitive is destroyed, not leaked
    expect(s.removed).toEqual([coll]);
  });
});

describe('STTPolygonLayer — setTiles', () => {
  it('builds ONE batched primitive holding one instance per feature', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene);
    layer.setTiles(TWO);
    expect(primitiveOf(layer)).toBeInstanceOf(Primitive);
    const gis = instancesOf(layer);
    expect(gis).toHaveLength(2);
    expect(gis[0].geometry).toBeInstanceOf(PolygonGeometry);
  });

  it('emits one instance per PART with DISTINCT id objects', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, { id: 'iso' });
    layer.setTiles(MULTI);
    const gis = instancesOf(layer);
    // One FEATURE, two members → two instances that still name feature 0.
    expect(gis).toHaveLength(2);
    const ids = gis.map(
      (gi) => gi.id as { layerId: string; featureIndex: number },
    );
    expect(ids[0].featureIndex).toBe(0);
    expect(ids[1].featureIndex).toBe(0);
    expect(ids[0].layerId).toBe('iso');
    // ...and they are separate OBJECTS, because Cesium's batch table keys by ===.
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('carries holes through to the PolygonHierarchy', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene);
    layer.setTiles(HOLED);
    const gis = instancesOf(layer);
    expect(gis).toHaveLength(1);
    const h = geomOf(gis[0])._polygonHierarchy;
    expect(h.positions).toHaveLength(4); // ring opened
    expect(h.holes).toHaveLength(1);
  });

  it('holds the previous polygons when the new set is empty', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene);
    layer.setTiles(
      [polygonTile(A, [0, 5], [10], [200], {}, 1000)], // origin 1000
    );
    const before = primitiveOf(layer);
    layer.setTiles([]);
    // Same primitive object: nothing was torn down between a viewport change
    // and the first decoded tile of the new set.
    expect(primitiveOf(layer)).toBe(before);
    // ...and the time origin survives too, so the held geometry keeps animating.
    expect((layer as unknown as { timeOrigin: number }).timeOrigin).toBe(1000);
  });

  it('replaces everything on a non-empty rebuild', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene);
    layer.setTiles(TWO);
    const before = primitiveOf(layer);
    layer.setTiles(MULTI);
    expect(primitiveOf(layer)).not.toBe(before);
    expect(instancesOf(layer)).toHaveLength(2);
  });
});

describe('STTPolygonLayer — geometry shape', () => {
  it('draws a flat fill with per-vertex height and FLAT shading', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene);
    layer.setTiles(TWO);
    const g = geomOf(instancesOf(layer)[0]);
    expect(g._perPositionHeight).toBe(true);
    expect(g._height).toBe(g._extrudedHeight); // no prism
    // A fill has no meaningful normal, so the appearance drops the attribute.
    expect(appearanceOf(layer).flat).toBe(true);
    expect(appearanceOf(layer).vertexFormat.normal).toBe(false);
    expect(appearanceOf(layer).translucent).toBe(true); // alpha IS the animation
  });

  it('extrudes between two scalar heights and switches to LIT shading', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, {
      extrudedHeight: 2000,
      zLift: 50,
    });
    layer.setTiles(TWO);
    const g = geomOf(instancesOf(layer)[0]);
    // Cesium sorts the pair: the roof ends up in _height.
    expect(g._extrudedHeight).toBe(50);
    expect(g._height).toBe(2050);
    expect(g._perPositionHeight).toBe(false); // deviation 5: per-vertex z collapses
    expect(appearanceOf(layer).flat).toBe(false); // walls need normals to read as walls
    expect(appearanceOf(layer).vertexFormat.normal).toBe(true);
  });

  it('extrudes per feature from a numeric column', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, {
      extrudedHeightProperty: 'h',
      heightScale: 2,
    });
    layer.setTiles([
      polygonTile([...A, ...B], [0, 5, 10], [0, 0], [500, 500], {
        numericProps: { h: new Float32Array([100, 300]) },
      }),
    ]);
    const gis = instancesOf(layer);
    expect(geomOf(gis[0])._height).toBe(200);
    expect(geomOf(gis[1])._height).toBe(600);
  });

  it('lets `flat` be forced against the build', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, {
      extrudedHeight: 500,
      flat: true,
    });
    layer.setTiles(TWO);
    expect(appearanceOf(layer).flat).toBe(true);
    // The geometry must agree with the appearance or Cesium throws on a
    // missing normal attribute at draw time.
    expect(appearanceOf(layer).vertexFormat.normal).toBe(false);
  });
});

describe('STTPolygonLayer — setTime', () => {
  it('does nothing before the primitive is ready', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, { color: OPAQUE });
    layer.setTiles(TWO);
    expect(() => layer.setTime(100)).not.toThrow(); // no batch table yet
  });

  it('writes the oracle alpha, preserving the base RGB', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, {
      color: OPAQUE,
      mode: 'wake',
      timeFilter: WAKE,
    });
    layer.setTiles(TWO);
    const store = armPrimitive(primitiveOf(layer));
    layer.setTime(150);
    const [a, b] = slotsInOrder(layer, store);
    const expectAt = (start: number, end: number) =>
      Math.round(timeFilterAlpha('wake', 150, start, end, WAKE) * 255);
    expect([...a.bytes]).toEqual([10, 20, 30, expectAt(0, 200)]);
    expect([...b.bytes]).toEqual([10, 20, 30, expectAt(400, 600)]);
    // Different features, different alphas — a shared scratch that leaked its
    // reference would give both the last write.
    expect(a.bytes[3]).not.toBe(b.bytes[3]);
  });

  it('multiplies the time-filter alpha by the base colour alpha', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, {
      color: { type: 'constant', color: [1, 2, 3, 128] },
      mode: 'cumulative',
      timeFilter: { fadeIn: 0 },
    });
    layer.setTiles(TWO);
    const store = armPrimitive(primitiveOf(layer));
    layer.setTime(1000); // fully past both windows → oracle alpha 1
    const [a] = slotsInOrder(layer, store);
    expect(a.bytes[3]).toBe(Math.round((128 / 255) * 255));
  });

  it('gives every PART of one feature the same alpha, through its own slot', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, { color: OPAQUE });
    layer.setTiles(MULTI);
    const store = armPrimitive(primitiveOf(layer));
    layer.setTime(250);
    const slots = slotsInOrder(layer, store);
    expect(store.size).toBe(2); // two independent batch-table slots
    expect([...slots[0].bytes]).toEqual([...slots[1].bytes]);
    expect(slots[0].bytes[3]).toBeGreaterThan(0);
  });

  it('arms the batch table lazily and skips unchanged alphas', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, {
      color: OPAQUE,
      mode: 'wake',
      timeFilter: WAKE,
    });
    layer.setTiles(TWO);
    const prim = primitiveOf(layer);
    const store = armPrimitive(prim);
    expect(store.size).toBe(0); // nothing looked up before the first ready frame

    layer.setTime(150);
    expect(store.size).toBe(2);
    const slots = slotsInOrder(layer, store);
    expect(slots.map((x) => x.writes)).toEqual([1, 1]);

    layer.setTime(150); // same instant → same alpha → no GPU dirty
    expect(slots.map((x) => x.writes)).toEqual([1, 1]);

    layer.setTime(420); // moved: both features change
    expect(slots.map((x) => x.writes)).toEqual([2, 2]);
  });

  it('rebases the playhead onto the build time origin', () => {
    const s = stubScene();
    const mk = (timeOffset: number) =>
      polygonTile(A, [0, 5], [0], [200], {}, timeOffset);
    const shifted = new STTPolygonLayer(s.scene, {
      color: OPAQUE,
      mode: 'window',
      timeFilter: { windowHalf: 400 },
    });
    shifted.setTiles([mk(1_700_000_000_000)]);
    const store = armPrimitive(primitiveOf(shifted));
    shifted.setTime(1_700_000_000_150);
    const [slot] = slotsInOrder(shifted, store);
    expect(slot.bytes[3]).toBe(
      Math.round(
        timeFilterAlpha('window', 150, 0, 200, { windowHalf: 400 }) * 255,
      ),
    );
  });
});

describe('STTPolygonLayer — picking', () => {
  it('returns null when nothing is under the cursor', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene);
    layer.setTiles(TWO);
    expect(layer.pick(1, 2)).toBeNull();
  });

  it('returns null for another layer id', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, { id: 'mine' });
    layer.setTiles(TWO);
    s.setPick({ id: { layerId: 'theirs', binary: {}, featureIndex: 0 } });
    expect(layer.pick(1, 2)).toBeNull();
  });

  it('resolves the feature, its props and its coordinate', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, { id: 'mine' });
    layer.setTiles(TWO);
    s.setPick({ id: instancesOf(layer)[1].id });
    const hit = layer.pick(7, 9);
    expect(hit).not.toBeNull();
    expect(hit?.layerId).toBe('mine');
    expect(hit?.index).toBe(1);
    expect(hit?.screen).toEqual([7, 9]);
    expect(hit?.coordinate).toEqual([-70, -30]); // feature 1's first vertex
    expect(hit?.object).toBeTypeOf('object');
  });

  it('resolves EITHER member of a MultiPolygon to the one feature', () => {
    const s = stubScene();
    const layer = new STTPolygonLayer(s.scene, { id: 'mine' });
    layer.setTiles(MULTI);
    for (const gi of instancesOf(layer)) {
      s.setPick({ id: gi.id });
      const hit = layer.pick(0, 0);
      expect(hit?.index).toBe(0);
      expect(hit?.coordinate).toEqual([10, 45]);
    }
  });
});
