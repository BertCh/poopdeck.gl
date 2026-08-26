// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTFlowStrokeLayer` — the Three/TSL port of deck's `FlowStrokeLayer`:
 * coherent merged DIRECTED corridors whose WIDTH breathes with the active
 * hour's traveller count, drawn as twin offset ribbons. Built for the
 * `bixi-corridors` demo (`stt-generate bixi --merged-paths`).
 *
 * It EXTENDS {@link STTFlowCorridorLayer} and inherits everything that class
 * does — the once-uploaded segment geometry, the RTC origin, the whole value
 * matrix as a linear-filtered `DataTexture`, and the GPU two-bucket lerp that
 * animates per-vertex COLOUR with nothing but a moving uniform. On top of that
 * it adds exactly two things:
 *
 *   • **WIDTH** — per PATH (uniform along a corridor, deck's `PathLayer`
 *     semantics), `width = (that corridor's BUSIEST-vertex volume at the
 *     active, blended bucket) ** widthExponent`, then `widthScale`, then the
 *     `minWidthPx`/`maxWidthPx` clamp. Corridors whose active-bucket peak is
 *     `<= minFlow` collapse to width 0 — invisible — which is the per-hour
 *     pulse. The math is pure and lives in `../lib/flow-stroke-widths.js`.
 *
 *   • **OFFSET** — a constant perpendicular shift of `offsetWidths ×` the
 *     rendered width. A→B and B→A are SEPARATE strokes traversing a shared
 *     two-way street in OPPOSITE vertex order, so their screen-space
 *     perpendiculars point opposite ways and one constant offset lands them on
 *     opposite sides: the twin ribbons that expose directional asymmetry
 *     (inbound vs outbound rush). `0` disables it (and is compiled out).
 *
 * **When the width recomputes.** Only when the playhead crosses a SUB-STEP
 * (`FLOW_STROKE_SUB_STEP` = deck's `FlowCorridorLayer.STEP`, the granularity
 * deck re-expands its inherited gradient at). On a crossing the layer rewrites
 * ONE per-instance `Float32Array` of `segmentCount` floats and flips its
 * `needsUpdate`; **the geometry never re-uploads** — positions, the value
 * texture and the ramp are all untouched from `setTiles` to `dispose`. Note
 * the asymmetry with deck: THIS backend's inherited colour blend is continuous
 * (the GPU lerps the value texture at a fractional bucket), so the width is the
 * only quantized signal here, and the gate exists purely to keep the per-frame
 * CPU cost at one `Math.round` on the frames that are not a crossing.
 *
 * **Why the vertex stage is re-installed here.** The width has to be
 * PER-INSTANCE, and the shared flow-corridor material derives its width from
 * the value-texture sample instead — which is provably incompatible: there,
 * width and colour are both monotone functions of the same sampled endpoint
 * values, so "uniform width along a path" would force "uniform colour along a
 * path" and destroy the inherited gradient. So this layer keeps the corridor
 * material's FRAGMENT half verbatim (that IS the inherited colour animation:
 * the same value texture, the same ramp, the same window alpha) and replaces
 * only its VERTEX expansion with the same screen-space ribbon math driven by a
 * `sttStrokeWidth` attribute plus the offset. That is precisely the delta this
 * layer is, and it is why the graph is built here rather than in `src/tsl/`:
 * it is a DERIVATION of one material, not a new kind's material.
 *
 * **Not id-pickable.** No `pick()` / `resolvePick()`, deliberately: deck does
 * not pick this kind either. A stroke is a MERGED corridor — an aggregate over
 * many trips between many station pairs — so a picked instance would resolve to
 * a synthesised aggregate row, not to a feature a user could reason about; the
 * parent corridor layer omits picking for the same reason. Pick the underlying
 * trips/points layer instead.
 */

import { InstancedBufferAttribute, DynamicDrawUsage } from 'three';
import type { InstancedBufferGeometry } from 'three';
import type { MeshBasicNodeMaterial } from 'three/webgpu';
import type { Tile } from '@poopdeck.gl/core';
import type { STTLayerContext } from './layer.js';
import {
  STTFlowCorridorLayer,
  type STTFlowCorridorLayerOptions,
} from './flow-corridor-layer.js';
import { bucketPosFromTime } from '../lib/flow-corridor-buffers.js';
import {
  buildFlowStrokePaths,
  computePathWidths,
  expandPathWidths,
  flowStrokeSubStep,
  steppedBucketPos,
  DEFAULT_WIDTH_EXPONENT,
  type FlowStrokePaths,
  type FlowStrokeWidthOptions,
} from '../lib/flow-stroke-widths.js';
import { resolveTimeWindow } from '../lib/time-window.js';
import {
  attribute,
  positionGeometry,
  uniform,
  float,
  vec2,
  vec4,
  mix,
  modelViewMatrix,
  cameraProjectionMatrix,
  type UniformNode,
} from '../tsl/nodes.js';
import {
  TimeFilterUniforms,
  windowVisibleNode,
  updateTimeFilterUniforms,
} from '../tsl/time-filter.js';

