// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTTripsLayer` — animated trips/trajectories with a trailing fade, the Three port
 * of deck's `AnimatedTripsLayer` (trail mode) over the {@link createWideLineMaterial}
 * ribbon. Each LineString segment is one quad instance the GPU expands to `widthPx`
 * screen pixels; per-vertex trail times (`sttTimeA`/`sttTimeB`) fade each vertex
 * behind the playhead over `[cur - trailLength, cur]`, with optional head→tail fade.
 *
 * This is a sibling of {@link STTWideLineLayer} pinned to `mode: 'trail'`, using
 * {@link buildTripsBuffers} (real per-vertex trail times) instead of
 * {@link buildLineSegmentBuffers} (which leaves `timeA`/`timeB` at feature start).
 *
 * RTC: all tiles merge into one instanced buffer whose positions are relative to a
 * shared `origin`, written to `object.position`. AV/ENU origin is tiny → no-op.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { InstanceProvenance, buildIdColors } from '@poopdeck.gl/core/picking';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import { makeSegmentQuadGeometry } from '../geometry/segment-quad.js';
import {
  buildTripsBuffers,
  type TripsColorMode,
  type TripsBufferOptions,
} from '../lib/trips-buffers.js';
import {
  createWideLineMaterial,
  createWideLineIdMaterial,
  updateWideLineUniforms,
  type WideLineMaterialBundle,
  type WideLineUniformValues,
} from '../tsl/wide-line-material.js';
import type { DataFilterRange } from '../tsl/data-filter.js';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

export interface STTTripsLayerOptions {
  id?: string;
  /** Per-feature colour: categorical | ramp | constant. */
  colorMode: TripsColorMode;
  /** Full trail width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /**
   * Additive blending (glowing trails) instead of normal alpha.
   *
   * OFF by default, matching deck's `AnimatedTripsLayer` — which sets no
   * blending override at all, so it draws with deck's normal
   * `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`. This layer used to default it ON, the one
   * blend divergence among the three line layers (arc / flowmap / flow-corridor
   * / path-geo all pass the caller's value straight through). Additive only
   * flatters a DARK basemap: on a light one every track saturates its
   * destination and clips to white regardless of the colour the shader
   * computed, which is exactly what buried the ocean-drifters SST ramp on its
   * cream globe. Opt in per demo when the glow is wanted.
   *
   * @default false
   */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  // geometry
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // ── DataFilter (deck DataFilterExtension) ──────────────────────────────────
  /**
   * Numeric column feeding the GPU column filter (`sttFilterValue`, per segment —
   * a trip's value repeated to each of its segments). When set, the material
   * installs the filter and each trip is gated by {@link filterRange} /
   * {@link filterSoftRange}. @default null (no filter)
   */
  filterProperty?: string | null;
  /** Inclusive `[min,max]` hard range; `null` idles the filter. @default null */
  filterRange?: DataFilterRange | null;
  /** `[min,max]` inside {@link filterRange} fading instead of hard-clipping. @default null */
  filterSoftRange?: DataFilterRange | null;
  /** Enable/disable the column filter. @default true */
  filterEnabled?: boolean;
  // trail params
  /** Trail length behind the playhead (ms). @default 180000 */
  trailLength?: number;
  /** 1 ⇒ trail fades head→tail; 0 ⇒ solid trail. @default 1 */
  trailFade?: number;
}

