/**
 * Styling pass-through contract (styling audit 2026-06).
 *
 * Pins the two fix waves from docs/styling-passthrough-audit-2026-06.md:
 *
 * 1. **Extension merge** — the layers' internal extension lists (time filter,
 *    categorical color, heatmap data filter) are load-bearing and hardcoded
 *    per sublayer, which used to silently drop a user's top-level
 *    `extensions` prop. `composeExtensions` now appends user extensions after
 *    the internal ones; equal-content user lists must NOT thrash the sublayer
 *    caches (extensionsDigest keys constructor + opts, not reference); a
 *    `_subLayerProps.<id>.extensions` override still REPLACES the list (deck
 *    contract) but warns when it omits an internal extension class.
 *
 * 2. **Underlying-layer prop pass-throughs** — miterLimit/billboard (path
 *    family), the full ScatterplotLayer stroke surface + billboard/
 *    antialiasing (point), wireframe/material/elevationScale (polygon),
 *    aggregation/weightsTextureSize/debounceTimeout (heatmap). Each must
 *    reach the sublayer AND participate in cache invalidation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePointTile, makePathTile, makePolygonTile } from './fake-tile';

interface CapturedLayer {
  props: Record<string, any>;
}

vi.mock('@deck.gl/layers', () => {
  class FakeScatterplotLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakePathLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakeSolidPolygonLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return {
    ScatterplotLayer: FakeScatterplotLayer,
    PathLayer: FakePathLayer,
    SolidPolygonLayer: FakeSolidPolygonLayer,
  };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer<P = any> {
    props: any;
    constructor(props: Record<string, any> = {}) {
      this.props = props;
    }
  }
  return {
    ...core,
    Layer: FakeLayer,
    project32: { name: 'project32' },
  };
});

vi.mock('@deck.gl/aggregation-layers', () => {
  class FakeDeckHeatmapLayer implements CapturedLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return { HeatmapLayer: FakeDeckHeatmapLayer };
});

vi.mock('@deck.gl/extensions', () => {
  class FakeDataFilterExtension {
    constructor(_opts?: any) {}
  }
  return { DataFilterExtension: FakeDataFilterExtension };
});

/** Stand-ins for user-supplied deck.gl extensions. */
class UserExtensionA {
  opts = { mode: 'a' };
}
class UserExtensionB {}

// ---------------------------------------------------------------------------
// Layer factories (Object.create harness — same pattern as the sibling suites)
// ---------------------------------------------------------------------------

function basePointTile() {
  const tile = makePointTile({
    positions: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
    startTimes: [0, 1, 2],
    endTimes: [1, 2, 3],
    timeOffset: 0,
  });
  tile.layers[0].features.numericProps['mag'] = new Float32Array([1, 2, 3]) as any;
  return tile;
}

function basePathTile() {
  return makePathTile({
    paths: [
      [
        [0, 0],
        [1, 1],
      ],
      [
        [2, 2],
        [3, 3],
      ],
    ],
    startTimes: [0, 0],
    endTimes: [100, 100],
    timeOffset: 0,
  });
}

function basePolygonTile() {
  return makePolygonTile({
    polygons: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
    startTimes: [0],
    endTimes: [100],
    timeOffset: 0,
  });
}