/** Twin-ribbon separation that reads as two lanes of one street at demo zooms. */
const DEFAULT_OFFSET_WIDTHS = 0.6;

export interface STTFlowStrokeLayerOptions extends STTFlowCorridorLayerOptions {
  /**
   * Width = `(active-bucket peak volume) ** widthExponent`, before
   * {@link widthScale} and the `minWidthPx`/`maxWidthPx` clamp. `0.5` (√) is
   * area-proportional and the cartographic default; lower flattens the
   * busy/quiet contrast, higher exaggerates it.
   * @default 0.5
   */
  widthExponent?: number;
  /**
   * Corridors whose active-bucket peak volume is `<= minFlow` render at width 0
   * (invisible) — the per-hour pulse. The collapse is exact and bypasses
   * `minWidthPx`.
   * @default 0
   */
  minFlow?: number;
  /**
   * Constant perpendicular offset, in multiples of the rendered width, applied
   * to every corridor (twin-ribbon separation). `0` disables the offset — the
   * term is then compiled out of the vertex graph entirely.
   * @default 0.6
   */
  offsetWidths?: number;
  /**
   * Multiplier applied to `peak ** widthExponent` before the pixel clamp
   * (deck `PathLayer.widthScale`). Tune it so a typical rush-hour peak lands
   * inside `[minWidthPx, maxWidthPx]`.
   * @default 1
   */
  widthScale?: number;
  // NOTE on the inherited width knobs: the parent maps `minWidthPx` /
  // `maxWidthPx` onto the ENDS of a value→width lerp. For a stroke they are the
  // CLAMP of the computed width instead, so both kinds still render inside the
  // same documented pixel range — a stroke just reaches 0 below `minFlow`.
  // In BOTH kinds the number is the FULL drawn width in CSS px (the segment
  // quad's `side` ∈ {-1,+1} carries the ÷2, see `installStrokeVertexStage`).
}

export class STTFlowStrokeLayer extends STTFlowCorridorLayer {
  /** Own copy of the options — the parent's `opts` is typed to ITS interface. */
  private readonly strokeOpts: STTFlowStrokeLayerOptions;

  private paths: FlowStrokePaths | null = null;
  private widthAttr: InstancedBufferAttribute | null = null;
  /** Scratch per-PATH widths, reused across sub-steps (zero per-frame alloc). */
  private pathWidths = new Float32Array(0);
  /** Last sub-step the widths were expanded for; `NaN` = none yet. */
  private lastSubStep = Number.NaN;
  /** Last playhead seen, so a `setTiles` mid-playback widths at the right hour. */
  private currentTimeMs: number | null = null;

  /**
   * The stroke vertex stage's OWN uniforms. The parent's live in a private
   * bundle, so the re-installed graph carries its own viewport + time-filter
   * holders and this layer pushes them alongside the parent's.
   */
  private readonly strokeTime = new TimeFilterUniforms();
  private readonly strokeViewport: UniformNode = uniform(vec2(1280, 720));

  constructor(options: STTFlowStrokeLayerOptions) {
    // The parent assigns `readonly id` in ITS constructor, so the kind's own
    // default id has to be resolved before `super`.
    const resolved: STTFlowStrokeLayerOptions = {
      ...options,
      id: options.id ?? 'flow-stroke',
    };
    super(resolved);
    this.strokeOpts = resolved;
  }

  override setViewport(width: number, height: number): void {
    super.setViewport(width, height);
    this.strokeViewport.value.set(width, height);
  }

