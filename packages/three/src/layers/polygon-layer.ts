// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTPolygonLayer` — filled polygon meshes, the Three port of the deck
 * `AnimatedPolygonLayer` (and its static `map_poly` ancestor). It merges every
 * polygon feature across the resident tiles into ONE indexed mesh via the pure
 * {@link buildPolygonBuffers} builder, then shades it with a single
 * {@link createPolygonMaterial} node material:
 *
 *   • TESSELLATION — honours a tile's pre-baked `triangles`/`triangleOffsets`
 *     (the columnar.rs multi-ring / hole fix) when present, else earcut-
 *     tessellates each feature's ring **in projected/planar space** (raw lon/lat
 *     earcut is wrong under mercator/globe).
 *   • TIME WINDOW — in `window` mode each vertex carries its feature's
 *     `[start,end]` and the material fades the polygon in/out around the playhead
 *     (storms / wildfires / osm). `none` mode is the shipped static AV map-decal
 *     behaviour, byte-identical (constant alpha, no filter).
 *   • EXTRUSION — an optional numeric column raises each feature to a 3D prism
 *     (cap + side walls), sized in true metres at any latitude.
 *   • RTC — positions are f32 relative to a per-build origin; the layer sets
 *     `object.position = origin` so large mercator/globe magnitudes stay in the
 *     f64 CPU transform.
 *
 * {@link STTStaticPolygonLayer} is a thin back-compat wrapper preserving the old
 * AV map-poly API (categorical `map_layer` colouring, flat, no time filter).
 */

import {
  Group,
  Mesh,
  BufferGeometry,
  Float32BufferAttribute,
  Uint32BufferAttribute,
} from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { InstanceProvenance } from '@poopdeck.gl/core/picking';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { type RGBA } from '../lib/color.js';
import {
  buildPolygonBuffers,
  type PolygonColorMode,
  type PolygonBufferOptions,
} from './polygon-buffers.js';
import {
  createPolygonMaterial,
  createPolygonIdMaterial,
  updatePolygonUniforms,
  type PolygonMaterialBundle,
  type PolygonTimeMode,
  type PolygonUniformValues,
} from '../tsl/polygon-material.js';
import type { DataFilterOptions, DataFilterRange } from '../tsl/data-filter.js';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

export interface STTPolygonLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** How each feature is coloured. @default constant grey */
  colorMode?: PolygonColorMode;
  /** Time-filter mode. @default 'none' (static) */
  mode?: PolygonTimeMode;
  // `window` mode: full-width `timeWindow` + `fadeIn/OutDuration` and the
  // lower-level `windowHalf` (@default 500) / `fadeIn` / `fadeOut` aliases come
  // from ThreeTimeWindowOptions.
  /** Height above ground for flat fills (metres). @default 0.02 */
  zLift?: number;
  /** Numeric column extruding each feature into a 3D prism (metres). @default null */
  extrusionProperty?: string | null;
  /** Multiplier on extrusion height + geometry z. @default 1 */
  elevationScale?: number;
  /** Write depth (extruded prisms usually want this). @default false */
  depthWrite?: boolean;
  opacity?: number;
  // ── DataFilter (deck DataFilterExtension) ──────────────────────────────────
  /**
   * Numeric column feeding the GPU column filter (`sttFilterValue`, per vertex —
   * a feature's value written to every one of its mesh vertices). When set, the
   * material installs the filter and each feature is gated by {@link filterRange}
   * / {@link filterSoftRange} (composes with `window` mode). @default null (no filter)
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
   * raises each feature along local up by
   * `(featureStart − timeHeightOrigin) × timeHeightScale` metres via a single
   * scale uniform (animating flat⇄cube is free; composes with `window` mode).
   * `null`/omitted ⇒ flat, byte-identical to today. @default null (off)
   */
  timeHeightScale?: number | null;
  /**
   * Absolute time (epoch-ms) mapped to altitude 0, typically the dataset
   * `timeRange.start`. Relativized against the layer `timeOrigin` on the CPU.
   * @default 0
   */
  timeHeightOrigin?: number;
}

const DEFAULT_COLOR: RGBA = [120, 130, 150, 90];

