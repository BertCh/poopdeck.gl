// @poopdeck.gl/core
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/core contributors

/**
 * STT geometry kernel — framework-free, backend-neutral geometry reductions the
 * renderers share. Phase 2 seeds it with the OD endpoint derivation (byte-
 * identical across the deck and three packages before this extraction); Phase 3
 * adds `tessellateFeature` (pre-baked-triangle-aware polygon tessellation) here.
 * See docs/roadmap/renderer-architecture.md.
 */

import earcut from 'earcut';
import { GeometryType } from '../types.js';
import type { BinaryFeatures } from '../types.js';

/** Dense source/target endpoint buffers derived from a tile's LineString features. */
export interface SourceTargetPositions {
  /** Interleaved source endpoints, `featureCount * dims` long (feature i's FIRST vertex). */
  source: Float64Array;
  /** Interleaved target endpoints, `featureCount * dims` long (feature i's LAST vertex). */
  target: Float64Array;
  /** Position dimensions (2 for [lon, lat], 3 for [lon, lat, alt]). */
  dims: number;
}

/**
 * Derive dense source (first-vertex) and target (last-vertex) endpoint buffers
 * for every feature in a LineString tile — the source→target representation the
 * OD flow layers (deck ArcLayer/LineLayer, three OD-line) need. STT stores OD
 * flows as LineString features (a run of vertices addressed by `startIndices`);
 * an arc/line has only two ends, so each feature collapses to its FIRST vertex
 * (source) and LAST vertex (target); intermediate vertices are dropped.
 *
 * Float64 output so deck's fp64 position attribute populates hi/lo correctly.
 * Requires `startIndices`; callers gate on `featureCount > 0 && startIndices`.
 * A single-vertex feature degenerates to source === target.
 */
export function deriveSourceTargetPositions(
  binary: BinaryFeatures,
): SourceTargetPositions {
  const dims = binary.positionDimensions ?? 2;
  const featureCount = binary.featureCount;
  const startIndices = binary.startIndices!;
  const positions = binary.positions;

  const source = new Float64Array(featureCount * dims);
  const target = new Float64Array(featureCount * dims);

  for (let i = 0; i < featureCount; i++) {
    // First vertex of feature i is the source; the last (one before the next
    // feature's start) is the target. startIndices has length featureCount + 1.
    const srcVertex = startIndices[i];
    const tgtVertex = startIndices[i + 1] - 1;
    const srcBase = srcVertex * dims;
    const tgtBase = tgtVertex * dims;
    const outBase = i * dims;
    for (let d = 0; d < dims; d++) {
      source[outBase + d] = positions[srcBase + d];
      target[outBase + d] = positions[tgtBase + d];
    }
  }

  return { source, target, dims };
}

/**
 * True when `boundaries` (an ascending nested boundary array — `ringIndices` or
 * `partIndices`) puts no break STRICTLY inside `(vStart, vEnd)`.
 *
 * Both arrays are documented to contain every feature boundary, so the values
 * at the feature's own ends are expected and not breaks.
 */
function hasNoInteriorBreak(
  boundaries: Uint32Array,
  vStart: number,
  vEnd: number,
): boolean {
  // First boundary strictly greater than vStart (binary search: ascending).
  let lo = 0;
  let hi = boundaries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (boundaries[mid] <= vStart) lo = mid + 1;
    else hi = mid;
  }
  return lo >= boundaries.length || boundaries[lo] >= vEnd;
}

/**
 * Whether the vertex run `[vStart, vEnd)` is provably a single ring — one
 * exterior, no holes, no additional parts.
 *
 * ABSENT `ringIndices` PROVES NOTHING and so answers `false`. That asymmetry is
 * the whole safety property: see the corruption note on
 * {@link tessellateFeature}.
 *
 * Shared by the decoder's triangle backfill and by `tessellateFeature`, so the
 * "is it safe to earcut this as one loop?" question has exactly one answer in
 * the codebase.
 */
