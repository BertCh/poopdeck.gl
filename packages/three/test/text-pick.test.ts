// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// GPU id-buffer picking for the TEXT kind — instanced billboard quads, one PER
// CHARACTER, over Point geometry. Three seams, mirroring the proven icon/column
// template, with ONE rule that is unique to this kind:
//   • PROVENANCE — `buildTextBuffers` records one entry per merged GLYPH in draw
//     order, but every glyph of a label repeats that LABEL's
//     `(tileKey, featureIndex)`. A pick on any character of "AB" therefore
//     resolves to the same feature; nowhere else in the package is the merged
//     instance coarser than the thing it identifies.
//   • ID MATERIAL — `createTextIdMaterial` BUILDS (TSL graph) with the SAME
//     collapse gates as the colour material (time-filter + label filter), so an
//     out-of-window / off-filter label is unpickable on-device. Pixel-level
//     collapse is browser-verify (this package's policy); here we gate on the
//     graph + uniforms.
//   • DISPATCH — the FULL `layer.pick()` path with a stub renderer/readback (as
//     `gpu-pick-readback.test.ts` does): a chosen id colour resolves to the right
//     `{tileKey, featureIndex, kind:'text'}`, a sentinel background is a miss, and
//     the id material is swapped in only for the render and restored after.

