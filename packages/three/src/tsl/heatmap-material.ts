// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `HeatmapMaterial` — the TSL half of the two-pass per-PIXEL density heatmap,
 * the three port of deck's `AnimatedHeatmapLayer` and the direct analogue of
 * maplibre's `STTHeatmapLayer` accumulate + ramp program pair.
 *
 * ── WHY TWO MATERIALS AND NOT ONE ────────────────────────────────────────────
 * This is the ONE thing a heatmap has to get right. A single pass that samples
 * the colour ramp PER SPLAT and additively blends the resulting COLOURS sums
 * colours, not density: two overlapping mid-ramp oranges make white, three make
 * whiter, and the image never reads as a heatmap — the palette stops carrying
 * information the moment anything overlaps. Density is the quantity that
 * accumulates; colour is a function OF the accumulated density and can only be
 * evaluated once, per pixel, after the sum is known. Hence:
 *
 *   1. {@link createHeatmapSplatMaterial} — one camera-facing quad per point,
 *      ADDITIVELY blended into a single-channel float render target. Its
 *      fragment writes a scalar KERNEL WEIGHT, not a colour, and the target
 *      accumulates `Σ kernel(r) · weight` per texel.
 *   2. {@link createHeatmapRampMaterial} — a full-screen quad that reads that
 *      texel ONCE, normalises it through `[domainMin, domainMax]`, and maps the
 *      result through the colour ramp.
 *
 * {@link createHeatmapMaterial} builds the pair together; the layer owns the
 * render target and the pass ordering.
 *
 * ── COLOUR-SPACE RULE, AND WHERE IT DOES *NOT* APPLY ─────────────────────────
 * The splat pass writes DENSITY, a physical quantity, into a render target.
 * `srgbToWorking` must NEVER touch it — the same reason the id materials are
 * exempt. (Three agrees structurally: `Renderer.currentToneMapping` is
 * `NoToneMapping` and `currentColorSpace` is the working space whenever the
 * bound target is not the output target, so what the splat fragment writes is
 * exactly what the ramp pass reads back.) The ramp pass DOES produce a colour
 * and converts it last, on the final fragment RGB only, per the package rule.
 *
 * ── TIME FILTERING ───────────────────────────────────────────────────────────
 * Standard for this package: {@link timeFilterVisibleNode} multiplies the splat
 * quad's half-size in the VERTEX stage, so an out-of-window point collapses to
 * a zero-extent primitive and contributes EXACTLY zero density — no fragments,
 * no accumulation, early-Z intact (deck.gl #7509). The complementary soft
 * fade-in/out ramp rides the accumulated WEIGHT in the fragment stage rather
 * than an opacity: a half-faded point deposits half the density, which is what
 * a fade means for a density field. `opacityNode` stays a hard `1` because
 * three's `AdditiveBlending` uses `srcAlpha` as the source blend factor — an
 * alpha below 1 would silently halve the contribution a second time.
 *
 * ── WGSL DISCIPLINE ──────────────────────────────────────────────────────────
 * The soft time alpha is a `select()`-based node and is NEVER wrapped in a
 * `varying()` (the package's recurring WGSL build crash). The raw per-instance
 * `start`/`end` scalars are varied and the alpha is RECOMPUTED in the fragment
 * stage, exactly as point / icon / surfel do.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending, AdditiveBlending } from 'three';
import type { Texture } from 'three';
import * as TSL from 'three/tsl';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  max,
  select,
  saturate,
  exp,
  oneMinus,
  mix,
  modelViewMatrix,
  cameraProjectionMatrix,
  type TSLNode,
  type UniformNode,
} from './nodes.js';
import { srgbToWorking } from './color-space.js';
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  timeFilterVisibleNode,
  wakeSizeScaleNode,
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterMode, TimeFilterParams } from './time-filter-math.js';
import { DEFAULT_HEATMAP_COLOR_RANGE } from '@poopdeck.gl/core';
import type { PaletteRGBA } from '@poopdeck.gl/core';

// Loose TSL builders not surfaced on the ./nodes seam (texture sampling, the
// screen-space UV, smoothstep), grabbed locally exactly as icon-material /
// flow-corridor-material / palette do.
const texture = TSL.texture as unknown as (...a: any[]) => any;
const screenUV = TSL.screenUV as unknown as TSLNode;
const smoothstep = TSL.smoothstep as unknown as (...a: any[]) => any;

/** Tiny epsilon guarding a division by a degenerate (zero-width) domain. */
const EPS = 1e-6;

/**
 * Per-splat attribute names. The material's `attribute()` strings and the
 * layer's `geometry.setAttribute` calls are linked by NOTHING but this object —
 * a typo silently reads zeros — so both sides spell them from here.
 */
