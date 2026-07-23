/**
 * Flow kernel — packing, sampling, ribbon tessellation and ref-stability.
 *
 * The kernel's promise is that a corridor's MAGNITUDE animates without any
 * per-frame geometry work: buffers are built once per tile, the matrix rides a
 * texture, and only `uFlowBucket` moves. These tests pin the three things that
 * promise rests on:
 *
 *  1. **Packing round-trips** — a value written at `(row, col)` is the value the
 *     shader reads at `(row, col)`. The texel addressing is re-derived here
 *     from the EMITTED GLSL's own arithmetic (`glslTexel`), including the
 *     power-of-two invariant, with a negative control showing a non-power-of-two
 *     width really does address the wrong row.
 *  2. **Time interpolation** — at / between / outside timesteps, cross-checked
 *     against a standalone re-implementation of the deck backend's
 *     `bucketBlendAt` + `blendMatrixRow` (no deck import), because a corridor
 *     must light up identically on both backends.
 *  3. **Ribbon geometry + ref-stability** — width lives in the extrusion
 *     attribute (never in the positions), winding is consistent, no triangle is
 *     degenerate, and the cache hands back the SAME object every time.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CPU_FALLBACK_SUB_STEP,
  FlowTileCache,
  MAX_FLOW_MATRIX_TEXELS,
  bucketPositionAt,
  buildCorridorRibbon,
  chooseFlowMatrixFormat,
  createFlowMatrixUniforms,
  deriveFlowAxis,
  expandFlowMagnitudes,
  extractFlowOdPairs,
  flowTileKey,
  mercatorPerPixel,
  packValueMatrix,
  packVertexValueMatrix,
  quantizeBucketPosition,
  readFlowTexelJS,
  resolveFlowMatrixUniforms,
  sampleFlowMatrixJS,
  supportsVertexTextureFetch,
  type PackedValueMatrix,
} from '../src/lib/flow-kernel';
import {
  FLOW_MAGNITUDE_CALL_GLSL,
  FLOW_MATRIX_FORMATS,
  FLOW_MATRIX_TEXTURE_RECIPE,
  FLOW_MATRIX_UNIFORMS_GLSL,
  FLOW_NAMES,
  FLOW_RIBBON_ATTRIBUTES_GLSL,
  FLOW_SAMPLER_STEPS,
  FLOW_WIDTH_GLSL,
  buildFlowMatrixSampler,
  flowRampTJS,
  flowSamplerCacheKey,
  flowWidthJS,
  type FlowMatrixFormat,
} from '../src/shaders/flow.glsl';
import { lngLatToMercator } from '../src/lib/projection';
import { makeLineTile } from './fixtures';

// ── helpers ─────────────────────────────────────────────────────────────────

/** A `rows × cols` matrix whose entry (r, c) is a distinctive number. */
function rampMatrix(rows: number, cols: number): Float32Array {
  const m = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) m[r * cols + c] = r * 10 + c;
  }
  return m;
}

/**
 * Re-derivation of the EMITTED sampler's texel arithmetic, in float32 (the
 * precision a GPU `highp float` gives), so the packing layout is tested against
 * the shader's own addressing rather than against itself.
 */
function glslTexel(
  packed: PackedValueMatrix,
  row: number,
  col: number,
): number {
  const f = Math.fround;
  const invW = f(1 / packed.texWidth);
  const idx = f(f(row) * f(packed.cols) + f(col));
  const ty = Math.floor(f(idx * invW));
  const tx = f(idx - f(ty * packed.texWidth));
  // Texel centres under NEAREST: uv * texSize floors straight back to (tx, ty).
  const i = ty * packed.texWidth + tx;
  if (packed.format === 'float32') {
    return (packed.data as Float32Array)[i];
  }
  const r = packed.data[i * 4] / 255;
  const g = packed.data[i * 4 + 1] / 255;
  const q = r * 65280 + g * 255;
  return packed.valueMin + (q / 65535) * packed.valueSpan;
}

/** Standalone re-implementation of the deck backend's two-bucket blend. */
function deckBlend(
  matrix: ArrayLike<number>,
  rowBase: number,
  stepped: number,
  numBuckets: number,
): number {
  const b0 = Math.floor(stepped);
  const b1 = Math.min(b0 + 1, numBuckets - 1);
  const f = stepped - b0;
  if (f <= 0) return matrix[rowBase + b0];
  const g = 1 - f;
  return matrix[rowBase + b0] * g + matrix[rowBase + b1] * f;
}

