// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * EdgeBundler — GPU **kernel-density edge bundling** (KDEEB; Hurter, Ersoy &
 * Telea 2012) with a CUBu-style pipeline (van der Zwan & Telea 2016), in the
 * ping-pong-float-texture style cosmos.gl uses for its force graph. Given a
 * tile's edges (each resampled to `pointCount` control points), it bundles
 * geometrically-close flows into smooth rivers by iteratively advecting the
 * control points up the gradient of an edge-DENSITY field — the method behind
 * the smooth, river-like bundles in the classic CPU examples. (We started on
 * force-directed bundling, FDEB, but its pairwise spring/electrostatic forces
 * are O(E²) and look kinky; KDEEB is both smoother and GPU-native — see
 * docs/roadmap.)
 *
 * Per iteration (≈15, all on the GPU; one iteration per {@link stepCycle}):
 *  1. SPLAT — additively rasterize an Epanechnikov kernel of radius `h` at every
 *     control point into an R32F density texture (mean-shift density estimate).
 *  2. ADVECT — move each interior control point a step `h` along the normalized
 *     density gradient `∇ρ/‖∇ρ‖` (toward where neighbouring edges already are).
 *  3. RESAMPLE — redistribute each edge's points to uniform arc-length spacing
 *     (advection bunches them; without this you get gaps/kinks).
 *  4. SMOOTH — one 1D Laplacian pass along each edge (`p += f·(½(prev+next)−p)`),
 *     which removes the advection/discretization zig-zags — THIS is what makes
 *     the bundles smooth (advection alone is jagged).
 *  5. ANNEAL — shrink `h` by `λ∈[0.5,0.9]` and repeat, progressively sharpening
 *     the density map to tighten bundles.
 * Endpoints (columns `0` and `P-1`) are pinned every pass.
 *
 * COORDINATE SPACE: the simulation runs in a fixed {@link WORK_SIZE}-unit box
 * (the cosLat-corrected endpoints are normalized into it) so the kernel/step
 * constants behave the same whether the data spans a city or a continent. The
 * renderer reconstructs lon/lat from the box on the GPU. Positions are f32, so
 * bundled rivers carry ~1 m of slop at city latitudes — invisible at the
 * overview zooms where bundling runs.
 *
 * The CPU-testable kernel/smoothing/resampling math is exported as pure
 * functions the GLSL mirrors (see edge-bundler.test.ts); the device path is
 * never exercised in unit tests (no GPU in jsdom).
 *
 * PORTABILITY: the density splat needs additive blending into a float texture
 * (`EXT_color_buffer_float` + `EXT_float_blend`; luma features
 * `float32-renderable-webgl` + `texture-blend-float-webgl`). Universal on
 * desktop WebGL2, absent on some mobile GPUs (the cosmos.gl caveat) —
 * {@link isBundlingSupported} gates on it and the composite falls back to
 * straight arrows when it's missing.
 */

import type { Device, Texture, Framebuffer } from '@luma.gl/core';
import { Model, Geometry } from '@luma.gl/engine';

// ───────────────────────── pure (CPU-testable) math ─────────────────────────
// The GLSL kernel mirrors these; they exist so the bundling logic is unit-tested
// on the CPU the way the rest of the package tests layer logic.

/** A 2-D point/vector. */
export type Vec2 = readonly [number, number];

const sub = (a: Vec2, b: Vec2): [number, number] => [a[0] - b[0], a[1] - b[1]];
const len = (a: Vec2): number => Math.hypot(a[0], a[1]);
const EPS = 1e-9;

/**
 * Radial **Epanechnikov** kernel weight (KDEEB's density kernel): `1 − (d/h)²`
 * inside the bandwidth `h`, `0` outside. Smooth, finite-support, cheap.
 */
export function epanechnikovWeight(dist: number, radius: number): number {
  if (radius <= EPS) return 0;
  const x = dist / radius;
  return x >= 1 ? 0 : 1 - x * x;
}

/**
 * One 1D Laplacian smoothing step on a control point toward the midpoint of its
 * same-edge neighbours, by strength `f` (CUBu uses `f≈0.5`): `cur + f·(½(prev+
 * next) − cur)`. Evenly-spaced collinear points are unchanged; kinks relax.
 */
export function laplacianStep(prev: Vec2, cur: Vec2, next: Vec2, f: number): [number, number] {
  const mx = 0.5 * (prev[0] + next[0]) - cur[0];
  const my = 0.5 * (prev[1] + next[1]) - cur[1];
  return [cur[0] + f * mx, cur[1] + f * my];
}