import { describe, it, expect, vi } from 'vitest';
import { Texture } from 'three';
import type { TileId } from '@poopdeck.gl/core';
import {
  buildTextBuffers,
  type TextColorMode,
  type TextGlyphMappingEntry,
} from '../src/lib/text-buffers';
import {
  createTextIdMaterial,
  TextUniforms,
  type TextMode,
} from '../src/tsl/text-material';
import { DataFilterUniforms } from '../src/tsl/data-filter';
import { TimeFilterUniforms } from '../src/tsl/time-filter';
import { STTTextLayer } from '../src/layers/text-layer';
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
const EM = 64;
const MAPPING: Record<string, TextGlyphMappingEntry> = {
  A: { x: 0, y: 0, width: 32, height: 64, advance: 40 },
  B: { x: 32, y: 0, width: 32, height: 64, advance: 40 },
};
// Shared atlas shell. `STTTextLayer` resolves its own `colorMode` from
// `color`/`colorProperty`; the buffer builder takes an explicit `colorMode`, so
// the provenance test spreads this + a constant white `colorMode`.
const ATLAS_OPTS = {
  atlas: new Texture(),
  atlasWidth: ATLAS_W,
  atlasHeight: ATLAS_H,
  fontMapping: MAPPING,
  fontHeight: EM,
  textProperty: 'name',
};
const CONSTANT_TINT: TextColorMode = {
  type: 'constant',
  color: [255, 255, 255, 255] as [number, number, number, number],
};
const BUFFER_OPTS = {
  atlasWidth: ATLAS_W,
  atlasHeight: ATLAS_H,
  fontMapping: MAPPING,
  fontHeight: EM,
  textProperty: 'name' as string | null,
  sizeProperty: null,
  angleProperty: null,
  colorMode: CONSTANT_TINT,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────
//
// Tile A holds two labels — 'AB' (two glyphs) and 'A' (one) — so the merged glyph
// run straddles a feature boundary INSIDE a tile. Tile B adds a third label so it
// also straddles a tile boundary. Merged glyph order: [A0, A0, A1, B0].

const textIdA: TileId = { z: 12, x: 1, y: 2, t: 0 };
const textIdB: TileId = { z: 12, x: 3, y: 4, t: 500 };
const labelTile = (
  labels: string[],
  positions: number[],
  ids: number[],
  id: TileId,
  timeOffset: number,
) =>
  makePointTile(
    labels.length,
    positions,
    {
      categoricalProps: {
        name: {
          indices: Uint16Array.from(labels.map((_, i) => i)),
          categories: labels,
        },
      },
      startTimes: new Float32Array(labels.length),
      endTimes: new Float32Array(labels.length).fill(1000),
      featureIds: Uint32Array.from(ids),
    },
    { id, layerName: 'places', timeOffset },
  );

const textTileA = labelTile(
  ['AB', 'A'],
  [
    anchor.longitude,
    anchor.latitude,
    anchor.longitude + 0.001,
    anchor.latitude,
  ],
  [10, 11],
  textIdA,
  0,
);
const textTileB = labelTile(
  ['B'],
  [anchor.longitude + 0.002, anchor.latitude + 0.001],
  [12],
  textIdB,
  500,
);

const KEY_A = featureTileKey(textIdA, 'places');
const KEY_B = featureTileKey(textIdB, 'places');

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

describe('buildTextBuffers provenance', () => {
  it('resolves EVERY glyph of a label to the SAME feature', () => {
    const buf = buildTextBuffers([textTileA, textTileB], proj, 0, BUFFER_OPTS);
    // 2 + 1 + 1 glyphs from 3 labels: the instance count is CHARACTERS.
    expect(buf.count).toBe(4);
    expect(buf.rowCount).toBe(3);
    expect(buf.provenance.length).toBe(4);
    // Glyph 0 is 'A' of "AB" and glyph 1 is its 'B' — the same label, so the same
    // provenance entry. This is the rule unique to the text kind.
    expect(buf.provenance.resolve(0)).toEqual({
      tileKey: KEY_A,
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(1)).toEqual({
      tileKey: KEY_A,
      featureIndex: 0,
    });
    // Boundary: the next label inside the same tile.
    expect(buf.provenance.resolve(2)).toEqual({
      tileKey: KEY_A,
      featureIndex: 1,
    });
    // Boundary: the first label of tile B.
    expect(buf.provenance.resolve(3)).toEqual({
      tileKey: KEY_B,
      featureIndex: 0,
    });
    expect(buf.provenance.resolve(4)).toBeNull();
    expect(buf.binaryByTileKey.get(KEY_A)).toBe(textTileA.layers[0].features);
    expect(buf.binaryByTileKey.get(KEY_B)).toBe(textTileB.layers[0].features);
    expect(buf.binaryByTileKey.size).toBe(2);
  });

  it('emits empty (non-null) pick buffers when no labels merge', () => {
    const buf = buildTextBuffers([], proj, 0, BUFFER_OPTS);
    expect(buf.count).toBe(0);
    expect(buf.provenance.length).toBe(0);
    expect(buf.binaryByTileKey.size).toBe(0);
  });
});

// ── ID MATERIAL ───────────────────────────────────────────────────────────────

describe('createTextIdMaterial (reuses the colour material collapse gates)', () => {
  it('builds a vertexNode + opacityNode graph for every text mode', () => {
    for (const mode of ['window', 'cumulative', 'none'] as TextMode[]) {
      const b = createTextIdMaterial({ mode });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.material.colorNode).toBeTruthy();
      expect(b.mode).toBe(mode);
      expect(b.time).toBeInstanceOf(TimeFilterUniforms);
      expect(b.text).toBeInstanceOf(TextUniforms);
    }
  });

  it('installs the label-filter collapse gate when asked', () => {
    const b = createTextIdMaterial({ mode: 'window', dataFilter: true });
    expect(b.material.vertexNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.filter).toBeInstanceOf(DataFilterUniforms);
  });

  it('omits the filter uniforms when the gate is off', () => {
    expect(createTextIdMaterial({ mode: 'window' }).filter).toBeNull();
    expect(
      createTextIdMaterial({ mode: 'window', dataFilter: false }).filter,
    ).toBeNull();
  });

  it('is opaque with a hard alpha test (an exact 24-bit id, never blended)', () => {
    const b = createTextIdMaterial({ mode: 'window' });
    expect(b.material.transparent).toBe(false);
    expect(b.material.alphaTest).toBe(0.5);
  });
});

// ── DISPATCH ──────────────────────────────────────────────────────────────────

describe('STTTextLayer.pick (full GPU id-buffer dispatch, mock readback)', () => {
  const makeLayer = () =>
    new STTTextLayer({ id: 'places', ...ATLAS_OPTS, atlas: new Texture() });

  it('resolves a merged glyph id to the right {tileKey, featureIndex, kind:text}', async () => {
    const layer = makeLayer();
    layer.setTiles([textTileA, textTileB], ctx);
    const colourMat = layer.object.material;

    const { picker, camera } = mockPicker(encodeId(3)); // glyph 3 → tile B label 0
    const hit = await layer.pick(picker, camera, 12, 34);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('text');
    expect(hit!.layerId).toBe('places');
    expect(hit!.tileKey).toBe(KEY_B);
    expect(hit!.featureIndex).toBe(0);
    expect(hit!.object!.id).toBe(12);
    expect(hit!.coordinate![0]).toBeCloseTo(anchor.longitude + 0.002, 9);
    expect(hit!.coordinate![1]).toBeCloseTo(anchor.latitude + 0.001, 9);
    expect(hit!.screen).toEqual([12, 34]);
    // The id material is swapped in only for the render; the colour material restored.
    expect(layer.object.material).toBe(colourMat);
    layer.dispose();
  });

  it('resolves a pick on ANY glyph of a label to that label', async () => {
    const layer = makeLayer();
    layer.setTiles([textTileA, textTileB], ctx);

    const first = mockPicker(encodeId(0)); // the 'A' of "AB"
    const second = mockPicker(encodeId(1)); // the 'B' of the SAME label
    const a = await layer.pick(first.picker, first.camera, 5, 6);
    const b = await layer.pick(second.picker, second.camera, 5, 6);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
    expect(a!.tileKey).toBe(KEY_A);
    expect(a!.featureIndex).toBe(0);
    expect(a!.object!.id).toBe(10);
    layer.dispose();
  });

  it('reports a sentinel background readback as a miss (no hit)', async () => {
    const layer = makeLayer();
    layer.setTiles([textTileA, textTileB], ctx);
    const { picker, camera } = mockPicker([255, 255, 255]); // white → MAX_PICK_ID ≥ count
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('bounds the id space by the GLYPH count, so an id past the last glyph misses', async () => {
    const layer = makeLayer();
    layer.setTiles([textTileA, textTileB], ctx);
    const { picker, camera } = mockPicker(encodeId(4)); // one past the 4 merged glyphs
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });

  it('returns null (never touches the GPU) when there are no labels', async () => {
    const layer = makeLayer();
    layer.setTiles([], ctx);
    const { picker, camera } = mockPicker(encodeId(0));
    expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
    layer.dispose();
  });
});

// ── Label-source resolution (observed through the pick identity) ──────────────
//
// `provenance` is one entry per GLYPH, so `resolvePick(n)` doubles as a probe for
// "how many characters did this layer actually lay out" — which is how these two
// assert which label source won without reaching into the builder.

describe('STTTextLayer label source', () => {
  it('honours an EXPLICIT textProperty: null (constant label, column ignored)', () => {
    // `textProperty ?? 'text'` would swallow the null and pick up the tile's
    // `name`-shaped column if it happened to be called `text`; both the option's
    // `string | null` type and `text`'s doc say null means "no column".
    const tile = makePointTile(
      1,
      [anchor.longitude, anchor.latitude],
      {
        categoricalProps: {
          text: { indices: new Uint16Array([0]), categories: ['AB'] },
        },
      },
      { id: textIdA, layerName: 'places', timeOffset: 0 },
    );
    const constant = new STTTextLayer({
      id: 'places',
      ...ATLAS_OPTS,
      atlas: new Texture(),
      textProperty: null,
      text: 'A',
    });
    constant.setTiles([tile], ctx);
    // The one-character CONSTANT was drawn, not the two-character column.
    expect(constant.resolvePick(0)).not.toBeNull();
    expect(constant.resolvePick(1)).toBeNull();
    constant.dispose();

    // Same tile, prop unset → the default `text` column wins: two glyphs.
    const column = new STTTextLayer({
      id: 'places',
      ...ATLAS_OPTS,
      atlas: new Texture(),
      textProperty: undefined,
      text: 'A',
    });
    column.setTiles([tile], ctx);
    expect(column.resolvePick(1)).not.toBeNull();
    expect(column.resolvePick(2)).toBeNull();
    column.dispose();
  });
});

// ── The no-atlas contract ─────────────────────────────────────────────────────
//
// Deliberately SOFTER than STTIconLayer, whose `atlas` is a required prop: a font
// atlas is usually generated asynchronously, so the layer has to survive the
// frames before it arrives rather than refuse to type-check.

describe('STTTextLayer without an atlas', () => {
  it('draws nothing, picks nothing, and warns exactly once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const layer = new STTTextLayer({
        id: 'places',
        atlasWidth: ATLAS_W,
        atlasHeight: ATLAS_H,
        fontMapping: MAPPING,
        fontHeight: EM,
        textProperty: 'name',
      });
      layer.setTiles([textTileA, textTileB], ctx);
      expect(layer.object.visible).toBe(false);
      // A second tile arrival must not restart the log storm.
      layer.setTiles([textTileA], ctx);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('no `atlas`');

      const { picker, camera } = mockPicker(encodeId(0));
      expect(await layer.pick(picker, camera, 12, 34)).toBeNull();
      layer.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});
