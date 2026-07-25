// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// GPU id-buffer picking on the two MERGED-MESH kinds — `polygon` (indexed
// triangle fill) and `iso` (density-contour `LineSegments`). These are the one
// geometry case the instanced template (point / column / arc) did NOT cover: a
// polygon/iso layer is ONE merged, NON-instanced mesh, so the per-instance id
// trick can't apply. Instead the id colour is a PER-VERTEX attribute — every
// vertex of a feature is painted the SAME colour, encoding that feature's MERGED
// index — and provenance is pushed once per emitted feature. The three seams,
// mirroring the instanced proofs:
//   • PROVENANCE + PER-VERTEX ID COLOUR — the builder records one slot per emitted
//     feature (draw order) + a `tileKey → BinaryFeatures` map, and paints every one
//     of a feature's mesh vertices its merged-index colour (`idColors`).
//   • ID MATERIAL — the id-material variant BUILDS with the SAME vertex-stage
//     collapse gates as the colour material (window + column-filter + time-height
//     for polygon; window for iso), so an out-of-window / out-of-range primitive is
//     unpickable on-device. Pixel-level collapse is browser-verify (package policy).
//   • DISPATCH — the FULL `layer.pick()` path with a stub renderer/readback: a
//     chosen id colour resolves to the right `{kind, tileKey, featureIndex}` and the
//     merged-mesh coordinate (the feature's first SOURCE vertex, via the indexed
//     `resolveIdPick` path), a sentinel background is a miss, and the id material is
//     swapped onto the child mesh only for the render and restored after.

import { describe, it, expect } from 'vitest';
import type { Mesh, LineSegments } from 'three';
import { GeometryType } from '@poopdeck.gl/core';
import type { TileId } from '@poopdeck.gl/core';
import { buildPolygonBuffers } from '../src/layers/polygon-buffers';
import {
  createPolygonIdMaterial,
  TimeHeightUniforms as PolygonTimeHeightUniforms,
} from '../src/tsl/polygon-material';
import { createIsoLineIdMaterial } from '../src/tsl/iso-line-material';
import { DataFilterUniforms } from '../src/tsl/data-filter';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import { STTPolygonLayer } from '../src/layers/polygon-layer';
import { STTIsoLayer } from '../src/layers/iso-layer';
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
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };

/** Stub `GpuPicker` whose readback RETURNS one 1×1 texel painted `rgb` — no GPU
 *  device (the exact seam of `column-arc-pick.test.ts` / `gpu-pick-readback`). */
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

// ── POLYGON fixtures ──────────────────────────────────────────────────────────

// A CCW square ~d° on a side, centred near the anchor.
function square(d: number): number[] {
  return [
    anchor.longitude - d,
    anchor.latitude - d,
    anchor.longitude + d,
    anchor.latitude - d,
    anchor.longitude + d,
    anchor.latitude + d,
    anchor.longitude - d,
    anchor.latitude + d,
  ];
}

