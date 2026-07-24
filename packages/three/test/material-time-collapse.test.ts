// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Node-graph BUILD gate for the vertex-stage time-collapse rewrite (Wave 1 item
 * 1). GPU compilation is browser-verified (see `vitest.config.ts`); here we only
 * assert every converted material's TSL node graph CONSTRUCTS without throwing
 * across all its time-filter modes, and that the merged-mesh materials wire a
 * collapsing `positionNode` in their filtered mode (and none in the static mode).
 * This catches wiring regressions (undefined nodes, bad method chains, a mode
 * that no longer builds) that the pure-math `time-filter-math.test.ts` cannot.
 */

import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import {
  createPointMaterial,
  createPointIdMaterial,
} from '../src/tsl/point-material';
import { createIconMaterial } from '../src/tsl/icon-material';
import { createColumnMaterial } from '../src/tsl/column-material';
import { createArcMaterial } from '../src/tsl/arc-material';
import { createWideLineMaterial } from '../src/tsl/wide-line-material';
import { createFlowArrowMaterial } from '../src/tsl/flow-arrow-material';
import { createFlowCorridorMaterial } from '../src/tsl/flow-corridor-material';
import { createSurfelMaterial } from '../src/tsl/surfel-material';
import { createPolygonMaterial } from '../src/tsl/polygon-material';
import { createIsoLineMaterial } from '../src/tsl/iso-line-material';

describe('point material — vertex collapse builds in every mode', () => {
  for (const mode of ['none', 'window', 'wake', 'cumulative'] as const) {
    it(`colour + id materials build (mode: ${mode})`, () => {
      for (const sizeUnits of ['meters', 'pixels'] as const) {
        const colour = createPointMaterial({ mode, sizeUnits, splat: true });
        expect(colour.material.vertexNode).toBeTruthy();
        expect(colour.material.opacityNode).toBeTruthy();
        const id = createPointIdMaterial({ mode, sizeUnits });
        expect(id.material.vertexNode).toBeTruthy();
        expect(id.material.opacityNode).toBeTruthy();
      }
    });
  }
});

describe('icon material — vertex collapse builds in every mode', () => {
  for (const mode of ['none', 'window', 'cumulative'] as const) {
    for (const mask of [false, true]) {
      it(`builds (mode: ${mode}, mask: ${mask})`, () => {
        const b = createIconMaterial({ mode, mask, atlas: new Texture() });
        expect(b.material.vertexNode).toBeTruthy();
        expect(b.material.opacityNode).toBeTruthy();
      });
    }
  }
});

describe('column material — prism collapse builds', () => {
  for (const timeFiltered of [true, false]) {
    it(`builds (timeFiltered: ${timeFiltered})`, () => {
      const b = createColumnMaterial({ timeFiltered, transparent: true });
      expect(b.material.positionNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
    });
  }
});

describe('arc material — width collapse builds', () => {
  for (const shape of ['parabolic', 'greatCircle'] as const) {
    it(`builds (shape: ${shape})`, () => {
      const b = createArcMaterial({ shape });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
    });
  }
});

describe('wide-line material — width collapse builds in every mode', () => {
  for (const mode of ['none', 'window', 'trail'] as const) {
    it(`builds (mode: ${mode})`, () => {
      const b = createWideLineMaterial({ mode });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
    });
  }
});

describe('flow-arrow material — builds (no time filter; already width-0 on CPU)', () => {
  it('builds', () => {
    const b = createFlowArrowMaterial({});
    expect(b.material.vertexNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
  });
});

describe('flow-corridor material — optional window collapse builds', () => {
  for (const windowFilter of [false, true]) {
    it(`builds (windowFilter: ${windowFilter})`, () => {
      const b = createFlowCorridorMaterial({
        valueTexture: new Texture(),
        rampTexture: new Texture(),
        windowFilter,
      });
      expect(b.material.vertexNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
    });
  }
});

describe('surfel material — builds (already vertex-collapses via its own gate)', () => {
  for (const packed of [false, true]) {
    it(`builds (packed: ${packed})`, () => {
      const b = createSurfelMaterial({ packed });
      expect(b.material.positionNode).toBeTruthy();
      expect(b.material.opacityNode).toBeTruthy();
    });
  }
});

describe('polygon material — merged-mesh collapse wiring', () => {
  it('wires a collapsing positionNode ONLY in window mode', () => {
    const win = createPolygonMaterial({ mode: 'window' });
    expect(win.material.positionNode).toBeTruthy(); // collapse wired
    expect(win.material.opacityNode).toBeTruthy();

    const none = createPolygonMaterial({ mode: 'none' });
    // Static polygons keep the default geometry position — no collapse node.
    expect(none.material.positionNode ?? null).toBeNull();
    expect(none.material.opacityNode).toBeTruthy();
  });
});

describe('iso-line material — merged-mesh collapse wiring', () => {
  it('wires a collapsing positionNode (always window-filtered)', () => {
    const b = createIsoLineMaterial();
    expect(b.material.positionNode).toBeTruthy();
    expect(b.material.opacityNode).toBeTruthy();
  });
});
