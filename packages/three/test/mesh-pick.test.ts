// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// GPU id-buffer picking for the MESH kind — instanced 3D models, one per ACTIVE
// tracked object. Three seams, mirroring the proven column/icon template:
//   • PROVENANCE — `buildMeshTrackIndex` records one entry per TRACK (not per
//     keyframe, and not per draw slot) plus a `tileKey → BinaryFeatures` map.
//     This kind's decoded id is the stable TRACK ORDINAL, because draw order is
//     the active set at the playhead and changes every frame; the bake paints
//     that ordinal into `sttIdColor`, so the id indexes the provenance array by
//     construction. The cases below pin exactly that.
//   • ID MATERIAL — `createMeshIdMaterial` BUILDS (TSL graph) the SAME pose
//     composition as the colour material, so a model picks where it is drawn,
//     and thresholds the SAME fade alpha so a barely-visible model does not win
//     a pick. Pixel-level behaviour is browser-verify (this package's policy);
//     here we gate on the graph + uniforms.
//   • DISPATCH — the FULL `layer.pick()` path with a stub renderer/readback (as
//     `gpu-pick-readback.test.ts` does): a chosen id colour resolves to the
//     right `{tileKey, featureIndex, kind:'mesh'}`, the coordinate reports the
//     INTERPOLATED pose, a sentinel background is a miss, and every child mesh's
//     material is swapped in only for the render and restored after.

import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute } from 'three';
import type { BinaryFeatures, Tile, TileId } from '@poopdeck.gl/core';
import {
  buildMeshTrackIndex,
  type MeshTrackOptions,
} from '../src/lib/mesh-instances';
import {
  createMeshMaterial,
  createMeshIdMaterial,
  MeshUniforms,
} from '../src/tsl/mesh-material';
import { STTMeshLayer, resetMeshWarnings } from '../src/layers/mesh-layer';
import { LocalEnuProjection } from '../src/projection/local-enu';
import {
  GpuPicker,
  encodeId,
  type PickRenderer,
  type RenderTargetCtor,
} from '../src/lib/gpu-pick';
import { featureTileKey } from '../src/lib/id-pick';
import { makePointTile } from './_support/features';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const ctx = { projection: proj, timeOrigin: 0 };

const TRACK_OPTS: MeshTrackOptions = {
  trackIdProperty: 'track_id',
  colorProperty: 'category',
  colorMapping: {},
  colorMappingDefault: [255, 255, 255, 255],
  labelProperty: 'category',
  headingProperty: 'heading',
  lengthProperty: 'length',
  widthProperty: 'width',
  heightProperty: 'height',
  speedProperty: 'speed',
  quaternionColumn: '',
};

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  t: number;
  lon: number;
  lat: number;
  category?: string;
}

function catProp(values: string[]): {
  indices: Uint16Array;
  categories: string[];
} {
  const categories: string[] = [];
  const indices = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let k = categories.indexOf(values[i]);
    if (k < 0) {
      k = categories.length;
      categories.push(values[i]);
    }
    indices[i] = k;
  }
  return { indices, categories };
}

function trackTile(
  rows: Row[],
  opts: { id?: TileId; timeOffset?: number } = {},
): Tile {
  const positions: number[] = [];
  for (const r of rows) positions.push(r.lon, r.lat);
  const partial: Partial<BinaryFeatures> = {
    startTimes: new Float32Array(rows.map((r) => r.t)),
    endTimes: new Float32Array(rows.map((r) => r.t)),
    featureIds: new Uint32Array(rows.map((_, i) => 100 + i)),
    categoricalProps: {
      track_id: catProp(rows.map((r) => r.id)),
      category: catProp(rows.map((r) => r.category ?? 'car')),
    },
    numericProps: {
      heading: new Float32Array(rows.length),
      length: new Float32Array(rows.map(() => 4)),
      width: new Float32Array(rows.map(() => 2)),
      height: new Float32Array(rows.map(() => 1.6)),
      speed: new Float32Array(rows.map(() => 3)),
    },
  };
  return makePointTile(rows.length, positions, partial, {
    id: opts.id,
    layerName: 'objects',
    timeOffset: opts.timeOffset ?? 0,
  });
}

