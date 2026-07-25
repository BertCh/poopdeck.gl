// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `SttIsoLayer` — animated density iso-lines, the Three port of the deck AV
 * `lidarIso` / `lidarIso3d` modes (`AnimatedPathLayer` over windowed contour
 * LineStrings). Each contour is split into `LineSegments` with per-vertex time
 * (`sttStart` / `sttEnd`) and colour (`sttColor`, the `density_band` ramp), and a
 * window-filtered {@link createIsoLineMaterial} fades it in/out around the
 * playhead. For iso3d, each ring is lifted to its real altitude via a numeric
 * `z_layer` column. Built once in {@link setTiles}; only the time uniform moves
 * per frame.
 */

import {
  Group,
  LineSegments,
  BufferGeometry,
  Float32BufferAttribute,
} from 'three';
import type { Tile, BinaryFeatures } from '@poopdeck.gl/core';
import { GeometryType } from '@poopdeck.gl/core';
import { InstanceProvenance, encodePickId } from '@poopdeck.gl/core/picking';
import { BaseSttLayer, type SttLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { resolveCategoryColor, type RGBA } from '../lib/color.js';
import {
  createIsoLineMaterial,
  createIsoLineIdMaterial,
  updateIsoLineUniforms,
  type IsoLineMaterialBundle,
  type IsoLineUniformValues,
} from '../tsl/iso-line-material.js';
import {
  resolveIdPick,
  featureTileKey,
  type SttIdPickInfo,
  type SttIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

export interface STTIsoLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** Categorical property selecting the contour colour. @default 'density_band' */
  colorProperty?: string;
  colorMapping?: Record<string, RGBA>;
  colorMappingDefault?: RGBA;
  /** Numeric column lifting each contour to a real altitude (iso3d). @default null */
  elevationProperty?: string | null;
  /** Multiplier on the elevation column (metres). @default 1 */
  elevationScale?: number;
  /** Height above ground for the flat (non-iso3d) case (metres). @default 0.05 */
  zLift?: number;
  // Full-width `timeWindow` + `fadeIn/OutDuration` and the lower-level
  // `windowHalf` (@default 130) / `fadeIn` / `fadeOut` aliases come from
  // ThreeTimeWindowOptions.
  opacity?: number;
}

const DEFAULT_COLOR: RGBA = [120, 200, 255, 220];

export class STTIsoLayer extends BaseSttLayer implements SttIdPickable {
  readonly id: string;
  readonly object = new Group();
  private lines: LineSegments;
  private bundle: IsoLineMaterialBundle;

  // ── GPU id-buffer pick identity (merged contour m → (tileKey, featureIndex)) ──
  // Iso is a MERGED `LineSegments` mesh, so — like polygon — the id is a per-vertex
  // attribute (`idColors`, painted both endpoints of each of a contour's segments);
  // provenance is per emitted contour.
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  private idColors = new Float32Array(0);
  // Opt-in GPU id-buffer pick pass (lazily built on first pick; browser-verify).
  private idBundle: IsoLineMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  private readonly opts: Required<
    Omit<
      STTIsoLayerOptions,
      'id' | 'timeWindow' | 'fadeInDuration' | 'fadeOutDuration'
    >
  >;

  constructor(options: STTIsoLayerOptions = {}) {
    super();
    this.id = options.id ?? 'iso';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    const tw = resolveTimeWindow(options, 130);
    this.opts = {
      colorProperty: options.colorProperty ?? 'density_band',
      colorMapping: options.colorMapping ?? {},
      colorMappingDefault: options.colorMappingDefault ?? DEFAULT_COLOR,
      elevationProperty: options.elevationProperty ?? null,
      elevationScale: options.elevationScale ?? 1,
      zLift: options.zLift ?? 0.05,
      windowHalf: tw.windowHalf,
      fadeIn: tw.fadeIn,
      fadeOut: tw.fadeOut,
      opacity: options.opacity ?? 0.95,
    };
    this.bundle = createIsoLineMaterial();
    this.lines = new LineSegments(new BufferGeometry(), this.bundle.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.object.add(this.lines);
  }

  setTiles(tiles: Tile[], ctx: SttLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const proj = ctx.projection;

    // Fresh pick identity (adopted below; empty when there are no contours, so a
    // stale pick after a reload resolves to null rather than an old contour).
    const provenance = new InstanceProvenance();
    const binaryByTileKey = new Map<string, BinaryFeatures>();

    // Pass 1 — count segments + carry each layer's provenance key.
    let segCount = 0;
    const lineLayers: Array<{ b: BinaryFeatures; tileKey: string }> = [];
    for (const tile of tiles) {
      for (const tl of tile.layers) {
        const b = tl.features;
        if (
          !b.featureCount ||
          b.geometryType !== GeometryType.LineString ||
          !b.startIndices
        )
          continue;
        lineLayers.push({ b, tileKey: featureTileKey(tile.id, tl.name) });
        for (let f = 0; f < b.featureCount; f++) {
          segCount += Math.max(
            0,
            b.startIndices[f + 1] - b.startIndices[f] - 1,
          );
        }
      }
    }

    const positions = new Float32Array(segCount * 2 * 3);
    const colors = new Float32Array(segCount * 2 * 4);
    const starts = new Float32Array(segCount * 2);
    const ends = new Float32Array(segCount * 2);
    // Per-vertex GPU pick id colour (both endpoints of every segment of a contour
    // share the contour's merged-index colour). Merged-mesh analogue of the
    // instanced `buildIdColors`.
    const idColors = new Float32Array(segCount * 2 * 3);
    let p = 0; // position cursor (×3)
    let c = 0; // color cursor (×4)
    let t = 0; // time cursor (×1)
    let ic = 0; // id-colour cursor (×3)

    for (const { b, tileKey } of lineLayers) {
      binaryByTileKey.set(tileKey, b);
      const dims = b.positionDimensions ?? 2;
      const cat = b.categoricalProps[this.opts.colorProperty];
      const elev = this.opts.elevationProperty
        ? b.numericProps[this.opts.elevationProperty]
        : undefined;
      const rebase = b.timeOffset - this.timeOrigin;

      for (let f = 0; f < b.featureCount; f++) {
        const v0 = b.startIndices![f];
        const v1 = b.startIndices![f + 1];
        // A contour with < 2 vertices emits no segment → never takes a pick slot,
        // so `provenance` and `idColors` stay aligned with the vertices written.
        if (v1 - v0 < 2) continue;

        // Per-contour colour (straight, NOT premultiplied — alpha varies per frame).
        const label =
          cat && cat.indices[f] !== 0xffff
            ? cat.categories[cat.indices[f]]
            : undefined;
        const rgba = resolveCategoryColor(
          label,
          this.opts.colorMapping,
          this.opts.colorMappingDefault,
        );
        const cr = rgba[0] / 255;
        const cg = rgba[1] / 255;
        const cb = rgba[2] / 255;
        const ca = (rgba[3] ?? 255) / 255;

        // Take this contour's merged pick slot + encode it once — both endpoints of
        // every segment below carry this colour. Pushed in emit order.
        const mergedFeatureIndex = provenance.length;
        provenance.push(tileKey, f);
        const [ir, ig, ib] = encodePickId(mergedFeatureIndex);
        const idR = ir / 255;
        const idG = ig / 255;
        const idB = ib / 255;

        // Per-contour time window (all vertices share it).
        const start = (b.startTimes ? b.startTimes[f] : 0) + rebase;
        const end = (b.endTimes ? b.endTimes[f] : 0) + rebase;

        // iso3d lifts the whole ring to its slab altitude; flat iso uses geom z.
        const baseZ = elev ? elev[f] * this.opts.elevationScale : null;

        for (let v = v0; v < v1 - 1; v++) {
          const lon0 = b.positions[v * dims];
          const lat0 = b.positions[v * dims + 1];
          const lon1 = b.positions[(v + 1) * dims];
          const lat1 = b.positions[(v + 1) * dims + 1];
          const z0 =
            (baseZ ?? (dims > 2 ? b.positions[v * dims + 2] : 0)) +
            this.opts.zLift;
          const z1 =
            (baseZ ?? (dims > 2 ? b.positions[(v + 1) * dims + 2] : 0)) +
            this.opts.zLift;
          const a0 = proj.project(lon0, lat0, z0);
          const a1 = proj.project(lon1, lat1, z1);
          positions[p] = a0[0];
          positions[p + 1] = a0[1];
          positions[p + 2] = a0[2];
          positions[p + 3] = a1[0];
          positions[p + 4] = a1[1];
          positions[p + 5] = a1[2];
          p += 6;
          colors[c] = cr;
          colors[c + 1] = cg;
          colors[c + 2] = cb;
          colors[c + 3] = ca;
          colors[c + 4] = cr;
          colors[c + 5] = cg;
          colors[c + 6] = cb;
          colors[c + 7] = ca;
          c += 8;
          starts[t] = start;
          starts[t + 1] = start;
          ends[t] = end;
          ends[t + 1] = end;
          t += 2;
          idColors[ic] = idR;
          idColors[ic + 1] = idG;
          idColors[ic + 2] = idB;
          idColors[ic + 3] = idR;
          idColors[ic + 4] = idG;
          idColors[ic + 5] = idB;
          ic += 6;
        }
      }
    }

    // Adopt the fresh pick identity; the per-vertex id colours are uploaded lazily
    // onto the new geometry in ensurePickPass.
    this.provenance = provenance;
    this.binaryByTileKey = binaryByTileKey;
    this.idColors = idColors;
    this.idColorsPresent = false;

    this.lines.geometry.dispose();
    const geom = new BufferGeometry();
    geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geom.setAttribute('sttColor', new Float32BufferAttribute(colors, 4));
    geom.setAttribute('sttStart', new Float32BufferAttribute(starts, 1));
    geom.setAttribute('sttEnd', new Float32BufferAttribute(ends, 1));
    geom.computeBoundingSphere();
    this.lines.geometry = geom;
    this.lines.visible = segCount > 0; // no 0-vertex draw when there are no contours
  }

  /** The uniform values for the given playhead — shared by the contour render and
   *  the id-pass so the pick pass gates on the SAME time window. */
  private uniformValues(absoluteTimeMs: number): IsoLineUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: {
        windowHalf: this.opts.windowHalf,
        fadeIn: this.opts.fadeIn,
        fadeOut: this.opts.fadeOut,
      },
      opacity: this.opts.opacity,
    };
  }

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    updateIsoLineUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  // ── Picking (GPU id-buffer catalog: iso variant — MERGED LineSegments mesh) ──

  /**
   * Resolve a decoded merged-CONTOUR index (from a GPU id-buffer readback) to a
   * normalised {@link SttIdPickInfo} (`kind: 'iso'`), or `null` for a miss. The
   * coordinate is the contour's FIRST source vertex (`startIndices[i]`, the
   * standard indexed-geometry path — iso contours are LineStrings, always with
   * `startIndices`). Pure — the unit-tested seam; call it directly.
   */
  resolvePick(index: number, screen?: [number, number]): SttIdPickInfo | null {
    return resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'iso',
      layerId: this.id,
      screen,
    });
  }

  /** Lazily build the id material + set the per-vertex `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createIsoLineIdMaterial();
    }
    if (!this.idColorsPresent && this.idColors.length > 0) {
      this.lines.geometry.setAttribute(
        'sttIdColor',
        new Float32BufferAttribute(this.idColors, 3),
      );
      this.idColorsPresent = true;
    }
  }

  /**
   * GPU iso pick — auto-registered into the r3f `PickController` (a CPU box miss
   * falls through to this). Renders the merged contours with the flat id material
   * into `picker`'s off-screen target, reads back the merged CONTOUR id at CSS
   * pixel `(cssX, cssY)`, and resolves it through the provenance buffer. The
   * `resolvePick` half is unit-tested; the render + readback needs a live GPU
   * device and is browser-verify. The id material reuses the SAME window
   * collapse gate, so only contours drawn THIS frame are pickable. The pick
   * renders the parent `object` (Group) and swaps only the child mesh's material.
   */
  async pick(
    picker: GpuPicker,
    camera: unknown,
    cssX: number,
    cssY: number,
  ): Promise<SttIdPickInfo | null> {
    if (this.provenance.length === 0 || !this.lines.visible) return null;
    this.ensurePickPass();
    const idBundle = this.idBundle;
    if (!idBundle) return null;
    // Sync the id material's window gate to the live playhead so only contours
    // visible THIS frame are pickable.
    updateIsoLineUniforms(idBundle, this.uniformValues(this.currentTimeMs));

    const lines = this.lines;
    const renderMaterial = lines.material;
    const index = await picker.pick(this.object, camera, cssX, cssY, {
      featureCount: this.provenance.length,
      onBeforeRender: () => {
        lines.material = idBundle.material;
      },
      onAfterRender: () => {
        lines.material = renderMaterial;
      },
    });
    if (index == null) return null;
    return this.resolvePick(index, [cssX, cssY]);
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.bundle.material.dispose();
    this.idBundle?.material.dispose();
    this.idBundle = null;
    this.idColorsPresent = false;
  }
}
