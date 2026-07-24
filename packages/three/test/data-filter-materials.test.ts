// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
//
// Node-graph BUILD gate for the DataFilter feature family (arc, line/od-line,
// trips, column, polygon). GPU compilation is browser-verified; here we assert
// each material's TSL graph CONSTRUCTS without throwing when built with
// `dataFilter: true` (across every time-filter mode it also supports), that the
// filter uniforms are present only when requested, that the merged-mesh
// (polygon) collapse wiring appears even in the static `none` mode once the
// column filter is installed, and that the uniform-push resolves deck props.
// The range math itself is proven in `data-filter-math.test.ts`.

import { describe, it, expect } from 'vitest';
import { createArcMaterial, updateArcUniforms } from '../src/tsl/arc-material';
import {
  createWideLineMaterial,
  updateWideLineUniforms,
} from '../src/tsl/wide-line-material';
import {
  createColumnMaterial,
  updateColumnUniforms,
} from '../src/tsl/column-material';
import {
  createPolygonMaterial,
  updatePolygonUniforms,
} from '../src/tsl/polygon-material';
import { DataFilterUniforms } from '../src/tsl/data-filter';

describe('arc material — DataFilter width collapse builds', () => {
  for (const shape of ['parabolic', 'greatCircle'] as const) {
    it(`builds with dataFilter (shape: ${shape})`, () => {
      const b = createArcMaterial({ shape, dataFilter: true });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.filter).toBeInstanceOf(DataFilterUniforms);
    });
  }
  it('omits the filter uniforms when dataFilter is off', () => {
    expect(createArcMaterial({}).filter).toBeUndefined();
  });
});

describe('wide-line material — DataFilter width collapse builds in every mode', () => {
  for (const mode of ['none', 'window', 'trail'] as const) {
    it(`builds with dataFilter (mode: ${mode})`, () => {
      const b = createWideLineMaterial({ mode, dataFilter: true });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.filter).toBeInstanceOf(DataFilterUniforms);
    });
  }
  it('omits the filter uniforms when dataFilter is off', () => {
    expect(createWideLineMaterial({ mode: 'trail' }).filter).toBeUndefined();
  });
});

describe('column material — DataFilter prism collapse builds', () => {
  for (const timeFiltered of [true, false]) {
    it(`builds with dataFilter (timeFiltered: ${timeFiltered})`, () => {
      const b = createColumnMaterial({
        timeFiltered,
        transparent: true,
        dataFilter: true,
      });
      expect(b.material.positionNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
      expect(b.filter).toBeInstanceOf(DataFilterUniforms);
    });
  }
  it('omits the filter uniforms when dataFilter is off', () => {
    expect(createColumnMaterial({}).filter).toBeUndefined();
  });
});

describe('polygon material — DataFilter merged-mesh collapse wiring', () => {
  it('wires a collapsing positionNode in window mode with dataFilter', () => {
    const b = createPolygonMaterial({ mode: 'window', dataFilter: true });
    expect(b.material.positionNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
    expect(b.filter).toBeInstanceOf(DataFilterUniforms);
  });

  it('wires a collapsing positionNode EVEN in static none mode once the filter is installed', () => {
    const withFilter = createPolygonMaterial({
      mode: 'none',
      dataFilter: true,
    });
    // The column filter must collapse out-of-range features even for a static
    // (non-time-filtered) polygon → a positionNode is present.
    expect(withFilter.material.positionNode).toBeTruthy();
    expect(withFilter.filter).toBeInstanceOf(DataFilterUniforms);

    // Regression guard: a static polygon with NO filter keeps the default
    // geometry position (no collapse node) — the shipped map-decal behaviour.
    const plain = createPolygonMaterial({ mode: 'none' });
    expect(plain.material.positionNode ?? null).toBeNull();
    expect(plain.filter).toBeUndefined();
  });
});

describe('uniform push resolves deck DataFilter props', () => {
  it('activates the filter and pushes the range for every material', () => {
    const arc = createArcMaterial({ dataFilter: true });
    updateArcUniforms(arc, {
      relativeCurrentTime: 0,
      dataFilter: { filterRange: [2, 8], filterSoftRange: [3, 7] },
    });
    expect(arc.filter!.enabled.value).toBe(1);
    expect(arc.filter!.filterMin.value).toBe(2);
    expect(arc.filter!.filterMax.value).toBe(8);
    expect(arc.filter!.useSoftMargin.value).toBe(1);

    const line = createWideLineMaterial({ mode: 'window', dataFilter: true });
    updateWideLineUniforms(line, {
      relativeCurrentTime: 0,
      dataFilter: { filterRange: [0, 5] },
    });
    expect(line.filter!.enabled.value).toBe(1);
    expect(line.filter!.filterSoftMin.value).toBe(0); // soft collapses onto hard

    const col = createColumnMaterial({ dataFilter: true });
    updateColumnUniforms(col, {
      relativeCurrentTime: 0,
      dataFilter: { filterEnabled: false, filterRange: [0, 5] },
    });
    expect(col.filter!.enabled.value).toBe(0); // explicitly disabled → idle

    const poly = createPolygonMaterial({ mode: 'none', dataFilter: true });
    updatePolygonUniforms(poly, {
      relativeCurrentTime: 0,
      dataFilter: { filterRange: [10, 20] },
    });
    expect(poly.filter!.enabled.value).toBe(1);
    expect(poly.filter!.filterMax.value).toBe(20);
  });

  it('is a no-op push when the material has no filter installed', () => {
    const arc = createArcMaterial({});
    expect(() =>
      updateArcUniforms(arc, {
        relativeCurrentTime: 0,
        dataFilter: { filterRange: [0, 1] },
      }),
    ).not.toThrow();
    expect(arc.filter).toBeUndefined();
  });
});
