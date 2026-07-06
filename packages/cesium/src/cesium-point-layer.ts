// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * The worked-example STT layer for CesiumJS: a `point` renderer that satisfies the
 * shared `SttRenderNode` shape and is built ENTIRELY from the render kernel —
 * proving a new backend is thin (docs/roadmap/renderer-abstraction-2026-06.md §6):
 *
 *   - positions  → `core/geo` `GlobeProjection({datum:'wgs84'})` → ECEF `Cartesian3`
 *                  (Cesium's native frame IS WGS84 ECEF, so the kernel output drops in)
 *   - color      → `core/style` `expandCategoricalColors` (same fallback semantics as deck/three/maplibre)
 *   - time-filter→ `core/time-filter` `timeFilterAlpha` oracle, per-frame on the CPU
 *                  (identical math to every other backend; the GPU-appearance path
 *                  is ready via {@link timeFilterAlphaGlsl})
 *   - streaming  → `core/tileset-adapter` `makeTilesetCallbacks` (see the package README/streaming helper)
 *   - picking    → `scene.pick` → `getFeatureProperties` → the shared `SttPickResult`
 *
 * Rendering requires a live Cesium `Scene` (a browser canvas), so this file is
 * browser-verify-only; the pure kernel pieces it composes are unit-tested in core.
 */

import { Cartesian2, Cartesian3, Color, PointPrimitiveCollection, defined, type PointPrimitive, type Scene } from 'cesium';
import { getFeatureProperties, type Tile } from '@poopdeck.gl/core';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import { timeFilterAlpha, type TimeFilterMode, type TimeFilterParams } from '@poopdeck.gl/core/time-filter';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import { buildPointEntries } from './lib/points.js';

export interface CesiumPointLayerOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;
  /** Categorical property to color by (else every point gets `colorMappingDefault`). */
  colorProperty?: string;
  colorMapping?: Record<string, RGBA255>;
  /** Color for unmapped/absent categories (0–255). @default opaque grey */
  colorMappingDefault?: RGBA255;
  /** Point size in pixels. @default 6 */
  pixelSize?: number;
}

interface PointEntry {
  pp: PointPrimitive;
  start: number; // relative to timeOrigin (ms)
  end: number;
  r: number; // base colour channels, pre-normalized to 0..1 so setTime never re-divides
  g: number;
  b: number;
  a: number; // base categorical alpha (0..1), multiplied by the time-filter alpha
  lastAlpha: number; // last alpha written to the primitive; skip the setter when unchanged
  lon: number;
  lat: number;
  binary: BinaryFeatures;
  featureIndex: number;
}

// Reused for every per-frame colour write so setTime allocates nothing. JS is
// single-threaded and setTime runs to completion synchronously, so one shared
// scratch is safe even across multiple layer instances. It MUST stay a distinct
// object from each primitive's internal `_color`: the setter compares by value
// (Color.equals) to decide whether to dirty the GPU buffer, so mutating `_color`
// in place would bypass that dirty check and freeze the animation.
const SCRATCH_COLOR = new Color();

export class CesiumPointLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PointPrimitiveCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: CesiumPointLayerOptions;
  private timeOrigin = 0;
  private entries: PointEntry[] = [];

  constructor(scene: Scene, options: CesiumPointLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-points';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.collection = new PointPrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build points from decoded tiles. Rebases all times to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    this.collection.removeAll();
    this.entries = [];

    // Pure geometry/colour/rebase assembly lives in the Cesium-free builder;
    // this method only turns each FeaturePoint into a Cesium primitive.
    const build = buildPointEntries(tiles, {
      colorProperty: this.opts.colorProperty,
      colorMapping: this.opts.colorMapping,
      colorMappingDefault: this.opts.colorMappingDefault,
    });
    if (build.points.length === 0) return; // no points — leave the prior timeOrigin untouched
    this.timeOrigin = build.timeOrigin;

    const pixelSize = this.opts.pixelSize ?? 6;
    for (const fp of build.points) {
      const pp = this.collection.add({
        position: new Cartesian3(fp.x, fp.y, fp.z),
        color: new Color(fp.r, fp.g, fp.b, fp.a),
        pixelSize,
        id: { layerId: this.id, binary: fp.binary, featureIndex: fp.featureIndex },
      });
      this.entries.push({
        pp,
        start: fp.start,
        end: fp.end,
        r: fp.r,
        g: fp.g,
        b: fp.b,
        a: fp.a,
        lastAlpha: NaN, // NaN !== anything → force the first setTime to write
        lon: fp.lon,
        lat: fp.lat,
        binary: fp.binary,
        featureIndex: fp.featureIndex,
      });
    }
  }

  /**
   * Advance to an absolute playhead time; recompute per-point alpha via the
   * shared oracle. Reuses one scratch Color (zero allocations per frame) and
   * skips points whose alpha is unchanged since the last frame — so a point
   * that is fully in or fully out of the window costs a single compare, not a
   * Color allocation + GPU dirty. (The end-state fix is a GPU custom-Appearance
   * path via `timeFilterAlphaGlsl`, making this a single `currentTime` uniform
   * write; tracked as a separate follow-up.)
   */
  setTime(absoluteMs: number): void {
    const cur = absoluteMs - this.timeOrigin;
    const c = SCRATCH_COLOR;
    for (const e of this.entries) {
      const alpha = e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      if (alpha === e.lastAlpha) continue; // colour identical to last write — nothing to dirty
      e.lastAlpha = alpha;
      c.red = e.r;
      c.green = e.g;
      c.blue = e.b;
      c.alpha = alpha;
      e.pp.color = c; // setter clones the scratch into the primitive's own _color
    }
  }

  /** Hit-test → the shared `SttPickResult` (feature props joined via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | { id?: { layerId: string; binary: BinaryFeatures; featureIndex: number } }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id) return null;
    const { binary, featureIndex } = picked.id;
    const entry = this.entries.find((e) => e.binary === binary && e.featureIndex === featureIndex);
    return {
      object: getFeatureProperties(binary, featureIndex),
      index: featureIndex,
      layerId: this.id,
      coordinate: entry ? [entry.lon, entry.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  dispose(): void {
    this.scene.primitives.remove(this.collection);
    this.entries = [];
  }
}
