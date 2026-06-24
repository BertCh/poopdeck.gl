// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `SurfelMaterial` — the TSL port of deck's `SplatPrimitiveLayer` GLSL.
 *
 * One instance = one oriented anisotropic Gaussian surfel: a flat elliptical disk
 * in its local surface frame, with a soft radial Gaussian profile AND a soft
 * temporal Gaussian weight, rendered depth-tested with depth-WRITE on and an
 * alpha cutoff — surface splatting (Pfister/Zwicker), so the z-buffer gives
 * correct occlusion with NO back-to-front sort.
 *
 * Differences from the deck shader (all simplifications, same visual result):
 *   • In the local ENU world (see `../projection/local-enu`), 1 unit = 1 metre
 *     and the surfel quaternion's basis is already expressed in that frame, so
 *     the disk-offset is added in OBJECT space and Three's model-view-projection
 *     does the rest — no deck `project_size` / common-space dance.
 *   • Off-time surfels are culled by collapsing the hexagon to its centre
 *     (`offset * visible`, visible∈{0,1}) → a zero-area triangle, the Three
 *     analogue of deck's `gl_Position = vec4(0)`.
 *   • Sub-cutoff fragments are dropped via `material.alphaTest` (no depth write),
 *     matching deck's `if (a < alphaCutoff) discard`.
 *
 * The math (quaternion unpack, quat→tangent/bitangent, temporal Gaussian
 * static/dynamic/cumulative, radial falloff) mirrors `splat-primitive-layer.ts`
 * line-for-line.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  int,
  vec3,
  vec4,
  select,
  max,
  exp,
  sqrt,
  mix,
  step,
  oneMinus,
  type TSLNode,
  type UniformNode,
} from './nodes';

/** Per-frame / per-config surfel uniforms. The layer sets `.value` each tick. */
export class SurfelUniforms {
  /** Play time RELATIVE to the layer's time origin. */
  readonly currentTime: UniformNode = uniform(0);
  /** Soft temporal Gaussian width for static surfels (ms). */
  readonly temporalSigma: UniformNode = uniform(180);
  /** Soft temporal Gaussian width for dynamic surfels (ms). */
  readonly temporalSigmaDynamic: UniformNode = uniform(180);
  /** Multiplier on baked surfel extents. */
  readonly sizeScale: UniformNode = uniform(1);
  /** Radial Gaussian tightness (`alpha *= exp(-falloff·r²)`). */
  readonly falloff: UniformNode = uniform(3);
  /** Layer opacity. */
  readonly opacity: UniformNode = uniform(1);
  /** Worldbuild accreted reveal: >0.5 ⇒ statics appear-and-persist. */
  readonly cumulative: UniformNode = uniform(0);
  /** Reveal alpha-ramp (ms) for cumulative statics; 0 ⇒ instant. */
  readonly revealFade: UniformNode = uniform(0);
}

export interface SurfelMaterialOptions {
  /** Quaternion attribute is smallest-three packed `[a,b,c,imax]`. @default false */
  packed?: boolean;
  /** Discard fragments below this final alpha (no depth write). @default 0.04 */
  alphaCutoff?: number;
}

export interface SurfelMaterialBundle {
  material: MeshBasicNodeMaterial;
  uniforms: SurfelUniforms;
}

/** Reconstruct a full quaternion from the smallest-three packing `[a,b,c,imax]`. */
function unpackQuat(p: TSLNode): TSLNode {
  const a = p.x;
  const b = p.y;
  const c = p.z;
  const d = sqrt(max(float(0), float(1).sub(a.mul(a)).sub(b.mul(b)).sub(c.mul(c))));
  const m = int(p.w.add(0.5));
  return select(
    m.equal(0),
    vec4(d, a, b, c),
    select(m.equal(1), vec4(a, d, b, c), select(m.equal(2), vec4(a, b, d, c), vec4(a, b, c, d))),
  );
}

/** Quaternion → the two in-plane basis vectors (matrix columns 0 and 1). */
function quatTangentBitangent(q: TSLNode): { tangent: TSLNode; bitangent: TSLNode } {
  const x = q.x;
  const y = q.y;
  const z = q.z;
  const w = q.w;
  const x2 = x.add(x);
  const y2 = y.add(y);
  const z2 = z.add(z);
  const xx = x.mul(x2);
  const xy = x.mul(y2);
  const xz = x.mul(z2);
  const yy = y.mul(y2);
  const yz = y.mul(z2);
  const zz = z.mul(z2);
  const wx = w.mul(x2);
  const wy = w.mul(y2);
  const wz = w.mul(z2);
  const tangent = vec3(float(1).sub(yy.add(zz)), xy.add(wz), xz.sub(wy));
  const bitangent = vec3(xy.sub(wz), float(1).sub(xx.add(zz)), yz.add(wx));
  return { tangent, bitangent };
}

/**
 * Create a surfel material + its uniforms. The layer attaches per-instance
 * attributes `sttCenter` (vec3, ENU metres), `sttQuat` (vec4), `sttScale` (vec2),
 * `sttColor` (vec4), `sttStart` (float, relative ms), `sttDynamic` (float 0/1).
 */
