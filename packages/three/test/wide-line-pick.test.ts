// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// GPU id-buffer picking for the WIDE-LINE MATERIAL FAMILY — the `line`, `od-line`,
// `trips` and `path` kinds all ride the shared `createWideLineMaterial` ribbon, so
// ONE id material (`createWideLineIdMaterial`, per `mode`) serves all four. Three
// seams per kind, mirroring the column/arc template (`column-arc-pick.test.ts`):
//   • PROVENANCE — the segment builder records ONE entry per merged SEGMENT
//     instance in draw order (a multi-vertex feature's segments all point at the
//     same `featureIndex`, so a pick on any segment resolves to the parent feature)
//     + a `tileKey → BinaryFeatures` map. OD collapses each feature to one segment.
//   • ID MATERIAL — the id variant BUILDS (TSL graph) with the SAME width-collapse
//     gate as the colour material (window / trail + column filter). Pixel-level
//     collapse is browser-verify (this package's policy); here we gate on the graph.
//   • DISPATCH — the FULL `layer.pick()` path with a stub renderer/readback: a
//     chosen id colour resolves to the right `{tileKey, featureIndex, kind}`, a
//     sentinel background is a miss, and the id material is swapped in only for the
//     render and restored after.

import { describe, it, expect } from 'vitest';
import type { TileId } from '@poopdeck.gl/core';
import { buildLineSegmentBuffers } from '../src/lib/geo-line-buffers';
import { buildOdLineSegmentBuffers } from '../src/lib/od-positions';
import { buildTripsBuffers } from '../src/lib/trips-buffers';
import {
  createWideLineIdMaterial,
  WideLineUniforms,
} from '../src/tsl/wide-line-material';
import { DataFilterUniforms } from '../src/tsl/data-filter';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import { WideLineLayer } from '../src/layers/wide-line-layer';
import { OdLineLayer } from '../src/layers/od-line-layer';
import { TripsLayer } from '../src/layers/trips-layer';
import { PathGeoLayer } from '../src/layers/path-geo-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import {
  GpuPicker,
  encodeId,
  type PickRenderer,
  type RenderTargetCtor,
} from '../src/lib/gpu-pick';
import { featureTileKey } from '../src/lib/id-pick';
import { makeLineTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const L = anchor.longitude;
const A = anchor.latitude;
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };

const CONST_COLOR = {
  type: 'constant' as const,
  color: [255, 140, 0, 255] as [number, number, number, number],
};

// ── Shared fixture ────────────────────────────────────────────────────────────
// Two LineString features in one tile:
//   feature 0 — 3 vertices → 2 segments (merged instances 0,1)
//   feature 1 — 2 vertices → 1 segment  (merged instance 2)
// OD collapses each to ONE segment (instances 0,1). `vertexTimestamps` rides along
// so the trips builder is deterministic; the line/od/path paths ignore it.
const lineId: TileId = { z: 12, x: 1, y: 2, t: 0 };
const makeTile = () =>
  makeLineTile(
    {
      featureCount: 2,
      positions: new Float64Array([
        L,
        A, // f0 v0
        L + 0.001,
        A, // f0 v1
        L + 0.002,
        A, // f0 v2
        L + 0.003,
        A + 0.001, // f1 v0 (startIndices[1] = 3)
        L + 0.004,
        A + 0.001, // f1 v1
      ]),
      startIndices: new Uint32Array([0, 3, 5]),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([1000, 1000]),
      vertexTimestamps: new Float32Array([0, 500, 1000, 0, 1000]),
      featureIds: new Uint32Array([200, 201]),
    },
    { id: lineId, layerName: 'paths', timeOffset: 0 },
  );
const tileKey = featureTileKey(lineId, 'paths');

/** Stub `GpuPicker` whose readback RETURNS one 1×1 texel painted `rgb` — the exact
 *  seam of `gpu-pick-readback.test.ts` / `column-arc-pick.test.ts`, no GPU device. */
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

// ── PROVENANCE ────────────────────────────────────────────────────────────────

