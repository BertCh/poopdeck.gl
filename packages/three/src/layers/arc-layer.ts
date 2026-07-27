// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTArcLayer` — raised origin→destination arcs, the Three port of deck's
 * `AnimatedArcLayer`. Every LineString feature collapses to its source (first)
 * and target (last) endpoint (one arc instance); the GPU tessellates a raised,
 * window-time-filtered, source→target gradient curve over the instanced strip
 * ({@link makeArcStripGeometry} + {@link createArcMaterial}). Unlocks the
 * od-arcs demo.
 *
 * RTC: all tiles merge into one instanced buffer whose endpoints are relative to
 * a shared `origin`, written to `object.position` so large mercator/globe
 * magnitudes stay in the f64 CPU transform. The same origin is pushed to the
 * material uniform so the `greatCircle` shape can recover absolute ECEF for slerp.
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
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import {
  buildArcBuffers,
  type ArcColorMode,
  type ArcBufferOptions,
} from '../lib/arc-buffers.js';
import {
  createArcMaterial,
  createArcIdMaterial,
  makeArcStripGeometry,
  updateArcUniforms,
  type ArcMaterialBundle,
  type ArcShape,
  type ArcUniformValues,
} from '../tsl/arc-material.js';
import type { DataFilterRange } from '../tsl/data-filter.js';
import { buildStablePalette, type StablePalette } from '../lib/palette.js';
import type { RGBA } from '../lib/color.js';
import { makePaletteTexture } from '../tsl/palette.js';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

export interface STTArcLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** parabolic flat-map raised arc | greatCircle spherical (globe). @default 'parabolic' */
  shape?: ArcShape;
  /** Source-endpoint colour spec. @default constant [0,150,255,255] */
  sourceColor?: ArcColorMode;
  /** Target-endpoint colour spec. @default constant [255,127,14,255] */
  targetColor?: ArcColorMode;
  /** Full arc width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /** Additive blending (glowing flows). @default false */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  /** Per-arc height multiplier (constant). @default 1 */
  height?: number;
  /** Per-feature numeric height-multiplier column (overrides {@link height}). */
  heightProperty?: string | null;
  // geometry lift
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // ── DataFilter (deck DataFilterExtension) ──────────────────────────────────
  /**
   * Numeric column feeding the GPU column filter (`sttFilterValue`, per arc).
   * When set, the material installs the filter and each arc is gated by
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
   * Opt into the GPU stable-palette path when `sourceColor` OR `targetColor` is
   * categorical (source wins if both are — the extension drives ONE unified arc
   * colour, matching deck's arc constraint). The category then renders the SAME
   * colour in every tile and recolouring is a palette-texture swap. Off (default)
   * or all-constant/ramp colours leave the per-endpoint gradient path
   * BYTE-IDENTICAL. @default false
   */
  stableColorMapping?: boolean;
  /**
   * Positional palette (deck `colorPalette`) for the auto / hash / order paths of
   * {@link stableColorMapping}; ignored when the driving endpoint's `mapping` is
   * non-empty. Defaults to the shared categorical palette.
   */
  colorPalette?: RGBA[];
  /**
   * Optional global category ordering for {@link stableColorMapping} (a label
   * takes its position here instead of a hash). Ignored when the driving
   * endpoint's `mapping` is non-empty.
   */
  categoryOrder?: string[];
  // time window params (full-width `timeWindow` + `fadeIn/OutDuration`, plus the
  // lower-level `windowHalf`/`fadeIn`/`fadeOut` aliases) via ThreeTimeWindowOptions.
}

