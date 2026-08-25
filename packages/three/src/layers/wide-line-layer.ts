// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTWideLineLayer` — screen-pixel-width animated lines, the Three port of deck's
 * `PathLayer` / `AnimatedLineLayer` / `AnimatedTripsLayer` (window + trail) over
 * the {@link createWideLineMaterial} ribbon. Every LineString segment is one quad
 * instance; the GPU expands it to `widthPx` and time-filters it. This is the base
 * for Path (window), OD-Line (window, 2-vertex od-pairs), map-lines (`none`), and
 * the geometry base for Trips/FlowCorridor.
 *
 * RTC: all tiles merge into one instanced buffer whose positions are relative to
 * a shared `origin`, which is written to `object.position` so large mercator/globe
 * magnitudes stay in the f64 CPU transform.
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
import { makeSegmentQuadGeometry } from '../geometry/segment-quad.js';
import {
  buildLineSegmentBuffers,
  type LineColorMode,
  type LineSegmentBufferOptions,
} from '../lib/geo-line-buffers.js';
import {
  createWideLineMaterial,
  createWideLineIdMaterial,
  updateWideLineUniforms,
  type WideLineMaterialBundle,
  type WideLineMode,
  type WideLineUniformValues,
} from '../tsl/wide-line-material.js';
import type { DataFilterRange } from '../tsl/data-filter.js';
import { buildStablePalette, type StablePalette } from '../lib/palette.js';
import type { RGBA } from '../lib/color.js';
import { makePaletteTexture } from '../tsl/palette.js';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
  type STTIdPickKind,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

export interface STTWideLineLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** window (Path/OD-Line) | trail (Trips) | none (static map lines). @default 'none' */
  mode?: WideLineMode;
  colorMode: LineColorMode;
  /** Full line width in CSS pixels. @default 2 */
  widthPx?: number;
  opacity?: number;
  /** Additive blending (glowing trails/flows). @default false */
  additive?: boolean;
  depthWrite?: boolean;
  alphaCutoff?: number;
  // geometry
  elevationProperty?: string | null;
  elevationScale?: number;
  zLift?: number;
  // ── DataFilter (deck DataFilterExtension) ──────────────────────────────────
  /**
   * Numeric column feeding the GPU column filter (`sttFilterValue`, per segment).
   * When set, the material installs the filter and each segment is gated by
   * {@link filterRange} / {@link filterSoftRange}. @default null (no filter)
   */
  filterProperty?: string | null;
  /** Inclusive `[min,max]` hard range; `null` idles the filter. @default null */
  filterRange?: DataFilterRange | null;
  /** `[min,max]` inside {@link filterRange} fading instead of hard-clipping. @default null */
  filterSoftRange?: DataFilterRange | null;
  /** Enable/disable the column filter. @default true */
  filterEnabled?: boolean;
  // time params — full-width `timeWindow` + `fadeIn/OutDuration` and the
  // lower-level `windowHalf`/`fadeIn`/`fadeOut` aliases come from
  // ThreeTimeWindowOptions.
  trailLength?: number;
  trailFade?: number;
  // ── Stable categorical colour (deck CategoryColorExtension) ────────────────
  /**
   * Opt into the GPU stable-palette path for a categorical `colorMode`. A given
   * category then renders the SAME colour in every tile (each segment of a feature
   * shares its slot) and recolouring is a palette-texture swap. Off (default) or a
   * non-categorical `colorMode` leaves the CPU colour path BYTE-IDENTICAL.
   * @default false
   */
  stableColorMapping?: boolean;
  /** Positional palette (deck `colorPalette`) for the auto/hash/order paths of
   *  {@link stableColorMapping}; ignored when `colorMode.mapping` is non-empty. */
  colorPalette?: RGBA[];
  /** Optional global category ordering for {@link stableColorMapping} (position
   *  instead of hash); ignored when `colorMode.mapping` is non-empty. */
  categoryOrder?: string[];
}