export const HEATMAP_ATTR = {
  /** vec3, RTC-local splat centre. */
  center: 'sttCenter',
  /** float, accumulation weight (`1` for a pure count heatmap). */
  weight: 'sttWeight',
  /** float, start time relative to the scene time origin. */
  start: 'sttStart',
  /** float, end time relative to the scene time origin. */
  end: 'sttEnd',
} as const;

/**
 * Gaussian splat falloff, `exp(-r² · falloff)`. `1 / 0.15` reproduces the
 * maplibre backend's `exp(-r² / 0.15)` — a tight, bright core — so the two
 * backends' splats have the same shape at the same `radiusPixels`.
 */
export const DEFAULT_SPLAT_FALLOFF = 1 / 0.15;

/** Which weight kernel a splat deposits over its disc. */
export type HeatmapKernel = 'gaussian' | 'epanechnikov';

/**
 * Live splat-pass uniforms. `radiusPixels` is the splat HALF-size in CSS
 * pixels (density is a screen-space quantity — a metric radius would make the
 * heatmap dissolve on zoom-out), so the quad is expanded in CLIP space against
 * `viewport`, the drawing-buffer size the host pushes on resize.
 */
export class HeatmapSplatUniforms {
  /** Splat radius in device pixels (deck's `radiusPixels`). */
  readonly radiusPixels: UniformNode = uniform(30);
  /** Global weight multiplier (maplibre's `uIntensity`). */
  readonly intensity: UniformNode = uniform(1);
  /** Gaussian tightness; ignored by the Epanechnikov kernel. */
  readonly splatFalloff: UniformNode = uniform(DEFAULT_SPLAT_FALLOFF);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
}

/**
 * Live ramp-pass uniforms. `[domainMin, domainMax]` is the ACCUMULATED-density
 * range mapped onto the ramp (deck / maplibre `colorDomain`); `threshold` is
 * the density below which a pixel is fully transparent.
 */
export class HeatmapRampUniforms {
  readonly domainMin: UniformNode = uniform(0);
  readonly domainMax: UniformNode = uniform(1);
  readonly threshold: UniformNode = uniform(0.05);
  readonly opacity: UniformNode = uniform(1);
}

export interface HeatmapSplatMaterialOptions {
  /**
   * Which temporal kernel decides whether a point splats this frame — the
   * shared `window` / `wake` / `cumulative` / `trail` / `none` vocabulary.
   * @default 'window'
   */
  mode?: TimeFilterMode;
  /**
   * Splat kernel. `'gaussian'` (default, deck + maplibre parity) is
   * `exp(-r² · splatFalloff)`; `'epanechnikov'` is `max(0, 1 - r²)`, the
   * compact-support kernel of the KDEEB literature, which reaches EXACTLY zero
   * at the disc edge and so leaves no faint square where the quad is clipped.
   * @default 'gaussian'
   */
  kernel?: HeatmapKernel;
}

export interface HeatmapRampMaterialOptions {
  /**
   * The accumulated-density texture (the splat pass's render-target texture).
   * Sampled at {@link screenUV}, so the ramp quad must cover the same viewport
   * the splats were accumulated in.
   */
  densityTexture: Texture;
  /**
   * Colour ramp, low → high density, as 0–255 sRGB RGBA stops. Evenly spaced
   * and linearly interpolated — the analytic form of maplibre's 256-texel LUT.
   * BAKED into the node graph, so changing it is a material rebuild (a
   * structural variant, like icon's stable-palette flag), never a per-frame
   * uniform. @default `DEFAULT_HEATMAP_COLOR_RANGE` (ColorBrewer OrRd, 7 stops)
   */
  colorRange?: readonly PaletteRGBA[];
}

export type HeatmapMaterialOptions = HeatmapSplatMaterialOptions &
  HeatmapRampMaterialOptions;

export interface HeatmapSplatBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  splat: HeatmapSplatUniforms;
  mode: TimeFilterMode;
  kernel: HeatmapKernel;
}

export interface HeatmapRampBundle {
  material: MeshBasicNodeMaterial;
  ramp: HeatmapRampUniforms;
  /** Number of colour stops baked into the graph (≥ 1). */
  stops: number;
}

/** The pass pair. The layer renders `splat` off-screen, then `ramp` on-screen. */
export interface HeatmapMaterialBundle {
  splat: HeatmapSplatBundle;
  ramp: HeatmapRampBundle;
}

/**
 * Clip-space billboard for one splat: project the centre, then push the quad
 * corner by a constant PIXEL half-size. `corner ∈ [-1,1]²`, so `corner · half`
 * is ±half px; `px → NDC` is `×2/viewport` and `NDC → clip` is `×clip.w`, which
 * cancels the perspective divide so the splat keeps a constant on-screen radius
 * regardless of depth. Same construction as the point material's `'pixels'`
 * sizing and the wide-line material's width.
 */
