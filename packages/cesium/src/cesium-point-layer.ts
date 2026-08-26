// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * The worked-example STT layer for CesiumJS: a `point` renderer that satisfies the
 * shared `SttRenderNode` shape and is built ENTIRELY from the render kernel —
 * proving a new backend is thin (docs/roadmap/renderer-architecture.md):
 *
 *   - positions  → `core/geo` `GlobeProjection({datum:'wgs84'})` → ECEF `Cartesian3`
 *                  (Cesium's native frame IS WGS84 ECEF, so the kernel output drops in)
 *   - color      → `core/style` `expandCategoricalColors` (same fallback semantics as deck/three/maplibre)
 *   - time-filter→ `core/time-filter` `timeFilterAlpha` oracle, per-frame on the CPU
 *                  (identical math to every other backend). This IS the shipped
 *                  path; the GPU-appearance alternative is unwired — only its
 *                  GLSL snippet exists, in `shaders.ts`.
 *   - streaming  → `core/tileset-adapter` `makeTilesetCallbacks` (see the package README/streaming helper)
 *   - picking    → `scene.pick` → `getFeatureProperties` → the shared `SttPickResult`
 *
 * Rendering requires a live Cesium `Scene` (a browser canvas), so this file is
 * browser-verify-only; the pure kernel pieces it composes are unit-tested in core.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  PointPrimitiveCollection,
  defined,
  type PointPrimitive,
  type Scene,
} from 'cesium';
import { getFeatureProperties, type Tile } from '@poopdeck.gl/core';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { BinaryFeatures } from '@poopdeck.gl/core';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import { buildPointEntries } from './lib/points.js';
import {
  compileExtensions,
  type CesiumLayerExtension,
  type CompiledExtensions,
} from './lib/extensions.js';

export interface STTPointLayerOptions {
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
  /**
   * User extensions — per-feature hooks composed ON TOP of the resolved alpha
   * and colour, the `userExtensions` capability for a backend with no shader of
   * its own. See `lib/extensions.ts` for the contract and why it is a value
   * hook rather than three's node hook or maplibre's GLSL splice. An empty or
   * absent list compiles to `null` and the frame loop below is untouched.
   */
  extensions?: readonly CesiumLayerExtension[];
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

export class STTPointLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PointPrimitiveCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: STTPointLayerOptions;
  /** Folded user extensions, or `null` — the zero-cost case. */
  private readonly ext: CompiledExtensions | null;
  private timeOrigin = 0;
  private entries: PointEntry[] = [];

  constructor(scene: Scene, options: STTPointLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-points';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    // Compile once, at construction: a bad list (blank/duplicate name) throws
    // here rather than on the first drawn frame.
    this.ext = compileExtensions(options.extensions, this.id);
    this.collection = new PointPrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /** (Re)build points from decoded tiles. Rebases all times to one scene-wide origin. */
  setTiles(tiles: Tile[]): void {
    // Pure geometry/colour/rebase assembly lives in the Cesium-free builder;
    // this method only turns each FeaturePoint into a Cesium primitive.
    const build = buildPointEntries(tiles, {
      colorProperty: this.opts.colorProperty,
      colorMapping: this.opts.colorMapping,
      colorMappingDefault: this.opts.colorMappingDefault,
    });
    // Build BEFORE the teardown, and bail on an empty result while the old
    // primitives are still standing. Selection reports an empty visible set for
    // the frames between a viewport change and the first decoded tile of the new
    // set; tearing down first turns that transient into a blank frame — the
    // "tiles genuinely in view flash out" symptom. Holding the previous points is
    // safe even when the emptiness is permanent: they sit at their true ECEF
    // positions, which the camera has by then left behind.
    if (build.points.length === 0) return; // also leaves the prior timeOrigin untouched
    this.collection.removeAll();
    this.entries = [];
    this.timeOrigin = build.timeOrigin;

    const pixelSize = this.opts.pixelSize ?? 6;
    for (const fp of build.points) {
      const pp = this.collection.add({
        position: new Cartesian3(fp.x, fp.y, fp.z),
        color: new Color(fp.r, fp.g, fp.b, fp.a),
        pixelSize,
        id: {
          layerId: this.id,
          binary: fp.binary,
          featureIndex: fp.featureIndex,
        },
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
   * Color allocation + GPU dirty. (The end-state fix would be a GPU
   * custom-Appearance path — `shaders.ts` holds the GLSL snippet for it, but
   * nothing wires it, so this CPU loop is what runs.)
   *
   * User extensions (`lib/extensions.ts`) compose ON TOP of the oracle's value,
   * never in place of it: the hook's argument IS `e.a * timeFilterAlpha(...)`.
   * They run BEFORE the skip compare, and the compare tests the COMPOSED alpha
   * — reversing that order would silently drop any change a hook makes for a
   * reason other than the playhead moving. `skipUnchanged` is false whenever an
   * extension also transforms colour, because the cache is keyed on alpha alone
   * and would otherwise freeze a colour that is still moving. With no
   * extensions `ext` is `null` and this is the loop it always was.
   */
  setTime(absoluteMs: number): void {
    const cur = absoluteMs - this.timeOrigin;
    const c = SCRATCH_COLOR;
    const ext = this.ext;
    if (ext !== null) ext.beginFrame(cur);
    const skipUnchanged = ext === null || ext.skipUnchanged;
    for (const e of this.entries) {
      let alpha =
        e.a * timeFilterAlpha(this.mode, cur, e.start, e.end, this.params);
      let r = e.r;
      let g = e.g;
      let b = e.b;
      if (ext !== null) {
        const out = ext.apply(
          alpha,
          e.start,
          e.end,
          e.binary,
          e.featureIndex,
          e.r,
          e.g,
          e.b,
        );
        alpha = out.alpha;
        r = out.r;
        g = out.g;
        b = out.b;
      }
      if (skipUnchanged && alpha === e.lastAlpha) continue; // colour identical to last write — nothing to dirty
      e.lastAlpha = alpha;
      c.red = r;
      c.green = g;
      c.blue = b;
      c.alpha = alpha;
      e.pp.color = c; // setter clones the scratch into the primitive's own _color
    }
  }

  /** Hit-test → the shared `SttPickResult` (feature props joined via `getFeatureProperties`). */
  pick(cssX: number, cssY: number): SttPickResult | null {
    const picked = this.scene.pick(new Cartesian2(cssX, cssY)) as
      | {
          id?: {
            layerId: string;
            binary: BinaryFeatures;
            featureIndex: number;
          };
        }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id)
      return null;
    const { binary, featureIndex } = picked.id;
    const entry = this.entries.find(
      (e) => e.binary === binary && e.featureIndex === featureIndex,
    );
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
