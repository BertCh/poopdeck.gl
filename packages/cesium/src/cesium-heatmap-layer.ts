// @poopdeck.gl/cesium
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/cesium contributors

/**
 * `STTHeatmapLayer` — the `heatmap` kind for CesiumJS: a per-pixel DENSITY
 * surface, not a pile of translucent dots.
 *
 * WHAT IT RENDERS
 * ---------------
 * One geodetic `RectangleGeometry` covering the data extent, textured with an
 * RGBA raster this layer computes on the CPU. The raster comes from
 * `lib/heatmap-field.ts` in two strictly ordered phases:
 *
 *   1. every in-window sample splats a compactly-supported kernel
 *      (Epanechnikov by default) ADDITIVELY into a scalar `Float32Array`;
 *   2. the SUMMED field is then mapped through the colour range, one palette
 *      lookup per cell.
 *
 * WHY THAT ORDER IS THE WHOLE LAYER
 * ---------------------------------
 * The tempting shortcut is to give every point a palette colour and let
 * additive blending pile them up. That sums COLOURS, not density: two
 * overlapping mid-ramp splats add to something brighter than either, dense
 * regions clip to white, and the ramp stops carrying any information — the
 * image reads as "lots of dots" instead of "how much". Accumulate first, ramp
 * once, per cell. `test/heatmap-field.test.ts` asserts the ordering directly
 * (two coincident points are strictly hotter than one, and the palette is
 * applied to the sum) and pins the divergence from the naive path.
 *
 * TIME
 * ----
 * `setTime` rebases the playhead to `timeOrigin` and evaluates
 * `core/time-filter`'s `timeFilterAlpha` oracle per sample — the same maths
 * every other backend runs, so "what is in the window" never forks by backend.
 * An out-of-window sample contributes EXACTLY ZERO density; it does not fade
 * to a dim colour, it leaves the sum. Alphas are quantised to 1/32 and cached
 * per entry (`lastAlpha`, seeded `NaN` so the first frame always writes), and a
 * `rebuildMs` sim-time bucket gates the evaluation loop, so a scrub costs one
 * compare per sample rather than a full re-splat per frame.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — DOCUMENTED DEVIATIONS FROM deck
 * -----------------------------------------------------------------
 * - **It is NOT a GPU heatmap.** deck's `HeatmapLayer` splats into a float
 *   render target and ramps in a fragment shader, re-running every frame for
 *   free. CesiumJS gives a primitive author no render-to-texture splat
 *   pipeline, so accumulation happens on the CPU main thread and the texture is
 *   re-uploaded on a bucket. Cost is O(samples x kernel area) per rebuild:
 *   `resolution`, `radiusPixels` and `rebuildMs` are the budget knobs. Any
 *   capability flag claiming a GPU heatmap for this backend would be false.
 * - **Radius is geographic, not screen-space.** deck's `radiusPixels` is
 *   measured in screen pixels and so rescales with zoom for free. Here the
 *   raster is a fixed geographic grid, so `radiusPixels` means "radius in field
 *   cells" and `radiusMeters` means metres on the ellipsoid (resolved through
 *   the wgs84 `GlobeProjection` in absolute f64 ECEF metres — no RTC anchor).
 *   The heat blob therefore keeps a fixed GROUND size as you zoom, where deck's
 *   keeps a fixed SCREEN size.
 * - **Picking is not per-texel.** The raster is a single primitive, so
 *   `scene.pick` can only report "the heatmap was hit". Rather than return
 *   nothing (deck's `HeatmapLayer` is not per-feature pickable either), a hit
 *   resolves to the field's PEAK contributor and the peak's coordinate.
 *   Per-texel picking would need a raw `camera.pickEllipsoid` read, which this
 *   package's hard constraints forbid a layer from doing.
 * - **No antimeridian stitching, Point geometry only.** See the builder header.
 *
 * FRAMES
 * ------
 * No model matrix is used anywhere: `RectangleGeometry` is specified in
 * geodetic degrees and Cesium places it on the ellipsoid itself. (Had the
 * raster been a quad positioned by `modelMatrix`, it would have had to be built
 * on a LOCAL east-north-up frame via `Transforms.eastNorthUpToFixedFrame` — an
 * identity rotation aims the quad's +Z at the ECEF pole, which is flat wrong at
 * the equator and visibly tilted everywhere else.)
 *
 * Uploading the texture requires a live WebGL context, so that step is
 * browser-verify-only; the field, the ramp and the time wiring are all unit
 * tested in Node against a real `PrimitiveCollection`.
 */