function splatVertexNode(
  center: TSLNode,
  corner: TSLNode,
  half: TSLNode,
  viewport: UniformNode,
): TSLNode {
  const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(center, 1));
  const off = corner.mul(half).mul(float(2)).div(viewport).mul(clip.w);
  return vec4(clip.x.add(off.x), clip.y.add(off.y), clip.z, clip.w);
}

/**
 * Build the ACCUMULATION material: one additively-blended splat per point,
 * writing a scalar density (replicated across RGB, as maplibre does) into a
 * single-channel float target.
 */
export function createHeatmapSplatMaterial(
  opts: HeatmapSplatMaterialOptions = {},
): HeatmapSplatBundle {
  const mode: TimeFilterMode = opts.mode ?? 'window';
  const kernel: HeatmapKernel = opts.kernel ?? 'gaussian';
  const time = new TimeFilterUniforms();
  const splat = new HeatmapSplatUniforms();

  const center = attribute(HEATMAP_ATTR.center, 'vec3');
  const weight = attribute(HEATMAP_ATTR.weight, 'float');
  const start = attribute(HEATMAP_ATTR.start, 'float');
  const end = attribute(HEATMAP_ATTR.end, 'float');
  const corner = positionGeometry.xy;

  // VERTEX stage. The time alpha (a `select()`) is consumed directly here, never
  // wrapped in a varying, so the WGSL backend builds it.
  const vertexAlpha = timeFilterAlphaNode(mode, time, start, end);
  // Wake mode shrinks the tail toward `wakeTailScale`; every other mode keeps
  // the full radius (maplibre's heatmap does the same).
  const sizeFactor =
    mode === 'wake' ? wakeSizeScaleNode(time, vertexAlpha) : float(1);
  // HARD collapse: an out-of-window splat gets half = 0, its four corners
  // coincide, the primitive dies at assembly and deposits ZERO density.
  const visible = timeFilterVisibleNode(mode, time, start, end);
  const half = splat.radiusPixels.mul(sizeFactor).mul(visible);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = splatVertexNode(center, corner, half, splat.viewport);

  // FRAGMENT stage: vary the RAW inputs and recompute the `select()`-based time
  // alpha here (see the header's WGSL discipline note).
  const vUv = varying(corner);
  const vWeight = varying(weight);
  const vStart = varying(start);
  const vEnd = varying(end);
  const fragAlpha = timeFilterAlphaNode(mode, time, vStart, vEnd);

  const r2 = vUv.dot(vUv);
  const shape =
    kernel === 'gaussian'
      ? exp(r2.mul(splat.splatFalloff).negate())
      : saturate(oneMinus(r2)); // Epanechnikov: max(0, 1 − r²)
  // Outside the inscribed circle the quad's corners contribute nothing, so the
  // splat is a disc and not a square.
  const density = select(
    r2.greaterThan(1),
    float(0),
    shape.mul(vWeight).mul(splat.intensity).mul(fragAlpha),
  );

  // NO `srgbToWorking` here — this is a density, not a colour (see the header).
  material.colorNode = vec3(density);
  // Hard 1: `AdditiveBlending` multiplies the source by srcAlpha, so anything
  // less would attenuate the contribution a second time. The soft time fade is
  // already inside `density`.
  material.opacityNode = float(1);
  material.transparent = true;
  material.blending = AdditiveBlending;
  // Accumulation is order-independent and must not self-occlude: every splat
  // has to reach the target regardless of depth.
  material.depthWrite = false;
  material.depthTest = false;
  material.side = DoubleSide;

  return { material, time, splat, mode, kernel };
}

/**
 * The baked colour-ramp node: `t ∈ [0,1]` → an sRGB `vec4` interpolated across
 * evenly-spaced `stops`.
 *
 * Built as a progressive `mix()` chain rather than a palette texture: with
 * `x = t · (n-1)`, every mix before the active segment has saturated to 1 and
 * every mix after it is 0, so the chain evaluates to exactly the linear
 * interpolation between the two bracketing stops — analytically identical to
 * maplibre's linearly-filtered 256-texel LUT, with no texture to allocate,
 * upload or dispose.
 */
function rampColorNode(stops: readonly PaletteRGBA[], t: TSLNode): TSLNode {
  const asVec4 = (c: PaletteRGBA): TSLNode =>
    vec4(
      float(c[0] / 255),
      float(c[1] / 255),
      float(c[2] / 255),
      float((c[3] ?? 255) / 255),
    );
  if (stops.length === 1) return asVec4(stops[0]);
  const x = t.mul(float(stops.length - 1));
  let color = asVec4(stops[0]);
  for (let i = 1; i < stops.length; i++) {
    color = mix(color, asVec4(stops[i]), saturate(x.sub(float(i - 1))));
  }
  return color;
}

