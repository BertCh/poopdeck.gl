/**
 * Globe-correctness geometry kit.
 *
 * MapLibre v5+'s injected shader prelude (`projectTile*`) projects *vertices*,
 * not edges: a long straight chord between two far-apart vertices cuts through
 * the sphere and gets horizon-clipped on globe. The fix is geometric — insert
 * vertices so no segment/edge exceeds the map's subdivision granularity —
 * and it must happen at tile-upload time, in the same mercator-unit-square
 * space our CPU pre-projection produces (see ./projection.ts), *before*
 * quantization.
 *
 * Everything here is pure geometry/math: no GL, no map, no layer imports.
 * Outputs are freshly allocated once per call (tile-upload time, never per
 * frame).
 *
 * Granularity convention: all `granularity` parameters below count segments
 * across the FULL mercator unit square, i.e. the max allowed per-axis span of
 * a segment/edge is `1/granularity` mercator units. MapLibre's own
 * granularity is per-*tile* and halves per zoom level; to honor a per-tile
 * granularity `g` (from {@link granularityForZoom}) for geometry inside a
 * tile at zoom `z`, pass `g * 2 ** z`. With the default curve that product is
 * a constant 128 until the per-tile clamp at 1 engages (z > 7).
 */

/** Flat numeric attribute storage — plain or typed array. */
export type AttrArray =
  | number[]
  | Float32Array
  | Float64Array
  | Uint8Array
  | Uint8ClampedArray
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array;

/** Per-vertex attribute arrays subdivided in parallel with positions. */
export interface SubdivisionAttrs {
  /** One flat array per attribute, `vertexCount * components[i]` long. */
  arrays: AttrArray[];
  /** Components per vertex for the same-index entry of `arrays`. */
  components: number[];
}

export interface LineSubdivisionResult {
  positions: Float64Array;
  /**
   * Present iff `attrs` was passed. Arrays mirror their input constructors
   * (plain `number[]` comes back as `Float32Array`, GPU-upload ready).
   */
  attrs?: SubdivisionAttrs;
}

/**
 * Safety valve: a single segment never expands into more pieces than this,
 * regardless of how large a granularity the caller passes. At the capped
 * default granularity (1024) a full-world segment needs at most 1024 pieces,
 * so this only binds on caller error.
 */
const MAX_SEGMENT_PIECES = 4096;

/**
 * Guards float noise at exact multiples: a segment whose span is precisely
 * `k / granularity` must produce `k` pieces, not `k + 1`, even when the
 * product `span * granularity` lands a few ulps above the integer.
 */
const PIECES_EPSILON = 1e-9;

/**
 * Recursion cap for {@link subdivideTrianglesMercator}: one input triangle
 * expands into at most `2 ** 16` output triangles. At the capped granularity
 * (1024) real tessellations terminate on the edge-length threshold well
 * before this binds.
 */
const MAX_TRIANGLE_SUBDIVISION_DEPTH = 16;

/**
 * Midpoint-dedup key = `lo * 2^22 + hi`; exact in doubles for meshes up to
 * 2^22 (~4.2M) vertices, far above any per-tile tessellation.
 */
const EDGE_KEY_STRIDE = 0x400000;

/** Per-axis (Chebyshev) mercator span — matches per-axis grid reasoning. */
function mercatorSpan(x0: number, y0: number, x1: number, y1: number): number {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  return dx > dy ? dx : dy;
}

/** `granularity` sanitized to 0 ("no subdivision") when non-finite or <= 0. */
function sanitizeGranularity(granularity: number): number {
  return Number.isFinite(granularity) && granularity > 0 ? granularity : 0;
}

function allocLike(src: AttrArray, length: number): AttrArray {
  if (Array.isArray(src)) return new Float32Array(length);
  return new (src.constructor as new (len: number) => AttrArray)(length);
}