export function createSurfelMaterial(opts: SurfelMaterialOptions = {}): SurfelMaterialBundle {
  const u = new SurfelUniforms();

  const center = attribute('sttCenter', 'vec3');
  const rawQuat = attribute('sttQuat', 'vec4');
  const scale = attribute('sttScale', 'vec2');
  const color = attribute('sttColor', 'vec4');
  const startTime = attribute('sttStart', 'float');
  const isDynamic = attribute('sttDynamic', 'float');

  const quat = opts.packed ? unpackQuat(rawQuat) : rawQuat;
  const { tangent, bitangent } = quatTangentBitangent(quat);

  // ── Temporal weight (mirrors splat-primitive-layer.ts) ──────────────────────
  // IMPORTANT: `weight`/`visible` are carried to the fragment stage in `vWeight`
  // (a `varying`). A `select()` (ConditionalNode) fails to build on the WGSL
  // backend when wrapped in a `varying()` — the if/else control flow can't be
  // lifted into a varying assignment, so the build throws ("undefined .build").
  // So this whole block is BRANCH-FREE: `step()` casts a comparison to a 0/1
  // float and `mix(a, b, t∈{0,1})` is the arithmetic equivalent of `select`.
  const age = u.currentTime.sub(startTime);
  const sigma = max(mix(u.temporalSigma, u.temporalSigmaDynamic, isDynamic), float(1));
  const dt = age.div(sigma);
  const symWeight = exp(dt.mul(dt).mul(-0.5));
  const symVisF = step(float(0.0111), symWeight); // symWeight ≥ 0.0111 ? 1 : 0

  // Cumulative (worldbuild) reveal: statics appear-and-persist, optional ramp.
  const ramp = age.div(max(u.revealFade, float(1))).clamp(0, 1);
  const fadeOn = step(float(0.5), u.revealFade); // revealFade > 0 ? 1 : 0
  const cumWeight = mix(float(1), ramp, fadeOn);
  const cumVisF = step(float(0), age); // age ≥ 0 ? 1 : 0
  // cumulative-static instance: cumulative uniform ON and this surfel is static.
  const cumStaticF = step(float(0.5), u.cumulative).mul(oneMinus(step(float(0.5), isDynamic)));

  const weight = mix(symWeight, cumWeight, cumStaticF);
  const visible = mix(symVisF, cumVisF, cumStaticF);

  // ── Oriented disk expansion (object space, metres) ──────────────────────────
  const corner = positionGeometry.xy; // hexagon corner (u,v); disk rim at r=1
  const ss = u.sizeScale;
  const offset = tangent
    .mul(corner.x.mul(scale.x).mul(ss))
    .add(bitangent.mul(corner.y.mul(scale.y).mul(ss)));
  // Collapse off-time surfels to a zero-area triangle (deck's gl_Position=0).
  const localPos = center.add(offset.mul(visible));

  const material = new MeshBasicNodeMaterial();
  material.positionNode = localPos;

  // Pass per-instance terms to the fragment stage.
  const vColor = varying(color);
  const vWeight = varying(weight.mul(visible));
  const vUv = varying(corner);

  const r2 = vUv.dot(vUv);
  const g = exp(r2.mul(u.falloff).negate());
  const alpha = select(r2.greaterThan(1), float(0), vColor.a.mul(u.opacity).mul(vWeight).mul(g));

  material.colorNode = vColor.xyz;
  material.opacityNode = alpha;

  // Surface splatting: depth-test + depth-WRITE on, std src-over, two-sided.
  material.transparent = true;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  // Sub-cutoff fragments (faint rims) are discarded → no depth write, no halo.
  material.alphaTest = opts.alphaCutoff ?? 0.04;

  return { material, uniforms: u };
}

/** Push per-frame + per-config values into the surfel uniforms. */
export interface SurfelUniformValues {
  relativeCurrentTime: number;
  temporalSigma?: number;
  temporalSigmaDynamic?: number;
  sizeScale?: number;
  falloff?: number;
  opacity?: number;
  cumulative?: boolean;
  revealFade?: number;
}

export function updateSurfelUniforms(u: SurfelUniforms, v: SurfelUniformValues): void {
  const sigma = v.temporalSigma ?? 180;
  u.currentTime.value = v.relativeCurrentTime;
  u.temporalSigma.value = sigma;
  // 0/unset dynamic σ falls back to the static σ (deck parity).
  u.temporalSigmaDynamic.value = v.temporalSigmaDynamic && v.temporalSigmaDynamic > 0
    ? v.temporalSigmaDynamic
    : sigma;
  u.sizeScale.value = v.sizeScale ?? 1;
  u.falloff.value = v.falloff ?? 3;
  u.opacity.value = v.opacity ?? 1;
  u.cumulative.value = v.cumulative ? 1 : 0;
  u.revealFade.value = v.revealFade ?? 0;
}
