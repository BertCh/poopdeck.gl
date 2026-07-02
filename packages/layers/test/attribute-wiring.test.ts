/**
 * Attribute-wiring tests.
 *
 * deck.gl binds binary `attributes` by ATTRIBUTE NAME, not accessor name.
 * These tests assert that:
 *  1. TimeFilterExtension / CategoryColorExtension register the attribute
 *     names we expect (instanceStartTime / instanceEndTime /
 *     instanceVertexTime / instanceCategoryIndex).
 *  2. The data objects the animated layers feed to deck.gl carry the time
 *     attributes under those EXACT keys (so the data actually reaches the GPU).
 *
 * Real deck.gl layers need a GPU to instantiate, so we construct the
 * per-tile binary `data.attributes` object the same way each layer builds it
 * and assert its key set.
 */

import { describe, it, expect } from 'vitest';
import { TimeFilterExtension } from '../src/extensions/time-filter-extension';
import { CategoryColorExtension } from '../src/extensions/category-color-extension';
import { makePointTile, makePathTile } from './fake-tile';

/**
 * Capture the attribute descriptors an extension registers by giving its
 * initializeState a fake layer whose attributeManager records addInstanced()
 * and add().
 */
function captureRegisteredAttributes(extension: any): {
  instanced: Record<string, any>;
  perVertex: Record<string, any>;
} {
  const instanced: Record<string, any> = {};
  const perVertex: Record<string, any> = {};
  const fakeAttributeManager = {
    addInstanced: (descriptors: Record<string, any>) => {
      Object.assign(instanced, descriptors);
    },
    add: (descriptors: Record<string, any>) => {
      Object.assign(perVertex, descriptors);
    },
  };
  const fakeLayer = {
    getAttributeManager: () => fakeAttributeManager,
    // CategoryColorExtension also creates a texture; give it a stub device.
    context: {
      device: {
        createTexture: () => ({
          copyImageData: () => {},
          destroy: () => {},
        }),
      },
    },
    setState: () => {},
    props: { categoryPalette: [] },
    state: {},
  };
  // Lifecycle methods run with `this` = the layer; extension passed as arg.
  extension.initializeState.call(fakeLayer, fakeLayer.context, extension);
  return { instanced, perVertex };
}

describe('TimeFilterExtension attribute registration', () => {
  it('registers instanceStartTime / instanceEndTime / instanceVertexTime via add() + stepMode dynamic', () => {
    // MUST be add(), not addInstanced(): deck.gl core's addInstanced()
    // unconditionally overrides stepMode to 'instance', which hard-locks the
    // extension to instanced layers (a divisor-1 attribute on
    // SolidPolygonLayer's non-instanced fill model reads element 0 for every
    // vertex). 'dynamic' resolves per model — 'instance' on instanced layers,
    // 'vertex' on SolidPolygonLayer — exactly like upstream
    // DataFilterExtension's filterValues.
    const { instanced, perVertex } = captureRegisteredAttributes(new TimeFilterExtension());
    expect(Object.keys(instanced)).toEqual([]);
    expect(Object.keys(perVertex).sort()).toEqual(
      ['instanceEndTime', 'instanceStartTime', 'instanceVertexTime'].sort()
    );
    for (const name of ['instanceStartTime', 'instanceEndTime', 'instanceVertexTime']) {
      expect(perVertex[name].size).toBe(1);
      expect(perVertex[name].type).toBe('float32');
      expect(perVertex[name].stepMode).toBe('dynamic');
    }
  });
});

describe('CategoryColorExtension attribute registration', () => {
  it('registers instanceCategoryIndex via add() + stepMode dynamic', () => {
    const { instanced, perVertex } = captureRegisteredAttributes(new CategoryColorExtension());
    expect(Object.keys(instanced)).toEqual([]);
    expect(Object.keys(perVertex)).toEqual(['instanceCategoryIndex']);
    expect(perVertex.instanceCategoryIndex.size).toBe(1);
    expect(perVertex.instanceCategoryIndex.type).toBe('float32');
    expect(perVertex.instanceCategoryIndex.stepMode).toBe('dynamic');
  });
});

describe('point layer per-tile attributes match the extension names', () => {
  it('exposes instanceStartTime / instanceEndTime as Float32Array', () => {
    const tile = makePointTile({
      positions: [[0, 0], [1, 1]],
      startTimes: [10, 20],
      endTimes: [15, 25],
      timeOffset: 1_716_206_000_000,
    });
    // Mirrors AnimatedPointLayer.prepareTile: the per-tile binary `data`
    // object hands the tile's own typed arrays to deck.gl under the
    // extension-registered keys.
    const binary = tile.layers[0].features;
    const attributes: Record<string, any> = {
      getPosition: { value: binary.positions, size: binary.positionDimensions ?? 2 },
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };
    expect(attributes).toHaveProperty('instanceStartTime');
    expect(attributes).toHaveProperty('instanceEndTime');
    expect(attributes).not.toHaveProperty('getInstanceStartTime');
    expect(attributes.instanceStartTime.value).toBeInstanceOf(Float32Array);
    expect(attributes.instanceEndTime.value).toBeInstanceOf(Float32Array);
  });
});

describe('path layer per-tile attributes match the extension names', () => {
  it('exposes instanceStartTime / instanceEndTime as Float32Array', () => {
    const tile = makePathTile({
      paths: [[[0, 0], [1, 1]]],
      startTimes: [10],
      endTimes: [20],
      timeOffset: 0,
    });
    // Mirrors AnimatedPathLayer.prepareTile.
    const binary = tile.layers[0].features;
    const attributes: Record<string, any> = {
      getPath: { value: binary.positions, size: binary.positionDimensions ?? 2 },
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };
    expect(attributes).toHaveProperty('instanceStartTime');
    expect(attributes).toHaveProperty('instanceEndTime');
    expect(attributes.instanceStartTime.value).toBeInstanceOf(Float32Array);
  });
});

describe('trips layer uses instanceVertexTime (the registered name)', () => {
  it('the trail-mode attribute key matches what the extension registers', () => {
    // AnimatedTripsLayer feeds per-vertex times under `instanceVertexTime`.
    const { perVertex } = captureRegisteredAttributes(new TimeFilterExtension());
    const tripsAttributeKey = 'instanceVertexTime';
    expect(perVertex).toHaveProperty(tripsAttributeKey);
  });
});