/**
 * Subdivide a polyline (flat `[x0, y0, x1, y1, ...]` mercator-unit-square
 * coordinates) so no segment spans more than `1/granularity` mercator units
 * on either axis (see the module header for the granularity convention).
 *
 * Inserted vertices are evenly spaced along their segment. Every parallel
 * per-vertex attribute array in `attrs` (timestamps, values, colors, ...) is
 * linearly interpolated at the same parameters, so time-filter and color
 * semantics survive subdivision. Original vertices and their attribute values
 * are copied through verbatim (never recomputed), so an already-fine polyline
 * round-trips exactly. Zero-length/degenerate (or NaN) segments pass through
 * unsplit. Integer-typed attribute arrays truncate interpolated values on
 * store (typed-array semantics).
 */
export function subdivideLineMercator(
  positions: Float64Array | Float32Array | number[],
  granularity: number,
  attrs?: SubdivisionAttrs,
): LineSubdivisionResult {
  if (positions.length % 2 !== 0) {
    throw new Error(
      'subdivideLineMercator: positions must be a flat xy array (even length)',
    );
  }
  const n = positions.length / 2;
  if (attrs) {
    if (attrs.arrays.length !== attrs.components.length) {
      throw new Error(
        'subdivideLineMercator: attrs.arrays and attrs.components lengths differ',
      );
    }
    for (let i = 0; i < attrs.arrays.length; i++) {
      if (attrs.arrays[i].length !== n * attrs.components[i]) {
        throw new Error(
          `subdivideLineMercator: attrs.arrays[${i}] length ${attrs.arrays[i].length} != vertexCount ${n} * components ${attrs.components[i]}`,
        );
      }
    }
  }

  const g = sanitizeGranularity(granularity);
  const segments = n > 1 ? n - 1 : 0;

  // Count pass: pieces per segment, so the fill pass allocates exactly once.
  const pieces = new Int32Array(segments);
  let outCount = n;
  for (let s = 0; s < segments; s++) {
    const span = mercatorSpan(
      positions[s * 2],
      positions[s * 2 + 1],
      positions[s * 2 + 2],
      positions[s * 2 + 3],
    );
    const scaled = span * g;
    const p =
      Number.isFinite(scaled) && scaled > 1
        ? Math.min(MAX_SEGMENT_PIECES, Math.ceil(scaled - PIECES_EPSILON))
        : 1;
    pieces[s] = p;
    outCount += p - 1;
  }

  const outPositions = new Float64Array(outCount * 2);
  let outAttrs: SubdivisionAttrs | undefined;
  if (attrs) {
    outAttrs = {
      arrays: attrs.arrays.map((a, i) =>
        allocLike(a, outCount * attrs.components[i]),
      ),
      components: attrs.components.slice(),
    };
  }

  let vOut = 0;
  for (let vIn = 0; vIn < n; vIn++) {
    // Original vertex: verbatim copy, never recomputed via lerp.
    outPositions[vOut * 2] = positions[vIn * 2];
    outPositions[vOut * 2 + 1] = positions[vIn * 2 + 1];
    if (attrs && outAttrs) {
      for (let a = 0; a < attrs.arrays.length; a++) {
        const c = attrs.components[a];
        const src = attrs.arrays[a];
        const dst = outAttrs.arrays[a];
        for (let j = 0; j < c; j++) dst[vOut * c + j] = src[vIn * c + j];
      }
    }
    vOut++;

    if (vIn >= segments) continue;
    const p = pieces[vIn];
    const x0 = positions[vIn * 2];
    const y0 = positions[vIn * 2 + 1];
    const x1 = positions[vIn * 2 + 2];
    const y1 = positions[vIn * 2 + 3];
    for (let k = 1; k < p; k++) {
      const t = k / p;
      outPositions[vOut * 2] = x0 + (x1 - x0) * t;
      outPositions[vOut * 2 + 1] = y0 + (y1 - y0) * t;
      if (attrs && outAttrs) {
        for (let a = 0; a < attrs.arrays.length; a++) {
          const c = attrs.components[a];
          const src = attrs.arrays[a];
          const dst = outAttrs.arrays[a];
          for (let j = 0; j < c; j++) {
            const v0 = src[vIn * c + j];
            dst[vOut * c + j] = v0 + (src[(vIn + 1) * c + j] - v0) * t;
          }
        }
      }
      vOut++;
    }
  }

  return outAttrs
    ? { positions: outPositions, attrs: outAttrs }
    : { positions: outPositions };
}

