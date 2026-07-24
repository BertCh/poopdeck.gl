// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// The stableColorMapping feature family — the Three port of deck's
// `CategoryColorExtension` GPU palette path. GPU compilation is browser-verified;
// here we assert (1) the pure stable-assignment kernel places a category by its
// LABEL so the same value lands on the same slot regardless of tile order,
// (2) the four kinds' buffer builders emit that stable slot (and stay
// byte-identical when off), (3) each material builds its palette node graph and
// (4) the five layers wire the `sttCategoryIndex` attribute + palette bundle
// end-to-end when opted in (and not otherwise). The colour math is deck-shared in
// `@poopdeck.gl/core/style`.

import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import type { InstancedBufferGeometry } from 'three';

import {
  buildStablePalette,
  stableCategoryHash,
  featureCategorySlot,
  assignCategoryIndices,
  paletteTextureData,
  NULL_CATEGORY_INDEX,
} from '../src/lib/palette';
import { PaletteUniforms } from '../src/tsl/palette';

import { createArcMaterial } from '../src/tsl/arc-material';
import { createWideLineMaterial } from '../src/tsl/wide-line-material';
import { createColumnMaterial } from '../src/tsl/column-material';
import { createIconMaterial } from '../src/tsl/icon-material';

import { buildColumnBuffers } from '../src/lib/column-buffers';
import { buildArcBuffers } from '../src/lib/arc-buffers';
import { buildLineSegmentBuffers } from '../src/lib/geo-line-buffers';
import { buildOdLineSegmentBuffers } from '../src/lib/od-positions';
import { buildIconBuffers } from '../src/lib/icon-buffers';

import { ColumnLayer } from '../src/layers/column-layer';
import { ArcLayer } from '../src/layers/arc-layer';
import { WideLineLayer } from '../src/layers/wide-line-layer';
import { OdLineLayer } from '../src/layers/od-line-layer';
import { IconLayer } from '../src/layers/icon-layer';

import { LocalEnuProjection } from '../src/projection/local-enu';
import { makePointTile, makeLineTile } from './_support/features';

const proj = new LocalEnuProjection({ longitude: 0, latitude: 0 });
const ctx = { projection: proj, timeOrigin: 0 };
const FALLBACK: [number, number, number, number] = [120, 120, 120, 255];

/** A 2-point tile whose two features carry the two category labels, in the order
 *  the caller passes (so callers can REVERSE the local dictionary across tiles). */
function twoPointTile(categories: string[], indices: number[]) {
  return makePointTile(2, [0, 0, 0.001, 0.001], {
    startTimes: new Float32Array([0, 0]),
    endTimes: new Float32Array([1000, 1000]),
    categoricalProps: {
      vtype: {
        categories,
        indices: new Uint16Array(indices),
      },
    },
  });
}

/** A 2-feature LineString tile (2-vertex segments) with a categorical column. */
function twoLineTile(categories: string[], indices: number[]) {
  return makeLineTile(
    {
      featureCount: 2,
      positions: new Float64Array([0, 0, 0.001, 0, 0.002, 0, 0.002, 0.001]),
      startIndices: new Uint32Array([0, 2, 4]),
      startTimes: new Float32Array([0, 0]),
      endTimes: new Float32Array([1000, 1000]),
      categoricalProps: {
        vtype: { categories, indices: new Uint16Array(indices) },
      },
    },
    { layerName: 'lines' },
  );
}

const CONST_COL = {
  type: 'constant' as const,
  color: [200, 200, 200, 255] as [number, number, number, number],
};
const CAT_COL = {
  type: 'categorical' as const,
  property: 'vtype',
  mapping: {},
  fallback: FALLBACK,
};

// ════════════════════════════════════════════════════════════════════════════
//  1. Pure stable-assignment kernel
// ════════════════════════════════════════════════════════════════════════════

