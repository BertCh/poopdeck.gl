/**
 * AnimatedPolygonLayer floating extrusions (`baseElevation` /
 * `elevationThickness`).
 *
 * deck's SolidPolygonLayer extrudes from the polygon's own vertex z
 * (`pos.z += elevations * elevationScale`), and STT polygon geometry is 2D, so
 * an extruded band whose elevation column says "12 km up" hangs a curtain from
 * the basemap to 12 km — what the storm-4d cloud-top canopy did. prepareTile
 * synthesises the vertex z (pre-scaled) and rewrites elevation to the thickness
 * above it, so the walls span exactly [floor, top].
 *
 * Same Object.create harness as polygon-seam-walls.test.ts (bypasses
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

/**
 * Two triangles well inside tile (0,0,0), carrying a per-feature cloud-top
 * height column — the cloud-top canopy's shape in miniature.
 */
function canopyTile(extra: Record<string, any> = {}) {
  return makePolygonTile({
    polygons: [
      [
        [-40, 10],
        [-20, 10],
        [-20, 30],
        [-40, 10],
      ],
      [
        [-35, 15],
        [-25, 15],
        [-25, 25],
        [-35, 15],
      ],
    ],
    startTimes: [0, 0],
    endTimes: [100, 100],
    timeOffset: 0,
    numericProps: { top_alt_m: [8000, 12000] },
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
    elevation: 'top_alt_m',
    elevationScale: 1,
    baseElevation: 0,
    elevationThickness: null,
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

/** One value per vertex of a closed triangle (3 corners + the ring closure). */
function rep(value: number): number[] {
  return [value, value, value, value];
}

/** Per-vertex z from the prepared `getPolygon` buffer. */
function vertexZ(prepared: any): number[] {
  const { value, size } = prepared.data.attributes.getPolygon;
  const out: number[] = [];
  for (let i = size - 1; i < value.length; i += size) out.push(value[i]);
  return out;
}

function elevations(prepared: any): number[] | undefined {
  const attr = prepared.data.attributes.getElevation;
  return attr ? Array.from(attr.value as Float32Array) : undefined;
}

beforeEach(() => {
  vi.resetModules();
});

describe('AnimatedPolygonLayer floating extrusions', () => {
  it('ground-anchored by default — geometry rides through zero-copy', async () => {
    const layer = await makePolygonLayer();
    const tile = canopyTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(prepared.data.attributes.getPolygon.size).toBe(2);
    expect(prepared.data.attributes.getPolygon.value).toBe(
      tile.layers[0].features.positions,
    );
    expect(prepared.dims).toBe(2);
    // Elevation is the raw column: walls span [0, top].
    expect(elevations(prepared)).toEqual([...rep(8000), ...rep(12000)]);
  });

  it('elevationThickness hangs a shell below each feature’s own top', async () => {
    const layer = await makePolygonLayer({ elevationThickness: 300 });
    const tile = canopyTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(prepared.data.attributes.getPolygon.size).toBe(3);
    expect(prepared.dims).toBe(3);
    // Floor = top − thickness, per feature.
    expect(vertexZ(prepared)).toEqual([...rep(7700), ...rep(11700)]);
    // Thickness is uniform by construction → constant prop, no per-vertex buffer.
    expect(elevations(prepared)).toBeUndefined();
    expect(prepared.elevationConstant).toBe(300);
  });

  it('pre-scales the floor because the shader scales only the thickness', async () => {
    const layer = await makePolygonLayer({
      elevationThickness: 300,
      elevationScale: 4,
    });
    const tile = canopyTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    // z is baked at floor × scale; the GPU adds thickness × scale on top, so
    // the top face lands at top × scale (7700×4 + 300×4 = 32000 = 8000×4).
    expect(vertexZ(prepared)).toEqual([...rep(30800), ...rep(46800)]);
    expect(prepared.elevationConstant).toBe(300);
  });

  it('re-prepares when elevationScale moves (it is baked into the floor)', async () => {
    const layer = await makePolygonLayer({ elevationThickness: 300 });
    const tile = canopyTile();
    const first = layer.prepareTile(tile, tile.layers[0]);

    layer.props = { ...layer.props, elevationScale: 4 };
    const second = layer.prepareTile(tile, tile.layers[0]);
    expect(second.styleKey).not.toBe(first.styleKey);
    expect(vertexZ(second)).not.toEqual(vertexZ(first));
  });

  it('constant baseElevation floats every polygon off a shared floor', async () => {
    const layer = await makePolygonLayer({ baseElevation: 6000 });
    const tile = canopyTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(vertexZ(prepared)).toEqual([...rep(6000), ...rep(6000)]);
    // Walls span [6000, top] ⇒ elevation is the remaining thickness.
    expect(elevations(prepared)).toEqual([...rep(2000), ...rep(6000)]);
  });

  it('column baseElevation gives each feature its own floor', async () => {
    const layer = await makePolygonLayer({ baseElevation: 'base_alt_m' });
    const tile = canopyTile({
      numericProps: { top_alt_m: [8000, 12000], base_alt_m: [1000, 9000] },
    });
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(vertexZ(prepared)).toEqual([...rep(1000), ...rep(9000)]);
    expect(elevations(prepared)).toEqual([...rep(7000), ...rep(3000)]);
  });

  it('clamps an inverted floor rather than extruding downward', async () => {
    const layer = await makePolygonLayer({ baseElevation: 'base_alt_m' });
    const tile = canopyTile({
      // Second feature's floor sits ABOVE its top — bad data, not a hole in
      // the basemap.
      numericProps: { top_alt_m: [8000, 12000], base_alt_m: [1000, 20000] },
    });
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(elevations(prepared)).toEqual([...rep(7000), ...rep(0)]);
  });

  it('a constant elevation collapses to a constant slab', async () => {
    const layer = await makePolygonLayer({
      elevation: 9000,
      elevationThickness: 250,
    });
    const tile = canopyTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(vertexZ(prepared)).toEqual([...rep(8750), ...rep(8750)]);
    expect(prepared.elevationConstant).toBe(250);
    expect(elevations(prepared)).toBeUndefined();
  });

  it('thickness 0 leaves a flat sheet at altitude (top face only)', async () => {
    const layer = await makePolygonLayer({ elevationThickness: 0 });
    const tile = canopyTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(vertexZ(prepared)).toEqual([...rep(8000), ...rep(12000)]);
    expect(prepared.elevationConstant).toBe(0);
  });

  it('flat fills ignore the floor entirely', async () => {
    const layer = await makePolygonLayer({
      extruded: false,
      elevationThickness: 300,
    });
    const tile = canopyTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(prepared.data.attributes.getPolygon.size).toBe(2);
    expect(prepared.dims).toBe(2);
  });

  it('keeps the seam-wall mask alongside the lifted geometry', async () => {
    const layer = await makePolygonLayer({ elevationThickness: 300 });
    // Zoom 2, tile (1,1): the (0,10)→(0,30) edge is the tiler's cut.
    const tile = makePolygonTile({
      polygons: [
        [
          [-40, 10],
          [0, 10],
          [0, 30],
          [-40, 10],
        ],
      ],
      startTimes: [0],
      endTimes: [100],
      timeOffset: 0,
      tileId: { z: 2, x: 1, y: 1, t: 0 },
      numericProps: { top_alt_m: [8000] },
    });
    const prepared = layer.prepareTile(tile, tile.layers[0]);

    expect(
      Array.from(
        prepared.data.attributes.instanceVertexValid.value as Uint16Array,
      ),
    ).toEqual([1, 0, 1, 0]);
    expect(vertexZ(prepared)).toEqual(rep(7700));
  });

  it('the stroked outline rides the floor plane with the fill', async () => {
    const layer = await makePolygonLayer({
      elevationThickness: 300,
      stroked: true,
    });
    const tile = canopyTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);

    expect(outline.props.positionFormat).toBe('XYZ');
    expect(outline.props.data.attributes.getPath.size).toBe(3);
    expect(outline.props.data.attributes.getPath.value).toBe(
      prepared.data.attributes.getPolygon.value,
    );
  });
});
