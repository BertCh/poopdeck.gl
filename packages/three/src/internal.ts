// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `@poopdeck.gl/three/internal` — the **layer/material authoring kit**.
 *
 * ⚠️ **UNSTABLE: these exports may change or disappear in ANY release, including
 * a patch.** They are not covered by semver. Nothing in the shipped renderer
 * needs them: every layer and material in `@poopdeck.gl/three` is fully drivable
 * from the root barrel (`create*Material` → bundle → `update*Uniforms`, or just
 * the layer classes). This subpath exists for the narrower job of writing a NEW
 * layer or a NEW TSL material against the same time-filter / data-filter /
 * palette node graph the built-ins use — subclassing {@link BaseSttLayer},
 * assembling instanced geometry, or wiring the visibility nodes by hand.
 *
 * The split is deliberate: at 0.5.0 every name on the ROOT barrel is an API we
 * have committed to keep stable, and a node-graph builder is an implementation
 * detail of the shader we happen to compile today. Keeping them reachable (so
 * the kit is usable) but scoped (so they are not load-bearing public API) is the
 * same move `@poopdeck.gl/core` makes with its `./render/*` sub-paths.
 *
 * The families below are re-exported WHOLE — including the handful of members
 * the root barrel still carries — so an authoring consumer can import a complete
 * family from one place instead of straddling two entry points.
 */

// ─── Layer base class ─────────────────────────────────────────────────────────
// Every built-in layer extends this: it owns the tile→buffer rebuild hook, the
// Three object lifecycle, and the per-frame `setTime` pump.
export {
  BaseSttLayer,
  type SttLayer,
  type SttLayerContext,
} from './layers/layer.js';

// ─── TSL node graph: time filter ──────────────────────────────────────────────
// Soft alpha nodes and their hard 0/1 vertex-stage twins. The *Visible* nodes
// collapse an out-of-window primitive to zero extent in the vertex stage
// (early-Z preserved) instead of discarding in the fragment stage.
export {
  TimeFilterUniforms,
  timeFilterAlphaNode,
  windowAlphaNode,
  wakeAlphaNode,
  wakeSizeScaleNode,
  cumulativeAlphaNode,
  trailAlphaNode,
  updateTimeFilterUniforms,
  timeFilterVisibleNode,
  windowVisibleNode,
  wakeVisibleNode,
  cumulativeVisibleNode,
  trailVisibleNode,
  type TSLNode,
  type UniformNode,
} from './tsl/time-filter.js';

// ─── TSL node graph: data filter (deck DataFilterExtension analogue) ──────────
export {
  DataFilterUniforms,
  dataFilterVisibleNode,
  dataFilterAlphaNode,
  updateDataFilterUniforms,
} from './tsl/data-filter.js';

// ─── TSL node graph: motion glide (GPU keyframe interpolation) ────────────────
// GLIDE_ATTR names the instanced attributes `glideSampleNode` reads, so a custom
// material must bake the SAME names its buffers were built under.
export {
  GLIDE_ATTR,
  GlideUniforms,
  glideSampleNode,
  glidePositionNode,
} from './tsl/motion-glide.js';

// ─── TSL node graph: stable categorical palette ───────────────────────────────
export {
  PALETTE_ATTR,
  PaletteUniforms,
  paletteColorNode,
  makePaletteTexture,
} from './tsl/palette.js';

// ─── Uniform holders for the built-in materials ───────────────────────────────
// `create*Material` constructs these and hangs them on its bundle; you only name
// the class when you assemble a material by hand.
export { SurfelUniforms } from './tsl/surfel-material.js';
export { PointUniforms } from './tsl/point-material.js';
export { ArcUniforms } from './tsl/arc-material.js';
export { FlowArrowUniforms } from './tsl/flow-arrow-material.js';
export { FlowCorridorUniforms } from './tsl/flow-corridor-material.js';

// ─── Instanced geometry primitives ────────────────────────────────────────────
// The per-instance templates the built-in layers instance-draw. Each one pairs
// with the vertex node of its material; swapping a template without swapping the
// material silently mis-tessellates.
export { makeHexDiskGeometry, HEX_CIRCUMRADIUS } from './geometry/hex-disk.js';
export { makeBillboardQuadGeometry } from './geometry/billboard-quad.js';
export { makeSegmentQuadGeometry } from './geometry/segment-quad.js';
export { makeArcStripGeometry } from './tsl/arc-material.js';
export {
  makeColumnPrismGeometry,
  circumradiusForIncircle,
} from './geometry/column-prism.js';
export {
  makeArrowTemplateGeometry,
  ARROW_TEMPLATE_POSITIONS,
} from './geometry/arrow-template.js';
export {
  writeBoxEdges,
  BOX_CORNERS,
  BOX_EDGES,
  FLOATS_PER_BOX,
} from './geometry/box-edges.js';

// ─── Scene primitives ─────────────────────────────────────────────────────────
// `SttScene` calls `makeGround` for you (`ground` option) and `frameBox` is the
// camera-framing helper behind the viewer rigs; `zoomFromCamera` is the
// altitude→web-mercator-zoom inverse the streaming source selects LOD with.
export { makeGround, type GroundOptions } from './scene/ground.js';
export { frameBox, type FrameOptions } from './scene/camera.js';
export { zoomFromCamera } from './scene/streaming-tile-source.js';