/**
 * Resample a polyline `points` into `newCount` evenly arc-length-spaced points,
 * preserving the endpoints. Used to seed each edge's control points (so 2-vertex
 * OD pairs stay straight, N-vertex trajectories keep their curve) and mirrors
 * the per-iteration GPU resample pass.
 */
export function subdivide(points: Vec2[], newCount: number): [number, number][] {
  if (newCount < 2 || points.length < 2) return points.map((p) => [p[0], p[1]]);
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + len(sub(points[i], points[i - 1])));
  const total = cum[cum.length - 1];
  const out: [number, number][] = [];
  for (let k = 0; k < newCount; k++) {
    const target = (total * k) / (newCount - 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const segLen = cum[i] - cum[i - 1];
    const f = segLen < EPS ? 0 : (target - cum[i - 1]) / segLen;
    out.push([
      points[i - 1][0] + f * (points[i][0] - points[i - 1][0]),
      points[i - 1][1] + f * (points[i][1] - points[i - 1][1]),
    ]);
  }
  return out;
}

// ───────────────────────────── GPU engine ───────────────────────────────────

/** Position texture format, preferred first. RG is enough (we store `u.xy`). */
const POSITION_FORMATS = ['rg32float', 'rgba32float'] as const;

/**
 * Side length of the normalized simulation box. KDEEB's kernel/step constants
 * are scale-relative, so we map every dataset's cosLat-corrected endpoints into
 * a fixed box; the renderer reconstructs lon/lat from it on the GPU.
 */
const WORK_SIZE = 1000;
/** Density-map resolution (CUBu uses 512²; 1024² for high quality). */
const DENSITY_RES = 512;

/**
 * True iff this device can run the KDEEB pipeline: render to a float position
 * texture AND additively blend into a float density texture. The composite gates
 * on this and falls back to straight arrows when false.
 */
export function isBundlingSupported(device: Device): boolean {
  if (!device.features.has('float32-renderable-webgl')) return false;
  // Additive splat into the R32F density map needs EXT_float_blend.
  if (!device.features.has('texture-blend-float-webgl')) return false;
  if (!device.isTextureFormatRenderable('r32float')) return false;
  return POSITION_FORMATS.some((f) => device.isTextureFormatRenderable(f));
}

/**
 * True iff this device can render a BAKED ({@link StaticBundle}) bundle. Unlike
 * {@link isBundlingSupported} this does NOT require additive float blending —
 * there's no density splat, only a float position texture that's uploaded once
 * and sampled — so it lights up on devices the live GPU bundler can't (the
 * cosmos.gl `EXT_float_blend` caveat on some mobile GPUs).
 */
export function isStaticBundleSupported(device: Device): boolean {
  if (!device.features.has('float32-renderable-webgl')) return false;
  return POSITION_FORMATS.some((f) => device.isTextureFormatRenderable(f));
}

/**
 * The read-only surface {@link BundledFlowLinesLayer} samples from a bundle —
 * satisfied structurally by both the live {@link EdgeBundler} and the baked
 * {@link StaticBundle}. The renderer reconstructs lon/lat as
 * `lngLat = (work · invScale + (originX, originY)) / (cosLat0, 1)`.
 */
export interface BundlePositions {
  /** `pointCount × edgeCount` work-space control points (RG/RGBA F32). */
  readonly positionTexture: Texture;
  /** Longitude-axis correction the renderer undoes (`lon = u.x / cosLat0`). */
  readonly cosLat0: number;
  /** Work-space ↔ corrected-space mapping (`corrected = work / scale + origin`). */
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
}

/**
 * Normalize cosLat-corrected control points (lon/lat, edge-major then
 * point-major) into the fixed {@link WORK_SIZE} box, returning the work-space
 * init buffer (`channels`-wide rows) plus the origin/scale the renderer needs to
 * invert it. Shared by {@link EdgeBundler} and {@link StaticBundle} so both
 * encode positions the renderer can read identically.
 */
