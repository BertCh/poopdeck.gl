// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `MeshMaterial` — the instanced-model material behind
 * {@link import('../layers/mesh-layer.js').STTMeshLayer}: one recognizable 3D
 * model (car / pedestrian / ship / plane) per tracked object, self-lit and
 * tinted per instance. The Three answer to deck's `SimpleMeshLayer` under
 * `AnimatedMeshLayer`.
 *
 * ── POSITION (`positionNode`) ────────────────────────────────────────────────
 * The model's object position `(ox, oy, oz)` is recomposed into the RTC-local
 * instance frame by three per-instance basis columns, exactly the idiom
 * `column-material.ts` established:
 *   `local = sttCenter + ox·sttBasisX + oy·sttBasisY + oz·sttBasisZ`
 * The bake (`../lib/mesh-instances.ts`) folds the interpolated pose, the
 * `[length, width, height]` scale, the metric→world factor AND the projection's
 * local east/north/up frame into those three columns, so ONE instance buffer
 * covers the AV Z-up plane, mercator and the ECEF globe with no shader branch.
 *
 * ── NO TIME FILTER — and that is the whole point ─────────────────────────────
 * Every other timed kind in this package gates on a `[start, end]` window. This
 * one deliberately does NOT, and carries no `TimeFilterUniforms`, no
 * `sttStart`/`sttEnd` attributes and no vertex-stage collapse gate.
 *
 * The archive holds one snapshot per object PER KEYFRAME. A window filter would
 * therefore draw N models per object whenever the window spans N keyframes — a
 * "train" of cars trailing every car, which is the bug deck's
 * `AnimatedMeshLayer` was rewritten to kill. Instead the CPU emits exactly one
 * interpolated instance per ACTIVE track each frame and simply omits inactive
 * ones, so VISIBILITY IS IMPLICIT in `geometry.instanceCount`. The appear /
 * disappear fade is likewise a CPU ramp already folded into `sttColor.a` by the
 * time it reaches here.
 *
 * That is why this material's id variant has no gate to mirror beyond the pose
 * itself plus the fade threshold — see {@link createMeshIdMaterial}.
 *
 * ── SHADE (baked into `colorNode`) ───────────────────────────────────────────
 * Unlit `MeshBasicNodeMaterial`, like the rest of this renderer (there are no
 * scene lights anywhere). The object normal is rotated into world space by the
 * NORMALIZED basis — direction only, so it stays a pure rotation under the
 * non-uniform length/width/height scale — and a fixed-sun
 * `ambient + (1−ambient)·max(0, N·L)` term multiplies the albedo, so the model's
 * 3D form reads regardless of the host scene. `lit: false` is the analogue of
 * deck's `material: false`: flat albedo, no shading.
 *
 * Colour is converted sRGB→working LAST, on the final fragment colour, colour
 * channels only (see `./color-space.ts`).
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec3,
  saturate,
  select,
  type UniformNode,
  type TSLNode,
} from './nodes.js';
import { srgbToWorking } from './color-space.js';

/** Ambient floor of the baked self-lit shade (shadowed faces stay readable). */
const MESH_AMBIENT = 0.45;

/** Fixed world-space sun direction for the baked Lambert term (shared with columns). */
const MESH_SUN: readonly [number, number, number] = [0.32, 0.4, 0.86];

/** Live mesh uniforms — a constant opacity multiplier over the per-instance alpha. */
export class MeshUniforms {
  readonly opacity: UniformNode = uniform(1);
}

export interface MeshMaterialOptions {
  /**
   * Bake the fixed-sun Lambert shade into the albedo (deck `material: true`).
   * `false` renders flat albedo — right for a model whose colour already carries
   * its own shading. @default true
   */
  lit?: boolean;
  /** Translucent models (lets the appear/disappear fade show). @default false */
  transparent?: boolean;
  /** Discard fragments below this alpha when transparent. @default 0.01 */
  alphaCutoff?: number;
  /** Draw the models in wireframe (deck `wireframe` pass-through). @default false */
  wireframe?: boolean;
}

export interface MeshMaterialBundle {
  material: MeshBasicNodeMaterial;
  mesh: MeshUniforms;
  /** Whether the fixed-sun shade term was baked in. */
  lit: boolean;
  /**
   * ALWAYS false, and present so the bundle reads like its timed siblings' —
   * this kind has no time-window gate at all (see the file header). Keeping the
   * field makes the absence explicit at every call site rather than something a
   * reader has to notice is missing.
   */
  readonly timeFiltered: false;
}

/**
 * Shared vertex stage: recompose the model's object position into the RTC-local
 * instance frame. Built by BOTH the colour and the id material from the SAME
 * attributes and the SAME expression, so a model picks exactly where — and only
 * where — it is drawn.
 */
function meshPositionNode(): {
  local: TSLNode;
  bx: TSLNode;
  by: TSLNode;
  bz: TSLNode;
  color: TSLNode;
} {
  const center = attribute('sttCenter', 'vec3');
  const bx = attribute('sttBasisX', 'vec3');
  const by = attribute('sttBasisY', 'vec3');
  const bz = attribute('sttBasisZ', 'vec3');
  const color = attribute('sttColor', 'vec4');
  const op = positionGeometry; // model-space vertex
  const local = center.add(bx.mul(op.x).add(by.mul(op.y)).add(bz.mul(op.z)));
  return { local, bx, by, bz, color };
}

