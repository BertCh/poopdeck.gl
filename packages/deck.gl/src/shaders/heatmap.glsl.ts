/**
 * Shader sources for the GPU-splat heatmap layer (deck.gl/luma.gl 9.x).
 *
 * Single-pass architecture: each visible point is rendered as a textured
 * gaussian disc straight into the canvas with ADDITIVE blending
 * (gl.ONE, gl.ONE). The vertex shader evaluates the time-window alpha
 * against the feature's [startTime, endTime] so per-frame CPU filtering
 * is eliminated.
 *
 * We bypass the offscreen-FBO + ramp-pass architecture (which the
 * MapLibre adapter uses) because it interacts poorly with deck.gl 9's
 * RenderPass system — the inner sublayer's manual beginRenderPass leaves
 * the deck.gl-managed pass in an inconsistent state and the ramp output
 * silently disappears. A single-pass direct splat keeps us inside the
 * standard pipeline and still wins the architectural battle: zero
 * per-frame CPU work, GPU-side time filtering, per-tile VBOs uploaded
 * once on tile arrival.
 *
 * Trade-off vs the FBO design: the ramp is sampled per-splat, not
 * per-pixel, so the colour gradient is driven by the per-feature weight
 * × per-splat gaussian rather than per-pixel accumulated density. The
 * visual is close in practice; a future revision can layer per-pixel
 * accumulation on top once the deck.gl 9 offscreen path is sorted.
 */

const TIME_WINDOW_SNIPPET = /* glsl */ `
float sttTimeWindowAlpha(
  vec2 timeRange,
  float windowStart,
  float windowEnd,
  float fadeIn,
  float fadeOut
) {
  float startTime = timeRange.x;
  float endTime   = timeRange.y;
  if (endTime < windowStart || startTime > windowEnd) return 0.0;
  float alpha = 1.0;
  if (fadeIn > 0.0) {
    float age = windowEnd - startTime;
    if (age < fadeIn) alpha *= clamp(age / fadeIn, 0.0, 1.0);
  }
  if (fadeOut > 0.0) {
    float remaining = endTime - windowStart;
    if (remaining < fadeOut) alpha *= clamp(remaining / fadeOut, 0.0, 1.0);
  }
  return alpha;
}
`;

export const HEATMAP_VS = /* glsl */ `\
#version 300 es
#define SHADER_NAME heatmap-splat-vs

in vec3 instancePosition;
in vec2 instanceTime;
in float instanceWeight;
// Per-instance channel index, baked into the buffer at tile-prepare time
// (constant per (tile, channel) pair).
in float instanceChannel;

flat out int vChannel;
out float vWeight;
out vec2 vQuadUV;

${TIME_WINDOW_SNIPPET}

void main() {
  // Project lon/lat → clip via deck.gl's project32 module.
  vec3 world64Low = vec3(0.0);
  gl_Position = project_position_to_clipspace(instancePosition, world64Low, vec3(0.0));
  gl_PointSize = heatmap.radius * 2.0;
  float windowAlpha = sttTimeWindowAlpha(
    instanceTime,
    heatmap.windowStart,
    heatmap.windowEnd,
    heatmap.fadeIn,
    heatmap.fadeOut
  );
  vWeight = instanceWeight * windowAlpha * heatmap.intensity;
  vChannel = int(instanceChannel + 0.5);
  // gl_PointCoord-driven UV is set per-fragment, but we still need a
  // varying for the disc cull. Unused in this VS path.
  vQuadUV = vec2(0.0);
}
`;

export const HEATMAP_FS = /* glsl */ `\
#version 300 es
#define SHADER_NAME heatmap-splat-fs
precision highp float;

flat in int vChannel;
in float vWeight;

uniform sampler2D uPalette0;
uniform sampler2D uPalette1;
uniform sampler2D uPalette2;
uniform sampler2D uPalette3;

out vec4 outColor;

vec4 paletteColor(int channel, float t) {
  // GLSL ES 3.00 lacks dynamic sampler indexing, so we branch.
  if (channel == 0) return texture(uPalette0, vec2(t, 0.5));
  if (channel == 1) return texture(uPalette1, vec2(t, 0.5));
  if (channel == 2) return texture(uPalette2, vec2(t, 0.5));
  return texture(uPalette3, vec2(t, 0.5));
}

void main() {
  if (vWeight <= 0.0) discard;
  // gl_PointCoord ranges 0..1; recenter to [-0.5, 0.5].
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  // sigma^2 = 0.15 — tight, bright core. Matches the maplibre adapter.
  float falloff = exp(-r2 / 0.15);
  float intensity = clamp(falloff * vWeight, 0.0, 1.0);
  if (intensity <= heatmap.threshold) discard;
  // Map intensity → palette LUT entry.
  float t = clamp(
    (intensity - heatmap.domainMin) /
      max(1e-6, heatmap.domainMax - heatmap.domainMin),
    0.0, 1.0
  );
  vec4 c = paletteColor(vChannel, t);
  // Premultiplied alpha — the additive blend (ONE, ONE) sums colour+alpha
  // contributions across overlapping splats, so the per-splat alpha must
  // already weight the colour for the math to come out right.
  c.rgb *= c.a;
  c.a *= heatmap.opacity;
  outColor = c;
}
`;

/**
 * Shader uniform module. All per-frame and per-channel knobs live here.
 * `domainMin`/`domainMax` are the active channel's pinned intensity
 * domain. Per-channel domains are baked into channel-instance buffers at
 * the tile-prepare stage, so a single uniform set suffices for a given
 * draw call — when channels[i] and channels[j] share a tile they're still
 * drawn as separate draw calls and re-bind the uniforms accordingly.
 */
export const heatmapUniforms = {
  name: 'heatmap',
  vs: /* glsl */ `\
uniform heatmapUniforms {
  float radius;
  float intensity;
  float windowStart;
  float windowEnd;
  float fadeIn;
  float fadeOut;
  float threshold;
  float opacity;
  float domainMin;
  float domainMax;
} heatmap;
`,
  fs: /* glsl */ `\
uniform heatmapUniforms {
  float radius;
  float intensity;
  float windowStart;
  float windowEnd;
  float fadeIn;
  float fadeOut;
  float threshold;
  float opacity;
  float domainMin;
  float domainMax;
} heatmap;
`,
  uniformTypes: {
    radius: 'f32',
    intensity: 'f32',
    windowStart: 'f32',
    windowEnd: 'f32',
    fadeIn: 'f32',
    fadeOut: 'f32',
    threshold: 'f32',
    opacity: 'f32',
    domainMin: 'f32',
    domainMax: 'f32',
  },
} as const;
