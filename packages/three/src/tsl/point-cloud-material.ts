// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `PointCloudMaterial` — phong-LIT 3D points, the Three port of deck's
 * `AnimatedPointCloudLayer` (deck base: `PointCloudLayer`). The middle ground
 * between `./point-material.ts` (flat UNLIT billboard splats) and
 * `./surfel-material.ts` (oriented anisotropic gaussians that need baked
 * covariance columns): each instance is a camera-facing quad masked to its
 * inscribed disc and SHADED, so a cloud reads as 3D structure rather than as a
 * flat confetti of dots.
 *
 * ── WHY THE LIGHT LIVES IN THE MATERIAL ──────────────────────────────────────
 * This renderer is otherwise entirely unlit: every STT material is a
 * `MeshBasicNodeMaterial` and the scene carries NO lights at all (the host app
 * mounts our `object` into whatever scene it likes, frequently with nothing but
 * a basemap and a camera). Depending on three's lighting system here would make
 * this ONE kind silently black in every scene that has no light rig, and would
 * couple the package to `MeshStandardNodeMaterial`'s far heavier node graph.
 *
 * So the lighting is SELF-CONTAINED and baked into the colour node, exactly the
 * posture `./column-material.ts` already takes for its extruded prisms: a
 * fixed-direction key light plus an ambient floor, both material-level uniforms:
 *
 *   `shade = ambient + diffuse · max(0, N·L)`,   `rgb = albedo · shade`
 *
 * The defaults match deck's out-of-the-box `PointCloudLayer` lighting:
 * `ambient` 0.35 and `diffuse` 0.6 are deck's default phong material
 * coefficients, and {@link POINT_CLOUD_LIGHT_DIRECTION} is the NEGATION (surface →
 * light) of deck's `LightingEffect` default `directionalLight0.direction`
 * `[-1,-3,-1]`, normalized. deck's common space shares our ENU axes (x east,
 * y north, z up), so the vector transfers unchanged.
 *
 * ── THE SHADING NORMAL, AND ITS FRAME ────────────────────────────────────────
 * Two build-time variants, chosen by whether the archive carries a normal
 * column (`PointCloudBuffers.hasNormals`):
 *
 *  • `normals: true` — the per-instance `sttNormal` attribute is the shading
 *    normal, and it lives in the layer's WORLD (RTC) frame, so `lightDirection`
 *    reads as a WORLD direction: a fixed sun, stable as the camera orbits,
 *    which is deck's behaviour.
 *  • `normals: false` — there is no per-point normal to light, so the disc is
 *    shaded as a SPHERE IMPOSTOR: `N = (u, v, √(1−u²−v²))` from the quad's own
 *    corner coordinate, which exists only in VIEW space (the quad faces the
 *    camera by construction). `lightDirection` is then read in that frame — a
 *    key light fixed relative to the camera. This keeps a normal-less cloud
 *    legible from every angle instead of flat-shading it, and it is the only
 *    frame the impostor normal has.
 *
 * The uniform is therefore documented as "the light direction in the SHADING
 * frame", and the two variants are never mixed within one material.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 *  • No scene lights, no `MeshStandardNodeMaterial`, no shadow — see above.
 *  • No specular lobe. deck's default `specularColor` is `[30,30,30]` (a ~12%
 *    grey highlight, invisible at point scale) and an exact Blinn-Phong half
 *    vector needs a per-fragment view direction this unlit graph deliberately
 *    does not carry. deck's SECOND fill light is folded away for the same
 *    reason: one directional term plus ambient is the whole model.
 *  • No GPU stable-palette (`sttCategoryIndex`) colour path. It replaces colour
 *    AFTER lighting, which would render categorical points flat and unshaded —
 *    the reason deck refuses to install `CategoryColorExtension` on this kind.
 *    Categorical colour rides the ordinary per-instance `sttColor` attribute
 *    and is shaded like any other albedo.
 *  • No wake / cumulative time modes. A point cloud is a scan/overview
 *    primitive, not a "draws itself" reveal (deck's `AnimatedPointCloudLayer`
 *    says the same), so the time filter is window-only and switchable off.
 *
 * ── TIME ─────────────────────────────────────────────────────────────────────
 * HARD cut (VERTEX stage): the billboard half-size is multiplied by
 * {@link timeFilterVisibleNode}, so an out-of-window point collapses to a
 * zero-area quad and dies at primitive assembly — no fragment cost, early-Z
 * preserved (deck.gl #7509). SOFT fade (`opacityNode`): the window alpha is a
 * `select()`, so we vary the RAW per-instance `start`/`end` and RECOMPUTE it in
 * the fragment stage — never wrap a `select()` in a `varying()` (the recurring
 * WGSL build failure; mirrors point/column-material). `alphaTest` discard is
 * kept ONLY for the disc edge.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  select,
  saturate,
  sqrt,
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
  updateTimeFilterUniforms,
} from './time-filter.js';
import type { TimeFilterParams } from './time-filter-math.js';

