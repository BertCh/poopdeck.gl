/**
 * Web Mercator projection helpers.
 *
 * MapLibre's CustomLayerInterface passes a `matrix` argument whose input space
 * is mercator coordinates in the unit square — i.e. lon=-180→x=0, lon=180→x=1,
 * lat=85.0511→y=0, lat=-85.0511→y=1. Our shaders project lon/lat into that
 * unit square and let MapLibre's matrix carry them to clip space.
 *
 * We pre-project on the CPU once per tile (in Float64) and cache the result as
 * a Float32Array of mercator unit-square coordinates. This avoids per-frame
 * `log(tan(...))` work in the vertex shader and keeps precision sound at
 * city-scale zooms where Float64 lon/lat math matters.
 */

const MAX_LAT = 85.05112877980659;

/** Project a single lon/lat pair to mercator unit-square coordinates. */
export function lngLatToMercator(lon: number, lat: number): [number, number] {
  const x = lon / 360 + 0.5;
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return [x, y];
}

/**
 * Pre-project a packed lon/lat/alt buffer to mercator unit-square coordinates.
 *
 * @param positions - Interleaved positions. For 2D: [lon0, lat0, lon1, lat1, ...].
 *                    For 3D: [lon0, lat0, alt0, lon1, lat1, alt1, ...].
 * @param dimensions - 2 or 3.
 * @returns Float32Array of [mx, my, alt?] triples (3D output if input was 3D).
 */
export function projectPositions(
  positions: Float64Array | Float32Array,
  dimensions: 2 | 3,
): Float32Array {
  const count = positions.length / dimensions;
  // We always emit a stride-3 buffer so the vertex shader layout is uniform
  // (mx, my, alt). For 2D inputs we leave altitude at 0.
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const lon = positions[i * dimensions];
    const lat = positions[i * dimensions + 1];
    const [mx, my] = lngLatToMercator(lon, lat);
    out[i * 3] = mx;
    out[i * 3 + 1] = my;
    out[i * 3 + 2] = dimensions === 3 ? positions[i * dimensions + 2] : 0;
  }
  return out;
}

/**
 * The altitude→mercator-z scale used by MapLibre for `setTerrain`-style
 * elevation. For our adapter we use a small fraction so altitudes don't
 * dominate the matrix (which would push features below the basemap). Callers
 * can override via the layer's `altitudeScale` option.
 */
export const DEFAULT_ALTITUDE_SCALE = 1e-7;

/**
 * Per-axis parameters reconstructing a world mercator position from a
 * {@link quantizePositionsToUint16} output: `world[i] = normalized[i] *
 * scale[i] + offset[i]`, where `normalized` is the GPU's own [0,1] decode of
 * the uploaded `UNSIGNED_SHORT` attribute (via `normalized: true` in
 * `vertexAttribPointer` — free hardware int→float, no shader division).
 */
export interface PositionQuantization {
  scale: [number, number, number];
  offset: [number, number, number];
}

/**
 * Quantize a stride-3 Float32 mercator-unit-square position buffer (as
 * produced by {@link projectPositions}) to per-tile-local `UInt16`, halving
 * this buffer's GPU upload/vertex-fetch bytes with no visible precision loss
 * — nothing needs world precision inside one tile's own bounding box.
 * MapLibre GL JS uses the same trick for its own vertex positions (Int16,
 * local to each tile's EXTENT — `src/data/pos_attributes.ts`).
 *
 * Each axis is independently quantized across ITS OWN min/max in this
 * buffer (not the world unit square), so precision concentrates where the
 * tile's actual data is — a dense, geographically tight tile gets far more
 * effective precision than a fixed global grid would give. A degenerate
 * (zero-range) axis quantizes to a constant offset with scale 0, so `q * 0 +
 * offset` reconstructs the exact original value regardless of the
 * (arbitrary) quantized bit pattern.
 */
export function quantizePositionsToUint16(projected: Float32Array): {
  quantized: Uint16Array;
  scale: [number, number, number];
  offset: [number, number, number];
} {
  const n = projected.length / 3;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = projected[i * 3];
    const y = projected[i * 3 + 1];
    const z = projected[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (n === 0) {
    minX = maxX = minY = maxY = minZ = maxZ = 0;
  }
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;
  const rangeZ = maxZ - minZ;
  const quantizeAxis = (v: number, min: number, range: number): number =>
    range > 0 ? Math.round(((v - min) / range) * 65535) : 0;

  const quantized = new Uint16Array(n * 3);
  for (let i = 0; i < n; i++) {
    quantized[i * 3] = quantizeAxis(projected[i * 3], minX, rangeX);
    quantized[i * 3 + 1] = quantizeAxis(projected[i * 3 + 1], minY, rangeY);
    quantized[i * 3 + 2] = quantizeAxis(projected[i * 3 + 2], minZ, rangeZ);
  }
  return {
    quantized,
    scale: [rangeX, rangeY, rangeZ],
    offset: [minX, minY, minZ],
  };
}
