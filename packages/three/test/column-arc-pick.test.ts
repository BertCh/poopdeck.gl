// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// GPU id-buffer picking PROVEN on two instanced kinds of differing geometry —
// `column` (extruded prism, Point geometry) and `arc` (raised ribbon, indexed
// LineString geometry). Three seams per kind, mirroring the point template:
//   • PROVENANCE — the buffer builder records one entry per merged instance in
//     draw order + a `tileKey → BinaryFeatures` map (index alignment with the
//     GPU id the shader paints).
//   • ID MATERIAL — the id-material variant BUILDS (TSL graph) with the SAME
//     collapse gates as the colour material (time-filter + column-filter +, for
//     columns, the time-as-height lift), so an out-of-window / out-of-range
//     primitive is unpickable on-device. Pixel-level collapse is browser-verify
//     (this package's policy); here we gate on the graph + uniforms.
//   • DISPATCH — the FULL `layer.pick()` path with a stub renderer/readback (as
//     `gpu-pick-readback.test.ts` does): a chosen id colour resolves to the right
//     `{tileKey, featureIndex}`, a sentinel background is a miss, and the id
//     material is swapped in only for the render and restored after.

import { describe, it, expect } from 'vitest';
import type { TileId } from '@poopdeck.gl/core';
import { buildColumnBuffers } from '../src/lib/column-buffers';
import { buildArcBuffers } from '../src/lib/arc-buffers';
import {
  createColumnIdMaterial,
  ColumnUniforms,
  TimeHeightUniforms as ColumnTimeHeightUniforms,
} from '../src/tsl/column-material';
import { createArcIdMaterial } from '../src/tsl/arc-material';
import { DataFilterUniforms } from '../src/tsl/data-filter';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import { ColumnLayer } from '../src/layers/column-layer';
import { ArcLayer } from '../src/layers/arc-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import {
  GpuPicker,
  encodeId,
  type PickRenderer,
  type RenderTargetCtor,
} from '../src/lib/gpu-pick';
import { featureTileKey } from '../src/lib/id-pick';
import { makePointTile, makeLineTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };

// ── Fixtures ────────────────────────────────────────────────────────────────

const colIdA: TileId = { z: 12, x: 1, y: 2, t: 0 };
const colIdB: TileId = { z: 12, x: 3, y: 4, t: 500 };
const colTileA = makePointTile(
  2,
  [
    anchor.longitude,
    anchor.latitude,
    anchor.longitude + 0.001,
    anchor.latitude,
  ],
  {
    numericProps: { mag: new Float32Array([3, 5]) },
    featureIds: new Uint32Array([10, 11]),
  },
  { id: colIdA, layerName: 'quakes', timeOffset: 0 },
);
const colTileB = makePointTile(
  1,
  [anchor.longitude + 0.002, anchor.latitude + 0.001],
  {
    numericProps: { mag: new Float32Array([9]) },
    featureIds: new Uint32Array([12]),
  },
  { id: colIdB, layerName: 'quakes', timeOffset: 500 },
);
const COLUMN_OPTS = {
  colorMode: {
    type: 'constant' as const,
    color: [255, 140, 0, 255] as [number, number, number, number],
  },
  elevationProperty: 'mag',
  elevationScale: 1000,
  radius: 100,
};