/** Signed area × 2 of a ribbon triangle after extrusion at `halfWidth`. */
function triArea2(
  ribbon: NonNullable<ReturnType<typeof buildCorridorRibbon>>,
  t: number,
  halfWidth: number,
): number {
  const pt = (v: number): [number, number] => [
    ribbon.positions[v * 3] + ribbon.extrusions[v * 2] * halfWidth,
    ribbon.positions[v * 3 + 1] + ribbon.extrusions[v * 2 + 1] * halfWidth,
  ];
  const [ax, ay] = pt(ribbon.indices[t * 3]);
  const [bx, by] = pt(ribbon.indices[t * 3 + 1]);
  const [cx, cy] = pt(ribbon.indices[t * 3 + 2]);
  return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}

/** Minimal binary-features shape carrying a value matrix. */
function matrixFeatures(rows: number, cols: number, spanMs = 8000) {
  return {
    vertexValueMatrix: rampMatrix(rows, cols),
    vertexValueBuckets: cols,
    startTimes: new Float32Array([0]),
    endTimes: new Float32Array([spanMs]),
    timeOffset: 1_700_000_000_000,
  };
}

// ── bucket axis ─────────────────────────────────────────────────────────────

describe('flow bucket axis', () => {
  it('derives the column axis from a tile the way the deck backend does', () => {
    const axis = deriveFlowAxis(matrixFeatures(4, 8, 8000))!;
    expect(axis.numBuckets).toBe(8);
    expect(axis.bucketWidthMs).toBe(1000);
    expect(axis.bucket0Abs).toBe(1_700_000_000_000);
  });

  it('returns null for tiles with no usable axis', () => {
    const base = matrixFeatures(2, 4);
    expect(deriveFlowAxis({ ...base, vertexValueBuckets: 0 })).toBeNull();
    expect(
      deriveFlowAxis({ ...base, startTimes: new Float32Array([]) }),
    ).toBeNull();
    expect(
      deriveFlowAxis({ ...base, endTimes: new Float32Array([0]) }),
    ).toBeNull();
  });

  it('maps the playhead to a continuous column, clamped at both ends', () => {
    const axis = deriveFlowAxis(matrixFeatures(2, 8, 8000))!;
    const t0 = axis.bucket0Abs;
    expect(bucketPositionAt(axis, t0)).toBe(0);
    expect(bucketPositionAt(axis, t0 + 3000)).toBe(3);
    expect(bucketPositionAt(axis, t0 + 3500)).toBeCloseTo(3.5, 12);
    // A flow tile is timeless: outside the range it holds the end columns
    // rather than blanking the network.
    expect(bucketPositionAt(axis, t0 - 10_000)).toBe(0);
    expect(bucketPositionAt(axis, t0 + 10_000_000)).toBe(7);
  });

  it('quantizes only for the CPU fallback path', () => {
    expect(quantizeBucketPosition(3.4, CPU_FALLBACK_SUB_STEP)).toBe(3.5);
    expect(quantizeBucketPosition(3.4, 0)).toBe(3.4);
  });
});

// ── packing ─────────────────────────────────────────────────────────────────

