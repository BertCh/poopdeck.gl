/**
 * Ego-vehicle deck layers for the AV cockpit (av-cockpit.md §2 R1.6).
 *
 * Builds two plain deck layers from the lightweight `scene.streams.ego.path`
 * (`[{ t, lon, lat }]`, already shipped) — NOT tile layers; the Lead appends
 * them to the deck in {@link AvDeck} alongside the STT layer tree, driving them
 * off the live clock:
 *
 *   • {@link buildEgoFootprintLayer} — a single oriented car footprint at the
 *     interpolated ego position/heading at `time` (`SimpleMeshLayer` over a unit
 *     cube, `getScale:[4.6,1.9,1.5]` m).
 *   • {@link buildEgoPathLayer} — a tapering bright ribbon of the ego positions
 *     in `[time, time + aheadMs]` (openpilot's predicted-path look).
 *
 * Position + heading are interpolated between the two bracketing `ego.path`
 * samples ({@link egoSampleAt} / {@link egoHeadingAt}). These are pure functions;
 * the caller honours reduced motion (passes a frozen `time`, or omits them).
 *
 * The unit cube is a plain `MeshAttributes` object so we don't pull in
 * `@luma.gl/engine` (not a showcase dep) for `CubeGeometry`. It spans ±0.5 on
 * each axis (one unit edge-to-edge), so `getScale:[L,W,H]` maps directly to a
 * box of L×W×H metres.
 */
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { PathLayer } from '@deck.gl/layers';
import type { ColorRGBA } from '../../types';

/** One ego polyline vertex (`scene.streams.ego.path`). */
export interface EgoPathPoint {
  t: number;
  lon: number;
  lat: number;
}

/** An interpolated ego pose: position (lon/lat) + heading in degrees. */
export interface EgoPose {
  longitude: number;
  latitude: number;
  /** Heading in degrees, 0 = east (+x), CCW positive — the SimpleMeshLayer yaw. */
  headingDeg: number;
}

const DEFAULT_EGO_COLOR: ColorRGBA = [94, 212, 255, 235];
const DEFAULT_AHEAD_MS = 5000;
/** Car footprint in metres (length × width × height). */
const CAR_SCALE: [number, number, number] = [4.6, 1.9, 1.5];

/**
 * Largest index `i` with `path[i].t <= t`, or -1 if `t` precedes the first
 * vertex. Plain binary search over the time-sorted polyline (matches the
 * sampler convention in sceneTypes.ts).
 */
