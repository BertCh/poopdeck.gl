// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// Node-graph BUILD gate for the time-as-height ("space-time cube") lift on the
// column + polygon materials. GPU compilation is browser-verified; here we
// assert each material's TSL graph CONSTRUCTS without throwing when built with
// `timeHeight: true` (across every time-filter mode it also supports), that the
// lift uniforms are present only when requested, that the lift COMPOSES with the
// DataFilter collapse, that it installs a positionNode on the otherwise-static
// polygon path, and that the uniform-push resolves the deck-shaped scale/origin.

import { describe, it, expect } from 'vitest';
import {
  createColumnMaterial,
  updateColumnUniforms,
  TimeHeightUniforms as ColumnTimeHeightUniforms,
} from '../src/tsl/column-material';
import {
  createPolygonMaterial,
  updatePolygonUniforms,
  TimeHeightUniforms as PolygonTimeHeightUniforms,
} from '../src/tsl/polygon-material';
import { DataFilterUniforms } from '../src/tsl/data-filter';

describe('column material — time-as-height lift builds', () => {
  for (const timeFiltered of [true, false]) {
    it(`builds with timeHeight (timeFiltered: ${timeFiltered})`, () => {
      const b = createColumnMaterial({ timeFiltered, timeHeight: true });
      expect(b.material.positionNode).toBeTruthy();
      expect(b.timeHeight).toBeInstanceOf(ColumnTimeHeightUniforms);
    });
  }
  it('composes the lift alongside the DataFilter collapse', () => {
    const b = createColumnMaterial({ timeHeight: true, dataFilter: true });
    expect(b.timeHeight).toBeInstanceOf(ColumnTimeHeightUniforms);
    expect(b.filter).toBeInstanceOf(DataFilterUniforms);
  });
  it('omits the height uniforms when timeHeight is off', () => {
    expect(createColumnMaterial({}).timeHeight).toBeUndefined();
  });
});

describe('polygon material — time-as-height lift builds', () => {
  for (const mode of ['none', 'window'] as const) {
    it(`installs a lifting positionNode with timeHeight (mode: ${mode})`, () => {
      const b = createPolygonMaterial({ mode, timeHeight: true });
      // The lift raises the geometry position even in static `none` mode, so a
      // positionNode must be present.
      expect(b.material.positionNode).toBeTruthy();
      expect(b.timeHeight).toBeInstanceOf(PolygonTimeHeightUniforms);
    });
  }
  it('composes the lift with window mode + DataFilter', () => {
    const b = createPolygonMaterial({
      mode: 'window',
      timeHeight: true,
      dataFilter: true,
    });
    expect(b.material.positionNode).toBeTruthy();
    expect(b.timeHeight).toBeInstanceOf(PolygonTimeHeightUniforms);
    expect(b.filter).toBeInstanceOf(DataFilterUniforms);
  });
  it('a plain none-mode polygon keeps the default geometry position (no lift)', () => {
    const plain = createPolygonMaterial({ mode: 'none' });
    expect(plain.material.positionNode ?? null).toBeNull();
    expect(plain.timeHeight).toBeUndefined();
  });
});

describe('time-as-height uniform push', () => {
  it('resolves heightScale/heightOrigin for the column material', () => {
    const col = createColumnMaterial({ timeHeight: true });
    updateColumnUniforms(col, {
      relativeCurrentTime: 0,
      timeHeight: { heightScale: 0.5, heightOrigin: 3000 },
    });
    expect(col.timeHeight!.heightScale.value).toBe(0.5);
    expect(col.timeHeight!.heightOrigin.value).toBe(3000);
  });

  it('resolves heightScale/heightOrigin for the polygon material', () => {
    const poly = createPolygonMaterial({ mode: 'window', timeHeight: true });
    updatePolygonUniforms(poly, {
      relativeCurrentTime: 0,
      timeHeight: { heightScale: 0.25, heightOrigin: -500 },
    });
    expect(poly.timeHeight!.heightScale.value).toBe(0.25);
    expect(poly.timeHeight!.heightOrigin.value).toBe(-500);
  });

  it('defaults to flat (heightScale 0) when the lift params are omitted', () => {
    const col = createColumnMaterial({ timeHeight: true });
    updateColumnUniforms(col, { relativeCurrentTime: 0 });
    expect(col.timeHeight!.heightScale.value).toBe(0);
    expect(col.timeHeight!.heightOrigin.value).toBe(0);
  });

  it('is a no-op push when the material has no lift installed', () => {
    const plain = createPolygonMaterial({ mode: 'none' });
    expect(() =>
      updatePolygonUniforms(plain, {
        relativeCurrentTime: 0,
        timeHeight: { heightScale: 1, heightOrigin: 0 },
      }),
    ).not.toThrow();
    expect(plain.timeHeight).toBeUndefined();
  });
});
