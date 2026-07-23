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
 *
 * The second half of the module is the metres↔mercator scale (campaign D10):
 * mercator distances are latitude-dependent, so anything expressed in real
 * metres — extrusion heights, metric point radii / line widths — must divide by
 * `EARTH_CIRCUMFERENCE_M · cos(lat)` rather than by a flat constant.
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

/** Inverse of {@link lngLatToMercator}'s y: mercator unit-square y → latitude. */
export function latFromMercatorY(y: number): number {
  return (
    (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) *
    (180 / Math.PI)
  );
}

/**
 * Latitude at the CENTRE of tile `(z, y)` — the granularity every metres-based
 * uniform in this backend is resolved at (see {@link mercatorZFromAltitude}).
 * `y` is the XYZ tile row (`tile.id.y`), counted from the north edge.
 */
export function tileCenterLatitude(z: number, y: number): number {
  return latFromMercatorY((y + 0.5) / Math.pow(2, z));
}

// ── metres ↔ mercator (campaign D10: elevation reconciliation) ───────────────

/**
 * Mean earth radius (m). This is the radius MapLibre and Mapbox build their
 * mercator SCALE on (`earthRadius` in maplibre's `geo/lng_lat.ts`, verified in
 * the installed maplibre-gl 4.7 bundle), not the WGS84 semi-major axis.
 */
export const EARTH_RADIUS_M = 6371008.8;

/**
 * `2π · EARTH_RADIUS_M` = 40 030 228.884 m — maplibre's own `earthCircumference`,
 * the divisor inside its `mercatorZfromAltitude()` and `transform._pixelPerMeter`.
 * Matching the HOST's constant is the necessary half of lining a metre in this
 * backend up with the host's fill-extrusion heights, terrain and scale bar.
 *
 * It is not the sufficient half: maplibre resolves metres→pixels ONCE per frame
 * at the MAP CENTRE's latitude (`_pixelPerMeter = mercatorZfromAltitude(1,
 * center.lat) * worldSize`) and applies that single factor to every tile on
 * screen, while this backend resolves per TILE at its own centre latitude. The
 * two agree where `tileLat == centreLat` and differ by `cos(centreLat) /
 * cos(tileLat)` elsewhere — so a 100 m STT prism at 60°N in a view centred on
 * the equator stands ~2× a 100 m `fill-extrusion` beside it. Per-tile is the
 * conformal choice (see {@link mercatorZFromAltitude}); read
 * `map.getCenter().lat` instead if matching the host's own non-conformal
 * factor matters more than a cube looking like a cube.
 *
 * Deliberately NOT `@poopdeck.gl/core`'s `WORLD_CIRCUMFERENCE`
 * (`2π · 6 378 137` = 40 075 016.686, the WGS84 equatorial value the
 * three/globe kernel uses): the two differ by 0.11%, and the tie-break is
 * "agree with whoever owns the camera". Wave M2 removed the polygon layer's
 * `MERCATOR_Z_TO_METERS_MIDLAT` stopgap — extrusion now resolves the factor per
 * tile from {@link mercatorZFromAltitude} at that tile's own latitude, so this
 * constant is the single anchor for every metre in the backend.
 */
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * EARTH_RADIUS_M;

/**
 * Metres spanned by ONE mercator unit at `latDeg` — the mercator stretch
 * `circumference · cos(lat)`. The unit square is 1×1 everywhere, so a mercator
 * unit buys fewer ground metres the further you go from the equator.
 *
 * Latitude is clamped to the Web Mercator cutoff (±85.0511°, the same clamp
 * {@link lngLatToMercator} applies) so the factor stays finite — cos(±90°)
 * would make the reciprocal divide by zero — and so a vertex and its elevation
 * are always scaled at the same latitude.
 */
export function metersPerMercatorUnit(latDeg: number): number {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg));
  return EARTH_CIRCUMFERENCE_M * Math.cos((clamped * Math.PI) / 180);
}

