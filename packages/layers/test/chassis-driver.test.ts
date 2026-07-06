/**
 * Shared per-tile-sublayer chassis driver.
 *
 * Every animated-* layer copy-pastes its OWN private `renderLayers` /
 * `prepareTile` / `buildSublayer`; the chassis assertions therefore have to run
 * against EACH layer, not one shared function. This `describe.each` driver runs
 * the shared per-tile-sublayer contract against every layer that carried a
 * chassis block, so removing those blocks from the dedicated files loses no
 * coverage — the same assertions run here, per layer.
 *
 * The layer-SPECIFIC behaviour (arc endpoints, icon pixelOffset/heading, column
 * elevation, point-cloud normals/colour, path per-vertex colour, trips
 * vertex-times, polygon per-vertex time, cumulative slabs, splat/flow-corridor)
 * stays in each layer's own file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  makeLayerHarness,
  bigPointTile,
  bigPathTile,
  odTile,
  bigPolygonTile,
  type LayerHarness,
} from './harness';

// ---------------------------------------------------------------------------
// deck.gl mocks — one factory returning every layer class the chassis needs.
// Each mocked class just stashes its constructor props (no GPU).
// ---------------------------------------------------------------------------

vi.mock('@deck.gl/layers', () => {
  const stash = (name: string) => {
    const cls = class {
      props: Record<string, any>;
      constructor(props: Record<string, any>) {
        this.props = props;
      }
    };
    Object.defineProperty(cls, 'name', { value: name });
    return cls;
  };
  return {
    ScatterplotLayer: stash('ScatterplotLayer'),
    PathLayer: stash('PathLayer'),
    SolidPolygonLayer: stash('SolidPolygonLayer'),
    ArcLayer: stash('ArcLayer'),
    LineLayer: stash('LineLayer'),
    IconLayer: stash('IconLayer'),
    ColumnLayer: stash('ColumnLayer'),
    PointCloudLayer: stash('PointCloudLayer'),
  };
});

// SplatLayer's custom-Model primitive imports luma (no GPU here); some core
// layers pull it in at module-eval time. Swap it for a prop-stashing stand-in.
vi.mock('../src/layers/internal/splat-primitive-layer', () => {
  class FakeSplatPrimitiveLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { SplatPrimitiveLayer: FakeSplatPrimitiveLayer };
});

vi.mock('@deck.gl/core', async () =>
  (await import('./fake-deck-core')).createDeckCoreMock(),
);

// ---------------------------------------------------------------------------
// Per-layer case config
// ---------------------------------------------------------------------------

const ICON_ATLAS = 'https://example.test/atlas.png';
const ICON_MAPPING = {
  vessel: { x: 0, y: 0, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true },
};

interface LayerCase {
  /** display name for the parametrized describe block */
  name: string;
  /** literal dynamic import returning the layer ctor */
  load: () => Promise<any>;
  /** base `layer.props` the ctor would set */
  props: Record<string, any>;
  /** build a valid tile of `n` features for this layer */
  makeTile: (n: number) => any;
  /** a baked layer-level prop that must invalidate the sublayer cache */
  rebuildProp: { key: string; value: any };
  /** optional extra instance-field setup (e.g. trips getEffectiveTimeWindow) */
  init?: (layer: any) => void;
}

