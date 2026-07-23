// @poopdeck.gl/maplibre
// SPDX-License-Identifier: MIT

/**
 * The FLOW kernel — CPU side of the origin→destination / corridor family
 * (maplibre parity campaign Wave M4, P2 tier).
 *
 * A flow tile is a STATIC geometry carrying a TIME SERIES: the streets, the
 * river reaches or the OD pairs never move, but each one's magnitude changes
 * with the playhead (`BinaryFeatures.vertexValueMatrix`, `vertexValueBuckets`
 * columns, flattened vertex-major). Everything here exists to keep that split
 * honest:
 *
 *   **Geometry is built once per tile and is REF-STABLE. Magnitude reaches the
 *   GPU as a TEXTURE plus ONE per-frame scalar uniform (`uFlowBucket`).
 *   Nothing in a per-frame path allocates, re-tessellates or re-uploads.**
 *
 * That sentence is the whole design, and it is written this loudly because the
 * deck backend's `FlowCorridorLayer` got it wrong in a way that cost 6 Hz
 * whole-network re-tessellation: its prepared-tile `styleKey` folded the
 * quantized playhead in (`gradientStyleSuffix` → `:fp{step}`), so every
 * sub-step minted a fresh `data` object, deck saw `dataChanged` and re-ran
 * PathLayer tessellation over the entire street network. See the rivers/rain
 * perf root-cause note in the roadmap. Concretely, on this backend:
 *
 *   | changes                | when                    | cost                  |
 *   | ---------------------- | ----------------------- | --------------------- |
 *   | ribbon vertex buffers  | tile upload / eviction  | once per tile         |
 *   | value-matrix texture   | tile upload / eviction  | once per tile         |
 *   | `uFlowBucket` uniform  | every frame             | one `uniform1f`       |
 *   | magnitude per vertex   | every frame, ON THE GPU | 2 texture fetches     |
 *
 * {@link flowTileKey} is the guard rail: the cache key it builds carries the
 * tile, the layer and the *shape* knobs — never the playhead. If a future
 * change makes a key playhead-dependent, the bug is back.
 *
 * ── What is in here ────────────────────────────────────────────────────────
 *  1. **Bucket axis** — `deriveFlowAxis` / `bucketPositionAt`: the tile's
 *     timestep axis and the playhead→continuous-column map, byte-for-byte the
 *     deck `FlowCorridorLayer.posFromBinary` formula so both backends light the
 *     same corridors at the same instants.
 *  2. **Value-matrix packing** — `packValueMatrix` / `packVertexValueMatrix`:
 *     rows × cols → a texture-ready `Float32Array` (`float32`) or `Uint8Array`
 *     (`unorm16`) plus the lookup metadata the shader samples with.
 *  3. **Sampling references** — `sampleFlowMatrixJS` mirrors the emitted GLSL
 *     exactly (including the packing's texel addressing), and doubles as the
 *     CPU fallback (`expandFlowMagnitudes`) for hosts without vertex texture
 *     fetch.
 *  4. **Corridor ribbon** — `buildCorridorRibbon`: a polyline + width profile →
 *     a mitred triangle-list ribbon whose width is left to the shader, so the
 *     same buffers serve every playhead position.
 *  5. **OD pairs** — `extractFlowOdPairs`, over core's
 *     `deriveSourceTargetPositions`.
 *  6. **Caches** — `FlowTileCache` + `flowTileKey`, the object-identity
 *     promise the ref-stability tests pin.
 *
 * Pure geometry/maths and typed arrays: no GL calls, no map, no layer imports
 * (`supportsVertexTextureFetch` takes a structural `getParameter` reader, not a
 * `WebGLRenderingContext`). Outputs are freshly allocated once per call —
 * tile-upload time, never per frame.
 *
 * Coordinates are MERCATOR UNIT SQUARE throughout (`lib/projection.ts`), the
 * space this backend pre-projects into on the CPU and quantizes from.
 */

import type { BinaryFeatures, TileId } from '@poopdeck.gl/core';
import { deriveSourceTargetPositions } from '@poopdeck.gl/core/geometry';
import { lngLatToMercatorInto } from './projection.js';
import { subdivideLineMercator } from './globe.js';
import type { FlowMatrixFormat } from '../shaders/flow.glsl.js';

// ── bucket axis ─────────────────────────────────────────────────────────────

/**
 * A flow tile's timestep axis. `numBuckets` is the matrix's COLUMN count;
 * `bucket0Abs` is the absolute epoch-ms time of column 0's left edge.
 *
 * The axis is uniform across a dataset (whole-range corridor archives and
 * time-CHUNKED archives alike — each chunk slices the same uniform bin), so a
 * layer may cache one axis from the first matrix tile it sees and gate its
 * repaint on it, exactly as `FlowCorridorLayer.noteAxis` does.
 */
export interface FlowBucketAxis {
  /** Number of timestep columns (`BinaryFeatures.vertexValueBuckets`). */
  numBuckets: number;
  /** Duration of one column, ms. */
  bucketWidthMs: number;
  /** Absolute epoch-ms time at the left edge of column 0. */
  bucket0Abs: number;
}

