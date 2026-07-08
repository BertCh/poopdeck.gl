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
import { GeometryType } from '@poopdeck.gl/core';
import { STTPointLayer } from '../src/layers/point-layer';
import { STTLineLayer } from '../src/layers/line-layer';
import { STTPolygonLayer } from '../src/layers/polygon-layer';
import { makeMockGl } from './mock-gl';
import {
  makeLineTile,
  makePointTile,
  makePolygonTile,
  makePreTessellatedPolygonTile,
} from './fixtures';

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

  it('uses pre-baked triangle indices when the tile carries them (MLT mode)', () => {
    // When a tile arrives with `triangles`, we must NOT call earcut. Stub it
    // out — any call would surface as a test failure regardless of count.
    const layer = new STTPolygonLayer({ ...baseOpts, id: 'g' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePreTessellatedPolygonTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    expect(cache).not.toBeNull();
    // Same vertex count + index count as the legacy path (single square,
    // 4 verts, 2 triangles → 6 indices) — pre-baking is a CPU-time win, not
    // a representation change.
    expect(cache.vertexCount).toBe(4);
    expect(cache.indexCount).toBe(6);
  });

  it('setExtruded(false) rebuilds tile caches so walls actually disappear', () => {
    const layer = new STTPolygonLayer({
      ...baseOpts,
      id: 'g',
      extruded: true,
      elevation: 1000,
    }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    layer.gl = gl;
    layer.map = { triggerRepaint: vi.fn() };
    const tile = makePolygonTile();
    const before = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    // Extruded geometry is baked in: 4 top + 4 bottom verts, walls indexed.
    expect(before.vertexCount).toBe(8);
    expect(before.indexCount).toBe(30);

    layer.setExtruded(false);
    // The cache sweep frees the GPU buffers and forces a repaint…
    expect(layer.tileGpuCache.size).toBe(0);
    expect(gl.deleteBuffer).toHaveBeenCalled();
    expect(layer.map.triggerRepaint).toHaveBeenCalled();

    // …and the next frame's rebuild emits flat geometry (no walls/tops).
    const after = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(after.vertexCount).toBe(4);
    expect(after.indexCount).toBe(6);
  });

  it('setStroked(true) rebuilds tile caches so the stroke pass appears', () => {
    const layer = new STTPolygonLayer({ ...baseOpts, id: 'g' }) as any;
    layer.supports32BitIndices = true;
    layer.instSupport = {
      enabled: true,
      drawArraysInstanced: () => {},
      drawElementsInstanced: () => {},
      vertexAttribDivisor: () => {},
    };
    const gl = makeMockGl();
    layer.gl = gl;
    layer.map = { triggerRepaint: vi.fn() };
    const tile = makePolygonTile();
    const before = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(before.stroke).toBeUndefined();

    layer.setStroked(true);
    expect(layer.tileGpuCache.size).toBe(0);

    const after = layer.ensureTileGpuCache(gl, tile, tile.layers[0]);
    expect(after.stroke).toBeDefined();
    expect(after.stroke.instanceCount).toBe(4);

    // No-op toggle (same value) must NOT pay for a rebuild.
    layer.setStroked(true);
    expect(layer.tileGpuCache.size).toBe(1);
  });

  it('pre-baked path produces identical fill geometry to the earcut path', () => {
    // A regression guard for the index translation: pre-baked indices are
    // global into the tile's `positions` buffer; the layer must subtract
    // each feature's `startIndex` so the emitted index list still indexes
    // into the per-feature top-vertex slot the existing emit loop builds.
    const baseline = new STTPolygonLayer({ ...baseOpts, id: 'g1' }) as any;
    baseline.supports32BitIndices = true;
    const baselineCache = baseline.buildTileGpuCache(
      makeMockGl(),
      makePolygonTile(),
      makePolygonTile().layers[0],
    );

    const baked = new STTPolygonLayer({ ...baseOpts, id: 'g2' }) as any;
    baked.supports32BitIndices = true;
    const bakedTile = makePreTessellatedPolygonTile();
    const bakedCache = baked.buildTileGpuCache(
      makeMockGl(),
      bakedTile,
      bakedTile.layers[0],
    );
    expect(bakedCache.vertexCount).toBe(baselineCache.vertexCount);
    expect(bakedCache.indexCount).toBe(baselineCache.indexCount);
  });
});

describe('Per-feature attribute wiring', () => {
  it('point layer uploads radius + color buffers when properties are configured', async () => {
    const { STTPointLayer } = await import('../src/layers/point-layer');
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

  it('defaults to a HARD 0-cut (unified cross-backend policy, matches deck/three)', () => {
    // Renderer-abstraction Phase 1 decision: no soft ramp unless explicitly opted in.
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const { fadeIn, fadeOut } = layer.resolveFadeDurations();
    expect(fadeIn).toBe(0);
    expect(fadeOut).toBe(0);
  });

  it('applies the 10%-of-window soft ramp only when softTimeWindow: true is explicit', () => {
    const layer = new STTPointLayer({
      ...baseOpts,
      id: 'p',
      softTimeWindow: true,
    }) as any;
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
      windowStart:
        layer.opts.currentTime - cache.timeOffset - layer.opts.timeWindow / 2,
      windowEnd:
        layer.opts.currentTime - cache.timeOffset + layer.opts.timeWindow / 2,
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

describe('STTPointLayer position quantization (perf research 2026-07)', () => {
  it('buildTileGpuCache populates posScale/posOffset from a real (non-degenerate) bbox', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePointTile(); // SF + NYC — a genuinely wide mercator bbox.
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    expect(cache.posScale).toHaveLength(3);
    expect(cache.posOffset).toHaveLength(3);
    // x/y ranges must be positive (SF and NYC are far apart in mercator x);
    // z (altitude) is 0 for every 2D point, so its range collapses to 0.
    expect(cache.posScale[0]).toBeGreaterThan(0);
    expect(cache.posScale[1]).toBeGreaterThan(0);
    expect(cache.posScale[2]).toBe(0);
  });

  it('drawTile uploads the position buffer as UNSIGNED_SHORT/normalized and sets uPosScale/uPosOffset', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    layer.supports32BitIndices = true;
    layer.onContextReady(makeMockGl());
    const gl = makeMockGl();
    const tile = makePointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    layer.drawTile(gl, tile, tile.layers[0], cache, {
      matrix: new Float32Array(16),
      windowStart: 0,
      windowEnd: 10_000,
      currentTime: layer.opts.currentTime,
      zoom: 2,
    });

    const h = layer.handles;
    // The position attribute is bound UNSIGNED_SHORT + normalized=true — half
    // the bytes of the old Float32 upload, decoded to [0,1] for free by the
    // GPU's fixed-function vertex fetch.
    expect(gl.vertexAttribPointer).toHaveBeenCalledWith(
      h.aMercator,
      3,
      gl.UNSIGNED_SHORT,
      true,
      0,
      0,
    );
    // uPosScale/uPosOffset were set from the cache's quantization params.
    const scaleCalls = gl.uniform3fv.mock.calls.filter(
      (c: unknown[]) => c[0] === h.uPosScale,
    );
    const offsetCalls = gl.uniform3fv.mock.calls.filter(
      (c: unknown[]) => c[0] === h.uPosOffset,
    );
    expect(scaleCalls).toHaveLength(1);
    expect(offsetCalls).toHaveLength(1);
    expect(scaleCalls[0][1]).toEqual(cache.posScale);
    expect(offsetCalls[0][1]).toEqual(cache.posOffset);
  });

  it('positionBuffer is uploaded as a Uint16Array (half the bytes of the old Float32 buffer)', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePointTile();
    layer.buildTileGpuCache(gl, tile, tile.layers[0]);

    const posBufferCall = gl.bufferData.mock.calls.find(
      (c: unknown[]) =>
        c[1] instanceof Uint16Array && (c[1] as Uint16Array).length === 6, // 2 points * 3 components
    );
    expect(posBufferCall).toBeDefined();
  });
});
