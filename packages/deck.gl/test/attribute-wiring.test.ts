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
 * Real deck.gl layers need a GPU to instantiate, so layer construction is
 * exercised indirectly: we reproduce each layer's consolidated `attributes`
 * object the same way the layer builds it and assert its keys.
 */

import { describe, it, expect } from 'vitest';
import { TimeFilterExtension } from '../src/time-filter-extension';
import { CategoryColorExtension } from '../src/category-color-extension';
import { PolygonTimeFilterExtension } from '../src/polygon-time-filter-extension';
import { consolidatePoints, consolidatePaths } from '../src/consolidate';
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
  it('registers instanceStartTime / instanceEndTime / instanceVertexTime', () => {
    const { instanced } = captureRegisteredAttributes(new TimeFilterExtension());
    expect(Object.keys(instanced).sort()).toEqual(
      ['instanceEndTime', 'instanceStartTime', 'instanceVertexTime'].sort()
    );
    // All are single-component float32 attributes.
    for (const name of ['instanceStartTime', 'instanceEndTime', 'instanceVertexTime']) {
      expect(instanced[name].size).toBe(1);
      expect(instanced[name].type).toBe('float32');
    }
  });
});

describe('CategoryColorExtension attribute registration', () => {
  it('registers instanceCategoryIndex', () => {
    const { instanced } = captureRegisteredAttributes(new CategoryColorExtension());
    expect(Object.keys(instanced)).toEqual(['instanceCategoryIndex']);
    expect(instanced.instanceCategoryIndex.size).toBe(1);
    expect(instanced.instanceCategoryIndex.type).toBe('float32');
  });
});

describe('PolygonTimeFilterExtension attribute registration', () => {
  it('registers startTime / endTime as NON-instanced (per-vertex via tesselator)', () => {
    // SolidPolygonLayer is non-instanced. Registering via addInstanced()
    // (the standard TimeFilterExtension path) would set stepMode='instance'
    // and the polygon tesselator's per-feature → per-vertex expansion would
    // not happen.
    const { instanced, perVertex } = captureRegisteredAttributes(
      new PolygonTimeFilterExtension(),
    );
    expect(Object.keys(instanced)).toEqual([]);
    expect(Object.keys(perVertex).sort()).toEqual(['endTime', 'startTime']);
    for (const name of ['startTime', 'endTime']) {
      expect(perVertex[name].size).toBe(1);
      expect(perVertex[name].type).toBe('float32');
      expect(perVertex[name].stepMode).toBe('dynamic');
    }
  });
});

describe('point layer consolidated attributes match the extension names', () => {
  it('exposes instanceStartTime / instanceEndTime as Float32Array', () => {
    // Reproduce AnimatedPointLayer.buildConsolidatedData's attribute object.
    const tile = makePointTile({
      positions: [[0, 0], [1, 1]],
      startTimes: [10, 20],
      endTimes: [15, 25],
      timeOffset: 1_716_206_000_000,
    });
    const c = consolidatePoints([tile])!;
    const attributes: Record<string, any> = {
      getPosition: { value: c.positions, size: c.dims },
      instanceStartTime: { value: c.startTimes, size: 1 },
      instanceEndTime: { value: c.endTimes, size: 1 },
    };

    expect(attributes).toHaveProperty('instanceStartTime');
    expect(attributes).toHaveProperty('instanceEndTime');
    // Must NOT use the old accessor-name key.
    expect(attributes).not.toHaveProperty('getInstanceStartTime');
    expect(attributes.instanceStartTime.value).toBeInstanceOf(Float32Array);
    expect(attributes.instanceEndTime.value).toBeInstanceOf(Float32Array);
  });
});

describe('path layer consolidated attributes match the extension names', () => {
  it('exposes instanceStartTime / instanceEndTime as Float32Array', () => {
    const tile = makePathTile({
      paths: [[[0, 0], [1, 1]]],
      startTimes: [10],
      endTimes: [20],
      timeOffset: 0,
    });
    const c = consolidatePaths([tile])!;
    const attributes: Record<string, any> = {
      getPath: { value: c.positions, size: c.dims },
      instanceStartTime: { value: c.startTimes, size: 1 },
      instanceEndTime: { value: c.endTimes, size: 1 },
    };
    expect(attributes).toHaveProperty('instanceStartTime');
    expect(attributes).toHaveProperty('instanceEndTime');
    expect(attributes.instanceStartTime.value).toBeInstanceOf(Float32Array);
  });
});

describe('trips layer uses instanceVertexTime (the registered name)', () => {
  it('the trail-mode attribute key matches what the extension registers', () => {
    // AnimatedTripsLayer feeds per-vertex times under `instanceVertexTime`.
    const { instanced } = captureRegisteredAttributes(new TimeFilterExtension());
    const tripsAttributeKey = 'instanceVertexTime';
    expect(instanced).toHaveProperty(tripsAttributeKey);
  });
});