/**
 * Read a tile's timestep axis from its binary features, or `null` when the tile
 * carries no usable matrix axis (no `vertexValueBuckets`, no times, or a
 * non-positive span).
 *
 * Deliberately the same derivation as the deck backend
 * (`FlowCorridorLayer.posFromBinary` / `FlowmapLayer.posFromBinary`): a flow
 * feature's `[startTimes[0], endTimes[0]]` spans the tile's WHOLE range and the
 * columns divide it evenly, so `bucketWidth = span / numBuckets` and column `b`
 * begins at `bucket0Abs + b * bucketWidth`. Column CENTRES are not used — the
 * playhead maps to the column's left edge — because that is what the deck side
 * does and cross-backend agreement beats a half-column of theory.
 */
export function deriveFlowAxis(
  features: Pick<
    BinaryFeatures,
    'vertexValueBuckets' | 'startTimes' | 'endTimes' | 'timeOffset'
  >,
): FlowBucketAxis | null {
  const numBuckets = features.vertexValueBuckets ?? 0;
  if (numBuckets <= 0) return null;
  const { startTimes, endTimes } = features;
  if (!startTimes || !endTimes || startTimes.length === 0) return null;
  const rel0 = startTimes[0];
  const span = endTimes[0] - rel0;
  if (!(span > 0)) return null;
  return {
    numBuckets,
    bucketWidthMs: span / numBuckets,
    bucket0Abs: features.timeOffset + rel0,
  };
}

/**
 * Continuous column position for an absolute epoch-ms time, CLAMPED to
 * `[0, numBuckets - 1]`.
 *
 * The clamp is the reason a flow layer never blanks: a flow tile is timeless
 * (its geometry exists across the whole range), so a playhead before the first
 * column reads column 0 and one past the last reads the final column instead of
 * disappearing. This is the ONE number that changes per frame — the layer
 * writes it into `uFlowBucket` and touches nothing else.
 */
export function bucketPositionAt(
  axis: FlowBucketAxis,
  absTimeMs: number,
): number {
  if (!(axis.bucketWidthMs > 0)) return 0;
  const pos = (absTimeMs - axis.bucket0Abs) / axis.bucketWidthMs;
  if (!Number.isFinite(pos) || pos < 0) return 0;
  const max = axis.numBuckets - 1;
  return pos > max ? max : pos;
}

/**
 * Sub-step granularity for the CPU FALLBACK path only (hosts without vertex
 * texture fetch, see {@link expandFlowMagnitudes}): 0.5 ⇒ two re-expansions per
 * column, the same trade `FlowCorridorLayer.STEP` makes on the deck backend.
 *
 * The GPU path needs NO quantization — that is the point of the texture — so
 * never route `uFlowBucket` through {@link quantizeBucketPosition}.
 */
export const CPU_FALLBACK_SUB_STEP = 0.5;

/**
 * Quantize a continuous column position onto a sub-step grid, for gating the
 * CPU fallback's re-expansion. `step <= 0` passes the position through.
 */
export function quantizeBucketPosition(pos: number, step: number): number {
  if (!(step > 0)) return pos;
  return Math.round(pos / step) * step;
}

// ── value-matrix packing ────────────────────────────────────────────────────

/**
 * Hard ceiling on `rows * cols`. The shader addresses texels through a single
 * float index (`row * cols + col`); float32 represents integers exactly only up
 * to 2^24, and past that the addressing silently aliases onto the wrong row.
 */
export const MAX_FLOW_MATRIX_TEXELS = 1 << 24;

/** A packed, texture-ready value matrix plus everything needed to sample it. */
export interface PackedValueMatrix {
  /** Storage format — a shader permutation axis (`flowSamplerCacheKey`). */
  readonly format: FlowMatrixFormat;
  /**
   * Texture payload, `texWidth * texHeight` texels, zero-padded past the last
   * real value. `float32` ⇒ one float per texel; `unorm16` ⇒ RGBA bytes with
   * the value in `(r, g)` and **alpha pinned to 255** so a host that left
   * `UNPACK_PREMULTIPLY_ALPHA_WEBGL` enabled cannot zero the payload.
   */
  readonly data: Float32Array | Uint8Array;
  /** Texture width. ALWAYS A POWER OF TWO — see `shaders/flow.glsl.ts`. */
  readonly texWidth: number;
  /** Texture height. */
  readonly texHeight: number;
  /** Matrix rows (reaches / vertices / OD pairs). */
  readonly rows: number;
  /** Matrix columns (timesteps). */
  readonly cols: number;
  /** `uFlowValueScale.x` — decode offset (0 on the `float32` path). */
  readonly valueMin: number;
  /** `uFlowValueScale.y` — decode span (1 on the `float32` path). */
  readonly valueSpan: number;
}

/** Options for {@link packValueMatrix}. */
export interface PackValueMatrixOptions {
  /** Storage format. @default 'float32' */
  format?: FlowMatrixFormat;
  /**
   * Pack `|value|`. STT's per-bucket-direction archives carry a SIGNED matrix
   * where the sign is travel direction and the magnitude is the volume; width
   * and colour want the magnitude, and blending signed values would dip through
   * zero at a direction flip (deck's `blendMatrixRow(..., absolute)`).
   * @default false
   */
  absolute?: boolean;
  /**
   * Explicit `[min, max]` for the `unorm16` fixed-point range. Defaults to the
   * data's own min/max. Pass a DATASET-wide range when several tiles must share
   * one decode (otherwise each tile gets its own, which is fine as long as the
   * `uFlowValueScale` uniform is set from the same tile as the bound texture).
   * Ignored by `float32`.
   */
  valueRange?: readonly [number, number];
  /** `gl.MAX_TEXTURE_SIZE`. @default 4096 (the WebGL floor worth assuming) */
  maxTextureSize?: number;
}

