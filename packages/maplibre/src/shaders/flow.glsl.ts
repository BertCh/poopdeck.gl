// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * The FLOW kernel's GLSL — origin→destination magnitude sampled on the GPU from
 * a packed **value matrix** (rows = reaches, cols = timesteps), plus the
 * magnitude→width and magnitude→ramp helpers the flow family shares.
 *
 * ── Why the matrix lives in a TEXTURE ───────────────────────────────────────
 * A flow tile stores its geometry ONCE and carries a per-reach × per-timestep
 * value matrix (`BinaryFeatures.vertexValueMatrix`). Only the playhead moves,
 * so only the SAMPLE POINT may move per frame — never the geometry.
 *
 * The deck backend's `FlowCorridorLayer` learned that the hard way: its
 * `styleKey` folded the quantized playhead in (`:fp{step}`), so crossing a
 * sub-step minted a new `data` object and deck re-tessellated the WHOLE street
 * network ~6 Hz (see `docs/roadmap` + the rivers/rain perf root-cause memory).
 * This kernel is the fix expressed as a contract:
 *
 *   - vertex buffers are built at TILE UPLOAD and never touched again;
 *   - the matrix is uploaded once per tile as a texture;
 *   - each frame the layer writes ONE uniform, `uFlowBucket` (a continuous
 *     timestep position), and the vertex shader does two `texture2D` fetches
 *     and a `mix` per vertex.
 *
 * There is no cross-fade quantization on this path — the GPU interpolates
 * between adjacent timesteps continuously, so the corridors breathe at frame
 * rate instead of stepping at ~5 Hz. (`BundledFlowLinesLayer` in the deck
 * package proves the same trick with `texelFetch`; GLSL ES 1.00 has no
 * `texelFetch`, hence the explicit texel-centre UV maths below.)
 *
 * ── Texture addressing (the load-bearing invariant) ─────────────────────────
 * The matrix is packed LINEARLY — texel `row * cols + col` — into a texture of
 * `texWidth × texHeight`, so a matrix wider or taller than `MAX_TEXTURE_SIZE`
 * still fits and one addressing path serves every shape. Splitting that linear
 * index back into `(tx, ty)` needs a division, and a float division that
 * rounds UP across an integer boundary would sample a texel from the wrong
 * row. **`texWidth` is therefore always a power of two**
 * (`packValueMatrix` enforces it): `1/texWidth` is then exact, `idx * (1/texWidth)`
 * is an exponent shift with no rounding at all, and `floor` is exact for every
 * `idx` below 2^24 (`MAX_FLOW_MATRIX_TEXELS`).
 *
 * ── Formats ────────────────────────────────────────────────────────────────
 * Two, because vertex-stage float-texture sampling is not universal:
 *
 *  | format      | texel                     | WebGL2                | WebGL1                      |
 *  | ----------- | ------------------------- | --------------------- | --------------------------- |
 *  | `float32`   | one float, read `.r`      | `R32F` / `RED` / `FLOAT` | `LUMINANCE` / `FLOAT` (+ `OES_texture_float`) |
 *  | `unorm16`   | 16-bit fixed point in r,g | `RGBA` / `UNSIGNED_BYTE` | same                        |
 *
 * `unorm16` decodes through `uFlowValueScale` = `[min, range]`; the `float32`
 * path leaves that uniform inert (`[0, 1]`). The format is a SHADER
 * PERMUTATION AXIS — a layer's program-cache key must carry
 * {@link flowSamplerCacheKey}, exactly like the time mode does.
 *
 * Filtering is NEAREST on both (a float texture is not linearly filterable
 * without `OES_texture_float_linear`, and we want exact texels anyway — the
 * interpolation between timesteps is done in the shader, where it is defined).
 *
 * Like `time-window.glsl.ts` and `data-filter.glsl.ts`, every formula here
 * ships with a JS reference impl in the same file so the two cannot drift; the
 * matrix-sampling reference needs the packing layout and therefore lives with
 * it in `lib/flow-kernel.ts` (`sampleFlowMatrixJS`).
 */

/**
 * How a packed value matrix is stored in its texture. See the module header's
 * format table. A shader permutation axis — see {@link flowSamplerCacheKey}.
 */