function toWorkBox(
  controlPoints: Float64Array,
  E: number,
  P: number,
  dims: number,
  cosLat0: number,
  channels: number,
): { init: Float32Array; originX: number; originY: number; scale: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let e = 0; e < E; e++) {
    for (let i = 0; i < P; i++) {
      const base = (e * P + i) * dims;
      const cx = controlPoints[base] * cosLat0;
      const cy = controlPoints[base + 1];
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
    }
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1e-9);
  const scale = WORK_SIZE / extent;
  const init = new Float32Array(P * E * channels);
  for (let e = 0; e < E; e++) {
    for (let i = 0; i < P; i++) {
      const base = (e * P + i) * dims;
      const o = (e * P + i) * channels;
      init[o] = (controlPoints[base] * cosLat0 - minX) * scale;
      init[o + 1] = (controlPoints[base + 1] - minY) * scale;
    }
  }
  return { init, originX: minX, originY: minY, scale };
}

/** Options for {@link EdgeBundler}. */
export interface EdgeBundlerOptions {
  device: Device;
  /**
   * Per-edge control points, `edgeCount * pointCount * dims`, in lon/lat —
   * edge-major then point-major (edge e's point i at `(e*pointCount + i)*dims`).
   * The caller resamples each input feature's polyline to `pointCount` points.
   */
  controlPoints: Float64Array;
  /** Number of edges, E. */
  edgeCount: number;
  /** Control points per edge, P (≥ 3; endpoints pinned). */
  pointCount: number;
  /** Position dimensions of `controlPoints` (2 or 3); only lon/lat bundle. */
  dims: number;
  /** cos(meanLatitude) used to make the longitude axis isotropic. */
  cosLat0: number;
  /** KDEEB iterations (≈15). */
  iterations: number;
  /** Initial kernel bandwidth as a FRACTION of the drawing size (≈0.05). */
  kernelRadiusFraction: number;
  /** Laplacian smoothing strength f (≈0.5). */
  smoothingStrength: number;
  /** Kernel-bandwidth anneal factor per iteration, λ∈[0.5,0.9] (default 0.8). */
  annealLambda?: number;
}

const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 positions;
void main() { gl_Position = vec4(positions, 0.0, 1.0); }
`;

// Per-iteration scalars (block name = '<moduleName>Uniforms'; one field per line
// so luma's module-uniform validator parses it correctly).
const KDEB_BLOCK = /* glsl */ `\
layout(std140) uniform kdebUniforms {
  float h;
  float advectStep;
  float smoothing;
} kdeb;
`;
const kdebUniforms = {
  name: 'kdeb',
  vs: KDEB_BLOCK,
  fs: KDEB_BLOCK,
  uniformTypes: { h: 'f32', advectStep: 'f32', smoothing: 'f32' },
} as const;

/** Density-splat vertex shader: one instanced quad per control point, sized to
 * the kernel bandwidth and centred on the point (read from the position texture). */
function splatVs(numPoints: number): string {
  return /* glsl */ `#version 300 es
in vec2 corner;                 // unit quad corner in [-1,1]
uniform sampler2D posTex;       // P × E control points (work space)
out vec2 vCorner;
void main() {
  int id = gl_InstanceID;
  int i = id % ${numPoints};
  int e = id / ${numPoints};
  vec2 p = texelFetch(posTex, ivec2(i, e), 0).xy;          // work space [0,WORK]
  vec2 ndc = (p / ${WORK_SIZE}.0) * 2.0 - 1.0;             // density NDC
  float hNdc = (kdeb.h / ${WORK_SIZE}.0) * 2.0;            // kernel radius in NDC
  gl_Position = vec4(ndc + corner * hNdc, 0.0, 1.0);
  vCorner = corner;
}
`;
}

const SPLAT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vCorner;
out vec4 fragColor;
void main() {
  // Circular Epanechnikov inscribed in the quad: 1 at centre → 0 at radius.
  float d2 = dot(vCorner, vCorner);
  float w = max(0.0, 1.0 - d2);
  fragColor = vec4(w, 0.0, 0.0, 0.0);   // additively blended into the density map
}
`;