const arcIdA: TileId = { z: 14, x: 1, y: 1, t: 0 };
const arcTileA = makeLineTile(
  {
    featureCount: 2,
    positions: new Float64Array([
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + 0.002,
      anchor.latitude, // feat 0: src, tgt
      anchor.longitude + 0.001,
      anchor.latitude + 0.001,
      anchor.longitude + 0.003,
      anchor.latitude + 0.001, // feat 1
    ]),
    startIndices: new Uint32Array([0, 2, 4]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    featureIds: new Uint32Array([100, 101]),
  },
  { id: arcIdA, layerName: 'flows', timeOffset: 0 },
);

/** Stub `GpuPicker` whose readback RETURNS one 1×1 texel painted `rgb` — the
 *  exact seam of `gpu-pick-readback.test.ts`, no GPU device. */
function mockPicker(rgb: readonly [number, number, number]) {
  const pixels = new Uint8Array([rgb[0], rgb[1], rgb[2], 255]);
  const renderer: PickRenderer = {
    domElement: { width: 200, height: 200 } as unknown as HTMLCanvasElement,
    getPixelRatio: () => 1,
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    render: () => {},
    readRenderTargetPixelsAsync: async () => pixels,
  };
  const camera = { setViewOffset() {}, clearViewOffset() {} };
  const TargetCtor = class {
    dispose() {}
  } as unknown as RenderTargetCtor;
  const picker = new GpuPicker(renderer, TargetCtor, 1);
  return { picker, camera };
}

// ── COLUMN ───────────────────────────────────────────────────────────────────

describe('buildColumnBuffers provenance', () => {
  it('records one entry per merged column in emit order + a tileKey→binary map', () => {
    const buf = buildColumnBuffers([colTileA, colTileB], proj, 0, COLUMN_OPTS);
    expect(buf.count).toBe(3);
    expect(buf.provenance.length).toBe(3);
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: featureTileKey(colIdA, 'quakes'),
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: featureTileKey(colIdA, 'quakes'),
      featureIndex: 1,
    });
    // Boundary: first column of tile B.
    expect(buf.provenance.resolve(2)).toEqual({
      tileKey: featureTileKey(colIdB, 'quakes'),
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(3)).toBeNull();
    expect(buf.binaryByTileKey.get(featureTileKey(colIdA, 'quakes'))).toBe(
      colTileA.layers[0].features,
    );
    expect(buf.binaryByTileKey.get(featureTileKey(colIdB, 'quakes'))).toBe(
      colTileB.layers[0].features,
    );
    expect(buf.binaryByTileKey.size).toBe(2);
  });

  it('emits empty (non-null) pick buffers when no columns merge', () => {
    const buf = buildColumnBuffers([], proj, 0, COLUMN_OPTS);
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

describe('createColumnIdMaterial (reuses the colour material collapse gates)', () => {
  it('builds a positionNode + opacityNode graph', () => {
    const b = createColumnIdMaterial({});
    expect(b.material.positionNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.time).toBeInstanceOf(TimeFilterUniforms);
    expect(b.column).toBeInstanceOf(ColumnUniforms);
  });

  it('installs the time-filter + column-filter + time-as-height gates when requested', () => {
    const b = createColumnIdMaterial({
      timeFiltered: true,
      dataFilter: true,
      timeHeight: true,
    });
    expect(b.timeFiltered).toBe(true);
    expect(b.filter).toBeInstanceOf(DataFilterUniforms); // column-filter collapse
    expect(b.timeHeight).toBeInstanceOf(ColumnTimeHeightUniforms); // space-time-cube lift
  });

  it('omits the filter/lift uniforms when the gates are off', () => {
    const b = createColumnIdMaterial({ dataFilter: false, timeHeight: false });
    expect(b.filter).toBeUndefined();
    expect(b.timeHeight).toBeUndefined();
  });
});

describe('ColumnLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  it('resolves a merged id colour to the right {tileKey, featureIndex}', async () => {
    const layer = new ColumnLayer({ id: 'quakes', ...COLUMN_OPTS });
    layer.setTiles([colTileA, colTileB], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(2)); // merged 2 → tile B feature 0
    const hit = await layer.pick(picker, camera, 10, 10);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('column');
    expect(hit!.layerId).toBe('quakes');
    expect(hit!.tileKey).toBe(featureTileKey(colIdB, 'quakes'));
    expect(hit!.featureIndex).toBe(0);
    expect(hit!.object!.mag).toBeCloseTo(9, 5);
    expect(hit!.object!.id).toBe(12);
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude + 0.002, 9);
    expect(hit!.screen).toEqual([10, 10]);
    // The id material is swapped in only for the render; the colour material is restored.
    expect(layer.object.material).toBe(colourMat);
  });

  it('reports a sentinel background readback as a miss (no hit) — the collapsed/absent case', async () => {
    const layer = new ColumnLayer({ id: 'quakes', ...COLUMN_OPTS });
    layer.setTiles([colTileA, colTileB], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]); // white → MAX_PICK_ID ≥ count
    expect(await layer.pick(picker, camera, 10, 10)).toBeNull();
  });

  it('returns null (never touches the GPU) when there are no columns', async () => {
    const layer = new ColumnLayer({ id: 'quakes', ...COLUMN_OPTS });
    layer.setTiles([], ctx);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 10, 10)).toBeNull();
  });
});

// ── ARC ────────────────────────────────────────────────────────────────────

describe('buildArcBuffers provenance', () => {
  it('records one entry per merged arc in emit order + a tileKey→binary map', () => {
    const buf = buildArcBuffers([arcTileA], proj, 0, {});
    expect(buf.count).toBe(2);
    expect(buf.provenance.length).toBe(2);
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: featureTileKey(arcIdA, 'flows'),
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: featureTileKey(arcIdA, 'flows'),
      featureIndex: 1,
    });
    expect(buf.provenance.resolve(2)).toBeNull();
    expect(buf.binaryByTileKey.get(featureTileKey(arcIdA, 'flows'))).toBe(
      arcTileA.layers[0].features,
    );
  });

  it('emits empty (non-null) pick buffers when no arcs merge', () => {
    const buf = buildArcBuffers([], proj, 0, {});
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

describe('createArcIdMaterial (reuses the colour material width-collapse gate)', () => {
  it('builds a vertexNode + opacityNode graph for both arc shapes', () => {
    for (const shape of ['parabolic', 'greatCircle'] as const) {
      const b = createArcIdMaterial({ shape });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.shape).toBe(shape);
    }
  });

  it('installs the column-filter gate alongside the time window when requested', () => {
    const b = createArcIdMaterial({ dataFilter: true });
    expect(b.filter).toBeInstanceOf(DataFilterUniforms);
    expect(createArcIdMaterial({ dataFilter: false }).filter).toBeUndefined();
  });
});

describe('ArcLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  it('resolves a merged id colour to the right arc + its SOURCE coordinate', async () => {
    const layer = new ArcLayer({ id: 'flows' });
    layer.setTiles([arcTileA], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(1)); // merged 1 → arc feature 1
    const hit = await layer.pick(picker, camera, 20, 30);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('arc');
    expect(hit!.layerId).toBe('flows');
    expect(hit!.tileKey).toBe(featureTileKey(arcIdA, 'flows'));
    expect(hit!.featureIndex).toBe(1);
    expect(hit!.object!.id).toBe(101);
    // Arc coordinate is the SOURCE (first) vertex of feature 1 (startIndices[1] = 2).
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude + 0.001, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude + 0.001, 9);
    expect(layer.object.material).toBe(colourMat);
  });

  it('reports a sentinel background readback as a miss', async () => {
    const layer = new ArcLayer({ id: 'flows' });
    layer.setTiles([arcTileA], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]);
    expect(await layer.pick(picker, camera, 20, 30)).toBeNull();
  });
});
