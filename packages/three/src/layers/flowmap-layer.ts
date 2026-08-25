// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTFlowmapLayer` — flowmap.gl-style **animated OD flowmap**, the Three port of
 * deck's `STTFlowmapLayer`. Renders one weighted tapered half-arrow per OD
 * station-pair whose WIDTH tracks trip volume at the playhead (from the tile's
 * `vertexValueMatrix`), plus node circles sized by each station's total incident
 * flow. As the slider scrubs, corridors swell and recede and the node circles
 * pulse — the classic flowmap-over-time look. Unlocks bixi-flowmap /
 * nyc-taxi-flows.
 *
 * Two child objects under one group:
 *  • the ARROWS — an instanced {@link makeArrowTemplateGeometry} +
 *    {@link createFlowArrowMaterial}: each OD flow is one instance the GPU
 *    extrudes into a screen-space tapered arrow (shaft → arrowhead), its width
 *    the per-instance `sttWidth`. The flat data tile spans the whole time range
 *    and loads once; there is NO time filter — a zero-flow arrow simply has
 *    width 0 (invisible), which IS the animation.
 *  • the NODES — an instanced {@link makeBillboardQuadGeometry} +
 *    {@link createPointMaterial} (pixel-sized, window mode with an open window so
 *    they are always visible): one camera-facing disc per dock, radius scaling
 *    with incident flow.
 *
 * RTC: all tiles merge into one buffer whose endpoints / node centres are
 * relative to a shared `origin`, written to `object.position` so large
 * mercator/globe magnitudes stay in the f64 CPU transform. For the ENU/AV frame
 * the origin is tiny and this is a no-op.
 *
 * Time animation: arrow widths and node radii depend on the playhead, so
 * {@link setTime} re-runs the pure buffer builder and refreshes the dynamic
 * attributes (`sttWidth`, `sttEndpointOffsets`, node centres/radii) in place —
 * gated to a cross-fade sub-step grid so it re-expands ~5 Hz, not per frame
 * (mirroring deck's `flowStep` setState). The endpoint geometry stays resident.
 */

import {
  Group,
  Mesh,
  InstancedBufferAttribute,
  Box3,
  Vector3,
  Sphere,
} from 'three';
import type { Tile } from '@poopdeck.gl/core';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import { makeArrowTemplateGeometry } from '../geometry/arrow-template.js';
import { makeBillboardQuadGeometry } from '../geometry/billboard-quad.js';
import {
  buildFlowmapBuffers,
  type FlowmapBufferOptions,
  type FlowmapBuffers,
} from '../lib/flowmap-buffers.js';
import {
  createFlowArrowMaterial,
  updateFlowArrowUniforms,
  type FlowArrowMaterialBundle,
} from '../tsl/flow-arrow-material.js';
import {
  createPointMaterial,
  updatePointUniforms,
  type PointMaterialBundle,
} from '../tsl/point-material.js';
import type { RGBA } from '../lib/color.js';

/** Cross-fade granularity in fractions of a bucket (matches deck STTFlowmapLayer.STEP). */
const STEP = 0.1;
/** A node's window is forced wide-open (always visible) with this half-width. */
const OPEN_WINDOW_HALF = 1e12;

export interface STTFlowmapLayerOptions extends FlowmapBufferOptions {
  id?: string;
  /** Arrow source (origin / tail) colour, 0..255 RGBA. @default [56,196,232,235] */
  sourceColor?: RGBA;
  /** Arrow target (arrowhead) colour, 0..255 RGBA. @default [255,142,64,245] */
  targetColor?: RGBA;
  /** Clamp arrow width to at least this many px (active arrows only). @default 1 */
  widthMinPixels?: number;
  /** Clamp arrow width to at most this many px. @default 12 */
  widthMaxPixels?: number;
  /** Perpendicular separation between a pair's two directions, in widths. @default 0.5 */
  gap?: number;
  /** Node circle fill colour, 0..255 RGBA. @default [232,238,255,170] */
  nodeColor?: RGBA;
  opacity?: number;
  /** Additive blending (glowing flows). @default false */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  /** Hide node circles entirely. @default false */
  hideNodes?: boolean;
}

const DEFAULT_SOURCE_COLOR: RGBA = [56, 196, 232, 235];
const DEFAULT_TARGET_COLOR: RGBA = [255, 142, 64, 245];
const DEFAULT_NODE_COLOR: RGBA = [232, 238, 255, 170];

function toVec4(c: RGBA): [number, number, number, number] {
  return [
    (c[0] ?? 0) / 255,
    (c[1] ?? 0) / 255,
    (c[2] ?? 0) / 255,
    (c[3] ?? 255) / 255,
  ];
}

export class STTFlowmapLayer extends BaseSTTLayer {
  readonly id: string;
  readonly object = new Group();

  private readonly arrows = new Mesh();
  private readonly nodes = new Mesh();
  private arrowBundle: FlowArrowMaterialBundle | null = null;
  private nodeBundle: PointMaterialBundle | null = null;

  private tiles: Tile[] = [];
  private projection: STTLayerContext['projection'] | null = null;
  private viewport: [number, number] = [1280, 720];
  private lastStepKey = Number.NaN;
  private readonly opts: STTFlowmapLayerOptions;

  constructor(options: STTFlowmapLayerOptions = {}) {
    super();
    this.opts = options;
    this.id = options.id ?? 'flowmap';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.arrows.frustumCulled = false;
    this.nodes.frustumCulled = false;
    this.arrows.name = `${this.id}-arrows`;
    this.nodes.name = `${this.id}-nodes`;
    this.arrows.renderOrder = 1; // arrows over nodes
    this.object.add(this.nodes);
    this.object.add(this.arrows);
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so widths/radii are true px. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
    if (this.arrowBundle)
      this.arrowBundle.arrow.viewport.value.set(width, height);
    if (this.nodeBundle)
      this.nodeBundle.point.viewport.value.set(width, height);
  }

  private bufferOptions(): FlowmapBufferOptions {
    return {
      widthScale: this.opts.widthScale,
      nodeRadiusScale: this.opts.nodeRadiusScale,
      nodeRadiusMinPixels: this.opts.nodeRadiusMinPixels,
      nodeRadiusMaxPixels: this.opts.nodeRadiusMaxPixels,
      minFlow: this.opts.minFlow,
    };
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.tiles = tiles;
    this.projection = ctx.projection;
    this.disposeGeometries();
    this.lastStepKey = Number.NaN;
    // Build at the time origin so the layer is renderable before the first
    // setTime; setTime re-expands the dynamic attributes as the playhead moves.
    this.rebuild(this.timeOrigin, /* forceGeometry */ true);
  }

  setTime(absoluteTimeMs: number): void {
    this.rebuild(absoluteTimeMs, /* forceGeometry */ false);
  }

  /** (Re)build buffers for `absoluteTimeMs`. `forceGeometry` rebuilds the whole
   * geometry (tile change); otherwise only the time-dependent attributes are
   * refreshed, and only when the playhead crosses a cross-fade sub-step. */
  private rebuild(absoluteTimeMs: number, forceGeometry: boolean): void {
    if (!this.projection) return;
    const stepKey = this.stepKey(absoluteTimeMs);
    if (!forceGeometry && this.arrowBundle && stepKey === this.lastStepKey)
      return;
    this.lastStepKey = stepKey;

    const buf = buildFlowmapBuffers(
      this.tiles,
      this.projection,
      absoluteTimeMs,
      this.bufferOptions(),
    );

    if (buf.count === 0) {
      this.object.visible = false;
      if (forceGeometry) this.ensureEmptyGeometry();
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    if (forceGeometry || !this.arrowBundle) this.buildGeometry(buf);
    else this.updateDynamic(buf);
  }

  /** Round the playhead to the nearest cross-fade sub-step (per-tile axis). */
  private stepKey(absoluteTimeMs: number): number {
    for (const tile of this.tiles) {
      for (const tl of tile.layers) {
        const b = tl.features;
        const nb = b.vertexValueBuckets ?? 0;
        if (nb <= 0 || !b.startTimes || b.startTimes.length === 0) continue;
        const rel0 = b.startTimes[0];
        const span = b.endTimes[0] - rel0;
        if (span <= 0) continue;
        const width = span / nb;
        let pos = (absoluteTimeMs - b.timeOffset - rel0) / width;
        if (pos < 0) pos = 0;
        const maxPos = nb - 1;
        if (pos > maxPos) pos = maxPos;
        return Math.round(pos / STEP);
      }
    }
    return 0;
  }

  private buildGeometry(buf: FlowmapBuffers): void {
    // ── Arrows ────────────────────────────────────────────────────────────────
    const ag = makeArrowTemplateGeometry();
    ag.instanceCount = buf.count;
    ag.setAttribute(
      'sttPosSource',
      new InstancedBufferAttribute(buf.posSource, 3),
    );
    ag.setAttribute(
      'sttPosTarget',
      new InstancedBufferAttribute(buf.posTarget, 3),
    );
    ag.setAttribute('sttWidth', new InstancedBufferAttribute(buf.widths, 1));
    ag.setAttribute(
      'sttEndpointOffsets',
      new InstancedBufferAttribute(buf.endpointOffsets, 2),
    );
    if (buf.bbox) {
      ag.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
      );
      ag.boundingSphere = ag.boundingBox.getBoundingSphere(new Sphere());
    }
    // Materials are built ONCE (audit E5): their inputs are constructor
    // options, and disposing them per rebuild evicted three's
    // nodeBuilderCache entry, program and pipeline each time.
    if (!this.arrowBundle) {
      this.arrowBundle = createFlowArrowMaterial({
        additive: this.opts.additive,
        depthWrite: this.opts.depthWrite,
        alphaCutoff: this.opts.alphaCutoff,
      });
    }
    this.arrows.geometry = ag;
    this.arrows.material = this.arrowBundle.material;
    this.pushArrowUniforms();

    // ── Nodes ─────────────────────────────────────────────────────────────────
    this.buildNodeGeometry(buf);
  }

  private buildNodeGeometry(buf: FlowmapBuffers): void {
    const hide = this.opts.hideNodes || buf.nodeCount === 0;
    this.nodes.visible = !hide;
    if (hide) return;

    const ng = makeBillboardQuadGeometry();
    ng.instanceCount = buf.nodeCount;
    ng.setAttribute(
      'sttCenter',
      new InstancedBufferAttribute(buf.nodeCenters, 3),
    );
    // Per-node colour (constant fill) + a wide-open window so they always show.
    const color = toVec4(this.opts.nodeColor ?? DEFAULT_NODE_COLOR);
    const colors = new Float32Array(buf.nodeCount * 4);
    const starts = new Float32Array(buf.nodeCount); // 0
    const ends = new Float32Array(buf.nodeCount); // 0
    for (let i = 0; i < buf.nodeCount; i++) {
      colors[i * 4] = color[0];
      colors[i * 4 + 1] = color[1];
      colors[i * 4 + 2] = color[2];
      colors[i * 4 + 3] = color[3];
    }
    ng.setAttribute('sttColor', new InstancedBufferAttribute(colors, 4));
    ng.setAttribute('sttStart', new InstancedBufferAttribute(starts, 1));
    ng.setAttribute('sttEnd', new InstancedBufferAttribute(ends, 1));
    // The shared point material sizes every disc by a single `pointSize` uniform
    // (no per-instance size attribute), so node circles render at ONE
    // representative pixel radius rather than each dock's own. Node circles are a
    // relative-magnitude cue, and a per-instance-sized node material is a future
    // enhancement; the per-node radii still drive the arrow endpoint insets via
    // `sttEndpointOffsets`, which is where exact radius matters most.
    if (!this.nodeBundle) {
      this.nodeBundle = createPointMaterial({
        mode: 'window',
        sizeUnits: 'pixels',
      });
    }
    this.nodes.geometry = ng;
    this.nodes.material = this.nodeBundle.material;
    this.nodeRadiiRepresentative = representativeRadius(buf.nodeRadii);
    this.pushNodeUniforms();
  }

  /** Refresh ONLY the time-dependent attributes (widths/insets/nodes) in place. */
  private updateDynamic(buf: FlowmapBuffers): void {
    const ag = this.arrows.geometry;
    const wAttr = ag.getAttribute('sttWidth') as
      | InstancedBufferAttribute
      | undefined;
    const eAttr = ag.getAttribute('sttEndpointOffsets') as
      | InstancedBufferAttribute
      | undefined;
    // Instance count is invariant (geometry fixed); update if shapes still match.
    if (wAttr && wAttr.array.length === buf.widths.length) {
      (wAttr.array as Float32Array).set(buf.widths);
      wAttr.needsUpdate = true;
    }
    if (eAttr && eAttr.array.length === buf.endpointOffsets.length) {
      (eAttr.array as Float32Array).set(buf.endpointOffsets);
      eAttr.needsUpdate = true;
    }
    // Node set membership can change with the playhead → rebuild node
    // GEOMETRY (the material is kept: rebuilding it here was a shader
    // recompile per cross-fade sub-step).
    if (!this.opts.hideNodes) {
      this.nodes.geometry?.dispose();
      this.buildNodeGeometry(buf);
    }
  }

  private nodeRadiiRepresentative = 6;

  private pushArrowUniforms(): void {
    if (!this.arrowBundle) return;
    updateFlowArrowUniforms(this.arrowBundle, {
      sourceColor: toVec4(this.opts.sourceColor ?? DEFAULT_SOURCE_COLOR),
      targetColor: toVec4(this.opts.targetColor ?? DEFAULT_TARGET_COLOR),
      widthMinPixels: this.opts.widthMinPixels ?? 1,
      widthMaxPixels: this.opts.widthMaxPixels ?? 12,
      gap: this.opts.gap ?? 0.5,
      opacity: this.opts.opacity ?? 1,
      viewport: this.viewport,
    });
  }

  private pushNodeUniforms(): void {
    if (!this.nodeBundle) return;
    updatePointUniforms(this.nodeBundle, {
      relativeCurrentTime: 0,
      params: { windowHalf: OPEN_WINDOW_HALF, fadeIn: 0, fadeOut: 0 },
      pointSize: this.nodeRadiiRepresentative,
      opacity: this.opts.opacity ?? 1,
      viewport: this.viewport,
    });
  }

  private ensureEmptyGeometry(): void {
    if (!this.arrows.geometry)
      this.arrows.geometry = makeArrowTemplateGeometry();
    if (!this.nodes.geometry) this.nodes.geometry = makeBillboardQuadGeometry();
  }

  private disposeGeometries(): void {
    this.arrows.geometry?.dispose();
    this.nodes.geometry?.dispose();
  }

  private disposeGpu(): void {
    this.disposeGeometries();
    this.arrowBundle?.material.dispose();
    this.nodeBundle?.material.dispose();
    this.arrowBundle = null;
    this.nodeBundle = null;
  }

  dispose(): void {
    this.disposeGpu();
  }
}

/** A representative node-circle pixel size for the shared (single-uniform) point
 * material — the 70th-percentile radius, so hubs read large without one giant
 * outlier blowing every dot out. */
function representativeRadius(radii: Float32Array): number {
  if (radii.length === 0) return 6;
  const sorted = Float32Array.from(radii).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.7))];
}