describe('buildLineSegmentBuffers provenance (line / path kinds)', () => {
  it('records one entry per merged SEGMENT in draw order + a tileKey→binary map', () => {
    const tile = makeTile();
    const buf = buildLineSegmentBuffers([tile], proj, 0, {
      colorMode: CONST_COLOR,
    });
    expect(buf.count).toBe(3); // 2 segments (f0) + 1 segment (f1)
    expect(buf.provenance.length).toBe(3);
    // Both of feature 0's segments point at featureIndex 0.
    expect(buf.provenance.resolve(0)).toEqual({ tileKey, featureIndex: 0 });
    expect(buf.provenance.resolve(1)).toEqual({ tileKey, featureIndex: 0 });
    // Feature 1's single segment.
    expect(buf.provenance.resolve(2)).toEqual({ tileKey, featureIndex: 1 });
    expect(buf.provenance.resolve(3)).toBeNull();
    expect(buf.binaryByTileKey.get(tileKey)).toBe(tile.layers[0].features);
    expect(buf.binaryByTileKey.size).toBe(1);
  });

  it('emits empty (non-null) pick buffers when no lines merge', () => {
    const buf = buildLineSegmentBuffers([], proj, 0, {
      colorMode: CONST_COLOR,
    });
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

describe('buildOdLineSegmentBuffers provenance (od-line kind)', () => {
  it('records one entry per merged OD instance (feature-collapsed) in draw order', () => {
    const tile = makeTile();
    const buf = buildOdLineSegmentBuffers([tile], proj, 0, {
      colorMode: CONST_COLOR,
    });
    expect(buf.count).toBe(2); // one OD segment per feature
    expect(buf.provenance.length).toBe(2);
    expect(buf.provenance.resolve(0)).toEqual({ tileKey, featureIndex: 0 });
    expect(buf.provenance.resolve(1)).toEqual({ tileKey, featureIndex: 1 });
    expect(buf.provenance.resolve(2)).toBeNull();
    expect(buf.binaryByTileKey.get(tileKey)).toBe(tile.layers[0].features);
  });

  it('emits empty (non-null) pick buffers when no OD lines merge', () => {
    const buf = buildOdLineSegmentBuffers([], proj, 0, {
      colorMode: CONST_COLOR,
    });
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

describe('buildTripsBuffers provenance (trips kind)', () => {
  it('records one entry per merged trail SEGMENT in draw order + a tileKey→binary map', () => {
    const tile = makeTile();
    const buf = buildTripsBuffers([tile], proj, 0, { colorMode: CONST_COLOR });
    expect(buf.count).toBe(3);
    expect(buf.provenance.length).toBe(3);
    expect(buf.provenance.resolve(0)).toEqual({ tileKey, featureIndex: 0 });
    expect(buf.provenance.resolve(1)).toEqual({ tileKey, featureIndex: 0 });
    expect(buf.provenance.resolve(2)).toEqual({ tileKey, featureIndex: 1 });
    expect(buf.provenance.resolve(3)).toBeNull();
    expect(buf.binaryByTileKey.get(tileKey)).toBe(tile.layers[0].features);
  });

  it('emits empty (non-null) pick buffers when no trips merge', () => {
    const buf = buildTripsBuffers([], proj, 0, { colorMode: CONST_COLOR });
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

// ── ID MATERIAL ───────────────────────────────────────────────────────────────

describe('createWideLineIdMaterial (reuses the colour material width-collapse gate)', () => {
  it('builds a vertexNode + opacityNode graph for every wide-line mode', () => {
    for (const mode of ['none', 'window', 'trail'] as const) {
      const b = createWideLineIdMaterial({ mode });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.mode).toBe(mode);
      expect(b.time).toBeInstanceOf(TimeFilterUniforms);
      expect(b.line).toBeInstanceOf(WideLineUniforms);
    }
  });

  it('installs the column-filter gate alongside the time gate when requested', () => {
    const b = createWideLineIdMaterial({ mode: 'window', dataFilter: true });
    expect(b.filter).toBeInstanceOf(DataFilterUniforms);
    expect(
      createWideLineIdMaterial({ mode: 'trail', dataFilter: false }).filter,
    ).toBeUndefined();
  });
});

// ── DISPATCH (full layer.pick, mock readback) ─────────────────────────────────

describe('WideLineLayer.pick (GPU id-buffer dispatch → `line` kind)', () => {
  it('resolves a merged id colour to the right {tileKey, featureIndex} + first vertex', async () => {
    const layer = new WideLineLayer({ id: 'paths', colorMode: CONST_COLOR });
    layer.setTiles([makeTile()], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(2)); // merged 2 → feature 1
    const hit = await layer.pick(picker, camera, 10, 10);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('line');
    expect(hit!.layerId).toBe('paths');
    expect(hit!.tileKey).toBe(tileKey);
    expect(hit!.featureIndex).toBe(1);
    expect(hit!.object!.id).toBe(201);
    // Coordinate = feature 1's FIRST vertex (startIndices[1] = 3).
    expect(hit!.coordinate![0]).toBeCloseTo(L + 0.003, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(A + 0.001, 9);
    expect(hit!.screen).toEqual([10, 10]);
    // The id material is swapped in only for the render; the colour material restored.
    expect(layer.object.material).toBe(colourMat);
  });

  it('resolves a segment of feature 0 to feature 0 (many segments → one feature)', async () => {
    const layer = new WideLineLayer({ id: 'paths', colorMode: CONST_COLOR });
    layer.setTiles([makeTile()], ctx);
    const { picker, camera } = mockPicker(encodeId(1)); // merged 1 → feature 0 (2nd seg)
    const hit = await layer.pick(picker, camera, 5, 5);
    expect(hit!.featureIndex).toBe(0);
    expect(hit!.object!.id).toBe(200);
  });

  it('reports a sentinel background readback as a miss', async () => {
    const layer = new WideLineLayer({ id: 'paths', colorMode: CONST_COLOR });
    layer.setTiles([makeTile()], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]); // → MAX_PICK_ID ≥ count
    expect(await layer.pick(picker, camera, 10, 10)).toBeNull();
  });

  it('returns null (never touches the GPU) when there are no lines', async () => {
    const layer = new WideLineLayer({ id: 'paths', colorMode: CONST_COLOR });
    layer.setTiles([], ctx);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 10, 10)).toBeNull();
  });
});

describe('OdLineLayer.pick (GPU id-buffer dispatch → `line` kind)', () => {
  it('resolves a merged id colour to the right OD feature + its SOURCE vertex', async () => {
    const layer = new OdLineLayer({ id: 'flows', colorMode: CONST_COLOR });
    layer.setTiles([makeTile()], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(1)); // merged 1 → feature 1
    const hit = await layer.pick(picker, camera, 20, 30);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('line');
    expect(hit!.layerId).toBe('flows');
    expect(hit!.tileKey).toBe(tileKey);
    expect(hit!.featureIndex).toBe(1);
    expect(hit!.object!.id).toBe(201);
    expect(hit!.coordinate![0]).toBeCloseTo(L + 0.003, 9);
    expect(layer.object.material).toBe(colourMat);
  });

  it('reports a sentinel background readback as a miss', async () => {
    const layer = new OdLineLayer({ id: 'flows', colorMode: CONST_COLOR });
    layer.setTiles([makeTile()], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]);
    expect(await layer.pick(picker, camera, 20, 30)).toBeNull();
  });
});

describe('TripsLayer.pick (GPU id-buffer dispatch → `trips` kind)', () => {
  it('resolves a trail segment to the whole trip', async () => {
    const layer = new TripsLayer({ id: 'trips', colorMode: CONST_COLOR });
    layer.setTiles([makeTile()], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(2)); // merged 2 → trip 1
    const hit = await layer.pick(picker, camera, 40, 40);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('trips');
    expect(hit!.layerId).toBe('trips');
    expect(hit!.tileKey).toBe(tileKey);
    expect(hit!.featureIndex).toBe(1);
    expect(hit!.object!.id).toBe(201);
    expect(layer.object.material).toBe(colourMat);
  });

  it('reports a sentinel background readback as a miss', async () => {
    const layer = new TripsLayer({ id: 'trips', colorMode: CONST_COLOR });
    layer.setTiles([makeTile()], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]);
    expect(await layer.pick(picker, camera, 40, 40)).toBeNull();
  });
});

describe('PathGeoLayer.pick (GPU id-buffer dispatch → `path` kind)', () => {
  it('resolves a merged id colour and reports the `path` kind (inherited machinery)', async () => {
    const layer = new PathGeoLayer({ id: 'path-geo', colorMode: CONST_COLOR });
    layer.setTiles([makeTile()], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(2)); // merged 2 → feature 1
    const hit = await layer.pick(picker, camera, 50, 60);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('path');
    expect(hit!.layerId).toBe('path-geo');
    expect(hit!.tileKey).toBe(tileKey);
    expect(hit!.featureIndex).toBe(1);
    expect(hit!.object!.id).toBe(201);
    expect(hit!.coordinate![0]).toBeCloseTo(L + 0.003, 9);
    expect(layer.object.material).toBe(colourMat);
  });

  it('reveal-trail mode still resolves as the `path` kind', async () => {
    const layer = new PathGeoLayer({
      id: 'path-reveal',
      colorMode: CONST_COLOR,
      revealTrail: true,
    });
    layer.setTiles([makeTile()], ctx);
    const { picker, camera } = mockPicker(encodeId(0)); // merged 0 → feature 0
    const hit = await layer.pick(picker, camera, 50, 60);
    expect(hit!.kind).toBe('path');
    expect(hit!.featureIndex).toBe(0);
  });
});