const polyId: TileId = { z: 12, x: 1, y: 2, t: 0 };
// Two polygon features (two squares), so the merged index of the SECOND is
// non-trivial and its per-vertex id colour must land on its own mesh vertices.
const polyTile = makeLineTile(
  {
    featureCount: 2,
    positions: new Float64Array([...square(0.0001), ...square(0.0002)]),
    startIndices: new Uint32Array([0, 4, 8]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    numericProps: { level: new Float32Array([3, 7]) },
    featureIds: new Uint32Array([200, 201]),
  },
  {
    id: polyId,
    layerName: 'storms',
    geometryType: GeometryType.Polygon,
    geometryExtensionName: 'geoarrow.polygon',
  },
);
const POLY_KEY = featureTileKey(polyId, 'storms');
const POLY_OPTS = {
  colorMode: { type: 'constant' as const, color: [255, 0, 0, 255] as const },
};

describe('buildPolygonBuffers pick identity (MERGED mesh: per-vertex id colour)', () => {
  it('records one provenance slot per feature + a tileKey→binary map', () => {
    const buf = buildPolygonBuffers([polyTile], proj, 0, POLY_OPTS);
    expect(buf.provenance.length).toBe(2);
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: POLY_KEY,
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: POLY_KEY,
      featureIndex: 1,
    });
    expect(buf.provenance.resolve(2)).toBeNull();
    expect(buf.binaryByTileKey.get(POLY_KEY)).toBe(polyTile.layers[0].features);
    expect(buf.binaryByTileKey.size).toBe(1);
  });

  it('paints EVERY vertex of a feature with its own merged-index colour', () => {
    const buf = buildPolygonBuffers([polyTile], proj, 0, POLY_OPTS);
    // One id colour (vec3) per mesh vertex.
    expect(buf.idColors.length).toBe(buf.vertexCount * 3);
    expect(buf.vertexCount).toBe(8); // 4 + 4 ring vertices

    // Feature 0 → merged index 0 → encodeId(0) = (0,0,0); its 4 vertices (mesh
    // 0..3) all carry it.
    for (let v = 0; v < 4; v++) {
      expect(buf.idColors[v * 3]).toBe(0);
      expect(buf.idColors[v * 3 + 1]).toBe(0);
      expect(buf.idColors[v * 3 + 2]).toBe(0);
    }
    // Feature 1 → merged index 1 → encodeId(1) = (0,0,1); its 4 vertices (mesh
    // 4..7) all carry (0, 0, 1/255) — distinct from feature 0, constant within.
    for (let v = 4; v < 8; v++) {
      expect(buf.idColors[v * 3]).toBe(0);
      expect(buf.idColors[v * 3 + 1]).toBe(0);
      expect(buf.idColors[v * 3 + 2]).toBeCloseTo(1 / 255, 9);
    }
  });

  it('covers the EXTRUSION top-cap vertices with the same feature id colour', () => {
    const extrudeTile = makeLineTile(
      {
        positions: new Float64Array(square(0.0001)),
        startIndices: new Uint32Array([0, 4]),
        numericProps: { h: new Float32Array([5]) },
      },
      { geometryType: GeometryType.Polygon, layerName: 'storms' },
    );
    const buf = buildPolygonBuffers([extrudeTile], proj, 0, {
      ...POLY_OPTS,
      extrusionProperty: 'h',
    });
    // base 4 + top 4 = 8 vertices; every one is feature 0 (id colour (0,0,0)).
    expect(buf.vertexCount).toBe(8);
    expect(buf.idColors.length).toBe(24);
    for (const c of buf.idColors) expect(c).toBe(0);
  });

  it('emits empty (non-null) pick buffers when no polygons merge', () => {
    const buf = buildPolygonBuffers([], proj, 0, POLY_OPTS);
    expect(buf.vertexCount).toBe(0);
    expect(buf.idColors.length).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

describe('createPolygonIdMaterial (reuses the colour material collapse gates)', () => {
  it('builds colour + opacity nodes; a static (none) fill is always opaque-pickable', () => {
    const b = createPolygonIdMaterial({});
    expect(b.material.colorNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.time).toBeInstanceOf(TimeFilterUniforms);
    // `none` mode + no filter/lift ⇒ no vertex collapse gate (static geometry
    // position; the node material leaves `positionNode` at its null default).
    expect(b.material.positionNode).toBeNull();
    expect(b.filter).toBeUndefined();
    expect(b.timeHeight).toBeUndefined();
  });

  it('installs the window + column-filter + time-as-height gates when requested', () => {
    const b = createPolygonIdMaterial({
      mode: 'window',
      dataFilter: true,
      timeHeight: true,
    });
    expect(b.material.positionNode).toBeTruthy(); // window collapse present
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.filter).toBeInstanceOf(DataFilterUniforms); // column-filter collapse
    expect(b.timeHeight).toBeInstanceOf(PolygonTimeHeightUniforms); // space-time-cube lift
  });
});

describe('STTPolygonLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  it('resolves a merged id colour to the right polygon + its FIRST source vertex', async () => {
    const layer = new STTPolygonLayer({ id: 'storms', ...POLY_OPTS });
    layer.setTiles([polyTile], ctx);
    const mesh = layer.object.children[0] as Mesh;
    const colourMat = mesh.material;

    const { picker, camera } = mockPicker(encodeId(1)); // merged 1 → feature 1
    const hit = await layer.pick(picker, camera, 15, 25);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('polygon');
    expect(hit!.layerId).toBe('storms');
    expect(hit!.tileKey).toBe(POLY_KEY);
    expect(hit!.featureIndex).toBe(1);
    expect(hit!.object!.level).toBeCloseTo(7, 5);
    expect(hit!.object!.id).toBe(201);
    // Merged-mesh coordinate = feature 1's FIRST source vertex (startIndices[1]=4),
    // resolved from the SOURCE binary — not the merged geometry.
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude - 0.0002, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude - 0.0002, 9);
    expect(hit!.screen).toEqual([15, 25]);
    // The id material is swapped onto the child mesh only for the render + restored.
    expect(mesh.material).toBe(colourMat);
  });

  it('reports a sentinel background readback as a miss (collapsed/absent)', async () => {
    const layer = new STTPolygonLayer({ id: 'storms', ...POLY_OPTS });
    layer.setTiles([polyTile], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]); // white → MAX_PICK_ID ≥ count
    expect(await layer.pick(picker, camera, 15, 25)).toBeNull();
  });

  it('returns null (never touches the GPU) when there are no polygons', async () => {
    const layer = new STTPolygonLayer({ id: 'storms', ...POLY_OPTS });
    layer.setTiles([], ctx);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 15, 25)).toBeNull();
  });
});