/** Advect interior points up the normalized density gradient by `advectStep`. */
function advectFs(numPoints: number): string {
  return /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D posTex;
uniform sampler2D densityTex;
out vec4 fragColor;
int cl(int v) { return v < 0 ? 0 : (v > ${DENSITY_RES - 1} ? ${DENSITY_RES - 1} : v); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);   // x = point i, y = edge e
  int i = c.x, e = c.y;
  vec2 p = texelFetch(posTex, ivec2(i, e), 0).xy;
  if (i == 0 || i == ${numPoints - 1}) { fragColor = vec4(p, 0.0, 0.0); return; }
  ivec2 dt = ivec2(p / ${WORK_SIZE}.0 * ${DENSITY_RES}.0);
  int x = cl(dt.x), y = cl(dt.y);
  float dL = texelFetch(densityTex, ivec2(cl(dt.x - 1), y), 0).r;
  float dR = texelFetch(densityTex, ivec2(cl(dt.x + 1), y), 0).r;
  float dB = texelFetch(densityTex, ivec2(x, cl(dt.y - 1)), 0).r;
  float dT = texelFetch(densityTex, ivec2(x, cl(dt.y + 1)), 0).r;
  vec2 grad = vec2(dR - dL, dT - dB);
  float g = length(grad);
  if (g > 1e-8) p += kdeb.advectStep * grad / g;
  fragColor = vec4(p, 0.0, 0.0);
}
`;
}

/** Redistribute each edge's interior points to uniform arc-length spacing. */
function resampleFs(numPoints: number): string {
  return /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D posTex;
out vec4 fragColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = c.x, e = c.y;
  if (i == 0 || i == ${numPoints - 1}) {
    fragColor = vec4(texelFetch(posTex, ivec2(i, e), 0).xy, 0.0, 0.0);
    return;
  }
  float total = 0.0;
  vec2 prev = texelFetch(posTex, ivec2(0, e), 0).xy;
  for (int k = 1; k < ${numPoints}; k++) {
    vec2 cur = texelFetch(posTex, ivec2(k, e), 0).xy;
    total += length(cur - prev);
    prev = cur;
  }
  float target = total * float(i) / float(${numPoints - 1});
  float acc = 0.0;
  prev = texelFetch(posTex, ivec2(0, e), 0).xy;
  vec2 outp = prev;
  for (int k = 1; k < ${numPoints}; k++) {
    vec2 cur = texelFetch(posTex, ivec2(k, e), 0).xy;
    float seg = length(cur - prev);
    if (acc + seg >= target) {
      float f = seg > 1e-8 ? (target - acc) / seg : 0.0;
      outp = mix(prev, cur, f);
      break;
    }
    acc += seg;
    prev = cur;
    outp = cur;
  }
  fragColor = vec4(outp, 0.0, 0.0);
}
`;
}