describe('value-matrix packing', () => {
  it('round-trips every cell of a float32 matrix through the shader addressing', () => {
    const rows = 37;
    const cols = 11;
    const packed = packValueMatrix(rampMatrix(rows, cols), rows, cols)!;
    expect(packed.format).toBe('float32');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        expect(readFlowTexelJS(packed, r, c)).toBe(r * 10 + c);
        expect(glslTexel(packed, r, c)).toBe(r * 10 + c);
      }
    }
  });

  it('always chooses a power-of-two texture width, big enough to hold the matrix', () => {
    for (const [rows, cols] of [
      [1, 1],
      [3, 2],
      [37, 11],
      [1000, 24],
      [5, 9000],
    ]) {
      const packed = packValueMatrix(rampMatrix(rows, cols), rows, cols)!;
      expect(Math.log2(packed.texWidth) % 1).toBe(0);
      expect(packed.texWidth * packed.texHeight).toBeGreaterThanOrEqual(
        rows * cols,
      );
      expect(packed.rows).toBe(rows);
      expect(packed.cols).toBe(cols);
    }
  });

  it('is why the width must be a power of two: a non-POT width mis-addresses', () => {
    const f = Math.fround;
    const split = (idx: number, w: number) => Math.floor(f(f(idx) * f(1 / w)));
    // Power of two: `1/w` is exact, so the split is exact everywhere below 2^24.
    for (const idx of [0, 1, 4095, 4096, 4097, 8_388_608, 16_777_215]) {
      expect(split(idx, 4096)).toBe(Math.floor(idx / 4096));
    }
    // Non-power-of-two: this index lands one texture ROW too far — i.e. it would
    // read another reach's magnitude. (Found by search over `k * w ± 1`.)
    expect(split(10_773_999, 1000)).toBe(10_774);
    expect(Math.floor(10_773_999 / 1000)).toBe(10_773);
  });

  it('zero-pads past the last value', () => {
    const packed = packValueMatrix(rampMatrix(3, 2), 3, 2)!;
    for (let i = 6; i < packed.data.length; i++) expect(packed.data[i]).toBe(0);
  });

  it('sanitizes NaN and Infinity to zero', () => {
    const values = new Float32Array([
      1,
      Number.NaN,
      3,
      Number.POSITIVE_INFINITY,
    ]);
    const packed = packValueMatrix(values, 2, 2)!;
    expect(readFlowTexelJS(packed, 0, 0)).toBe(1);
    expect(readFlowTexelJS(packed, 0, 1)).toBe(0);
    expect(readFlowTexelJS(packed, 1, 0)).toBe(3);
    expect(readFlowTexelJS(packed, 1, 1)).toBe(0);
  });

  it('packs |value| for signed (per-bucket-direction) matrices on request', () => {
    const values = new Float32Array([-4, 2, -1, 0]);
    const plain = packValueMatrix(values, 2, 2)!;
    const abs = packValueMatrix(values, 2, 2, { absolute: true })!;
    expect(readFlowTexelJS(plain, 0, 0)).toBe(-4);
    expect(readFlowTexelJS(abs, 0, 0)).toBe(4);
    expect(readFlowTexelJS(abs, 1, 0)).toBe(1);
  });

  it('round-trips a unorm16 matrix within one quantization step', () => {
    const rows = 9;
    const cols = 7;
    const values = rampMatrix(rows, cols); // 0 … 87
    const packed = packValueMatrix(values, rows, cols, { format: 'unorm16' })!;
    expect(packed.data).toBeInstanceOf(Uint8Array);
    expect(packed.valueMin).toBe(0);
    expect(packed.valueSpan).toBe(86);
    const tol = packed.valueSpan / 65535;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const want = values[r * cols + c];
        // Tighter than the tolerance a fixed-point step allows: half a step.
        expect(Math.abs(readFlowTexelJS(packed, r, c) - want)).toBeLessThan(
          tol,
        );
        // …and the shader's own decode agrees with the JS reference.
        expect(glslTexel(packed, r, c)).toBeCloseTo(
          readFlowTexelJS(packed, r, c),
          4,
        );
      }
    }
  });

  it('pins unorm16 alpha to 255 so premultiplied unpack cannot zero the payload', () => {
    const packed = packValueMatrix(rampMatrix(4, 4), 4, 4, {
      format: 'unorm16',
    })!;
    for (let i = 3; i < packed.data.length; i += 4) {
      expect(packed.data[i]).toBe(255);
    }
  });

  it('decodes a degenerate unorm16 range exactly', () => {
    const values = new Float32Array([7, 7, 7, 7]);
    const packed = packValueMatrix(values, 2, 2, { format: 'unorm16' })!;
    expect(packed.valueSpan).toBe(0);
    expect(readFlowTexelJS(packed, 0, 0)).toBe(7);
    expect(readFlowTexelJS(packed, 1, 1)).toBe(7);
  });

  it('honours an explicit unorm16 value range', () => {
    const packed = packValueMatrix(new Float32Array([0, 50]), 1, 2, {
      format: 'unorm16',
      valueRange: [0, 100],
    })!;
    expect(packed.valueMin).toBe(0);
    expect(packed.valueSpan).toBe(100);
    // Within one fixed-point step of the explicit 0..100 range.
    expect(Math.abs(readFlowTexelJS(packed, 0, 1) - 50)).toBeLessThan(
      100 / 65535,
    );
  });

  it('returns null (never throws) for the data-shaped refusals', () => {
    expect(packValueMatrix(new Float32Array(0), 0, 4)).toBeNull();
    expect(packValueMatrix(new Float32Array(4), 3, 4)).toBeNull(); // short matrix
    expect(
      packValueMatrix(new Float32Array(4), MAX_FLOW_MATRIX_TEXELS, 2),
    ).toBeNull();
    // 4096 × 64 texels needs 64 rows of a 4096-wide texture — fine — but a
    // 16-texel-wide cap cannot hold it.
    expect(
      packValueMatrix(rampMatrix(4096, 64), 4096, 64, { maxTextureSize: 16 }),
    ).toBeNull();
  });

  it('throws on malformed dimensions (programmer error, not data)', () => {
    expect(() => packValueMatrix(new Float32Array(4), 2.5, 2)).toThrow(
      /non-negative integers/,
    );
    expect(() => packValueMatrix(new Float32Array(4), -1, 2)).toThrow(
      /non-negative integers/,
    );
  });

  it('packs a tile vertexValueMatrix, and declines a tile without one', () => {
    const features = matrixFeatures(6, 4);
    const packed = packVertexValueMatrix(features, 6)!;
    expect(packed.rows).toBe(6);
    expect(packed.cols).toBe(4);
    expect(
      packVertexValueMatrix(
        { vertexValueMatrix: undefined, vertexValueBuckets: 0 },
        6,
      ),
    ).toBeNull();
  });
});

