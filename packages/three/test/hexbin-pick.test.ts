// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// GPU id-buffer picking for the HEXBIN kind. Same three seams as every other
// id-pickable kind (provenance → id material → dispatch), but adapted for the
// thing that makes hexbin different: **a cell is not a feature**.
//
//   • PROVENANCE — `buildHexbinBuffers` records one entry per CELL, in dense
//     cell-index order (which is draw order), naming the cell's FIRST
//     contributing feature as a deterministic REPRESENTATIVE. Cell 0 here is fed
//     by two features from one tile; cell 1 by one feature from another.
//   • ID MATERIAL — `createHexbinIdMaterial` builds with the SAME vertex-stage
//     collapse gates as the colour material (the aggregate's own `sttVisible`
//     plus the sub-step window filter over the cell's temporal span), so an
//     empty / percentile-clipped / out-of-window cell is unpickable on-device.
//     Pixel-level collapse is browser-verify (package policy); here we gate on
//     the graph + uniforms.
//   • DISPATCH — the FULL `layer.pick()` path against a stubbed renderer, and
//     the hexbin-specific claims it must satisfy: `coordinate` is the CELL
//     CENTROID (what was clicked), `featureCoordinate` is the representative
//     feature's own position, and `featureCount` is the honest number of
//     contributors — never 1 just because provenance holds one entry.

import { describe, it, expect } from 'vitest';
import type { TileId } from '@poopdeck.gl/core';
import {
  buildHexbinBuffers,
  hexbinCentroidMercator,
  hexbinRadiusFromMeters,
  mercatorUnitToLngLat,
} from '../src/lib/hexbin-buffers';
import {
  createHexbinMaterial,
  createHexbinIdMaterial,
  updateHexbinUniforms,
  HexbinUniforms,
} from '../src/tsl/hexbin-material';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import {
  STTHexbinLayer,
  type STTHexbinPickInfo,
} from '../src/layers/hexbin-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import {
  GpuPicker,
  encodeId,
  type PickRenderer,
  type RenderTargetCtor,
} from '../src/lib/gpu-pick';
import { featureTileKey } from '../src/lib/id-pick';
import { makePointTile } from './_support/features';

const anchor = { longitude: 0, latitude: 0 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };

const RADIUS_M = 1000;
const R_MERC = hexbinRadiusFromMeters(RADIUS_M, 0);

/** Two probes that share one hexagon, and one that lands a column east of it. */
const A: [number, number] = [0, 0];
const B: [number, number] = [0.0122788, -0.0045665];
const D: [number, number] = [0.023, -0.004];
const CELL_AB: [number, number] = [11569, 13358];
const CELL_D: [number, number] = [11570, 13358];

/** Every layer/build in this file shares one lattice + one wide-open window. */
const LAYER_OPTS = {
  radius: RADIUS_M,
  radiusLatitude: 0,
  timeWindow: 4000,
} as const;
const BUFFER_OPTS = { radius: RADIUS_M, radiusLatitude: 0 };

// ── Fixtures ─────────────────────────────────────────────────────────────────

const hexIdA: TileId = { z: 12, x: 1, y: 2, t: 0 };
const hexIdB: TileId = { z: 12, x: 3, y: 4, t: 500 };
const KEY_A = featureTileKey(hexIdA, 'rides');
const KEY_B = featureTileKey(hexIdB, 'rides');

const hexTileA = makePointTile(
  2,
  [A[0], A[1], B[0], B[1]],
  {
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    featureIds: new Uint32Array([10, 11]),
  },
  { id: hexIdA, layerName: 'rides', timeOffset: 0 },
);
const hexTileB = makePointTile(
  1,
  [D[0], D[1]],
  {
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([500]),
    featureIds: new Uint32Array([12]),
  },
  { id: hexIdB, layerName: 'rides', timeOffset: 500 },
);

