/**
 * AnimatedScenegraphLayer tests.
 *
 * The layer is `AnimatedMeshLayer` with deck's `ScenegraphLayer` as its render
 * engine instead of `SimpleMeshLayer` — mirroring deck's own two-layer split for
 * flat meshes vs full glTF scenegraphs. It exists to place AUTHORED assets (an
 * OpenUSD / Omniverse export converted to glTF) at each tracked object's
 * interpolated pose.
 *
 * The subclass overrides only the four "engine seams", so these tests
 * deliberately do NOT re-test the inherited machinery (pooling, interpolation,
 * fades, grow-only buffers, picking — covered in animated-mesh-layer.test.ts).
 * They pin exactly what the subclass changes:
 *
 *  • the sublayer CLASS is ScenegraphLayer and the short id is `scenegraph`;
 *  • the asset rides deck's `scenegraph` prop, with `scenegraphMapping` for the
 *    per-category split, and BOTH fall back to the inherited `mesh`/`meshMapping`
 *    so one config drives either engine;
 *  • `scaleToDimensions` defaults to FALSE (an authored asset is already in real
 *    metres — the inherited `true` would squash it);
 *  • the SimpleMesh-only props (`texture`, `wireframe`, `_instanced`, `material`)
 *    are NOT forwarded, and setting them warns once;
 *  • the scenegraph-only props are forwarded, with the optional ones spread in
 *    only when set so deck's own defaults survive;
 *  • `_animations` warns about deck's timeline clock (verified constraint: deck
 *    drives the GLTFAnimator from `context.timeline`, not the STT playhead);
 *  • the inherited pose bake reaches ScenegraphLayer unchanged.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

// ---------------------------------------------------------------------------
// deck.gl mocks — both engine constructors just stash their props, so a test
// can assert WHICH one was constructed as well as with what.
// ---------------------------------------------------------------------------

vi.mock('@deck.gl/mesh-layers', () => {
  class FakeSimpleMeshLayer {
    static layerName = 'SimpleMeshLayer';
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeScenegraphLayer {
    static layerName = 'ScenegraphLayer';
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return {
    SimpleMeshLayer: FakeSimpleMeshLayer,
    ScenegraphLayer: FakeScenegraphLayer,
  };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// ---------------------------------------------------------------------------
// Helpers (mirroring animated-mesh-layer.test.ts)
// ---------------------------------------------------------------------------

const RAD_TO_DEG = 180 / Math.PI;

const oriOf = (layer: any, i = 0): number[] =>
  layer.props.getOrientation(null, { index: i });
const sclOf = (layer: any, i = 0): number[] =>
  layer.props.getScale(null, { index: i });

/** Sentinel asset sources — the layer forwards them verbatim. */
const GLB = { kind: 'gltf', id: 'vehicle.glb' };
const GLB_CAR = { kind: 'gltf', id: 'car.glb' };
const GLB_PED = { kind: 'gltf', id: 'ped.glb' };
const MESH = { kind: 'gltf', id: 'legacy-mesh' };

function categorical(values: string[]): {
  indices: Uint16Array;
  categories: string[];
} {
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
  t: number;
  track?: string;
  category?: string;
  heading?: number;
  length?: number;
  width?: number;
  height?: number;
}

function makeObjTile(rows: ObjRow[]): Tile {
  const tile = makePointTile({
    positions: rows.map((r) => [r.lon, r.lat]),
    startTimes: rows.map((r) => r.t),
    endTimes: rows.map((r) => r.t),
    timeOffset: 0,
  });
  const f = tile.layers[0].features;
  if (rows.some((r) => r.track !== undefined)) {
    f.categoricalProps['track_id'] = categorical(
      rows.map((r) => r.track ?? ''),
    );
  }
  if (rows.some((r) => r.category !== undefined)) {
    f.categoricalProps['category'] = categorical(
      rows.map((r) => r.category ?? ''),
    );
  }
  for (const col of ['heading', 'length', 'width', 'height'] as const) {
    if (rows.some((r) => r[col] !== undefined)) {
      f.numericProps[col] = new Float32Array(
        rows.map((r) => (r[col] ?? NaN) as number),
      );
    }
  }
  return tile;
}

