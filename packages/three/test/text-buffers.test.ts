// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// `buildTextBuffers` — the glyph-layout half of the TEXT kind. The builder turns
// binary POINT tiles into ONE instanced quad PER CHARACTER, so the assertions
// here are about the layout that the shader then only rotates and scales:
// how many glyphs a label produces, where the per-character advance puts them,
// how the whole row moves under the anchor / baseline props, and that the row's
// per-feature values (size, angle, colour, rebased times, filter) are repeated
// across its glyphs. Plus the two invariants every builder in this package
// carries: the empty short-circuit and the RTC origin.

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@poopdeck.gl/core';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import {
  buildTextBuffers,
  type TextGlyphMappingEntry,
} from '../src/lib/text-buffers';
import { LocalEnuProjection } from '../src/projection/local-enu';
import { MercatorProjection } from '../src/projection/mercator';
import type { RGBA } from '../src/lib/color';
import { makePointTile } from './_support/features';
import { expectEmptyBuffers } from './_support/rtc';

const anchor = { longitude: -71.05, latitude: 42.35 };
const proj = new LocalEnuProjection(anchor);
const DEG2RAD = Math.PI / 180;

const placeTile = (
  count: number,
  positions: number[],
  partial: Partial<BinaryFeatures>,
  timeOffset = 0,
  geometryType = GeometryType.Point,
) =>
  makePointTile(count, positions, partial, {
    timeOffset,
    geometryType,
    layerName: 'places',
  });

// A 256×128 atlas over a 64px EM. 'A'/'B' are 32px wide on a 40px advance (so
// there is real side bearing to catch a layout that forgets `advance`), 'i' is a
// narrow 16/20, and '1'/'.' let the numeric-label path be spelled out exactly.
const ATLAS_W = 256;
const ATLAS_H = 128;
const EM = 64;
const MAPPING: Record<string, TextGlyphMappingEntry> = {
  A: { x: 0, y: 0, width: 32, height: 64, advance: 40 },
  B: { x: 32, y: 0, width: 32, height: 64, advance: 40 },
  i: { x: 64, y: 0, width: 16, height: 64, advance: 20 },
  '1': { x: 80, y: 0, width: 16, height: 64, advance: 20 },
  '.': { x: 96, y: 0, width: 8, height: 64, advance: 12 },
};
/** EM-space advance / half-extent of the wide glyphs, as the builder computes them. */
const ADV_A = 40 / EM; // 0.625
const HALF_W_A = 32 / EM / 2; // 0.25
const HALF_H = 64 / EM / 2; // 0.5
/** Quad centre inside the advance box: xOffset (0) + width/2. */
const DX_A = 32 / 2 / EM; // 0.25

const ATLAS = {
  atlasWidth: ATLAS_W,
  atlasHeight: ATLAS_H,
  fontMapping: MAPPING,
  fontHeight: EM,
};
const WHITE: RGBA = [255, 255, 255, 255];
const BASE = {
  ...ATLAS,
  textProperty: 'name' as string | null,
  sizeProperty: null,
  angleProperty: null,
  colorMode: { type: 'constant' as const, color: WHITE },
};

/** A tile whose `name` categorical column holds one label per feature. */
const labelTile = (
  labels: string[],
  positions: number[],
  extra: Partial<BinaryFeatures> = {},
  timeOffset = 0,
) =>
  placeTile(
    labels.length,
    positions,
    {
      categoricalProps: {
        name: {
          indices: Uint16Array.from(labels.map((_, i) => i)),
          categories: labels,
        },
      },
      ...extra,
    },
    timeOffset,
  );

const PLACE_COLORS: Record<string, RGBA> = {
  city: [10, 20, 30, 255],
  town: [200, 100, 50, 255],
};