export function createMeshMaterial(
  opts: MeshMaterialOptions = {},
): MeshMaterialBundle {
  const mesh = new MeshUniforms();
  const lit = opts.lit ?? true;
  const transparent = opts.transparent ?? false;

  const { local, bx, by, bz, color } = meshPositionNode();

  const material = new MeshBasicNodeMaterial();
  material.positionNode = vec3(local);

  // Self-lit (no scene lights needed): rotate the model normal into world space
  // by the NORMALIZED basis, so the rotation survives the non-uniform
  // length/width/height scale, then bake a fixed-sun Lambert term into the
  // albedo. `varying` the world normal (a plain arithmetic graph, never a
  // select()) and re-normalizing per fragment keeps the shading smooth.
  let shade: TSLNode = float(1);
  if (lit) {
    const nrm = attribute('normal', 'vec3');
    const worldN = bx
      .normalize()
      .mul(nrm.x)
      .add(by.normalize().mul(nrm.y))
      .add(bz.normalize().mul(nrm.z));
    const vWorldN = varying(worldN);
    const ndl = saturate(vWorldN.normalize().dot(vec3(...MESH_SUN)));
    shade = float(MESH_AMBIENT).add(ndl.mul(1 - MESH_AMBIENT));
  }

  // Per-instance albedo × baked shade, THEN sRGB→working (see ./color-space.ts):
  // the shade multiplies INSIDE the conversion because deck darkens the 0–255
  // colour the same way — converting first would change the falloff curve.
  const vColor = varying(color);
  material.colorNode = srgbToWorking(vColor.xyz.mul(shade));
  // The appear/disappear fade already rode in on the instance alpha (a CPU ramp
  // from the shared track kernel), so opacity is just that × the layer constant.
  material.opacityNode = vColor.a.mul(mesh.opacity);

  material.transparent = transparent;
  material.depthWrite = transparent ? false : true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.wireframe = opts.wireframe ?? false;
  if (transparent) material.alphaTest = opts.alphaCutoff ?? 0.01;

  return { material, mesh, lit, timeFiltered: false };
}

export interface MeshUniformValues {
  /** Constant opacity multiplier over the per-instance (faded) alpha. @default 1 */
  opacity?: number;
}

/**
 * Push one frame's uniform values — a uniform WRITE, not a rebuild, cheap every
 * frame. Deliberately takes the same bundle shape the id material returns, so
 * the pick pass syncs through this same call.
 */
export function updateMeshUniforms(
  bundle: MeshMaterialBundle,
  v: MeshUniformValues = {},
): void {
  bundle.mesh.opacity.value = v.opacity ?? 1;
}

// ── GPU id-buffer pick material (GPU picking catalog: mesh variant) ───────────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Renders each model's flat
// per-instance id colour (`sttIdColor`) into the picker's off-screen target.
//
// It recomposes the SAME model at the SAME pose as the colour material —
// identical `positionNode`, built from the identical attributes by the shared
// {@link meshPositionNode} — so a model picks exactly where it is drawn, at its
// interpolated pose rather than at any keyframe. There is no time-window /
// data-filter collapse gate to mirror because the colour material has none (see
// the file header: an inactive track emits no instance at all), so the pose IS
// the vertex-stage gate.
//
// What the fragment stage must still mirror is the FADE: an object mid-way
// through its appear/disappear ramp is barely visible and must not register a
// partial-alpha id, so the SAME alpha expression (`sttColor.a × opacity`) is
// recomputed here from the VARIED raw attribute and thresholded to a hard 0/1.
// The id itself is written flat and opaque — never × shade, never × alpha — so
// the decoded RGB is an exact 24-bit index.

/**
 * Build the mesh id material. `opts` mirror the colour material's gate options
 * (`alphaCutoff`) so the pick pass matches the on-screen models; the
 * colour-only options (`lit`, `transparent`, `wireframe`) are ignored — the id
 * is a flat per-instance colour and must rasterise solid.
 *
 * Returns the SAME bundle shape as {@link createMeshMaterial}, so
 * {@link updateMeshUniforms} syncs it to the live playhead unmodified.
 */
export function createMeshIdMaterial(
  opts: MeshMaterialOptions = {},
): MeshMaterialBundle {
  const mesh = new MeshUniforms();
  const { local, color } = meshPositionNode();
  const idColor = attribute('sttIdColor', 'vec3');

  const material = new MeshBasicNodeMaterial();
  material.positionNode = vec3(local);

  // FRAGMENT: flat per-instance id colour, opaque wherever the model is drawn
  // AND not faded out. No `srgbToWorking` here — the pick pass renders into a
  // RenderTarget with no output encode, so the 24-bit index must reach the
  // readback bit-exact.
  material.colorNode = varying(idColor);
  const cutoff = opts.alphaCutoff ?? 0.01;
  const vColor = varying(color);
  const onGate = vColor.a.mul(mesh.opacity).greaterThan(float(cutoff));
  material.opacityNode = select(onGate, float(1), float(0));

  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.alphaTest = 0.5;

  return { material, mesh, lit: false, timeFiltered: false };
}
