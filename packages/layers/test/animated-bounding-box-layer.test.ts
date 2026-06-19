/**
 * AnimatedBoundingBoxLayer tests.
 *
 * The layer renders ONE CPU-interpolated oriented 3D box per tracked object: it
 * pools the object snapshots across all loaded tiles (rebased to absolute time),
 * groups them by `track_id`, and once per frame emits a single box per ACTIVE
 * track, its pose interpolated between the two keyframes bracketing the playhead.
 * Rendering is a `SimpleMeshLayer` (`@deck.gl/mesh-layers`) instanced over a unit
 * `CubeGeometry`, with per-instance `getOrientation` (interpolated heading →
 * z-rotation degrees), `getScale` ([length,width,height] × 0.5 × sizeScale),
 * `getTranslation` (ground-lift by height/2) and a per-instance `getColor` RGBA
 * (category via colorMapping, × a CPU appear/disappear fade). See the layer's
 * file header.
 *
 * These tests exercise `renderLayers()` directly (via Object.create, bypassing
 * CompositeLayer's lifecycle) with a deck.gl mock that captures the constructed
 * sublayer props. They pin: construction defaults, cross-tile pooling +
 * track grouping into one box per track, position/heading/dim interpolation,
 * inactive-track exclusion, the per-instance color bake, the optional
 * label/velocity sublayers, and the picking object shape.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile } from './fake-tile';
import type { Tile } from '@poopdeck.gl/core';

// ---------------------------------------------------------------------------
// deck.gl mocks — each sublayer constructor just stashes its props.
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

vi.mock('@deck.gl/layers', () => {
  class FakeTextLayer implements CapturedLayer {
    static layerName = 'TextLayer';
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeLineLayer implements CapturedLayer {
    static layerName = 'LineLayer';
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { TextLayer: FakeTextLayer, LineLayer: FakeLineLayer };
});

vi.mock('@luma.gl/engine', () => {
  class FakeCubeGeometry {
    constructor(public props?: Record<string, any>) {}
  }
  return { CubeGeometry: FakeCubeGeometry };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RAD_TO_DEG = 180 / Math.PI;
const DEG = Math.PI / 180;

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
describe('AnimatedBoundingBoxLayer', () => {
  let LayerCtor: any;
  let makeLayer: (opts?: any) => any;
  let render: (tiles: Tile[], time: number, opts?: any) => any[];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/layers/core/animated-bounding-box-layer');
    LayerCtor = mod.AnimatedBoundingBoxLayer as any;

    makeLayer = (opts = {}) => {
      // Object.create bypasses CompositeLayer's lifecycle — drive renderLayers
      // (and its pooling/interpolation) directly.
      const layer = Object.create(LayerCtor.prototype);
      layer.props = {
        id: 'test',
        trackIdProperty: 'track_id',
        colorProperty: null,
        colorMapping: null,
        colorMappingDefault: [160, 160, 160, 255],
        headingProperty: 'heading',
        lengthProperty: 'length',
        widthProperty: 'width',
        heightProperty: 'height',
        sizeScale: 1,
        defaultLength: 4,
        defaultWidth: 2,
        defaultHeight: 1.6,
        wireframe: false,
        material: true,
        // Default OFF in these tests so colors aren't dimmed by edge fades
        // unless a test opts in.
        fadeInDuration: 0,
        fadeOutDuration: 0,
        showLabels: false,
        labelProperty: 'category',
        showVelocity: false,
        speedProperty: 'speed',
        velocityScale: 1.5,
        velocityMinSpeed: 0.3,
        velocityColor: [80, 255, 220, 255],
        velocityWidthMinPixels: 2,
        opacity: 1,
        visible: true,
        ...opts,
      };
      layer._currentTime = 0;
      layer.trackIndex = null;
      layer.trackIndexKey = '';
      layer.lastTilesRef = null;
      layer.hasSpeedColumn = false;
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
    expect(LayerCtor.layerName).toBe('AnimatedBoundingBoxLayer');
    expect(LayerCtor.defaultProps.trackIdProperty).toBe('track_id');
    expect(LayerCtor.defaultProps.headingProperty).toBe('heading');
    expect(LayerCtor.defaultProps.lengthProperty).toBe('length');
    expect(LayerCtor.defaultProps.widthProperty).toBe('width');
    expect(LayerCtor.defaultProps.heightProperty).toBe('height');
    expect(LayerCtor.defaultProps.sizeScale.value).toBe(1);
    expect(LayerCtor.defaultProps.defaultLength.value).toBe(4);
    expect(LayerCtor.defaultProps.wireframe).toBe(false);
    expect(LayerCtor.defaultProps.showLabels).toBe(false);
    expect(LayerCtor.defaultProps.labelProperty).toBe('category');
    expect(LayerCtor.defaultProps.showVelocity).toBe(false);
    expect(LayerCtor.defaultProps.speedProperty).toBe('speed');
    expect(LayerCtor.defaultProps.velocityColor.value).toEqual([80, 255, 220, 255]);
    // Base defaults spread in.
    expect(LayerCtor.defaultProps.timeWindow).toBeDefined();
    expect(LayerCtor.defaultProps.tier).toBeDefined();
  });

  // ── One box per track (the core anti-"train" guarantee) ──────────────────

  it('collapses many keyframes of one track into a SINGLE box', () => {
    // Four snapshots of track 'A' marching east — the old window mode showed
    // all four ("train"); now exactly one interpolated box renders.
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 10, lat: 0, t: 1000 },
      { track: 'A', lon: 20, lat: 0, t: 2000 },
      { track: 'A', lon: 30, lat: 0, t: 3000 },
    ]);
    const layers = render([tile], 1500);
    expect(layers.length).toBe(1); // boxes only
    const data = layers[0].props.data;
    expect(data.length).toBe(1); // ONE box, not four
    // Halfway between the t=1000 (lon10) and t=2000 (lon20) keyframes.
    expect(data.attributes.getPosition.value[0]).toBeCloseTo(15, 6);
    expect(data.attributes.getPosition.value[1]).toBeCloseTo(0, 6);
  });

  it('renders one box PER track (distinct objects stay distinct)', () => {
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
    // Keyframe 1 lives in tile A (offset 1000, rel 0 → abs 1000, lon 0).
    // Keyframe 2 lives in tile B (offset 0, rel 2000 → abs 2000, lon 10).
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
    // Playhead past the track's last keyframe → no box → no sublayers.
    expect(render([tile], 5000)).toEqual([]);
  });

  // ── Interpolation ────────────────────────────────────────────────────────

  it('interpolates heading along the SHORTEST arc across the ±180° seam', () => {
    // 170° → -170° should pass through 180°, not collapse toward 0°.
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, heading: 170 * DEG },
      { track: 'A', lon: 0, lat: 0, t: 1000, heading: -170 * DEG },
    ]);
    const ori = render([tile], 500)[0].props.data.attributes.getOrientation.value;
    // z carries the heading in degrees; mid-arc is 180° (≡ -180°), never 0°.
    expect(Math.abs(ori[2])).toBeCloseTo(180, 3);
  });

  it('bakes interpolated heading into getOrientation [0, 0, heading°]', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, heading: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000, heading: Math.PI / 2 },
    ]);
    const ori = render([tile], 500)[0].props.data.attributes.getOrientation.value;
    expect(ori[0]).toBe(0);
    expect(ori[1]).toBe(0);
    expect(ori[2]).toBeCloseTo((Math.PI / 4) * RAD_TO_DEG, 4); // 45°
  });

  it('leaves boxes axis-aligned (orientation z = 0) when no heading column', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 10, lat: 0, t: 1000 },
    ]);
    const ori = render([tile], 500)[0].props.data.attributes.getOrientation.value;
    expect(Array.from(ori)).toEqual([0, 0, 0]);
  });

  it('bakes length/width/height into getScale × 0.5 (CubeGeometry spans ±1) and ground-lift', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, length: 4.5, width: 1.8, height: 1.6 },
      { track: 'A', lon: 0, lat: 0, t: 1000, length: 4.5, width: 1.8, height: 1.6 },
    ]);
    const attrs = render([tile], 500)[0].props.data.attributes;
    expect(attrs.getScale.value[0]).toBeCloseTo(2.25, 5); // 4.5 / 2
    expect(attrs.getScale.value[1]).toBeCloseTo(0.9, 5); // 1.8 / 2
    expect(attrs.getScale.value[2]).toBeCloseTo(0.8, 5); // 1.6 / 2
    // Lift = height/2 so the base rests on the ground.
    expect(attrs.getTranslation.value[2]).toBeCloseTo(0.8, 5);
  });

  it('falls back to constant default dims when no dim columns are present', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    const attrs = render([tile], 500, {
      defaultLength: 6,
      defaultWidth: 3,
      defaultHeight: 2,
    })[0].props.data.attributes;
    expect(attrs.getScale.value[0]).toBeCloseTo(3, 5); // 6/2
    expect(attrs.getScale.value[1]).toBeCloseTo(1.5, 5); // 3/2
    expect(attrs.getScale.value[2]).toBeCloseTo(1, 5); // 2/2
    expect(attrs.getTranslation.value[2]).toBeCloseTo(1, 5); // 2/2
  });

  it('applies sizeScale uniformly to scale and ground-lift', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, length: 4, width: 2, height: 1.6 },
      { track: 'A', lon: 0, lat: 0, t: 1000, length: 4, width: 2, height: 1.6 },
    ]);
    const attrs = render([tile], 500, { sizeScale: 2 })[0].props.data.attributes;
    expect(attrs.getScale.value[0]).toBeCloseTo(4, 5); // 4 × 0.5 × 2
    expect(attrs.getScale.value[2]).toBeCloseTo(1.6, 5); // 1.6 × 0.5 × 2
    expect(attrs.getTranslation.value[2]).toBeCloseTo(1.6, 5); // 1.6/2 × 2
  });

  it('honors custom heading/length/width/height/track-id property names', () => {
    const tile = makePointTile({
      positions: [[0, 0], [0, 0]],
      startTimes: [0, 1000],
      endTimes: [0, 1000],
      timeOffset: 0,
    });
    const f = tile.layers[0].features;
    f.categoricalProps['tid'] = categorical(['A', 'A']);
    f.numericProps['yaw'] = new Float32Array([0, Math.PI]);
    f.numericProps['len_m'] = new Float32Array([4, 4]);
    f.numericProps['wid_m'] = new Float32Array([2, 2]);
    f.numericProps['hgt_m'] = new Float32Array([2, 2]);
    const attrs = render([tile], 1000, {
      trackIdProperty: 'tid',
      headingProperty: 'yaw',
      lengthProperty: 'len_m',
      widthProperty: 'wid_m',
      heightProperty: 'hgt_m',
    })[0].props.data.attributes;
    expect(attrs.getScale.value[0]).toBeCloseTo(2, 5); // 4/2
    // yaw π at t=1000 → ±180° (the same orientation; Float32 π may land on -180).
    expect(Math.abs(attrs.getOrientation.value[2])).toBeCloseTo(180, 3);
  });

  // ── Per-instance category color ──────────────────────────────────────────

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
    // Order follows track insertion (A then B): car, then pedestrian.
    expect(Array.from(color.value.slice(0, 4))).toEqual([80, 170, 255, 255]);
    expect(Array.from(color.value.slice(4, 8))).toEqual([255, 90, 90, 255]);
  });

  it('uses colorMappingDefault for categories absent from colorMapping', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'barrier' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'barrier' },
    ]);
    const color = render([tile], 500, {
      colorProperty: 'category',
      colorMapping: { car: [80, 170, 255, 255] },
      colorMappingDefault: [50, 50, 50, 255],
    })[0].props.data.attributes.getColor.value;
    expect(Array.from(color.slice(0, 4))).toEqual([50, 50, 50, 255]);
  });

  it('uses colorMappingDefault for every box when colorProperty is unset', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    const color = render([tile], 500, { colorMappingDefault: [10, 20, 30, 255] })[0].props
      .data.attributes.getColor.value;
    expect(Array.from(color.slice(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it('ramps the box alpha over fadeInDuration just after the track starts', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
    ]);
    // 100ms into a 200ms fade-in → alpha ≈ 0.5 → 255 × 0.5.
    const color = render([tile], 100, {
      colorProperty: 'category',
      colorMapping: { car: [80, 170, 255, 255] },
      fadeInDuration: 200,
    })[0].props.data.attributes.getColor.value;
    expect(color[3]).toBeCloseTo(128, -0.5);
    expect(color[3]).toBeLessThan(200);
  });

  // ── Optional label + velocity sublayers ──────────────────────────────────

  it('emits ONLY the boxes sublayer when labels/velocity are off (default)', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, speed: 5 },
      { track: 'A', lon: 0, lat: 0, t: 1000, speed: 5 },
    ]);
    const layers = render([tile], 500);
    expect(layers.length).toBe(1);
    expect(layers[0].props.mesh).toBeDefined();
  });

  it('adds a TextLayer label sublayer with one row per active box when showLabels is on', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car' },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car' },
      { track: 'B', lon: 1, lat: 1, t: 0, category: 'pedestrian' },
      { track: 'B', lon: 1, lat: 1, t: 1000, category: 'pedestrian' },
    ]);
    const layers = render([tile], 500, { showLabels: true });
    expect(layers.length).toBe(2);
    const labels = layers[1];
    expect(labels.constructor.layerName).toBe('TextLayer');
    const data = labels.props.data;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
    expect(labels.props.getText(data[0])).toBe('car');
    expect(labels.props.getText(data[1])).toBe('pedestrian');
    expect(labels.props.billboard).toBe(true);
    expect(labels.props.getPixelOffset).toEqual([0, -16]);
    expect(labels.props.getColor).toEqual([255, 255, 255, 255]);
  });

  it('reads a custom labelProperty (e.g. track_id) for the label text', () => {
    const tile = makePointTile({
      positions: [[0, 0], [0, 0]],
      startTimes: [0, 1000],
      endTimes: [0, 1000],
      timeOffset: 0,
    });
    tile.layers[0].features.categoricalProps['track_id'] = categorical(['t-7', 't-7']);
    const layers = render([tile], 500, { showLabels: true, labelProperty: 'track_id' });
    const data = layers[1].props.data;
    expect(layers[1].props.getText(data[0])).toBe('t-7');
  });

  it('adds a LineLayer velocity sublayer offset by (vx,vy)·scale when showVelocity is on', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, heading: 0, speed: 10 }, // east
      { track: 'A', lon: 0, lat: 0, t: 1000, heading: 0, speed: 10 },
    ]);
    const layers = render([tile], 500, { showVelocity: true, velocityScale: 2 });
    expect(layers.length).toBe(2);
    const vel = layers[1];
    expect(vel.constructor.layerName).toBe('LineLayer');
    const attrs = vel.props.data.attributes;
    const src = attrs.getSourcePosition.value;
    const tgt = attrs.getTargetPosition.value;
    // Heading east, 10 m/s × 2 = 20 m → +lon, lat unchanged.
    expect(src[0]).toBe(0);
    expect(tgt[0]).toBeCloseTo(20 / 111320, 8);
    expect(tgt[1]).toBeCloseTo(0, 8);
    expect(vel.props.getColor).toEqual([80, 255, 220, 255]);
    expect(vel.props.widthMinPixels).toBe(2);
  });

  it('collapses the velocity arrow to zero length below velocityMinSpeed', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 5, lat: 10, t: 0, heading: 0, speed: 0.1 }, // < 0.3
      { track: 'A', lon: 5, lat: 10, t: 1000, heading: 0, speed: 0.1 },
    ]);
    const attrs = render([tile], 500, { showVelocity: true })[1].props.data.attributes;
    const src = attrs.getSourcePosition.value;
    const tgt = attrs.getTargetPosition.value;
    expect(tgt[0]).toBe(src[0]);
    expect(tgt[1]).toBe(src[1]);
  });

  it('omits the velocity sublayer when no speed column is present', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000 },
    ]);
    const layers = render([tile], 500, { showVelocity: true });
    expect(layers.length).toBe(1); // boxes only
  });

  it('emits boxes + labels + velocity together (3 sublayers) when both are on', () => {
    const tile = makeObjTile([
      { track: 'A', lon: 0, lat: 0, t: 0, category: 'car', speed: 5, heading: 0 },
      { track: 'A', lon: 0, lat: 0, t: 1000, category: 'car', speed: 5, heading: 0 },
    ]);
    const layers = render([tile], 500, { showLabels: true, showVelocity: true });
    expect(layers.length).toBe(3);
    expect(layers[0].props.mesh).toBeDefined();
    expect(layers[1].constructor.layerName).toBe('TextLayer');
    expect(layers[2].constructor.layerName).toBe('LineLayer');
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
    const boxes = (layer as any).renderLayers()[0];
    const rows = boxes.props.sttPickRows;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(1);
    expect(rows[0].track_id).toBe('t-7');
    expect(rows[0].category).toBe('car');

    // getPickingInfo reads the hit row off the source sublayer.
    const info: any = { index: 0 };
    const out = (layer as any).getPickingInfo({ info, sourceLayer: boxes });
    expect(out.object.track_id).toBe('t-7');
    expect(out.object.category).toBe('car');
    expect(out.object.length).toBeCloseTo(4, 6);
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
    layer.state = { tiles: [a, makeObjTile([{ track: 'B', lon: 1, lat: 1, t: 0 }, { track: 'B', lon: 2, lat: 1, t: 1000 }], { tileId: { z: 16, x: 1, y: 3, t: 0 } })] };
    (layer as any).renderLayers();
    expect((layer as any).trackIndex).not.toBe(firstIndex);
    expect((layer as any).trackIndex.size).toBe(2);
  });

  it('returns [] for an empty tile set', () => {
    expect(render([], 0)).toEqual([]);
  });
});
