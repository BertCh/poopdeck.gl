/**
 * Layer-level behaviour tests. We bypass MapLibre's real lifecycle and call the
 * `protected` hooks directly through `as any` casts — the goal is to verify
 * the *non-GL* logic each layer owns:
 *
 *   - Geometry filtering (each layer ignores tiles that don't match its kind)
 *   - Tile-cache construction (right vertex count, right index count)
 *   - Mercator pre-projection (positions in the unit square)
 *
 * The shader itself is unit-untestable without a real GL context; we cover it
 * via the showcase demo and visual inspection.
 */

import { describe, it, expect, vi } from 'vitest';
import { GeometryType } from '@stt/core';
import { STTPointLayer } from '../src/point-layer';
import { STTLineLayer } from '../src/line-layer';
import { STTPolygonLayer } from '../src/polygon-layer';
import { makeMockGl } from './mock-gl';
import { makePointTile, makeLineTile, makePolygonTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

describe('STTPointLayer', () => {
  it('only accepts Point geometry', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('builds a tile cache with one vertex per feature', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const gl = makeMockGl();
    layer.supports32BitIndices = true;
    const tile = makePointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    expect(cache.vertexCount).toBe(2);
    expect(cache.indexCount).toBe(0);
    expect(cache.timeOffset).toBe(tile.layers[0].features.timeOffset);
  });
});

describe('STTLineLayer', () => {
  it('only accepts LineString geometry', () => {
    const layer = new STTLineLayer({ ...baseOpts, id: 'l' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(true);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(false);
  });

  it('emits one instance per segment with no CPU quad expansion', () => {
    const layer = new STTLineLayer({ ...baseOpts, id: 'l' }) as any;
    layer.supports32BitIndices = true;
    // Drive the protected hooks directly — the real `initInstanceSupport`
    // from `onAdd` hasn't run, so we stand up a minimal stub.
    layer.instSupport = {
      enabled: true,
      drawArraysInstanced: () => {},
      drawElementsInstanced: () => {},
      vertexAttribDivisor: () => {},
    };
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    // Path 0 has 3 vertices => 2 segments. Path 1 has 2 vertices => 1 segment.
    // Total segments = 3 → 3 instances; no CPU quad expansion now.
    expect(cache.instanceCount).toBe(3);
    expect(cache.indexCount).toBe(0);
    // extraBuffers: posBBuffer (posABuffer is reused as positionBuffer).
    expect(cache.extraBuffers).toBeDefined();
    expect(cache.extraBuffers.length).toBe(1);
  });

  it('returns null for a layer with no startIndices', () => {
    const layer = new STTLineLayer({ ...baseOpts, id: 'l' }) as any;
    layer.supports32BitIndices = true;
    layer.instSupport = {
      enabled: true,
      drawArraysInstanced: () => {},
      drawElementsInstanced: () => {},
      vertexAttribDivisor: () => {},
    };
    const gl = makeMockGl();
    const tile = makePointTile(); // Point tile has no startIndices.
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).toBeNull();
  });

  it('refuses to build a tile cache when instancing is unavailable', () => {
    const layer = new STTLineLayer({ ...baseOpts, id: 'l' }) as any;
    layer.supports32BitIndices = true;
    // Leave instSupport.enabled at its default (false). Silence the warn so
    // the test output stays clean.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gl = makeMockGl();
    const tile = makeLineTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).toBeNull();
    warn.mockRestore();
  });
});

describe('STTPolygonLayer', () => {
  it('only accepts Polygon geometry', () => {
    const layer = new STTPolygonLayer({ ...baseOpts, id: 'g' }) as any;
    expect(layer.acceptsGeometry(GeometryType.Point)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.LineString)).toBe(false);
    expect(layer.acceptsGeometry(GeometryType.Polygon)).toBe(true);
  });

  it('triangulates a square into 2 triangles (6 indices)', () => {
    const layer = new STTPolygonLayer({ ...baseOpts, id: 'g' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePolygonTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    expect(cache.vertexCount).toBe(4);
    expect(cache.indexCount).toBe(6);
  });

  it('adds an instanced stroke pass when stroked: true', () => {
    const layer = new STTPolygonLayer({
      ...baseOpts,
      id: 'g',
      stroked: true,
      lineWidth: 2,
    }) as any;
    layer.supports32BitIndices = true;
    layer.instSupport = {
      enabled: true,
      drawArraysInstanced: () => {},
      drawElementsInstanced: () => {},
      vertexAttribDivisor: () => {},
    };
    const gl = makeMockGl();
    const tile = makePolygonTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.stroke).toBeDefined();
    // A 4-vertex square ring → 4 edges → 4 stroke instances. The legacy path
    // emitted 24 (4 edges × 6 indices) — instancing collapses that to a single
    // draw call against the shared 4-vertex unit quad.
    expect(cache.stroke.instanceCount).toBe(4);
  });

  it('emits side walls when extruded: true with a non-zero elevation', () => {
    const layer = new STTPolygonLayer({
      ...baseOpts,
      id: 'g',
      extruded: true,
      elevation: 1000,
    }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePolygonTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    // 4 top + 4 bottom verts; 2 top tris (6 idx) + 4 side quads (24 idx) = 30.
    expect(cache.vertexCount).toBe(8);
    expect(cache.indexCount).toBe(30);
  });
});

describe('Per-feature attribute wiring', () => {
  it('point layer uploads radius + color buffers when properties are configured', async () => {
    const { STTPointLayer } = await import('../src/point-layer');
    const { makePropertyPointTile } = await import('./fixtures');
    const layer = new STTPointLayer({
      ...baseOpts,
      id: 'p',
      colorProperty: 'species',
      radiusProperty: 'magnitude',
    }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePropertyPointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache.colorBuffer).toBeDefined();
    expect(cache.radiusBuffer).toBeDefined();
  });
});

describe('Fade-in/out resolution', () => {
  it('returns explicit durations when provided', () => {
    const layer = new STTPointLayer({
      ...baseOpts,
      id: 'p',
      fadeInDuration: 750,
      fadeOutDuration: 250,
    }) as any;
    const { fadeIn, fadeOut } = layer.resolveFadeDurations();
    expect(fadeIn).toBe(750);
    expect(fadeOut).toBe(250);
  });

  it('defaults to 10% of timeWindow when soft-fade is implied', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const { fadeIn, fadeOut } = layer.resolveFadeDurations();
    expect(fadeIn).toBe(500); // 5000 * 0.1
    expect(fadeOut).toBe(500);
  });

  it('returns 0 fades when softTimeWindow: false is explicit', () => {
    const layer = new STTPointLayer({
      ...baseOpts,
      id: 'p',
      softTimeWindow: false,
    }) as any;
    const { fadeIn, fadeOut } = layer.resolveFadeDurations();
    expect(fadeIn).toBe(0);
    expect(fadeOut).toBe(0);
  });
});

describe('STTPointLayer time-window math', () => {
  it('sets uniforms with window offsets relative to tile timeOffset', () => {
    const layer = new STTPointLayer({
      ...baseOpts,
      id: 'p',
      currentTime: 1_700_000_005_000,
      timeWindow: 10_000,
    }) as any;
    layer.supports32BitIndices = true;
    layer.onContextReady(makeMockGl());
    const gl = makeMockGl();
    const tile = makePointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    // Drive a render manually.
    layer.drawTile(gl, tile, tile.layers[0], cache, {
      matrix: new Float32Array(16),
      windowStart: layer.opts.currentTime - cache.timeOffset - layer.opts.timeWindow / 2,
      windowEnd: layer.opts.currentTime - cache.timeOffset + layer.opts.timeWindow / 2,
      currentTime: layer.opts.currentTime,
      zoom: 2,
    });
    // Window start/end should be 0 ms (5s before currentTime) and 10000 ms,
    // since currentTime - timeOffset = 5000 and halfWindow = 5000.
    const uniform1fCalls = gl.uniform1f.mock.calls as Array<[unknown, number]>;
    const values = uniform1fCalls.map((c) => c[1]);
    expect(values).toContain(0);
    expect(values).toContain(10_000);
    expect(gl.drawArrays).toHaveBeenCalledWith(expect.any(Number), 0, 2);
  });
});
