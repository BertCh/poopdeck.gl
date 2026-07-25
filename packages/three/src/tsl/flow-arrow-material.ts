// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `FlowArrowMaterial` — instanced **tapered half-arrows**, the Three port of
 * deck's `FlowLinesLayer` (itself a port of flowmap.gl's `FlowLinesLayer`). One
 * instance = one origin→destination flow; its on-screen WIDTH tracks the trip
 * volume at the playhead (the {@link STTFlowmapLayer} computes `widthScale·√flow`
 * per instance on the CPU and re-expands the width buffer as the slider scrubs).
 *
 * Each instance draws the {@link makeArrowTemplateGeometry} 9-vertex template
 * (3 triangles) extruded in the vertex stage into a straight shaft tapering into
 * a triangular arrowhead at the destination, all in screen pixels — the exact
 * geometry of the deck primitive, just expressed as a TSL node graph instead of
 * GLSL:
 *  • the vertex is placed at `mix(source, target, positions.x)` on the
 *    centreline (in clip space), then offset perpendicular by `positions.y · w`
 *    (shaft / arrowhead half-width) and along-travel by `positions.z · w`
 *    (arrowhead pull-back);
 *  • a constant `gap · w` perpendicular offset pushes the whole arrow to one
 *    side of the centreline so the A→B and B→A flows of a pair sit side-by-side
 *    (perpDir flips with direction, so the two arrows separate automatically);
 *  • per-instance `sttEndpointOffsets` (pixels) inset the start/end along the
 *    line so the arrow begins/ends on the node-circle EDGE, not its centre;
 *  • along-travel + endpoint offsets are clamped to a fraction of the flow's
 *    pixel length so short flows don't self-overlap or overshoot.
 *
 * Pixel→clip conversion mirrors {@link createWideLineMaterial}: clip→NDC by the
 * perspective divide, the screen-space direction gives a left-normal, and a
 * pixel offset becomes a clip offset via `×2/viewport × clip.w` (cancelling the
 * later perspective divide so the arrow keeps a constant on-screen size at any
 * depth).
 *
 * Colour is a layer-uniform `mix(sourceColor → targetColor)` along the arrow
 * (`positions.x`), matching the deck primitive (our colours are constants, so no
 * per-instance colour attribute). The colour `mix` is `varying`-safe; there is
 * no `select()` to vary here (zero-flow arrows are squelched to width 0 on the
 * CPU and clamped away — invisible without a fragment branch).
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending, AdditiveBlending } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  uniform,
  float,
  vec2,
  vec4,
  mix,
  min,
  max,
  modelViewMatrix,
  cameraProjectionMatrix,
  type UniformNode,
} from './nodes.js';

export interface FlowArrowMaterialOptions {
  /** Additive blending (glowing flows) vs normal alpha. @default false */
  additive?: boolean;
  /** Write depth vs not (translucent overlay). @default false */
  depthWrite?: boolean;
  /** Discard fragments below this final alpha. @default 0.02 */
  alphaCutoff?: number;
}

/** Live flow-arrow uniforms: gradient colours, pixel width clamps, gap, opacity,
 *  and the canvas size in px (host updates it on resize). */
export class FlowArrowUniforms {
  readonly sourceColor: UniformNode = uniform(vec4(0.22, 0.77, 0.91, 0.92));
  readonly targetColor: UniformNode = uniform(vec4(1.0, 0.56, 0.25, 0.96));
  readonly widthMinPixels: UniformNode = uniform(1);
  readonly widthMaxPixels: UniformNode = uniform(12);
  /** Perpendicular separation between the two directions of a pair, in widths. */
  readonly gap: UniformNode = uniform(0.5);
  readonly opacity: UniformNode = uniform(1);
  /** Drawing-buffer size (px); the host updates it on resize. */
  readonly viewport: UniformNode = uniform(vec2(1280, 720));
}

export interface FlowArrowMaterialBundle {
  material: MeshBasicNodeMaterial;
  arrow: FlowArrowUniforms;
}

/**
 * Build a flow-arrow material. The layer attaches per-instance attributes
 * `sttPosSource`/`sttPosTarget` (vec3, RTC-local), `sttWidth` (float, pixels —
 * already `widthScale·√flow`), and `sttEndpointOffsets` (vec2, px `[srcInset,
 * tgtInset]`), on a {@link makeArrowTemplateGeometry}.
 */