/** Largest power of two `<= n` (>= 1). */
function pow2Floor(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/**
 * Pack a `rows × cols` value matrix (flattened ROW-MAJOR, i.e. `values[row *
 * cols + col]` — the layout `BinaryFeatures.vertexValueMatrix` already uses)
 * into a texture payload.
 *
 * Texels are addressed LINEARLY (`row * cols + col`), so a matrix wider or
 * taller than `MAX_TEXTURE_SIZE` still fits and one shader path serves every
 * shape. The width is chosen square-ish and forced to a POWER OF TWO, which is
 * what makes the shader's index→(x, y) split exact — see the invariant section
 * of `shaders/flow.glsl.ts`.
 *
 * Non-finite entries (NaN marks "no value" in STT's baked float columns) are
 * sanitized to 0: a NaN reaching a width would collapse a whole triangle into
 * nothing, or worse, poison a projected position.
 *
 * Returns `null` — never throws — for the data-shaped refusals a tile can
 * legitimately hit: an empty matrix, a matrix SHORTER than `rows * cols`
 * (deck's `matrix.length < totalVerts * nb` guard, which falls back to the
 * static channel), a matrix past {@link MAX_FLOW_MATRIX_TEXELS}, or one whose
 * height would exceed `maxTextureSize`. Throws only on programmer error
 * (non-integer or negative dimensions).
 */
export function packValueMatrix(
  values: ArrayLike<number>,
  rows: number,
  cols: number,
  opts: PackValueMatrixOptions = {},
): PackedValueMatrix | null {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 0 ||
    cols < 0
  ) {
    throw new Error(
      `packValueMatrix: rows/cols must be non-negative integers (got ${rows}×${cols})`,
    );
  }
  const total = rows * cols;
  if (total === 0) return null;
  if (values.length < total) return null;
  if (total > MAX_FLOW_MATRIX_TEXELS) return null;

  const maxTextureSize = Math.floor(opts.maxTextureSize ?? 4096);
  if (maxTextureSize < 1) return null;
  const maxPot = pow2Floor(maxTextureSize);
  let texWidth = 1;
  while (texWidth < maxPot && texWidth * texWidth < total) texWidth *= 2;
  const texHeight = Math.ceil(total / texWidth);
  if (texHeight > maxTextureSize) return null;

  const format: FlowMatrixFormat = opts.format ?? 'float32';
  const absolute = opts.absolute === true;

  if (format === 'float32') {
    const data = new Float32Array(texWidth * texHeight);
    for (let i = 0; i < total; i++) {
      const raw = values[i];
      if (!Number.isFinite(raw)) continue; // padding is already 0
      data[i] = absolute ? Math.abs(raw) : raw;
    }
    return {
      format,
      data,
      texWidth,
      texHeight,
      rows,
      cols,
      valueMin: 0,
      valueSpan: 1,
    };
  }

  // unorm16: 16-bit fixed point across the (r, g) bytes of an RGBA texel.
  let min: number;
  let max: number;
  if (opts.valueRange) {
    min = opts.valueRange[0];
    max = opts.valueRange[1];
  } else {
    min = Infinity;
    max = -Infinity;
    for (let i = 0; i < total; i++) {
      const raw = values[i];
      const v = Number.isFinite(raw) ? (absolute ? Math.abs(raw) : raw) : 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 0;
  }
  // A degenerate range stores zeros and decodes to `min` everywhere — exact,
  // and no divide by zero.
  const span = max > min ? max - min : 0;
  const invSpan = span > 0 ? 1 / span : 0;

  const data = new Uint8Array(texWidth * texHeight * 4);
  for (let i = 0; i < texWidth * texHeight; i++) {
    // Alpha 255 on EVERY texel (padding included): premultiplied-alpha unpack
    // is a no-op then, whatever pixel-store state the host left behind.
    data[i * 4 + 3] = 255;
  }
  for (let i = 0; i < total; i++) {
    const raw = values[i];
    const v = Number.isFinite(raw) ? (absolute ? Math.abs(raw) : raw) : 0;
    let q = span > 0 ? Math.round((v - min) * invSpan * 65535) : 0;
    if (q < 0) q = 0;
    else if (q > 65535) q = 65535;
    data[i * 4] = (q >> 8) & 0xff;
    data[i * 4 + 1] = q & 0xff;
  }
  return {
    format,
    data,
    texWidth,
    texHeight,
    rows,
    cols,
    valueMin: min,
    valueSpan: span,
  };
}

/**
 * {@link packValueMatrix} over a tile's `vertexValueMatrix`: rows are GLOBAL
 * VERTICES (the layout STT bakes — `matrix[globalVertex * buckets + bucket]`),
 * columns are timesteps. `null` when the tile carries no matrix, mirroring the
 * deck side's fall-through to the static `vertexValues` channel.
 */
export function packVertexValueMatrix(
  features: Pick<BinaryFeatures, 'vertexValueMatrix' | 'vertexValueBuckets'>,
  vertexCount: number,
  opts: PackValueMatrixOptions = {},
): PackedValueMatrix | null {
  const cols = features.vertexValueBuckets ?? 0;
  const matrix = features.vertexValueMatrix;
  if (cols <= 0 || !matrix || vertexCount <= 0) return null;
  return packValueMatrix(matrix, vertexCount, cols, opts);
}

// ── sampling references (parity + CPU fallback) ─────────────────────────────

/**
 * Read ONE texel of a packed matrix exactly as `sttFlowTexel` does — same
 * linear index, same fixed-point decode. `col` is NOT clamped here (the caller
 * or {@link sampleFlowMatrixJS} does that, like the GLSL).
 *
 * A `(row, col)` inside the texture but past `rows * cols` lands in the zero
 * padding and decodes exactly as the GPU would (0 on the float path,
 * `valueMin` on the fixed-point one). Past the texture itself is caller error —
 * a row `>= rows` — and reads 0 here while the GPU's `CLAMP_TO_EDGE` would
 * repeat its last texel; neither is meaningful, so do not rely on either.
 */
export function readFlowTexelJS(
  packed: PackedValueMatrix,
  row: number,
  col: number,
): number {
  const idx = row * packed.cols + col;
  if (idx < 0) return 0;
  if (packed.format === 'float32') {
    return idx < packed.data.length ? (packed.data[idx] as number) : 0;
  }
  const base = idx * 4;
  if (base + 1 >= packed.data.length) return 0;
  // The GPU computes `r/255 * 65280 + g/255 * 255`, which is exactly
  // `hi * 256 + lo` in real arithmetic; its float rounding is ~1e-7 relative,
  // three orders below the 1/65535 quantization step.
  const q = packed.data[base] * 256 + packed.data[base + 1];
  return packed.valueMin + (q / 65535) * packed.valueSpan;
}

/**
 * JS-side reference implementation of `sttFlowMagnitude` — the linear blend of
 * the two adjacent timestep columns at a continuous position.
 *
 * Mirrors the GLSL statement for statement, including the `[0, cols - 1]`
 * clamp, the `b1 = min(b0 + 1, maxCol)` collapse at the last column, and
 * `mix(v0, v1, f) = v0 * (1 - f) + v1 * f` (which is also deck's
 * `blendMatrixRow` form, so the two backends round identically).
 *
 * Used by the parity tests, by {@link expandFlowMagnitudes} and by any CPU-side
 * question about what the GPU is drawing (picking, a legend, a hover readout).
 */
export function sampleFlowMatrixJS(
  packed: PackedValueMatrix,
  row: number,
  bucketPos: number,
): number {
  const maxCol = packed.cols - 1;
  const b = bucketPos < 0 ? 0 : bucketPos > maxCol ? maxCol : bucketPos;
  const b0 = Math.floor(b);
  const f = b - b0;
  const v0 = readFlowTexelJS(packed, row, b0);
  if (f <= 0) return v0;
  const v1 = readFlowTexelJS(packed, row, Math.min(b0 + 1, maxCol));
  return v0 * (1 - f) + v1 * f;
}

/**
 * CPU fallback for hosts without vertex texture fetch
 * ({@link supportsVertexTextureFetch} false — a WebGL1 possibility, since the
 * spec's minimum for `MAX_VERTEX_TEXTURE_IMAGE_UNITS` is zero): expand one
 * magnitude per draw unit into a caller-owned buffer, which the layer then
 * re-uploads as an attribute.
 *
 * This path DOES touch a buffer per update, so gate it on a sub-step
 * ({@link quantizeBucketPosition} + {@link CPU_FALLBACK_SUB_STEP}) rather than
 * running it per frame — and note that `out` is caller-owned and reused, so the
 * gated update still allocates nothing.
 *
 * Mutates and returns `out`.
 */
export function expandFlowMagnitudes(
  out: Float32Array,
  packed: PackedValueMatrix,
  rows: ArrayLike<number>,
  bucketPos: number,
): Float32Array {
  const n = Math.min(out.length, rows.length);
  const maxCol = packed.cols - 1;
  const b = bucketPos < 0 ? 0 : bucketPos > maxCol ? maxCol : bucketPos;
  const b0 = Math.floor(b);
  const f = b - b0;
  const b1 = Math.min(b0 + 1, maxCol);
  const g = 1 - f;
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const v0 = readFlowTexelJS(packed, row, b0);
    out[i] = f <= 0 ? v0 : v0 * g + readFlowTexelJS(packed, row, b1) * f;
  }
  return out;
}

