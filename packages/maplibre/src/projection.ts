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
