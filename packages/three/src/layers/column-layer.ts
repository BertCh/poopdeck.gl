// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTColumnLayer` — extruded 3D columns (bars / prisms) at point features, the
 * Three port of deck's `AnimatedColumnLayer`. Each Point feature becomes one
 * instance of a shared unit prism (`diskResolution` sides, see
 * `geometry/column-prism.ts`), scaled by a metric `radius` + a per-feature HEIGHT
 * (a numeric column × `elevationScale`), oriented to the local ground frame
 * (`projection.localFrame`, so columns stand up on the globe too), coloured per
 * feature (categorical / ramp / constant), lit by {@link createColumnMaterial},
 * and optionally window time-filtered.
 *
 * RTC: all tiles merge into one instanced buffer whose BASE positions are relative
 * to a shared `origin`, written to `object.position` so large mercator/globe
 * magnitudes stay in the f64 CPU transform (no-op for the AV ENU frame). Unlocks
 * the earthquake-columns demo (magnitude → height, depth → colour ramp).
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
import { makeColumnPrismGeometry } from '../geometry/column-prism.js';
import {
  buildColumnBuffers,
  type ColumnColorMode,
  type ColumnBufferOptions,
} from '../lib/column-buffers.js';
import {
  createColumnMaterial,
  createColumnIdMaterial,
  updateColumnUniforms,
  type ColumnMaterialBundle,
  type ColumnUniformValues,
} from '../tsl/column-material.js';
import type { TimeFilterParams } from '../tsl/time-filter-math.js';
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

export interface STTColumnLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  colorMode: ColumnColorMode;
  /** Disk faces (deck `diskResolution`). @default 20 */
  diskResolution?: number;
  /** Disk rotation (deck `angle`), CCW degrees. @default 0 */
  angle?: number;
  /** Disk incircle radius in true metres. @default 100 */
  radius?: number;
  /** Numeric column driving per-feature height (metres). @default null */
  elevationProperty?: string | null;
  /** Constant height (metres) when `elevationProperty` is absent. @default 1000 */
  defaultElevation?: number;
  /** Multiplier on every height. @default 1 */
  elevationScale?: number;
  /** Base-altitude column (metres) lifting the column foot. */
  baseElevationProperty?: string | null;
  /** Constant base-altitude lift (metres). @default 0 */
  zLift?: number;
  /** Apply the window time-filter. @default true */
  timeFiltered?: boolean;
  /** Translucent columns (lets the time window fade). @default false */
  transparent?: boolean;
  opacity?: number;
  alphaCutoff?: number;
  // ── DataFilter (deck DataFilterExtension) ──────────────────────────────────
  /**
   * Numeric column feeding the GPU column filter (`sttFilterValue`, per column).
   * When set, the material installs the filter and each prism is gated by
   * {@link filterRange} / {@link filterSoftRange}. @default null (no filter)
   */
  filterProperty?: string | null;
  /** Inclusive `[min,max]` hard range; `null` idles the filter. @default null */
  filterRange?: DataFilterRange | null;
  /** `[min,max]` inside {@link filterRange} fading instead of hard-clipping. @default null */
  filterSoftRange?: DataFilterRange | null;
  /** Enable/disable the column filter. @default true */
  filterEnabled?: boolean;
  // ── Time-as-height / space-time cube (deck timeHeightScale) ────────────────
  /**
   * Time-as-height ("space-time cube") lift — metres of altitude per simulation
   * millisecond. When set (including 0), the material installs the lift path and
   * raises each prism's foot along local up by
   * `(featureStart − timeHeightOrigin) × timeHeightScale` metres via a single
   * scale uniform (animating flat⇄cube is free). `null`/omitted ⇒ flat,
   * byte-identical to today. @default null (off)
   */
  timeHeightScale?: number | null;
  /**
   * Absolute time (epoch-ms) mapped to altitude 0 in time-as-height mode,
   * typically the dataset `timeRange.start`. Relativized against the layer
   * `timeOrigin` on the CPU, like every other time here. @default 0
   */
  timeHeightOrigin?: number;
  // ── Stable categorical colour (deck CategoryColorExtension) ────────────────
  /**
   * Opt into the GPU stable-palette path for a categorical `colorMode`. A given
   * category then renders the SAME colour in every tile (instead of the per-tile
   * first-seen CPU expansion), and recolouring is a single palette-texture swap.
   * Any of an explicit `colorMode.mapping`, a {@link categoryOrder}, or a stable
   * hash of the label assigns the slot. Off (default) or a non-categorical
   * `colorMode` leaves the CPU colour path BYTE-IDENTICAL. @default false
   */
  stableColorMapping?: boolean;
  /**
   * Positional palette (deck `colorPalette`) for the auto / hash / order paths of
   * {@link stableColorMapping}; ignored when `colorMode.mapping` is non-empty.
   * Defaults to the shared categorical palette.
   */
  colorPalette?: RGBA[];
  /**
   * Optional global category ordering (an archive/global category list) for
   * {@link stableColorMapping}: a label takes its position here instead of a hash,
   * for a known category space. Ignored when `colorMode.mapping` is non-empty.
   */
  categoryOrder?: string[];
  // window time params — full-width `timeWindow` + `fadeIn/OutDuration` and the
  // lower-level `windowHalf`/`fadeIn`/`fadeOut` aliases come from
  // ThreeTimeWindowOptions.
}

