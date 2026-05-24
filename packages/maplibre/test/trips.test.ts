/**
 * Behaviour tests for STTTripsLayer. Same approach as layers.test.ts: drive the
 * `protected` hooks directly with a mock GL context and assert on cache shape
 * + the uniform values pushed by drawTile.
 */

import { describe, it, expect } from 'vitest';
import { GeometryType } from '@stt/core';
import { STTTripsLayer } from '../src/trips-layer';
import { makeMockGl } from './mock-gl';
import { makeTripsTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_500,
  timeWindow: 5000,
};

describe('STTTripsLayer', () => {
  it('only accepts LineString geometry', () => {
    const layer = new STTTripsLayer({ ...baseOpts, id: 't' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('emits one instance per segment with per-endpoint vertex times', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      trailLength: 1500,
    }) as any;
    layer.supports32BitIndices = true;
    layer.instSupport = {
      enabled: true,
      drawArraysInstanced: () => {},
      drawElementsInstanced: () => {},
      vertexAttribDivisor: () => {},
    };
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    // Path 0 has 3 verts → 2 segments, Path 1 has 2 verts → 1 segment → 3.
    expect(cache.instanceCount).toBe(3);
    expect(cache.indexCount).toBe(0);
    expect(cache.vertexTimeABBuffer).toBeDefined();
  });

  it('packs per-feature width and colour attributes when properties are set', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      widthProperty: 'width',
      colorProperty: 'vehicleType',
    }) as any;
    layer.supports32BitIndices = true;
    layer.instSupport = {
      enabled: true,
      drawArraysInstanced: () => {},
      drawElementsInstanced: () => {},
      vertexAttribDivisor: () => {},
    };
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    expect(cache.widthBuffer).toBeDefined();
    expect(cache.colorBuffer).toBeDefined();
  });

  it('uploads currentTime relative to tile timeOffset in drawTile', () => {
    const layer = new STTTripsLayer({
      ...baseOpts,
      id: 't',
      currentTime: 1_700_000_001_500,
      trailLength: 2000,
    }) as any;
    layer.supports32BitIndices = true;
    layer.instSupport = {
      enabled: true,
      drawArraysInstanced: () => {},
      drawElementsInstanced: () => {},
      vertexAttribDivisor: () => {},
    };
    layer.onContextReady(makeMockGl());
    const gl = makeMockGl();
    const tile = makeTripsTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    layer.drawTile(gl, tile, tile.layers[0], cache, {
      matrix: new Float32Array(16),
      windowStart: 0,
      windowEnd: 0,
      currentTime: layer.opts.currentTime,
      zoom: 2,
    });
    // currentTime - timeOffset = 1500
    const uniform1fCalls = gl.uniform1f.mock.calls as Array<[unknown, number]>;
    const values = uniform1fCalls.map((c) => c[1]);
    expect(values).toContain(1500);
    expect(values).toContain(2000); // trail length
    // The instanced draw is routed through `instSupport.drawArraysInstanced`,
    // which the test stub above no-ops; just verify the layer did not fall
    // back to the legacy drawElements path.
    expect(gl.drawElements).not.toHaveBeenCalled();
  });
});