export function isSingleRingRun(
  ringIndices: Uint32Array | undefined,
  partIndices: Uint32Array | undefined,
  vStart: number,
  vEnd: number,
): boolean {
  if (!ringIndices) return false;
  if (!hasNoInteriorBreak(ringIndices, vStart, vEnd)) return false;
  // partIndices is coarser than ringIndices, so a part break inside the run
  // implies a ring break inside it and the check above already returned. Test it
  // anyway: the nesting is a documented contract, not something to lean on when
  // the cost of being wrong is a silently filled hole.
  if (partIndices && !hasNoInteriorBreak(partIndices, vStart, vEnd))
    return false;
  return true;
}

/**
 * Earcut the vertex run `[vStart, vEnd)` of `positions`, returning GLOBAL
 * indices (already shifted by `vStart`). `null` for a degenerate run.
 *
 * The caller is responsible for having established that the run is one ring —
 * {@link isSingleRingRun}.
 */
export function earcutRun(
  positions: Float64Array,
  dims: number,
  vStart: number,
  vEnd: number,
): Uint32Array | null {
  const ringLen = vEnd - vStart;
  if (ringLen < 3) return null;
  // Flat 2D coords for earcut (topology is unaffected by dropping z).
  const flat = new Float64Array(ringLen * 2);
  for (let i = 0; i < ringLen; i++) {
    flat[i * 2] = positions[(vStart + i) * dims];
    flat[i * 2 + 1] = positions[(vStart + i) * dims + 1];
  }
  const local = earcut(flat, undefined, 2);
  const out = new Uint32Array(local.length);
  for (let i = 0; i < local.length; i++) out[i] = local[i] + vStart; // local → global
  return out;
}

/**
 * Whether feature `featureIndex` is provably a single ring.
 */
function isProvablySingleRing(
  binary: BinaryFeatures,
  featureIndex: number,
): boolean {
  const startIndices = binary.startIndices;
  if (!startIndices) return false;
  return isSingleRingRun(
    binary.ringIndices,
    binary.partIndices,
    startIndices[featureIndex],
    startIndices[featureIndex + 1],
  );
}

/**
 * Tessellate one polygon feature into GLOBAL triangle indices (into the tile's
 * `positions` vertices), the single dispatch every backend shares:
 *
 *  - When the tile carries pre-baked `triangles`/`triangleOffsets` (built with
 *    `--pre-tessellate`; the TS decoder already pre-shifts them to global
 *    indices) AND `preferPrebaked` (default), return that feature's slice — the
 *    holes-correct, multi-ring-correct path deck and three already use.
 *  - Otherwise fall back to earcutting the feature's SINGLE ring
 *    (`startIndices[f] … startIndices[f+1]`), matching maplibre's current
 *    fallback. (Multi-ring earcut needs a `holeIndices` field STT does not yet
 *    emit — the multi-ring case is handled by build-time baking above.)
 *
 * TB-12 — DECODER-SIDE BACKFILL. A pre-baked list may now be EMPTY for a
 * feature the builder chose not to bake (`triangles-partial`). When that
 * feature is provably single-ring we earcut it here instead of returning the
 * empty slice, which is what relaxes the reader contract from layer-global to
 * per-feature for all three backends at once — they all read this output.
 *
 * "Provably" is load-bearing and deliberately conservative: an empty list on a
 * HOLED or MULTI-PART feature must stay empty, because earcutting its rings as
 * one flat loop renders the holes FILLED — a silent corruption, not a visible
 * failure. So we backfill only when {@link BinaryFeatures.ringIndices} is
 * present AND shows no ring break strictly inside the feature (and likewise for
 * `partIndices`). A tile whose reader predates those columns cannot prove
 * anything, so it keeps the empty list.
 *
 * Returns `null` when the feature has no polygon geometry. Indices are `Uint32`
 * (a returned pre-baked `Uint32Array` is a zero-copy subarray view).
 */