  override setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    // The parent owns geometry, textures, material and RTC origin — everything
    // a corridor is. This subclass only ever ADDS to what it produced.
    super.setTiles(tiles, ctx);
    // Both time-driven halves are re-pushed at the LIVE playhead, not at the
    // time ORIGIN the parent's `setTiles` just pushed:
    //  • the parent's `bucketPos` — the inherited COLOUR — would otherwise snap
    //    back to bucket 0 for the frame after a mid-playback tile load, while
    //    the width below is already at the live hour;
    //  • the re-installed vertex stage gates on the stroke's OWN time-filter
    //    holder, which the parent knows nothing about. Without this push a
    //    `windowFilter` stroke hard-collapses against the constructor defaults
    //    (`currentTime` 0, `windowHalf` 0) while the inherited fragment alpha
    //    runs the real window — the hard cut killing what the soft alpha drew.
    const now = this.currentTimeMs ?? ctx.timeOrigin;
    if (this.currentTimeMs !== null) super.setTime(this.currentTimeMs);
    this.pushStrokeUniforms(now);
    this.paths = null;
    this.widthAttr = null;
    this.lastSubStep = Number.NaN;
    if (!this.object.visible) return; // parent merged nothing

    const paths = buildFlowStrokePaths(tiles);
    const geometry = this.object.geometry as InstancedBufferGeometry;
    if (paths.segmentCount === 0) return;
    if (geometry.instanceCount !== paths.segmentCount) {
      // The two builders walk the same tiles with mirrored predicates; if they
      // ever disagree, every width would land on the wrong corridor. Announce
      // it and degrade to a plain corridor rather than render a lie.
      // eslint-disable-next-line no-console
      console.warn(
        `[stt-three] STTFlowStrokeLayer "${this.id}": ${paths.segmentCount} ` +
          `stroke segments vs ${geometry.instanceCount} corridor instances — ` +
          `skipping the per-path width (rendering as a flow corridor).`,
      );
      return;
    }
    // The parent assigns a single node material whenever it merged anything;
    // the multi-material case is impossible here, but bail rather than guess.
    if (!this.object.material || Array.isArray(this.object.material)) return;
    const material = this.object.material as MeshBasicNodeMaterial;

    const widths = new Float32Array(paths.segmentCount);
    const attr = new InstancedBufferAttribute(widths, 1);
    // Rewritten on every sub-step crossing — the ONE buffer that ever re-uploads.
    attr.setUsage(DynamicDrawUsage);
    geometry.setAttribute('sttStrokeWidth', attr);