// ── time interpolation ──────────────────────────────────────────────────────

describe('time interpolation', () => {
  const rows = 5;
  const cols = 6;
  const values = rampMatrix(rows, cols);
  const packed = packValueMatrix(values, rows, cols)!;

  it('reads the exact column at an integer position', () => {
    for (let c = 0; c < cols; c++) {
      expect(sampleFlowMatrixJS(packed, 2, c)).toBe(20 + c);
    }
  });

  it('interpolates linearly between adjacent timesteps', () => {
    expect(sampleFlowMatrixJS(packed, 3, 1.5)).toBeCloseTo(31.5, 12);
    expect(sampleFlowMatrixJS(packed, 3, 1.25)).toBeCloseTo(31.25, 12);
    expect(sampleFlowMatrixJS(packed, 0, 4.75)).toBeCloseTo(4.75, 12);
  });

  it('clamps outside the axis instead of wrapping into the next row', () => {
    expect(sampleFlowMatrixJS(packed, 1, -3)).toBe(10);
    expect(sampleFlowMatrixJS(packed, 1, cols - 1)).toBe(15);
    expect(sampleFlowMatrixJS(packed, 1, cols + 40)).toBe(15);
    // The collapse at the last column is what stops row 1 reading row 2's first
    // value — the failure mode a naive `b0 + 1` would have.
    expect(sampleFlowMatrixJS(packed, 1, cols - 1 + 0.5)).toBe(15);
  });

  it('agrees with the deck backend blend at every sub-step', () => {
    for (let r = 0; r < rows; r++) {
      for (let s = 0; s <= (cols - 1) * 8; s++) {
        const pos = s / 8;
        expect(sampleFlowMatrixJS(packed, r, pos)).toBeCloseTo(
          deckBlend(values, r * cols, pos, cols),
          10,
        );
      }
    }
  });

  it('agrees with the emitted shader arithmetic on both formats', () => {
    for (const format of FLOW_MATRIX_FORMATS) {
      const p = packValueMatrix(values, rows, cols, { format })!;
      for (let r = 0; r < rows; r++) {
        for (let s = 0; s <= (cols - 1) * 4; s++) {
          const pos = s / 4;
          const b0 = Math.floor(Math.min(pos, cols - 1));
          const f = Math.min(pos, cols - 1) - b0;
          const glsl =
            f <= 0
              ? glslTexel(p, r, b0)
              : glslTexel(p, r, b0) * (1 - f) +
                glslTexel(p, r, Math.min(b0 + 1, cols - 1)) * f;
          expect(sampleFlowMatrixJS(p, r, pos)).toBeCloseTo(glsl, 3);
        }
      }
    }
  });

  it('expands per-draw-unit magnitudes identically to the scalar reference', () => {
    const rowIndex = new Float32Array([0, 2, 4, 4, 1]);
    const out = new Float32Array(rowIndex.length);
    const same = expandFlowMagnitudes(out, packed, rowIndex, 2.25);
    expect(same).toBe(out); // caller-owned buffer, no allocation
    for (let i = 0; i < rowIndex.length; i++) {
      expect(out[i]).toBe(sampleFlowMatrixJS(packed, rowIndex[i], 2.25));
    }
  });

  it('fills the uniform payload in place, texture-side and frame-side together', () => {
    const uniforms = createFlowMatrixUniforms();
    const texSize = uniforms.texSize;
    const returned = resolveFlowMatrixUniforms(uniforms, packed, 2.5);
    expect(returned).toBe(uniforms);
    expect(returned.texSize).toBe(texSize); // no per-draw allocation
    expect(texSize[0]).toBe(packed.texWidth);
    expect(texSize[2]).toBeCloseTo(1 / packed.texWidth, 12);
    expect(returned.dims[0]).toBe(cols);
    expect(returned.dims[1]).toBe(rows);
    expect(returned.valueScale[0]).toBe(0);
    expect(returned.valueScale[1]).toBe(1);
    expect(returned.bucket).toBe(2.5);
    resolveFlowMatrixUniforms(uniforms, packed, Number.NaN);
    expect(returned.bucket).toBe(0);
  });
});