/**
 * Default key-light direction (surface → light) in the shading frame: deck's
 * `LightingEffect` default `directionalLight0.direction` `[-1,-3,-1]`, negated
 * and normalized. Mostly from the north with a shallow elevation, exactly as an
 * unconfigured deck scene lights its 3D primitives.
 */
export const POINT_CLOUD_LIGHT_DIRECTION: readonly [number, number, number] = [
  1 / Math.sqrt(11),
  3 / Math.sqrt(11),
  1 / Math.sqrt(11),
];

/** deck's default phong material `ambient` — the unlit-side shade floor. */
export const POINT_CLOUD_AMBIENT = 0.35;
/** deck's default phong material `diffuse` — the key light's weight. */
export const POINT_CLOUD_DIFFUSE = 0.6;
/** deck `PointCloudLayer.pointSize` default (RADIUS, in `sizeUnits`). */
export const POINT_CLOUD_SIZE = 10;

/**
 * Live point-cloud uniforms. `pointSize` is the point RADIUS (the billboard
 * HALF-size): CSS pixels when `sizeUnits:'pixels'` (the deck-parity default) or
 * world metres when `sizeUnits:'meters'`. `viewport` is the drawing-buffer size
 * in px, read only by the pixel-sizing path (the host pushes it on resize).
 * `lightDirection` / `ambient` / `diffuse` are the self-contained light — see
 * the module docstring for the frame `lightDirection` is measured in.
 */
export class PointCloudUniforms {
  readonly pointSize: UniformNode = uniform(POINT_CLOUD_SIZE);
  readonly opacity: UniformNode = uniform(1);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
  /** Unit direction FROM the surface TOWARD the key light, in the shading frame. */
  readonly lightDirection: UniformNode = uniform(
    vec3(
      POINT_CLOUD_LIGHT_DIRECTION[0],
      POINT_CLOUD_LIGHT_DIRECTION[1],
      POINT_CLOUD_LIGHT_DIRECTION[2],
    ),
  );
  readonly ambient: UniformNode = uniform(POINT_CLOUD_AMBIENT);
  readonly diffuse: UniformNode = uniform(POINT_CLOUD_DIFFUSE);
}

/** How {@link PointCloudUniforms.pointSize} is interpreted. @default 'pixels' */
export type PointCloudSizeUnits = 'meters' | 'pixels';

export interface PointCloudMaterialOptions {
  /** Apply the window time-filter (collapse + fade by `[start,end]`). @default true */
  timeFiltered?: boolean;
  /**
   * Light the per-instance `sttNormal` attribute (world frame) instead of the
   * sphere-impostor normal (view frame). A STRUCTURAL variant of the node
   * graph — the layer flips it only when the archive's normal column appears or
   * disappears, never per tile arrival. @default false
   */
  normals?: boolean;
  /**
   * Point sizing. `'pixels'` (default, deck `sizeUnits` parity) expands the
   * quad in clip space so every point keeps a constant on-screen radius
   * regardless of depth (needs the `viewport` uniform). `'meters'` expands it in
   * view space so a point is a fixed metric size that shrinks with distance.
   * @default 'pixels'
   */
  sizeUnits?: PointCloudSizeUnits;
  /** Discard fragments below this final alpha (disc edge). @default 0.01 */
  alphaCutoff?: number;
}

export interface PointCloudMaterialBundle {
  material: MeshBasicNodeMaterial;
  time: TimeFilterUniforms;
  pointCloud: PointCloudUniforms;
  /** Whether the window time-filter gates this graph. */
  timeFiltered: boolean;
  /** Whether the graph reads a per-instance `sttNormal` attribute. */
  normals: boolean;
  /** The sizing the vertex stage was built for. */
  sizeUnits: PointCloudSizeUnits;
}

/**
 * The billboard clip-space position shared by the colour and the id materials,
 * so they rasterise IDENTICAL quads (a pick must land on exactly the pixels the
 * point drew). Deliberately a verbatim twin of `point-material.ts`'s private
 * `billboardVertexNode`: that one is module-private, and the two kinds must be
 * free to diverge (this one carries a lit disc, that one a soft splat) without
 * one silently re-shaping the other.
 */
