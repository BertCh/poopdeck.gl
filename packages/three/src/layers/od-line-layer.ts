// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `OdLineLayer` — the Three port of deck's `AnimatedLineLayer` (WINDOW mode):
 * straight origin→destination flow lines. Each LineString feature collapses to a
 * SINGLE segment from its FIRST vertex (source) to its LAST vertex (target);
 * intermediate vertices are dropped — an OD flow has only two ends. The segment
 * rides the shared {@link createWideLineMaterial} ribbon (screen-pixel width,
 * window-mode time filter), so this is the OD-pair sibling of {@link
 * WideLineLayer} differing only in the buffer builder.
 *
 * It mirrors the `WideLineLayer.setTiles` GPU flow but feeds {@link
 * buildOdLineSegmentBuffers} (one quad instance per OD pair) instead of the
 * per-segment builder. RTC: positions relative to a shared `origin`, written to
 * `object.position`.
 *
 * Unlocks the OD-arcs / OD-flows geographic demos on the Three renderer.
 */

import {
  Mesh,
  InstancedBufferAttribute,
  Box3,
  Vector3,
  Sphere,
  DataTexture,
} from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { InstanceProvenance, buildIdColors } from '@poopdeck.gl/core/picking';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { makeSegmentQuadGeometry } from '../geometry/segment-quad.js';
import { buildOdLineSegmentBuffers } from '../lib/od-positions.js';
import type {
  LineColorMode,
  LineSegmentBufferOptions,
} from '../lib/geo-line-buffers.js';
import {
  createWideLineMaterial,
  createWideLineIdMaterial,
  updateWideLineUniforms,
  type WideLineMaterialBundle,
  type WideLineUniformValues,
} from '../tsl/wide-line-material.js';
import type { DataFilterRange } from '../tsl/data-filter.js';
import { buildStablePalette, type StablePalette } from '../lib/palette.js';
import type { RGBA } from '../lib/color.js';
import { makePaletteTexture } from '../tsl/palette.js';
import {
  resolveIdPick,
  type SttIdPickInfo,
  type SttIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

export interface OdLineLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** Per-feature color (categorical / ramp / constant). */
  colorMode: LineColorMode;
  /** Full line width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /** Additive blending (glowing flows). @default false */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  // geometry
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // ── DataFilter (deck DataFilterExtension) ──────────────────────────────────
  /**
   * Numeric column feeding the GPU column filter (`sttFilterValue`, per OD pair).
   * When set, the material installs the filter and each OD line is gated by
   * {@link filterRange} / {@link filterSoftRange}. @default null (no filter)
   */
  filterProperty?: string | null;
  /** Inclusive `[min,max]` hard range; `null` idles the filter. @default null */
  filterRange?: DataFilterRange | null;
  /** `[min,max]` inside {@link filterRange} fading instead of hard-clipping. @default null */
  filterSoftRange?: DataFilterRange | null;
  /** Enable/disable the column filter. @default true */
  filterEnabled?: boolean;
  // ── Stable categorical colour (deck CategoryColorExtension) ────────────────
  /**
   * Opt into the GPU stable-palette path for a categorical `colorMode`. A given
   * category then renders the SAME colour in every tile and recolouring is a
   * palette-texture swap. Off (default) or a non-categorical `colorMode` leaves
   * the CPU colour path BYTE-IDENTICAL. @default false
   */
  stableColorMapping?: boolean;
  /** Positional palette (deck `colorPalette`) for the auto/hash/order paths of
   *  {@link stableColorMapping}; ignored when `colorMode.mapping` is non-empty. */
  colorPalette?: RGBA[];
  /** Optional global category ordering for {@link stableColorMapping} (position
   *  instead of hash); ignored when `colorMode.mapping` is non-empty. */
  categoryOrder?: string[];
  // window-mode time params — full-width `timeWindow` + `fadeIn/OutDuration`
  // and the lower-level `windowHalf` (@default 0, instantaneous) / `fadeIn` /
  // `fadeOut` aliases come from ThreeTimeWindowOptions.
}

