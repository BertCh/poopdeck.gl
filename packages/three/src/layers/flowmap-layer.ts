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
 *
 * OPT-IN BUNDLING (`bundling`): with it on, the arrows are replaced by KDEEB
 * bundled rivers — `../lib/edge-bundler.ts` resamples each OD flow into control
 * points, hands them to the ONE shared iteration in
 * `@poopdeck.gl/core/edge-bundling`, and the result is drawn as per-segment
 * ribbons by {@link createBundledFlowMaterial} (direction read from the
 * source→target gradient, not an arrowhead). A bundle is STATIC GEOMETRY: it is
 * a function of the edge SET, so it is recomputed in {@link setTiles} and never
 * on the playhead — the per-edge width refresh above is unchanged, just fanned
 * across each edge's segments. When the bundle cannot be built (no renderer
 * backend, too few flows, or over the CPU work budget) the layer says so ONCE
 * and keeps drawing straight arrows; nothing throws and nothing half-draws.
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
import { makeSegmentQuadGeometry } from '../geometry/segment-quad.js';
import {
  buildFlowmapBuffers,
  type FlowmapBufferOptions,
  type FlowmapBuffers,
} from '../lib/flowmap-buffers.js';
import {
  bundleFlowEdges,
  collectFlowEndpoints,
  isBundlingSupported,
  type BundledFlowEdges,
  type BundleRenderer,
  type ThreeBundleOptions,
} from '../lib/edge-bundler.js';
import {
  createFlowArrowMaterial,
  updateFlowArrowUniforms,
  type FlowArrowMaterialBundle,
} from '../tsl/flow-arrow-material.js';
import { createBundledFlowMaterial } from '../tsl/bundle-material.js';
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