function pointCloudVertexNode(
  center: TSLNode,
  corner: TSLNode,
  half: TSLNode,
  sizeUnits: PointCloudSizeUnits,
  viewport: UniformNode,
): TSLNode {
  if (sizeUnits === 'pixels') {
    // CLIP-SPACE billboard: project the centre, then push the quad corner by a
    // constant pixel radius. corner ∈ [-1,1]², so corner·half = ±half px;
    // px → NDC = ×2/viewport, NDC → clip = ×clip.w (cancels the perspective
    // divide, so the on-screen radius is depth-independent).
    const clip = cameraProjectionMatrix
      .mul(modelViewMatrix)
      .mul(vec4(center, 1));
    const off = corner.mul(half).mul(float(2)).div(viewport).mul(clip.w);
    return vec4(clip.x.add(off.x), clip.y.add(off.y), clip.z, clip.w);
  }
  // VIEW-SPACE billboard: metric radius that shrinks with distance.
  const viewCenter = modelViewMatrix.mul(vec4(center, 1));
  const viewPos = vec4(
    viewCenter.x.add(corner.x.mul(half)),
    viewCenter.y.add(corner.y.mul(half)),
    viewCenter.z,
    viewCenter.w,
  );
  return cameraProjectionMatrix.mul(viewPos);
}

/**
 * The shading normal for the active variant. With `normals` it is the varied
 * per-instance world normal (constant across the quad, so varying it is exact);
 * without, it is the SPHERE-IMPOSTOR normal `(u, v, √(1−r²))` built from the
 * quad's own corner coordinate — already unit length, and defined only inside
 * the disc (`r² ≤ 1`), which is the only region the fragment stage keeps.
 */
function shadingNormalNode(
  normals: boolean,
  uv: TSLNode,
  r2: TSLNode,
): TSLNode {
  if (normals) return varying(attribute('sttNormal', 'vec3')).normalize();
  return vec3(uv.x, uv.y, sqrt(saturate(float(1).sub(r2))));
}

export function createPointCloudMaterial(
  opts: PointCloudMaterialOptions = {},
): PointCloudMaterialBundle {
  const time = new TimeFilterUniforms();
  const pointCloud = new PointCloudUniforms();
  const timeFiltered = opts.timeFiltered ?? true;
  const normals = opts.normals ?? false;
  const sizeUnits: PointCloudSizeUnits = opts.sizeUnits ?? 'pixels';

  const center = attribute('sttCenter', 'vec3');
  const color = attribute('sttColor', 'vec4');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const corner = positionGeometry.xy;

  // HARD vertex-stage collapse: an out-of-window point gets half = 0, so the
  // four quad corners coincide at the centre (zero area → dies at assembly, no
  // fragment cost). The complementary soft fade stays in the fragment alpha.
  const visible = timeFiltered
    ? timeFilterVisibleNode('window', time, start, end)
    : float(1);
  const half = pointCloud.pointSize.mul(visible);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = pointCloudVertexNode(
    center,
    corner,
    half,
    sizeUnits,
    pointCloud.viewport,
  );

  // FRAGMENT: vary the RAW per-instance inputs and recompute the `select()`
  // window alpha here — a `select()` wrapped in a `varying()` fails to build on
  // the WGSL backend. `start`/`end` are per-instance constants, so the
  // recomputed alpha is identical to a vertex-stage evaluation.
  const vColor = varying(color);
  const vStart = varying(start);
  const vEnd = varying(end);
  const vUv = varying(corner);
  const fragAlpha = timeFiltered
    ? timeFilterAlphaNode('window', time, vStart, vEnd)
    : float(1);
  const r2 = vUv.dot(vUv);

  // Self-contained key light + ambient floor (no scene lights — see the module
  // docstring). `saturate` clamps the back hemisphere to the ambient floor.
  const n = shadingNormalNode(normals, vUv, r2);
  const ndl = saturate(n.dot(pointCloud.lightDirection));
  const shade = pointCloud.ambient.add(pointCloud.diffuse.mul(ndl));

  // Albedo × shade, THEN sRGB→working (see ./color-space.ts). The shade
  // multiplies INSIDE the conversion because deck darkens the 0–255 colour the
  // same way — converting first would change the falloff curve.
  material.colorNode = srgbToWorking(vColor.xyz.mul(shade));
  // Outside the inscribed disc the quad's corners are not part of the point.
  material.opacityNode = select(
    r2.greaterThan(1),
    float(0),
    vColor.a.mul(pointCloud.opacity).mul(fragAlpha),
  );

  material.transparent = true;
  // Points are solid 3D objects: they must depth-WRITE so a near point occludes
  // a far one (unlike the additive splat path in point-material). The alpha cut
  // below keeps the disc edge from writing depth for a corner fragment.
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.01;

  return { material, time, pointCloud, timeFiltered, normals, sizeUnits };
}