/** Layers with the full per-tile sublayer chassis (all 7 shared assertions). */
const FULL_CASES: LayerCase[] = [
  {
    name: 'AnimatedPointLayer',
    load: () =>
      import('../src/layers/core/animated-point-layer').then((m) => m.AnimatedPointLayer),
    props: {
      id: 'test',
      fillColor: [255, 128, 0, 255],
      radius: 5,
      radiusUnits: 'pixels',
      timeWindow: 1000,
      opacity: 1,
      visible: true,
    },
    makeTile: (n) => bigPointTile(n),
    rebuildProp: { key: 'radiusScale', value: 7 },
  },
  {
    name: 'AnimatedTripsLayer',
    load: () =>
      import('../src/layers/trips/animated-trips-layer').then((m) => m.AnimatedTripsLayer),
    props: {
      id: 'trips',
      tripColor: [253, 128, 93, 255],
      tripWidth: 2,
      timeWindow: 1000,
      trailLength: 500,
      opacity: 1,
      visible: true,
    },
    makeTile: (n) => bigPathTile(n, 4),
    rebuildProp: { key: 'trailLength', value: 12345 },
    init: (layer) => {
      layer.getEffectiveTimeWindow = () => 1000;
    },
  },
  {
    name: 'AnimatedPolygonLayer',
    load: () =>
      import('../src/layers/core/animated-polygon-layer').then((m) => m.AnimatedPolygonLayer),
    props: {
      id: 'poly',
      fillColor: [255, 140, 0, 180],
      timeWindow: 1000,
      opacity: 1,
      visible: true,
      filled: true,
      extruded: false,
      elevation: 0,
    },
    makeTile: (n) => bigPolygonTile(n),
    rebuildProp: { key: 'extruded', value: true },
  },
  {
    name: 'AnimatedArcLayer',
    load: () =>
      import('../src/layers/core/animated-arc-layer').then((m) => m.AnimatedArcLayer),
    props: {
      id: 'arcs',
      sourceColor: [0, 150, 255, 255],
      targetColor: [255, 127, 14, 255],
      width: 2,
      widthUnits: 'pixels',
      greatCircle: false,
      arcHeight: 1,
      arcTilt: 0,
      timeWindow: 1000,
      opacity: 1,
      visible: true,
    },
    makeTile: (n) => odTile(n),
    rebuildProp: { key: 'widthScale', value: 7 },
  },
  {
    name: 'AnimatedIconLayer',
    load: () =>
      import('../src/layers/core/animated-icon-layer').then((m) => m.AnimatedIconLayer),
    props: {
      id: 'test',
      icon: 'vessel',
      iconAtlas: ICON_ATLAS,
      iconMapping: ICON_MAPPING,
      angle: 0,
      color: [255, 255, 255, 255],
      size: 12,
      pixelOffset: [0, 0],
      sizeUnits: 'pixels',
      sizeBasis: 'height',
      alphaCutoff: 0.05,
      textureParameters: null,
      fadeInDuration: 300,
      fadeOutDuration: 300,
      timeWindow: 1000,
      opacity: 1,
      visible: true,
    },
    makeTile: (n) => bigPointTile(n),
    rebuildProp: { key: 'sizeScale', value: 7 },
  },
  {
    name: 'AnimatedColumnLayer',
    load: () =>
      import('../src/layers/core/animated-column-layer').then((m) => m.AnimatedColumnLayer),
    props: {
      id: 'test',
      fillColor: [255, 140, 0, 255],
      elevation: 1000,
      elevationScale: 1,
      radius: 100,
      radiusUnits: 'meters',
      diskResolution: 20,
      extruded: true,
      filled: true,
      stroked: false,
      lineColor: [0, 0, 0, 255],
      lineWidth: 1,
      lineWidthUnits: 'meters',
      lineWidthScale: 1,
      lineWidthMinPixels: 0,
      lineWidthMaxPixels: Number.MAX_SAFE_INTEGER,
      material: true,
      timeWindow: 1000,
      fadeInDuration: 300,
      fadeOutDuration: 300,
      opacity: 1,
      visible: true,
    },
    makeTile: (n) => bigPointTile(n),
    rebuildProp: { key: 'elevationScale', value: 9 },
  },
  {
    name: 'AnimatedPointCloudLayer',
    load: () =>
      import('../src/layers/core/animated-point-cloud-layer').then(
        (m) => m.AnimatedPointCloudLayer,
      ),
    props: {
      id: 'test',
      sizeUnits: 'pixels',
      pointSize: 10,
      material: true,
      color: [255, 255, 255, 255],
      getColor: null,
      colorPalette: undefined,
      colorMapping: null,
      colorMappingDefault: [0, 0, 0, 0],
      rgbColorColumns: null,
      colorVectorColumn: 'point_rgba',
      normalColumn: 'normal',
      elevationProperty: null,
      elevationScale: 1,
      timeWindow: 1000,
      timeHeightScale: 0,
      timeHeightOrigin: 0,
      fadeInDuration: 300,
      fadeOutDuration: 300,
      opacity: 1,
      visible: true,
    },
    makeTile: (n) => bigPointTile(n),
    rebuildProp: { key: 'pointSize', value: 25 },
  },
];

/** Layers whose only shared chassis assertion is the dataComparator. */
const COMPARATOR_ONLY_CASES: LayerCase[] = [
  {
    name: 'AnimatedPathLayer',
    load: () =>
      import('../src/layers/core/animated-path-layer').then((m) => m.AnimatedPathLayer),
    props: {
      id: 'test',
      pathColor: [31, 186, 214, 255],
      pathWidth: 2,
      widthUnits: 'pixels',
      timeWindow: 1000,
      opacity: 1,
      visible: true,
    },
    makeTile: (n) => bigPathTile(n, 4),
    rebuildProp: { key: 'widthScale', value: 7 },
  },
  {
    name: 'AnimatedLineLayer',
    load: () =>
      import('../src/layers/core/animated-line-layer').then((m) => m.AnimatedLineLayer),
    props: {
      id: 'lines',
      color: [0, 150, 255, 255],
      width: 1,
      widthUnits: 'pixels',
      timeWindow: 1000,
      opacity: 1,
      visible: true,
    },
    makeTile: (n) => odTile(n),
    rebuildProp: { key: 'widthScale', value: 7 },
  },
];