export class STTTripsLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: WideLineMaterialBundle | null = null;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: STTTripsLayerOptions;

  // ── GPU id-buffer pick identity (merged instance i → (tileKey, featureIndex)) ──
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  private idBundle: WideLineMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  constructor(options: STTTripsLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'trips';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so `widthPx` is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  protected bufferOptions(): TripsBufferOptions {
    return {
      colorMode: this.opts.colorMode,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      zLift: this.opts.zLift ?? 0,
      filterProperty: this.opts.filterProperty ?? null,
    };
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const buf = buildTripsBuffers(
      tiles,
      ctx.projection,
      ctx.timeOrigin,
      this.bufferOptions(),
    );
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old trip).
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;

    this.disposeGpu();
    if (buf.count === 0) {
      this.object.geometry = makeSegmentQuadGeometry();
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    const geometry = makeSegmentQuadGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute('sttPosA', new InstancedBufferAttribute(buf.posA, 3));
    geometry.setAttribute('sttPosB', new InstancedBufferAttribute(buf.posB, 3));
    geometry.setAttribute(
      'sttColorA',
      new InstancedBufferAttribute(buf.colorA, 4),
    );
    geometry.setAttribute(
      'sttColorB',
      new InstancedBufferAttribute(buf.colorB, 4),
    );
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    geometry.setAttribute(
      'sttTimeA',
      new InstancedBufferAttribute(buf.timeA, 1),
    );
    geometry.setAttribute(
      'sttTimeB',
      new InstancedBufferAttribute(buf.timeB, 1),
    );
    // DataFilter: bind the per-segment filter value when a filterProperty emitted one.
    if (buf.filterValues.length > 0) {
      geometry.setAttribute(
        'sttFilterValue',
        new InstancedBufferAttribute(buf.filterValues, 1),
      );
    }
    if (buf.bbox) {
      geometry.boundingBox = new Box3(
        new Vector3(...buf.bbox.min),
        new Vector3(...buf.bbox.max),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }

    this.bundle = createWideLineMaterial({
      mode: 'trail',
      additive: this.opts.additive ?? false,
      depthWrite: this.opts.depthWrite,
      alphaCutoff: this.opts.alphaCutoff,
      dataFilter: !!this.opts.filterProperty,
    });
    this.object.geometry = geometry;
    this.object.material = this.bundle.material;
    this.pushUniforms(this.timeOrigin);
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    this.pushUniforms(absoluteTimeMs);
  }

  /** The uniform values for the given playhead — shared by the colour render and
   *  the id-pass so the pick pass gates on the SAME trail + filter + width. */
  private uniformValues(absoluteTimeMs: number): WideLineUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        trailLength: this.opts.trailLength ?? 180_000,
        trailFade: this.opts.trailFade ?? 1,
      },
      widthPx: this.opts.widthPx ?? 2,
      opacity: this.opts.opacity ?? 1,
      viewport: this.viewport,
      dataFilter: {
        filterEnabled: this.opts.filterEnabled,
        filterRange: this.opts.filterRange ?? null,
        filterSoftRange: this.opts.filterSoftRange ?? null,
      },
    };
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updateWideLineUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: trips variant, `trips` kind) ───────────

  /**
   * Resolve a merged instance index (as decoded from a GPU id-buffer readback) to
   * a normalised {@link STTIdPickInfo} (`kind: 'trips'`), or `null` for a miss. A
   * pick on any trail segment resolves to the whole trip (its first vertex is the
   * coordinate). Pure — the unit-tested seam; call it directly with a decoded index.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'trips',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-instance `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createWideLineIdMaterial({
        mode: 'trail',
        dataFilter: !!this.opts.filterProperty,
        alphaCutoff: this.opts.alphaCutoff,
      });
    }
    if (!this.idColorsPresent && this.provenance.length > 0) {
      const idColors = buildIdColors(this.provenance.length);
      this.object.geometry.setAttribute(
        'sttIdColor',
        new InstancedBufferAttribute(idColors, 3),
      );
      this.idColorsPresent = true;
    }
  }

  /**
   * GPU trips pick — auto-registered into the r3f `PickController`. Renders the
   * trip trails with the flat id material into `picker`'s off-screen target, reads
   * back the merged-instance id at CSS pixel `(cssX, cssY)`, and resolves it. The
   * id material reuses the SAME per-vertex trail-collapse gate (+ column filter),
   * so only the CURRENTLY-DRAWN trail (behind the playhead) is pickable — picking
   * the drawn geometry position (per-track glide-pick is deferred, consistent with
   * point/icon). Browser-verify render.
   */
  async pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<STTIdPickInfo | null> {
    if (this.provenance.length === 0 || !this.object.visible) return null;
    this.ensurePickPass();
    const idBundle = this.idBundle;
    if (!idBundle) return null;
    updateWideLineUniforms(idBundle, this.uniformValues(this.currentTimeMs));

    const mesh = this.object;
    const renderMaterial = mesh.material;
    const index = await picker.pick(mesh, camera, cssX, cssY, {
      featureCount: this.provenance.length,
      onBeforeRender: () => {
        mesh.material = idBundle.material;
      },
      onAfterRender: () => {
        mesh.material = renderMaterial;
      },
    });
    if (index == null) return null;
    return this.resolvePick(index, [cssX, cssY]);
  }

  private disposeGpu(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.bundle?.material.dispose();
    this.bundle = null;
    this.idBundle?.material.dispose();
    this.idBundle = null;
    this.idColorsPresent = false;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
