// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `BundledFlowMaterial` — the **bundled-river ribbon**, the Three port of deck's
 * `BundledFlowLinesLayer`. It draws the output of the KDEEB bundler
 * (`../lib/edge-bundler.ts`) in place of {@link createFlowArrowMaterial}'s
 * straight tapered arrows, and is what {@link STTFlowmapLayer} switches to when
 * its `bundling` option is on.
 *
 * One instance = ONE SEGMENT of one bundled edge (an `E × (P-1)` instance
 * count), drawn on the shared {@link makeSegmentQuadGeometry} quad. The vertex
 * stage expands that quad into a constant-pixel-width **half**-ribbon on one
 * side of the segment's centreline, plus a constant `gap · w` perpendicular
 * offset, so the A→B and B→A flows of a station pair form twin ribbons instead
 * of overprinting — the same trick, and the same `gap` uniform, as the straight
 * arrow.
 *
 * DIRECTION IS THE GRADIENT, NOT AN ARROWHEAD. Every segment carries the
 * `[t0, t1]` span it occupies along its whole edge (`sttBundleT`), and the
 * fragment colour is `mix(sourceColor → targetColor)` at the interpolated `t`.
 * That matches deck's bundled layer: an arrowhead per segment would be visual
 * noise, and one arrowhead per edge would sit inside the river core where
 * nothing can be read. The straight-arrow path keeps its arrowheads; the two
 * conventions are deliberate, not drift.
 *
 * The pixel→clip conversion is lifted verbatim from
 * {@link createFlowArrowMaterial}/{@link createWideLineMaterial}: both endpoints
 * go to clip space, the perspective divide gives NDC, the screen-space direction
 * gives a left-normal, and a pixel offset becomes a clip offset via
 * `×2/viewport × clip.w` (cancelling the later divide, so ribbon width is
 * constant on screen at any depth).
 *
 * NO TIME FILTER, deliberately: as in the straight-arrow path, the OD tile spans
 * the whole time range and loads once, and the animation IS the per-instance
 * `sttWidth` the layer re-expands as the playhead crosses a cross-fade sub-step.
 *
 * ONE DIFFERENCE FROM THE ARROW MATERIAL, ON PURPOSE: a zero-width (squelched,
 * sub-`minFlow`) flow is collapsed to zero extent by a branch-free
 * `step()` gate BEFORE the `widthMinPixels` clamp. The arrow material clamps
 * first, so a dead flow still draws a hairline; on a bundled map that would
 * paint a hairline down the core of every river — precisely where the live flows
 * are — so here the clamp only applies to flows that are actually flowing. The
 * collapse is a VERTEX-stage zero-extent (deck.gl #7509), not a fragment
 * discard: no fragment cost, early-Z preserved.
 *
 * WHAT THIS DOES NOT DO: no per-segment mitre. Consecutive segments are
 * butt-joined, so a sharp bend leaves a small notch on the outside of the turn
 * at large widths. Bundled polylines are smooth by construction — core's
 * Laplacian pass is what makes them so — so bends are shallow and the notch is
 * sub-pixel at the widths a flowmap uses; a proper joint would need the
 * neighbouring control point as a third attribute. It also carries no node-circle
 * endpoint inset (`sttEndpointOffsets`): the arrow material insets its tips to
 * the dock circle's edge, which only reads correctly on a straight line to the
 * dock, and a bundled river does not arrive on one.
 */

import { MeshBasicNodeMaterial } from 'three/webgpu';
import { DoubleSide, NormalBlending, AdditiveBlending } from 'three';
import {
  attribute,
  positionGeometry,
  varying,
  float,
  vec2,
  vec4,
  mix,
  min,
  max,
  step,
  modelViewMatrix,
  cameraProjectionMatrix,
} from './nodes.js';
import { srgbToWorking } from './color-space.js';
import {
  FlowArrowUniforms,
  type FlowArrowMaterialBundle,
  type FlowArrowMaterialOptions,
} from './flow-arrow-material.js';

/**
 * Widths at or below this many pixels count as "no flow" and collapse the
 * ribbon entirely, ahead of the `widthMinPixels` clamp. Well under any width a
 * `widthScale·√flow` can legitimately produce, so it only ever catches the
 * exact `0` the buffer builder writes for a squelched flow.
 */
const ZERO_WIDTH_PX = 1e-6;

/**
 * Build the bundled-flow ribbon material.
 *
 * The layer attaches per-instance attributes on a
 * {@link makeSegmentQuadGeometry}:
 *  • `sttPosSource` / `sttPosTarget` (vec3, RTC-local) — this SEGMENT's two
 *    bundled control points, already projected;
 *  • `sttWidth` (float, pixels) — the whole EDGE's current width
 *    (`widthScale·√flow`), repeated across its segments, refreshed as the
 *    playhead moves;
 *  • `sttBundleT` (vec2) — `[t0, t1]`, this segment's span along its edge in
 *    `[0,1]`, which drives the source→target colour gradient.
 *
 * It returns the SAME bundle shape as {@link createFlowArrowMaterial} — a
 * {@link FlowArrowUniforms} under `arrow` — so `updateFlowArrowUniforms` drives
 * both paths unmodified and the two can never drift on colours, width clamps,
 * gap, opacity or viewport.
 */
export function createBundledFlowMaterial(
  opts: FlowArrowMaterialOptions = {},
): FlowArrowMaterialBundle {
  const arrow = new FlowArrowUniforms();

  const posSource = attribute('sttPosSource', 'vec3');
  const posTarget = attribute('sttPosTarget', 'vec3');
  const width = attribute('sttWidth', 'float');
  const tRange = attribute('sttBundleT', 'vec2');

  // Segment quad: x ∈ {0,1} along the segment, y ∈ {-1,1} across it. Remap the
  // side to 0..1 so the ribbon is a HALF ribbon on one side of the centreline
  // (the `gap` then pushes the whole thing clear of the pair's other direction).
  const quad = positionGeometry;
  const along = quad.x;
  const side = quad.y.mul(float(0.5)).add(float(0.5));

  // ── VERTEX: expand the quad to a screen-space ribbon ────────────────────────
  const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
  const clipS = mvp.mul(vec4(posSource, 1));
  const clipT = mvp.mul(vec4(posTarget, 1));
  const ndcS = clipS.xy.div(clipS.w);
  const ndcT = clipT.xy.div(clipT.w);

  const deltaPx = ndcT.sub(ndcS).mul(arrow.viewport).mul(float(0.5));
  const lenPx = max(deltaPx.length(), float(1));
  const flowDir = deltaPx.div(lenPx); // unit, source→target
  const perpDir = vec2(flowDir.y.negate(), flowDir.x);

  // Zero-flow segments collapse to zero extent BEFORE the min-pixel clamp, so a
  // squelched flow contributes nothing at all (see the header).
  const live = step(float(ZERO_WIDTH_PX), width);
  const w = min(max(width, arrow.widthMinPixels), arrow.widthMaxPixels).mul(
    live,
  );

  const perpPx = side.mul(w).add(arrow.gap.mul(w));
  const offPx = perpDir.mul(perpPx);

  const clip = mix(clipS, clipT, along);
  const offClip = offPx.mul(float(2)).div(arrow.viewport).mul(clip.w);

  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(
    clip.x.add(offClip.x),
    clip.y.add(offClip.y),
    clip.z,
    clip.w,
  );

  // ── FRAGMENT: source→target gradient along the WHOLE edge ───────────────────
  // `mix` is varying-safe (no `select()` anywhere in this graph), so the colour
  // can be interpolated directly rather than recomputed per fragment.
  const t = mix(tRange.x, tRange.y, along);
  const vColor = varying(mix(arrow.sourceColor, arrow.targetColor, t));
  material.colorNode = srgbToWorking(vColor.xyz);
  material.opacityNode = vColor.a.mul(arrow.opacity);
  material.transparent = true;
  material.depthTest = true;
  material.depthWrite = opts.depthWrite ?? false;
  material.side = DoubleSide;
  material.blending = opts.additive ? AdditiveBlending : NormalBlending;
  material.alphaTest = opts.alphaCutoff ?? 0.02;

  return { material, arrow };
}