// ── ISO fixtures ──────────────────────────────────────────────────────────────

const isoId: TileId = { z: 14, x: 3, y: 4, t: 0 };
// Two density contours (2 vertices each → 1 segment each), so the second contour
// takes merged slot 1 and paints its own segment's endpoints.
const isoTile = makeLineTile(
  {
    featureCount: 2,
    positions: new Float64Array([
      anchor.longitude,
      anchor.latitude,
      anchor.longitude + 0.001,
      anchor.latitude, // contour 0: 2 verts
      anchor.longitude - 0.002,
      anchor.latitude + 0.001,
      anchor.longitude - 0.001,
      anchor.latitude + 0.001, // contour 1: first vert idx 2
    ]),
    startIndices: new Uint32Array([0, 2, 4]),
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    featureIds: new Uint32Array([300, 301]),
  },
  { id: isoId, layerName: 'iso' },
);
const ISO_KEY = featureTileKey(isoId, 'iso');

describe('createIsoLineIdMaterial (reuses the colour material window collapse gate)', () => {
  it('builds position + colour + opacity nodes with the window gate', () => {
    const b = createIsoLineIdMaterial();
    expect(b.material.positionNode).toBeTruthy(); // window collapse (always on for iso)
    expect(b.material.colorNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.time).toBeInstanceOf(TimeFilterUniforms);
    expect(b.iso.opacity).toBeTruthy();
  });
});

describe('STTIsoLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  it('resolves a merged id colour to the right contour + its FIRST source vertex', async () => {
    const layer = new STTIsoLayer({ id: 'iso' });
    layer.setTiles([isoTile], ctx);
    const lines = layer.object.children[0] as LineSegments;
    const colourMat = lines.material;

    const { picker, camera } = mockPicker(encodeId(1)); // merged 1 → contour 1
    const hit = await layer.pick(picker, camera, 40, 50);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('iso');
    expect(hit!.layerId).toBe('iso');
    expect(hit!.tileKey).toBe(ISO_KEY);
    expect(hit!.featureIndex).toBe(1);
    expect(hit!.object!.id).toBe(301);
    // Merged-mesh coordinate = contour 1's FIRST source vertex (startIndices[1]=2).
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude - 0.002, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude + 0.001, 9);
    expect(hit!.screen).toEqual([40, 50]);
    // The id material is swapped onto the child LineSegments only for the render.
    expect(lines.material).toBe(colourMat);
  });

  it('reports a sentinel background readback as a miss', async () => {
    const layer = new STTIsoLayer({ id: 'iso' });
    layer.setTiles([isoTile], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]);
    expect(await layer.pick(picker, camera, 40, 50)).toBeNull();
  });

  it('returns null (never touches the GPU) when there are no contours', async () => {
    const layer = new STTIsoLayer({ id: 'iso' });
    layer.setTiles([], ctx);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 40, 50)).toBeNull();
  });
});