function indexAtOrBefore(path: ArrayLike<EgoPathPoint>, t: number): number {
  let lo = 0;
  let hi = path.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (path[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Heading in degrees (0 = east, CCW) from point `a`→`b`, accounting for lat. */
function bearingDeg(a: EgoPathPoint, b: EgoPathPoint): number {
  // Equirectangular delta in metres-ish units: scale lon by cos(lat) so the
  // heading is geometrically correct away from the equator.
  const latRad = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const dx = (b.lon - a.lon) * Math.cos(latRad);
  const dy = b.lat - a.lat;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * Interpolated ego pose at `time`: linearly between the two bracketing
 * `ego.path` samples, heading from the local direction of travel. Returns null
 * for an empty path; clamps to the endpoints outside the path's time range.
 */
export function egoSampleAt(
  path: EgoPathPoint[] | null | undefined,
  time: number,
): EgoPose | null {
  if (!path || path.length === 0) return null;
  if (path.length === 1) {
    return { longitude: path[0].lon, latitude: path[0].lat, headingDeg: 0 };
  }
  const i = indexAtOrBefore(path, time);
  // Clamp the bracketing pair into range so we always have an a→b segment.
  const ai = i < 0 ? 0 : Math.min(i, path.length - 2);
  const a = path[ai];
  const b = path[ai + 1];
  const span = b.t - a.t || 1;
  const f = Math.min(1, Math.max(0, (time - a.t) / span));
  return {
    longitude: a.lon + (b.lon - a.lon) * f,
    latitude: a.lat + (b.lat - a.lat) * f,
    headingDeg: bearingDeg(a, b),
  };
}

/**
 * Heading in degrees (0 = east, CCW) at `time` — the local direction of travel
 * along the ego path. 0 for an empty/degenerate path.
 */
export function egoHeadingAt(
  path: EgoPathPoint[] | null | undefined,
  time: number,
): number {
  return egoSampleAt(path, time)?.headingDeg ?? 0;
}

// ── Unit cube (plain MeshAttributes; no @luma.gl/engine dep) ────────────────
// 24 vertices (4 per face) so each face gets its own outward normal for clean
// phong shading; spans ±0.5 → getScale:[L,W,H] yields an L×W×H box.
const UNIT_CUBE = (() => {
  // prettier-ignore
  const positions = new Float32Array([
    // +z (top)
    -0.5,-0.5, 0.5,  0.5,-0.5, 0.5,  0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    // -z (bottom)
    -0.5,-0.5,-0.5, -0.5, 0.5,-0.5,  0.5, 0.5,-0.5,  0.5,-0.5,-0.5,
    // +x
     0.5,-0.5,-0.5,  0.5, 0.5,-0.5,  0.5, 0.5, 0.5,  0.5,-0.5, 0.5,
    // -x
    -0.5,-0.5,-0.5, -0.5,-0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5,-0.5,
    // +y
    -0.5, 0.5,-0.5, -0.5, 0.5, 0.5,  0.5, 0.5, 0.5,  0.5, 0.5,-0.5,
    // -y
    -0.5,-0.5,-0.5,  0.5,-0.5,-0.5,  0.5,-0.5, 0.5, -0.5,-0.5, 0.5,
  ]);
  // prettier-ignore
  const normals = new Float32Array([
    0,0,1, 0,0,1, 0,0,1, 0,0,1,
    0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
    1,0,0, 1,0,0, 1,0,0, 1,0,0,
    -1,0,0, -1,0,0, -1,0,0, -1,0,0,
    0,1,0, 0,1,0, 0,1,0, 0,1,0,
    0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
  ]);
  // Two triangles per face, winding CCW for outward-facing fronts.
  const indices = new Uint16Array(36);
  for (let f = 0; f < 6; f++) {
    const o = f * 4;
    const i = f * 6;
    indices[i] = o;
    indices[i + 1] = o + 1;
    indices[i + 2] = o + 2;
    indices[i + 3] = o;
    indices[i + 4] = o + 2;
    indices[i + 5] = o + 3;
  }
  return {
    attributes: {
      positions: { value: positions, size: 3 },
      normals: { value: normals, size: 3 },
    },
    indices: { value: indices, size: 1 },
  };
})();

export interface EgoFootprintOptions {
  path: EgoPathPoint[] | null | undefined;
  time: number;
  color?: ColorRGBA;
  id?: string;
}

/**
 * A single oriented car footprint at the interpolated ego pose at `time`.
 * `getScale:[4.6,1.9,1.5]` m, `getOrientation:[0,0,headingDeg]` (yaw). Renders
 * nothing (empty data) when the path is empty so the caller can append it
 * unconditionally.
 */
export function buildEgoFootprintLayer({
  path,
  time,
  color = DEFAULT_EGO_COLOR,
  id = 'ego-footprint',
}: EgoFootprintOptions): SimpleMeshLayer {
  const pose = egoSampleAt(path, time);
  const data = pose ? [pose] : [];
  return new SimpleMeshLayer<EgoPose>({
    id,
    data,
    mesh: UNIT_CUBE as any,
    getPosition: (d: EgoPose) => [d.longitude, d.latitude, CAR_SCALE[2] / 2],
    getColor: () => color,
    // SimpleMeshLayer orientation is [pitch, yaw, roll]; ego heading is yaw.
    getOrientation: (d: EgoPose) => [0, d.headingDeg, 0],
    getScale: () => CAR_SCALE,
    // Lit so the box reads as a 3D volume against the dark basemap.
    material: { ambient: 0.45, diffuse: 0.6, shininess: 32 },
    // Per-tick reposition: the data array identity changes each call.
    updateTriggers: { getPosition: [time], getOrientation: [time] },
    parameters: { depthTest: true } as any,
  });
}

export interface EgoPathOptions {
  path: EgoPathPoint[] | null | undefined;
  time: number;
  /** Look-ahead horizon in ms (default ~5 s). */
  aheadMs?: number;
  color?: ColorRGBA;
  id?: string;
}

/**
 * The predicted-path ribbon: the ego positions in `[time, time + aheadMs]` as a
 * single tapering PathLayer trace ahead of the car. The ribbon narrows toward
 * the far end (width in metres) and fades to transparent, openpilot-style.
 *
 * Implemented as per-segment sublines so width + alpha can taper along the
 * path (a single PathLayer path takes one width); each segment is one `path`
 * pair carrying its own width/colour by horizon fraction.
 */
export function buildEgoPathLayer({
  path,
  time,
  aheadMs = DEFAULT_AHEAD_MS,
  color = DEFAULT_EGO_COLOR,
  id = 'ego-path',
}: EgoPathOptions): PathLayer {
  const horizon = time + aheadMs;
  const pts: EgoPathPoint[] = [];

  // Start exactly at the (interpolated) current ego position so the ribbon
  // emanates from the car, then take every real vertex inside the horizon, then
  // cap with the interpolated horizon endpoint.
  const head = egoSampleAt(path, time);
  if (head) pts.push({ t: time, lon: head.longitude, lat: head.latitude });
  if (path && path.length > 0) {
    for (const p of path) {
      if (p.t > time && p.t < horizon) pts.push(p);
    }
    const tail = egoSampleAt(path, horizon);
    if (tail) pts.push({ t: horizon, lon: tail.longitude, lat: tail.latitude });
  }

  // Build tapering segments: width shrinks and alpha fades along the horizon.
  const W_NEAR = 1.8; // metres
  const W_FAR = 0.4;
  type Seg = { path: [number, number][]; width: number; color: ColorRGBA };
  const segments: Seg[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const f = pts.length > 1 ? i / (pts.length - 1) : 0; // 0 near → 1 far
    const width = W_NEAR + (W_FAR - W_NEAR) * f;
    const alpha = Math.round((color[3] ?? 235) * (1 - 0.85 * f));
    segments.push({
      path: [
        [pts[i].lon, pts[i].lat],
        [pts[i + 1].lon, pts[i + 1].lat],
      ],
      width,
      color: [color[0], color[1], color[2], alpha],
    });
  }

  return new PathLayer<Seg>({
    id,
    data: segments,
    getPath: (d: Seg) => d.path,
    getColor: (d: Seg) => d.color,
    getWidth: (d: Seg) => d.width,
    widthUnits: 'meters',
    widthMinPixels: 1,
    capRounded: true,
    jointRounded: true,
    parameters: { depthTest: false } as any,
    updateTriggers: { getPath: [time, aheadMs] },
  });
}