import {
  Cartesian2,
  GeometryInstance,
  Material,
  MaterialAppearance,
  Primitive,
  PrimitiveCollection,
  Rectangle,
  RectangleGeometry,
  defined,
  type Scene,
} from 'cesium';
import {
  getFeatureProperties,
  type BinaryFeatures,
  type Tile,
} from '@poopdeck.gl/core';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import {
  timeFilterAlpha,
  type TimeFilterMode,
  type TimeFilterParams,
} from '@poopdeck.gl/core/time-filter';
import type { SttRenderNode } from '@poopdeck.gl/core/capabilities';
import type { SttPickResult } from '@poopdeck.gl/core/picking';
import {
  buildHeatmapSamples,
  fieldGridForBounds,
  nearestSample,
  padHeatmapBounds,
  peakCell,
  renderHeatmapRaster,
  type DensityField,
  type HeatmapBounds,
  type HeatmapKernel,
  type HeatmapRaster,
  type HeatmapSample,
} from './lib/heatmap-field.js';

/** An RGBA raster turned into something Cesium's `Image` material accepts. */
export type HeatmapImageSource = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) => unknown;

export interface STTHeatmapLayerOptions {
  id?: string;
  /** Time-filter mode. @default 'window' */
  mode?: TimeFilterMode;
  /** Window/wake/cumulative/trail parameters (relative ms). */
  timeFilter?: TimeFilterParams;

  /** Baked numeric column supplying each feature's weight; unset ⇒ every feature counts 1. */
  weightProperty?: string;
  /** Weight for features with no usable value in `weightProperty`. @default 1 */
  defaultWeight?: number;

  /** Kernel radius in FIELD CELLS (see the header: not screen pixels). @default 12 */
  radiusPixels?: number;
  /** Kernel radius in metres on the ellipsoid; wins over `radiusPixels`. */
  radiusMeters?: number;
  /** @default 'epanechnikov' */
  kernel?: HeatmapKernel;
  /** `'SUM'` = density (default); `'MEAN'` = kernel-weighted average of the weights. */
  aggregation?: 'SUM' | 'MEAN';
  /** Longest side of the density raster, in cells. Clamped to 8..1024. @default 256 */
  resolution?: number;

  /** Palette stops, low density first. @default deck's 6-step YlOrRd */
  colorRange?: RGBA255[];
  /** Explicit `[lo, hi]` density domain; defaults to `[0, fieldMax]` (auto-scaling). */
  colorDomain?: [number, number];
  /** Multiplies normalised density before the ramp. @default 1 */
  intensity?: number;
  /** Normalised density at or below which a cell is fully transparent. @default 0.05 */
  threshold?: number;
  /** Global opacity multiplier, 0..1. @default 1 */
  opacity?: number;

  /** Explicit raster extent; defaults to the padded extent of the samples. */
  bounds?: HeatmapBounds;
  /** Fractional padding applied to the derived extent. @default 0.08 */
  boundsPadding?: number;
  /** Height of the raster plane above the ellipsoid, metres. @default 0 */
  height?: number;

  /**
   * Sim-time bucket (ms) the density field is recomputed on. `0` disables the
   * gate and evaluates every `setTime` (what the tests do). @default 250
   */
  rebuildMs?: number;

  /**
   * Turns the RGBA raster into a texture source. The default uses
   * `OffscreenCanvas` (or a DOM canvas) and returns `undefined` in a headless
   * environment, where the field is still computed but nothing is uploaded.
   */
  imageSource?: HeatmapImageSource;
}