export class STTPolygonLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Group();
  private mesh: Mesh;
  private bundle: PolygonMaterialBundle;

  // ── GPU id-buffer pick identity (merged feature m → (tileKey, featureIndex)) ──
  // Polygon is a MERGED mesh, so unlike the instanced kinds the id is a per-vertex
  // attribute (`idColors`, from the builder); provenance is per emitted feature.
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  private idColors: Float32Array = new Float32Array(0);
  // Opt-in GPU id-buffer pick pass (lazily built on first pick; browser-verify).
  private idBundle: PolygonMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  private readonly opts: Required<
    Omit<
      STTPolygonLayerOptions,
      'id' | 'timeWindow' | 'fadeInDuration' | 'fadeOutDuration'
    >
  >;

  constructor(options: STTPolygonLayerOptions = {}) {
    super();
    this.id = options.id ?? 'polygons';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    const tw = resolveTimeWindow(options, 500);
    this.opts = {
      colorMode: options.colorMode ?? {
        type: 'constant',
        color: DEFAULT_COLOR,
      },
      mode: options.mode ?? 'none',
      windowHalf: tw.windowHalf,
      fadeIn: tw.fadeIn,
      fadeOut: tw.fadeOut,
      zLift: options.zLift ?? 0.02,
      extrusionProperty: options.extrusionProperty ?? null,
      elevationScale: options.elevationScale ?? 1,
      depthWrite: options.depthWrite ?? false,
      opacity: options.opacity ?? 1,
      filterProperty: options.filterProperty ?? null,
      filterRange: options.filterRange ?? null,
      filterSoftRange: options.filterSoftRange ?? null,
      filterEnabled: options.filterEnabled ?? true,
      timeHeightScale: options.timeHeightScale ?? null,
      timeHeightOrigin: options.timeHeightOrigin ?? 0,
    };
    this.bundle = createPolygonMaterial({
      mode: this.opts.mode,
      depthWrite: this.opts.depthWrite,
      dataFilter: !!this.opts.filterProperty,
      timeHeight: this.opts.timeHeightScale != null,
    });
    this.mesh = new Mesh(new BufferGeometry(), this.bundle.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.object.add(this.mesh);
  }

  /** Deck-shaped column-filter props (a no-op push unless a filter is installed). */
  private dataFilterOpts(): DataFilterOptions {
    return {
      filterEnabled: this.opts.filterEnabled,
      filterRange: this.opts.filterRange,
      filterSoftRange: this.opts.filterSoftRange,
    };
  }

  /**
   * Time-as-height lift params (a no-op push unless the lift is installed).
   * `heightOrigin` is relativized against the layer `timeOrigin` so
   * `(start − heightOrigin)` stays f32-exact, matching deck.
   */
  private timeHeightOpts():
    | { heightScale: number; heightOrigin: number }
    | undefined {
    return this.opts.timeHeightScale != null
      ? {
          heightScale: this.opts.timeHeightScale,
          heightOrigin: this.opts.timeHeightOrigin - this.timeOrigin,
        }
      : undefined;
  }

  /** The uniform values for the given playhead — shared by the fill render and the
   *  id-pass so the pick pass gates on the SAME window / filter / lift. */
  private uniformValues(absoluteTimeMs: number): PolygonUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        windowHalf: this.opts.windowHalf,
        fadeIn: this.opts.fadeIn,
        fadeOut: this.opts.fadeOut,
      },
      opacity: this.opts.opacity,
      dataFilter: this.dataFilterOpts(),
      timeHeight: this.timeHeightOpts(),
    };
  }

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const bufOpts: PolygonBufferOptions = {
      colorMode: this.opts.colorMode,
      zLift: this.opts.zLift,
      extrusionProperty: this.opts.extrusionProperty,
      elevationScale: this.opts.elevationScale,
      filterProperty: this.opts.filterProperty,
      timeHeight: this.opts.timeHeightScale != null,
    };
    const buf = buildPolygonBuffers(
      tiles,
      ctx.projection,
      ctx.timeOrigin,
      bufOpts,
    );
    // Adopt the fresh pick-identity buffers (empty when vertexCount === 0, so a
    // stale pick after a reload resolves to null rather than an old feature). The
    // per-vertex id colours are set lazily on the new geometry in ensurePickPass.
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;
    this.idColors = buf.idColors;
    this.idColorsPresent = false;

    this.mesh.geometry.dispose();
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(buf.positions, 3));
    geom.setAttribute('sttColor', new Float32BufferAttribute(buf.colors, 4));
    geom.setAttribute('sttStart', new Float32BufferAttribute(buf.starts, 1));
    geom.setAttribute('sttEnd', new Float32BufferAttribute(buf.ends, 1));
    // DataFilter: bind the per-vertex filter value when a filterProperty emitted
    // one (non-instanced, so the merged mesh's `sttFilterValue` is per vertex).
    if (buf.filterValues.length > 0) {
      geom.setAttribute(
        'sttFilterValue',
        new Float32BufferAttribute(buf.filterValues, 1),
      );
    }
    // Time-as-height: bind the per-vertex lift direction when timeHeight emitted it.
    if (buf.lift.length > 0) {
      geom.setAttribute('sttLift', new Float32BufferAttribute(buf.lift, 3));
    }
    geom.setIndex(new Uint32BufferAttribute(buf.indices, 1));
    geom.computeBoundingSphere();
    this.mesh.geometry = geom;

    // RTC: the large mercator/globe magnitude lives in the f64 CPU transform.
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);
    this.mesh.visible = buf.indices.length > 0;

    // Seed the uniforms so the static (`none`) path is correct before any frame.
    updatePolygonUniforms(this.bundle, this.uniformValues(ctx.timeOrigin));
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    updatePolygonUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: polygon variant — MERGED mesh) ───────────

  /**
   * Resolve a decoded merged-FEATURE index (from a GPU id-buffer readback) to a
   * normalised {@link STTIdPickInfo} (`kind: 'polygon'`), or `null` for a miss.
   * The coordinate is the feature's FIRST source vertex (`startIndices[i]`, the
   * standard indexed-geometry path — polygons always carry `startIndices`). Pure —
   * the unit-tested seam; call it directly with a decoded index.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'polygon',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + set the per-vertex `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createPolygonIdMaterial({
        mode: this.opts.mode,
        dataFilter: !!this.opts.filterProperty,
        timeHeight: this.opts.timeHeightScale != null,
      });
    }
    if (!this.idColorsPresent && this.idColors.length > 0) {
      // Per-vertex id colours (each vertex of a feature shares its merged-index
      // colour) — the merged-mesh analogue of the instanced `buildIdColors`.
      this.mesh.geometry.setAttribute(
        'sttIdColor',
        new Float32BufferAttribute(this.idColors, 3),
      );
      this.idColorsPresent = true;
    }
  }

  /**
   * GPU polygon pick — auto-registered into the r3f `PickController` (a CPU box
   * miss falls through to this). Renders the merged fill with the flat id material
   * into `picker`'s off-screen target, reads back the merged FEATURE id at CSS
   * pixel `(cssX, cssY)`, and resolves it through the provenance buffer. The
   * `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify. The id material reuses the SAME vertex-stage
   * collapse gates (window + column-filter + time-as-height lift), so only fills
   * drawn THIS frame are pickable, at their animated (lifted) position. The pick
   * renders the parent `object` (Group) so its RTC origin transform is applied,
   * swapping only the child mesh's material.
   */
  async pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<STTIdPickInfo | null> {
    if (this.provenance.length === 0 || !this.mesh.visible) return null;
    this.ensurePickPass();
    const idBundle = this.idBundle;
    if (!idBundle) return null;
    // Sync the id material's gates to the live playhead so only fills visible THIS
    // frame are pickable, at their animated position.
    updatePolygonUniforms(idBundle, this.uniformValues(this.currentTimeMs));

    const mesh = this.mesh;
    const renderMaterial = mesh.material;
    const index = await picker.pick(this.object, camera, cssX, cssY, {
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

  dispose(): void {
    this.mesh.geometry.dispose();
    this.bundle.material.dispose();
    this.idBundle?.material.dispose();
    this.idBundle = null;
    this.idColorsPresent = false;
  }
}

// ── Back-compat: the shipped AV map-poly layer ─────────────────────────────────

export interface STTStaticPolygonLayerOptions {
  id?: string;
  colorProperty?: string;
  colorMapping?: Record<string, RGBA>;
  colorMappingDefault?: RGBA;
  /** Height above ground (metres). @default 0.02 */
  zLift?: number;
  opacity?: number;
}

/**
 * The original flat, static, categorically-coloured AV `map_poly` layer
 * (drivable area / lanes / crosswalks). Now a thin preset over {@link STTPolygonLayer}
 * (`mode:'none'`, categorical colour by `map_layer`) so the shipped cockpit keeps
 * working unchanged.
 */
export class STTStaticPolygonLayer extends STTPolygonLayer {
  constructor(options: STTStaticPolygonLayerOptions = {}) {
    super({
      id: options.id ?? 'map-poly',
      mode: 'none',
      colorMode: {
        type: 'categorical',
        property: options.colorProperty ?? 'map_layer',
        mapping: options.colorMapping ?? {},
        fallback: options.colorMappingDefault ?? [120, 130, 150, 90],
      },
      zLift: options.zLift ?? 0.02,
      opacity: options.opacity ?? 1,
    });
  }
}