describe('buildStablePalette — stable label → slot assignment', () => {
  it('hash path: the same label always resolves to the same slot', () => {
    const p = buildStablePalette({ colorMappingDefault: FALLBACK });
    expect(p.slotForLabel('cargo')).toBe(p.slotForLabel('cargo'));
    // Independent rebuilds agree (deterministic across process state).
    const q = buildStablePalette({ colorMappingDefault: FALLBACK });
    expect(q.slotForLabel('cargo')).toBe(p.slotForLabel('cargo'));
  });

  it('hash path: distinct labels get distinct slots (palette wide enough)', () => {
    // 20-entry palette leaves ample room; the FNV hashes of these two differ.
    const palette = Array.from(
      { length: 20 },
      (_, i) => [i, i, i, 255] as [number, number, number, number],
    );
    const p = buildStablePalette({ palette, colorMappingDefault: FALLBACK });
    expect(p.slotForLabel('cargo')).not.toBe(p.slotForLabel('tanker'));
  });

  it('explicit colorMapping: deterministic (sorted-key) slots + mapped colours', () => {
    const p = buildStablePalette({
      colorMapping: {
        tanker: [10, 20, 30, 255],
        cargo: [40, 50, 60, 255],
      },
      colorMappingDefault: FALLBACK,
    });
    // Sorted keys → cargo (0), tanker (1); the null/default slot trails.
    expect(p.slotForLabel('cargo')).toBe(0);
    expect(p.slotForLabel('tanker')).toBe(1);
    expect(p.colors[0]).toEqual([40, 50, 60, 255]);
    expect(p.colors[1]).toEqual([10, 20, 30, 255]);
    // Unmapped label → the null/default slot (deck colorMappingDefault).
    expect(p.slotForLabel('sailing')).toBe(p.nullIndex);
    expect(p.colors[p.nullIndex]).toEqual(FALLBACK);
  });

  it('categoryOrder path: label takes its position in the global list', () => {
    const palette: [number, number, number, number][] = [
      [1, 0, 0, 255],
      [0, 1, 0, 255],
      [0, 0, 1, 255],
    ];
    const p = buildStablePalette({
      categoryOrder: ['cargo', 'tanker', 'sailing'],
      palette,
      colorMappingDefault: FALLBACK,
    });
    expect(p.slotForLabel('cargo')).toBe(0);
    expect(p.slotForLabel('tanker')).toBe(1);
    expect(p.slotForLabel('sailing')).toBe(2);
    // A label absent from the order → the null/default slot.
    expect(p.slotForLabel('tug')).toBe(p.nullIndex);
  });

  it('appends a trailing null/default slot at nullIndex', () => {
    const p = buildStablePalette({ colorMappingDefault: FALLBACK });
    expect(p.nullIndex).toBe(p.colors.length - 1);
    expect(p.colors[p.nullIndex]).toEqual(FALLBACK);
    // Default defaults to transparent when none supplied.
    const q = buildStablePalette({});
    expect(q.colors[q.nullIndex]).toEqual([0, 0, 0, 0]);
  });

  it('empty / undefined labels resolve to the null slot', () => {
    const p = buildStablePalette({ colorMappingDefault: FALLBACK });
    expect(p.slotForLabel(undefined)).toBe(p.nullIndex);
    expect(p.slotForLabel('')).toBe(p.nullIndex);
  });

  it('stableCategoryHash is deterministic and label-sensitive', () => {
    expect(stableCategoryHash('cargo')).toBe(stableCategoryHash('cargo'));
    expect(stableCategoryHash('cargo')).not.toBe(stableCategoryHash('tanker'));
  });

  it('paletteTextureData flattens colours to RGBA 0..1, row-major', () => {
    const p = buildStablePalette({
      colorMapping: { a: [255, 0, 128, 255] },
      colorMappingDefault: [0, 255, 0, 255],
    });
    const data = paletteTextureData(p);
    expect(data.length).toBe(p.colors.length * 4);
    expect(data[0]).toBeCloseTo(1, 6); // 255/255
    expect(data[2]).toBeCloseTo(128 / 255, 6);
    // Trailing null slot = green default.
    const o = p.nullIndex * 4;
    expect(data[o + 1]).toBeCloseTo(1, 6);
  });
});