// ---------------------------------------------------------------------------
describe('AnimatedScenegraphLayer', () => {
  let LayerCtor: any;
  let MeshCtor: any;
  let render: (tiles: Tile[], time: number, opts?: any) => any[];
  let warnSpy: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-scenegraph-layer');
    LayerCtor = mod.AnimatedScenegraphLayer as any;
    MeshCtor = (await import('../src/layers/core/animated-mesh-layer'))
      .AnimatedMeshLayer as any;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const makeLayer = (opts: any = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — drive renderLayers
      // (and its inherited pooling/interpolation) directly.
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        // The engine asset + its inherited alias, both unset unless a test opts in.
        scenegraph: GLB,
        scenegraphMapping: null,
        mesh: null,
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
        // The subclass DEFAULT is false; the harness bypasses defaultProps, so
        // spell it out to match what deck would have merged in.
        scaleToDimensions: false,
        sizeScale: 1,
        getTranslation: [0, 0, 0],
        defaultLength: 4,
        defaultWidth: 2,
        defaultHeight: 1.6,
        material: true,
        wireframe: false,
        _instanced: true,
        _lighting: 'flat',
        _imageBasedLightingEnvironment: null,
        _animations: null,
        sizeMinPixels: 0,
        sizeMaxPixels: Number.MAX_SAFE_INTEGER,
        getScene: null,
        getAnimator: null,
        onFirstDraw: null,
        scenegraphLoadOptions: null,
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

  /** A one-track tile whose playhead-1500 pose is well defined. */
  const oneTrack = (extra: Partial<ObjRow> = {}) =>
    makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 1000, ...extra },
      { track: 'A', lon: 10, lat: 0, t: 2000, ...extra },
    ]);

  // ── Construction / identity ───────────────────────────────────────────────

  it('is an AnimatedMeshLayer subclass with its own layerName', () => {
    expect(LayerCtor.layerName).toBe('AnimatedScenegraphLayer');
    expect(LayerCtor.prototype instanceof MeshCtor).toBe(true);
  });

  it('does NOT collide with deck.gl own ScenegraphLayer export name', () => {
    // The catalog-wide rule: an app imports @deck.gl/* and @poopdeck.gl/* into
    // one module, so no export may share a name with deck's.
    expect(LayerCtor.layerName).not.toBe('ScenegraphLayer');
  });

  it('inherits the base defaults and adds the scenegraph ones', () => {
    // Inherited, unchanged.
    expect(LayerCtor.defaultProps.trackIdProperty).toBe('track_id');
    expect(LayerCtor.defaultProps.headingProperty).toBe('heading');
    expect(LayerCtor.defaultProps.timeWindow).toBeDefined();
    expect(LayerCtor.defaultProps.colorMappingDefault.value).toEqual([
      255, 255, 255, 255,
    ]);
    // Own.
    expect(LayerCtor.defaultProps.scenegraph.value).toBe(null);
    expect(LayerCtor.defaultProps.scenegraphMapping.value).toBe(null);
    expect(LayerCtor.defaultProps._lighting).toBe('flat');
    expect(LayerCtor.defaultProps._animations.value).toBe(null);
    expect(LayerCtor.defaultProps.sizeMinPixels.value).toBe(0);
    expect(LayerCtor.defaultProps.sizeMaxPixels.value).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('FLIPS scaleToDimensions to false (an authored asset is already in metres)', () => {
    expect(MeshCtor.defaultProps.scaleToDimensions).toBe(true);
    expect(LayerCtor.defaultProps.scaleToDimensions).toBe(false);
  });

  // ── The engine swap ───────────────────────────────────────────────────────

  it('renders a ScenegraphLayer, not a SimpleMeshLayer', () => {
    const layers = render([oneTrack()], 1500);
    expect(layers.length).toBe(1);
    expect(layers[0].constructor.layerName).toBe('ScenegraphLayer');
  });

  it("forwards the asset on deck's `scenegraph` prop (no `mesh` prop)", () => {
    const props = render([oneTrack()], 1500)[0].props;
    expect(props.scenegraph).toBe(GLB);
    expect(props.mesh).toBeUndefined();
  });

  it('uses the `scenegraph` sublayer short id', () => {
    // composeSubLayerProps builds `${shortId}-${instanceKey}` into the id.
    const props = render([oneTrack()], 1500)[0].props;
    expect(String(props.id)).toContain('scenegraph');
    expect(String(props.id)).not.toContain('mesh');
  });

  it('does NOT forward the SimpleMesh-only props', () => {
    const props = render([oneTrack()], 1500, {
      material: { ambient: 0.5 },
      wireframe: true,
      _instanced: true,
      texture: 'tex.png',
      textureParameters: { magFilter: 'linear' },
    })[0].props;
    expect(props.material).toBeUndefined();
    expect(props.wireframe).toBeUndefined();
    expect(props._instanced).toBeUndefined();
    expect(props.texture).toBeUndefined();
    expect(props.textureParameters).toBeUndefined();
  });

  // ── Asset resolution + the inherited alias ────────────────────────────────

  it('falls back to the inherited `mesh` when `scenegraph` is unset', () => {
    const props = render([oneTrack()], 1500, {
      scenegraph: null,
      mesh: MESH,
    })[0].props;
    expect(props.scenegraph).toBe(MESH);
  });

  it('prefers `scenegraph` over `mesh` when both are set', () => {
    const props = render([oneTrack()], 1500, {
      scenegraph: GLB,
      mesh: MESH,
    })[0].props;
    expect(props.scenegraph).toBe(GLB);
  });

  it('splits per category via scenegraphMapping, falling back to `scenegraph`', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
      { track: 'A', lon: 10, lat: 0, t: 2000, category: 'car' },
      { track: 'B', lon: 1, lat: 1, t: 1000, category: 'pedestrian' },
      { track: 'B', lon: 2, lat: 1, t: 2000, category: 'pedestrian' },
      { track: 'C', lon: 3, lat: 3, t: 1000, category: 'bus' },
      { track: 'C', lon: 4, lat: 3, t: 2000, category: 'bus' },
    ]);
    const layers = render([tile], 1500, {
      colorProperty: 'category',
      scenegraphMapping: { car: GLB_CAR, pedestrian: GLB_PED },
    });
    const byAsset = new Map<any, number>();
    for (const l of layers) {
      byAsset.set(
        l.props.scenegraph,
        (byAsset.get(l.props.scenegraph) ?? 0) + l.props.data.length,
      );
    }
    expect(byAsset.get(GLB_CAR)).toBe(1);
    expect(byAsset.get(GLB_PED)).toBe(1);
    // `bus` is unmapped → the `scenegraph` fallback carries it.
    expect(byAsset.get(GLB)).toBe(1);
    expect(
      layers.every((l: any) => l.constructor.layerName === 'ScenegraphLayer'),
    ).toBe(true);
  });

  it('falls back to the inherited `meshMapping` when scenegraphMapping is unset', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
      { track: 'A', lon: 10, lat: 0, t: 2000, category: 'car' },
    ]);
    const layers = render([tile], 1500, {
      colorProperty: 'category',
      scenegraph: null,
      scenegraphMapping: null,
      meshMapping: { car: GLB_CAR },
    });
    expect(layers.some((l: any) => l.props.scenegraph === GLB_CAR)).toBe(true);
  });

  it('renders nothing and warns when no asset is set at all', () => {
    const layers = render([oneTrack()], 1500, {
      scenegraph: null,
      scenegraphMapping: null,
      mesh: null,
      meshMapping: null,
    });
    expect(layers).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('AnimatedScenegraphLayer'),
    );
  });

  // ── Scenegraph-only prop forwarding ───────────────────────────────────────

  it('forwards _lighting / sizeMinPixels / sizeMaxPixels always', () => {
    const props = render([oneTrack()], 1500, {
      _lighting: 'pbr',
      sizeMinPixels: 4,
      sizeMaxPixels: 200,
    })[0].props;
    expect(props._lighting).toBe('pbr');
    expect(props.sizeMinPixels).toBe(4);
    expect(props.sizeMaxPixels).toBe(200);
  });

  it('omits the optional pass-throughs when unset so deck defaults survive', () => {
    const props = render([oneTrack()], 1500)[0].props;
    for (const key of [
      '_animations',
      '_imageBasedLightingEnvironment',
      'getScene',
      'getAnimator',
      'onFirstDraw',
      'loadOptions',
      'loaders',
    ]) {
      expect(props, `${key} should be absent`).not.toHaveProperty(key);
    }
  });

  it('forwards the optional pass-throughs when set', () => {
    const getScene = () => ({});
    const getAnimator = () => ({});
    const onFirstDraw = () => {};
    const env = { specularEnvSampler: 1 };
    const animations = { '*': { playing: true, speed: 2 } };
    const props = render([oneTrack()], 1500, {
      _lighting: 'pbr',
      _imageBasedLightingEnvironment: env,
      _animations: animations,
      getScene,
      getAnimator,
      onFirstDraw,
    })[0].props;
    expect(props._imageBasedLightingEnvironment).toBe(env);
    expect(props._animations).toBe(animations);
    expect(props.getScene).toBe(getScene);
    expect(props.getAnimator).toBe(getAnimator);
    expect(props.onFirstDraw).toBe(onFirstDraw);
  });

  it('maps scenegraphLoadOptions onto the sublayer `loadOptions`', () => {
    // The base repurposes deck's `loadOptions` as SttLoadOptions for archive
    // HTTP and does not forward it, so glTF load options need this own prop.
    const opts = { gltf: { decompressMeshes: true } };
    const props = render([oneTrack()], 1500, {
      scenegraphLoadOptions: opts,
    })[0].props;
    expect(props.loadOptions).toBe(opts);
  });

  // ── Warnings for the verified deck-level constraints ──────────────────────

  it("warns that _animations runs on deck's timeline, not the playhead", () => {
    render([oneTrack()], 1500, { _animations: { '*': { playing: true } } });
    const messages = warnSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(messages.some((m: string) => m.includes('context.timeline'))).toBe(
      true,
    );
    expect(messages.some((m: string) => m.includes('_animate'))).toBe(true);
  });

  it('warns when an IBL environment is set without _lighting: pbr', () => {
    render([oneTrack()], 1500, {
      _imageBasedLightingEnvironment: { specularEnvSampler: 1 },
      _lighting: 'flat',
    });
    const messages = warnSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(messages.some((m: string) => m.includes('_lighting'))).toBe(true);
  });

  it('warns that inherited SimpleMesh props are inert here', () => {
    render([oneTrack()], 1500, { wireframe: true, texture: 'tex.png' });
    const messages = warnSpy.mock.calls.map((c: any[]) => String(c[0]));
    const inert = messages.find((m: string) => m.includes('no effect here'));
    expect(inert).toBeDefined();
    expect(inert).toContain('wireframe');
    expect(inert).toContain('texture');
  });

  it("does NOT inherit the mesh layer's texture-defeats-fade warning", () => {
    // ScenegraphLayer MULTIPLIES getColor into the material, so the CPU fade
    // works on a textured/PBR asset — the inherited warning would be wrong.
    render([oneTrack()], 1500, {
      texture: 'tex.png',
      fadeInDuration: 200,
      fadeOutDuration: 200,
    });
    const messages = warnSpy.mock.calls.map((c: any[]) => String(c[0]));
    expect(messages.some((m: string) => m.includes('pop in/out'))).toBe(false);
  });

  // ── The inherited pose bake still reaches the new engine ──────────────────

  it('bakes the interpolated position/heading through to ScenegraphLayer', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 1000, heading: 0 },
      { track: 'A', lon: 10, lat: 0, t: 2000, heading: Math.PI / 2 },
    ]);
    const layer = render([tile], 1500)[0];
    expect(layer.props.data.attributes.getPosition.value[0]).toBeCloseTo(5, 6);
    // Heading rides the YAW slot of deck's [pitch, yaw, roll], in degrees.
    expect(oriOf(layer)[1]).toBeCloseTo((Math.PI / 4) * RAD_TO_DEG, 4);
  });

  it('leaves scale at [1,1,1] under the flipped scaleToDimensions default', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 1000, length: 5, width: 2, height: 1.8 },
      {
        track: 'A',
        lon: 10,
        lat: 0,
        t: 2000,
        length: 5,
        width: 2,
        height: 1.8,
      },
    ]);
    expect(sclOf(render([tile], 1500)[0])).toEqual([1, 1, 1]);
  });

  it('still honours scaleToDimensions: true when explicitly opted back in', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 1000, length: 5, width: 2, height: 1.8 },
      {
        track: 'A',
        lon: 10,
        lat: 0,
        t: 2000,
        length: 5,
        width: 2,
        height: 1.8,
      },
    ]);
    const scl = sclOf(render([tile], 1500, { scaleToDimensions: true })[0]);
    expect(scl[0]).toBeCloseTo(5, 5);
    expect(scl[1]).toBeCloseTo(2, 5);
    expect(scl[2]).toBeCloseTo(1.8, 5);
  });

  it('carries the per-category color bake (getColor multiplies the material)', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
      { track: 'A', lon: 10, lat: 0, t: 2000, category: 'car' },
    ]);
    const props = render([tile], 1500, {
      colorProperty: 'category',
      colorMapping: { car: [10, 20, 30, 255] },
    })[0].props;
    const c = props.data.attributes.getColor.value;
    expect([c[0], c[1], c[2], c[3]]).toEqual([10, 20, 30, 255]);
  });

  it('keeps the stable pose accessors + explicit updateTriggers', () => {
    const layer = render([oneTrack()], 1500)[0];
    expect(typeof layer.props.getOrientation).toBe('function');
    expect(typeof layer.props.getScale).toBe('function');
    // deck reports every function accessor "equal", so the revision counter is
    // what actually invalidates the pose.
    expect(layer.props.updateTriggers.getOrientation).toBeGreaterThan(0);
    expect(layer.props.updateTriggers.getScale).toBeGreaterThan(0);
  });

  it('keeps the lazy pick-row plumbing', () => {
    const layer = render([oneTrack()], 1500)[0];
    expect(layer.props.sttPickSamples.length).toBe(1);
    expect(layer.props.sttPickStride).toBe(1);
  });
});