export class STTArcLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: ArcMaterialBundle | null = null;
  private paletteTexture: DataTexture | null = null;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: STTArcLayerOptions;

  // ── GPU id-buffer pick identity (merged instance i → (tileKey, featureIndex)) ──
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  private idBundle: ArcMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;
  /** RTC origin of the current buffers (greatCircle id pass needs it too). */
  private origin: [number, number, number] = [0, 0, 0];

  constructor(options: STTArcLayerOptions = {}) {
    super();
    this.opts = options;
    this.id = options.id ?? 'arc';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so `widthPx` is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  protected bufferOptions(): ArcBufferOptions {
    return {
      sourceColor: this.opts.sourceColor,
      targetColor: this.opts.targetColor,
      height: this.opts.height ?? 1,
      heightProperty: this.opts.heightProperty ?? null,
      elevationProperty: this.opts.elevationProperty ?? null,
      elevationScale: this.opts.elevationScale ?? 1,
      zLift: this.opts.zLift ?? 0,
      filterProperty: this.opts.filterProperty ?? null,
    };
  }

  /**
   * Resolve the GPU stable-palette path (driving categorical property + palette)
   * when `stableColorMapping` is on and an endpoint colour is categorical; else
   * null. Source wins if both endpoints are categorical (deck's single-colour arc
   * constraint). CPU-only — the texture is built after `disposeGpu` in `setTiles`.
   */
  private resolveCategoryPalette(): {
    property: string;
    palette: StablePalette;
  } | null {
    if (this.opts.stableColorMapping !== true) return null;
    const mode =
      this.opts.sourceColor?.type === 'categorical'
        ? this.opts.sourceColor
        : this.opts.targetColor?.type === 'categorical'
          ? this.opts.targetColor
          : null;
    if (!mode) return null;
    const palette = buildStablePalette({
      colorMapping: mode.mapping,
      colorMappingDefault: mode.fallback,
      palette: this.opts.colorPalette,
      categoryOrder: this.opts.categoryOrder,
    });
    return { property: mode.property, palette };
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const cat = this.resolveCategoryPalette();
    const buf = buildArcBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      ...this.bufferOptions(),
      categoryIndex: cat,
    });
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old feature).
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;
    this.origin = buf.origin;

    this.disposeGpu();
    if (buf.count === 0) {
      this.object.geometry = makeArcStripGeometry();
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    const geometry = makeArcStripGeometry();
    geometry.instanceCount = buf.count;
    geometry.setAttribute(
      'sttPosSource',
      new InstancedBufferAttribute(buf.posSource, 3),
    );
    geometry.setAttribute(
      'sttPosTarget',
      new InstancedBufferAttribute(buf.posTarget, 3),
    );
    geometry.setAttribute(
      'sttColorSource',
      new InstancedBufferAttribute(buf.colorSource, 4),
    );
    geometry.setAttribute(
      'sttColorTarget',
      new InstancedBufferAttribute(buf.colorTarget, 4),
    );
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    geometry.setAttribute(
      'sttHeight',
      new InstancedBufferAttribute(buf.heights, 1),
    );
    // DataFilter: bind the per-arc filter value when a filterProperty emitted one.
    if (buf.filterValues.length > 0) {
      geometry.setAttribute(
        'sttFilterValue',
        new InstancedBufferAttribute(buf.filterValues, 1),
      );
    }
    // Stable palette: bind the per-arc category slot when it emitted one.
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

    this.bundle = createArcMaterial({
      shape: this.opts.shape ?? 'parabolic',
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
    // origin lives in the uniform too (greatCircle slerp recovers absolute ECEF).
    this.bundle.arc.origin.value.set(
      buf.origin[0],
      buf.origin[1],
      buf.origin[2],
    );
    this.pushUniforms(this.timeOrigin);
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    this.pushUniforms(absoluteTimeMs);
  }

  /** The uniform values for the given playhead — shared by the colour render and
   *  the id-pass so the pick pass gates on the SAME window / filter / width. */
  private uniformValues(absoluteTimeMs: number): ArcUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: resolveTimeWindow(this.opts, 0),
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
    updateArcUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: arc variant) ───────────────────────────

  /**
   * Resolve a merged instance index (as decoded from a GPU id-buffer readback)
   * to a normalised {@link STTIdPickInfo} (`kind: 'arc'`), or `null` for a miss.
   * The coordinate is the arc's SOURCE endpoint (first vertex). Pure — the
   * unit-tested seam; call it directly with a decoded index.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'arc',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-instance `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createArcIdMaterial({
        shape: this.opts.shape ?? 'parabolic',
        dataFilter: !!this.opts.filterProperty,
        alphaCutoff: this.opts.alphaCutoff,
      });
      // greatCircle slerp recovers absolute ECEF by adding the RTC origin back.
      this.idBundle.arc.origin.value.set(
        this.origin[0],
        this.origin[1],
        this.origin[2],
      );
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
   * GPU arc pick — auto-registered into the r3f `PickController` (a CPU box miss
   * falls through to this). Renders this layer's ribbons with the flat id
   * material into `picker`'s off-screen target, reads back the merged-instance id
   * at CSS pixel `(cssX, cssY)`, and resolves it through the provenance buffer.
   * The `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify. The id material reuses the SAME vertex
   * width-collapse gate (time-window + column-filter), so only arcs drawn THIS
   * frame are pickable.
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
    // Sync the id material's gates + width/viewport to the live playhead so only
    // arcs visible THIS frame are pickable, at their true screen ribbon.
    updateArcUniforms(idBundle, this.uniformValues(this.currentTimeMs));

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
