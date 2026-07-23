/**
 * Minimal WebGL recorder used in tests. Returns sentinel objects for buffer /
 * program / shader handles so the layer code under test can pass them around,
 * and counts calls so tests can assert "did we draw something" without needing
 * a real GPU.
 */

import { vi } from 'vitest';

let nextHandleId = 1;

const makeHandle = (kind: string) => ({
  __mockKind: kind,
  __id: nextHandleId++,
});

/**
 * Build a recorder that satisfies both WebGLRenderingContext and
 * WebGL2RenderingContext as far as our layer code uses them. Anything we
 * don't call falls through to `vi.fn()` so we can assert on it later if a
 * future code path starts exercising it.
 */
export function makeMockGl(
  opts: {
    supports32Bit?: boolean;
    /**
     * When true, the recorder advertises `EXT_color_buffer_half_float` so the
     * heatmap path probes RGBA16F. Default `false` so legacy tests see the
     * historical RGBA8 allocator.
     */
    supportsHalfFloatColorBuffer?: boolean;
    /**
     * When true, `getExtension('OES_vertex_array_object')` returns a stub.
     * Default false — the WebGL2-style `createVertexArray` already exists on
     * the mock so the layer code takes the WebGL2 fast path; this flag exists
     * for the (rare) WebGL1 + OES test cases.
     */
    supportsVaoExtension?: boolean;
  } = {},
): any {
  const constants = {
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    DEPTH_TEST: 0x0b71,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_SHORT: 0x1403,
    UNSIGNED_INT: 0x1405,
    HALF_FLOAT: 0x140b,
    RGBA: 0x1908,
    RGBA16F: 0x881a,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    FRAMEBUFFER: 0x8d40,
    FRAMEBUFFER_BINDING: 0x8ca6,
    VIEWPORT: 0x0ba2,
    COLOR_ATTACHMENT0: 0x8ce0,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    ONE: 1,
    LINE_LOOP: 2,
    LINE_STRIP: 3,
    TRIANGLE_STRIP: 5,
    TRIANGLE_FAN: 6,
    COLOR_BUFFER_BIT: 0x4000,
    TRIANGLES: 0x0004,
    POINTS: 0x0000,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    COLOR_CLEAR_VALUE: 0x0c22,
    VERTEX_ARRAY_BINDING: 0x85b5,
  };

  const drawCalls: Array<{ kind: 'arrays' | 'elements'; count: number }> = [];

  /**
   * Snapshot log of every `uniform2fv` upload. `mock.calls` retains the CALLER's
   * array, and the DataFilter payload is a single `Float32Array` resolved in
   * place per draw (no hot-path allocation), so a plain call log would show
   * every recorded upload holding the latest values. Real GL copies at upload
   * time — this log reproduces that, and is what a test asserting a SEQUENCE of
   * vec2 uploads must read.
   */
  const vec2Uploads: Array<{ location: unknown; value: number[] }> = [];

  // Tracked bind state for getParameter — just enough for the heatmap's
  // "capture + restore the host render target" path and pick()'s wider
  // capture/restore (blend + depth-test enables, clear colour, bound VAO).
  let boundFramebuffer: unknown = null;
  let currentViewport = new Int32Array([0, 0, 1024, 768]);
  let boundVao: unknown = null;
  // Real GL's own initial values, so a test can assert pick() put them back.
  const enabledCaps = new Map<number, boolean>([
    [constants.BLEND, false],
    [constants.DEPTH_TEST, false],
  ]);
  let clearColorValue = new Float32Array([0, 0, 0, 0]);

  const gl = {
    ...constants,
    drawingBufferWidth: 1024,
    drawingBufferHeight: 768,

    drawCalls,
    vec2Uploads,

    enable: vi.fn((cap: number) => {
      enabledCaps.set(cap, true);
    }),
    disable: vi.fn((cap: number) => {
      enabledCaps.set(cap, false);
    }),
    isEnabled: vi.fn((cap: number) => enabledCaps.get(cap) ?? false),
    blendFunc: vi.fn(),
    useProgram: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    disableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    uniformMatrix4fv: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    // The DataFilter kernel uploads its vec2 range/soft-range payloads as
    // `uniform2fv` (Float32Array in, no unpacking) — every layer's filter path
    // needs this recorder. Values are snapshotted into `vec2Uploads`; see there.
    uniform2fv: vi.fn((location: unknown, value: ArrayLike<number>) => {
      vec2Uploads.push({ location, value: Array.from(value) });
    }),
    uniform4fv: vi.fn(),

    createBuffer: vi.fn(() => makeHandle('buffer')),
    createShader: vi.fn((_type: number) => makeHandle('shader')),
    createProgram: vi.fn(() => makeHandle('program')),
    createVertexArray: vi.fn(() => makeHandle('vao')),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    deleteShader: vi.fn(),
    deleteProgram: vi.fn(),
    deleteBuffer: vi.fn(),
    deleteVertexArray: vi.fn(),
    bindVertexArray: vi.fn((vao: unknown) => {
      boundVao = vao ?? null;
    }),

    getShaderParameter: vi.fn(() => true),
    getProgramParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    getProgramInfoLog: vi.fn(() => ''),
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn(() => makeHandle('uniform')),

    getExtension: vi.fn((name: string) => {
      if (name === 'OES_element_index_uint' && opts.supports32Bit) {
        return makeHandle('extension');
      }
      if (
        (name === 'EXT_color_buffer_half_float' ||
          name === 'EXT_color_buffer_float') &&
        opts.supportsHalfFloatColorBuffer
      ) {
        return makeHandle('extension');
      }
      // Paired texture extension required on the WebGL1 path. The mock isn't
      // a real `WebGL2RenderingContext`, so the layer takes the WebGL1 branch
      // even though it has `createVertexArray` from the WebGL2-style mock.
      if (
        name === 'OES_texture_half_float' &&
        opts.supportsHalfFloatColorBuffer
      ) {
        return { HALF_FLOAT_OES: 0x8d61 };
      }
      if (name === 'OES_vertex_array_object' && opts.supportsVaoExtension) {
        return {
          createVertexArrayOES: vi.fn(() => makeHandle('vao')),
          bindVertexArrayOES: vi.fn((vao: unknown) => {
            boundVao = vao ?? null;
          }),
          deleteVertexArrayOES: vi.fn(),
        };
      }
      return null;
    }),

    drawArrays: vi.fn((_mode: number, _first: number, count: number) => {
      drawCalls.push({ kind: 'arrays', count });
    }),
    drawElements: vi.fn(
      (_mode: number, count: number, _type: number, _offset: number) => {
        drawCalls.push({ kind: 'elements', count });
      },
    ),
    // Instanced draws. Track them separately so tests can distinguish "ran
    // the new instanced path" from "ran the old expanded-quad path". The
    // `count` we record for instanced is `vertCount * instanceCount` — same
    // semantics as the legacy drawElements path so existing assertions still
    // resolve sensibly (e.g. 18 = 3 segments × 6 indices, now 3 instances × 6
    // quad indices).
    drawArraysInstanced: vi.fn(
      (_mode: number, _first: number, count: number, primCount: number) => {
        drawCalls.push({
          kind: 'arrays-instanced',
          count: count * primCount,
          vertices: count,
          instances: primCount,
        });
      },
    ),
    drawElementsInstanced: vi.fn(
      (
        _mode: number,
        count: number,
        _type: number,
        _offset: number,
        primCount: number,
      ) => {
        drawCalls.push({
          kind: 'elements-instanced',
          count: count * primCount,
          vertices: count,
          instances: primCount,
        });
      },
    ),
    vertexAttribDivisor: vi.fn(),

    // FBO / texture surface (used by the heatmap layer's two-pass pipeline).
    createTexture: vi.fn(() => makeHandle('texture')),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    activeTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    createFramebuffer: vi.fn(() => makeHandle('framebuffer')),
    deleteFramebuffer: vi.fn(),
    bindFramebuffer: vi.fn((_target: number, fbo: unknown) => {
      boundFramebuffer = fbo ?? null;
    }),
    framebufferTexture2D: vi.fn(),
    checkFramebufferStatus: vi.fn(() => 0x8cd5),
    viewport: vi.fn((x: number, y: number, w: number, h: number) => {
      currentViewport = new Int32Array([x, y, w, h]);
    }),
    getParameter: vi.fn((pname: number) => {
      if (pname === constants.FRAMEBUFFER_BINDING) return boundFramebuffer;
      // Fresh copy, matching real-GL semantics (callers can't mutate ours).
      if (pname === constants.VIEWPORT) return new Int32Array(currentViewport);
      if (pname === constants.COLOR_CLEAR_VALUE) {
        return new Float32Array(clearColorValue);
      }
      if (pname === constants.VERTEX_ARRAY_BINDING) return boundVao;
      return null;
    }),
    clear: vi.fn(),
    clearColor: vi.fn((r: number, g: number, b: number, a: number) => {
      clearColorValue = new Float32Array([r, g, b, a]);
    }),
    uniform1i: vi.fn(),
    uniform3fv: vi.fn(),

    // Single-pixel readback for the id-buffer picker. Real GL fills `out` from
    // the bound framebuffer; the mock instead copies whatever `_readPixelsValue`
    // the test staged, so the picker's decode/join can be exercised without a
    // GPU. Defaults to the cleared "no hit" pixel (all zero).
    _readPixelsValue: new Uint8Array([0, 0, 0, 0]),
    readPixels: vi.fn(
      (
        _x: number,
        _y: number,
        _w: number,
        _h: number,
        _format: number,
        _type: number,
        out: Uint8Array,
      ) => {
        out.set(gl._readPixelsValue.subarray(0, out.length));
      },
    ),
  };

  return gl;
}

/** Minimal MapLibre Map shape — only the methods the layer touches. */
export function makeMockMap(
  bounds = {
    west: -180,
    south: -85,
    east: 180,
    north: 85,
  },
): any {
  return {
    triggerRepaint: vi.fn(),
    getZoom: vi.fn(() => 2),
    getBounds: vi.fn(() => ({
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    })),
  };
}