const idA = { z: 14, x: 1, y: 2, t: 0 };
const idB = { z: 14, x: 1, y: 3, t: 0 };

// ---------------------------------------------------------------------------
// Shared assertions — run once per FULL_CASES layer.
// ---------------------------------------------------------------------------

describe.each(FULL_CASES)('$name — shared per-tile sublayer chassis', (c) => {
  let h: LayerHarness;

  beforeEach(async () => {
    // Fresh import each test so the vi.mock's above are applied.
    vi.resetModules();
    const Ctor = await c.load();
    h = makeLayerHarness(Ctor, c.props, c.init);
  });

  it('builds one sublayer per tile (no cross-tile consolidation)', () => {
    const layer = h.makeLayer();
    const a = c.makeTile(20);
    a.id = { ...idA };
    const b = c.makeTile(15);
    b.id = { ...idB };
    const sublayers = h.render(layer, [a, b]);
    expect(sublayers.length).toBe(2);
  });

  it("uses each tile's own timeOffset (no cross-tile rebasing)", () => {
    const layer = h.makeLayer();
    const a = c.makeTile(3);
    a.id = { ...idA };
    a.layers[0].features.timeOffset = 1_700_000_000_000;
    const b = c.makeTile(3);
    b.id = { ...idB };
    b.layers[0].features.timeOffset = 1_700_086_400_000;
    const [subA, subB] = h.render(layer, [a, b]);
    expect(subA.props.timeOffset).toBe(1_700_000_000_000);
    expect(subB.props.timeOffset).toBe(1_700_086_400_000);
  });

  it('caches PreparedTile so the data object reference is stable across renders', () => {
    const layer = h.makeLayer();
    const tile = c.makeTile(5);
    const first = layer.prepareTile(tile, tile.layers[0]);
    const second = layer.prepareTile(tile, tile.layers[0]);
    expect(second).toBe(first);
    expect(second.data).toBe(first.data);
  });

  it('returns the SAME sublayer instance per tile across renders when nothing changed', () => {
    const layer = h.makeLayer();
    const a = c.makeTile(3);
    a.id = { ...idA };
    const b = c.makeTile(3);
    b.id = { ...idB };
    layer.state = { tiles: [a, b] };
    const first = layer.renderLayers();
    const second = layer.renderLayers();
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('rebuilds the cached sublayer when a tile-level prop changes', () => {
    const layer = h.makeLayer();
    const tile = c.makeTile(3);
    layer.state = { tiles: [tile] };
    const first = layer.renderLayers();
    layer.props[c.rebuildProp.key] = c.rebuildProp.value;
    const second = layer.renderLayers();
    expect(second[0]).not.toBe(first[0]);
    expect(second[0].props[c.rebuildProp.key]).toBe(c.rebuildProp.value);
  });

  it('drops sublayer-cache entries for tiles that leave the visible set', () => {
    const layer = h.makeLayer();
    const a = c.makeTile(3);
    a.id = { ...idA };
    const b = c.makeTile(3);
    b.id = { ...idB };
    layer.state = { tiles: [a, b] };
    layer.renderLayers();
    expect(layer.sublayerCache.size).toBe(2);

    layer.state = { tiles: [a] };
    layer.renderLayers();
    expect(layer.sublayerCache.size).toBe(1);
  });

  it('declares dataComparator that skips deck.gl prop diff on identical references', () => {
    const built = h.buildSublayerForTile(c.makeTile(3));
    const cmp = built.props.dataComparator;
    expect(typeof cmp).toBe('function');
    const ref = {};
    expect(cmp(ref, ref)).toBe(true);
    expect(cmp(ref, {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path / Line share only the dataComparator half of the chassis.
// ---------------------------------------------------------------------------

describe.each(COMPARATOR_ONLY_CASES)('$name — shared dataComparator', (c) => {
  let h: LayerHarness;

  beforeEach(async () => {
    vi.resetModules();
    const Ctor = await c.load();
    h = makeLayerHarness(Ctor, c.props, c.init);
  });

  it('declares dataComparator that skips deck.gl prop diff on identical references', () => {
    const built = h.buildSublayerForTile(c.makeTile(3));
    const cmp = built.props.dataComparator;
    expect(typeof cmp).toBe('function');
    const ref = {};
    expect(cmp(ref, ref)).toBe(true);
    expect(cmp(ref, {})).toBe(false);
  });
});