// ── uniform payload ─────────────────────────────────────────────────────────

/**
 * Uniform payload for one draw. Mutable and caller-owned: a layer allocates one
 * with {@link createFlowMatrixUniforms} at construction and re-resolves it in
 * place every draw, so the hot path allocates nothing (the DataFilter kernel's
 * `DataFilterUniforms` convention).
 */
export interface FlowMatrixUniforms {
  /** `uFlowMatrixSize` — `[texW, texH, 1/texW, 1/texH]`; `gl.uniform4fv`. */
  readonly texSize: Float32Array;
  /** `uFlowMatrixDims` — `[cols, rows]`; `gl.uniform2fv`. */
  readonly dims: Float32Array;
  /** `uFlowValueScale` — `[min, span]`; `gl.uniform2fv`. */
  readonly valueScale: Float32Array;
  /** `uFlowBucket` — the continuous column position; `gl.uniform1f`. */
  bucket: number;
}

/** Allocate a payload once per layer; {@link resolveFlowMatrixUniforms} fills it. */
export function createFlowMatrixUniforms(): FlowMatrixUniforms {
  return {
    texSize: new Float32Array(4),
    dims: new Float32Array(2),
    valueScale: new Float32Array([0, 1]),
    bucket: 0,
  };
}

/**
 * Fill a payload from the tile's packed matrix + the frame's column position.
 *
 * The three array uniforms belong to the TILE (they travel with the bound
 * texture — a `unorm16` decode from tile A applied to tile B's texture is a
 * silent value error), while `bucket` belongs to the FRAME. Resolve both
 * together, immediately before the draw that binds this tile's texture.
 *
 * Mutates and returns `out`.
 */