/**
 * Build the RESOLVE material: a full-screen quad that reduces the accumulated
 * density texture to one colour per pixel.
 *
 * `vertexNode` emits clip space DIRECTLY from the quad's `[-1,1]²` corners, so
 * the pass is camera-independent by construction (the mesh's own transform is
 * never read) and the density texture is sampled at {@link screenUV} — three's
 * own screen-space coordinate, which is what makes the sample flip-correct on
 * both the WebGPU and WebGL2 backends.
 */
export function createHeatmapRampMaterial(
  opts: HeatmapRampMaterialOptions,
): HeatmapRampBundle {
  const stops =
    opts.colorRange && opts.colorRange.length > 0
      ? opts.colorRange
      : DEFAULT_HEATMAP_COLOR_RANGE;
  const ramp = new HeatmapRampUniforms();

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(positionGeometry.xy, float(0), float(1));

  // ONE sample of the accumulated field per pixel — the whole point of the
  // second pass.
  const density = texture(opts.densityTexture, screenUV).r;
  const span = max(ramp.domainMax.sub(ramp.domainMin), float(EPS));
  const t = saturate(density.sub(ramp.domainMin).div(span));
  const color = rampColorNode(stops, t);

  // Below `threshold` the field is noise (one stray point in an empty region);
  // fade it out over a narrow band above the threshold rather than cutting a
  // hard edge. Byte-for-byte the maplibre backend's
  // `smoothstep(uThreshold, uThreshold + 0.05, intensity)`.
  const gate = smoothstep(
    ramp.threshold,
    ramp.threshold.add(float(0.05)),
    density,
  );

  // Convert LAST, on the final fragment RGB only — never the alpha.
  material.colorNode = srgbToWorking(color.xyz);
  material.opacityNode = color.w.mul(gate).mul(ramp.opacity);
  material.transparent = true;
  material.blending = NormalBlending;
  // A screen-space composite: it owns no depth and must not occlude the scene
  // it is drawn over.
  material.depthWrite = false;
  material.depthTest = false;
  material.side = DoubleSide;

  return { material, ramp, stops: stops.length };
}

/** Build both passes of the heatmap pipeline. */
export function createHeatmapMaterial(
  opts: HeatmapMaterialOptions,
): HeatmapMaterialBundle {
  return {
    splat: createHeatmapSplatMaterial(opts),
    ramp: createHeatmapRampMaterial(opts),
  };
}

/** Live values pushed into both passes once per frame. */
export interface HeatmapUniformValues {
  /** Playhead minus the scene time origin (f32-exact). */
  relativeCurrentTime: number;
  params?: TimeFilterParams & { wakeTailScale?: number };
  /** Splat half-size in device pixels. @default 30 */
  radiusPixels?: number;
  /** Global weight multiplier. @default 1 */
  intensity?: number;
  /** Gaussian tightness (`gaussian` kernel only). @default `1 / 0.15` */
  splatFalloff?: number;
  /** Drawing-buffer size `[w,h]` in px (push on resize). */
  viewport?: [number, number];
  /** `[min,max]` ACCUMULATED-density range mapped onto the ramp. @default [0,1] */
  colorDomain?: [number, number];
  /** Density below which a pixel renders transparent. @default 0.05 */
  threshold?: number;
  /** Ramp-pass opacity multiplier. @default 1 */
  opacity?: number;
}

/** Push the splat pass's per-frame values (a uniform write, never a rebuild). */
export function updateHeatmapSplatUniforms(
  bundle: HeatmapSplatBundle,
  v: HeatmapUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.splat.radiusPixels.value = v.radiusPixels ?? 30;
  bundle.splat.intensity.value = v.intensity ?? 1;
  bundle.splat.splatFalloff.value = v.splatFalloff ?? DEFAULT_SPLAT_FALLOFF;
  if (v.viewport) {
    bundle.splat.viewport.value.set(v.viewport[0], v.viewport[1]);
  }
}

/** Push the ramp pass's per-frame values. */
export function updateHeatmapRampUniforms(
  bundle: HeatmapRampBundle,
  v: HeatmapUniformValues,
): void {
  const domain = v.colorDomain ?? [0, 1];
  bundle.ramp.domainMin.value = domain[0];
  bundle.ramp.domainMax.value = domain[1];
  bundle.ramp.threshold.value = v.threshold ?? 0.05;
  bundle.ramp.opacity.value = v.opacity ?? 1;
}

/** Fan one values object out to both passes. Call once per frame. */
export function updateHeatmapUniforms(
  bundle: HeatmapMaterialBundle,
  v: HeatmapUniformValues,
): void {
  updateHeatmapSplatUniforms(bundle.splat, v);
  updateHeatmapRampUniforms(bundle.ramp, v);
}