export type FlowMatrixFormat = 'float32' | 'unorm16';

/** Every {@link FlowMatrixFormat}, for exhaustive tests and pickers. */
export const FLOW_MATRIX_FORMATS: readonly FlowMatrixFormat[] = Object.freeze([
  'float32',
  'unorm16',
]);

/**
 * Attribute / uniform names the GLSL below declares. Layers resolve locations
 * through these constants so the kernel, the layers and the tests cannot drift
 * on a string.
 */
export const FLOW_NAMES = Object.freeze({
  /** `sampler2D` — the packed value matrix. */
  matrix: 'uFlowMatrix',
  /** `vec4` — `[texWidth, texHeight, 1/texWidth, 1/texHeight]`. */
  texSize: 'uFlowMatrixSize',
  /** `vec2` — `[cols (timesteps), rows (reaches)]`. */
  dims: 'uFlowMatrixDims',
  /** `vec2` — `[min, range]` fixed-point decode; `[0, 1]` on the float path. */
  valueScale: 'uFlowValueScale',
  /** `float` — continuous timestep position (THE per-frame uniform). */
  bucket: 'uFlowBucket',
  /** `float` attribute — this vertex's matrix row. */
  row: 'aFlowRow',
  /** `vec2` attribute — signed unit-width miter offset, mercator space. */
  extrusion: 'aFlowExtrusion',
  /** `float` attribute — `-1` / `+1`, which edge of the ribbon. */
  side: 'aFlowSide',
  /** `float` attribute — `0..1` position along the corridor. */
  along: 'aFlowAlong',
} as const);

/**
 * Texture-upload recipe per format and host, as GL enum NAMES (the kernel
 * itself stays GL-free, like `lib/projection.ts` and `lib/globe.ts`). A layer
 * does `gl[recipe.internalFormat]`, `gl[recipe.format]`, `gl[recipe.type]`.
 *
 * `float32` on a WebGL1 host additionally requires the `OES_texture_float`
 * extension; without it the layer must pack `unorm16` instead
 * (`chooseFlowMatrixFormat` in `lib/flow-kernel.ts` makes that call). Both
 * formats need `NEAREST` min/mag filtering and `CLAMP_TO_EDGE` wrapping.
 */
export const FLOW_MATRIX_TEXTURE_RECIPE = Object.freeze({
  float32: Object.freeze({
    webgl2: Object.freeze({
      internalFormat: 'R32F',
      format: 'RED',
      type: 'FLOAT',
      unpackAlignment: 4,
    }),
    webgl1: Object.freeze({
      internalFormat: 'LUMINANCE',
      format: 'LUMINANCE',
      type: 'FLOAT',
      unpackAlignment: 4,
    }),
  }),
  unorm16: Object.freeze({
    webgl2: Object.freeze({
      internalFormat: 'RGBA',
      format: 'RGBA',
      type: 'UNSIGNED_BYTE',
      unpackAlignment: 4,
    }),
    webgl1: Object.freeze({
      internalFormat: 'RGBA',
      format: 'RGBA',
      type: 'UNSIGNED_BYTE',
      unpackAlignment: 4,
    }),
  }),
} as const);

/**
 * Uniform declarations to splice into a layer's vertex source. All five are
 * declared together; a layer that ignores one never reads it, the compiler
 * strips it and `getUniformLocation` returns null (a no-op for the setter) —
 * the same tolerance the DataFilter kernel relies on.
 */
export const FLOW_MATRIX_UNIFORMS_GLSL = `
  uniform sampler2D uFlowMatrix;   // packed value matrix (lib/flow-kernel.ts)
  uniform vec4 uFlowMatrixSize;    // [texW, texH, 1/texW, 1/texH]; texW is a POWER OF TWO
  uniform vec2 uFlowMatrixDims;    // [cols (timesteps), rows (reaches)]
  uniform vec2 uFlowValueScale;    // [min, range] fixed-point decode; [0,1] on the float path
  uniform float uFlowBucket;       // continuous timestep position — THE per-frame uniform
`;

