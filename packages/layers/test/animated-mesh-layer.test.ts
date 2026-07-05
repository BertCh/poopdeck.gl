/**
 * AnimatedMeshLayer tests.
 *
 * The layer renders ONE CPU-interpolated 3D MODEL per tracked object — the mesh
 * analog of AnimatedBoundingBoxLayer. It pools the object snapshots across all
 * loaded tiles (rebased to absolute time, via the SHARED track kernel), groups
 * them by `track_id`, and once per frame emits a single instance per ACTIVE
 * track, its pose interpolated between the two keyframes bracketing the playhead.
 * Rendering is a `SimpleMeshLayer` (`@deck.gl/mesh-layers`) instancing a STATIC
 * per-layer `mesh` (glTF/OBJ) — or a per-category `meshMapping` — with
 * per-instance `getPosition`, `getOrientation` (interpolated heading → yaw deg +
 * orientationOffset), `getScale` ([length,width,height] when scaleToDimensions)
 * and a per-instance `getColor` RGBA (category via colorMapping × a CPU fade).
 *
 * These tests drive `renderLayers()` directly (via Object.create, bypassing
 * CompositeLayer's lifecycle) with a deck.gl mock that captures the constructed
 * sublayer props. They pin: construction defaults, cross-tile pooling + track
 * grouping into one model per track, pose interpolation, inactive-track
 * exclusion, the per-instance color bake, SimpleMeshLayer prop forwarding,
 * per-category meshMapping dispatch, and the picking object shape.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

// ---------------------------------------------------------------------------
// deck.gl mocks — the mesh sublayer constructor just stashes its props.
// ---------------------------------------------------------------------------

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/mesh-layers', () => {
  class FakeSimpleMeshLayer implements CapturedLayer {
    static layerName = 'SimpleMeshLayer';
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { SimpleMeshLayer: FakeSimpleMeshLayer };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RAD_TO_DEG = 180 / Math.PI;
const DEG = Math.PI / 180;

// Per-instance orientation/scale reach the GPU via FUNCTION accessors (deck's
// SimpleMeshLayer ignores a binary data.attributes.getOrientation/getScale — it
// folds them into the computed instanceModelMatrix, built from the props). So
// the tests read the value the matrix updater actually consumes: the accessor's
// return for a given instance index.
const oriOf = (layer: any, i = 0): number[] => layer.props.getOrientation(null, { index: i });
const sclOf = (layer: any, i = 0): number[] => layer.props.getScale(null, { index: i });

/** A sentinel mesh source (the layer forwards it verbatim to SimpleMeshLayer). */
const MESH = { kind: 'gltf', id: 'car' };
const MESH_CAR = { kind: 'gltf', id: 'car-model' };
const MESH_PED = { kind: 'gltf', id: 'ped-model' };

/** Build a categorical {indices, categories} column from string values. */
function categorical(values: string[]): { indices: Uint16Array; categories: string[] } {
  const categories: string[] = [];
  const map = new Map<string, number>();
  const indices = new Uint16Array(values.length);
  values.forEach((v, i) => {
    let idx = map.get(v);
    if (idx === undefined) {
      idx = categories.length;
      categories.push(v);
      map.set(v, idx);
    }
    indices[i] = idx;
  });
  return { indices, categories };
}

interface ObjRow {
  lon: number;
  lat: number;
  /** Time RELATIVE to the tile timeOffset. */
  t: number;
  track?: string;
  category?: string;
  heading?: number;
  length?: number;
  width?: number;
  height?: number;
  speed?: number;
}

/** Build a fake object (point) tile of tracked-object snapshots. */
function makeObjTile(
  rows: ObjRow[],
  opts: { timeOffset?: number; tileId?: { z: number; x: number; y: number; t: number } } = {},
): Tile {
  const tile = makePointTile({
    positions: rows.map((r) => [r.lon, r.lat]),
    startTimes: rows.map((r) => r.t),
    endTimes: rows.map((r) => r.t), // instantaneous snapshots
    timeOffset: opts.timeOffset ?? 0,
    tileId: opts.tileId,
  });
  const f = tile.layers[0].features;
  if (rows.some((r) => r.track !== undefined)) {
    f.categoricalProps['track_id'] = categorical(rows.map((r) => r.track ?? ''));
  }
  if (rows.some((r) => r.category !== undefined)) {
    f.categoricalProps['category'] = categorical(rows.map((r) => r.category ?? ''));
  }
  for (const col of ['heading', 'length', 'width', 'height', 'speed'] as const) {
    if (rows.some((r) => r[col] !== undefined)) {
      f.numericProps[col] = new Float32Array(rows.map((r) => (r[col] ?? NaN) as number));
    }
  }
  return tile;
}