/**
 * Subdivide a triangle mesh (flat xy mercator positions + index triples) by
 * longest-edge bisection until every edge spans at most `1/granularity`
 * mercator units per axis, or the per-triangle recursion cap
 * (2^{@link MAX_TRIANGLE_SUBDIVISION_DEPTH} output triangles) is reached.
 *
 * Winding is preserved: rotating a triangle so its longest edge comes first
 * and splitting `(a, b, c)` at `m = midpoint(a, b)` into `(a, m, c)` /
 * `(m, b, c)` both keep orientation. Midpoints are deduplicated per edge
 * (keyed by vertex-index pair), so the two triangles flanking a shared edge
 * split it at the same dyadic points — the refined mesh stays watertight.
 *
 * Input vertices are copied through verbatim ahead of appended midpoints, so
 * original indices remain valid in the output. An invalid granularity
 * (<= 0 / non-finite) passes the mesh through as fresh copies.
 */
export function subdivideTrianglesMercator(
  positions: Float64Array | Float32Array | number[],
  indices: Uint16Array | Uint32Array | number[],
  granularity: number,
): { positions: Float64Array; indices: Uint32Array } {
  if (positions.length % 2 !== 0) {
    throw new Error(
      'subdivideTrianglesMercator: positions must be a flat xy array (even length)',
    );
  }
  if (indices.length % 3 !== 0) {
    throw new Error(
      'subdivideTrianglesMercator: indices length must be a multiple of 3',
    );
  }
  const g = sanitizeGranularity(granularity);
  if (g === 0) {
    return {
      positions: Float64Array.from(positions as ArrayLike<number>),
      indices: Uint32Array.from(indices as ArrayLike<number>),
    };
  }

  // Growable copies; originals stay at their input indices.
  const pos: number[] = [];
  for (let i = 0; i < positions.length; i++) pos.push(positions[i]);
  const outIndices: number[] = [];

  const midpointByEdge = new Map<number, number>();
  const midpoint = (i0: number, i1: number): number => {
    const lo = i0 < i1 ? i0 : i1;
    const hi = i0 < i1 ? i1 : i0;
    const key = lo * EDGE_KEY_STRIDE + hi;
    const found = midpointByEdge.get(key);
    if (found !== undefined) return found;
    const idx = pos.length / 2;
    pos.push(
      (pos[lo * 2] + pos[hi * 2]) / 2,
      (pos[lo * 2 + 1] + pos[hi * 2 + 1]) / 2,
    );
    midpointByEdge.set(key, idx);
    return idx;
  };
  const span = (i0: number, i1: number): number =>
    mercatorSpan(pos[i0 * 2], pos[i0 * 2 + 1], pos[i1 * 2], pos[i1 * 2 + 1]);

  // Depth-first over a packed [ia, ib, ic, depth, ...] stack (no recursion).
  const stack: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    stack.push(indices[t], indices[t + 1], indices[t + 2], 0);
  }
  while (stack.length > 0) {
    const depth = stack.pop()!;
    const ic = stack.pop()!;
    const ib = stack.pop()!;
    const ia = stack.pop()!;
    const sab = span(ia, ib);
    const sbc = span(ib, ic);
    const sca = span(ic, ia);
    // Rotate so the longest edge is (i0, i1); rotation preserves winding.
    // First maximum wins ties, keeping the split deterministic.
    let i0 = ia;
    let i1 = ib;
    let i2 = ic;
    let longest = sab;
    if (sbc > longest) {
      longest = sbc;
      i0 = ib;
      i1 = ic;
      i2 = ia;
    }
    if (sca > longest) {
      longest = sca;
      i0 = ic;
      i1 = ia;
      i2 = ib;
    }
    // Same threshold rule as subdivideLineMercator (epsilon guards exact
    // multiples); NaN spans (garbage coordinates) emit rather than recurse.
    if (
      !Number.isFinite(longest) ||
      longest * g <= 1 + PIECES_EPSILON ||
      depth >= MAX_TRIANGLE_SUBDIVISION_DEPTH
    ) {
      outIndices.push(ia, ib, ic);
      continue;
    }
    const m = midpoint(i0, i1);
    stack.push(i0, m, i2, depth + 1);
    stack.push(m, i1, i2, depth + 1);
  }

  return {
    positions: Float64Array.from(pos),
    indices: Uint32Array.from(outIndices),
  };
}