/** Console-warn at most once per key — a fallback must say so, not spam. */
const warnedKeys = new Set<string>();
function warnOnce(key: string, ...args: unknown[]): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(...args);
}

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
  /**
   * Draw KDEEB-**bundled rivers** instead of straight arrows (`true` for the
   * defaults, or an options object to tune the bundler). Geometrically close
   * flows are advected together into smooth rivers by the shared iteration in
   * `@poopdeck.gl/core/edge-bundling`, which turns an unreadable hairball of OD
   * lines into legible corridors. Direction is then carried by the
   * source→target colour gradient rather than an arrowhead.
   *
   * COST: the bundle is recomputed synchronously on the main thread whenever
   * the tile set changes — never per frame — and is capped by
   * {@link BUNDLE_WORK_BUDGET}. Over budget (or with fewer than 2 flows in
   * view), the layer warns once and keeps drawing straight arrows.
   * @default false
   */
  bundling?: boolean | ThreeBundleOptions;
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
  /** Ribbon material for the bundled path; built lazily, alongside the arrows'. */
  private bundleMaterial: FlowArrowMaterialBundle | null = null;

  private tiles: Tile[] = [];
  private projection: STTLayerContext['projection'] | null = null;
  private viewport: [number, number] = [1280, 720];
  private lastStepKey = Number.NaN;
  private readonly opts: STTFlowmapLayerOptions;

  /** The bundled rivers for the CURRENT tile set; `null` = straight arrows. */
  private bundle: BundledFlowEdges | null = null;
  /** Whether the resident arrow geometry is the ribbon form or the arrow form. */
  private bundledGeometry = false;
  /** True once geometry exists, so the sub-step cache knows it may skip. */
  private built = false;
  /** Set when the device gate downgrades us mid-life; drains on the next frame. */
  private pendingGeometryRebuild = false;
  /** The host renderer, learned from the first `onBeforeRender` (heatmap idiom). */
  private renderer: BundleRenderer | null = null;

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
    // The only place a layer sees the host renderer (the `STTHeatmapLayer`
    // idiom). It is the bundler's device gate; before the first frame there is
    // no renderer and `isBundlingSupported(undefined)` is deliberately `true`.
    this.arrows.onBeforeRender = (renderer): void => {
      this.noteRenderer(renderer as unknown as BundleRenderer);
    };
  }

  /** Host pushes the drawing-buffer size on resize so widths/radii are true px. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
    this.forEachArrowBundle((b) => b.arrow.viewport.value.set(width, height));
    if (this.nodeBundle)
      this.nodeBundle.point.viewport.value.set(width, height);
  }

  /** Run `fn` over whichever arrow/ribbon materials exist (uniforms are shared). */
  private forEachArrowBundle(fn: (b: FlowArrowMaterialBundle) => void): void {
    if (this.arrowBundle) fn(this.arrowBundle);
    if (this.bundleMaterial) fn(this.bundleMaterial);
  }

  /**
   * Learn the host renderer and re-check the bundling device gate against it. A
   * renderer that cannot host the bundle downgrades us to straight arrows on the
   * next frame rather than mid-render: only flags are set here.
   */
  private noteRenderer(renderer: BundleRenderer): void {
    if (this.renderer === renderer) return;
    this.renderer = renderer;
    if (!this.bundlingRequested() || isBundlingSupported(renderer)) return;
    warnOnce(
      `flowmap-bundling:${this.id}`,
      `[stt-three] STTFlowmapLayer '${this.id}': bundling is not supported by ` +
        'this renderer; falling back to straight arrows.',
    );
    if (this.bundle) {
      this.bundle = null;
      this.pendingGeometryRebuild = true;
    }
  }

  /** The caller's bundling knobs, or `null` when bundling is off (the default). */
  private bundlingRequested(): ThreeBundleOptions | null {
    const b = this.opts.bundling;
    if (!b) return null;
    return b === true ? {} : b;
  }

  /**
   * Recompute the bundled rivers for the current tile set — the ONLY place the
   * KDEEB iteration runs. A bundle is static geometry, so this is called from
   * `setTiles` and never from `setTime`.
   */
  private rebuildBundle(): void {
    this.bundle = null;
    const requested = this.bundlingRequested();
    if (!requested) return;
    const ends = collectFlowEndpoints(this.tiles);
    const result = bundleFlowEdges(
      ends.endpoints,
      ends.edgeCount,
      requested,
      this.renderer,
    );
    if (result.bundled) {
      this.bundle = result.edges;
      return;
    }
    warnOnce(
      `flowmap-bundling:${this.id}`,
      `[stt-three] STTFlowmapLayer '${this.id}': drawing straight arrows — ` +
        `${result.reason}.`,
    );
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
    this.built = false;
    // The edge SET just changed, so this is exactly when (and the only time) the
    // bundle is recomputed.
    this.rebuildBundle();
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
    const force = forceGeometry || this.pendingGeometryRebuild;
    const stepKey = this.stepKey(absoluteTimeMs);
    if (!force && this.built && stepKey === this.lastStepKey) return;
    this.lastStepKey = stepKey;
    this.pendingGeometryRebuild = false;

    const buf = buildFlowmapBuffers(
      this.tiles,
      this.projection,
      absoluteTimeMs,
      this.bufferOptions(),
    );

    if (buf.count === 0) {
      this.object.visible = false;
      if (force) this.ensureEmptyGeometry();
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    if (force || !this.built) this.buildGeometry(buf);
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
    // A bundle is only usable when it describes THIS edge set. Both derive from
    // the same tiles, so a mismatch means the two got out of step; drawing
    // straight arrows is the safe read rather than indexing widths by a stale
    // edge index.
    const bundle =
      this.bundle && this.bundle.edgeCount === buf.count ? this.bundle : null;
    this.bundledGeometry = bundle !== null;
    if (bundle) this.buildBundledGeometry(buf, bundle);
    else this.buildArrowGeometry(buf);

    // ── Nodes ─────────────────────────────────────────────────────────────────
    this.buildNodeGeometry(buf);
    this.built = true;
  }

  /** Straight tapered half-arrows: one instance per OD flow (the default path). */
  private buildArrowGeometry(buf: FlowmapBuffers): void {
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
  }

  /**
   * KDEEB bundled rivers: one instance per SEGMENT of each bundled edge
   * (`E × (P-1)`), on the shared segment quad. The bundled control points arrive
   * in lon/lat from `../lib/edge-bundler.ts` and are projected here, RTC-relative
   * to the same `buf.origin` the straight path uses, so switching paths cannot
   * move the map. Each control point is projected ONCE and shared by the two
   * segments that meet at it.
   */
  private buildBundledGeometry(
    buf: FlowmapBuffers,
    bundle: BundledFlowEdges,
  ): void {
    const projection = this.projection;
    if (!projection) return;
    const { edgeCount, pointsPerEdge, lonLat } = bundle;
    const segs = pointsPerEdge - 1;
    const count = edgeCount * segs;
    const [ox, oy, oz] = buf.origin;

    const posSource = new Float32Array(count * 3);
    const posTarget = new Float32Array(count * 3);
    const widths = new Float32Array(count);
    const bundleT = new Float32Array(count * 2);
    const local = new Float64Array(pointsPerEdge * 3);

    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity;
    let maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;

    for (let e = 0; e < edgeCount; e++) {
      for (let i = 0; i < pointsPerEdge; i++) {
        const p = projection.project(
          lonLat[(e * pointsPerEdge + i) * 2],
          lonLat[(e * pointsPerEdge + i) * 2 + 1],
          0,
        );
        const x = p[0] - ox,
          y = p[1] - oy,
          z = p[2] - oz;
        local[i * 3] = x;
        local[i * 3 + 1] = y;
        local[i * 3 + 2] = z;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      const w = buf.widths[e];
      for (let s = 0; s < segs; s++) {
        const j = e * segs + s;
        posSource[j * 3] = local[s * 3];
        posSource[j * 3 + 1] = local[s * 3 + 1];
        posSource[j * 3 + 2] = local[s * 3 + 2];
        posTarget[j * 3] = local[(s + 1) * 3];
        posTarget[j * 3 + 1] = local[(s + 1) * 3 + 1];
        posTarget[j * 3 + 2] = local[(s + 1) * 3 + 2];
        widths[j] = w;
        bundleT[j * 2] = s / segs;
        bundleT[j * 2 + 1] = (s + 1) / segs;
      }
    }

    const rg = makeSegmentQuadGeometry();
    rg.instanceCount = count;
    rg.setAttribute('sttPosSource', new InstancedBufferAttribute(posSource, 3));
    rg.setAttribute('sttPosTarget', new InstancedBufferAttribute(posTarget, 3));
    rg.setAttribute('sttWidth', new InstancedBufferAttribute(widths, 1));
    rg.setAttribute('sttBundleT', new InstancedBufferAttribute(bundleT, 2));
    if (count > 0) {
      rg.boundingBox = new Box3(
        new Vector3(minX, minY, minZ),
        new Vector3(maxX, maxY, maxZ),
      );
      rg.boundingSphere = rg.boundingBox.getBoundingSphere(new Sphere());
    }
    // Built ONCE, like the arrow material (audit E5).
    if (!this.bundleMaterial) {
      this.bundleMaterial = createBundledFlowMaterial({
        additive: this.opts.additive,
        depthWrite: this.opts.depthWrite,
        alphaCutoff: this.opts.alphaCutoff,
      });
    }
    this.arrows.geometry = rg;
    this.arrows.material = this.bundleMaterial.material;
    this.pushArrowUniforms();
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
    if (this.bundledGeometry && this.bundle) {
      // The bundled ribbon is `E × (P-1)` instances, so each edge's width fans
      // out across its segments. The RIVER itself never moves here — it is a
      // function of the edge set, not the playhead.
      const segs = this.bundle.pointsPerEdge - 1;
      if (wAttr && wAttr.array.length === buf.widths.length * segs) {
        const array = wAttr.array as Float32Array;
        for (let e = 0; e < buf.widths.length; e++) {
          const w = buf.widths[e];
          const base = e * segs;
          for (let s = 0; s < segs; s++) array[base + s] = w;
        }
        wAttr.needsUpdate = true;
      }
    } else {
      if (wAttr && wAttr.array.length === buf.widths.length) {
        (wAttr.array as Float32Array).set(buf.widths);
        wAttr.needsUpdate = true;
      }
      if (eAttr && eAttr.array.length === buf.endpointOffsets.length) {
        (eAttr.array as Float32Array).set(buf.endpointOffsets);
        eAttr.needsUpdate = true;
      }
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

  /** One values object, fanned out to whichever arrow/ribbon materials exist —
   *  the bundled ribbon reuses `FlowArrowUniforms` verbatim, so the straight and
   *  bundled paths cannot drift on colours, clamps, gap or opacity. */
  private pushArrowUniforms(): void {
    this.forEachArrowBundle((bundle) => {
      updateFlowArrowUniforms(bundle, {
        sourceColor: toVec4(this.opts.sourceColor ?? DEFAULT_SOURCE_COLOR),
        targetColor: toVec4(this.opts.targetColor ?? DEFAULT_TARGET_COLOR),
        widthMinPixels: this.opts.widthMinPixels ?? 1,
        widthMaxPixels: this.opts.widthMaxPixels ?? 12,
        gap: this.opts.gap ?? 0.5,
        opacity: this.opts.opacity ?? 1,
        viewport: this.viewport,
      });
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
      this.arrows.geometry = this.bundledGeometry
        ? makeSegmentQuadGeometry()
        : makeArrowTemplateGeometry();
    if (!this.nodes.geometry) this.nodes.geometry = makeBillboardQuadGeometry();
  }

  private disposeGeometries(): void {
    this.arrows.geometry?.dispose();
    this.nodes.geometry?.dispose();
  }

  private disposeGpu(): void {
    this.disposeGeometries();
    this.arrowBundle?.material.dispose();
    this.bundleMaterial?.material.dispose();
    this.nodeBundle?.material.dispose();
    this.arrowBundle = null;
    this.bundleMaterial = null;
    this.nodeBundle = null;
    this.bundle = null;
    this.built = false;
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