/** Per-sample animation state. Mirrors the point layer's entry, minus colour. */
interface HeatmapEntry {
  start: number; // relative to timeOrigin (ms)
  end: number;
  /** Last alpha folded into the field; `NaN` forces the first frame to write. */
  lastAlpha: number;
}

/** The mutable pick id attached to the single raster instance. */
interface HeatmapPickId {
  layerId: string;
  binary: BinaryFeatures | null;
  featureIndex: number;
}

// Reused for every per-frame pick coordinate so `pick` allocates one object,
// not two. Distinct from anything Cesium stores internally.
const SCRATCH_PICK_XY = new Cartesian2();
// The material's `repeat` uniform never changes — one shared immutable value.
const NO_REPEAT = new Cartesian2(1, 1);

/**
 * Alpha quantisation for the rebuild gate: a fade that moves by less than 1/32
 * cannot change a byte of the ramped raster in any way a viewer can see, and
 * treating it as unchanged is what keeps a smooth `fadeIn` from forcing a
 * full CPU re-splat on every single frame.
 */
const ALPHA_STEPS = 32;

function quantiseAlpha(a: number): number {
  return Math.round(a * ALPHA_STEPS) / ALPHA_STEPS;
}

/**
 * Default texture source: an `OffscreenCanvas` (preferred — no DOM needed) or a
 * DOM canvas. A FRESH canvas is returned per rebuild on purpose: Cesium's
 * material texture updater re-uploads only when the uniform's identity changes,
 * so reusing one canvas would leave the first frame's heat on screen forever.
 * Returns `undefined` where neither exists (Node, workers without canvas) —
 * the field is still computed and still assertable, just not uploaded.
 */
export function defaultHeatmapImageSource(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): unknown {
  if (typeof ImageData !== 'function') return undefined;
  // Built empty and filled, rather than `new ImageData(rgba, w, h)`: the DOM
  // typing insists the backing store is a plain ArrayBuffer, and `set` copies
  // without the cast.
  const data = new ImageData(width, height);
  data.data.set(rgba);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.putImageData(data, 0, 0);
    return canvas;
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.putImageData(data, 0, 0);
    return canvas;
  }
  return undefined;
}

export class STTHeatmapLayer implements SttRenderNode {
  readonly id: string;
  private readonly scene: Scene;
  private readonly collection: PrimitiveCollection;
  private readonly mode: TimeFilterMode;
  private readonly params: TimeFilterParams;
  private readonly opts: STTHeatmapLayerOptions;
  private readonly rebuildMs: number;
  private readonly imageSource: HeatmapImageSource;

  private timeOrigin = 0;
  private samples: HeatmapSample[] = [];
  private entries: HeatmapEntry[] = [];
  /** Per-sample time-filter alpha handed to the (pure) accumulator. */
  private alphas = new Float64Array(0);

  private bounds: HeatmapBounds | null = null;
  private grid = { width: 0, height: 0 };
  private raster: HeatmapRaster | null = null;
  private field: DensityField | null = null;
  private peak: { lon: number; lat: number; value: number } | null = null;

  private material: Material | null = null;
  private primitive: Primitive | null = null;
  private pickId: HeatmapPickId | null = null;
  private lastBucket = Number.NaN;

  constructor(scene: Scene, options: STTHeatmapLayerOptions = {}) {
    this.id = options.id ?? 'stt-cesium-heatmap';
    this.scene = scene;
    this.opts = options;
    this.mode = options.mode ?? 'window';
    this.params = options.timeFilter ?? {};
    this.rebuildMs = options.rebuildMs ?? 250;
    this.imageSource = options.imageSource ?? defaultHeatmapImageSource;
    this.collection = new PrimitiveCollection();
    scene.primitives.add(this.collection);
  }