export function resolveFlowMatrixUniforms(
  out: FlowMatrixUniforms,
  packed: PackedValueMatrix,
  bucketPos: number,
): FlowMatrixUniforms {
  out.texSize[0] = packed.texWidth;
  out.texSize[1] = packed.texHeight;
  out.texSize[2] = 1 / packed.texWidth;
  out.texSize[3] = 1 / packed.texHeight;
  out.dims[0] = packed.cols;
  out.dims[1] = packed.rows;
  out.valueScale[0] = packed.valueMin;
  out.valueScale[1] = packed.valueSpan;
  out.bucket = Number.isFinite(bucketPos) ? bucketPos : 0;
  return out;
}

// ── corridor ribbon ─────────────────────────────────────────────────────────

/** Result of {@link buildCorridorRibbon}. Every array is freshly allocated. */
export interface CorridorRibbon {
  /** Ribbon vertices = `2 × pathVertexCount` (one pair per path vertex). */
  vertexCount: number;
  /** Path vertices kept after de-duplication. */
  pathVertexCount: number;
  /**
   * Mercator positions, STRIDE 3 (`mx, my, 0`) so the buffer can go straight
   * through `quantizePositionsToUint16` like every other geometry in this
   * backend. Both vertices of a pair sit ON the path — the ribbon's width lives
   * entirely in {@link extrusions}, which is what lets one buffer serve every
   * playhead position.
   */
  positions: Float32Array;
  /**
   * Signed miter offset at UNIT width, stride 2 (`aFlowExtrusion`). The shader
   * computes `posM + aFlowExtrusion * halfWidthMercator`; the sign already
   * encodes the side, the length already carries the miter correction and the
   * static width profile.
   */
  extrusions: Float32Array;
  /** `-1` / `+1` per vertex (`aFlowSide`) — band coordinate for edge AA. */
  sides: Float32Array;
  /** Value-matrix row per vertex (`aFlowRow`), float for a GLSL ES 1.00 attribute. */
  rows: Float32Array;
  /** `0..1` cumulative distance along the corridor (`aFlowAlong`). */
  alongs: Float32Array;
  /** Triangle list, `3 × triangleCount` indices into the ribbon vertices. */
  indices: Uint32Array;
  /** `2 × (pathVertexCount - 1)`. */
  triangleCount: number;
  /** Corridor length in mercator units (of the de-duplicated polyline). */
  lengthMercator: number;
}

/** Input to {@link buildCorridorRibbon}. */
export interface CorridorRibbonOptions {
  /** Flat mercator polyline, `[x0, y0, x1, y1, …]`. */
  positions: Float64Array | Float32Array | number[];
  /**
   * Value-matrix row per INPUT vertex. Defaults to `firstRow + i`, which is
   * exactly the vertex-major layout of `vertexValueMatrix` for a feature whose
   * first vertex is `firstRow` (`startIndices[f]`).
   */
  rows?: ArrayLike<number>;
  /** Row of the first vertex when {@link rows} is omitted. @default 0 */
  firstRow?: number;
  /**
   * STATIC per-input-vertex width multiplier — a taper, a per-reach constant, a
   * stream-order weight. Folded into {@link CorridorRibbon.extrusions} at build
   * time. This is NOT where the animated magnitude goes: that is the shader's
   * job, every frame, from the value matrix.
   * @default 1 everywhere
   */
  widthProfile?: ArrayLike<number>;
  /**
   * Globe subdivision granularity (full-mercator-square convention — see
   * `lib/globe.ts`). `0`/omitted skips subdivision, which is right on every
   * mercator host. Inserted vertices interpolate the width profile linearly and
   * take the NEAREST original row (a row index is an address, not a quantity —
   * interpolating it would address a texel between two reaches).
   * @default 0
   */
  granularity?: number;
  /**
   * Cap on the miter lengthening at a sharp bend, in multiples of the width. An
   * unclamped miter shoots a spike out of every hairpin; past the limit the
   * join bevels instead. @default 4
   */
  miterLimit?: number;
}

/**
 * Two mercator positions are the "same" vertex below this separation (~0.04 mm
 * on the ground). Repeated vertices are what produce zero-area triangles and
 * NaN normals, so they are dropped before anything is computed.
 */
const RIBBON_DEDUPE_EPSILON = 1e-12;

/** Below this the miter bisector has collapsed (a 180° reversal). */
const MITER_DEGENERATE = 1e-6;