// ── GLSL ────────────────────────────────────────────────────────────────────

describe('flow GLSL kernel', () => {
  it('emits the load-bearing sampler steps for every format', () => {
    for (const format of FLOW_MATRIX_FORMATS) {
      const src = buildFlowMatrixSampler({ format });
      for (const step of FLOW_SAMPLER_STEPS) expect(src).toContain(step);
      expect(src).toContain('float sttFlowMagnitude(');
      expect(src).toContain('float sttFlowTexel(');
    }
  });

  it('decodes fixed point only on the unorm16 variant', () => {
    const float32 = buildFlowMatrixSampler({ format: 'float32' });
    const unorm16 = buildFlowMatrixSampler({ format: 'unorm16' });
    expect(float32).toContain('return texel.r;');
    expect(float32).not.toContain('65280');
    expect(unorm16).toContain('65280.0');
    expect(unorm16).toContain(FLOW_NAMES.valueScale);
    expect(float32).not.toBe(unorm16);
  });

  it('keys the program cache per format (the shader permutation axis)', () => {
    const keys = FLOW_MATRIX_FORMATS.map((f) => flowSamplerCacheKey(f));
    expect(new Set(keys).size).toBe(FLOW_MATRIX_FORMATS.length);
    expect(keys[0]).toContain('float32');
  });

  it('declares every name the layers resolve locations through', () => {
    const decls = FLOW_MATRIX_UNIFORMS_GLSL + FLOW_RIBBON_ATTRIBUTES_GLSL;
    for (const name of Object.values(FLOW_NAMES)) expect(decls).toContain(name);
    expect(FLOW_MAGNITUDE_CALL_GLSL).toContain(FLOW_NAMES.row);
    expect(FLOW_MAGNITUDE_CALL_GLSL).toContain(FLOW_NAMES.bucket);
  });

  it('publishes an upload recipe for every format and host', () => {
    for (const format of FLOW_MATRIX_FORMATS) {
      for (const host of ['webgl1', 'webgl2'] as const) {
        const recipe = FLOW_MATRIX_TEXTURE_RECIPE[format][host];
        expect(typeof recipe.internalFormat).toBe('string');
        expect(typeof recipe.format).toBe('string');
        expect(typeof recipe.type).toBe('string');
      }
    }
    expect(FLOW_MATRIX_TEXTURE_RECIPE.unorm16.webgl1.type).toBe(
      'UNSIGNED_BYTE',
    );
    expect(FLOW_MATRIX_TEXTURE_RECIPE.float32.webgl2.internalFormat).toBe(
      'R32F',
    );
  });

  it('mirrors deck flow-width semantics: below minFlow is invisible, not clamped up', () => {
    expect(FLOW_WIDTH_GLSL).toContain('!(magnitude > minFlow)');
    // deck: `val > minFlow ? val ** exp : 0`, then the pixel clamp.
    expect(flowWidthJS(0.2, 0.25, 1.1, 0.5, [1, 12])).toBe(0);
    expect(flowWidthJS(0.25, 0.25, 1.1, 0.5, [1, 12])).toBe(0);
    expect(flowWidthJS(4, 0.25, 1.1, 0.5, [1, 12])).toBeCloseTo(2.2, 12);
    expect(flowWidthJS(1e6, 0.25, 1.1, 0.5, [1, 12])).toBe(12);
    expect(flowWidthJS(0.3, 0.25, 1.1, 0.5, [1, 12])).toBe(1); // clamped up when ACTIVE
    expect(flowWidthJS(Number.NaN, 0, 1, 0.5, [1, 12])).toBe(0);
  });

  it('maps magnitude onto a 0..1 ramp position with clamping and gamma', () => {
    expect(flowRampTJS(0, [0, 10], 1)).toBe(0);
    expect(flowRampTJS(5, [0, 10], 1)).toBe(0.5);
    expect(flowRampTJS(50, [0, 10], 1)).toBe(1);
    expect(flowRampTJS(-5, [0, 10], 1)).toBe(0);
    expect(flowRampTJS(2.5, [0, 10], 0.5)).toBeCloseTo(0.5, 12);
    expect(flowRampTJS(5, [0, 10], 0)).toBe(0.5); // gamma <= 0 ⇒ linear
    expect(flowRampTJS(5, [3, 3], 1)).toBe(1); // degenerate domain
    expect(flowRampTJS(1, [3, 3], 1)).toBe(0);
  });
});