/**
 * Metres of altitude → mercator-z, latitude-correct (maplibre's
 * `mercatorZfromAltitude`). Honors the conformal-z contract: a box with equal
 * x/y/z mercator lengths renders as a cube, because the same
 * `1/(circumference·cos lat)` factor scales all three axes.
 *
 * **Intentional visual change (campaign D10).** This REPLACES the historical
 * `DEFAULT_ALTITUDE_SCALE = 1e-7` flat factor, which is 4.003× larger than the
 * correct equatorial value ({@link DEPRECATED_ALTITUDE_SCALE}) — extrusions
 * built on it stood ~4× too tall. Extruded polygons/columns therefore become
 * ~4× SHORTER, i.e. correct, once a layer switches to this function. Reviewers:
 * that shrink is the fix, not a regression.
 *
 * **Per-tile latitude is the practical granularity.** `altitudeScale` reaches
 * the shader as a uniform, so a layer converts once per draw with the tile's
 * centre latitude (`mercatorZFromAltitude(1, tileCenterLatitude(tile.id.z,
 * tile.id.y))` as the scale, or `mercatorZFromAltitude(meters, lat)` for a
 * constant height). The exact worst-case within-tile relative error is
 * `max(|cos(latEdge) / cos(latCentre) − 1|)` over the tile's two latitude
 * edges. Its first-order form `≈ π·sin(lat) / 2^z` (half-tile latitude span
 * `π·cos(lat)/2^z` rad × the `tan(lat)` sensitivity of `1/cos`) gives ~0.9% at
 * z8 and ~0.2% at z10 — negligible wherever extrusion is legible — but ~14% at
 * z4/45°, where per-vertex baking is the exact option ({@link projectPositions}
 * already holds each vertex's own latitude).
 *
 * That linearization is only valid while the tile's latitude SPAN is small
 * next to its centre latitude, and it collapses for an equator-straddling
 * tile: at z0 the centre latitude is 0, so `π·sin(lat)/2^z` reads 0% while the
 * true spread across that one tile is `cos(85.0511°)` = 8.6% of the centre
 * value — 11.6× at the poleward edge. Use the exact form above whenever an
 * archive is tiled from z0/z1 and extrusion matters at world view.
 */
export function mercatorZFromAltitude(meters: number, latDeg: number): number {
  return meters / metersPerMercatorUnit(latDeg);
}

/**
 * Horizontal twin of {@link mercatorZFromAltitude}: ground metres → mercator
 * units at `latDeg`. Same factor (mercator stretches x, y and z alike), separate
 * name so metric SIZING (point radius, line width, corridor width) reads as
 * sizing rather than elevation.
 */
export function metersToMercatorUnits(meters: number, latDeg: number): number {
  return meters / metersPerMercatorUnit(latDeg);
}

/**
 * Ground metres → PIXELS at `latDeg` and `zoom` — the scale factor that turns a
 * metres-based option into the pixel width/radius our layers already consume
 * (`uWidth`/`uRadius` in the line/point shaders, `gl_PointSize`).
 *
 * Pixel space follows `tileSize`: maplibre's world is `512 · 2^zoom` CSS px
 * around, so the default returns CSS pixels. The layer shaders offset in
 * DEVICE pixels (`uViewport` is `gl.drawingBuffer{Width,Height}`; `gl_PointSize`
 * is device pixels too), so a layer sizing in metres passes
 * `tileSize = 512 * devicePixelRatio`.
 *
 * Equivalent to `metersToMercatorUnits(meters, latDeg) * worldSize`, which is
 * exactly maplibre's `_pixelPerMeter = mercatorZfromAltitude(1, lat) * worldSize`.
 *
 * Screen-space caveat: those shaders expand in SCREEN pixels, so one uniform per
 * draw is a constant-on-screen approximation of a metric size — under pitch,
 * geometry near the horizon keeps its centre-of-view width instead of shrinking
 * with depth (deck's `widthUnits: 'meters'` expands per-vertex in world space
 * instead). Resolve `latDeg` per tile ({@link tileCenterLatitude}); anything
 * better is a layer-side vertex-expansion change, not a scale-factor change.
 */
export function metersToPixelsAtLatitude(
  meters: number,
  latDeg: number,
  zoom: number,
  tileSize = 512,
): number {
  return metersToMercatorUnits(meters, latDeg) * tileSize * Math.pow(2, zoom);
}

/**
 * The pre-D10 flat altitude→mercator-z factor, kept ONLY as the citable anchor
 * for the correction: `DEPRECATED_ALTITUDE_SCALE / mercatorZFromAltitude(1, 0)`
 * = 4.003, the "~4× too tall" the ecosystem audit measured.
 *
 * NOTHING reads it any more. `STTPolygonLayer.altitudeScale` defaults to `1`
 * and means a dimensionless exaggeration; the metres→mercator-z conversion is
 * this module's job. A new extruding layer (Wave M3's column kind) must build
 * on {@link mercatorZFromAltitude}, never re-adopt this value as a default.
 *
 * @deprecated Use {@link mercatorZFromAltitude} — latitude-correct, host-matched.
 */
export const DEPRECATED_ALTITUDE_SCALE = 1e-7;

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