/**
 * Tessellate a corridor polyline into a mitred ribbon whose WIDTH IS NOT BAKED.
 *
 * Each kept path vertex emits two ribbon vertices, both AT the path position,
 * carrying opposite unit-width miter offsets. The shader then draws
 * `posM + aFlowExtrusion * halfWidth`, where `halfWidth` comes from the value
 * matrix at the live playhead — so a corridor breathing from 0 to 40 px never
 * touches a vertex buffer. Consecutive quads share their offset vertices via
 * the miter, so a bend has no gap on its outside.
 *
 * The extrusion is in MERCATOR space, which makes this a GROUND ribbon: a
 * constant pixel width is a per-frame scalar ({@link mercatorPerPixel}), a
 * constant metric width is `metersToMercatorUnits` at the tile's latitude, and
 * under pitch the ribbon foreshortens with the ground (unlike `STTLineLayer`'s
 * screen-space quads, which hold their pixel width into the distance). For a
 * corridor — a road, a river reach, a channel — ground-anchored is the correct
 * reading; that is why the ribbon exists instead of reusing the line layer.
 *
 * Returns `null` for a corridor with fewer than two DISTINCT vertices (there is
 * no direction to extrude along, and every triangle would be degenerate).
 */
export function buildCorridorRibbon(
  o: CorridorRibbonOptions,
): CorridorRibbon | null {
  const src = o.positions;
  if (src.length % 2 !== 0) {
    throw new Error(
      'buildCorridorRibbon: positions must be a flat xy array (even length)',
    );
  }
  const inCount = src.length / 2;
  if (inCount < 2) return null;

  const firstRow = o.firstRow ?? 0;
  // Annotated (not inferred): the subdivision path below reassigns the array
  // the globe kit returns, whose buffer type is the wider `ArrayBufferLike`.
  let rows: Float32Array = new Float32Array(inCount);
  if (o.rows) {
    for (let i = 0; i < inCount; i++) rows[i] = o.rows[i];
  } else {
    for (let i = 0; i < inCount; i++) rows[i] = firstRow + i;
  }
  let profile: Float32Array | null = null;
  if (o.widthProfile) {
    profile = new Float32Array(inCount);
    for (let i = 0; i < inCount; i++) profile[i] = o.widthProfile[i];
  }

  // Globe: split chords longer than the host's granularity BEFORE the ribbon is
  // built, so the mitres are computed on the geometry that actually ships.
  let pts: Float64Array | Float32Array | number[] = src;
  const granularity = o.granularity ?? 0;
  if (granularity > 0) {
    const arrays: (Float32Array | Float64Array)[] = [rows];
    const components = [1];
    if (profile) {
      arrays.push(profile);
      components.push(1);
    }
    const sub = subdivideLineMercator(src, granularity, {
      arrays,
      components,
    });
    pts = sub.positions;
    const outAttrs = sub.attrs!.arrays;
    // A row is an ADDRESS: the subdivider lerps it like any other attribute, so
    // snap back to the nearest real row. (The shader's texel-centre fetch would
    // round anyway; doing it here keeps CPU and GPU reading the same texel.)
    const subRows = outAttrs[0] as Float32Array;
    for (let i = 0; i < subRows.length; i++)
      subRows[i] = Math.round(subRows[i]);
    rows = subRows;
    if (profile) profile = outAttrs[1] as Float32Array;
  }

  // Drop repeated vertices — the source of zero-area triangles and NaN normals.
  const n0 = pts.length / 2;
  const keep = new Uint32Array(n0);
  let n = 0;
  for (let i = 0; i < n0; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (n > 0) {
      const px = pts[keep[n - 1] * 2];
      const py = pts[keep[n - 1] * 2 + 1];
      if (
        Math.abs(x - px) <= RIBBON_DEDUPE_EPSILON &&
        Math.abs(y - py) <= RIBBON_DEDUPE_EPSILON
      ) {
        continue;
      }
    }
    keep[n++] = i;
  }
  if (n < 2) return null;

  const miterLimit = o.miterLimit && o.miterLimit > 1 ? o.miterLimit : 4;
  const invMiterLimit = 1 / miterLimit;

  // Segment directions + cumulative length, over the KEPT vertices.
  const segCount = n - 1;
  const dirX = new Float64Array(segCount);
  const dirY = new Float64Array(segCount);
  const cumulative = new Float64Array(n);
  for (let s = 0; s < segCount; s++) {
    const a = keep[s];
    const b = keep[s + 1];
    const dx = pts[b * 2] - pts[a * 2];
    const dy = pts[b * 2 + 1] - pts[a * 2 + 1];
    const len = Math.sqrt(dx * dx + dy * dy);
    // `len > 0` is guaranteed by the de-duplication above; the guard is here so
    // a future caller-supplied epsilon cannot reintroduce a divide by zero.
    const inv = len > 0 ? 1 / len : 0;
    dirX[s] = dx * inv;
    dirY[s] = dy * inv;
    cumulative[s + 1] = cumulative[s] + len;
  }
  const totalLength = cumulative[n - 1];
  const invTotal = totalLength > 0 ? 1 / totalLength : 0;

  const positions = new Float32Array(n * 2 * 3);
  const extrusions = new Float32Array(n * 2 * 2);
  const sides = new Float32Array(n * 2);
  const outRows = new Float32Array(n * 2);
  const alongs = new Float32Array(n * 2);
  const indices = new Uint32Array(segCount * 6);

  for (let i = 0; i < n; i++) {
    const vi = keep[i];
    const x = pts[vi * 2];
    const y = pts[vi * 2 + 1];
    // Perpendiculars of the incoming / outgoing segment. perp(d) = (-dy, dx),
    // so `+` is one consistent side of travel for the whole corridor.
    const sIn = i > 0 ? i - 1 : 0;
    const sOut = i < segCount ? i : segCount - 1;
    const nInX = -dirY[sIn];
    const nInY = dirX[sIn];
    const nOutX = -dirY[sOut];
    const nOutY = dirX[sOut];
    let mx = nInX + nOutX;
    let my = nInY + nOutY;
    const mlen = Math.sqrt(mx * mx + my * my);
    let scale = 1;
    if (mlen < MITER_DEGENERATE) {
      // 180° reversal: the bisector vanishes. Fall back to the outgoing normal
      // (unit length, so no degenerate triangle) rather than emitting (0, 0).
      mx = nOutX;
      my = nOutY;
    } else {
      mx /= mlen;
      my /= mlen;
      // 1 / cos(θ/2) keeps the ribbon's width constant through the bend, capped
      // so a hairpin bevels instead of spiking.
      const cosHalf = mx * nOutX + my * nOutY;
      scale = 1 / Math.max(cosHalf, invMiterLimit);
      if (scale > miterLimit) scale = miterLimit;
      else if (scale < 1) scale = 1;
    }
    const w = (profile ? profile[vi] : 1) * scale;
    const ex = mx * w;
    const ey = my * w;
    const along = cumulative[i] * invTotal;
    const row = rows[vi];

    const l = i * 2;
    const r = l + 1;
    positions[l * 3] = x;
    positions[l * 3 + 1] = y;
    positions[r * 3] = x;
    positions[r * 3 + 1] = y;
    extrusions[l * 2] = ex;
    extrusions[l * 2 + 1] = ey;
    extrusions[r * 2] = -ex;
    extrusions[r * 2 + 1] = -ey;
    sides[l] = 1;
    sides[r] = -1;
    outRows[l] = row;
    outRows[r] = row;
    alongs[l] = along;
    alongs[r] = along;
  }

  for (let s = 0; s < segCount; s++) {
    const l0 = s * 2;
    const r0 = l0 + 1;
    const l1 = l0 + 2;
    const r1 = l0 + 3;
    const o6 = s * 6;
    // Consistent winding across the whole ribbon (both triangles positively
    // oriented for a left-to-right segment), so a host that enables face
    // culling keeps the whole corridor or drops the whole corridor.
    indices[o6] = l0;
    indices[o6 + 1] = r0;
    indices[o6 + 2] = l1;
    indices[o6 + 3] = l1;
    indices[o6 + 4] = r0;
    indices[o6 + 5] = r1;
  }

  return {
    vertexCount: n * 2,
    pathVertexCount: n,
    positions,
    extrusions,
    sides,
    rows: outRows,
    alongs,
    indices,
    triangleCount: segCount * 2,
    lengthMercator: totalLength,
  };
}

