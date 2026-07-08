/**
 * id-buffer picking scaffold tests (Phase 4c).
 *
 * The GL round-trip inside `STTBaseLayer.pick()` (offscreen FBO render +
 * `readPixels`) needs a live GPU and is browser-verify-only. Everything CPU is
 * covered here:
 *
 *   - `buildPickIdColors` — per-feature id-colour bytes, round-trips through the
 *     `encodePickId`/`decodePickId` kernel and agrees with `buildIdColors`.
 *   - `cssToDevicePixel` — cursor → device-pixel math with the GL Y-flip.
 *   - `buildPickProvenance` — global 1-based id allocation across tiles/layers.
 *   - `resolvePick` — decode → provenance lookup → `getFeatureProperties` join.
 *   - `pick()` orchestration — driven end-to-end against the recorder GL with a
 *     staged single-pixel readback (proves provenance → resolve wiring + host
 *     render-target save/restore, without asserting real GPU output).
 */

import { describe, it, expect } from 'vitest';
import {
  encodePickId,
  decodePickId,
  buildIdColors,
} from '@poopdeck.gl/core/picking';
import { STTPointLayer } from '../src/layers/point-layer';
import { STTLineLayer } from '../src/layers/line-layer';
import { cssToDevicePixel } from '../src/base-layer';
import { makeMockGl, makeMockMap } from './mock-gl';
import { makeLineTile, makePointTile } from './fixtures';

const baseOpts = {
  url: 'mem://test.stt',
  currentTime: 1_700_000_001_000,
  timeWindow: 5000,
};

/** Read the i-th 3-byte id colour out of a flat Uint8Array as an [r,g,b]. */
const triple = (buf: Uint8Array, i: number): [number, number, number] => [
  buf[i * 3],
  buf[i * 3 + 1],
  buf[i * 3 + 2],
];

describe('buildPickIdColors', () => {
  it('encodes feature i as encodePickId(idBase + i), round-tripping via decodePickId', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const idBase = 7;
    const count = 4;
    const colors: Uint8Array = layer.buildPickIdColors(count, idBase);
    expect(colors.length).toBe(count * 3);
    for (let i = 0; i < count; i++) {
      expect(decodePickId(triple(colors, i))).toBe(idBase + i);
    }
  });

  it('rejects a non-positive idBase (0 is reserved for the no-hit background)', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    expect(() => layer.buildPickIdColors(2, 0)).toThrow(RangeError);
    expect(() => layer.buildPickIdColors(2, -1)).toThrow(RangeError);
  });

  it('agrees byte-for-byte with the core buildIdColors kernel (offset aside)', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const n = 6;
    // core buildIdColors is 0-based normalized floats; ours is 1-based bytes.
    const floats = buildIdColors(n); // ids 0..n-1
    const bytes: Uint8Array = layer.buildPickIdColors(n, 1); // ids 1..n
    for (let i = 0; i < n; i++) {
      const [fr, fg, fb] = [
        floats[i * 3],
        floats[i * 3 + 1],
        floats[i * 3 + 2],
      ];
      // Our feature i (id i+1) should equal the core encoding of id i+1.
      const [r, g, b] = encodePickId(i + 1);
      expect(triple(bytes, i)).toEqual([r, g, b]);
      // And the core float for id i decodes to i.
      expect(
        decodePickId([
          Math.round(fr * 255),
          Math.round(fg * 255),
          Math.round(fb * 255),
        ]),
      ).toBe(i);
    }
  });
});

describe('cssToDevicePixel', () => {
  it('scales by dpr and flips Y into GL bottom-left space', () => {
    // dpr 2: (10,20) css → (20,40) device (top-left); flip in a 200-tall buffer.
    expect(cssToDevicePixel(10, 20, 2, 200)).toEqual({
      x: 20,
      y: 200 - 1 - 40,
    });
  });

  it('is identity-ish at dpr 1 apart from the Y-flip', () => {
    expect(cssToDevicePixel(3, 5, 1, 100)).toEqual({ x: 3, y: 94 });
  });

  it('clamps to non-negative pixels for out-of-canvas cursors', () => {
    const { x, y } = cssToDevicePixel(-5, 10_000, 1, 100);
    expect(x).toBe(0);
    expect(y).toBe(0);
  });
});

describe('buildPickProvenance', () => {
  it('allocates one contiguous 1-based id range per accepted (tile, layer)', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tile = makePointTile(); // 2 point features
    layer.loadedTiles.set('a', tile);

    const prov = layer.buildPickProvenance(gl);
    expect(prov).toHaveLength(1);
    expect(prov[0].idBase).toBe(1); // 1-based; 0 is the background sentinel
    expect(prov[0].count).toBe(2);
    expect(prov[0].layer.name).toBe('points');
  });

  it('advances the id cursor across multiple tiles so ranges never overlap', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    const tileA = makePointTile();
    const tileB = makePointTile();
    tileB.id = { ...tileB.id, x: 2 }; // distinct tile key
    layer.loadedTiles.set('a', tileA);
    layer.loadedTiles.set('b', tileB);

    const prov = layer.buildPickProvenance(gl);
    expect(prov.map((e: any) => [e.idBase, e.count])).toEqual([
      [1, 2],
      [3, 2],
    ]);
  });

  it('skips tiles whose geometry the layer does not accept', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    layer.supports32BitIndices = true;
    const gl = makeMockGl();
    layer.loadedTiles.set('line', makeLineTile()); // LineString, not Point
    expect(layer.buildPickProvenance(gl)).toHaveLength(0);
  });
});