export interface PointCloudUniformValues {
  relativeCurrentTime: number;
  params?: TimeFilterParams;
  /** Point RADIUS — CSS px (`sizeUnits:'pixels'`) or world metres (`'meters'`). */
  pointSize?: number;
  opacity?: number;
  /** Drawing-buffer size `[w,h]` in px (push on resize; pixel sizing only). */
  viewport?: [number, number];
  /** Unit direction FROM the surface TOWARD the key light, in the shading frame. */
  lightDirection?: [number, number, number];
  /** Ambient floor (deck material `ambient`). */
  ambient?: number;
  /** Key-light weight (deck material `diffuse`). */
  diffuse?: number;
}

export function updatePointCloudUniforms(
  bundle: PointCloudMaterialBundle,
  v: PointCloudUniformValues,
): void {
  updateTimeFilterUniforms(bundle.time, v.relativeCurrentTime, v.params);
  bundle.pointCloud.pointSize.value = v.pointSize ?? POINT_CLOUD_SIZE;
  bundle.pointCloud.opacity.value = v.opacity ?? 1;
  if (v.viewport) {
    bundle.pointCloud.viewport.value.set(v.viewport[0], v.viewport[1]);
  }
  const l = v.lightDirection ?? POINT_CLOUD_LIGHT_DIRECTION;
  bundle.pointCloud.lightDirection.value.set(l[0], l[1], l[2]);
  bundle.pointCloud.ambient.value = v.ambient ?? POINT_CLOUD_AMBIENT;
  bundle.pointCloud.diffuse.value = v.diffuse ?? POINT_CLOUD_DIFFUSE;
}

// ── GPU id-buffer pick material (GPU picking catalog: pointCloud variant) ──────
//
// BROWSER-VERIFY ONLY (needs a live WebGPU device). Renders each point's flat
// per-instance id colour (`sttIdColor`, from `buildIdColors(mergedCount)`) into
// the picker's off-screen target. It rasterises the SAME billboard quad as the
// colour material (shared {@link pointCloudVertexNode}, same `pointSize` /
// `sizeUnits` / viewport uniforms) and REUSES the identical vertex-stage
// time-filter collapse, so an out-of-window point is equally invisible AND
// unpickable. The lighting is dropped entirely: the id must decode to an exact
// 24-bit RGB, so it is written flat, unmodulated and opaque (a shade multiply
// would corrupt the index), and the disc mask + hard-thresholded window alpha
// discard everything the eye does not see. Bind {@link updatePointCloudUniforms}
// to sync its time / size uniforms before the pass — the returned bundle is
// shape-compatible with {@link PointCloudMaterialBundle}.

/**
 * Build the point-cloud id material. `opts` mirror the colour material's GATE
 * options (`timeFiltered`, `sizeUnits`, `alphaCutoff`) so the pick pass matches
 * the on-screen discs; `normals` is ignored (the id is unlit by construction)
 * and reported as `false` on the bundle.
 */
export function createPointCloudIdMaterial(
  opts: PointCloudMaterialOptions = {},
): PointCloudMaterialBundle {
  const time = new TimeFilterUniforms();
  const pointCloud = new PointCloudUniforms();
  const timeFiltered = opts.timeFiltered ?? true;
  const sizeUnits: PointCloudSizeUnits = opts.sizeUnits ?? 'pixels';

  const center = attribute('sttCenter', 'vec3');
  const idColor = attribute('sttIdColor', 'vec3');
  const start = attribute('sttStart', 'float');
  const end = attribute('sttEnd', 'float');
  const corner = positionGeometry.xy;

  // SAME hard vertex-stage collapse as the colour material.
  const visible = timeFiltered
    ? timeFilterVisibleNode('window', time, start, end)
    : float(1);
  const half = pointCloud.pointSize.mul(visible);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = pointCloudVertexNode(
    center,
    corner,
    half,
    sizeUnits,
    pointCloud.viewport,
  );

  // FRAGMENT: same WGSL discipline as the colour material — vary the raw inputs
  // and recompute the `select()` here. Visible iff inside the disc AND on-time;
  // the id is opaque, everything else is discarded (alphaTest) so background /
  // off-time points never win a pick.
  const vId = varying(idColor);
  const vStart = varying(start);
  const vEnd = varying(end);
  const vUv = varying(corner);
  const fragAlpha = timeFiltered
    ? timeFilterAlphaNode('window', time, vStart, vEnd)
    : float(1);
  const r2 = vUv.dot(vUv);
  const cutoff = opts.alphaCutoff ?? 0.01;
  const onGate = r2.lessThanEqual(1).and(fragAlpha.greaterThan(float(cutoff)));

  material.colorNode = vId;
  material.opacityNode = select(onGate, float(1), float(0));
  material.transparent = false;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = DoubleSide;
  material.blending = NormalBlending;
  material.alphaTest = 0.5;

  return {
    material,
    time,
    pointCloud,
    timeFiltered,
    normals: false,
    sizeUnits,
  };
}