describe('buildTextBuffers', () => {
  it('emits one instance per CHARACTER and advances the pen between them', () => {
    const tile = labelTile(['AB'], [anchor.longitude, anchor.latitude]);
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      anchor: 'start',
      baseline: 'center',
    });

    expect(buf.count).toBe(2); // two glyphs, ONE label
    expect(buf.rowCount).toBe(1);
    // Both glyphs share the row's anchor position (the layout lives in the offset).
    expect(buf.centers[0]).toBeCloseTo(0, 6);
    expect(buf.centers[3]).toBeCloseTo(0, 6);
    // 'start' anchor → the pen begins at the feature; each glyph's quad centre
    // sits half a glyph-width into its own advance box.
    expect(buf.glyphOffsets[0]).toBeCloseTo(DX_A, 6);
    expect(buf.glyphOffsets[2]).toBeCloseTo(ADV_A + DX_A, 6);
    // Vertically centred (baseline 'center', one line).
    expect(buf.glyphOffsets[1]).toBeCloseTo(0, 6);
    expect(buf.glyphOffsets[3]).toBeCloseTo(0, 6);
    // Half-extents are the glyph's own box in EM units — NOT the advance.
    expect(buf.glyphExtents[0]).toBeCloseTo(HALF_W_A, 6);
    expect(buf.glyphExtents[1]).toBeCloseTo(HALF_H, 6);
  });

  it('honours per-glyph advances so a narrow character does not reserve a wide box', () => {
    const tile = labelTile(['iA'], [anchor.longitude, anchor.latitude]);
    const buf = buildTextBuffers([tile], proj, 0, { ...BASE, anchor: 'start' });
    expect(buf.count).toBe(2);
    // 'i' advances 20/64; 'A' therefore starts there, not a full 'A' width along.
    expect(buf.glyphOffsets[0]).toBeCloseTo(16 / 2 / EM, 6);
    expect(buf.glyphOffsets[2]).toBeCloseTo(20 / EM + DX_A, 6);
    expect(buf.glyphExtents[0]).toBeCloseTo(16 / EM / 2, 6);
  });

  it('anchors the ROW as a whole (start | middle | end)', () => {
    const tile = labelTile(['AB'], [anchor.longitude, anchor.latitude]);
    const rowWidth = 2 * ADV_A;
    const at = (anchorMode: 'start' | 'middle' | 'end') =>
      buildTextBuffers([tile], proj, 0, { ...BASE, anchor: anchorMode });

    expect(at('start').glyphOffsets[0]).toBeCloseTo(DX_A, 6);
    // 'middle' shifts the whole row left by half its width — the two glyph
    // centres then straddle the feature symmetrically.
    const mid = at('middle');
    expect(mid.glyphOffsets[0]).toBeCloseTo(DX_A - rowWidth / 2, 6);
    expect(mid.glyphOffsets[2]).toBeCloseTo(ADV_A + DX_A - rowWidth / 2, 6);
    // The row's ADVANCE box (not its ink, which is inset by the side bearing)
    // straddles the feature: leading pen at -w/2, trailing pen end at +w/2.
    expect(mid.glyphOffsets[0] - DX_A).toBeCloseTo(-rowWidth / 2, 6);
    expect(mid.glyphOffsets[2] - DX_A + ADV_A).toBeCloseTo(rowWidth / 2, 6);
    // 'end' puts the row's trailing edge on the feature.
    expect(at('end').glyphOffsets[0]).toBeCloseTo(DX_A - rowWidth, 6);
  });

  it('aligns the row vertically (top hangs below, bottom sits above)', () => {
    const tile = labelTile(['A'], [anchor.longitude, anchor.latitude]);
    const at = (baseline: 'top' | 'center' | 'bottom') =>
      buildTextBuffers([tile], proj, 0, { ...BASE, baseline }).glyphOffsets[1];
    // World +y is up, one line of lineHeight 1 ⇒ ±half a line.
    expect(at('top')).toBeCloseTo(-0.5, 6);
    expect(at('center')).toBeCloseTo(0, 6);
    expect(at('bottom')).toBeCloseTo(0.5, 6);
  });

  it('stacks an explicit newline into a paragraph by lineHeight', () => {
    const tile = labelTile(['A\nB'], [anchor.longitude, anchor.latitude]);
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      anchor: 'start',
      baseline: 'center',
      lineHeight: 2,
    });
    expect(buf.count).toBe(2); // the newline itself is not a glyph
    // Two lines of height 2, centred ⇒ the first line's centre is +1, the second -1.
    expect(buf.glyphOffsets[1]).toBeCloseTo(1, 6);
    expect(buf.glyphOffsets[3]).toBeCloseTo(-1, 6);
    // Each line restarts the pen at the paragraph's left edge.
    expect(buf.glyphOffsets[0]).toBeCloseTo(DX_A, 6);
    expect(buf.glyphOffsets[2]).toBeCloseTo(DX_A, 6);
  });

  it('anchors each ROW of a paragraph against its OWN width (deck convention)', () => {
    // Two lines of very different widths: 'AB' (2 × 40/64) over 'i' (20/64).
    // deck's `TextLayer.getIconOffsets` is
    // `((anchorX - 1) * rowWidth[i]) / 2 + x[i]` — `rowWidth[i]` is the width of
    // the row THAT character sits in, so 'middle' centres each row over the
    // feature and 'end' right-aligns each row. Anchoring the whole block by the
    // paragraph's WIDEST row instead would leave the short row left-aligned
    // inside it — indistinguishable on a single-line label, which is why this
    // case has to be spelled out.
    const tile = labelTile(['AB\ni'], [anchor.longitude, anchor.latitude]);
    const at = (anchorMode: 'start' | 'middle' | 'end') =>
      buildTextBuffers([tile], proj, 0, { ...BASE, anchor: anchorMode });
    const wideRow = 2 * ADV_A; // 'AB'
    const narrowRow = 20 / EM; // 'i'
    const DX_I = 16 / 2 / EM;

    // Glyph order is [A, B, i]; index 4 is the third glyph's x offset.
    const mid = at('middle');
    expect(mid.count).toBe(3);
    expect(mid.glyphOffsets[0]).toBeCloseTo(DX_A - wideRow / 2, 6);
    // The narrow row is centred on ITS width, NOT parked at -wideRow/2.
    expect(mid.glyphOffsets[4]).toBeCloseTo(DX_I - narrowRow / 2, 6);
    expect(mid.glyphOffsets[4]).not.toBeCloseTo(DX_I - wideRow / 2, 6);

    const end = at('end');
    // 'end' puts EVERY row's trailing edge on the feature: the narrow row's pen
    // ends at 0, so its only glyph centre is half a glyph-width back from there.
    expect(end.glyphOffsets[0]).toBeCloseTo(DX_A - wideRow, 6);
    expect(end.glyphOffsets[4]).toBeCloseTo(DX_I - narrowRow, 6);

    // 'start' is the degenerate case where every convention agrees.
    expect(at('start').glyphOffsets[4]).toBeCloseTo(DX_I, 6);
  });

  it('drops characters the atlas does not map (no glyph, no advance)', () => {
    // 'Z' is absent from MAPPING; 'AZB' must lay out exactly like 'AB'.
    const zTile = labelTile(['AZB'], [anchor.longitude, anchor.latitude]);
    const plain = labelTile(['AB'], [anchor.longitude, anchor.latitude]);
    const withZ = buildTextBuffers([zTile], proj, 0, {
      ...BASE,
      anchor: 'start',
    });
    const without = buildTextBuffers([plain], proj, 0, {
      ...BASE,
      anchor: 'start',
    });
    expect(withZ.count).toBe(2);
    expect(withZ.glyphOffsets[2]).toBeCloseTo(without.glyphOffsets[2], 6);
  });

  it('bakes the UV sub-rectangle of each glyph, normalized to the atlas', () => {
    const tile = labelTile(['AB'], [anchor.longitude, anchor.latitude]);
    const buf = buildTextBuffers([tile], proj, 0, BASE);
    // 'A' = (0,0,32,64) of a 256×128 atlas; v origin is the TOP.
    expect(buf.uvRects[0]).toBeCloseTo(0, 6);
    expect(buf.uvRects[1]).toBeCloseTo(0, 6);
    expect(buf.uvRects[2]).toBeCloseTo(32 / 256, 6);
    expect(buf.uvRects[3]).toBeCloseTo(64 / 128, 6);
    // 'B' starts one glyph along in x.
    expect(buf.uvRects[4]).toBeCloseTo(32 / 256, 6);
    expect(buf.uvRects[6]).toBeCloseTo(64 / 256, 6);
  });

  it('repeats the ROW values (size, angle, colour, rebased times) over its glyphs', () => {
    const tile = labelTile(
      ['AB', 'A'],
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        numericProps: {
          label_size: new Float32Array([20, 40]),
          heading: new Float32Array([0, 90]),
        },
        startTimes: new Float32Array([10, 20]),
        endTimes: new Float32Array([15, 25]),
      },
      3000,
    );
    const buf = buildTextBuffers([tile], proj, 1000, {
      ...BASE,
      sizeProperty: 'label_size',
      angleProperty: 'heading',
    });
    expect(buf.count).toBe(3); // 2 glyphs + 1 glyph
    // Feature 0's two glyphs share its size / angle / times…
    expect(buf.sizes[0]).toBe(20);
    expect(buf.sizes[1]).toBe(20);
    expect(buf.angles[0]).toBeCloseTo(0, 6);
    expect(buf.angles[1]).toBeCloseTo(0, 6);
    // …times rebased by (3000 - 1000), a label appearing and vanishing whole.
    expect(buf.starts[0]).toBe(10 + 2000);
    expect(buf.starts[1]).toBe(10 + 2000);
    expect(buf.ends[0]).toBe(15 + 2000);
    // …and feature 1's single glyph carries ITS values (degrees → radians).
    expect(buf.sizes[2]).toBe(40);
    expect(buf.angles[2]).toBeCloseTo(90 * DEG2RAD, 6);
    expect(buf.starts[2]).toBe(20 + 2000);
  });

  it('applies the constant size / angle when no column is set', () => {
    const tile = labelTile(['A'], [anchor.longitude, anchor.latitude]);
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      sizeConstant: 18,
      angleConstant: 45,
    });
    expect(buf.sizes[0]).toBe(18);
    expect(buf.angles[0]).toBeCloseTo(45 * DEG2RAD, 6);
  });

  it('resolves a categorical colour once per feature and repeats it per glyph', () => {
    const tile = placeTile(
      2,
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      {
        categoricalProps: {
          name: {
            indices: new Uint16Array([0, 1]),
            categories: ['AB', 'A'],
          },
          kind: {
            indices: new Uint16Array([0, 1]),
            categories: ['city', 'town'],
          },
        },
      },
    );
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      colorMode: {
        type: 'categorical',
        property: 'kind',
        mapping: PLACE_COLORS,
        fallback: [0, 0, 0, 0],
      },
    });
    expect(buf.count).toBe(3);
    // Both glyphs of feature 0 get the 'city' tint, 0..1.
    expect(buf.colors[0]).toBeCloseTo(10 / 255, 6);
    expect(buf.colors[4]).toBeCloseTo(10 / 255, 6);
    // Feature 1's glyph gets 'town'.
    expect(buf.colors[8]).toBeCloseTo(200 / 255, 6);
  });

  it('formats a NUMERIC label column with a float32 round-trip, not String(v)', () => {
    const tile = placeTile(1, [anchor.longitude, anchor.latitude], {
      numericProps: { v: new Float32Array([1.1]) },
    });
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      textProperty: 'v',
    });
    // Without the round-trip search this would decode '1.100000023841858'.
    expect(String.fromCodePoint(...buf.codePoints)).toBe('1.1');
    expect(Array.from(buf.charStarts)).toEqual([0, 3]);
    expect(buf.count).toBe(3);
  });

  it('falls back to the constant label when the column is absent', () => {
    const tile = placeTile(2, [
      anchor.longitude,
      anchor.latitude,
      anchor.longitude,
      anchor.latitude,
    ]);
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      textProperty: 'missing',
      textConstant: 'A',
    });
    expect(buf.count).toBe(2); // one glyph per feature
    expect(Array.from(buf.charStarts)).toEqual([0, 1, 2]);
  });

  it('emits a per-glyph filter value repeated from the row', () => {
    const tile = labelTile(
      ['AB', 'A'],
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
      { numericProps: { pop: new Float32Array([5, 9]) } },
    );
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      filterProperty: 'pop',
    });
    expect(Array.from(buf.filterValues)).toEqual([5, 5, 9]);
  });

  it('keeps a rowʼs flat UTF-32 buffer and per-row char offsets across tiles', () => {
    const a = labelTile(['AB'], [anchor.longitude, anchor.latitude]);
    const b = labelTile(['i'], [anchor.longitude, anchor.latitude], {}, 500);
    const buf = buildTextBuffers([a, b], proj, 0, BASE);
    expect(buf.rowCount).toBe(2);
    // charStarts are GLOBAL across the merged tiles, not per tile.
    expect(Array.from(buf.charStarts)).toEqual([0, 2, 3]);
    expect(String.fromCodePoint(...buf.codePoints)).toBe('ABi');
  });

  it('elevates from a z column and reports a bbox', () => {
    const tile = labelTile(['A'], [anchor.longitude, anchor.latitude], {
      numericProps: { z: new Float32Array([5]) },
    });
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      elevationProperty: 'z',
      elevationScale: 1,
    });
    // The single feature IS the RTC origin (incl. its z), so its centre z is 0
    // but the origin carries the 5m lift.
    expect(buf.origin[2]).toBeCloseTo(5, 6);
    expect(buf.centers[2]).toBeCloseTo(0, 6);
    expect(buf.bbox).not.toBeNull();
  });

  it('subtracts the RTC origin so f32 centres stay small under mercator', () => {
    const mproj = new MercatorProjection(anchor);
    const tile = labelTile(
      ['A', 'A'],
      [
        anchor.longitude,
        anchor.latitude,
        anchor.longitude + 0.001,
        anchor.latitude + 0.001,
      ],
    );
    const buf = buildTextBuffers([tile], mproj, 0, BASE);
    expect(buf.count).toBe(2);
    // Origin = the absolute mercator projection of the first feature (large).
    const abs0 = mproj.project(anchor.longitude, anchor.latitude, 0);
    expect(Math.abs(buf.origin[0])).toBeGreaterThan(1e6);
    expect(buf.origin[0]).toBeCloseTo(abs0[0], 3);
    // First centre is the origin → relative ~0, not the huge absolute magnitude.
    expect(buf.centers[0]).toBeCloseTo(0, 3);
    expect(buf.centers[1]).toBeCloseTo(0, 3);
    // Second centre is a small local offset the f32 buffer can hold.
    const abs1 = mproj.project(
      anchor.longitude + 0.001,
      anchor.latitude + 0.001,
      0,
    );
    expect(buf.centers[3]).toBeCloseTo(abs1[0] - abs0[0], 3);
    expect(Math.abs(buf.centers[3])).toBeLessThan(500);
  });

  it('short-circuits to the empty shape when nothing merges', () => {
    const none = buildTextBuffers([], proj, 0, BASE);
    expectEmptyBuffers(none);
    expect(none.rowCount).toBe(0);
    expect(none.provenance.length).toBe(0);
    expect(none.binaryByTileKey.size).toBe(0);
    expect(none.codePoints.length).toBe(0);
  });

  it('short-circuits when features merge but no label renders', () => {
    // A real point tile with no label column and no constant → zero glyphs.
    const tile = placeTile(2, [
      anchor.longitude,
      anchor.latitude,
      anchor.longitude,
      anchor.latitude,
    ]);
    const buf = buildTextBuffers([tile], proj, 0, {
      ...BASE,
      textProperty: 'missing',
    });
    expectEmptyBuffers(buf);
    expect(buf.provenance.length).toBe(0);
  });

  it('still returns the decoded UTF-32 buffer when the atlas maps NO character', () => {
    // The point of surfacing `codePoints`/`charStarts` is that a host with no
    // font atlas yet can derive its character set from them. That host's FIRST
    // call is exactly this one — an empty `fontMapping`, so zero glyphs render —
    // and dropping the decode here would make the field unreachable when it is
    // the only thing worth having.
    const tile = labelTile(
      ['AB', 'i'],
      [anchor.longitude, anchor.latitude, anchor.longitude, anchor.latitude],
    );
    const buf = buildTextBuffers([tile], proj, 0, { ...BASE, fontMapping: {} });
    expectEmptyBuffers(buf); // nothing DRAWS…
    expect(buf.provenance.length).toBe(0);
    // …but the labels came back decoded, per row.
    expect(buf.rowCount).toBe(2);
    expect(String.fromCodePoint(...buf.codePoints)).toBe('ABi');
    expect(Array.from(buf.charStarts)).toEqual([0, 2, 3]);
  });

  it('skips non-point geometry layers', () => {
    const tile = placeTile(
      1,
      [anchor.longitude, anchor.latitude],
      {},
      0,
      GeometryType.LineString,
    );
    const buf = buildTextBuffers([tile], proj, 0, BASE);
    expectEmptyBuffers(buf);
  });
});