async function makePointLayer(props: Record<string, any> = {}) {
  const { AnimatedPointLayer } = await import('../src/layers/core/animated-point-layer');
  const layer: any = Object.create((AnimatedPointLayer as any).prototype);
  layer.props = {
    id: 'pts',
    fillColor: [255, 128, 0, 255],
    radius: 5,
    radiusUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  return layer;
}

async function makePathLayer(props: Record<string, any> = {}) {
  const { AnimatedPathLayer } = await import('../src/layers/core/animated-path-layer');
  const layer: any = Object.create((AnimatedPathLayer as any).prototype);
  layer.props = {
    id: 'paths',
    pathColor: [0, 150, 255, 255],
    pathWidth: 3,
    widthUnits: 'pixels',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  return layer;
}

async function makeTripsLayer(props: Record<string, any> = {}) {
  const { AnimatedTripsLayer } = await import('../src/layers/trips/animated-trips-layer');
  const layer: any = Object.create((AnimatedTripsLayer as any).prototype);
  layer.props = {
    id: 'trips',
    tripColor: [253, 128, 93, 255],
    tripWidth: 2,
    widthUnits: 'pixels',
    timeWindow: 1000,
    trailLength: 500,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  (layer as any).getEffectiveTimeWindow = () => 1000;
  return layer;
}

async function makePolygonLayer(props: Record<string, any> = {}) {
  const { AnimatedPolygonLayer } = await import('../src/layers/core/animated-polygon-layer');
  const layer: any = Object.create((AnimatedPolygonLayer as any).prototype);
  layer.props = {
    id: 'poly',
    fillColor: [255, 140, 0, 180],
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    filled: true,
    extruded: false,
    elevation: 0,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = {};
  layer.categoryColorExtension = {};
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  return layer;
}

async function makeHeatmapLayer(props: Record<string, any> = {}) {
  const { AnimatedHeatmapLayer } = await import('../src/layers/summary/heatmap-layer');
  const layer: any = Object.create((AnimatedHeatmapLayer as any).prototype);
  layer.props = {
    id: 'hm',
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    ...props,
  };
  layer._currentTime = 0;
  layer._dataFilter = {};
  layer._channelCache = new Map();
  layer._lastFilterUpdateWall = 0;
  return layer;
}

beforeEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// 1. Extension merge: top-level `extensions` reaches the sublayers
// ---------------------------------------------------------------------------

describe('user extensions merge into the internal extension list', () => {
  // Point + heatmap resolve extensions in renderLayers(); path/trips/polygon in
  // buildSublayer(). Point/path/trips/polygon append the user list after the
  // internal [timeFilter, categoryColor] pair; heatmap appends after its single
  // internal DataFilterExtension. Each layer copy-pastes its OWN extension-merge
  // path, so this runs the assertion against every one.
  it.each([
    { name: 'AnimatedPointLayer', make: makePointLayer, tile: basePointTile, via: 'render' as const },
    { name: 'AnimatedPathLayer', make: makePathLayer, tile: basePathTile, via: 'build' as const },
    { name: 'AnimatedTripsLayer', make: makeTripsLayer, tile: basePathTile, via: 'build' as const },
    { name: 'AnimatedPolygonLayer', make: makePolygonLayer, tile: basePolygonTile, via: 'build' as const },
    { name: 'AnimatedHeatmapLayer', make: makeHeatmapLayer, tile: basePointTile, via: 'render' as const, heatmap: true },
  ])(
    '$name: appends user extensions after the internal extension(s)',
    async ({ make, tile, via, heatmap }) => {
      const userExt = new UserExtensionA();
      const layer = await make({ extensions: [userExt] });
      let sub: any;
      if (via === 'render') {
        layer.state = { tiles: [tile()] };
        [sub] = layer.renderLayers();
      } else {
        const t = tile();
        sub = layer.buildSublayer(layer.prepareTile(t, t.layers[0]));
      }
      const expected = heatmap
        ? [layer._dataFilter, userExt]
        : [layer.timeFilterExtension, layer.categoryColorExtension, userExt];
      expect(sub.props.extensions).toEqual(expected);
    },
  );

  it('AnimatedPointLayer: no user extensions → exactly the internal pair', async () => {
    const layer = await makePointLayer();
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    expect(sub.props.extensions).toEqual([
      layer.timeFilterExtension,
      layer.categoryColorExtension,
    ]);
  });

  it('adding a user extension between renders rebuilds the cached sublayer', async () => {
    const layer = await makePointLayer();
    layer.state = { tiles: [basePointTile()] };
    const [first] = layer.renderLayers();
    expect(layer.renderLayers()[0]).toBe(first);
    layer.props.extensions = [new UserExtensionA()];
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.extensions).toHaveLength(3);
  });

  it('an equal-content fresh extensions array does NOT thrash the sublayer cache', async () => {
    // extensionsDigest keys constructor + opts — the common
    // `extensions: [new Ext()]` per-render literal must hit the cache.
    const layer = await makePointLayer({ extensions: [new UserExtensionA()] });
    layer.state = { tiles: [basePointTile()] };
    const [first] = layer.renderLayers();
    layer.props.extensions = [new UserExtensionA()];
    expect(layer.renderLayers()[0]).toBe(first);
  });

  it('a _subLayerProps extensions override replaces the list and warns about dropped internals', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const userExt = new UserExtensionB();
      const layer = await makePointLayer({
        _subLayerProps: { points: { extensions: [userExt] } },
      });
      layer.state = { tiles: [basePointTile()] };
      const [sub] = layer.renderLayers();
      // deck contract: the override replaces the whole list.
      expect(sub.props.extensions).toEqual([userExt]);
      // ...and the layer surfaces what was silently dropped.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('_subLayerProps.points.extensions'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Path family: miterLimit / billboard
// ---------------------------------------------------------------------------

describe('path-family PathLayer pass-throughs', () => {
  it('AnimatedTripsLayer: miterLimit and billboard reach the sublayer', async () => {
    const layer = await makeTripsLayer({ miterLimit: 7, billboard: true });
    const tile = basePathTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.miterLimit).toBe(7);
    expect(sub.props.billboard).toBe(true);
  });

  it('AnimatedPathLayer: miterLimit and billboard reach the sublayer', async () => {
    const layer = await makePathLayer({ miterLimit: 9, billboard: true });
    const tile = basePathTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.miterLimit).toBe(9);
    expect(sub.props.billboard).toBe(true);
  });

  it('AnimatedTripsLayer: a widthUnits change invalidates cached sublayers (audit fix)', async () => {
    // widthUnits was forwarded but missing from the trips layerPropsKey, so a
    // pixels↔meters switch never rebuilt cached sublayers.
    const layer = await makeTripsLayer({ widthUnits: 'pixels' });
    layer.state = { tiles: [basePathTile()] };
    const [first] = layer.renderLayers();
    expect(layer.renderLayers()[0]).toBe(first);
    layer.props.widthUnits = 'meters';
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.widthUnits).toBe('meters');
  });

  it('AnimatedTripsLayer: a miterLimit change invalidates cached sublayers', async () => {
    const layer = await makeTripsLayer({ miterLimit: 4 });
    layer.state = { tiles: [basePathTile()] };
    const [first] = layer.renderLayers();
    layer.props.miterLimit = 8;
    expect(layer.renderLayers()[0]).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 3. Point layer: stroke surface + billboard/antialiasing
// ---------------------------------------------------------------------------

describe('AnimatedPointLayer ScatterplotLayer pass-throughs', () => {
  it('forwards the full stroke + render prop surface', async () => {
    const layer = await makePointLayer({
      lineWidthUnits: 'pixels',
      lineWidthScale: 2,
      lineWidthMinPixels: 1,
      lineWidthMaxPixels: 12,
      billboard: true,
      antialiasing: false,
    });
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    expect(sub.props.lineWidthUnits).toBe('pixels');
    expect(sub.props.lineWidthScale).toBe(2);
    expect(sub.props.lineWidthMinPixels).toBe(1);
    expect(sub.props.lineWidthMaxPixels).toBe(12);
    expect(sub.props.billboard).toBe(true);
    expect(sub.props.antialiasing).toBe(false);
  });

  it('constant strokeWidth flows as the getLineWidth constant', async () => {
    const layer = await makePointLayer({ strokeWidth: 3 });
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    expect(sub.props.getLineWidth).toBe(3);
  });

  it('column-name strokeWidth bakes the numeric column as a binary getLineWidth attribute', async () => {
    const layer = await makePointLayer({ strokeWidth: 'mag' });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [sub] = layer.renderLayers();
    const attr = sub.props.data.attributes.getLineWidth;
    expect(attr).toBeDefined();
    // Zero-copy: the tile's own column rides to the GPU.
    expect(attr.value).toBe(tile.layers[0].features.numericProps['mag']);
  });

  it('getLineWidth alias wins over strokeWidth; a strokeWidth change invalidates caches', async () => {
    const layer = await makePointLayer({ strokeWidth: 5, getLineWidth: 'mag' });
    const tile = basePointTile();
    layer.state = { tiles: [tile] };
    const [first] = layer.renderLayers();
    expect(first.props.data.attributes.getLineWidth).toBeDefined();
    layer.props.getLineWidth = null;
    const [second] = layer.renderLayers();
    expect(second).not.toBe(first);
    expect(second.props.data.attributes.getLineWidth).toBeUndefined();
    expect(second.props.getLineWidth).toBe(5);
  });

  it('a function getLineWidth warns once and falls back to strokeWidth', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePointLayer({
        strokeWidth: 4,
        getLineWidth: () => 1,
      });
      layer.state = { tiles: [basePointTile()] };
      const [sub] = layer.renderLayers();
      expect(sub.props.getLineWidth).toBe(4);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('getLineWidth'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('cumulative mode: a column strokeWidth warns and is not baked (slabs pack a fixed schema)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = await makePointLayer({ cumulative: true, strokeWidth: 'mag' });
      const tile = basePointTile();
      const built = layer.buildTileData(tile, tile.layers[0]);
      expect(built.data.attributes.getLineWidth).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('cumulative'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Polygon layer: wireframe / material / elevationScale
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer SolidPolygonLayer pass-throughs', () => {
  it('forwards wireframe, material, and elevationScale', async () => {
    const material = { ambient: 0.5, diffuse: 0.5, shininess: 32, specularColor: [60, 64, 70] };
    const layer = await makePolygonLayer({
      extruded: true,
      wireframe: true,
      material,
      elevationScale: 100,
    });
    const tile = basePolygonTile();
    const sub = layer.buildSublayer(layer.prepareTile(tile, tile.layers[0]));
    expect(sub.props.wireframe).toBe(true);
    expect(sub.props.material).toBe(material);
    expect(sub.props.elevationScale).toBe(100);
  });

  it('an elevationScale change invalidates cached sublayers', async () => {
    const layer = await makePolygonLayer({ extruded: true, elevation: 10, elevationScale: 1 });
    layer.state = { tiles: [basePolygonTile()] };
    const [first] = layer.renderLayers();
    expect(layer.renderLayers()[0]).toBe(first);
    layer.props.elevationScale = 50;
    expect(layer.renderLayers()[0]).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 4b. Polygon layer: categorical colorMapping → stable per-tile palette
// ---------------------------------------------------------------------------

/** A 2-feature polygon tile carrying a `severity` categorical column whose
 *  per-tile dictionary order is caller-controlled. A distinct `t` keeps the
 *  per-tile prepare cache from collapsing two tiles onto one cache key. */
function severityPolygonTile(categories: string[], indices: number[], t = 0) {
  const tile = makePolygonTile({
    polygons: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
      [
        [2, 2],
        [3, 2],
        [3, 3],
        [2, 2],
      ],
    ],
    startTimes: [0, 0],
    endTimes: [100, 100],
    timeOffset: 0,
    tileId: { z: 0, x: 0, y: 0, t },
  });
  tile.layers[0].features.categoricalProps['severity'] = {
    indices: new Uint16Array(indices),
    categories,
  } as any;
  return tile;
}

describe('AnimatedPolygonLayer categorical colorMapping', () => {
  const MAPPING = {
    moderate: [255, 237, 160, 255],
    extreme: [240, 59, 32, 255],
  } as Record<string, number[]>;

  it('resolves a per-tile palette by category STRING, stable across dictionary order', async () => {
    const layer = await makePolygonLayer({
      fillColor: 'severity',
      colorMapping: MAPPING,
      colorMappingDefault: [0, 0, 0, 0],
    });

    // Two tiles whose `severity` dictionaries are in OPPOSITE order. A bare
    // index palette would paint feature 0 the same color in both; the mapping
    // must instead tie color to the string, so the palettes come out reversed.
    const tileA = severityPolygonTile(['moderate', 'extreme'], [0, 1], 0);
    const tileB = severityPolygonTile(['extreme', 'moderate'], [0, 1], 1);

    const paletteA = layer.prepareTile(tileA, tileA.layers[0]).gpuPalette;
    const paletteB = layer.prepareTile(tileB, tileB.layers[0]).gpuPalette;

    expect(paletteA).toEqual([MAPPING.moderate, MAPPING.extreme]);
    expect(paletteB).toEqual([MAPPING.extreme, MAPPING.moderate]);

    // Each tile's category index resolves through its own palette to the SAME
    // color for the same string — the cross-tile-stability guarantee.
    // tileA feature1 = 'extreme' (idx 1) → paletteA[1]; tileB feature0 =
    // 'extreme' (idx 0) → paletteB[0]; both must equal the extreme color.
    expect(paletteA![1]).toEqual(MAPPING.extreme);
    expect(paletteB![0]).toEqual(MAPPING.extreme);
  });

  it('uses colorMappingDefault for categories absent from the map', async () => {
    const layer = await makePolygonLayer({
      fillColor: 'severity',
      colorMapping: MAPPING,
      colorMappingDefault: [180, 180, 180, 255],
    });
    // 'low' is not in MAPPING → its palette slot falls to the default.
    const tile = severityPolygonTile(['moderate', 'low'], [0, 1]);
    const palette = layer.prepareTile(tile, tile.layers[0]).gpuPalette;
    expect(palette).toEqual([MAPPING.moderate, [180, 180, 180, 255]]);
  });

  it('without colorMapping, falls back to the global colorPalette (index order)', async () => {
    const palette = [
      [10, 10, 10, 255],
      [20, 20, 20, 255],
    ];
    const layer = await makePolygonLayer({ fillColor: 'severity', colorPalette: palette });
    const tile = severityPolygonTile(['moderate', 'extreme'], [0, 1]);
    expect(layer.prepareTile(tile, tile.layers[0]).gpuPalette).toBe(palette);
  });

  it('a colorMapping change re-prepares the tile (styleKey invalidation)', async () => {
    const layer = await makePolygonLayer({ fillColor: 'severity', colorMapping: MAPPING });
    const tile = severityPolygonTile(['moderate', 'extreme'], [0, 1]);
    const first = layer.prepareTile(tile, tile.layers[0]);
    expect(layer.prepareTile(tile, tile.layers[0])).toBe(first); // cached
    layer.props.colorMapping = { moderate: [1, 2, 3, 255], extreme: [4, 5, 6, 255] };
    const second = layer.prepareTile(tile, tile.layers[0]);
    expect(second).not.toBe(first);
    expect(second.gpuPalette).toEqual([
      [1, 2, 3, 255],
      [4, 5, 6, 255],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Heatmap: aggregation / weightsTextureSize / debounceTimeout
// ---------------------------------------------------------------------------

describe('AnimatedHeatmapLayer canonical-layer pass-throughs', () => {
  it('forwards aggregation, weightsTextureSize, and debounceTimeout', async () => {
    const layer = await makeHeatmapLayer({
      weightProperty: 'mag',
      aggregation: 'MEAN',
      weightsTextureSize: 1024,
      debounceTimeout: 50,
    });
    layer.state = { tiles: [basePointTile()] };
    const [sub] = layer.renderLayers();
    expect(sub.props.aggregation).toBe('MEAN');
    expect(sub.props.weightsTextureSize).toBe(1024);
    expect(sub.props.debounceTimeout).toBe(50);
  });
});