export class STTWideLineLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: WideLineMaterialBundle | null = null;
  private paletteTexture: DataTexture | null = null;
  private viewport: [number, number] = [1280, 720];
  protected readonly opts: STTWideLineLayerOptions;

  // ── GPU id-buffer pick identity (merged instance i → (tileKey, featureIndex)) ──
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  // Opt-in GPU id-buffer pick pass (lazily built on first pick; browser-verify).
  private idBundle: WideLineMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;
  /**
   * The pick kind reported for this layer — `'line'` for the wide-line / OD-line
   * family, overridden to `'path'` by the {@link STTPathGeoLayer} subclass. Protected
   * so a subclass can retag its picks without duplicating the pick machinery.
   */
  protected pickKind: STTIdPickKind = 'line';

  constructor(options: STTWideLineLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'wide-line';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  /** Host pushes the drawing-buffer size on resize so `widthPx` is true pixels. */
  setViewport(width: number, height: number): void {
    this.viewport = [width, height];
  }

  protected bufferOptions(): LineSegmentBufferOptions {
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
   * CPU-only — the texture is built once, in `ensureBundle`.
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

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const cat = this.resolveCategoryPalette();
    const buf = buildLineSegmentBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      ...this.bufferOptions(),
      categoryIndex: cat,
    });
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old feature).
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;

    this.disposeGeometry();
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
    // Stable palette: bind the per-segment category slot when it emitted one.
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

    const bundle = this.ensureBundle(cat, buf.categoryIndices.length > 0);
    this.object.geometry = geometry;
    this.object.material = bundle.material;
    this.pushUniforms(this.timeOrigin);
  }

  /** Whether the live bundle samples the stable-palette texture. */
  private bundleUsesPalette = false;

  /**
   * The material (+ its palette texture), built ONCE per variant (audit E5).
   * Every input is fixed at construction except whether the buffers carry
   * category slots, which is constant for a given palette config — so the
   * variant flips at most once. Disposing per `setTiles` evicted three's
   * `nodeBuilderCache` entry, program and pipeline: a shader rebuild per tile
   * arrival. Only the geometry churns now.
   */
  private ensureBundle(
    cat: { palette: StablePalette } | null,
    hasCategories: boolean,
  ): WideLineMaterialBundle {
    const usePalette = cat !== null && hasCategories;
    if (this.bundle && this.bundleUsesPalette === usePalette)
      return this.bundle;
    this.disposeMaterials();
    const paletteTexture = usePalette ? makePaletteTexture(cat.palette) : null;
    this.paletteTexture = paletteTexture;
    this.bundle = createWideLineMaterial({
      mode: this.opts.mode ?? 'none',
      additive: this.opts.additive,
      depthWrite: this.opts.depthWrite,
      alphaCutoff: this.opts.alphaCutoff,
      dataFilter: !!this.opts.filterProperty,
      colorPalette: paletteTexture ? { texture: paletteTexture } : undefined,
    });
    if (this.bundle.palette && cat) {
      this.bundle.palette.invWidth.value = 1 / cat.palette.colors.length;
    }
    this.bundleUsesPalette = usePalette;
    return this.bundle;
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    this.pushUniforms(absoluteTimeMs);
  }

  /** The uniform values for the given playhead — shared by the colour render and
   *  the id-pass so the pick pass gates on the SAME window/trail/filter + width. */
  private uniformValues(absoluteTimeMs: number): WideLineUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        ...resolveTimeWindow(this.opts, 0),
        trailLength: this.opts.trailLength ?? 0,
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

  // ── Picking (GPU id-buffer catalog: wide-line family variant) ──────────────

  /**
   * Resolve a merged instance index (as decoded from a GPU id-buffer readback) to
   * a normalised {@link STTIdPickInfo}, or `null` for a miss. The `kind` is
   * {@link pickKind} (`'line'`, or `'path'` for the {@link STTPathGeoLayer} subclass);
   * the coordinate is the feature's FIRST vertex (indexed geometry). Pure — the
   * unit-tested seam; call it directly with a decoded index.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: this.pickKind,
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-instance `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createWideLineIdMaterial({
        mode: this.opts.mode ?? 'none',
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
   * GPU wide-line pick — auto-registered into the r3f `PickController` (a CPU box
   * miss falls through to this). Renders this layer's ribbons with the flat id
   * material into `picker`'s off-screen target, reads back the merged-instance id
   * at CSS pixel `(cssX, cssY)`, and resolves it through the provenance buffer.
   * The `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify. The id material reuses the SAME vertex-stage
   * width-collapse gate (time window / trail + column filter), so only segments
   * drawn THIS frame are pickable, at their true screen ribbon.
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
    // segments visible THIS frame are pickable, at their true screen ribbon.
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

  /** Release the geometry (and the per-geometry pick attribute flag) only. */
  private disposeGeometry(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.idColorsPresent = false;
  }

  private disposeMaterials(): void {
    this.bundle?.material.dispose();
    this.bundle = null;
    this.idBundle?.material.dispose();
    this.idBundle = null;
    this.paletteTexture?.dispose();
    this.paletteTexture = null;
  }

  private disposeGpu(): void {
    this.disposeGeometry();
    this.disposeMaterials();
  }

  dispose(): void {
    this.disposeGpu();
  }
}