export function tessellateFeature(
  binary: BinaryFeatures,
  featureIndex: number,
  opts: { preferPrebaked?: boolean } = {},
): Uint32Array | null {
  const preferPrebaked = opts.preferPrebaked !== false;
  if (preferPrebaked && binary.triangles && binary.triangleOffsets) {
    const start = binary.triangleOffsets[featureIndex];
    const end = binary.triangleOffsets[featureIndex + 1];
    if (end > start) return binary.triangles.subarray(start, end);
    // Empty baked list: backfill only if we can PROVE the feature is one ring.
    if (!isProvablySingleRing(binary, featureIndex)) {
      return binary.triangles.subarray(start, end);
    }
    // fall through to the earcut path below
  }

  const startIndices = binary.startIndices;
  if (!startIndices) return null;
  return earcutRun(
    binary.positions,
    binary.positionDimensions ?? 2,
    startIndices[featureIndex],
    startIndices[featureIndex + 1],
  );
}

/**
 * Slop (degrees) allowed on top of half a quantization step when testing
 * whether a vertex sits ON a tile-boundary meridian/parallel.
 *
 * The builder's Sutherland–Hodgman clipper writes a seam vertex as
 * `prev + t·(cur − prev)` with `t = (bound − prev)/(cur − prev)`, which equals
 * `bound` in exact arithmetic but lands a couple of ULPs off in f64. 1e-9° is
 * ~0.1 mm — four orders of magnitude above that error and far below any real
 * geometry resolution, so it cannot pull an unrelated vertex onto the line.
 */
const SEAM_FLOAT_SLOP_DEG = 1e-9;

/** Web-Mercator tile bounds in WGS84 degrees. */
function tileBoundsDegrees(
  z: number,
  x: number,
  y: number,
): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
  const n = 2 ** z;
  const lat = (ty: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / n))) * 180) / Math.PI;
  return {
    minLon: (x / n) * 360 - 180,
    maxLon: ((x + 1) / n) * 360 - 180,
    minLat: lat(y + 1),
    maxLat: lat(y),
  };
}

/**
 * Per-vertex side-wall mask for an EXTRUDED polygon tile: `1` where the edge
 * from vertex `i` to vertex `i + 1` is a real polygon edge that should grow a
 * wall, `0` where it must be skipped.
 *
 * This is deck.gl's `instanceVertexValid` convention verbatim (its side model
 * reads vertex `i` and `i + 1` from one buffer offset by a vertex, so the mask
 * lives on the FIRST vertex of each edge), which lets the deck path feed the
 * result straight in as a binary attribute; the three / maplibre wall builders
 * consume the same array as a skip test.
 *
 * Two classes of edge are suppressed:
 *
 *  1. **Ring closures.** The last vertex of every ring has no successor inside
 *     that ring — without the break, an edge is stitched from the end of the
 *     exterior to the start of the first hole (and from the end of one feature
 *     to the start of the next), dragging a wall straight across the polygon.
 *     Needs {@link BinaryFeatures.ringIndices}; with only `startIndices` the
 *     mask degrades to feature-level breaks (deck's own default behaviour).
 *
 *  2. **Tile-cut edges** — the reason this exists. `stt-build` clips polygon
 *     coverage to each tile rect exactly (`polygon_buffer_degrees: 0`), so a
 *     polygon spanning a tile boundary is stored as two pieces that each gain
 *     a SYNTHETIC edge running along the shared boundary. Those edges are not
 *     part of the polygon; extruding them raises a full-height curtain along
 *     every tile boundary the shape crosses, which is what makes the tile grid
 *     read through big translucent extruded fills (the storm-4d cloud-top
 *     canopy is the canonical case). An edge whose BOTH endpoints lie on the
 *     same boundary line of this tile is such a cut, and gets no wall — the
 *     abutting tile's piece continues the surface there.
 *
 * The on-the-line tolerance is half the archive's coordinate-quantization step
 * ({@link BinaryFeatures.coordQuantStep}) plus float slop: quantization snaps
 * seam vertices to the nearest world-anchored grid point, identically on both
 * sides (which is what keeps the fills watertight), so they sit up to half a
 * step off the true boundary. A real edge running along a tile boundary within
 * that tolerance also loses its wall — it is sub-quantum from the seam, so the
 * wall it would draw is not resolvable anyway.
 *
 * `wrapLastEdge` picks which convention the LAST slot of each ring follows.
 * deck (default, `false`) reads the mask as "edge i → i + 1" in linear vertex
 * order, so a ring's final slot has no edge at all and is always `0`. Builders
 * that instead wrap the ring (three's `kn = (k + 1) % ringLen`) pass `true`:
 * the final slot then describes the closing edge back to the ring's first
 * vertex, and is masked only when that edge is degenerate (a GeoJSON-closed
 * ring, whose last vertex repeats the first) or is itself a tile cut.
 *
 * Returns `null` for non-polygon tiles or when `startIndices` is missing;
 * callers should then leave the renderer's own default masking in place.
 */
