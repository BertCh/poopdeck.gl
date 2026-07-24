// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// GPU id-buffer picking for the ICON kind — instanced billboard-quad directional
// markers (Point geometry), the same shape as `point` / `column`. Three seams,
// mirroring the proven column/arc template:
//   • PROVENANCE — `buildIconBuffers` records one entry per merged marker in draw
//     order + a `tileKey → BinaryFeatures` map (index alignment with the GPU id
//     the shader paints).
//   • ID MATERIAL — `createIconIdMaterial` BUILDS (TSL graph) with the SAME
//     collapse gates as the colour material (time-filter + wake taper + marker
//     filter), so an out-of-window / off-filter / tapered marker is unpickable
//     on-device. Pixel-level collapse is browser-verify (this package's policy);
//     here we gate on the graph + uniforms.
//   • DISPATCH — the FULL `layer.pick()` path with a stub renderer/readback (as
//     `gpu-pick-readback.test.ts` does): a chosen id colour resolves to the right
//     `{tileKey, featureIndex, kind:'icon'}`, a sentinel background is a miss, and
//     the id material is swapped in only for the render and restored after.

import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import type { TileId } from '@poopdeck.gl/core';
import {
  buildIconBuffers,
  type IconMappingEntry,
  type IconColorMode,
} from '../src/lib/icon-buffers';
import {
  createIconIdMaterial,
  IconUniforms,
  type IconMode,
} from '../src/tsl/icon-material';
import { DataFilterUniforms } from '../src/tsl/data-filter';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import { IconLayer } from '../src/layers/icon-layer';
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