/** The lattice centroid of a cell, in lon/lat — what a hexbin pick reports. */
function centroidOf(cell: [number, number]): [number, number] {
  return mercatorUnitToLngLat(
    ...hexbinCentroidMercator(cell[0], cell[1], R_MERC),
  );
}

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

// ── PROVENANCE ───────────────────────────────────────────────────────────────

describe('buildHexbinBuffers provenance (one entry per CELL)', () => {
  it('records a cell REPRESENTATIVE per cell, in draw order, + a tileKey map', () => {
    const buf = buildHexbinBuffers([hexTileA, hexTileB], proj, 0, BUFFER_OPTS);
    expect(buf.count).toBe(2);
    expect(buf.provenance.length).toBe(2);
    // Cell 0 aggregates BOTH of tile A's features; the entry names the first.
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: KEY_A,
      featureIndex: 0,
    });
    // Boundary: the first cell opened by tile B.
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: KEY_B,
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(2)).toBeNull();
    expect(buf.binaryByTileKey.get(KEY_A)).toBe(hexTileA.layers[0].features);
    expect(buf.binaryByTileKey.get(KEY_B)).toBe(hexTileB.layers[0].features);
    expect(buf.binaryByTileKey.size).toBe(2);
    // The membership table is the honest contributor count, not the provenance.
    expect(buf.memberOffsets[1] - buf.memberOffsets[0]).toBe(2);
    expect(buf.memberOffsets[2] - buf.memberOffsets[1]).toBe(1);
  });

  it('emits empty (non-null) pick buffers when no cells merge', () => {
    const buf = buildHexbinBuffers([], proj, 0, BUFFER_OPTS);
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

// ── ID MATERIAL ──────────────────────────────────────────────────────────────

describe('createHexbinIdMaterial (reuses the colour material collapse gates)', () => {
  it('builds a positionNode + opacityNode graph in both gate configurations', () => {
    for (const timeFiltered of [true, false]) {
      const b = createHexbinIdMaterial({ timeFiltered });
      expect(b.material.positionNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.material.colorNode).toBeTruthy();
      expect(b.timeFiltered).toBe(timeFiltered);
      expect(b.time).toBeInstanceOf(TimeFilterUniforms);
      expect(b.hexbin).toBeInstanceOf(HexbinUniforms);
    }
  });

  it('is opaque and exactly decodable (never blended, never colour-managed)', () => {
    const b = createHexbinIdMaterial({ timeFiltered: true });
    expect(b.material.transparent).toBe(false);
    expect(b.material.depthWrite).toBe(true);
    expect(b.material.alphaTest).toBe(0.5);
  });

  it('carries the same bundle SHAPE as the colour material, so one updater serves both', () => {
    const colour = createHexbinMaterial({ timeFiltered: true });
    const id = createHexbinIdMaterial({ timeFiltered: true });
    for (const bundle of [colour, id]) {
      updateHexbinUniforms(bundle, {
        relativeCurrentTime: 250,
        params: { windowHalf: 2000 },
        opacity: 0.5,
        elevationScale: 3,
      });
      expect(bundle.time.currentTime.value).toBe(250);
      expect(bundle.time.windowHalf.value).toBe(2000);
      expect(bundle.hexbin.opacity.value).toBe(0.5);
      expect(bundle.hexbin.elevationScale.value).toBe(3);
    }
    colour.material.dispose();
    id.material.dispose();
  });
});

// ── DISPATCH ─────────────────────────────────────────────────────────────────

describe('STTHexbinLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  it('resolves a decoded CELL id to {tileKey, featureIndex, kind:hexbin}', () => {
    const layer = new STTHexbinLayer({ id: 'rides', ...LAYER_OPTS });
    layer.setTiles([hexTileA, hexTileB], ctx);
    const hit = layer.resolvePick(1, [12, 34]) as STTHexbinPickInfo;
    expect(hit).not.toBeNull();
    expect(hit.kind).toBe('hexbin');
    expect(hit.layerId).toBe('rides');
    expect(hit.tileKey).toBe(KEY_B);
    expect(hit.featureIndex).toBe(0);
    expect(hit.object!.id).toBe(12);
    expect(hit.screen).toEqual([12, 34]);
    // Out of range ⇒ a miss, never a wrapped index.
    expect(layer.resolvePick(2)).toBeNull();
    expect(layer.resolvePick(-1)).toBeNull();
    layer.dispose();
  });

  it('reports the CELL, not the representative: centroid + contributor count', () => {
    const layer = new STTHexbinLayer({ id: 'rides', ...LAYER_OPTS });
    layer.setTiles([hexTileA, hexTileB], ctx);

    const cell0 = layer.resolvePick(0) as STTHexbinPickInfo;
    expect(cell0.cellIndex).toBe(0);
    expect(cell0.cell).toEqual(CELL_AB);
    // TWO features fed this cell — this is the number that must not be 1 just
    // because provenance holds a single representative entry.
    expect(cell0.featureCount).toBe(2);
    expect(cell0.value).toBe(2); // COUNT hexbin: no weight column
    // `coordinate` is the hexagon's own centre (the thing under the cursor)…
    const [clon, clat] = centroidOf(CELL_AB);
    expect(cell0.coordinate![0]).toBeCloseTo(clon, 9);
    expect(cell0.coordinate![1]).toBeCloseTo(clat, 9);
    // …while the representative feature's position rides along separately, and
    // the two are genuinely different points.
    expect(cell0.featureCoordinate).toEqual([A[0], A[1]]);
    expect(cell0.featureCoordinate![0]).not.toBeCloseTo(clon, 6);
    // The representative is feature 0 of tile A even though feature 1 is in the
    // same cell — deterministic merge order, not "whichever was nearest".
    expect(cell0.object!.id).toBe(10);

    const cell1 = layer.resolvePick(1) as STTHexbinPickInfo;
    expect(cell1.cell).toEqual(CELL_D);
    expect(cell1.featureCount).toBe(1);
    expect(cell1.featureCoordinate).toEqual([D[0], D[1]]);
    layer.dispose();
  });

  it('drives the full pick() path and restores the colour material', async () => {
    const layer = new STTHexbinLayer({ id: 'rides', ...LAYER_OPTS });
    layer.setTiles([hexTileA, hexTileB], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(1)); // cell 1 → tile B feat 0
    const hit = (await layer.pick(picker, camera, 12, 34)) as STTHexbinPickInfo;
    expect(hit).not.toBeNull();
    expect(hit.kind).toBe('hexbin');
    expect(hit.cellIndex).toBe(1);
    expect(hit.tileKey).toBe(KEY_B);
    expect(hit.screen).toEqual([12, 34]);
    // The id material is swapped in only for the render; the colour one is back.
    expect(layer.object.material).toBe(colourMat);
    layer.dispose();
  });

  it('reports a sentinel background readback as a miss (no hit)', async () => {
    const layer = new STTHexbinLayer({ id: 'rides', ...LAYER_OPTS });
    layer.setTiles([hexTileA, hexTileB], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]); // ≥ cell count
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('returns null (never touches the GPU) when there are no cells', async () => {
    const layer = new STTHexbinLayer({ id: 'rides', ...LAYER_OPTS });
    layer.setTiles([], ctx);
    expect(layer.object.visible).toBe(false);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('drops the stale identity when a reload empties the layer', async () => {
    const layer = new STTHexbinLayer({ id: 'rides', ...LAYER_OPTS });
    layer.setTiles([hexTileA, hexTileB], ctx);
    expect(layer.resolvePick(0)).not.toBeNull();
    layer.setTiles([], ctx);
    // The empty build's provenance was adopted, so a stale id resolves to null
    // rather than to a cell that is no longer on screen.
    expect(layer.resolvePick(0)).toBeNull();
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });
});