export function createFlowArrowMaterial(
  opts: FlowArrowMaterialOptions = {},
): FlowArrowMaterialBundle {
  const arrow = new FlowArrowUniforms();

  const posSource = attribute('sttPosSource', 'vec3');
  const posTarget = attribute('sttPosTarget', 'vec3');
  const width = attribute('sttWidth', 'float');
  const endpointOffsets = attribute('sttEndpointOffsets', 'vec2');

  const tmpl = positionGeometry; // (mix, perpendicular, alongTravel) in width units
  const mixT = tmpl.x;
  const perp = tmpl.y;
  const travel = tmpl.z;

  // ── VERTEX: extrude the template into a screen-space tapered arrow ───────────
  const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
  const clipS = mvp.mul(vec4(posSource, 1));
  const clipT = mvp.mul(vec4(posTarget, 1));
  const ndcS = clipS.xy.div(clipS.w);
  const ndcT = clipT.xy.div(clipT.w);

  // Screen-space (pixel) direction + length. clip→NDC spans [-1,1] across the
  // viewport, so NDC→pixels is ×viewport/2; we keep it implicit by scaling the
  // delta by viewport then normalising.
  const deltaPx = ndcT.sub(ndcS).mul(arrow.viewport).mul(float(0.5));
  const lenPx = max(deltaPx.length(), float(1));
  const flowDir = deltaPx.div(lenPx); // unit, source→target
  const perpDir = vec2(flowDir.y.negate(), flowDir.x);

  // Width clamped to the pixel envelope (zero-flow arrows stay at width 0).
  const w = min(max(width, arrow.widthMinPixels), arrow.widthMaxPixels);

  // Perpendicular: half-width (shaft / arrowhead) + a constant gap so the two
  // directions of a pair sit side-by-side (perpDir flips when direction flips).
  const perpPx = perp.mul(w).add(arrow.gap.mul(w));
  // Along-travel arrowhead pull-back, clamped so short flows don't overshoot.
  const travelLimit = lenPx.mul(float(0.8));
  const travelPx = min(max(travel.mul(w), travelLimit.negate()), travelLimit);
  // Inset start/end toward each other by the node-circle radii (px), clamped so
  // a short flow's arrowhead never crosses its origin. Lerp source→target inset.
  const insetLimit = lenPx.mul(float(0.4));
  const srcInset = min(max(endpointOffsets.x, float(0)), insetLimit);
  const tgtInset = min(max(endpointOffsets.y, float(0)), insetLimit);
  const endpointPx = mix(srcInset, tgtInset.negate(), mixT);

  // Total pixel offset from the centreline point.
  const offPx = perpDir.mul(perpPx).add(flowDir.mul(travelPx.add(endpointPx)));

  // Centreline point in clip space, then add the pixel offset converted to clip:
  // px → NDC = ×2/viewport, NDC → clip = ×clip.w (mirrors wide-line / point px).
  const clip = mix(clipS, clipT, mixT);
  const offClip = offPx.mul(float(2)).div(arrow.viewport).mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(offClip.x),
    clip.y.add(offClip.y),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: gradient colour source→target (mix is varying-safe) ───────────
  const vColor = varying(mix(arrow.sourceColor, arrow.targetColor, mixT));
  material.colorNode = vColor.xyz;
  material.opacityNode = vColor.a.mul(arrow.opacity);
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = opts.depthWrite ?? false;
  material.side = DoubleSide;
  material.blending = opts.additive ? AdditiveBlending : NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.02;

  return { material, arrow };
}

export interface FlowArrowUniformValues {
  /** Origin (tail) colour, straight RGBA 0..1. */
  sourceColor?: [number, number, number, number];
  /** Destination (arrowhead) colour, straight RGBA 0..1. */
  targetColor?: [number, number, number, number];
  /** Clamp arrow width to at least this many pixels. */
  widthMinPixels?: number;
  /** Clamp arrow width to at most this many pixels. */
  widthMaxPixels?: number;
  /** Perpendicular pair separation, in units of width. */
  gap?: number;
  opacity?: number;
  /** Drawing-buffer size `[w, h]` in px (push on resize). */
  viewport?: [number, number];
}

/** Push colours / clamps / gap / viewport into the uniforms. Width is per-instance. */
export function updateFlowArrowUniforms(
  bundle: FlowArrowMaterialBundle,
  v: FlowArrowUniformValues,
): void {
  const { arrow } = bundle;
  if (v.sourceColor) arrow.sourceColor.value.set(...v.sourceColor);
  if (v.targetColor) arrow.targetColor.value.set(...v.targetColor);
  if (v.widthMinPixels !== undefined)
    arrow.widthMinPixels.value = v.widthMinPixels;
  if (v.widthMaxPixels !== undefined)
    arrow.widthMaxPixels.value = v.widthMaxPixels;
  if (v.gap !== undefined) arrow.gap.value = v.gap;
  if (v.opacity !== undefined) arrow.opacity.value = v.opacity;
  if (v.viewport) arrow.viewport.value.set(v.viewport[0], v.viewport[1]);
}