// ── OD pairs ────────────────────────────────────────────────────────────────

/** Result of {@link extractFlowOdPairs}. */
export interface FlowOdPairs {
  /** Number of OD pairs (= `featureCount`). */
  count: number;
  /** Source endpoints in MERCATOR, stride 3 (`mx, my, alt`). */
  source: Float32Array;
  /** Target endpoints in MERCATOR, stride 3. */
  target: Float32Array;
  /**
   * Value-matrix row per pair — the pair's SOURCE vertex index
   * (`startIndices[i]`), which is where the vertex-major matrix keeps an OD
   * feature's series (deck's `FlowmapLayer.srcVertexIndex`). Float, for a
   * GLSL ES 1.00 attribute.
   */
  rows: Float32Array;
  /** Source endpoints in lon/lat, stride {@link dims} — node keys, picking. */
  sourceLngLat: Float64Array;
  /** Target endpoints in lon/lat, stride {@link dims}. */
  targetLngLat: Float64Array;
  /** Position dimensions of the lon/lat buffers (2 or 3). */
  dims: number;
}

/**
 * Collapse a LineString tile's features to OD endpoints, pre-projected to
 * mercator.
 *
 * The lon/lat collapse itself is core's `deriveSourceTargetPositions` (the
 * kernel deck and three already share — first vertex is the origin, last is the
 * destination, intermediates dropped); this adds the mercator pre-projection
 * every maplibre layer needs and the matrix row each pair samples with.
 *
 * `null` when the tile has no features or no `startIndices`.
 */
export function extractFlowOdPairs(
  features: BinaryFeatures,
): FlowOdPairs | null {
  const count = features.featureCount;
  const startIndices = features.startIndices;
  if (count <= 0 || !startIndices) return null;

  const { source, target, dims } = deriveSourceTargetPositions(features);
  const srcM = new Float32Array(count * 3);
  const tgtM = new Float32Array(count * 3);
  const rows = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const b = i * dims;
    lngLatToMercatorInto(source[b], source[b + 1], srcM, i * 3);
    lngLatToMercatorInto(target[b], target[b + 1], tgtM, i * 3);
    if (dims === 3) {
      srcM[i * 3 + 2] = source[b + 2];
      tgtM[i * 3 + 2] = target[b + 2];
    }
    rows[i] = startIndices[i];
  }
  return {
    count,
    source: srcM,
    target: tgtM,
    rows,
    sourceLngLat: source,
    targetLngLat: target,
    dims,
  };
}

