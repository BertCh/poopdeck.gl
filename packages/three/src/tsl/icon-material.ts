// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `IconMaterial` — directional billboard markers, the Three port of deck's
 * `AnimatedIconLayer`. Each instance is a camera-facing quad (built in
 * `vertexNode` like {@link createPointMaterial}) BUT sized in **screen pixels**
 * (deck `IconLayer`'s default `sizeUnits: 'pixels'`), rotated by a per-instance
 * heading attribute, and textured from a shared icon-atlas {@link Texture} via a
 * per-instance UV sub-rectangle. The shared {@link timeFilterAlphaNode} gives the
 * same window / cumulative animation as deck.
 *
 * VERTEX: the instance centre goes to clip space (`MVP · center`); the quad corner
 * (`[-1,1]²`) is rotated by `angle` (radians, CCW from up) and the optional anchor
 * offset, scaled to `sizePx/2` and converted to a clip offset via `2/viewport · w`
 * so the marker is a constant pixel size on screen at any depth (the same
 * pixel→clip conversion as {@link createWideLineMaterial}). `sizePx` is clamped to
 * `[sizeMinPixels, sizeMaxPixels]`.
 *
 * FRAGMENT: the rotated corner maps to the instance's atlas UV rect and samples
 * the atlas. For a `mask` icon the sampled alpha modulates the per-instance tint
 * (the tint REPLACES the sprite colour); for an opaque icon the sampled RGB is
 * modulated by the tint. The time alpha (a `select()`) is recomputed in the
 * FRAGMENT stage from VARIED raw `start`/`end` — never wrapped in a `varying()`
 * (the codebase's recurring WGSL crash; `mix()`/`step()` ARE varying-safe).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending } from 'three';
import type { Texture } from 'three';
import * as TSL from 'three/tsl';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec4,
  mix,
  modelViewMatrix,
  cameraProjectionMatrix,
  type UniformNode,
} from './nodes';
import {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  updateTimeFilterUniforms,
} from './time-filter';
import type { TimeFilterMode, TimeFilterParams } from './time-filter-math';

// Extra TSL builders not yet surfaced on the ./nodes seam (texture sampling +
// the per-instance rotation trig). Loosely typed like the ./nodes re-exports.
const texture = TSL.texture as unknown as (...a: any[]) => any;
const cos = TSL.cos as unknown as (...a: any[]) => any;
const sin = TSL.sin as unknown as (...a: any[]) => any;

/** Icon time-filter modes (deck `AnimatedIconLayer` is window-only; cumulative
 *  added here for the "leave a marker trail" worldbuild look). */
export type IconMode = Extract<TimeFilterMode, 'window' | 'cumulative' | 'none'>;

/** Live icon uniforms: pixel-size clamp, opacity, and the canvas size in px. */
export class IconUniforms {
  readonly opacity: UniformNode = uniform(1);
  /** Global multiplier on every instance's pixel size (deck `sizeScale`). */
  readonly sizeScale: UniformNode = uniform(1);
  readonly sizeMinPixels: UniformNode = uniform(0);
  readonly sizeMaxPixels: UniformNode = uniform(1e9);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
}

export interface IconMaterialOptions {
  /** Time-filter mode: window (raw), cumulative (markers persist), none. */
  mode: IconMode;
  /** The icon-atlas texture (host provides the loaded atlas image). */
  atlas: Texture;
  /**
   * `mask: true` icons are single-channel silhouettes — the sampled ALPHA gates
   * the per-instance tint (which supplies the colour). `false` icons are opaque
   * sprites whose sampled RGB is modulated by the tint. @default false
   */
  mask?: boolean;
  /** Discard fragments below this final alpha. @default 0.05 */
  alphaCutoff?: number;
}

export interface IconMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  icon: IconUniforms;
  mode: IconMode;
}

