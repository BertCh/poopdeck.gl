/**
 * AnimatedPolygonLayer tile-seam suppression — both consumers of the edge mask.
 *
 * `stt-build` clips polygon coverage to each tile rect exactly, so a polygon
 * spanning a tile boundary arrives as two pieces that each carry a SYNTHETIC
 * edge along the shared boundary. Two render modes draw those edges:
 *
 * - EXTRUSION (`instanceVertexValid`). deck's SolidPolygonLayer grows a wall on
 *   every ring edge, so extruding the pieces printed the tile grid through the
 *   surface as full-height curtains (the storm-4d cloud-top canopy).
 * - STROKE (outline `startIndices`). The synthetic edges are real ring
 *   vertices, so the stroked outline ruled a line down every seam and the map
 *   wore its own tile lattice (the storm-4d outage counties).
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

// ---------------------------------------------------------------------------
// The stroked outline consumes the same mask, as path BREAKS
// ---------------------------------------------------------------------------

function outlineStarts(layer: any, tile: any): number[] {
  const prepared = layer.prepareTile(tile, tile.layers[0]);
  return Array.from(
    layer.buildOutlineSublayer(prepared).props.data.startIndices as Uint32Array,
  );
}

describe('AnimatedPolygonLayer tile-seam outline splitting', () => {
  it('breaks the ring at the tile-cut edge instead of stroking it', async () => {
    const layer = await makePolygonLayer({ stroked: true, extruded: false });
    // The clipped box's cut edge leaves v1 (mask [1,0,1,1,0]). Runs are then
    // [v0..v1] and [v2..v4]: the western/northern/southern boundary is drawn,
    // the ruled line down lon 0 is not.
    expect(outlineStarts(layer, clippedBoxTile())).toEqual([0, 2, 5]);
  });

  it('leaves an untouched tile on the reference-stable ringIndices array', async () => {
    const layer = await makePolygonLayer({ stroked: true, extruded: false });
    const tile = makePolygonTile({
      polygons: [
        [
          [-60, 10],
          [-20, 10],
          [-20, 40],
          [-60, 10],
        ],
      ],
      startTimes: [0],
      endTimes: [100],
      timeOffset: 0,
      tileId: TILE_ID,
    });
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    // Nothing on a boundary ⇒ no split, no allocation: the outline is fed the
    // decoder's own array, which is what keeps the zero-copy path zero-copy.
    expect(prepared.outlineRuns).toBeNull();
    expect(outline.props.data.startIndices).toBe(prepared.data.startIndices);
  });

  it('splits holes on their own seams, independently of the exterior', async () => {
    const layer = await makePolygonLayer({ stroked: true, extruded: false });
    // Exterior clipped at lon 0 (cut edge leaves v1); an interior ring nowhere
    // near a boundary. Ring breaks at 4; the extra break at 2 is the cut.
    const tile = makePolygonTile({
      polygons: [
        [
          [-40, 10],
          [0, 10],
          [0, 30],
          [-40, 10],
          [-30, 15],
          [-25, 15],
          [-25, 20],
          [-30, 15],
        ],
      ],
      startTimes: [0],
      endTimes: [100],
      timeOffset: 0,
      tileId: TILE_ID,
      ringIndices: [0, 4, 8],
    });
    expect(outlineStarts(layer, tile)).toEqual([0, 2, 4, 8]);
  });

  it('seamWalls: true strokes the seam, as deck would', async () => {
    const layer = await makePolygonLayer({
      stroked: true,
      extruded: false,
      seamWalls: true,
    });
    expect(outlineStarts(layer, clippedBoxTile())).toEqual([0, 5]);
  });

  it('shares one mask walk with the extruded consumer', async () => {
    const layer = await makePolygonLayer({ stroked: true, extruded: true });
    const tile = clippedBoxTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    // Extruded ⇒ prepareTile already walked the geometry; the outline must
    // reuse that array rather than recomputing an identical one.
    expect(prepared.seamMask).toBe(
      prepared.data.attributes.instanceVertexValid.value,
    );
    layer.buildOutlineSublayer(prepared);
    expect(Array.from(prepared.outlineRuns)).toEqual([0, 2, 5]);
  });

  it('does not walk the geometry for a flat, unstroked tile', async () => {
    const layer = await makePolygonLayer({ stroked: false, extruded: false });
    const prepared = layer.prepareTile(
      clippedBoxTile(),
      clippedBoxTile().layers[0],
    );
    // Neither consumer is live: no mask, and no lazy outline walk triggered.
    expect(prepared.seamMask).toBeNull();
    expect(prepared.outlineRuns).toBeUndefined();
  });

  it('keeps the per-vertex buffers aligned across the split', async () => {
    const layer = await makePolygonLayer({ stroked: true, extruded: false });
    const tile = clippedBoxTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    const vertexCount = prepared.data.startIndices.at(-1);
    // Splitting moves no vertices, so the instanced draw is the same size and
    // the time buffers the outline shares with the fill still line up 1:1.
    expect(outline.props.data.startIndices.at(-1)).toBe(vertexCount);
    expect(outline.props.data.attributes.instanceStartTime).toBe(
      prepared.data.attributes.instanceStartTime,
    );
    expect(outline.props.data.attributes.getPath.value).toBe(
      prepared.data.attributes.getPolygon.value,
    );
  });
});

// ---------------------------------------------------------------------------
// Column-driven edge color — what keeps a wireframe-only prism categorical
// ---------------------------------------------------------------------------

describe('AnimatedPolygonLayer categorical getLineColor', () => {
  const MAPPING = {
    TO: [255, 80, 80, 215] as [number, number, number, number],
    SV: [255, 190, 60, 190] as [number, number, number, number],
  };

  /** Two clipped boxes, one TO and one SV, so the palette has to discriminate. */
  function phenomTile() {
    const tile = makePolygonTile({
      polygons: [
        [
          [-40, 10],
          [-20, 10],
          [-20, 30],
          [-40, 10],
        ],
        [
          [-60, 10],
          [-50, 10],
          [-50, 30],
          [-60, 10],
        ],
      ],
      startTimes: [0, 0],
      endTimes: [100, 100],
      timeOffset: 0,
      tileId: TILE_ID,
    });
    (tile.layers[0].features.categoricalProps as any)['phenom'] = {
      categories: ['TO', 'SV'],
      indices: new Uint16Array([0, 1]),
    };
    return tile;
  }

  it('expands the mapping into a per-vertex instanceLineColors buffer', async () => {
    const layer = await makePolygonLayer({
      extruded: true,
      filled: false,
      wireframe: true,
      fillColor: 'phenom',
      getLineColor: 'phenom',
      colorMapping: MAPPING,
    });
    const tile = phenomTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const attr = prepared.data.attributes.getLineColor;
    expect(attr.size).toBe(4);
    expect(attr.normalized).toBe(true);
    // Four vertices per feature; feature 0 is TO, feature 1 is SV.
    expect(Array.from(attr.value.slice(0, 4))).toEqual(MAPPING.TO);
    expect(Array.from(attr.value.slice(16, 20))).toEqual(MAPPING.SV);
  });

  it('leaves the constant on the sublayer prop as the missing-column fallback', async () => {
    const layer = await makePolygonLayer({
      extruded: true,
      filled: false,
      wireframe: true,
      getLineColor: 'phenom',
      colorMapping: MAPPING,
    });
    // Same geometry, no `phenom` column — a multi-layer archive where only one
    // layer carries it. The prop must still name a visible color.
    const tile = clippedBoxTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    expect(prepared.data.attributes.getLineColor).toBeUndefined();
    expect(layer.buildSublayer(prepared).props.getLineColor).toEqual([
      0, 0, 0, 255,
    ]);
  });

  it('re-prepares when the edge-color column changes', async () => {
    const layer = await makePolygonLayer({
      extruded: true,
      filled: false,
      wireframe: true,
      getLineColor: 'phenom',
      colorMapping: MAPPING,
    });
    const tile = phenomTile();
    const columnPrep = layer.prepareTile(tile, tile.layers[0]);
    layer.props = { ...layer.props, getLineColor: [1, 2, 3, 4] };
    const constPrep = layer.prepareTile(tile, tile.layers[0]);
    expect(constPrep.styleKey).not.toBe(columnPrep.styleKey);
    expect(constPrep.data.attributes.getLineColor).toBeUndefined();
  });

  it('is what a wireframe-only prism needs — the fill palette cannot reach it', async () => {
    // The "cage, not glass" render. Guards the gap this test was written for:
    // dropping `filled` while leaving `getLineColor` at its constant default
    // renders every cage unlit BLACK, because the wireframe model reads
    // `instanceLineColors` (not the fill's buffer) and the extruded path does
    // not run the GPU CategoryColorExtension whose fragment hook would
    // otherwise have caught it.
    const props = {
      extruded: true,
      filled: false,
      wireframe: true,
      fillColor: 'phenom',
      colorMapping: MAPPING,
    };
    const tile = phenomTile();

    const noColumn = await makePolygonLayer(props);
    const blackPrep = noColumn.prepareTile(tile, tile.layers[0]);
    expect(blackPrep.data.attributes.getLineColor).toBeUndefined();
    expect(noColumn.buildSublayer(blackPrep).props.getLineColor).toEqual([
      0, 0, 0, 255,
    ]);

    const withColumn = await makePolygonLayer({
      ...props,
      getLineColor: 'phenom',
    });
    const litPrep = withColumn.prepareTile(tile, tile.layers[0]);
    // Bound under deck's own attribute name so the wireframe model picks it up.
    expect(litPrep.data.attributes.getLineColor.size).toBe(4);
    expect(
      Array.from(litPrep.data.attributes.getLineColor.value.slice(0, 4)),
    ).toEqual(MAPPING.TO);
  });

  it('feeds the same buffer to the stroked outline’s getColor', async () => {
    const layer = await makePolygonLayer({
      stroked: true,
      extruded: false,
      getLineColor: 'phenom',
      colorMapping: MAPPING,
    });
    const tile = phenomTile();
    const prepared = layer.prepareTile(tile, tile.layers[0]);
    const outline = layer.buildOutlineSublayer(prepared);
    expect(outline.props.data.attributes.getColor).toBe(
      prepared.data.attributes.getLineColor,
    );
  });
});
