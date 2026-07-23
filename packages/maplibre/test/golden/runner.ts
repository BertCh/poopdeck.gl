/**
 * A small, dependency-light HARNESS for the maplibre-backend correctness
 * contract (`../golden-correctness.test.ts`).
 *
 * It holds the reusable "how do we check this property" helpers so the contract
 * test reads as a list of invariants rather than a wall of arithmetic:
 *
 *   - `windowEdges` — resolve half-window edges from a playhead + timeWindow,
 *     the way every time-filtered layer does before it calls the window kernel.
 *   - `inspectRing` — the geometric facts a summary/cell ring must satisfy
 *     (closed, canonical winding, seam containment), computed independently of
 *     the kernel that produced the ring.
 *   - `quantizationRoundTrip` — simulate the GPU's own normalized-uint16 decode
 *     (`q / 65535`) and report the reconstruction error in mercator units AND
 *     in ground metres, so the "no visible loss" claim gets a number.
 *
 * These are the CPU stand-ins for a GPU we do not have in CI: the shaders read
 * the same JS reference formulae (`decodeMercatorPosJS`, the time/flow refs),
 * so exercising the refs here is exercising the contract the GLSL must meet.
 * Nothing here imports GL or a map.
 */

import {
  quantizePositionsToUint16,
  latFromMercatorY,
  metersPerMercatorUnit,
} from '../../src/lib/projection.js';
import { decodeMercatorPosJS } from '../../src/shaders/position-quantization.glsl.js';
import { ringSignedArea2 } from '../../src/lib/cell-geometry.js';

/**
 * Half-window edges from a playhead, mirroring `resolveTimeFilterParams`:
 * `[currentTime − timeWindow/2, currentTime + timeWindow/2]`. The window kernel
 * takes edges, so this is where the DISCARD boundary is defined.
 */
export function windowEdges(
  currentTime: number,
  timeWindow: number,
): [number, number] {
  const half = timeWindow / 2;
  return [currentTime - half, currentTime + half];
}

/** Geometric facts about a flat-xy ring, computed WITHOUT the producing kernel. */
export interface RingFacts {
  /** Distinct rim vertices (excludes a trailing closing duplicate). */
  rimVertices: number;
  /** The ring repeats its first vertex at the end. */
  closed: boolean;
  /** Twice the signed shoelace area (mercator, y-south frame). */
  area2: number;
  /** Canonical orientation of this module: positive shoelace area. */
  positiveWinding: boolean;
  minX: number;
  maxX: number;
  /** `maxX − minX` — a contiguous (non-smeared) seam ring keeps this small. */
  xSpan: number;
  /** Every vertex sits inside the mercator unit square. */
  withinUnitSquare: boolean;
}

/**
 * Inspect a CLOSED flat-xy ring (`[x0, y0, x1, y1, …]`). Returns `null` for a
 * ring with fewer than 3 rim vertices (the kernels return `null` there too).
 */
export function inspectRing(ring: ArrayLike<number> | null): RingFacts | null {
  if (!ring) return null;
  const n = ring.length >> 1;
  if (n < 3) return null;
  const firstX = ring[0];
  const firstY = ring[1];
  const lastX = ring[(n - 1) * 2];
  const lastY = ring[(n - 1) * 2 + 1];
  const closed = firstX === lastX && firstY === lastY;
  const rimVertices = closed ? n - 1 : n;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = ring[i * 2];
    const y = ring[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const area2 = ringSignedArea2(ring);
  return {
    rimVertices,
    closed,
    area2,
    positiveWinding: area2 >= 0,
    minX,
    maxX,
    xSpan: maxX - minX,
    withinUnitSquare: minX >= 0 && maxX <= 1 && minY >= 0 && maxY <= 1,
  };
}

/** Per-axis and ground reconstruction error of the uint16 position round trip. */
export interface RoundTripError {
  /** Worst absolute mercator error on each axis, across all vertices. */
  maxAxisMercator: [number, number, number];
  /** Worst ground error in metres (x/y axes, at each vertex's own latitude). */
  maxGroundMeters: number;
  /** One quantization step per axis (`scale / 65535`) — the error ceiling. */
  stepMercator: [number, number, number];
  /** The uint16 buffer, so a caller can assert the extremes hit 0 / 65535. */
  quantized: Uint16Array;
}

/**
 * Round-trip a stride-3 mercator buffer through `quantizePositionsToUint16` and
 * the GPU's own normalized-uint16 decode (`q / 65535` — what `normalized: true`
 * in `vertexAttribPointer` produces before the shader runs), then
 * `sttDecodeMercatorPos`. Reports the reconstruction error so the contract can
 * assert it stays inside one quantization step and sub-millimetre on the ground.
 */
export function quantizationRoundTrip(projected: Float32Array): RoundTripError {
  const { quantized, scale, offset } = quantizePositionsToUint16(projected);
  const n = projected.length / 3;
  const maxAxisMercator: [number, number, number] = [0, 0, 0];
  let maxGroundMeters = 0;
  for (let i = 0; i < n; i++) {
    const normalized: [number, number, number] = [
      quantized[i * 3] / 65535,
      quantized[i * 3 + 1] / 65535,
      quantized[i * 3 + 2] / 65535,
    ];
    const decoded = decodeMercatorPosJS(normalized, scale, offset);
    const ex = Math.abs(decoded[0] - projected[i * 3]);
    const ey = Math.abs(decoded[1] - projected[i * 3 + 1]);
    const ez = Math.abs(decoded[2] - projected[i * 3 + 2]);
    if (ex > maxAxisMercator[0]) maxAxisMercator[0] = ex;
    if (ey > maxAxisMercator[1]) maxAxisMercator[1] = ey;
    if (ez > maxAxisMercator[2]) maxAxisMercator[2] = ez;
    // Ground metres: horizontal error scaled by the mercator stretch at this
    // vertex's own latitude (x and y share the factor).
    const mPerUnit = metersPerMercatorUnit(latFromMercatorY(decoded[1]));
    const ground = Math.hypot(ex, ey) * mPerUnit;
    if (ground > maxGroundMeters) maxGroundMeters = ground;
  }
  return {
    maxAxisMercator,
    maxGroundMeters,
    stepMercator: [scale[0] / 65535, scale[1] / 65535, scale[2] / 65535],
    quantized,
  };
}