// ---------------------------------------------------------------------------
describe('AnimatedMeshLayer', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let render: (tiles: Tile[], time: number, opts?: any) => any[];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-mesh-layer');
    LayerCtor = mod.AnimatedMeshLayer as any;

    makeLayer = (opts = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — drive renderLayers
      // (and its pooling/interpolation) directly.
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        mesh: MESH,
        meshMapping: null,
        texture: null,
        textureParameters: null,
        trackIdProperty: 'track_id',
        colorProperty: null,
        getColor: null,
        colorMapping: null,
        colorMappingDefault: [255, 255, 255, 255],
        headingProperty: 'heading',
        orientationOffset: [0, 0, 0],
        lengthProperty: 'length',
        widthProperty: 'width',
        heightProperty: 'height',
        scaleToDimensions: true,
        sizeScale: 1,
        getTranslation: [0, 0, 0],
        defaultLength: 4,
        defaultWidth: 2,
        defaultHeight: 1.6,
        material: true,
        wireframe: false,
        _instanced: true,
        // Default OFF in these tests so colors aren't dimmed by fades unless a
        // test opts in.
        fadeInDuration: 0,
        fadeOutDuration: 0,
        speedProperty: 'speed',
        labelProperty: 'category',
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer._currentTime = 0;
      layer.trackIndex = null;
      layer.trackIndexKey = '';
      layer.lastTilesRef = null;
      return layer;
    };

    render = (tiles, time, opts = {}) => {
      const layer = makeLayer(opts);
      layer.state = { tiles };
      layer._currentTime = time;
      return (layer as any).renderLayers();
    };
  });

  // ── Construction ─────────────────────────────────────────────────────────

  it('exposes the static layerName + own + base defaults', () => {
    expect(LayerCtor.layerName).toBe('AnimatedMeshLayer');
    expect(LayerCtor.defaultProps.trackIdProperty).toBe('track_id');
    expect(LayerCtor.defaultProps.headingProperty).toBe('heading');
    expect(LayerCtor.defaultProps.lengthProperty).toBe('length');
    expect(LayerCtor.defaultProps.scaleToDimensions).toBe(true);
    expect(LayerCtor.defaultProps.sizeScale.value).toBe(1);
    expect(LayerCtor.defaultProps.defaultLength.value).toBe(4);
    expect(LayerCtor.defaultProps.mesh.value).toBe(null);
    expect(LayerCtor.defaultProps.meshMapping.value).toBe(null);
    expect(LayerCtor.defaultProps.getColor.value).toBe(null);
    expect(LayerCtor.defaultProps.colorMappingDefault.value).toEqual([255, 255, 255, 255]);
    expect(LayerCtor.defaultProps.orientationOffset.value).toEqual([0, 0, 0]);
    expect(LayerCtor.defaultProps.getTranslation.value).toEqual([0, 0, 0]);
    expect(LayerCtor.defaultProps.material.value).toBe(true);
    expect(LayerCtor.defaultProps.wireframe).toBe(false);
    expect(LayerCtor.defaultProps._instanced).toBe(true);
    expect(LayerCtor.defaultProps.fadeInDuration.value).toBe(200);
    // Base defaults spread in.
    expect(LayerCtor.defaultProps.timeWindow).toBeDefined();
    expect(LayerCtor.defaultProps.tier).toBeDefined();
  });

  // ── One model per track (the core anti-"train" guarantee) ────────────────

  it('collapses many keyframes of one track into a SINGLE model', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 10, lat: 0, t: 1000 },
      { track: 'A', lon: 20, lat: 0, t: 2000 },
      { track: 'A', lon: 30, lat: 0, t: 3000 },
    ]);
    const layers = render([tile], 1500);
    expect(layers.length).toBe(1);
    expect(layers[0].constructor.layerName).toBe('SimpleMeshLayer');
    const data = layers[0].props.data;
    expect(data.length).toBe(1); // ONE model, not four
    // Halfway between the t=1000 (lon10) and t=2000 (lon20) keyframes.
    expect(data.attributes.getPosition.value[0]).toBeCloseTo(15, 6);
    expect(data.attributes.getPosition.value[1]).toBeCloseTo(0, 6);
    // The static mesh rides through to SimpleMeshLayer verbatim.
    expect(layers[0].props.mesh).toBe(MESH);
  });

  it('renders one model PER track (distinct objects stay distinct)', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'B', lon: 5, lat: 5, t: 0 },
      { track: 'A', lon: 10, lat: 0, t: 1000 },
      { track: 'B', lon: 5, lat: 15, t: 1000 },
    ]);
    const data = render([tile], 500)[0].props.data;
    expect(data.length).toBe(2);
  });

  it('pools a track whose keyframes span MULTIPLE tiles with different timeOffsets', () => {
    const a = makeObjTile([{ track: 'A', lon: 0, lat: 0, t: 0 }], {
      timeOffset: 1000,
      tileId: { z: 16, x: 1, y: 2, t: 0 },
    });
    const b = makeObjTile([{ track: 'A', lon: 10, lat: 0, t: 2000 }], {
      timeOffset: 0,
      tileId: { z: 16, x: 1, y: 2, t: 1 },
    });
    // Absolute playhead 1500 → halfway between abs 1000 and abs 2000.
    const data = render([a, b], 1500)[0].props.data;
    expect(data.length).toBe(1);
    expect(data.attributes.getPosition.value[0]).toBeCloseTo(5, 6);
  });

  it('excludes a track whose keyframe span does not contain the playhead', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 10, lat: 0, t: 1000 },
    ]);
    expect(render([tile], 5000)).toEqual([]);
  });

  // ── Orientation ───────────────────────────────────────────────────────────

  it('bakes interpolated heading into getOrientation [pitch, heading°, roll] (yaw slot)', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, heading: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000, heading: Math.PI / 2 },
    ]);
    const ori = oriOf(render([tile], 500)[0]);
    expect(ori[0]).toBe(0); // pitch
    expect(ori[2]).toBe(0); // roll
    expect(ori[1]).toBeCloseTo((Math.PI / 4) * RAD_TO_DEG, 4); // 45° yaw
  });

  it('interpolates heading along the SHORTEST arc across the ±180° seam', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, heading: 170 * DEG },
      { track: 'A', lon: 0, lat: 0, t: 1000, heading: -170 * DEG },
    ]);
    const ori = oriOf(render([tile], 500)[0]);
    expect(Math.abs(ori[1])).toBeCloseTo(180, 3);
  });

  it('adds the constant orientationOffset to every slot', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, heading: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000, heading: 0 },
    ]);
    const ori = oriOf(render([tile], 500, { orientationOffset: [5, 90, -10] })[0]);
    expect(ori[0]).toBeCloseTo(5, 5); // pitch offset
    expect(ori[1]).toBeCloseTo(90, 5); // heading 0 + yaw offset 90
    expect(ori[2]).toBeCloseTo(-10, 5); // roll offset
  });

  it('leaves models axis-aligned (yaw = 0) when no heading column', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 10, lat: 0, t: 1000 },
    ]);
    const ori = oriOf(render([tile], 500)[0]);
    expect(Array.from(ori)).toEqual([0, 0, 0]);
  });

  it('feeds DISTINCT per-instance heading + dims to the getOrientation/getScale accessors', () => {
    // Two tracks with different headings + dims: the accessors deck's matrix
    // updater calls MUST return each instance's own pose (a binary
    // data.attributes.getOrientation/getScale would be dropped by SimpleMeshLayer).
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, heading: 0, length: 4, width: 2, height: 1.6 },
      { track: 'A', lon: 0, lat: 0, t: 1000, heading: 0, length: 4, width: 2, height: 1.6 },
      { track: 'B', lon: 1, lat: 0, t: 0, heading: Math.PI / 2, length: 6, width: 2.5, height: 3 },
      { track: 'B', lon: 1, lat: 0, t: 1000, heading: Math.PI / 2, length: 6, width: 2.5, height: 3 },
    ]);
    const layer = render([tile], 500)[0];
    // getOrientation / getScale are function accessors (not binary attributes).
    expect(typeof layer.props.getOrientation).toBe('function');
    expect(typeof layer.props.getScale).toBe('function');
    expect(layer.props.data.attributes.getOrientation).toBeUndefined();
    expect(layer.props.data.attributes.getScale).toBeUndefined();
    // Instance 0 (track A): heading 0, dims 4/2/1.6.
    expect(oriOf(layer, 0)[1]).toBeCloseTo(0, 4);
    expect(sclOf(layer, 0)).toEqual([4, 2, expect.closeTo(1.6, 4)]);
    // Instance 1 (track B): heading 90°, dims 6/2.5/3.
    expect(oriOf(layer, 1)[1]).toBeCloseTo(90, 3);
    expect(sclOf(layer, 1)).toEqual([6, expect.closeTo(2.5, 4), 3]);
  });

  // ── Scale ─────────────────────────────────────────────────────────────────

  it('bakes length/width/height into getScale when scaleToDimensions (default)', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, length: 4.5, width: 1.8, height: 1.6 },
      { track: 'A', lon: 0, lat: 0, t: 1000, length: 4.5, width: 1.8, height: 1.6 },
    ]);
    const scl = sclOf(render([tile], 500)[0]);
    // Raw dims (no ×0.5 — a glTF model isn't a ±1 cube); SimpleMeshLayer's own
    // sizeScale multiplies on top.
    expect(scl[0]).toBeCloseTo(4.5, 5);
    expect(scl[1]).toBeCloseTo(1.8, 5);
    expect(scl[2]).toBeCloseTo(1.6, 5);
  });

  it('uses native size getScale [1,1,1] when scaleToDimensions is false', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, length: 4.5, width: 1.8, height: 1.6 },
      { track: 'A', lon: 0, lat: 0, t: 1000, length: 4.5, width: 1.8, height: 1.6 },
    ]);
    const scl = sclOf(render([tile], 500, { scaleToDimensions: false })[0]);
    expect(Array.from(scl)).toEqual([1, 1, 1]);
  });

  it('falls back to constant default dims when no dim columns are present', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    const scl = sclOf(render([tile], 500, {
      defaultLength: 6,
      defaultWidth: 3,
      defaultHeight: 2,
    })[0]);
    expect(scl[0]).toBeCloseTo(6, 5);
    expect(scl[1]).toBeCloseTo(3, 5);
    expect(scl[2]).toBeCloseTo(2, 5);
  });

  it('honors custom heading/length/track-id property names', () => {
    const tile = makePointTile({
      positions: [[0, 0], [0, 0]],
      startTimes: [0, 1000],
      endTimes: [0, 1000],
      timeOffset: 0,
    });
    const f = tile.layers[0].features;
    f.categoricalProps['tid'] = categorical(['A', 'A']);
    f.numericProps['yaw'] = new Float32Array([0, Math.PI / 2]);
    f.numericProps['len_m'] = new Float32Array([4, 4]);
    const layer = render([tile], 1000, {
      trackIdProperty: 'tid',
      headingProperty: 'yaw',
      lengthProperty: 'len_m',
    })[0];
    expect(sclOf(layer)[0]).toBeCloseTo(4, 5);
    expect(oriOf(layer)[1]).toBeCloseTo(90, 3);
  });

  // ── Per-instance color ────────────────────────────────────────────────────

  it('bakes category color into a per-instance RGBA getColor via colorMapping', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
      { track: 'B', lon: 1, lat: 1, t: 0, category: 'pedestrian' },
      { track: 'B', lon: 1, lat: 1, t: 1000, category: 'pedestrian' },
    ]);
    const data = render([tile], 500, {
      colorProperty: 'category',
      colorMapping: {
        car: [80, 170, 255, 255],
        pedestrian: [255, 90, 90, 255],
      },
    })[0].props.data;
    const color = data.attributes.getColor;
    expect(color.size).toBe(4);
    expect(color.normalized).toBe(true);
    expect(color.value).toBeInstanceOf(Uint8Array);
    expect(data.length).toBe(2);
    expect(Array.from(color.value.slice(0, 4))).toEqual([80, 170, 255, 255]);
    expect(Array.from(color.value.slice(4, 8))).toEqual([255, 90, 90, 255]);
  });

  it('uses colorMappingDefault (white) for every model when colorProperty is unset', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    const color = render([tile], 500)[0].props.data.attributes.getColor.value;
    expect(Array.from(color.slice(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it('lets a constant getColor alias paint every model, overriding colorProperty', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
    ]);
    const color = render([tile], 500, {
      colorProperty: 'category',
      colorMapping: { car: [80, 170, 255, 255] },
      getColor: [12, 34, 56, 255], // constant wins
    })[0].props.data.attributes.getColor.value;
    expect(Array.from(color.slice(0, 4))).toEqual([12, 34, 56, 255]);
  });

  it('treats a string getColor alias as the category column name', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
    ]);
    const color = render([tile], 500, {
      getColor: 'category',
      colorMapping: { car: [1, 2, 3, 255] },
    })[0].props.data.attributes.getColor.value;
    expect(Array.from(color.slice(0, 4))).toEqual([1, 2, 3, 255]);
  });

  it('ramps the model alpha over fadeInDuration just after the track starts', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
    ]);
    const color = render([tile], 100, {
      colorProperty: 'category',
      colorMapping: { car: [80, 170, 255, 255] },
      fadeInDuration: 200,
    })[0].props.data.attributes.getColor.value;
    expect(color[3]).toBeCloseTo(128, -0.5);
    expect(color[3]).toBeLessThan(200);
  });

  // ── SimpleMeshLayer prop forwarding ───────────────────────────────────────

  it('forwards SimpleMeshLayer style props (sizeScale/material/wireframe/_instanced/texture/getTranslation)', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    const tex = { url: 'car.png' };
    const props = render([tile], 500, {
      sizeScale: 3,
      material: false,
      wireframe: true,
      _instanced: false,
      texture: tex,
      getTranslation: [0, 0, 0.8],
    })[0].props;
    expect(props.sizeScale).toBe(3);
    expect(props.material).toBe(false);
    expect(props.wireframe).toBe(true);
    expect(props._instanced).toBe(false);
    expect(props.texture).toBe(tex);
    expect(props.getTranslation).toEqual([0, 0, 0.8]);
    expect(props.pickable).toBe(true);
  });

  // ── Per-category meshMapping dispatch ─────────────────────────────────────

  it('emits one SimpleMeshLayer per category with its mapped mesh when meshMapping is set', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
      { track: 'B', lon: 1, lat: 1, t: 0, category: 'pedestrian' },
      { track: 'B', lon: 1, lat: 1, t: 1000, category: 'pedestrian' },
    ]);
    const layers = render([tile], 500, {
      colorProperty: 'category',
      meshMapping: { car: MESH_CAR, pedestrian: MESH_PED },
    });
    expect(layers.length).toBe(2);
    // Track insertion order: A (car) then B (pedestrian).
    expect(layers[0].props.mesh).toBe(MESH_CAR);
    expect(layers[0].props.data.length).toBe(1);
    expect(layers[1].props.mesh).toBe(MESH_PED);
    expect(layers[1].props.data.length).toBe(1);
  });

  it('falls back to the base mesh for categories absent from meshMapping', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
      { track: 'B', lon: 1, lat: 1, t: 0, category: 'cyclist' },
      { track: 'B', lon: 1, lat: 1, t: 1000, category: 'cyclist' },
    ]);
    const layers = render([tile], 500, {
      colorProperty: 'category',
      mesh: MESH,
      meshMapping: { car: MESH_CAR }, // no cyclist entry → base MESH
    });
    expect(layers.length).toBe(2);
    expect(layers[0].props.mesh).toBe(MESH_CAR);
    expect(layers[1].props.mesh).toBe(MESH); // fallback
  });

  it('keeps a sublayer mounted (empty instance buffer) for a mapped category with no active tracks', () => {
    // Only 'car' is active this frame; 'pedestrian' is mapped but has no active
    // track. The pedestrian sublayer must still be emitted (empty) so its Model
    // stays uploaded across frames — no destroy/rebuild churn + async pop-in.
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
    ]);
    const layers = render([tile], 500, {
      colorProperty: 'category',
      meshMapping: { car: MESH_CAR, pedestrian: MESH_PED },
    });
    expect(layers.length).toBe(2);
    // Mapped categories keep their sublayer + mesh regardless of active count.
    expect(layers[0].props.mesh).toBe(MESH_CAR);
    expect(layers[0].props.data.length).toBe(1);
    expect(layers[1].props.mesh).toBe(MESH_PED);
    expect(layers[1].props.data.length).toBe(0); // persisted, but no instances
  });

  // ── Fade + texture (deck ignores getColor when a texture is set) ──────────

  it('warns once that fadeInDuration/fadeOutDuration have no effect with a texture set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    render([tile], 500, { texture: { url: 'car.png' }, fadeInDuration: 200 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/texture.*ignores.*getColor|fade/i);
    warn.mockRestore();
  });

  it('does NOT warn about fade when no texture is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    render([tile], 500, { fadeInDuration: 200 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // ── No-mesh guard ─────────────────────────────────────────────────────────

  it('renders nothing when neither mesh nor meshMapping is provided', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    expect(render([tile], 500, { mesh: null, meshMapping: null })).toEqual([]);
  });

  // ── Picking ──────────────────────────────────────────────────────────────

  it('attaches per-track pick rows and resolves info.object on a hit', () => {
    const tile = makeObjTile([
      { track: 't-7', lon: 0, lat: 0, t: 0, category: 'car', heading: 0, length: 4, width: 2, height: 1.6, speed: 8 },
      { track: 't-7', lon: 10, lat: 0, t: 1000, category: 'car', heading: 0, length: 4, width: 2, height: 1.6, speed: 8 },
    ]);
    const layer = makeLayer({ colorProperty: 'category' });
    layer.state = { tiles: [tile] };
    layer._currentTime = 500;
    const mesh = (layer as any).renderLayers()[0];
    const rows = mesh.props.sttPickRows;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(mesh.props.sttPickStride).toBe(1);
    expect(rows[0].track_id).toBe('t-7');
    expect(rows[0].category).toBe('car');

    const info: any = { index: 0 };
    const out = (layer as any).getPickingInfo({ info, sourceLayer: mesh });
    expect(out.object.track_id).toBe('t-7');
    expect(out.object.category).toBe('car');
    expect(out.object.length).toBeCloseTo(4, 6);
    expect(out.object.speed).toBeCloseTo(8, 6);
  });

  it('resolves picks within the correct per-category sublayer', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
      { track: 'B', lon: 5, lat: 0, t: 0, category: 'pedestrian' },
      { track: 'B', lon: 5, lat: 0, t: 1000, category: 'pedestrian' },
    ]);
    const layer = makeLayer({
      colorProperty: 'category',
      meshMapping: { car: MESH_CAR, pedestrian: MESH_PED },
    });
    layer.state = { tiles: [tile] };
    layer._currentTime = 500;
    const layers = (layer as any).renderLayers();
    const pedLayer = layers[1];
    const out = (layer as any).getPickingInfo({ info: { index: 0 }, sourceLayer: pedLayer });
    expect(out.object.track_id).toBe('B');
    expect(out.object.category).toBe('pedestrian');
  });

  // ── Caching / lifecycle ──────────────────────────────────────────────────

  it('rebuilds the pooled index when the tile set changes', () => {
    const layer = makeLayer();
    const a = makeObjTile(
      [
        { track: 'A', lon: 0, lat: 0, t: 0 },
        { track: 'A', lon: 10, lat: 0, t: 1000 },
      ],
      { tileId: { z: 16, x: 1, y: 2, t: 0 } },
    );
    layer.state = { tiles: [a] };
    layer._currentTime = 500;
    (layer as any).renderLayers();
    const firstIndex = (layer as any).trackIndex;
    // Same tiles ref → cached index reused.
    (layer as any).renderLayers();
    expect((layer as any).trackIndex).toBe(firstIndex);
    // New tiles array → rebuild.
    layer.state = {
      tiles: [
        a,
        makeObjTile(
          [
            { track: 'B', lon: 1, lat: 1, t: 0 },
            { track: 'B', lon: 2, lat: 1, t: 1000 },
          ],
          { tileId: { z: 16, x: 1, y: 3, t: 0 } },
        ),
      ],
    };
    (layer as any).renderLayers();
    expect((layer as any).trackIndex).not.toBe(firstIndex);
    expect((layer as any).trackIndex.size).toBe(2);
  });

  it('returns [] for an empty tile set', () => {
    expect(render([], 0)).toEqual([]);
  });
});