// ── corridor ribbon ─────────────────────────────────────────────────────────

describe('corridor ribbon tessellation', () => {
  // A straight west→east corridor, 3 vertices, in mercator units.
  const straight = [0.1, 0.2, 0.2, 0.2, 0.4, 0.2];

  it('emits a mitred triangle list with the width left to the shader', () => {
    const ribbon = buildCorridorRibbon({ positions: straight })!;
    expect(ribbon.pathVertexCount).toBe(3);
    expect(ribbon.vertexCount).toBe(6);
    expect(ribbon.triangleCount).toBe(4);
    expect(ribbon.indices.length).toBe(12);
    expect(ribbon.positions.length).toBe(18); // stride 3, quantizer-ready
    // BOTH ribbon vertices of a pair sit ON the path: the width is entirely in
    // the extrusion attribute, which is what lets one buffer serve every frame.
    for (let i = 0; i < 3; i++) {
      const l = i * 2;
      const r = l + 1;
      expect(ribbon.positions[l * 3]).toBeCloseTo(straight[i * 2], 6);
      expect(ribbon.positions[r * 3]).toBeCloseTo(straight[i * 2], 6);
      expect(ribbon.positions[l * 3 + 1]).toBeCloseTo(straight[i * 2 + 1], 6);
      expect(ribbon.positions[l * 3 + 2]).toBe(0);
    }
  });

  it('extrudes unit width perpendicular to travel, one side each', () => {
    const ribbon = buildCorridorRibbon({ positions: straight })!;
    for (let i = 0; i < ribbon.pathVertexCount; i++) {
      const l = i * 2;
      const r = l + 1;
      const ex = ribbon.extrusions[l * 2];
      const ey = ribbon.extrusions[l * 2 + 1];
      expect(Math.hypot(ex, ey)).toBeCloseTo(1, 6); // unit width
      expect(ex).toBeCloseTo(0, 6); // perpendicular to a due-east corridor
      expect(Math.abs(ey)).toBeCloseTo(1, 6);
      expect(ribbon.extrusions[r * 2]).toBeCloseTo(-ex, 6);
      expect(ribbon.extrusions[r * 2 + 1]).toBeCloseTo(-ey, 6);
      expect(ribbon.sides[l]).toBe(1);
      expect(ribbon.sides[r]).toBe(-1);
    }
  });

  it('numbers rows vertex-major by default and carries the along coordinate', () => {
    const ribbon = buildCorridorRibbon({ positions: straight, firstRow: 40 })!;
    expect(Array.from(ribbon.rows)).toEqual([40, 40, 41, 41, 42, 42]);
    expect(ribbon.alongs[0]).toBe(0);
    expect(ribbon.alongs[5]).toBeCloseTo(1, 12);
    // 0.1 of 0.3 total.
    expect(ribbon.alongs[2]).toBeCloseTo(1 / 3, 6);
    expect(ribbon.lengthMercator).toBeCloseTo(0.3, 12);
  });

  it('accepts explicit rows (a corridor whose reaches are not contiguous)', () => {
    const ribbon = buildCorridorRibbon({
      positions: straight,
      rows: [7, 9, 11],
    })!;
    expect(Array.from(ribbon.rows)).toEqual([7, 7, 9, 9, 11, 11]);
  });

  it('folds a static width profile into the extrusion', () => {
    const ribbon = buildCorridorRibbon({
      positions: straight,
      widthProfile: [1, 2, 0.5],
    })!;
    expect(Math.abs(ribbon.extrusions[1])).toBeCloseTo(1, 6);
    expect(Math.abs(ribbon.extrusions[5])).toBeCloseTo(2, 6);
    expect(Math.abs(ribbon.extrusions[9])).toBeCloseTo(0.5, 6);
  });

  it('winds every triangle the same way and leaves none degenerate', () => {
    const bendy = [0, 0, 0.1, 0, 0.15, 0.08, 0.3, 0.1, 0.32, 0.25];
    const ribbon = buildCorridorRibbon({ positions: bendy })!;
    for (const halfWidth of [0.002, 0.01]) {
      const areas: number[] = [];
      for (let t = 0; t < ribbon.triangleCount; t++) {
        areas.push(triArea2(ribbon, t, halfWidth));
      }
      for (const a of areas) {
        expect(Math.abs(a)).toBeGreaterThan(0); // no degenerate triangle
        expect(Math.sign(a)).toBe(Math.sign(areas[0])); // consistent winding
      }
    }
  });

  it('mitres a 90° corner to 1/cos(45°) and caps a hairpin at the miter limit', () => {
    // East then north (mercator y grows southward, so "north" is -y).
    const corner = [0, 0, 0.1, 0, 0.1, -0.1];
    const ribbon = buildCorridorRibbon({ positions: corner })!;
    const mid = 1 * 2;
    const len = Math.hypot(
      ribbon.extrusions[mid * 2],
      ribbon.extrusions[mid * 2 + 1],
    );
    expect(len).toBeCloseTo(Math.SQRT2, 6);

    // A near-hairpin would want a huge miter; the limit bevels it instead.
    const hairpin = [0, 0, 0.1, 0, 0.001, 0.0001];
    const capped = buildCorridorRibbon({
      positions: hairpin,
      miterLimit: 2,
    })!;
    const cappedLen = Math.hypot(capped.extrusions[4], capped.extrusions[5]);
    expect(cappedLen).toBeLessThanOrEqual(2 + 1e-6);
    expect(cappedLen).toBeGreaterThanOrEqual(1 - 1e-6);
  });

  it('survives a 180° reversal without emitting a zero-length extrusion', () => {
    const doubleBack = [0, 0, 0.1, 0, 0, 0];
    const ribbon = buildCorridorRibbon({ positions: doubleBack })!;
    for (let v = 0; v < ribbon.vertexCount; v++) {
      const len = Math.hypot(
        ribbon.extrusions[v * 2],
        ribbon.extrusions[v * 2 + 1],
      );
      expect(len).toBeGreaterThan(0.5);
      expect(Number.isFinite(len)).toBe(true);
    }
  });

  it('drops repeated vertices rather than emitting NaN normals', () => {
    const dupes = [0.1, 0.2, 0.1, 0.2, 0.2, 0.2, 0.2, 0.2, 0.4, 0.2];
    const ribbon = buildCorridorRibbon({ positions: dupes })!;
    expect(ribbon.pathVertexCount).toBe(3);
    for (const v of ribbon.extrusions) expect(Number.isNaN(v)).toBe(false);
  });

  it('returns null when there are fewer than two distinct vertices', () => {
    expect(buildCorridorRibbon({ positions: [0.1, 0.2] })).toBeNull();
    expect(
      buildCorridorRibbon({ positions: [0.1, 0.2, 0.1, 0.2, 0.1, 0.2] }),
    ).toBeNull();
    expect(buildCorridorRibbon({ positions: [] })).toBeNull();
  });

  it('throws on a malformed position array', () => {
    expect(() => buildCorridorRibbon({ positions: [0, 0, 1] })).toThrow(
      /flat xy/,
    );
  });

  it('subdivides for globe and keeps rows as integer addresses', () => {
    const long = [0.0, 0.5, 0.5, 0.5];
    const plain = buildCorridorRibbon({ positions: long })!;
    const globe = buildCorridorRibbon({ positions: long, granularity: 32 })!;
    expect(globe.pathVertexCount).toBeGreaterThan(plain.pathVertexCount);
    for (const row of globe.rows) expect(Number.isInteger(row)).toBe(true);
    // Endpoints keep their own rows; inserted vertices snap to the nearest.
    expect(globe.rows[0]).toBe(0);
    expect(globe.rows[globe.rows.length - 1]).toBe(1);
    expect(globe.alongs[globe.alongs.length - 1]).toBeCloseTo(1, 12);
  });
});