const ATLAS_W = 256;
const ATLAS_H = 128;
const MAPPING: Record<string, IconMappingEntry> = {
  marker: { x: 0, y: 0, width: 64, height: 64 },
};
// Shared atlas/mapping shell. `IconLayer` resolves its own `colorMode` from
// `color`/`colorProperty`; the buffer builder takes an explicit `colorMode`, so
// the buffer-provenance test spreads this + a constant white `colorMode`.
const ATLAS_OPTS = {
  atlas: new Texture(),
  atlasWidth: ATLAS_W,
  atlasHeight: ATLAS_H,
  iconMapping: MAPPING,
  icon: 'marker',
};
const CONSTANT_TINT: IconColorMode = {
  type: 'constant',
  color: [255, 255, 255, 255] as [number, number, number, number],
};
const BUFFER_OPTS = {
  ...ATLAS_OPTS,
  angleProperty: 'heading' as const,
  sizeProperty: null,
  colorMode: CONSTANT_TINT,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

const iconIdA: TileId = { z: 12, x: 1, y: 2, t: 0 };
const iconIdB: TileId = { z: 12, x: 3, y: 4, t: 500 };
const iconTileA = makePointTile(
  2,
  [
    anchor.longitude,
    anchor.latitude,
    anchor.longitude + 0.001,
    anchor.latitude,
  ],
  {
    numericProps: { heading: new Float32Array([0, 90]) },
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    featureIds: new Uint32Array([10, 11]),
  },
  { id: iconIdA, layerName: 'vessels', timeOffset: 0 },
);
const iconTileB = makePointTile(
  1,
  [anchor.longitude + 0.002, anchor.latitude + 0.001],
  {
    numericProps: { heading: new Float32Array([45]) },
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([1000]),
    featureIds: new Uint32Array([12]),
  },
  { id: iconIdB, layerName: 'vessels', timeOffset: 500 },
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

// ── PROVENANCE ──────────────────────────────────────────────────────────────

describe('buildIconBuffers provenance', () => {
  it('records one entry per merged marker in emit order + a tileKey→binary map', () => {
    const buf = buildIconBuffers([iconTileA, iconTileB], proj, 0, BUFFER_OPTS);
    expect(buf.count).toBe(3);
    expect(buf.provenance.length).toBe(3);
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: featureTileKey(iconIdA, 'vessels'),
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: featureTileKey(iconIdA, 'vessels'),
      featureIndex: 1,
    });
    // Boundary: first marker of tile B.
    expect(buf.provenance.resolve(2)).toEqual({
      tileKey: featureTileKey(iconIdB, 'vessels'),
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(3)).toBeNull();
    expect(buf.binaryByTileKey.get(featureTileKey(iconIdA, 'vessels'))).toBe(
      iconTileA.layers[0].features,
    );
    expect(buf.binaryByTileKey.get(featureTileKey(iconIdB, 'vessels'))).toBe(
      iconTileB.layers[0].features,
    );
    expect(buf.binaryByTileKey.size).toBe(2);
  });

  it('emits empty (non-null) pick buffers when no markers merge', () => {
    const buf = buildIconBuffers([], proj, 0, BUFFER_OPTS);
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

// ── ID MATERIAL ───────────────────────────────────────────────────────────────

describe('createIconIdMaterial (reuses the colour material collapse gates)', () => {
  it('builds a vertexNode + opacityNode graph for every icon mode', () => {
    for (const mode of ['window', 'wake', 'cumulative', 'none'] as IconMode[]) {
      const b = createIconIdMaterial({ mode });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.material.colorNode).toBeTruthy();
      expect(b.mode).toBe(mode);
      expect(b.time).toBeInstanceOf(TimeFilterUniforms);
      expect(b.icon).toBeInstanceOf(IconUniforms);
      // No colour-only extras on the flat id bundle.
      expect(b.glide).toBeNull();
      expect(b.palette).toBeNull();
    }
  });

  it('composes the wake tail-taper gate (mode: wake) with the marker filter', () => {
    const b = createIconIdMaterial({ mode: 'wake', dataFilter: true });
    expect(b.material.vertexNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.mode).toBe('wake');
    expect(b.filter).toBeInstanceOf(DataFilterUniforms); // marker-filter collapse
  });

  it('omits the filter uniforms when the gate is off', () => {
    expect(createIconIdMaterial({ mode: 'window' }).filter).toBeNull();
    expect(
      createIconIdMaterial({ mode: 'window', dataFilter: false }).filter,
    ).toBeNull();
  });
});

// ── DISPATCH ──────────────────────────────────────────────────────────────────

describe('IconLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  it('resolves a merged id colour to the right {tileKey, featureIndex, kind:icon}', async () => {
    const layer = new IconLayer({
      id: 'vessels',
      ...ATLAS_OPTS,
      angleProperty: 'heading',
    });
    layer.setTiles([iconTileA, iconTileB], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(2)); // merged 2 → tile B feat 0
    const hit = await layer.pick(picker, camera, 12, 34);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('icon');
    expect(hit!.layerId).toBe('vessels');
    expect(hit!.tileKey).toBe(featureTileKey(iconIdB, 'vessels'));
    expect(hit!.featureIndex).toBe(0);
    expect(hit!.object!.id).toBe(12);
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude + 0.002, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude + 0.001, 9);
    expect(hit!.screen).toEqual([12, 34]);
    // The id material is swapped in only for the render; the colour material restored.
    expect(layer.object.material).toBe(colourMat);
    layer.dispose();
  });

  it('reports a sentinel background readback as a miss (no hit)', async () => {
    const layer = new IconLayer({
      id: 'vessels',
      ...ATLAS_OPTS,
      angleProperty: 'heading',
    });
    layer.setTiles([iconTileA, iconTileB], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]); // white → MAX_PICK_ID ≥ count
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('returns null (never touches the GPU) when there are no markers', async () => {
    const layer = new IconLayer({
      id: 'vessels',
      ...ATLAS_OPTS,
      angleProperty: 'heading',
    });
    layer.setTiles([], ctx);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('defers picking on the glide (motionInterpolation) path — empty provenance', async () => {
    const layer = new IconLayer({
      id: 'vessels',
      ...ATLAS_OPTS,
      angleProperty: 'heading',
      interpolate: true,
      idProperty: 'mmsi',
    });
    layer.setTiles(
      [
        makePointTile(
          2,
          [
            anchor.longitude,
            anchor.latitude,
            anchor.longitude + 0.001,
            anchor.latitude,
          ],
          {
            numericProps: { heading: new Float32Array([0, 90]) },
            startTimes: new Float32Array([0, 0]),
            endTimes: new Float32Array([1000, 1000]),
            categoricalProps: {
              mmsi: {
                indices: new Uint16Array([0, 1]),
                categories: ['A', 'B'],
              },
            },
          },
          { id: iconIdA, layerName: 'vessels', timeOffset: 0 },
        ),
      ],
      ctx,
    );
    const { picker, camera } = mockPicker(encodeId(0));
    // Glide provenance is empty ⇒ pick short-circuits to null (never reads back).
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });
});