export class OdLineLayer extends BaseSttLayer implements SttIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: WideLineMaterialBundle | null = null;
  private paletteTexture: DataTexture | null = null;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: OdLineLayerOptions;

  // ── GPU id-buffer pick identity (merged instance i → (tileKey, featureIndex)) ──
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  private idBundle: WideLineMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  constructor(options: OdLineLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'od-line';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so `widthPx` is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  private bufferOptions(): LineSegmentBufferOptions {
    return {
      colorMode: this.opts.colorMode,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      zLift: this.opts.zLift ?? 0,
      filterProperty: this.opts.filterProperty ?? null,
    };
  }

  /**
   * Resolve the GPU stable-palette path when `stableColorMapping` is on and the
   * colour mode is categorical; else null (byte-identical CPU colour path).
   * CPU-only — the texture is built after `disposeGpu` in `setTiles`.
   */
  private resolveCategoryPalette(): {
    property: string;
    palette: StablePalette;
  } | null {
    if (this.opts.stableColorMapping !== true) return null;
    const mode = this.opts.colorMode;
    if (mode.type !== 'categorical') return null;
    const palette = buildStablePalette({
      colorMapping: mode.mapping,
      colorMappingDefault: mode.fallback,
      palette: this.opts.colorPalette,
      categoryOrder: this.opts.categoryOrder,
    });
    return { property: mode.property, palette };
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const cat = this.resolveCategoryPalette();
    const buf = buildOdLineSegmentBuffers(
      tiles,
      ctx.projection,
      ctx.timeOrigin,
      {
        ...this.bufferOptions(),
        categoryIndex: cat,
      },
    );
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old feature).
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
    // DataFilter: bind the per-OD-pair filter value when a filterProperty emitted one.
    if (buf.filterValues.length > 0) {
      geometry.setAttribute(
        'sttFilterValue',
        new InstancedBufferAttribute(buf.filterValues, 1),
      );
    }
    // Stable palette: bind the per-OD-pair category slot when it emitted one.
    if (buf.categoryIndices.length > 0) {
      geometry.setAttribute(
        'sttCategoryIndex',
        new InstancedBufferAttribute(buf.categoryIndices, 1),
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

    // Stable palette: build the texture AFTER disposeGpu (frees the previous one).
    const paletteTexture =
      cat && buf.categoryIndices.length > 0
        ? makePaletteTexture(cat.palette)
        : null;
    this.paletteTexture = paletteTexture;

    this.bundle = createWideLineMaterial({
      mode: 'window',
      additive: this.opts.additive,
      depthWrite: this.opts.depthWrite,
      alphaCutoff: this.opts.alphaCutoff,
      dataFilter: !!this.opts.filterProperty,
      colorPalette: paletteTexture ? { texture: paletteTexture } : undefined,
    });
    if (this.bundle.palette && cat) {
      this.bundle.palette.invWidth.value = 1 / cat.palette.colors.length;
    }
    this.object.geometry = geometry;
    this.object.material = this.bundle.material;
    this.pushUniforms(this.timeOrigin);
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    this.pushUniforms(absoluteTimeMs);
  }

  /** The uniform values for the given playhead — shared by the colour render and
   *  the id-pass so the pick pass gates on the SAME window + filter + width. */
  private uniformValues(absoluteTimeMs: number): WideLineUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        ...resolveTimeWindow(this.opts, 0),
        trailLength: 0,
        trailFade: 1,
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

  // ── Picking (GPU id-buffer catalog: OD-line variant, `line` kind) ──────────

  /**
   * Resolve a merged instance index (as decoded from a GPU id-buffer readback) to
   * a normalised {@link SttIdPickInfo} (`kind: 'line'`), or `null` for a miss. The
   * coordinate is the OD line's SOURCE (first) vertex. Pure — the unit-tested seam.
   */
  resolvePick(index: number, screen?: [number, number]): SttIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'line',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-instance `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createWideLineIdMaterial({
        mode: 'window',
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
   * GPU OD-line pick — auto-registered into the r3f `PickController`. Renders the
   * OD ribbons with the flat id material into `picker`'s off-screen target, reads
   * back the merged-instance id at CSS pixel `(cssX, cssY)`, and resolves it. The
   * id material reuses the SAME vertex-stage width-collapse gate (window + column
   * filter), so only OD lines drawn THIS frame are pickable. Browser-verify render.
   */
  async pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<SttIdPickInfo | null> {
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
    this.paletteTexture?.dispose();
    this.paletteTexture = null;
  }

  dispose(): void {
    this.disposeGpu();
  }
}