/**
 * Attribute declarations for the corridor-ribbon layout
 * (`buildCorridorRibbon` in `lib/flow-kernel.ts`). An OD layer that draws one
 * INSTANCE per pair declares `aFlowRow` per instance instead and skips the
 * rest.
 */
export const FLOW_RIBBON_ATTRIBUTES_GLSL = `
  attribute float aFlowRow;        // value-matrix row for this vertex
  attribute vec2 aFlowExtrusion;   // signed miter offset at UNIT width, mercator space
  attribute float aFlowSide;       // -1 / +1 — which edge of the ribbon (band AA)
  attribute float aFlowAlong;      // 0..1 distance along the corridor
`;

/** Canonical call expression, so every layer samples the same way. */
export const FLOW_MAGNITUDE_CALL_GLSL =
  'sttFlowMagnitude(aFlowRow, uFlowBucket)';

/**
 * The load-bearing operations of the emitted sampler, in order. Exported for a
 * structural seam gate (the `GLOBE_ELEVATION_STEPS` pattern): asserting these
 * survive is how a test says "this block still does the thing" without pinning
 * whole strings.
 */
export const FLOW_SAMPLER_STEPS: readonly string[] = Object.freeze([
  'uFlowMatrixDims.x',
  'floor(idx * uFlowMatrixSize.z)',
  'texture2D(uFlowMatrix',
  'floor(b)',
  'mix(v0, v1, f)',
]);

/** Options for {@link buildFlowMatrixSampler}. */
export interface FlowSamplerOptions {
  /** Storage format of the packed matrix — see the module header. */
  format: FlowMatrixFormat;
}

/**
 * Program-cache key fragment for a sampler variant. The emitted GLSL differs
 * per format, so a layer that can pack either MUST fold this into its
 * `getOrCreateProgram` key (the base class then appends `::variantName`).
 */
export function flowSamplerCacheKey(format: FlowMatrixFormat): string {
  return `flow-${format}`;
}

/**
 * Emit the value-matrix sampler: `sttFlowTexel(row, col)` (one exact texel)
 * and `sttFlowMagnitude(row, bucketPos)` (linear interpolation between the two
 * adjacent timesteps).
 *
 * Semantics, mirrored exactly by `sampleFlowMatrixJS` and by the deck
 * backend's `bucketBlendAt` + `blendMatrixRow`:
 *   - `bucketPos` is CLAMPED to `[0, cols - 1]`, so a playhead before the
 *     first timestep reads column 0 and one past the last reads column
 *     `cols - 1` — a flow tile spans the whole time range and must never blank;
 *   - the blend is `mix(v0, v1, f)` with `f = bucketPos - floor(bucketPos)`;
 *   - at the last column `b1` collapses onto `b0`, so the blend degenerates to
 *     a plain read rather than wrapping to row `row + 1`.
 *
 * Both fetches happen in the VERTEX stage. That needs vertex texture fetch,
 * which WebGL2 guarantees (≥16 units) but WebGL1 does not (the minimum is
 * ZERO) — `supportsVertexTextureFetch()` in `lib/flow-kernel.ts` is the gate,
 * and `expandFlowMagnitudes()` is the CPU fallback for hosts that fail it.
 */
export function buildFlowMatrixSampler(o: FlowSamplerOptions): string {
  // `.r` on both paths: LUMINANCE/FLOAT replicates L into rgb, R32F fills
  // (r, 0, 0, 1). The fixed-point path additionally reads `.g` as the low byte.
  const decode =
    o.format === 'float32'
      ? `  return texel.r;`
      : `  // 16-bit fixed point: r = high byte, g = low byte, both delivered as
  // byte/255. (65280 = 255 * 256, so this is exactly hi * 256 + lo.)
  float q = texel.r * 65280.0 + texel.g * 255.0;
  return uFlowValueScale.x + (q / 65535.0) * uFlowValueScale.y;`;

  return `
float sttFlowTexel(float row, float col) {
  float idx = row * uFlowMatrixDims.x + col;
  // texW is a POWER OF TWO, so 1/texW is exact and \`idx * (1/texW)\` is an
  // exponent shift — no rounding, so this split is exact for every idx below
  // 2^24. A non-power-of-two width would round UP across integer boundaries
  // and silently sample the wrong matrix row.
  float ty = floor(idx * uFlowMatrixSize.z);
  float tx = idx - ty * uFlowMatrixSize.x;
  // Texel CENTRES (+0.5) under NEAREST filtering: an exact fetch, and a
  // fractional row (a globe-subdivided vertex) resolves to its nearest row.
  vec4 texel = texture2D(uFlowMatrix, (vec2(tx, ty) + 0.5) * uFlowMatrixSize.zw);
${decode}
}

float sttFlowMagnitude(float row, float bucketPos) {
  float maxCol = uFlowMatrixDims.x - 1.0;
  float b = clamp(bucketPos, 0.0, maxCol);
  float b0 = floor(b);
  float f = b - b0;
  float v0 = sttFlowTexel(row, b0);
  if (f <= 0.0) return v0;
  float v1 = sttFlowTexel(row, min(b0 + 1.0, maxCol));
  return mix(v0, v1, f);
}
`;
}