describe('featureCategorySlot / assignCategoryIndices — NULL + missing handling', () => {
  const palette = buildStablePalette({
    categoryOrder: ['cargo', 'tanker'],
    palette: [
      [1, 0, 0, 255],
      [0, 1, 0, 255],
    ],
    colorMappingDefault: FALLBACK,
  });

  it('NULL_CATEGORY_INDEX resolves to the palette null slot', () => {
    const tile = twoPointTile(['cargo', 'tanker'], [0, NULL_CATEGORY_INDEX]);
    const b = tile.layers[0].features;
    expect(featureCategorySlot(b, 0, 'vtype', palette)).toBe(0);
    expect(featureCategorySlot(b, 1, 'vtype', palette)).toBe(palette.nullIndex);
  });

  it('an absent categorical column → every feature is the null slot', () => {
    const tile = makePointTile(2, [0, 0, 0.001, 0.001]);
    const b = tile.layers[0].features;
    const idx = assignCategoryIndices(b, 'vtype', palette);
    expect(Array.from(idx)).toEqual([palette.nullIndex, palette.nullIndex]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  2. Buffer builders — STABLE ACROSS TILES + off = byte-identical
// ════════════════════════════════════════════════════════════════════════════

describe('buffer builders — a category colours the same in every tile', () => {
  // Two tiles whose LOCAL dictionaries are REVERSED: raw per-tile indices [0,1]
  // would give 'cargo' slot 0 in tile A and slot 1 in tile B (the flicker the CPU
  // first-seen path has). The stable palette places by LABEL, so 'cargo' keeps ITS
  // slot in both. Exercised on the hash path (no mapping, no order — the auto path
  // deck assigns per-tile).
  const palette = buildStablePalette({
    palette: Array.from(
      { length: 16 },
      (_, i) => [i, i, i, 255] as [number, number, number, number],
    ),
    colorMappingDefault: FALLBACK,
  });
  const catIndex = { property: 'vtype', palette };
  const cargoSlot = palette.slotForLabel('cargo');
  const tankerSlot = palette.slotForLabel('tanker');

  it('column builder: same label → same slot across reversed-dictionary tiles', () => {
    // Tile A: point0=cargo, point1=tanker.  Tile B: point0=tanker, point1=cargo.
    const a = buildColumnBuffers(
      [twoPointTile(['cargo', 'tanker'], [0, 1])],
      proj,
      0,
      {
        colorMode: CAT_COL,
        categoryIndex: catIndex,
      },
    );
    const b = buildColumnBuffers(
      [twoPointTile(['tanker', 'cargo'], [0, 1])],
      proj,
      0,
      {
        colorMode: CAT_COL,
        categoryIndex: catIndex,
      },
    );
    // cargo is feature 0 in A, feature 1 in B — but SAME slot in both.
    expect(a.categoryIndices[0]).toBe(cargoSlot);
    expect(b.categoryIndices[1]).toBe(cargoSlot);
    expect(a.categoryIndices[1]).toBe(tankerSlot);
    expect(b.categoryIndices[0]).toBe(tankerSlot);
    // …and the two labels are genuinely different slots (no flicker AND no merge).
    expect(cargoSlot).not.toBe(tankerSlot);
  });

  it('arc builder: source-endpoint category slot is stable across tiles', () => {
    const a = buildArcBuffers(
      [twoLineTile(['cargo', 'tanker'], [0, 1])],
      proj,
      0,
      {
        categoryIndex: catIndex,
      },
    );
    const b = buildArcBuffers(
      [twoLineTile(['tanker', 'cargo'], [0, 1])],
      proj,
      0,
      {
        categoryIndex: catIndex,
      },
    );
    expect(a.categoryIndices[0]).toBe(cargoSlot);
    expect(b.categoryIndices[1]).toBe(cargoSlot);
  });

  it('wide-line builder: every segment of a feature shares its stable slot', () => {
    // 3-vertex feature → 2 segments; both carry the feature's category slot.
    const tile = makeLineTile(
      {
        featureCount: 1,
        positions: new Float64Array([0, 0, 0.001, 0, 0.002, 0]),
        startIndices: new Uint32Array([0, 3]),
        startTimes: new Float32Array([0]),
        endTimes: new Float32Array([1000]),
        categoricalProps: {
          vtype: { categories: ['cargo'], indices: new Uint16Array([0]) },
        },
      },
      { layerName: 'lines' },
    );
    const buf = buildLineSegmentBuffers([tile], proj, 0, {
      colorMode: CAT_COL,
      categoryIndex: catIndex,
    });
    expect(buf.count).toBe(2); // 2 segments
    expect(buf.categoryIndices.length).toBe(2);
    expect(buf.categoryIndices[0]).toBe(cargoSlot);
    expect(buf.categoryIndices[1]).toBe(cargoSlot);
  });

  it('od-line builder: one stable slot per OD pair, stable across tiles', () => {
    const a = buildOdLineSegmentBuffers(
      [twoLineTile(['cargo', 'tanker'], [0, 1])],
      proj,
      0,
      {
        colorMode: CAT_COL,
        categoryIndex: catIndex,
      },
    );
    const b = buildOdLineSegmentBuffers(
      [twoLineTile(['tanker', 'cargo'], [0, 1])],
      proj,
      0,
      {
        colorMode: CAT_COL,
        categoryIndex: catIndex,
      },
    );
    expect(a.categoryIndices[0]).toBe(cargoSlot);
    expect(b.categoryIndices[1]).toBe(cargoSlot);
  });

  it('icon builder: per-icon category slot is stable across tiles', () => {
    const iconOpts = {
      atlasWidth: 64,
      atlasHeight: 64,
      iconMapping: { marker: { x: 0, y: 0, width: 32, height: 32 } },
      icon: 'marker',
      angleProperty: null,
      sizeProperty: null,
      colorMode: {
        type: 'categorical' as const,
        property: 'vtype',
        mapping: {},
        fallback: FALLBACK,
      },
    };
    const a = buildIconBuffers(
      [twoPointTile(['cargo', 'tanker'], [0, 1])],
      proj,
      0,
      {
        ...iconOpts,
        categoryIndex: catIndex,
      },
    );
    const b = buildIconBuffers(
      [twoPointTile(['tanker', 'cargo'], [0, 1])],
      proj,
      0,
      {
        ...iconOpts,
        categoryIndex: catIndex,
      },
    );
    expect(a.categoryIndices[0]).toBe(cargoSlot);
    expect(b.categoryIndices[1]).toBe(cargoSlot);
  });
});

describe('buffer builders — off = byte-identical', () => {
  it('no categoryIndex ⇒ 0-length slot buffer and unchanged colours', () => {
    const off = buildColumnBuffers(
      [twoPointTile(['cargo', 'tanker'], [0, 1])],
      proj,
      0,
      {
        colorMode: CONST_COL,
      },
    );
    expect(off.categoryIndices.length).toBe(0);

    // Adding the palette path must NOT perturb the CPU-expanded colours (the
    // shader ignores them under the palette path, but the bytes stay identical).
    const palette = buildStablePalette({ colorMappingDefault: FALLBACK });
    const withPalette = buildColumnBuffers(
      [twoPointTile(['cargo', 'tanker'], [0, 1])],
      proj,
      0,
      { colorMode: CONST_COL, categoryIndex: { property: 'vtype', palette } },
    );
    expect(Array.from(withPalette.colors)).toEqual(Array.from(off.colors));
    expect(withPalette.categoryIndices.length).toBe(2);
  });

  it('every builder returns a 0-length slot buffer when the path is off', () => {
    const pt = [twoPointTile(['cargo', 'tanker'], [0, 1])];
    const ln = [twoLineTile(['cargo', 'tanker'], [0, 1])];
    expect(
      buildColumnBuffers(pt, proj, 0, { colorMode: CONST_COL }).categoryIndices
        .length,
    ).toBe(0);
    expect(buildArcBuffers(ln, proj, 0, {}).categoryIndices.length).toBe(0);
    expect(
      buildLineSegmentBuffers(ln, proj, 0, { colorMode: CONST_COL })
        .categoryIndices.length,
    ).toBe(0);
    expect(
      buildOdLineSegmentBuffers(ln, proj, 0, { colorMode: CONST_COL })
        .categoryIndices.length,
    ).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  3. Materials — GPU palette node builds per kind
// ════════════════════════════════════════════════════════════════════════════

describe('materials — GPU palette node graph builds (and off = no palette)', () => {
  const tex = () => new Texture();

  it('arc material builds with colorPalette in both shapes', () => {
    for (const shape of ['parabolic', 'greatCircle'] as const) {
      const b = createArcMaterial({ shape, colorPalette: { texture: tex() } });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.colorNode).toBeTruthy();
      expect(b.palette).toBeInstanceOf(PaletteUniforms);
    }
    expect(createArcMaterial({}).palette).toBeUndefined();
  });

  it('wide-line material builds with colorPalette in every mode', () => {
    for (const mode of ['none', 'window', 'trail'] as const) {
      const b = createWideLineMaterial({
        mode,
        colorPalette: { texture: tex() },
      });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.colorNode).toBeTruthy();
      expect(b.palette).toBeInstanceOf(PaletteUniforms);
    }
    expect(createWideLineMaterial({ mode: 'window' }).palette).toBeUndefined();
  });

  it('column material builds with colorPalette', () => {
    const b = createColumnMaterial({ colorPalette: { texture: tex() } });
    expect(b.material.colorNode).toBeTruthy();
    expect(b.material.positionNode).toBeTruthy();
    expect(b.palette).toBeInstanceOf(PaletteUniforms);
    expect(createColumnMaterial({}).palette).toBeUndefined();
  });

  it('icon material builds with colorPalette (mask + opaque), composing with glide', () => {
    for (const mask of [false, true]) {
      const b = createIconMaterial({
        mode: 'window',
        atlas: tex(),
        mask,
        colorPalette: { texture: tex() },
      });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.palette).toBeInstanceOf(PaletteUniforms);
    }
    // Composes with glide (separate texture): both bundles present.
    const both = createIconMaterial({
      mode: 'window',
      atlas: tex(),
      glide: { texture: tex() },
      colorPalette: { texture: tex() },
    });
    expect(both.palette).toBeInstanceOf(PaletteUniforms);
    expect(both.glide).toBeTruthy();

    expect(
      createIconMaterial({ mode: 'window', atlas: tex() }).palette,
    ).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  4. Layers — end-to-end wiring (opt-in), and off = no attribute / no palette
// ════════════════════════════════════════════════════════════════════════════

describe('layers — stableColorMapping wires the attribute + palette end-to-end', () => {
  const lineColorMode = {
    type: 'categorical' as const,
    property: 'vtype',
    mapping: {},
    fallback: FALLBACK,
  };

  function geomOf(layer: {
    object: { geometry: unknown };
  }): InstancedBufferGeometry {
    return layer.object.geometry as InstancedBufferGeometry;
  }

  it('ColumnLayer: sttCategoryIndex bound + palette bundle when on; neither when off', () => {
    const on = new ColumnLayer({
      colorMode: CAT_COL,
      stableColorMapping: true,
    });
    on.setTiles([twoPointTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(on).getAttribute('sttCategoryIndex')).toBeTruthy();
    expect(on['bundle'].palette).toBeInstanceOf(PaletteUniforms);
    on.dispose();

    const off = new ColumnLayer({ colorMode: CAT_COL }); // stableColorMapping default off
    off.setTiles([twoPointTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(off).getAttribute('sttCategoryIndex')).toBeUndefined();
    expect(off['bundle'].palette).toBeUndefined();
    off.dispose();
  });

  it('ArcLayer: source-categorical + stableColorMapping wires the palette', () => {
    const on = new ArcLayer({ sourceColor: CAT_COL, stableColorMapping: true });
    on.setTiles([twoLineTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(on).getAttribute('sttCategoryIndex')).toBeTruthy();
    expect(on['bundle'].palette).toBeInstanceOf(PaletteUniforms);
    on.dispose();

    const off = new ArcLayer({ sourceColor: CAT_COL });
    off.setTiles([twoLineTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(off).getAttribute('sttCategoryIndex')).toBeUndefined();
    on.dispose();
    off.dispose();
  });

  it('WideLineLayer: sttCategoryIndex bound when on; absent when off', () => {
    const on = new WideLineLayer({
      mode: 'none',
      colorMode: lineColorMode,
      stableColorMapping: true,
    });
    on.setTiles([twoLineTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(on).getAttribute('sttCategoryIndex')).toBeTruthy();
    expect(on['bundle'].palette).toBeInstanceOf(PaletteUniforms);
    on.dispose();

    const off = new WideLineLayer({ mode: 'none', colorMode: lineColorMode });
    off.setTiles([twoLineTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(off).getAttribute('sttCategoryIndex')).toBeUndefined();
    off.dispose();
  });

  it('OdLineLayer: sttCategoryIndex bound when on; absent when off', () => {
    const on = new OdLineLayer({
      colorMode: lineColorMode,
      stableColorMapping: true,
    });
    on.setTiles([twoLineTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(on).getAttribute('sttCategoryIndex')).toBeTruthy();
    expect(on['bundle'].palette).toBeInstanceOf(PaletteUniforms);
    on.dispose();

    const off = new OdLineLayer({ colorMode: lineColorMode });
    off.setTiles([twoLineTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(off).getAttribute('sttCategoryIndex')).toBeUndefined();
    off.dispose();
  });

  it('IconLayer (static path): tint palette bound when on; absent when off', () => {
    const iconOpts = {
      atlas: new Texture(),
      atlasWidth: 64,
      atlasHeight: 64,
      iconMapping: { marker: { x: 0, y: 0, width: 32, height: 32 } },
      colorProperty: 'vtype',
    };
    const on = new IconLayer({ ...iconOpts, stableColorMapping: true });
    on.setTiles([twoPointTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(on).getAttribute('sttCategoryIndex')).toBeTruthy();
    expect(on['bundle'].palette).toBeInstanceOf(PaletteUniforms);
    on.dispose();

    const off = new IconLayer({ ...iconOpts });
    off.setTiles([twoPointTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(off).getAttribute('sttCategoryIndex')).toBeUndefined();
    expect(off['bundle'].palette).toBeNull();
    off.dispose();
  });

  it('a constant colour mode never activates the palette even with the flag on', () => {
    const layer = new ColumnLayer({
      colorMode: CONST_COL,
      stableColorMapping: true,
    });
    layer.setTiles([twoPointTile(['cargo', 'tanker'], [0, 1])], ctx);
    expect(geomOf(layer).getAttribute('sttCategoryIndex')).toBeUndefined();
    expect(layer['bundle'].palette).toBeUndefined();
    layer.dispose();
  });
});