export function computePolygonWallMask(
  binary: BinaryFeatures,
  tile: { z: number; x: number; y: number },
  opts: { wrapLastEdge?: boolean } = {},
): Uint16Array | null {
  if (binary.geometryType !== GeometryType.Polygon) return null;
  const startIndices = binary.startIndices;
  if (!startIndices) return null;

  const dims = binary.positionDimensions ?? 2;
  const positions = binary.positions;
  const vertexCount = (positions.length / dims) | 0;
  if (vertexCount === 0) return null;

  const wrapLastEdge = !!opts.wrapLastEdge;
  const { minLon, maxLon, minLat, maxLat } = tileBoundsDegrees(
    tile.z,
    tile.x,
    tile.y,
  );
  const [stepX, stepY] = binary.coordQuantStep ?? [0, 0];
  const epsX = stepX / 2 + SEAM_FLOAT_SLOP_DEG;
  const epsY = stepY / 2 + SEAM_FLOAT_SLOP_DEG;

  /** True when the edge `a → b` runs along one of this tile's four boundaries. */
  const isTileCut = (a: number, b: number): boolean => {
    const ax = positions[a * dims];
    const ay = positions[a * dims + 1];
    const bx = positions[b * dims];
    const by = positions[b * dims + 1];
    return (
      (Math.abs(ax - minLon) <= epsX && Math.abs(bx - minLon) <= epsX) ||
      (Math.abs(ax - maxLon) <= epsX && Math.abs(bx - maxLon) <= epsX) ||
      (Math.abs(ay - minLat) <= epsY && Math.abs(by - minLat) <= epsY) ||
      (Math.abs(ay - maxLat) <= epsY && Math.abs(by - maxLat) <= epsY)
    );
  };

  const mask = new Uint16Array(vertexCount);
  // `ringIndices` carries every feature boundary too, so it subsumes
  // `startIndices` when present; without it the rings collapse to features,
  // which is exactly what deck's own updater can see on the binary path.
  const breaks = binary.ringIndices ?? startIndices;
  for (let r = 1; r < breaks.length; r++) {
    const ringStart = breaks[r - 1];
    const ringEnd = Math.min(breaks[r], vertexCount);
    if (ringEnd <= ringStart) continue;
    // Interior edges, in linear vertex order.
    for (let i = ringStart; i < ringEnd - 1; i++) {
      mask[i] = isTileCut(i, i + 1) ? 0 : 1;
    }
    // The ring's final slot: no edge (deck) or the closing edge (wrapping
    // builders), which a GeoJSON-closed ring makes degenerate.
    const last = ringEnd - 1;
    const closed =
      positions[last * dims] === positions[ringStart * dims] &&
      positions[last * dims + 1] === positions[ringStart * dims + 1];
    mask[last] = wrapLastEdge && !closed && !isTileCut(last, ringStart) ? 1 : 0;
  }

  return mask;
}
