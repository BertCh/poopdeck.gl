/**
 * Single source of truth for STT's GPU-local position dequantization GLSL
 * (perf research 2026-07, MapLibre-inspired: `src/data/pos_attributes.ts`
 * uses the same Int16-local-to-tile-EXTENT trick for its own vertex
 * positions).
 *
 * `@poopdeck.gl/maplibre`'s point/heatmap layers upload tile positions as a
 * per-tile-local `UNSIGNED_SHORT` buffer (see
 * `quantizePositionsToUint16` in `lib/projection.ts`) instead of raw Float32
 * mercator coordinates — half the bytes, no visible precision loss, since
 * nothing needs world precision inside one tile's own bounding box. The
 * vertex shader reads the attribute with `normalized: true`
 * (`vertexAttribPointer(..., gl.UNSIGNED_SHORT, true, ...)`), so the GPU's
 * fixed-function vertex fetch has ALREADY mapped it to `[0,1]` per component
 * by the time it reaches `main()` — this snippet just re-expands that
 * normalized value into the tile's own mercator bounding box via the
 * `uPosScale`/`uPosOffset` uniforms {@link quantizePositionsToUint16}
 * produces.
 *
 * The snippet expects the *caller* to declare:
 *   - `attribute vec3 aMercator` — normalized `[0,1]` per component (NOT raw
 *     mercator coordinates anymore).
 *   - `uniform vec3 uPosScale`, `uniform vec3 uPosOffset` — set once per tile
 *     draw from the `TileGpuCache`'s `posScale`/`posOffset`.
 */
export const POSITION_DEQUANT_GLSL = `
vec3 sttDecodeMercatorPos(vec3 normalizedPos, vec3 scale, vec3 offset) {
  return normalizedPos * scale + offset;
}
`;

/**
 * JS-side reference implementation, used by tests to cross-check the GLSL
 * against {@link quantizePositionsToUint16}'s own encode direction — round
 * tripping quantize→(GPU int/65535 normalize, simulated here)→decode should
 * reproduce the original mercator position within quantization error.
 */
export function decodeMercatorPosJS(
  normalizedPos: [number, number, number],
  scale: [number, number, number],
  offset: [number, number, number],
): [number, number, number] {
  return [
    normalizedPos[0] * scale[0] + offset[0],
    normalizedPos[1] * scale[1] + offset[1],
    normalizedPos[2] * scale[2] + offset[2],
  ];
}