    this.paths = paths;
    this.widthAttr = attr;
    this.pathWidths = new Float32Array(paths.pathCount);
    this.installStrokeVertexStage(material);
    this.refreshWidths(now);
  }

  override setTime(absoluteTimeMs: number): void {
    // Parent: the value-texture bucket + ramp/domain/opacity uniforms (colour).
    super.setTime(absoluteTimeMs);
    this.currentTimeMs = absoluteTimeMs;
    this.pushStrokeUniforms(absoluteTimeMs);
    this.refreshWidths(absoluteTimeMs);
  }

  override dispose(): void {
    super.dispose();
    this.paths = null;
    this.widthAttr = null;
    this.pathWidths = new Float32Array(0);
    this.lastSubStep = Number.NaN;
  }

  /**
   * Push the re-installed vertex stage's OWN time-filter uniforms. The parent's
   * holder lives in a private bundle, so the stroke carries a second one and
   * has to keep it in lockstep — on every `setTime` AND on `setTiles`, exactly
   * where the parent pushes its own.
   */
  private pushStrokeUniforms(absoluteTimeMs: number): void {
    updateTimeFilterUniforms(
      this.strokeTime,
      this.relativeTime(absoluteTimeMs),
      {
        ...resolveTimeWindow(this.strokeOpts, 0),
        trailLength: 0,
        trailFade: 1,
      },
    );
  }

  /** The width knobs, resolved against the parent's documented pixel range. */
  private widthOptions(): FlowStrokeWidthOptions {
    return {
      widthExponent: this.strokeOpts.widthExponent ?? DEFAULT_WIDTH_EXPONENT,
      minFlow: this.strokeOpts.minFlow ?? 0,
      widthScale: this.strokeOpts.widthScale ?? 1,
      // Same defaults the parent pushes into its width lerp, so a corridor and
      // a stroke built from one config render inside the same pixel range.
      minWidthPx: this.strokeOpts.minWidthPx ?? 1,
      maxWidthPx: this.strokeOpts.maxWidthPx ?? 8,
    };
  }

  /**
   * Re-expand the per-instance widths IF the playhead crossed a sub-step. This
   * is the whole per-frame cost of the kind: one `Math.round` and an early
   * return on the ~`1/STEP` frames per bucket that are not a crossing.
   */
  private refreshWidths(absoluteTimeMs: number): void {
    const paths = this.paths;
    const attr = this.widthAttr;
    if (!paths || !attr) return;
    const pos = paths.axis ? bucketPosFromTime(paths.axis, absoluteTimeMs) : 0;
    const subStep = flowStrokeSubStep(pos);
    if (subStep === this.lastSubStep) return; // NaN !== NaN → first call runs
    this.lastSubStep = subStep;
    const opts = this.widthOptions();
    computePathWidths(paths, steppedBucketPos(subStep), opts, this.pathWidths);
    expandPathWidths(paths, this.pathWidths, attr.array as Float32Array);
    attr.needsUpdate = true;
  }

  /**
   * Replace the corridor material's VERTEX stage with the stroke expansion:
   * the identical screen-space ribbon math (see `createFlowCorridorMaterial`,
   * which this mirrors line for line), but the half-width comes from the
   * per-instance `sttStrokeWidth` attribute and the quad's `side` is biased by
   * `offsetWidths` so the whole ribbon sits off the centreline.
   *
   * The material's fragment stage — the ramp colour sampled from the value
   * texture at the playhead bucket, and its window alpha — is left exactly as
   * the parent built it. TSL varyings are declared by the FRAGMENT expressions
   * (`varying(along)`, `varying(rowV)`), so replacing `vertexNode` cannot break
   * them.
   */
  private installStrokeVertexStage(material: MeshBasicNodeMaterial): void {
    const posA = attribute('sttPosA', 'vec3');
    const posB = attribute('sttPosB', 'vec3');
    const width = attribute('sttStrokeWidth', 'float');
    const along = positionGeometry.x; // 0 (A) .. 1 (B)
    const side = positionGeometry.y; // -1 .. +1

    const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
    const clipA = mvp.mul(vec4(posA, 1));
    const clipB = mvp.mul(vec4(posB, 1));
    const ndcA = clipA.xy.div(clipA.w);
    const ndcB = clipB.xy.div(clipB.w);
    const dir = ndcB.sub(ndcA).mul(this.strokeViewport).normalize();
    const perp = vec2(dir.y.negate(), dir.x);
    const clip = mix(clipA, clipB, along);

    // HARD vertex-stage collapse, same as the parent: an out-of-window stroke
    // gets width ×0 (zero-area strip → dies at assembly, no fragment cost;
    // deck.gl #7509). A corridor spans the whole range by default, so
    // `windowFilter` is normally off and this is a compile-time `1`.
    const visible = this.strokeOpts.windowFilter
      ? windowVisibleNode(
          this.strokeTime,
          attribute('sttStart', 'float'),
          attribute('sttEnd', 'float'),
        )
      : float(1);

    // `side` ∈ {-1,+1} spans the ribbon; adding a constant BIASES it, which is
    // the twin-ribbon offset — A→B and B→A traverse the shared street in
    // opposite vertex order, so their `perp` point opposite ways and one
    // constant lands them on opposite sides. Compiled out when 0.
    //
    // The BIAS IS DOUBLED, and that factor is load-bearing. `off` below divides
    // by the viewport, and NDC-per-pixel is 2/viewport, so `side.mul(width)`
    // displaces a corner by `side · width / 2` PIXELS — which is why the drawn
    // ribbon is exactly `sttStrokeWidth` px wide (the house convention, see
    // `wide-line-material.ts`: "pixel half-offset (side·widthPx/2) → NDC
    // (×2/viewport)"). A constant `c` added to `side` therefore shifts the
    // centreline by `c · width / 2` px = `c/2` RENDERED widths, so expressing
    // `offsetWidths` in multiples of the rendered width (deck's
    // `PathStyleExtension({offset:true})` + `getOffset`) needs `c = 2 ·
    // offsetWidths`. At the 0.6 default that puts the two centrelines 1.2
    // widths apart — a 0.2-width gap between ribbons. The naive `side +
    // offsetWidths` would separate them by only 0.6 widths and OVERLAP the
    // twin ribbons by 40%, which is the one thing this kind exists to show.
    const offsetWidths = this.strokeOpts.offsetWidths ?? DEFAULT_OFFSET_WIDTHS;
    const lateral = offsetWidths ? side.add(float(2 * offsetWidths)) : side;
    const off = perp
      .mul(lateral.mul(width).mul(visible))
      .div(this.strokeViewport)
      .mul(clip.w);

    material.vertexNode = vec4(
      clip.x.add(off.x),
      clip.y.add(off.y),
      clip.z,
      clip.w,
    );
  }
}