/** One 1D Laplacian smoothing pass along each edge. */
function smoothFs(numPoints: number): string {
  return /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D posTex;
out vec4 fragColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = c.x, e = c.y;
  vec2 p = texelFetch(posTex, ivec2(i, e), 0).xy;
  if (i == 0 || i == ${numPoints - 1}) { fragColor = vec4(p, 0.0, 0.0); return; }
  vec2 a = texelFetch(posTex, ivec2(i - 1, e), 0).xy;
  vec2 b = texelFetch(posTex, ivec2(i + 1, e), 0).xy;
  vec2 lap = 0.5 * (a + b) - p;
  fragColor = vec4(p + kdeb.smoothing * lap, 0.0, 0.0);
}
`;
}

/**
 * GPU kernel-density edge bundler. Construct with a tile's resampled control
 * points, call {@link stepCycle} once per frame until {@link isDone}, and bind
 * {@link positionTexture} into the renderer's vertex shader.
 */
export class EdgeBundler {
  readonly device: Device;
  readonly edgeCount: number;
  /** Control points per edge (texture width). */
  readonly pointCount: number;
  /** Longitude-axis correction the renderer must undo (`lon = u.x / cosLat0`). */
  readonly cosLat0: number;
  /** Work-space ↔ corrected-space mapping (`corrected = work / scale + origin`). */
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;

  private texA: Texture;
  private texB: Texture;
  private fbA: Framebuffer;
  private fbB: Framebuffer;
  private densityTex: Texture;
  private densityFb: Framebuffer;
  private quad: Geometry;
  private splatQuad: Geometry;
  private splatModel: Model;
  private advectModel: Model;
  private resampleModel: Model;
  private smoothModel: Model;

  private currentIsA = true;
  private itersDone = 0;
  private destroyed = false;
  private readonly iterations: number;
  private readonly kernelRadius0: number;
  private readonly smoothing: number;
  private readonly annealLambda: number;

  constructor(opts: EdgeBundlerOptions) {
    const { device, controlPoints, dims, cosLat0 } = opts;
    this.device = device;
    this.cosLat0 = cosLat0;
    this.iterations = Math.max(1, Math.floor(opts.iterations));
    this.kernelRadius0 = Math.max(2, opts.kernelRadiusFraction * WORK_SIZE);
    this.smoothing = Math.max(0, Math.min(1, opts.smoothingStrength));
    this.annealLambda = Math.max(0.3, Math.min(0.95, opts.annealLambda ?? 0.8));

    const E = opts.edgeCount;
    const P = Math.max(3, Math.floor(opts.pointCount));
    this.edgeCount = E;
    this.pointCount = P;

    const format =
      POSITION_FORMATS.find((f) => device.isTextureFormatRenderable(f)) ?? 'rgba32float';
    const channels = format === 'rgba32float' ? 4 : 2;

    // Normalize the cosLat-corrected control points into the fixed WORK box.
    const box = toWorkBox(controlPoints, E, P, dims, cosLat0, channels);
    this.originX = box.originX;
    this.originY = box.originY;
    this.scale = box.scale;
    const init = box.init;

    const sampler = {
      minFilter: 'nearest',
      magFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    } as const;

    this.texA = device.createTexture({ width: P, height: E, format, sampler });
    this.texB = device.createTexture({ width: P, height: E, format, sampler });
    this.texA.copyImageData({ data: init });
    this.texB.copyImageData({ data: init });
    this.fbA = device.createFramebuffer({ colorAttachments: [this.texA] });
    this.fbB = device.createFramebuffer({ colorAttachments: [this.texB] });

    this.densityTex = device.createTexture({
      width: DENSITY_RES,
      height: DENSITY_RES,
      format: 'r32float',
      sampler,
    });
    this.densityFb = device.createFramebuffer({ colorAttachments: [this.densityTex] });

    // Fullscreen triangle for the compute passes (gl_FragCoord drives texel id).
    this.quad = new Geometry({
      topology: 'triangle-list',
      vertexCount: 3,
      attributes: { positions: { size: 2, value: new Float32Array([-1, -1, 3, -1, -1, 3]) } },
    });
    // Unit quad (6 verts) for the instanced density splat.
    this.splatQuad = new Geometry({
      topology: 'triangle-list',
      vertexCount: 6,
      attributes: {
        corner: { size: 2, value: new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]) },
      },
    });

    const computeParams = {
      blend: false,
      depthWriteEnabled: false,
      depthCompare: 'always',
      cullMode: 'none',
    } as const;

    this.splatModel = new Model(device, {
      id: 'edge-bundler-splat',
      vs: splatVs(P),
      fs: SPLAT_FS,
      geometry: this.splatQuad,
      modules: [kdebUniforms],
      isInstanced: true,
      instanceCount: E * P,
      parameters: {
        blend: true,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one',
        blendAlphaOperation: 'add',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one',
        depthWriteEnabled: false,
        depthCompare: 'always',
        cullMode: 'none',
      },
      disableWarnings: true,
    });

    this.advectModel = new Model(device, {
      id: 'edge-bundler-advect',
      vs: FULLSCREEN_VS,
      fs: advectFs(P),
      geometry: this.quad,
      modules: [kdebUniforms],
      parameters: computeParams,
      disableWarnings: true,
    });

    this.resampleModel = new Model(device, {
      id: 'edge-bundler-resample',
      vs: FULLSCREEN_VS,
      fs: resampleFs(P),
      geometry: this.quad,
      parameters: computeParams,
      disableWarnings: true,
    });

    this.smoothModel = new Model(device, {
      id: 'edge-bundler-smooth',
      vs: FULLSCREEN_VS,
      fs: smoothFs(P),
      geometry: this.quad,
      modules: [kdebUniforms],
      parameters: computeParams,
      disableWarnings: true,
    });
  }

  /** The texture holding the latest control points (bind into the renderer). */
  get positionTexture(): Texture {
    return this.currentIsA ? this.texA : this.texB;
  }

  isDone(): boolean {
    return this.itersDone >= this.iterations;
  }

  /**
   * Run one KDEEB iteration (splat → advect → resample → smooth, then anneal the
   * kernel). Returns `true` once all iterations are complete. Designed to be
   * called at most once per frame so the bundle settles over several frames.
   */
  stepCycle(): boolean {
    if (this.destroyed || this.isDone()) return true;

    const h = this.kernelRadius0 * Math.pow(this.annealLambda, this.itersDone);
    const uniforms = { h, advectStep: h, smoothing: this.smoothing };

    // 1. SPLAT the density map (clear, then additively accumulate every site).
    this.splatModel.shaderInputs.setProps({ kdeb: uniforms });
    this.splatModel.setBindings({ posTex: this.positionTexture });
    const dp = this.device.beginRenderPass({
      framebuffer: this.densityFb,
      clearColor: [0, 0, 0, 0],
      parameters: { viewport: [0, 0, DENSITY_RES, DENSITY_RES] },
    });
    this.splatModel.draw(dp);
    dp.end();

    // 2. ADVECT up the density gradient.
    this.advectModel.shaderInputs.setProps({ kdeb: uniforms });
    this.advectModel.setBindings({
      posTex: this.positionTexture,
      densityTex: this.densityTex,
    });
    this.computeInto(this.advectModel);

    // 3. RESAMPLE to uniform spacing.
    this.resampleModel.setBindings({ posTex: this.positionTexture });
    this.computeInto(this.resampleModel);

    // 4. SMOOTH (one Laplacian pass) — what removes the advection zig-zags.
    this.smoothModel.shaderInputs.setProps({ kdeb: uniforms });
    this.smoothModel.setBindings({ posTex: this.positionTexture });
    this.computeInto(this.smoothModel);

    this.itersDone++;
    return this.isDone();
  }

  /** Draw a compute model into the ping-pong partner and flip current. */
  private computeInto(model: Model): void {
    const targetFb = this.currentIsA ? this.fbB : this.fbA;
    const pass = this.device.beginRenderPass({
      framebuffer: targetFb,
      clearColor: false,
      parameters: { viewport: [0, 0, this.pointCount, this.edgeCount] },
    });
    model.draw(pass);
    pass.end();
    this.currentIsA = !this.currentIsA;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.splatModel.destroy();
    this.advectModel.destroy();
    this.resampleModel.destroy();
    this.smoothModel.destroy();
    this.fbA.destroy();
    this.fbB.destroy();
    this.densityFb.destroy();
    this.texA.destroy();
    this.texB.destroy();
    this.densityTex.destroy();
  }
}

/** Options for {@link StaticBundle}. */
export interface StaticBundleOptions {
  device: Device;
  /**
   * Pre-bundled control points, `edgeCount * pointCount * dims`, in lon/lat,
   * edge-major then point-major — exactly the layout {@link EdgeBundler} takes,
   * but already relaxed at build time (see the Rust `edge_bundle` module). The
   * caller resamples each baked corridor's polyline to `pointCount` points.
   */
  controlPoints: Float64Array;
  /** Number of edges, E. */
  edgeCount: number;
  /** Control points per edge, P. */
  pointCount: number;
  /** Position dimensions of `controlPoints` (2 or 3). */
  dims: number;
  /** cos(meanLatitude) used to make the longitude axis isotropic. */
  cosLat0: number;
}

/**
 * The baked counterpart to {@link EdgeBundler}: control points that were bundled
 * at BUILD time (Rust KDEEB) are uploaded ONCE into a work-space position texture
 * and never relaxed. It exposes the same {@link BundlePositions} surface, so
 * {@link BundledFlowLinesLayer} renders a baked bundle and a live bundle through
 * the identical shader path — the only difference is the geometry source.
 *
 * Because there's no density splat (no additive float blend), this works on the
 * devices the live bundler can't — see {@link isStaticBundleSupported}.
 */
export class StaticBundle implements BundlePositions {
  readonly cosLat0: number;
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
  readonly edgeCount: number;
  readonly pointCount: number;

  private tex: Texture;
  private destroyed = false;

  constructor(opts: StaticBundleOptions) {
    const { device, controlPoints, dims, cosLat0 } = opts;
    this.cosLat0 = cosLat0;
    const E = opts.edgeCount;
    const P = Math.max(2, Math.floor(opts.pointCount));
    this.edgeCount = E;
    this.pointCount = P;

    const format =
      POSITION_FORMATS.find((f) => device.isTextureFormatRenderable(f)) ?? 'rgba32float';
    const channels = format === 'rgba32float' ? 4 : 2;

    const box = toWorkBox(controlPoints, E, P, dims, cosLat0, channels);
    this.originX = box.originX;
    this.originY = box.originY;
    this.scale = box.scale;

    this.tex = device.createTexture({
      width: P,
      height: E,
      format,
      sampler: {
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
    });
    this.tex.copyImageData({ data: box.init });
  }

  /** The texture holding the baked control points (bind into the renderer). */
  get positionTexture(): Texture {
    return this.tex;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.tex.destroy();
  }
}