describe('resolvePick', () => {
  it('decodes a hit into an SttPickResult joined via getFeatureProperties', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const gl = makeMockGl();
    const tile = makePointTile();
    const cache = layer.buildTileGpuCache(gl, tile, tile.layers[0]);
    const provenance = [
      { tile, layer: tile.layers[0], cache, idBase: 1, count: 2 },
    ];
    // Global id 2 → feature index 1 (id 2 = idBase 1 + local 1).
    const res = layer.resolvePick(encodePickId(2), provenance);
    expect(res).not.toBeNull();
    expect(res.index).toBe(1);
    expect(res.layerId).toBe('points');
    expect(res.tileId).toEqual(tile.id);
    // Feature 1's reconstructed columns (fixture: id 1, start 5000 / end 8000).
    expect(res.object.id).toBe(1);
    expect(res.object.start_time).toBe(
      tile.layers[0].features.timeOffset + 5000,
    );
    expect(res.object.end_time).toBe(tile.layers[0].features.timeOffset + 8000);
  });

  it('returns null for the cleared background (id 0)', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const tile = makePointTile();
    const provenance = [
      { tile, layer: tile.layers[0], cache: {}, idBase: 1, count: 2 },
    ];
    expect(layer.resolvePick([0, 0, 0], provenance)).toBeNull();
  });

  it('returns null for a decoded id outside every provenance range', () => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const tile = makePointTile();
    const provenance = [
      { tile, layer: tile.layers[0], cache: {}, idBase: 1, count: 2 },
    ];
    // id 9 is past [1, 3) → miss.
    expect(layer.resolvePick(encodePickId(9), provenance)).toBeNull();
  });
});

describe('supportsPicking', () => {
  it('is true for the point layer (has an id shader) and false for the line layer', () => {
    const point = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    const line = new STTLineLayer({ ...baseOpts, id: 'l' }) as any;
    expect(point.supportsPicking()).toBe(true);
    expect(line.supportsPicking()).toBe(false);
  });

  it('pick() returns null on a non-pickable layer', () => {
    const line = new STTLineLayer({ ...baseOpts, id: 'l' }) as any;
    line.gl = makeMockGl();
    line.map = makeMockMap();
    line.tileset = {};
    line.lastMatrix = new Float32Array(16);
    expect(line.pick(10, 10)).toBeNull();
  });
});

describe('pick() orchestration (staged readback)', () => {
  /** Stand a point layer up far enough to run pick() against the recorder GL. */
  const standUp = (gl: any) => {
    const layer = new STTPointLayer({ ...baseOpts, id: 'p' }) as any;
    layer.supports32BitIndices = true;
    layer.gl = gl;
    layer.map = makeMockMap();
    layer.tileset = {}; // truthy — pick() only needs it non-null
    layer.onContextReady(gl); // compiles visual + id programs
    layer.lastMatrix = new Float32Array(16);
    layer.loadedTiles.set('a', makePointTile());
    return layer;
  };

  it('returns null before any frame has rendered (no matrix captured)', () => {
    const gl = makeMockGl();
    const layer = standUp(gl);
    layer.lastMatrix = undefined;
    expect(layer.pick(50, 50)).toBeNull();
  });

  it('decodes the staged pixel into the picked feature and restores the host target', () => {
    const gl = makeMockGl();
    const layer = standUp(gl);

    // Simulate a host render target bound on entry (terrain/globe draping).
    const hostFbo = { __host: true };
    gl.bindFramebuffer(gl.FRAMEBUFFER, hostFbo);

    // Stage the readback: feature index 1 (global id 2), opaque.
    const [r, g, b] = encodePickId(2);
    gl._readPixelsValue = new Uint8Array([r, g, b, 255]);

    const res = layer.pick(100, 100);
    expect(res).not.toBeNull();
    expect(res.index).toBe(1);
    expect(res.layerId).toBe('points');
    expect(res.object.id).toBe(1);

    // The id pass actually drew, read back, and left the host target restored.
    expect(gl.readPixels).toHaveBeenCalledTimes(1);
    expect(gl.getParameter(gl.FRAMEBUFFER_BINDING)).toBe(hostFbo);
  });

  it('returns null when the staged pixel is the cleared background', () => {
    const gl = makeMockGl();
    const layer = standUp(gl);
    gl._readPixelsValue = new Uint8Array([0, 0, 0, 0]);
    expect(layer.pick(100, 100)).toBeNull();
  });
});