// ── caches ──────────────────────────────────────────────────────────────────

/**
 * Build the cache key for one tile-layer's flow geometry.
 *
 * ⚠ `shape` may carry ONLY knobs that change the GEOMETRY — the globe
 * subdivision granularity, a width-profile column name, a miter limit. It must
 * NEVER carry the playhead, the current bucket, a sub-step or anything derived
 * from time. A playhead in this key is precisely the deck-side bug this kernel
 * exists to avoid (see the module header): it turns a per-tile tessellation
 * into a per-sub-step one.
 */
export function flowTileKey(id: TileId, layerName: string, shape = ''): string {
  const base = `${id.z}/${id.x}/${id.y}/${id.t}::${layerName}`;
  return shape ? `${base}::${shape}` : base;
}

/**
 * Keyed cache with an OBJECT-IDENTITY guarantee: for a given key, every `get`
 * returns the very same instance until the entry is dropped. That identity is
 * the contract a layer's "did my data change?" checks lean on, and the
 * ref-stability tests assert it directly.
 *
 * `null` results are cached too, so a degenerate tile (one vertex, no matrix)
 * is not re-analysed on every frame.
 *
 * Eviction is the layer's job: call {@link prune} when the resident tile set
 * changes and release whatever GL objects the evicted entries owned.
 */
export class FlowTileCache<T> {
  private readonly entries = new Map<string, T | null>();

  /** Number of cached entries (including cached `null`s). */
  get size(): number {
    return this.entries.size;
  }

  /** True when `key` has been built (even if it built to `null`). */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Return the cached entry for `key`, building it with `build` exactly once.
   * The returned reference is stable for the entry's lifetime.
   */
  get(key: string, build: () => T | null): T | null {
    if (this.entries.has(key)) return this.entries.get(key) ?? null;
    const built = build();
    this.entries.set(key, built);
    return built;
  }

  /** Drop one entry, returning what it held (`null` if absent or cached-null). */
  delete(key: string): T | null {
    const existing = this.entries.get(key) ?? null;
    this.entries.delete(key);
    return existing;
  }

  /**
   * Drop every entry whose key is not in `live`, returning the non-null values
   * dropped so the caller can free their GPU resources. Call this when the
   * resident tile set changes — NOT per frame.
   */
  prune(live: ReadonlySet<string>): T[] {
    const dropped: T[] = [];
    for (const [key, value] of this.entries) {
      if (live.has(key)) continue;
      if (value !== null) dropped.push(value);
      this.entries.delete(key);
    }
    return dropped;
  }

  /** Drop everything, returning the non-null values dropped (context loss, dispose). */
  clear(): T[] {
    const dropped: T[] = [];
    for (const value of this.entries.values()) {
      if (value !== null) dropped.push(value);
    }
    this.entries.clear();
    return dropped;
  }
}

// ── host capability + scale helpers ─────────────────────────────────────────

/**
 * The two `getParameter` bits {@link supportsVertexTextureFetch} needs,
 * structurally — so the kernel stays GL-import-free and a test can hand it a
 * plain object.
 */
export interface VertexTextureProbe {
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: number;
  getParameter(pname: number): unknown;
}

/**
 * Can the VERTEX stage sample a texture? WebGL2 guarantees at least 16 units,
 * but the WebGL1 minimum is **zero** — so a WebGL1 host may legally refuse the
 * GPU magnitude path, and the layer must fall back to
 * {@link expandFlowMagnitudes}. Probe once per context, not per frame.
 */
export function supportsVertexTextureFetch(gl: VertexTextureProbe): boolean {
  const units = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS);
  return typeof units === 'number' && units > 0;
}

/**
 * Pick the matrix format for a host: `float32` wherever a float texture can be
 * SAMPLED (WebGL2 always; WebGL1 with `OES_texture_float`), else the portable
 * `unorm16` fixed point. Both are NEAREST-filtered — no
 * `OES_texture_float_linear` is required, because the interpolation between
 * timesteps happens in the shader.
 */
export function chooseFlowMatrixFormat(caps: {
  webgl2: boolean;
  floatTextures?: boolean;
}): FlowMatrixFormat {
  return caps.webgl2 || caps.floatTextures === true ? 'float32' : 'unorm16';
}

/**
 * Mercator units per screen pixel at `zoom` — the scalar that turns a corridor
 * width in PIXELS into the mercator half-width
 * {@link CorridorRibbon.extrusions} is multiplied by.
 *
 * `tileSize` follows the same convention as
 * `metersToPixelsAtLatitude` in `lib/projection.ts`: maplibre's world is
 * `512 · 2^zoom` CSS px around, so pass `512 * devicePixelRatio` when the
 * width is expressed in DEVICE pixels.
 *
 * (Latitude-free by construction — the mercator scale factor cancels, which is
 * exactly why a mercator-space extrusion reads as a constant on-screen width.)
 */
export function mercatorPerPixel(zoom: number, tileSize = 512): number {
  return 1 / (tileSize * Math.pow(2, zoom));
}