export class STTColumnLayer extends BaseSttLayer implements SttIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  private bundle: ColumnMaterialBundle | null = null;
  private paletteTexture: DataTexture | null = null;
  protected readonly opts: STTColumnLayerOptions;

  // ── GPU id-buffer pick identity (merged instance i → (tileKey, featureIndex)) ──
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  // Opt-in GPU id-buffer pick pass (lazily built on first pick; browser-verify).
  private idBundle: ColumnMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  constructor(options: STTColumnLayerOptions) {
    super();
    this.opts = options;
    this.id = options.id ?? 'columns';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  protected bufferOptions(): ColumnBufferOptions {
    return {
      colorMode: this.opts.colorMode,
      elevationProperty: this.opts.elevationProperty ?? null,
      defaultElevation: this.opts.defaultElevation ?? 1000,
      elevationScale: this.opts.elevationScale ?? 1,
      radius: this.opts.radius ?? 100,
      baseElevationProperty: this.opts.baseElevationProperty ?? null,
      zLift: this.opts.zLift ?? 0,
      filterProperty: this.opts.filterProperty ?? null,
      timeHeight: this.opts.timeHeightScale != null,
    };
  }

  /**
   * Resolve the GPU stable-palette path (property + palette) when
   * `stableColorMapping` is on AND the colour mode is categorical; else null (the
   * byte-identical CPU colour path). CPU-only — the palette TEXTURE is built after
   * `disposeGpu` in `setTiles`, mirroring icon-layer's glide texture.
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
    const buf = buildColumnBuffers(tiles, ctx.projection, ctx.timeOrigin, {
      ...this.bufferOptions(),
      categoryIndex: cat,
    });
    // Adopt the fresh pick-identity buffers (empty when count === 0, so a stale
    // pick after a reload resolves to null rather than an old feature).
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;

    this.disposeGpu();
    if (buf.count === 0) {
      this.object.geometry = makeColumnPrismGeometry(
        this.opts.diskResolution ?? 20,
        ((this.opts.angle ?? 0) * Math.PI) / 180,
      ).geometry;
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    const { geometry } = makeColumnPrismGeometry(
      this.opts.diskResolution ?? 20,
      ((this.opts.angle ?? 0) * Math.PI) / 180,
    );
    geometry.instanceCount = buf.count;
    geometry.setAttribute(
      'sttBase',
      new InstancedBufferAttribute(buf.bases, 3),
    );
    geometry.setAttribute(
      'sttBasisX',
      new InstancedBufferAttribute(buf.basisX, 3),
    );
    geometry.setAttribute(
      'sttBasisY',
      new InstancedBufferAttribute(buf.basisY, 3),
    );
    geometry.setAttribute(
      'sttBasisZ',
      new InstancedBufferAttribute(buf.basisZ, 3),
    );
    geometry.setAttribute(
      'sttColor',
      new InstancedBufferAttribute(buf.colors, 4),
    );
    geometry.setAttribute(
      'sttStart',
      new InstancedBufferAttribute(buf.starts, 1),
    );
    geometry.setAttribute('sttEnd', new InstancedBufferAttribute(buf.ends, 1));
    // DataFilter: bind the per-column filter value when a filterProperty emitted one.
    if (buf.filterValues.length > 0) {
      geometry.setAttribute(
        'sttFilterValue',
        new InstancedBufferAttribute(buf.filterValues, 1),
      );
    }
    // Time-as-height: bind the per-instance lift direction when timeHeight emitted it.
    if (buf.lift.length > 0) {
      geometry.setAttribute(
        'sttLift',
        new InstancedBufferAttribute(buf.lift, 3),
      );
    }
    // Stable palette: bind the per-instance category slot when it emitted one.
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

    this.bundle = createColumnMaterial({
      timeFiltered: this.opts.timeFiltered ?? true,
      transparent: this.opts.transparent ?? false,
      alphaCutoff: this.opts.alphaCutoff,
      dataFilter: !!this.opts.filterProperty,
      timeHeight: this.opts.timeHeightScale != null,
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
   *  the id-pass so the pick pass gates on the SAME time / filter / lift. */
  private uniformValues(absoluteTimeMs: number): ColumnUniformValues {
    const params: TimeFilterParams = resolveTimeWindow(this.opts, 0);
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params,
      opacity: this.opts.opacity ?? 1,
      dataFilter: {
        filterEnabled: this.opts.filterEnabled,
        filterRange: this.opts.filterRange ?? null,
        filterSoftRange: this.opts.filterSoftRange ?? null,
      },
      timeHeight:
        this.opts.timeHeightScale != null
          ? {
              heightScale: this.opts.timeHeightScale,
              // Relativize the absolute origin against the layer timeOrigin so
              // (start − heightOrigin) stays f32-exact, matching deck.
              heightOrigin: (this.opts.timeHeightOrigin ?? 0) - this.timeOrigin,
            }
          : undefined,
    };
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updateColumnUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: column variant) ────────────────────────

  /**
   * Resolve a merged instance index (as decoded from a GPU id-buffer readback)
   * to a normalised {@link SttIdPickInfo} (`kind: 'column'`), or `null` for a
   * miss. Pure — the unit-tested seam; call it directly with a decoded index.
   */
  resolvePick(index: number, screen?: [number, number]): SttIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'column',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + per-instance `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createColumnIdMaterial({
        timeFiltered: this.opts.timeFiltered ?? true,
        dataFilter: !!this.opts.filterProperty,
        timeHeight: this.opts.timeHeightScale != null,
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
   * GPU column pick — auto-registered into the r3f `PickController` (a CPU box
   * miss falls through to this). Renders this layer's prisms with the flat id
   * material into `picker`'s off-screen target, reads back the merged-instance id
   * at CSS pixel `(cssX, cssY)`, and resolves it through the provenance buffer.
   * The `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify per the package's test policy. The id material
   * reuses the SAME vertex collapse gates (time-filter + column-filter +
   * time-as-height lift), so only prisms drawn THIS frame are pickable, at their
   * animated (lifted) position.
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
    // Sync the id material's gates to the live playhead so only prisms visible
    // THIS frame are pickable, at their animated position.
    updateColumnUniforms(idBundle, this.uniformValues(this.currentTimeMs));

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