  /**
   * (Re)build the sample set from decoded tiles and re-raster the plane.
   *
   * The ordering below is a hard rule across this package: the PURE build runs
   * first and an empty result bails while the OLD primitive is still standing.
   * Selection reports an empty visible set for the frames between a viewport
   * change and the first decoded tile of the new set; tearing down first turns
   * that transient into a blank frame — the "tiles genuinely in view flash out"
   * symptom. Holding the previous raster is safe even when the emptiness is
   * permanent: it sits at its true geodetic rectangle, which the camera has by
   * then left behind. Bailing early also leaves the previous `timeOrigin`
   * untouched, which is deliberate.
   */
  setTiles(tiles: Tile[]): void {
    const build = buildHeatmapSamples(tiles, {
      weightProperty: this.opts.weightProperty,
      defaultWeight: this.opts.defaultWeight,
    });
    if (build.samples.length === 0 || !build.bounds) return;

    // Only now may anything be torn down.
    this.collection.removeAll(); // destroys the old Primitive
    this.destroyMaterial(); // the Material is OURS; the collection never frees it
    this.primitive = null;
    this.pickId = null;
    this.raster = null;
    this.field = null;
    this.peak = null;
    this.lastBucket = Number.NaN;

    this.timeOrigin = build.timeOrigin;
    this.samples = build.samples;
    this.entries = build.samples.map((s) => ({
      start: s.start,
      end: s.end,
      lastAlpha: Number.NaN, // NaN !== anything → the first setTime always writes
    }));
    this.alphas = new Float64Array(build.samples.length);

    this.bounds =
      this.opts.bounds ??
      padHeatmapBounds(build.bounds, this.opts.boundsPadding ?? 0.08);
    this.grid = fieldGridForBounds(this.bounds, this.opts.resolution ?? 256);

    this.pickId = {
      layerId: this.id,
      binary: build.samples[0].binary,
      featureIndex: build.samples[0].featureIndex,
    };
    this.createPrimitive();
    // Seed the raster so a layer that is never ticked still draws something.
    this.rebuildRaster();
  }

