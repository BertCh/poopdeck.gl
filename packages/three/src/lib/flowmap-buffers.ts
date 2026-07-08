// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) assembly of flowmap **arrow + node-circle** buffers from
 * decoded OD-flow tiles — the Three port of deck's `FlowmapLayer`
 * (`packages/layers/.../summary/flowmap-layer.ts`). Feeds
 * {@link createFlowArrowMaterial} (tapered half-arrows) and a node-circle splat.
 *
 * Each LineString feature is one OD flow: it collapses to its FIRST vertex
 * (source) and LAST vertex (target). The trip volume at the playhead comes from
 * the tile's `vertexValueMatrix` (`[globalVertex × numBuckets]`, vertex-major):
 * the active bucket is linearly blended across a sub-step, sampled at the
 * feature's SOURCE vertex, and mapped to arrow width `widthScale·√flow` in
 * pixels. Sub-minFlow flows get width 0 → the arrow vanishes (that IS the
 * animation). Incident flow accumulates at both endpoints → node-circle radii
 * (and the endpoint insets that pull each arrowhead to the circle edge).
 *
 * **RTC**: source/target endpoints and node-circle centres are written f32
 * RELATIVE to a per-build `origin` (the first feature's source vertex,
 * projected); the layer sets `object.position = origin` so the large
 * mercator/globe magnitude lives in the f64 CPU transform, not the f32 buffer.
 * For the ENU/AV frame the origin is tiny and this is a no-op.
 *
 * Time-dependent: the WIDTH + node aggregation depend on `currentTime` (the
 * absolute playhead). Geometry (endpoints) is invariant, so a layer may cache
 * the endpoints and only re-run this builder when the playhead crosses a
 * sub-step — but the builder is cheap (one pass) and re-runnable as a whole.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import type { Projection } from '../projection/local-enu.js';

export interface FlowmapBufferOptions {
  /** Arrow width in px per unit of `√(currentBucketFlow)`. @default 1.1 */
  widthScale?: number;
  /** Node circle radius in px per unit of `√(incidentFlow)`. @default 1.3 */
  nodeRadiusScale?: number;
  /** Clamp node radius (px). @default 1.5 */
  nodeRadiusMinPixels?: number;
  /** Clamp node radius (px). @default 28 */
  nodeRadiusMaxPixels?: number;
  /**
   * Hide arcs/nodes whose current flow is below this many trips — squelches
   * sub-bucket blend noise so the map reads cleanly. @default 0.25
   */
  minFlow?: number;
}

export interface FlowmapBuffers {
  /** Number of arrow instances (OD flows). */
  count: number;
  posSource: Float32Array; // vec3, RTC-local
  posTarget: Float32Array; // vec3, RTC-local
  /** Per-flow arrow width in pixels (`widthScale·√flow`; 0 when squelched). */
  widths: Float32Array; // float
  /** Per-flow `[sourceInset, targetInset]` in px (= each endpoint's node radius). */
  endpointOffsets: Float32Array; // vec2
  /** Number of node circles. */
  nodeCount: number;
  /** Node-circle centres, vec3 RTC-local. */
  nodeCenters: Float32Array; // vec3
  /** Node-circle radii in pixels (clamped to [min,max]). */
  nodeRadii: Float32Array; // float
  /** RTC origin (absolute projected world coords) shared by all buffers. */
  origin: [number, number, number];
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
}