/**
 * MapLibre draws wrapped world copies by rendering each tile once per `wrap`;
 * on the globe there is exactly one world, so custom layers must skip
 * `wrap !== 0` draws or geometry renders duplicated/misprojected. On mercator
 * every wrap draws.
 */
export function shouldDrawWorldCopy(wrap: number, isGlobe: boolean): boolean {
  return !isGlobe || wrap === 0;
}

/** MapLibre's base tile granularity for globe (`SubdivisionGranularitySetting`). */
const DEFAULT_BASE_GRANULARITY = 128;

/**
 * Sanity cap on host-reported granularity: subdivision cost is linear in
 * granularity for lines and quadratic for fills, so a buggy host object must
 * not be able to demand unbounded work.
 */
const GRANULARITY_CAP = 1024;

/** Structural shape of maplibre's `SubdivisionGranularityExpression`. */
interface GranularityExpressionLike {
  getGranularityForZoomLevel(zoomLevel: number): number;
}

function resolveGranularityExpression(
  like: unknown,
): GranularityExpressionLike | null {
  if (like === null || typeof like !== 'object') return null;
  const tile = (like as { tile?: unknown }).tile;
  if (
    tile !== null &&
    typeof tile === 'object' &&
    typeof (tile as GranularityExpressionLike).getGranularityForZoomLevel ===
      'function'
  ) {
    return tile as GranularityExpressionLike;
  }
  // Convenience: accept an expression object directly (e.g. a caller passing
  // `subdivisionGranularity.line` instead of the whole settings object).
  if (
    typeof (like as GranularityExpressionLike).getGranularityForZoomLevel ===
    'function'
  ) {
    return like as GranularityExpressionLike;
  }
  return null;
}

/**
 * Per-tile subdivision granularity for a zoom level.
 *
 * Structurally reads a maplibre-style settings object
 * (`map.style.projection?.subdivisionGranularity`, shape
 * `{tile: {getGranularityForZoomLevel(z)}}`) — duck-typed on purpose: the
 * package's maplibre-gl peer/types stay at ^4 while v5+ hosts are detected by
 * shape. Falls back to maplibre's own curve — base 128 halved per zoom level,
 * clamped at 1 — when the host object is absent, malformed, throws, or
 * returns garbage. Host results are floored and clamped to
 * [1, {@link GRANULARITY_CAP}].
 *
 * The result counts segments per TILE axis; multiply by `2 ** z` before
 * passing to the subdivide functions (module-header convention).
 */
export function granularityForZoom(
  subdivisionGranularityLike: unknown,
  z: number,
): number {
  // Hosts shift by the zoom level (`1 << z`), so hand them a clamped integer.
  const zi = Number.isFinite(z) ? Math.min(32, Math.max(0, Math.floor(z))) : 0;
  const expr = resolveGranularityExpression(subdivisionGranularityLike);
  if (expr) {
    try {
      const hostG = expr.getGranularityForZoomLevel(zi);
      if (typeof hostG === 'number' && Number.isFinite(hostG) && hostG >= 1) {
        return Math.min(GRANULARITY_CAP, Math.floor(hostG));
      }
    } catch {
      // Malformed host object — fall through to the default curve.
    }
  }
  return Math.max(1, Math.floor(DEFAULT_BASE_GRANULARITY / 2 ** zi));
}