/**
 * Magnitude → corridor width and magnitude → ramp position. Declares no
 * uniforms and no attributes, so a layer includes it once and calls it from
 * wherever it resolved its magnitude.
 *
 * `sttFlowWidth` is deck's flow-width formula verbatim
 * (`FlowStrokeLayer.widthsFor`, `FlowmapLayer.widthsFor`): a corridor at or
 * below `minFlow` collapses to width 0 — INVISIBLE, which is the animation —
 * and the pixel clamp applies to ACTIVE corridors only, so `widthClamp.x`
 * never resurrects a dead one. The test is written `!(magnitude > minFlow)`
 * rather than `magnitude <= minFlow` so a NaN magnitude collapses instead of
 * leaking through (the packer sanitizes NaN, but a layer may feed this from a
 * CPU path that does not).
 */
export const FLOW_WIDTH_GLSL = `
float sttFlowWidth(
  float magnitude,
  float minFlow,       // at or below ⇒ width 0 (invisible), no clamp applied
  float widthScale,
  float widthExponent, // 0.5 (√) is area-proportional, the cartographic default
  vec2 widthClamp      // [min, max], ACTIVE corridors only
) {
  if (!(magnitude > minFlow)) return 0.0;
  float w = widthScale * pow(max(magnitude, 0.0), widthExponent);
  return clamp(w, widthClamp.x, widthClamp.y);
}

float sttFlowRampT(
  float magnitude,
  vec2 domain,   // [lo, hi] magnitude mapped to 0..1
  float gamma    // <= 0 ⇒ linear; 0.5 lifts the low end, 2.0 crushes it
) {
  float span = domain.y - domain.x;
  float t = span > 0.0
    ? (magnitude - domain.x) / span
    : (magnitude > domain.x ? 1.0 : 0.0);
  t = clamp(t, 0.0, 1.0);
  return gamma > 0.0 ? pow(t, gamma) : t;
}
`;

/**
 * JS-side reference implementation of `sttFlowWidth`, kept in the same file so
 * the two stay in lock-step. Argument order mirrors the GLSL. Used by the
 * parity tests, by {@link expandFlowMagnitudes}-style CPU fallbacks, and by any
 * layer that needs to know a corridor's width without a GPU round-trip (a
 * legend, a hit test).
 *
 * `widthClamp` is `ArrayLike` so the `Float32Array` uniform pair can be handed
 * straight in.
 */
export function flowWidthJS(
  magnitude: number,
  minFlow: number,
  widthScale: number,
  widthExponent: number,
  widthClamp: ArrayLike<number>,
): number {
  if (!(magnitude > minFlow)) return 0;
  const w = widthScale * Math.pow(Math.max(magnitude, 0), widthExponent);
  return Math.min(Math.max(w, widthClamp[0]), widthClamp[1]);
}

/** JS-side reference implementation of `sttFlowRampT`. */
export function flowRampTJS(
  magnitude: number,
  domain: ArrayLike<number>,
  gamma: number,
): number {
  const span = domain[1] - domain[0];
  let t =
    span > 0 ? (magnitude - domain[0]) / span : magnitude > domain[0] ? 1 : 0;
  t = Math.min(Math.max(t, 0), 1);
  return gamma > 0 ? Math.pow(t, gamma) : t;
}