/** Quantized node key (~1 m) so the same dock collapses across tiles. */
function nodeKey(lon: number, lat: number): string {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

/**
 * Continuous bucket position in `[0, nb-1]` for an absolute time, from a tile's
 * own axis (matches deck `FlowmapLayer.posFromBinary`). `null` when the tile
 * carries no matrix.
 */
function posFromBinary(binary: BinaryFeatures, time: number): number | null {
  const nb = binary.vertexValueBuckets ?? 0;
  if (nb <= 0 || !binary.startTimes || binary.startTimes.length === 0)
    return null;
  const rel0 = binary.startTimes[0];
  const span = binary.endTimes[0] - rel0;
  if (span <= 0) return null;
  const width = span / nb;
  let pos = (time - binary.timeOffset - rel0) / width;
  if (pos < 0) pos = 0;
  const maxPos = nb - 1;
  if (pos > maxPos) pos = maxPos;
  return pos;
}

function collectOdLayers(tiles: Tile[]): {
  layers: BinaryFeatures[];
  total: number;
} {
  const layers: BinaryFeatures[] = [];
  let total = 0;
  for (const tile of tiles) {
    for (const tl of tile.layers) {
      const b = tl.features;
      if (
        !b.featureCount ||
        b.geometryType !== GeometryType.LineString ||
        !b.startIndices
      )
        continue;
      layers.push(b);
      total += b.featureCount;
    }
  }
  return { layers, total };
}

function emptyBuffers(): FlowmapBuffers {
  return {
    count: 0,
    posSource: new Float32Array(0),
    posTarget: new Float32Array(0),
    widths: new Float32Array(0),
    endpointOffsets: new Float32Array(0),
    nodeCount: 0,
    nodeCenters: new Float32Array(0),
    nodeRadii: new Float32Array(0),
    origin: [0, 0, 0],
    bbox: null,
  };
}

/**
 * Build flowmap arrow + node buffers for the playhead `currentTime` (absolute
 * epoch-ms). Source/target endpoints are RTC-relative to `origin`; arrow widths
 * and node radii reflect the blended current bucket of the value matrix.
 */
export function buildFlowmapBuffers(
  tiles: Tile[],
  projection: Projection,
  currentTime: number,
  opts: FlowmapBufferOptions = {},
): FlowmapBuffers {
  const { layers, total } = collectOdLayers(tiles);
  if (total === 0) return emptyBuffers();

  const widthScale = opts.widthScale ?? 1.1;
  const nodeRadiusScale = opts.nodeRadiusScale ?? 1.3;
  const rmin = opts.nodeRadiusMinPixels ?? 1.5;
  const rmax = opts.nodeRadiusMaxPixels ?? 28;
  const minFlow = opts.minFlow ?? 0.25;

  // RTC origin = first feature's SOURCE vertex, projected (absolute world).
  const first = layers[0];
  const fdims = first.positionDimensions ?? 2;
  const fAlt = fdims > 2 ? first.positions[2] : 0;
  const origin = projection.project(
    first.positions[0],
    first.positions[1],
    fAlt,
  );
  const [ox, oy, oz] = origin;

  const posSource = new Float32Array(total * 3);
  const posTarget = new Float32Array(total * 3);
  const widths = new Float32Array(total);
  // Cache the world (RTC) coords + a node key per endpoint so node aggregation
  // and the per-flow endpoint-offset lookup share the SAME quantized identity.
  const srcKey: string[] = new Array(total);
  const tgtKey: string[] = new Array(total);

  // node key → { center (RTC vec3), accumulated incident flow }.
  const nodeFlow = new Map<
    string,
    { cx: number; cy: number; cz: number; flow: number }
  >();

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  const bump = (x: number, y: number, z: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  };

  let o = 0; // global flow index across tiles
  for (const b of layers) {
    const dims = b.positionDimensions ?? fdims;
    const si = b.startIndices!;
    const nb = b.vertexValueBuckets ?? 0;
    const matrix = b.vertexValueMatrix;

    // Blended bucket weights for this tile's axis (quantized to a sub-step grid
    // is the layer's caching concern; here we sample the raw continuous pos).
    const pos = posFromBinary(b, currentTime) ?? 0;
    const b0 = Math.floor(pos);
    const b1 = nb > 0 ? Math.min(b0 + 1, nb - 1) : b0;
    const f = pos - b0;
    const g = 1 - f;

    for (let i = 0; i < b.featureCount; i++) {
      const j = o + i;
      const vSrc = si[i];
      const vTgt = si[i + 1] - 1;
      const srcLon = b.positions[vSrc * dims];
      const srcLat = b.positions[vSrc * dims + 1];
      const srcAlt = dims > 2 ? b.positions[vSrc * dims + 2] : 0;
      const tgtLon = b.positions[vTgt * dims];
      const tgtLat = b.positions[vTgt * dims + 1];
      const tgtAlt = dims > 2 ? b.positions[vTgt * dims + 2] : 0;

      const ps = projection.project(srcLon, srcLat, srcAlt);
      const pt = projection.project(tgtLon, tgtLat, tgtAlt);
      const sx = ps[0] - ox,
        sy = ps[1] - oy,
        sz = ps[2] - oz;
      const tx = pt[0] - ox,
        ty = pt[1] - oy,
        tz = pt[2] - oz;
      posSource[j * 3] = sx;
      posSource[j * 3 + 1] = sy;
      posSource[j * 3 + 2] = sz;
      posTarget[j * 3] = tx;
      posTarget[j * 3 + 1] = ty;
      posTarget[j * 3 + 2] = tz;
      bump(sx, sy, sz);
      bump(tx, ty, tz);

      const sk = nodeKey(srcLon, srcLat);
      const tk = nodeKey(tgtLon, tgtLat);
      srcKey[j] = sk;
      tgtKey[j] = tk;

      // Current-bucket flow, blended at the SOURCE vertex (vertex-major matrix).
      let flow = 0;
      if (nb > 0 && matrix) {
        const base = vSrc * nb;
        flow =
          f <= 0
            ? matrix[base + b0]
            : matrix[base + b0] * g + matrix[base + b1] * f;
      }
      if (flow <= minFlow) {
        widths[j] = 0; // inactive → invisible (this is the animation)
        continue;
      }
      widths[j] = widthScale * Math.sqrt(flow);

      // Incident flow → node circles at both endpoints.
      addNode(nodeFlow, sk, sx, sy, sz, flow);
      addNode(nodeFlow, tk, tx, ty, tz, flow);
    }
    o += b.featureCount;
  }

  // Node circles: one per distinct dock, radius = clamp(scale·√incidentFlow).
  const nodeCount = nodeFlow.size;
  const nodeCenters = new Float32Array(nodeCount * 3);
  const nodeRadii = new Float32Array(nodeCount);
  const nodeRadiusByKey = new Map<string, number>();
  {
    let n = 0;
    for (const [key, e] of nodeFlow) {
      const r = Math.min(
        rmax,
        Math.max(rmin, nodeRadiusScale * Math.sqrt(e.flow)),
      );
      nodeCenters[n * 3] = e.cx;
      nodeCenters[n * 3 + 1] = e.cy;
      nodeCenters[n * 3 + 2] = e.cz;
      nodeRadii[n] = r;
      nodeRadiusByKey.set(key, r);
      n++;
    }
  }

  // Per-flow endpoint insets = each endpoint's node radius (0 if no active node).
  const endpointOffsets = new Float32Array(total * 2);
  for (let j = 0; j < total; j++) {
    endpointOffsets[j * 2] = nodeRadiusByKey.get(srcKey[j]) ?? 0;
    endpointOffsets[j * 2 + 1] = nodeRadiusByKey.get(tgtKey[j]) ?? 0;
  }

  return {
    count: total,
    posSource,
    posTarget,
    widths,
    endpointOffsets,
    nodeCount,
    nodeCenters,
    nodeRadii,
    origin,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

/** Accumulate `flow` into the node at RTC `(cx,cy,cz)` under quantized `key`. */
function addNode(
  nodeFlow: Map<string, { cx: number; cy: number; cz: number; flow: number }>,
  key: string,
  cx: number,
  cy: number,
  cz: number,
  flow: number,
): void {
  const existing = nodeFlow.get(key);
  if (existing) existing.flow += flow;
  else nodeFlow.set(key, { cx, cy, cz, flow });
}