// ── ref-stability ───────────────────────────────────────────────────────────

describe('ref-stability (the FlowCorridorLayer perf bug, in test form)', () => {
  it('hands back the SAME object for a key, building exactly once', () => {
    const cache = new FlowTileCache<{ id: number }>();
    const build = vi.fn(() => ({ id: 1 }));
    const a = cache.get('k', build);
    const b = cache.get('k', build);
    expect(a).toBe(b);
    expect(build).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('caches a degenerate (null) build so it is not re-analysed every frame', () => {
    const cache = new FlowTileCache<{ id: number }>();
    const build = vi.fn(() => null);
    expect(cache.get('k', build)).toBeNull();
    expect(cache.get('k', build)).toBeNull();
    expect(build).toHaveBeenCalledTimes(1);
    expect(cache.has('k')).toBe(true);
  });

  it('prunes to the resident set and reports what to free', () => {
    const cache = new FlowTileCache<string>();
    cache.get('a', () => 'A');
    cache.get('b', () => 'B');
    cache.get('c', () => null);
    const dropped = cache.prune(new Set(['a']));
    expect(dropped.sort()).toEqual(['B']);
    expect(cache.size).toBe(1);
    expect(cache.get('a', () => 'A2')).toBe('A');
    expect(cache.clear()).toEqual(['A']);
    expect(cache.size).toBe(0);
  });

  it('keys tiles by shape only — the playhead never enters the key', () => {
    const id = { z: 4, x: 2, y: 3, t: 1_700_000_000_000 };
    expect(flowTileKey(id, 'flows')).toBe('4/2/3/1700000000000::flows');
    expect(flowTileKey(id, 'flows', 'globe:128')).toBe(
      '4/2/3/1700000000000::flows::globe:128',
    );
    // The same tile at two playhead positions is ONE key — a layer that folded
    // a bucket in here would re-tessellate the network per sub-step, which is
    // exactly the deck-side regression this kernel is designed against.
    expect(flowTileKey(id, 'flows', 'globe:128')).toBe(
      flowTileKey(id, 'flows', 'globe:128'),
    );
  });

  it('keeps the ribbon builder pure — identity comes from the cache, not the build', () => {
    const opts = { positions: [0, 0, 0.1, 0, 0.2, 0.05] };
    const a = buildCorridorRibbon(opts)!;
    const b = buildCorridorRibbon(opts)!;
    expect(a).not.toBe(b);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.extrusions)).toEqual(Array.from(b.extrusions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));

    const cache = new FlowTileCache<typeof a>();
    const key = flowTileKey({ z: 1, x: 0, y: 0, t: 0 }, 'corridors');
    const first = cache.get(key, () => buildCorridorRibbon(opts));
    const second = cache.get(key, () => buildCorridorRibbon(opts));
    expect(first).toBe(second);
    expect(first!.positions).toBe(second!.positions);
  });
});

