/**
 * AnimatedPolygonLayer side-wall masking (`instanceVertexValid`).
 *
 * `stt-build` clips polygon coverage to each tile rect exactly, so a polygon
 * spanning a tile boundary arrives as two pieces that each carry a SYNTHETIC
 * edge along the shared boundary. deck's SolidPolygonLayer grows a wall on
 * every ring edge, so extruding those pieces printed the tile grid through the
 * surface as full-height curtains (the storm-4d cloud-top canopy). prepareTile
 * now supplies the mask attribute itself.
 *
 * Same Object.create harness as a3-polygon-props.test.ts (bypasses
 * CompositeLayer's lifecycle) with a deck.gl mock capturing constructor args.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makePolygonTile } from './fake-tile';

vi.mock('@deck.gl/layers', () => {
  class FakeSolidPolygonLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  class FakePathLayer {
    props: Record<string, any>;
    constructor(props: Record<string, any>) {
      this.props = props;
    }
  }
  return {
    SolidPolygonLayer: FakeSolidPolygonLayer,
    PathLayer: FakePathLayer,
  };
});

vi.mock('@deck.gl/core', async () => {
  const core = (await import('./fake-deck-core')).createDeckCoreMock();
  class FakeLayer {
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

// Zoom 2, tile (1, 1) spans lon [-90, 0], lat [0, 66.51326044311186].
const TILE_ID = { z: 2, x: 1, y: 1, t: 0 };
const EAST_SEAM = 0;

/**
 * A box clipped at the tile's eastern boundary: the (0,10)→(0,30) edge is the
 * tiler's cut, the other three are real polygon edges.
 */
function clippedBoxTile(extra: Record<string, any> = {}) {
  return makePolygonTile({
    polygons: [
      [
        [-40, 10],
        [EAST_SEAM, 10],
        [EAST_SEAM, 30],
        [-40, 30],
        [-40, 10],
      ],
    ],
    startTimes: [0],
    endTimes: [100],
    timeOffset: 0,
    tileId: TILE_ID,
    ...extra,
  });
}

async function makePolygonLayer(props: Record<string, any> = {}) {
  const { AnimatedPolygonLayer } =
    await import('../src/layers/core/animated-polygon-layer');
  const layer: any = Object.create((AnimatedPolygonLayer as any).prototype);
  layer.props = {
    id: 'poly',
    fillColor: [255, 140, 0, 180],
    timeWindow: 1000,
    opacity: 1,
    visible: true,
    filled: true,
    extruded: true,
    seamWalls: false,
    elevation: 0,
    elevationScale: 1,
    wireframe: false,
    stroked: false,
    getLineColor: [0, 0, 0, 255],
    getLineWidth: 1,
    lineWidthUnits: 'meters',
    lineWidthMinPixels: 0,
    lineJointRounded: false,
    lineMiterLimit: 4,
    lineDashJustified: false,
    _full3d: false,
    fadeInDuration: 500,
    fadeOutDuration: 500,
    timeHeightScale: 0,
    timeHeightOrigin: 0,
    reducedMotion: false,
    filterProperty: null,
    filterRange: null,
    filterSoftRange: null,
    filterEnabled: true,
    ...props,
  };
  layer._currentTime = 0;
  layer.boundGetTime = () => 0;
  layer.timeFilterExtension = { name: 'time' };
  layer.categoryColorExtension = { name: 'category' };
  layer.dataFilterExtension = { name: 'dataFilter' };
  layer.preparedTileCache = new Map();
  layer.sublayerCache = new Map();
  layer.lastLayerPropsKey = '';
  layer.lastTilesRef = null;
  return layer;
}

function wallMask(prepared: any): number[] | undefined {
  const attr = prepared.data.attributes.instanceVertexValid;
  return attr ? Array.from(attr.value as Uint16Array) : undefined;
}

beforeEach(() => {
  vi.resetModules();
});

describe('AnimatedPolygonLayer tile-seam wall masking', () => {
  it('extruded ⇒ the tile-cut edge grows no wall, real edges do', async () => {
    const layer = await makePolygonLayer();
    const tile = clippedBoxTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    // v1 starts the cut edge along lon 0; v4 closes the ring.
    expect(wallMask(prepared)).toEqual([1, 0, 1, 1, 0]);
  });

  it('binds the mask under deck’s own attribute name so its updater is bypassed', async () => {
    const layer = await makePolygonLayer();
    const tile = clippedBoxTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const attr = prepared.data.attributes.instanceVertexValid;
    expect(attr.size).toBe(1);
    // uint16 matches SolidPolygonLayer's declared attribute type; a wider
    // array would be reinterpreted by the vertex format.
    expect(attr.value).toBeInstanceOf(Uint16Array);
    expect(attr.value.length).toBe(prepared.data.startIndices.at(-1));
  });

  it('flat fills skip the mask entirely (no side model consumes it)', async () => {
    const layer = await makePolygonLayer({ extruded: false });
    const tile = clippedBoxTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.instanceVertexValid).toBeUndefined();
  });

  it('seamWalls: true restores deck’s raw behaviour', async () => {
    const layer = await makePolygonLayer({ seamWalls: true });
    const tile = clippedBoxTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.instanceVertexValid).toBeUndefined();
  });

  it('re-prepares the tile when extruded / seamWalls toggle', async () => {
    const layer = await makePolygonLayer();
    const tile = clippedBoxTile();
    const extrudedPrep = layer.prepareTile(tile, tile.layers[0]);
    expect(extrudedPrep.data.attributes.instanceVertexValid).toBeDefined();

    // Same layer instance + same tile → the prepared-tile cache must not hand
    // back the masked attributes once the prop flips.
    layer.props = { ...layer.props, seamWalls: true };
    const rawPrep = layer.prepareTile(tile, tile.layers[0]);
    expect(rawPrep.styleKey).not.toBe(extrudedPrep.styleKey);
    expect(rawPrep.data.attributes.instanceVertexValid).toBeUndefined();
  });

  it('masks the ring closure so no wall bridges into a hole', async () => {
    const layer = await makePolygonLayer();
    // One feature, two rings: a square exterior and a square hole, neither
    // touching a tile boundary. Only the two ring closures are masked.
    const tile = makePolygonTile({
      polygons: [
        [
          [-60, 10],
          [-20, 10],
          [-20, 40],
          [-60, 10],
          [-50, 20],
          [-30, 20],
          [-30, 30],
          [-50, 20],
        ],
      ],
      startTimes: [0],
      endTimes: [100],
      timeOffset: 0,
      tileId: TILE_ID,
      ringIndices: [0, 4, 8],
    });
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(wallMask(prepared)).toEqual([1, 1, 1, 0, 1, 1, 1, 0]);
  });

  it('tolerates seam vertices snapped to the quantization grid', async () => {
    const layer = await makePolygonLayer();
    // A quantized archive rounds the clipper's exact seam coordinate to the
    // nearest world-anchored grid point — here half a step short of lon 0.
    const step = 0.01;
    const snapped = EAST_SEAM - step / 2;
    const tile = makePolygonTile({
      polygons: [
        [
          [-40, 10],
          [snapped, 10],
          [snapped, 30],
          [-40, 10],
        ],
      ],
      startTimes: [0],
      endTimes: [100],
      timeOffset: 0,
      tileId: TILE_ID,
      coordQuantStep: [step, step],
    });
    expect(wallMask(layer.prepareTile(tile, tile.layers[0]))).toEqual([
      1, 0, 1, 0,
    ]);
  });
});