const idA: TileId = { z: 14, x: 1, y: 2, t: 0 };
const idB: TileId = { z: 14, x: 1, y: 2, t: 2000 };

/** Track A lives 0–1000 in tile A; track B lives 2000–3000 in tile B. */
const tileA = trackTile(
  [
    { id: 'A', t: 0, lon: anchor.longitude, lat: anchor.latitude },
    { id: 'A', t: 1000, lon: anchor.longitude + 0.002, lat: anchor.latitude },
  ],
  { id: idA, timeOffset: 0 },
);
const tileB = trackTile(
  [
    {
      id: 'B',
      t: 0,
      lon: anchor.longitude + 0.01,
      lat: anchor.latitude,
      category: 'ped',
    },
    {
      id: 'B',
      t: 1000,
      lon: anchor.longitude + 0.012,
      lat: anchor.latitude,
      category: 'ped',
    },
  ],
  { id: idB, timeOffset: 2000 },
);

/** A unit model in the layer's convention (+x forward, +y left, +z up). */
function unitModel(): BufferGeometry {
  return new BoxGeometry(1, 1, 1);
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

// ── PROVENANCE ──────────────────────────────────────────────────────────────

describe('buildMeshTrackIndex provenance', () => {
  it('records one entry per TRACK in ordinal order + a tileKey→binary map', () => {
    const index = buildMeshTrackIndex([tileA, tileB], TRACK_OPTS);
    expect(index.ordinals.length).toBe(2);
    expect(index.provenance.length).toBe(2);
    expect(index.provenance.resolve(0)).toEqual({
      tileKey: featureTileKey(idA, 'objects'),
      featureIndex: 0,
    });
    // Boundary: the first track of the second tile.
    expect(index.provenance.resolve(1)).toEqual({
      tileKey: featureTileKey(idB, 'objects'),
      featureIndex: 0,
    });
    expect(index.provenance.resolve(2)).toBeNull();
    expect(index.binaryByTileKey.get(featureTileKey(idA, 'objects'))).toBe(
      tileA.layers[0].features,
    );
    expect(index.binaryByTileKey.get(featureTileKey(idB, 'objects'))).toBe(
      tileB.layers[0].features,
    );
    expect(index.binaryByTileKey.size).toBe(2);
  });

  it('emits empty (non-null) pick buffers when nothing pools', () => {
    const index = buildMeshTrackIndex([], TRACK_OPTS);
    expect(index.ordinals.length).toBe(0);
    expect(index.provenance.length).toBe(0);
    expect(index.binaryByTileKey.size).toBe(0);
  });
});

// ── ID MATERIAL ─────────────────────────────────────────────────────────────

describe('createMeshIdMaterial (reuses the colour material pose + fade gate)', () => {
  it('builds a positionNode + opacityNode + colorNode graph', () => {
    const b = createMeshIdMaterial();
    expect(b.material.positionNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.material.colorNode).toBeTruthy();
    expect(b.mesh).toBeInstanceOf(MeshUniforms);
  });

  it('carries NO time-filter uniforms — this kind has no window gate at all', () => {
    // The absence is the whole design (an inactive track emits no instance), so
    // it is asserted rather than left to be noticed.
    const colour = createMeshMaterial();
    const id = createMeshIdMaterial();
    expect(colour.timeFiltered).toBe(false);
    expect(id.timeFiltered).toBe(false);
    expect('time' in colour).toBe(false);
    expect('filter' in id).toBe(false);
  });

  it('is opaque and hard-alpha-tested so a faded model cannot win a partial pick', () => {
    const id = createMeshIdMaterial({ alphaCutoff: 0.25 });
    expect(id.material.transparent).toBe(false);
    expect(id.material.alphaTest).toBe(0.5);
    expect(id.material.depthWrite).toBe(true);
    // Never lit: the id must decode to an exact 24-bit RGB, unmodulated.
    expect(id.lit).toBe(false);
  });

  it('leaves the colour material free to be lit / transparent / wireframe', () => {
    const lit = createMeshMaterial({ lit: true, transparent: true });
    expect(lit.lit).toBe(true);
    expect(lit.material.transparent).toBe(true);
    expect(lit.material.depthWrite).toBe(false);
    expect(lit.material.alphaTest).toBe(0.01);
    const flat = createMeshMaterial({ lit: false, wireframe: true });
    expect(flat.lit).toBe(false);
    expect(flat.material.wireframe).toBe(true);
    expect(flat.material.transparent).toBe(false);
  });
});

// ── DISPATCH ────────────────────────────────────────────────────────────────

describe('STTMeshLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  it('resolves a decoded id colour to the right {tileKey, featureIndex, kind:mesh}', async () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([tileA, tileB], ctx);
    layer.setTime(2500); // only track B (ordinal 1) is active
    const colourMat = (layer.object.children[0] as { material: unknown })
      .material;

    const { picker, camera } = mockPicker(encodeId(1));
    const hit = await layer.pick(picker, camera, 12, 34);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('mesh');
    expect(hit!.layerId).toBe('objects');
    expect(hit!.tileKey).toBe(featureTileKey(idB, 'objects'));
    expect(hit!.featureIndex).toBe(0);
    expect(hit!.object!.track_id).toBe('B');
    expect(hit!.object!.category).toBe('ped');
    expect(hit!.object!.id).toBe(100);
    expect(hit!.tileId).toMatchObject(idB);
    expect(hit!.screen).toEqual([12, 34]);
    // The id material is swapped in only for the render; the colour restored.
    expect((layer.object.children[0] as { material: unknown }).material).toBe(
      colourMat,
    );
    layer.dispose();
  });

  it('reports the INTERPOLATED coordinate, not the representative keyframe', async () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([tileA, tileB], ctx);
    layer.setTime(2500); // halfway along track B's 0.01 → 0.012 leg
    const { picker, camera } = mockPicker(encodeId(1));
    const hit = await layer.pick(picker, camera, 5, 6);
    // Provenance points at feature 0 (lon +0.010); the model is DRAWN at +0.011.
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude + 0.011, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude, 9);
    layer.dispose();
  });

  it('keeps the id stable as the DRAW SLOT moves (ordinal, not slot, is the id)', async () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([tileA, tileB], ctx);

    // Frame 1: only track A is active, so it draws at slot 0 and its id is 0.
    layer.setTime(500);
    const first = await (async () => {
      const { picker, camera } = mockPicker(encodeId(0));
      return layer.pick(picker, camera, 1, 1);
    })();
    expect(first!.object!.track_id).toBe('A');

    // Frame 2: only track B is active — it now draws at slot 0 too, but its id
    // is still ordinal 1. Reading id 0 here must NOT report track A's model.
    layer.setTime(2500);
    const { picker, camera } = mockPicker(encodeId(1));
    const second = await layer.pick(picker, camera, 1, 1);
    expect(second!.object!.track_id).toBe('B');
    layer.dispose();
  });

  it('reports a sentinel background readback as a miss (no hit)', async () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([tileA, tileB], ctx);
    layer.setTime(500);
    const { picker, camera } = mockPicker([255, 255, 255]); // white → ≥ count
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('returns null (never touches the GPU) when there are no tracks', async () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([], ctx);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('returns null when every track is inactive at the playhead', async () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([tileA, tileB], ctx);
    layer.setTime(99_000); // past every keyframe span
    expect(layer.getActiveSamples().length).toBe(0);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('picks across PER-CATEGORY sublayers, restoring every child material', async () => {
    const car = unitModel();
    const ped = unitModel();
    const layer = new STTMeshLayer({
      id: 'objects',
      mesh: car,
      meshMapping: { ped },
    });
    layer.setTiles([tileA, tileB], ctx);
    // Nudge both tracks' spans into one frame: track A ends at 1000, track B
    // starts at 2000, so pick each in its own frame but through the SAME layer.
    layer.setTime(2500);
    const children = layer.object.children as Array<{ material: unknown }>;
    const before = children.map((c) => c.material);

    const { picker, camera } = mockPicker(encodeId(1));
    const hit = await layer.pick(picker, camera, 7, 8);
    expect(hit!.object!.category).toBe('ped');
    expect(children.map((c) => c.material)).toEqual(before);
    layer.dispose();
  });
});

// ── LAYER PLUMBING ──────────────────────────────────────────────────────────

describe('STTMeshLayer geometry + lifecycle', () => {
  it('CLONES the caller’s model so dispose() never frees a host-supplied buffer', () => {
    const source = unitModel();
    const layer = new STTMeshLayer({ id: 'objects', mesh: source });
    layer.setTiles([tileA], ctx);
    layer.setTime(500);
    const child = layer.object.children[0] as {
      geometry: BufferGeometry;
    };
    expect(child.geometry.getAttribute('position')).not.toBe(
      source.getAttribute('position'),
    );
    layer.dispose();
    // The caller's geometry is untouched and still usable.
    expect(source.getAttribute('position').count).toBeGreaterThan(0);
    expect(layer.object.children.length).toBe(0);
  });

  it('computes normals for a model that ships none (WebGPU hard-fails without them)', () => {
    const bare = new BufferGeometry();
    bare.setAttribute(
      'position',
      new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
    );
    const layer = new STTMeshLayer({ id: 'objects', mesh: bare });
    layer.setTiles([tileA], ctx);
    layer.setTime(500);
    const child = layer.object.children[0] as { geometry: BufferGeometry };
    expect(child.geometry.getAttribute('normal')).toBeTruthy();
    layer.dispose();
  });

  it('binds every per-instance attribute and tracks instanceCount', () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([tileA, tileB], ctx);
    layer.setTime(500);
    const geom = (layer.object.children[0] as { geometry: BufferGeometry })
      .geometry as BufferGeometry & { instanceCount: number };
    for (const name of [
      'sttCenter',
      'sttBasisX',
      'sttBasisY',
      'sttBasisZ',
      'sttColor',
      'sttIdColor',
    ]) {
      expect(geom.getAttribute(name)).toBeTruthy();
    }
    expect(geom.instanceCount).toBe(1); // only track A is active at 500
    layer.setTime(99_000);
    expect(geom.instanceCount).toBe(0);
    layer.dispose();
  });

  it('bounds the geometry over EVERY keyframe (static camera framing)', () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([tileA, tileB], ctx);
    layer.setTime(500);
    const geom = (layer.object.children[0] as { geometry: BufferGeometry })
      .geometry;
    // The box spans track B's far keyframe (0.012° east) even though only track
    // A is drawn right now.
    const span = 0.012 * 111_320 * Math.cos((anchor.latitude * Math.PI) / 180);
    expect(geom.boundingBox!.max.x).toBeCloseTo(span, 1);
    expect(geom.boundingSphere).toBeTruthy();
    layer.dispose();
  });

  it('renders nothing, and warns exactly once, when no model is supplied', () => {
    resetMeshWarnings();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = new STTMeshLayer({ id: 'no-model', mesh: null });
      layer.setTiles([tileA], ctx);
      layer.setTime(500);
      layer.setTiles([tileA, tileB], ctx);
      expect(layer.object.children.length).toBe(0);
      expect(layer.getActiveSamples().length).toBe(0);
      // One-shot: a second setTiles must not re-warn.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('no `mesh`');
      layer.dispose();
    } finally {
      warn.mockRestore();
      resetMeshWarnings();
    }
  });

  it('skips the re-bake when setTime repeats the same playhead', () => {
    const layer = new STTMeshLayer({ id: 'objects', mesh: unitModel() });
    layer.setTiles([tileA], ctx);
    layer.setTime(500);
    const before = layer.getActiveSamples()[0];
    layer.setTime(500);
    // A paused clock still renders every frame; the O(resident tracks) walk
    // must not run again — the same Sample object comes back.
    expect(layer.getActiveSamples()[0]).toBe(before);
    layer.setTime(600);
    expect(layer.getActiveSamples()[0]).not.toBe(before);
    layer.dispose();
  });
});