  /**
   * Advance to an absolute playhead time. Rebases to `timeOrigin`, re-evaluates
   * the shared oracle per sample, and re-splats ONLY when some sample's
   * (quantised) alpha actually moved — a field where every feature is fully in
   * or fully out of the window costs one compare per sample and no raster work.
   */
  setTime(absoluteMs: number): void {
    if (this.entries.length === 0) return;
    const cur = absoluteMs - this.timeOrigin;

    // Cheap sim-time gate first: a CPU splat is far too expensive to run per
    // frame, so the field is a function of the window BUCKET, not the frame.
    if (this.rebuildMs > 0) {
      const bucket = Math.round(cur / this.rebuildMs);
      if (bucket === this.lastBucket) return;
      this.lastBucket = bucket;
    }

    let dirty = false;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const alpha = quantiseAlpha(
        timeFilterAlpha(this.mode, cur, e.start, e.end, this.params),
      );
      if (alpha === e.lastAlpha) continue; // unchanged — nothing to re-splat for
      e.lastAlpha = alpha;
      this.alphas[i] = alpha;
      dirty = true;
    }
    if (!dirty) return;
    this.rebuildRaster();
  }

  /**
   * Hit-test. A density raster is ONE primitive, so `scene.pick` can only tell
   * us the heatmap was hit, never which texel — see the header. A hit therefore
   * resolves to the field's peak contributor and the peak's coordinate.
   */
  pick(cssX: number, cssY: number): SttPickResult | null {
    SCRATCH_PICK_XY.x = cssX;
    SCRATCH_PICK_XY.y = cssY;
    const picked = this.scene.pick(SCRATCH_PICK_XY) as
      | { id?: HeatmapPickId }
      | undefined;
    if (!defined(picked) || !picked.id || picked.id.layerId !== this.id) {
      return null;
    }
    const { binary, featureIndex } = picked.id;
    if (!binary) return null;
    return {
      object: getFeatureProperties(binary, featureIndex),
      index: featureIndex,
      layerId: this.id,
      coordinate: this.peak ? [this.peak.lon, this.peak.lat] : undefined,
      screen: [cssX, cssY],
    };
  }

  /**
   * Symmetric with the constructor. `PrimitiveCollection.remove` destroys the
   * `Primitive` it holds, but NOT the `Material` we supplied to its appearance
   * — that is an externally-owned GPU resource (its texture included), so this
   * layer frees it explicitly, here and before every rebuild.
   */
  dispose(): void {
    this.scene.primitives.remove(this.collection);
    this.destroyMaterial();
    this.primitive = null;
    this.pickId = null;
    this.entries = [];
    this.samples = [];
    this.alphas = new Float64Array(0);
    this.raster = null;
    this.field = null;
    this.peak = null;
  }

  /** The current RGBA raster, or `null` before the first build. Debug/test hook. */
  rasterSnapshot(): HeatmapRaster | null {
    return this.raster;
  }

  /** The current scalar density field, or `null` before the first build. */
  fieldSnapshot(): DensityField | null {
    return this.field;
  }

  /** The current hottest cell, or `null` when nothing is in the window. */
  peakSnapshot(): { lon: number; lat: number; value: number } | null {
    return this.peak;
  }

  private createPrimitive(): void {
    if (!this.bounds) return;
    const material = Material.fromType(Material.ImageType, {
      image: Material.DefaultImageId,
      repeat: NO_REPEAT,
    });
    // The raster is mostly transparent; without this the appearance would be
    // free to take an opaque render pass and the ramp would sit on a black slab.
    material.translucent = true;
    this.material = material;
    const appearance = new MaterialAppearance({
      material,
      materialSupport: MaterialAppearance.MaterialSupport.TEXTURED,
      translucent: true,
      flat: true,
      closed: false,
    });
    const { west, south, east, north } = this.bounds;
    this.primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: new RectangleGeometry({
          rectangle: Rectangle.fromDegrees(west, south, east, north),
          height: this.opts.height ?? 0,
          vertexFormat:
            MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
        }),
        // ONE instance ⇒ ONE pick id. It is a mutable record, re-pointed at the
        // current peak contributor on every rebuild; Cesium holds the reference,
        // so mutation is what keeps picking in step with the animation.
        id: this.pickId ?? undefined,
      }),
      appearance,
      asynchronous: false,
      allowPicking: true,
    });
    this.collection.add(this.primitive);
  }

  /**
   * Accumulate → ramp → upload. Never the other way round: see the header.
   */
  private rebuildRaster(): void {
    if (!this.bounds || this.samples.length === 0) return;
    const out = renderHeatmapRaster(
      this.samples,
      this.alphas,
      {
        bounds: this.bounds,
        width: this.grid.width,
        height: this.grid.height,
        radiusPixels: this.opts.radiusPixels,
        radiusMeters: this.opts.radiusMeters,
        kernel: this.opts.kernel,
        aggregation: this.opts.aggregation,
      },
      {
        colorRange: this.opts.colorRange,
        colorDomain: this.opts.colorDomain,
        intensity: this.opts.intensity,
        threshold: this.opts.threshold,
        opacity: this.opts.opacity,
      },
    );
    this.field = out.field;
    this.raster = {
      rgba: out.rgba,
      width: out.width,
      height: out.height,
      domain: out.domain,
    };

    // Re-point the single pick id at whatever now dominates the field.
    const hottest = peakCell(out.field);
    this.peak = hottest
      ? { lon: hottest.lon, lat: hottest.lat, value: hottest.value }
      : null;
    if (this.pickId) {
      const contributor = hottest
        ? nearestSample(this.samples, this.alphas, hottest.lon, hottest.lat)
        : null;
      if (contributor) {
        this.pickId.binary = contributor.binary;
        this.pickId.featureIndex = contributor.featureIndex;
      }
    }

    const image = this.imageSource(out.rgba, out.width, out.height);
    // Headless (no canvas): the field is computed and assertable, but there is
    // nothing to upload — and no live WebGL context that could consume it.
    if (image === undefined || !this.material) return;
    this.material.uniforms.image = image;
  }

  private destroyMaterial(): void {
    const material = this.material;
    this.material = null;
    if (material && !material.isDestroyed()) material.destroy();
  }
}