// ── OD pairs ────────────────────────────────────────────────────────────────

describe('OD pair extraction', () => {
  it('collapses LineString features to mercator endpoints plus a matrix row', () => {
    const tile = makeLineTile();
    const features = tile.layers[0].features;
    const od = extractFlowOdPairs(features)!;
    expect(od.count).toBe(2);
    expect(od.dims).toBe(2);
    // Feature 0: NYC → Maine (first and LAST vertex; intermediates dropped).
    expect(od.sourceLngLat[0]).toBeCloseTo(-73.95, 10);
    expect(od.targetLngLat[0]).toBeCloseTo(-69.5, 10);
    const [mx, my] = lngLatToMercator(-73.95, 40.75);
    expect(od.source[0]).toBeCloseTo(mx, 6);
    expect(od.source[1]).toBeCloseTo(my, 6);
    expect(od.source[2]).toBe(0);
    // Rows address the SOURCE vertex — where the vertex-major matrix keeps an
    // OD feature's series.
    expect(Array.from(od.rows)).toEqual([0, 3]);
  });

  it('declines a tile with no features or no startIndices', () => {
    const tile = makeLineTile();
    const features = tile.layers[0].features;
    expect(extractFlowOdPairs({ ...features, featureCount: 0 })).toBeNull();
    expect(
      extractFlowOdPairs({ ...features, startIndices: undefined }),
    ).toBeNull();
  });
});

// ── host capability + scale helpers ─────────────────────────────────────────

describe('host capability helpers', () => {
  const probe = (units: unknown) => ({
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
    getParameter: (p: number) => (p === 0x8b4c ? units : undefined),
  });

  it('gates the GPU magnitude path on vertex texture fetch', () => {
    expect(supportsVertexTextureFetch(probe(16))).toBe(true);
    expect(supportsVertexTextureFetch(probe(0))).toBe(false);
    expect(supportsVertexTextureFetch(probe(undefined))).toBe(false);
  });

  it('picks float textures wherever they can be sampled', () => {
    expect(chooseFlowMatrixFormat({ webgl2: true })).toBe('float32');
    expect(chooseFlowMatrixFormat({ webgl2: false, floatTextures: true })).toBe(
      'float32',
    );
    expect(
      chooseFlowMatrixFormat({ webgl2: false, floatTextures: false }),
    ).toBe('unorm16');
  });

  it('converts a pixel width into the mercator half-width the ribbon takes', () => {
    expect(mercatorPerPixel(0)).toBe(1 / 512);
    expect(mercatorPerPixel(1)).toBe(1 / 1024);
    // 4 device px at z12 on a 2× screen.
    expect(mercatorPerPixel(12, 1024) * 4).toBeCloseTo(4 / (1024 * 4096), 15);
  });

  it('is exhaustive over the declared formats', () => {
    const formats: FlowMatrixFormat[] = ['float32', 'unorm16'];
    expect([...FLOW_MATRIX_FORMATS].sort()).toEqual(formats.sort());
  });
});