export function createIconMaterial(opts: IconMaterialOptions): IconMaterialBundle {
  const time = new TimeFilterUniforms();
  const icon = new IconUniforms();

  // ── per-instance attributes (set by the layer) ──────────────────────────────
  const center = attribute('sttCenter', 'vec3');
  const color = attribute('sttColor', 'vec4');
  const angle = attribute('sttAngle', 'float'); // radians, CCW from up
  const size = attribute('sttSize', 'float'); // on-screen pixels (full height)
  const uvRect = attribute('sttUvRect', 'vec4'); // [u0,v0,u1,v1]
  const anchor = attribute('sttAnchor', 'vec2'); // [-1,1] quad-space offset
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const corner = positionGeometry.xy; // [-1,1]²

  // ── VERTEX: rotate the corner, size in pixels, expand in clip space ──────────
  // Apply the anchor offset first (in unrotated quad space), then rotate the whole
  // quad by `angle` so the anchor rides with the rotation (deck rotates about the
  // anchor). Rotation is CCW from up: a heading of 0 keeps the icon's up axis up.
  const c = cos(angle);
  const s = sin(angle);
  const local = corner.add(anchor); // [-1,1] offset by anchor
  const rx = local.x.mul(c).sub(local.y.mul(s));
  const ry = local.x.mul(s).add(local.y.mul(c));

  const sizePx = TSL.clamp(
    size.mul(icon.sizeScale),
    icon.sizeMinPixels,
    icon.sizeMaxPixels,
  );
  const half = sizePx.mul(0.5);

  const clip = cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(center, 1)));
  // pixel half-offset (corner·half px) → NDC (×2/viewport) → clip (×w).
  const offX = rx.mul(half).mul(float(2)).div(icon.viewport.x).mul(clip.w);
  const offY = ry.mul(half).mul(float(2)).div(icon.viewport.y).mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(clip.x.add(offX), clip.y.add(offY), clip.z, clip.w);

  // ── FRAGMENT: atlas sample (rotated UV) × tint × time alpha ──────────────────
  // The UNROTATED corner [-1,1]² maps to the atlas rect — the GEOMETRY was rotated
  // in clip space above, so the sprite stays upright in atlas space and rotates on
  // screen. corner∈[-1,1] → t∈[0,1]: u = mix(u0,u1, (x+1)/2); atlas v origin is the
  // top, quad +y is up, so v = mix(v0,v1, (1-y)/2) (top row ↔ +y).
  const vColor = varying(color);
  const vUvRect = varying(uvRect);
  const vCorner = varying(corner);
  const vStart = varying(start);
  const vEnd = varying(end);

  const tx = vCorner.x.add(1).mul(0.5);
  const ty = float(1).sub(vCorner.y).mul(0.5);
  const sampleU = mix(vUvRect.x, vUvRect.z, tx);
  const sampleV = mix(vUvRect.y, vUvRect.w, ty);
  const tex = texture(opts.atlas, vec2(sampleU, sampleV));

  const fragAlpha = timeFilterAlphaNode(opts.mode, time, vStart, vEnd);

  // mask: tint supplies colour, atlas alpha gates it. opaque: atlas RGB × tint.
  const rgb = opts.mask ? vColor.xyz : tex.xyz.mul(vColor.xyz);
  const baseA = opts.mask ? tex.a.mul(vColor.a) : tex.a.mul(vColor.a);
  const a = baseA.mul(icon.opacity).mul(fragAlpha);

  material.colorNode = rgb;
  material.opacityNode = a;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.05;

  return { material, time, icon, mode: opts.mode };
}

export interface IconUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  opacity?: number;
  sizeScale?: number;
  sizeMinPixels?: number;
  sizeMaxPixels?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize). */
  viewport?: [number, number];
}

export function updateIconUniforms(bundle: IconMaterialBundle, v: IconUniformValues): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  if (v.opacity !== undefined) bundle.icon.opacity.value = v.opacity;
  if (v.sizeScale !== undefined) bundle.icon.sizeScale.value = v.sizeScale;
  if (v.sizeMinPixels !== undefined) bundle.icon.sizeMinPixels.value = v.sizeMinPixels;
  if (v.sizeMaxPixels !== undefined) bundle.icon.sizeMaxPixels.value = v.sizeMaxPixels;
  if (v.viewport) bundle.icon.viewport.value.set(v.viewport[0], v.viewport[1]);
}
