// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * `STTHexbinLayer` — a RUNTIME hexbin over the raw point tier: every visible
 * feature is binned into a world-space hexagonal lattice and each occupied cell
 * is drawn as one instanced prism, coloured and extruded by its AGGREGATED
 * weight. The Three port of deck's `AnimatedHexagonLayer` (and the twin of
 * maplibre's `STTHexbinLayer`), and the discrete / pickable / extruded
 * counterpart of the smooth heatmap.
 *
 * ── It is NOT a referral to `STTH3SummaryLayer` ─────────────────────────────
 * {@link STTH3SummaryLayer} DECODES a precomputed summary tier — the cells
 * already exist in the archive, keyed by an H3 `featureIds64`, and nothing is
 * aggregated at runtime. This layer bins RAW features itself, at runtime, from
 * an archive that need carry no summary tier at all, and re-aggregates as the
 * play head moves. Different input, different machine, different answer; the
 * capability descriptor's old `hexbin → h3Summary` fallback was never
 * equivalent. The binning math and the cell-membership table live in the pure
 * `lib/hexbin-buffers.ts`; this class is the GPU wrapper.
 *
 * ── TIME: a real re-aggregation, and its cache key ─────────────────────────
 * The animation is not a cross-fade between two frozen aggregates and it is not
 * one static aggregate under a moving opacity. The reduction genuinely re-runs:
 * a cell's value is `Σ weight × windowAlpha(member)` over the members that
 * landed in it, so cells appear, re-colour, rise and vanish as their own
 * members enter and leave the window.
 *
 * Re-running it every frame would be O(members) per frame, so the play head is
 * quantised. The aggregate is CACHED under a three-part key, and a frame that
 * does not move the key touches nothing but the uniform block:
 *
 *   ┌ **visible tile set + weight config** → `buildGeneration`, bumped by every
 *   │   `setTiles` (which is also the only thing that can change the lattice,
 *   │   the radius, the weight column or the cell membership);
 *   ├ **window bucket** → `hexbinWindowBucket(relativeTime, aggregationStep)`,
 *   │   i.e. `floor(t / step)` — the aggregate is evaluated at the bucket's
 *   │   CENTRE, so it is a pure function of the bucket and scrubbing back into
 *   │   a bucket reproduces identical cells;
 *   └ **aggregation config** → `aggregateEpoch`, bumped when a style knob that
 *       feeds the reduction (aggregation op, domains, percentiles, ramp,
 *       `extruded`) is changed through {@link setAggregationOptions}.
 *
 * `aggregationStep` defaults to a quarter of the window half-width, so the cells
 * refresh eight times per window sweep — visually continuous, and the sub-step
 * gap is covered by the material's own window filter over each cell's temporal
 * span (see `tsl/hexbin-material.ts`). `aggregationStep: 0` opts out entirely
 * (one aggregate for the tile set).
 *
 * A re-aggregation re-uploads FOUR small per-cell attributes (`sttColor`,
 * `sttHeight`, `sttVisible`, `sttStart`/`sttEnd`) into the SAME
 * `InstancedBufferAttribute`s — the geometry, the bases and the material are
 * untouched, so nothing evicts three's `nodeBuilderCache` (audit E5).
 *
 * ── PICKING: provenance is per CELL, not per feature ───────────────────────
 * This is the second kind in the package (after `text`) where a pick does NOT
 * resolve 1:1 to a source feature, and it is worth being explicit about:
 *
 *  - the decoded GPU id is a CELL index, not a feature index;
 *  - `tileKey` / `featureIndex` / `object` name the cell's FIRST CONTRIBUTING
 *    feature in merge order — a deterministic REPRESENTATIVE, useful for "what
 *    kind of thing is in here", never "this is what you clicked";
 *  - `featureCount` is the honest number: how many features the cell aggregated
 *    at the live aggregate;
 *  - `coordinate` is the CELL CENTROID (what was actually clicked), and the
 *    representative feature's own position rides along as `featureCoordinate`.
 *
 * A consumer that needs every contributor should re-query the archive by the
 * cell's `(i, j)` address, which {@link STTHexbinPickInfo.cell} reports.
 */

import { Mesh, InstancedBufferAttribute, Box3, Vector3, Sphere } from 'three';
import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { InstanceProvenance, buildIdColors } from '@poopdeck.gl/core/picking';
import { BaseSTTLayer, type STTLayerContext } from './layer.js';
import {
  resolveTimeWindow,
  type ThreeTimeWindowOptions,
} from '../lib/time-window.js';
import { makeColumnPrismGeometry } from '../geometry/column-prism.js';
import {
  aggregateHexbins,
  buildHexbinBuffers,
  hexbinBucketTime,
  hexbinWindowBucket,
  DEFAULT_HEXBIN_COLOR_RANGE,
  DEFAULT_HEXBIN_ELEVATION_RANGE,
  DEFAULT_HEXBIN_RADIUS_METERS,
  type HexbinAggregate,
  type HexbinAggregation,
  type HexbinBufferOptions,
  type HexbinBuffers,
  type HexbinScaleType,
  type HexbinWeightAccessor,
} from '../lib/hexbin-buffers.js';
import {
  createHexbinMaterial,
  createHexbinIdMaterial,
  updateHexbinUniforms,
  type HexbinMaterialBundle,
  type HexbinUniformValues,
} from '../tsl/hexbin-material.js';
import type { RGBA } from '../lib/color.js';
import {
  resolveIdPick,
  type STTIdPickInfo,
  type STTIdPickable,
} from '../lib/id-pick.js';
import type { GpuPicker } from '../lib/gpu-pick.js';

/** Six sides, rotated 30° ⇒ flat sides east/west: deck's pointy-top hexagon. */
const HEXBIN_PRISM_SIDES = 6;
const HEXBIN_PRISM_ANGLE = Math.PI / 6;

/**
 * Re-aggregation cadence, as a fraction of the window HALF-width, when
 * `aggregationStep` is not pinned. Eight refreshes per full window sweep.
 */
const DEFAULT_AGGREGATION_STEP_FRACTION = 0.25;

/**
 * A hit on one hexbin CELL. Extends the shared id-pick shape, and every field
 * below exists because a cell is an aggregate rather than a feature — read the
 * class header's picking section before using `featureIndex`.
 */
export interface STTHexbinPickInfo extends STTIdPickInfo {
  kind: 'hexbin';
  /** Dense cell index — the value the GPU id buffer actually encoded. */
  cellIndex: number;
  /** The cell's axial lattice address `(i, j)`. */
  cell: [number, number];
  /** How many source features contributed to this cell at the live aggregate. */
  featureCount: number;
  /** The cell's aggregated COLOUR value at the live aggregate. */
  value: number;
  /** The cell's aggregated ELEVATION value at the live aggregate. */
  elevationValue: number;
  /** lon/lat of the REPRESENTATIVE feature named by `featureIndex`. */
  featureCoordinate?: [number, number];
}

/** Diagnostics for the lattice + the live aggregate (test/inspection seam). */
export interface HexbinStats {
  /** Bumped by every `setTiles` — the tile-set/weight half of the cache key. */
  buildGeneration: number;
  /** Bumped by every `setAggregationOptions` — the config half of the key. */
  aggregateEpoch: number;
  /** Bumped by every actual re-aggregation. A cache HIT must not move it. */
  aggregateGeneration: number;
  /** The window bucket the live aggregate was evaluated in. */
  bucket: number;
  /** Occupied cells in the lattice (the instance count). */
  cellCount: number;
  /** Cells that survived the occupancy + percentile gate this aggregate. */
  visibleCells: number;
  /** Entries offered to the lattice (features for points, vertices for paths). */
  entryCount: number;
  /** Entries dropped for an unpackable lattice address. */
  droppedEntries: number;
  /** Tile layers skipped by the geometry-kind guard. */
  skippedLayers: number;
  /** Mercator-unit circumradius the lattice is pitched at. */
  radiusMerc: number;
  /** Latitude the metric radius was resolved at. */
  latitude: number;
  /** The resolved weight column, or `null` for a pure COUNT hexbin. */
  weightProperty: string | null;
  /** The colour domain the live aggregate used. */
  colorDomain: [number, number];
  /** The elevation domain the live aggregate used. */
  elevationDomain: [number, number];
}

export interface STTHexbinLayerOptions extends ThreeTimeWindowOptions {
  id?: string;
  /** Cell CIRCUMRADIUS in true metres (deck `radius`). @default 1000 */
  radius?: number;
  /**
   * Latitude the metric radius resolves at. Unset ⇒ the centre of the visible
   * features' latitude span (deck's data-bounds rule). Pin it to stop the
   * lattice breathing as the visible tile set changes.
   */
  radiusLatitude?: number;
  /** Cell size multiplier, clamped 0..1 (deck pass-through). @default 1 */
  coverage?: number;
  /**
   * Extrude cells by their aggregated weight. `false` draws flat hexagons on the
   * ground.
   *
   * DELIBERATE DEFAULT DRIFT, matching `AnimatedHexagonLayer`: `true` here vs
   * deck's `HexagonLayer` default of `false`. The extruded 3-D hexbin is this
   * kind's whole reason to exist next to the heatmap, so the iconic look is the
   * out-of-box one. @default true
   */
  extruded?: boolean;
  /** Multiplier on every cell height — a UNIFORM, so animating it is free. @default 1 */
  elevationScale?: number;
  /** Elevation output range in METRES, low → high aggregate. @default [0, 1000] */
  elevationRange?: [number, number];
  /** Low→high RGBA ramp (0–255). @default 6-class YlOrRd */
  colorRange?: RGBA[];
  /**
   * Pinned colour domain. `null` auto-ranges over the OCCUPIED cells of each
   * aggregate (empty cells are absence, not a zero sample). Pin it to keep a
   * legend stable across the sweep. @default null
   */
  colorDomain?: [number, number] | null;
  /** Pinned elevation input domain; `null` auto-ranges. @default null */
  elevationDomain?: [number, number] | null;
  /** Colour scale. `'quantile'`/`'ordinal'` degrade to `'quantize'`. @default 'quantize' */
  colorScaleType?: HexbinScaleType;
  /** Hide cells below this colour percentile (0–100). @default 0 */
  lowerPercentile?: number;
  /** Hide cells above this colour percentile (0–100). @default 100 */
  upperPercentile?: number;
  /** Aggregation for BOTH channels unless overridden below. @default 'SUM' */
  hexagonAggregation?: HexbinAggregation;
  /** Colour aggregation override; `null` inherits {@link hexagonAggregation}. */
  colorAggregation?: HexbinAggregation | null;
  /** Elevation aggregation override; `null` inherits {@link hexagonAggregation}. */
  elevationAggregation?: HexbinAggregation | null;
  /**
   * The weight COLUMN NAME (three-native spelling of deck's `getColorWeight`).
   * Wins over {@link elevationWeight} and {@link weightProperty}; ONE column
   * drives BOTH colour and elevation. A function value warns once and falls
   * through — binary tiles cannot run per-feature accessors.
   */
  colorWeight?: HexbinWeightAccessor;
  /** Second-in-line weight column (deck's `getElevationWeight`). */
  elevationWeight?: HexbinWeightAccessor;
  /** Legacy weight column name. Unset ⇒ a pure COUNT hexbin. @default null */
  weightProperty?: string | null;
  /** Base altitude (metres) the cell footprints sit at. @default 0 */
  zLift?: number;
  /** Constant opacity multiplier — a uniform. @default 1 */
  opacity?: number;
  /** Translucent cells (lets the window fade show). @default false */
  transparent?: boolean;
  /** Discard fragments below this alpha when transparent. @default 0.01 */
  alphaCutoff?: number;
  /**
   * Gate contributing members by the time window (and gate each cell by its own
   * temporal span between re-aggregations). `false` aggregates the whole tile
   * set once — a static hexbin. @default true
   */
  timeFiltered?: boolean;
  /**
   * Milliseconds of play-head movement between re-aggregations — the third
   * component of the aggregate cache key (see the class header). Unset ⇒ a
   * quarter of the window half-width; `0` disables re-aggregation.
   */
  aggregationStep?: number;
  // window time params — full-width `timeWindow` + `fadeIn/OutDuration` and the
  // lower-level `windowHalf`/`fadeIn`/`fadeOut` aliases come from
  // ThreeTimeWindowOptions.
}

export class STTHexbinLayer extends BaseSTTLayer implements STTIdPickable {
  readonly id: string;
  readonly object = new Mesh();

  protected readonly opts: STTHexbinLayerOptions;
  private bundle: HexbinMaterialBundle | null = null;

  // ── The static (lattice) half ─────────────────────────────────────────────
  private buffers: HexbinBuffers | null = null;
  private buildGeneration = 0;

  // ── The play-head (aggregate) half + its cache key ────────────────────────
  private aggregate: HexbinAggregate | null = null;
  private aggregateGeneration = 0;
  private aggregateEpoch = 0;
  private cachedBuild = -1;
  private cachedEpoch = -1;
  private cachedBucket = 0;

  // Live attribute handles, re-filled in place by a re-aggregation.
  private attrColor: InstancedBufferAttribute | null = null;
  private attrHeight: InstancedBufferAttribute | null = null;
  private attrVisible: InstancedBufferAttribute | null = null;
  private attrStart: InstancedBufferAttribute | null = null;
  private attrEnd: InstancedBufferAttribute | null = null;

  // ── GPU id-buffer pick identity (merged CELL i → representative feature) ──
  private provenance = new InstanceProvenance();
  private binaryByTileKey = new Map<string, BinaryFeatures>();
  private idBundle: HexbinMaterialBundle | null = null;
  private idColorsPresent = false;
  private currentTimeMs = 0;

  constructor(options: STTHexbinLayerOptions = {}) {
    super();
    this.opts = options;
    this.id = options.id ?? 'hexbin';
    this.object.name = this.id;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  // ── Options plumbing ──────────────────────────────────────────────────────

  protected bufferOptions(): HexbinBufferOptions {
    return {
      radius: this.opts.radius ?? DEFAULT_HEXBIN_RADIUS_METERS,
      radiusLatitude: this.opts.radiusLatitude,
      coverage: this.opts.coverage ?? 1,
      zLift: this.opts.zLift ?? 0,
      colorWeight: this.opts.colorWeight,
      elevationWeight: this.opts.elevationWeight,
      weightProperty: this.opts.weightProperty ?? null,
      layerId: this.id,
    };
  }

  /** Re-aggregation cadence in ms; `0` disables it (see the class header). */
  private aggregationStep(): number {
    const pinned = this.opts.aggregationStep;
    if (pinned != null && Number.isFinite(pinned)) return Math.max(0, pinned);
    const { windowHalf } = resolveTimeWindow(this.opts, 0);
    return Math.max(1, windowHalf * DEFAULT_AGGREGATION_STEP_FRACTION);
  }

  /**
   * Mutate the aggregation-side style knobs and invalidate the aggregate cache.
   * The lattice is untouched (radius / weight / coverage live on the BUILD side
   * and need a fresh `setTiles`), so this is the cheap half of restyling: the
   * next frame re-reduces and re-uploads four small attributes.
   *
   * It writes THROUGH to the options object the constructor was given — the
   * package convention is that the options object stays the layer's live config
   * — and bumps `aggregateEpoch`, which is the only thing that makes an
   * otherwise unchanged frame re-reduce.
   */
  setAggregationOptions(
    patch: Partial<
      Pick<
        STTHexbinLayerOptions,
        | 'colorRange'
        | 'colorDomain'
        | 'elevationDomain'
        | 'elevationRange'
        | 'colorScaleType'
        | 'lowerPercentile'
        | 'upperPercentile'
        | 'hexagonAggregation'
        | 'colorAggregation'
        | 'elevationAggregation'
        | 'extruded'
      >
    >,
  ): void {
    Object.assign(this.opts, patch);
    this.aggregateEpoch++;
    this.reaggregate(this.currentTimeMs);
  }

  // ── The static half ───────────────────────────────────────────────────────

  setTiles(tiles: Tile[], ctx: STTLayerContext): void {
    this.timeOrigin = ctx.timeOrigin;
    this.currentTimeMs = ctx.timeOrigin;
    const buf = buildHexbinBuffers(
      tiles,
      ctx.projection,
      ctx.timeOrigin,
      this.bufferOptions(),
    );
    // Adopt the fresh pick identity even when empty, so a stale pick after a
    // reload resolves to null rather than to an old cell.
    this.buffers = buf;
    this.provenance = buf.provenance;
    this.binaryByTileKey = buf.binaryByTileKey;
    this.buildGeneration++;
    this.aggregate = null;
    this.cachedBuild = -1;

    this.disposeGeometry();
    if (buf.count === 0) {
      this.object.geometry = makeColumnPrismGeometry(
        HEXBIN_PRISM_SIDES,
        HEXBIN_PRISM_ANGLE,
      ).geometry;
      this.object.visible = false;
      return;
    }
    this.object.visible = true;
    this.object.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);

    const { geometry } = makeColumnPrismGeometry(
      HEXBIN_PRISM_SIDES,
      HEXBIN_PRISM_ANGLE,
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
    // The four aggregate-driven attributes. Allocated here at the cell count and
    // re-FILLED (never reallocated) by every re-aggregation.
    this.attrColor = new InstancedBufferAttribute(
      new Float32Array(buf.count * 4),
      4,
    );
    this.attrHeight = new InstancedBufferAttribute(
      new Float32Array(buf.count),
      1,
    );
    this.attrVisible = new InstancedBufferAttribute(
      new Float32Array(buf.count),
      1,
    );
    this.attrStart = new InstancedBufferAttribute(
      new Float32Array(buf.count),
      1,
    );
    this.attrEnd = new InstancedBufferAttribute(new Float32Array(buf.count), 1);
    geometry.setAttribute('sttColor', this.attrColor);
    geometry.setAttribute('sttHeight', this.attrHeight);
    geometry.setAttribute('sttVisible', this.attrVisible);
    geometry.setAttribute('sttStart', this.attrStart);
    geometry.setAttribute('sttEnd', this.attrEnd);

    if (buf.bbox) {
      // Expand the footprint box by the tallest cell the elevation range can
      // produce, along +Z of the RTC frame (the basis is per-cell, but the box
      // only has to CONTAIN the prisms, not hug them).
      const range = this.opts.elevationRange ?? DEFAULT_HEXBIN_ELEVATION_RANGE;
      const tallest =
        (this.opts.extruded ?? true)
          ? Math.max(Math.abs(range[0]), Math.abs(range[1])) *
            Math.abs(this.opts.elevationScale ?? 1)
          : 0;
      const up = this.maxUpWorldPerMeter(buf) * tallest;
      geometry.boundingBox = new Box3(
        new Vector3(
          buf.bbox.min[0] - up,
          buf.bbox.min[1] - up,
          buf.bbox.min[2] - up,
        ),
        new Vector3(
          buf.bbox.max[0] + up,
          buf.bbox.max[1] + up,
          buf.bbox.max[2] + up,
        ),
      );
      geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(
        new Sphere(),
      );
    }

    const bundle = this.ensureBundle();
    this.object.geometry = geometry;
    this.object.material = bundle.material;
    this.reaggregate(this.currentTimeMs);
    this.pushUniforms(this.currentTimeMs);
  }

  /** Longest per-metre up vector across the cells — the bbox padding factor. */
  private maxUpWorldPerMeter(buf: HexbinBuffers): number {
    let m = 0;
    for (let c = 0; c < buf.count; c++) {
      const len = Math.hypot(
        buf.basisZ[c * 3],
        buf.basisZ[c * 3 + 1],
        buf.basisZ[c * 3 + 2],
      );
      if (len > m) m = len;
    }
    return m;
  }

  /**
   * The material, built ONCE per layer (audit E5). Every input is fixed at
   * construction, so unlike the column layer there is not even a variant to flip
   * — rebuilding it per `setTiles` would evict three's `nodeBuilderCache` entry,
   * program and pipeline for nothing.
   */
  private ensureBundle(): HexbinMaterialBundle {
    if (this.bundle) return this.bundle;
    this.bundle = createHexbinMaterial({
      timeFiltered: this.opts.timeFiltered ?? true,
      transparent: this.opts.transparent ?? false,
      alphaCutoff: this.opts.alphaCutoff,
    });
    return this.bundle;
  }

  // ── The play-head half ────────────────────────────────────────────────────

  setTime(absoluteTimeMs: number): void {
    this.currentTimeMs = absoluteTimeMs;
    this.reaggregate(absoluteTimeMs);
    this.pushUniforms(absoluteTimeMs);
  }

  /**
   * Re-run the CPU reduction IF the three-part cache key moved (see the class
   * header), then re-fill the four aggregate-driven attributes in place. A frame
   * inside the same window bucket returns immediately — that is the whole point
   * of the bucket, and `getStats().aggregateGeneration` is the observable proof.
   */
  private reaggregate(absoluteTimeMs: number): void {
    const buf = this.buffers;
    if (!buf || buf.count === 0) return;
    const step = this.aggregationStep();
    const rel = this.relativeTime(absoluteTimeMs);
    const bucket = hexbinWindowBucket(rel, step);
    if (
      this.aggregate &&
      this.cachedBuild === this.buildGeneration &&
      this.cachedEpoch === this.aggregateEpoch &&
      this.cachedBucket === bucket
    ) {
      return; // cache hit — no reduction, no upload
    }

    const base = this.opts.hexagonAggregation ?? 'SUM';
    const agg = aggregateHexbins(buf, {
      relativeCurrentTime: hexbinBucketTime(bucket, step, rel),
      timeFiltered: this.opts.timeFiltered ?? true,
      params: resolveTimeWindow(this.opts, 0),
      colorAggregation: this.opts.colorAggregation ?? base,
      elevationAggregation: this.opts.elevationAggregation ?? base,
      colorRange: this.opts.colorRange ?? DEFAULT_HEXBIN_COLOR_RANGE,
      colorDomain: this.opts.colorDomain ?? null,
      elevationDomain: this.opts.elevationDomain ?? null,
      elevationRange:
        this.opts.elevationRange ?? DEFAULT_HEXBIN_ELEVATION_RANGE,
      colorScaleType: this.opts.colorScaleType ?? 'quantize',
      lowerPercentile: this.opts.lowerPercentile ?? 0,
      upperPercentile: this.opts.upperPercentile ?? 100,
      extruded: this.opts.extruded ?? true,
      layerId: this.id,
    });
    this.aggregate = agg;
    this.aggregateGeneration++;
    this.cachedBuild = this.buildGeneration;
    this.cachedEpoch = this.aggregateEpoch;
    this.cachedBucket = bucket;

    // Re-FILL the existing attribute arrays: same GPU buffers, same VAOs, same
    // material — only the bytes move.
    fill(this.attrColor, agg.colors);
    fill(this.attrHeight, agg.heights);
    fill(this.attrVisible, agg.visible);
    fill(this.attrStart, agg.starts);
    fill(this.attrEnd, agg.ends);
  }

  /** The uniform values for a play head — shared by the render and the id pass. */
  private uniformValues(absoluteTimeMs: number): HexbinUniformValues {
    return {
      relativeCurrentTime: this.relativeTime(absoluteTimeMs),
      params: resolveTimeWindow(this.opts, 0),
      opacity: this.opts.opacity ?? 1,
      elevationScale: this.opts.elevationScale ?? 1,
    };
  }

  private pushUniforms(absoluteTimeMs: number): void {
    if (!this.bundle) return;
    updateHexbinUniforms(this.bundle, this.uniformValues(absoluteTimeMs));
  }

  /** Lattice + live-aggregate diagnostics (the cache-behaviour test seam). */
  getStats(): HexbinStats {
    const buf = this.buffers;
    const agg = this.aggregate;
    return {
      buildGeneration: this.buildGeneration,
      aggregateEpoch: this.aggregateEpoch,
      aggregateGeneration: this.aggregateGeneration,
      bucket: this.cachedBucket,
      cellCount: buf?.count ?? 0,
      visibleCells: agg?.occupiedCells ?? 0,
      entryCount: buf?.entryCount ?? 0,
      droppedEntries: buf?.droppedEntries ?? 0,
      skippedLayers: buf?.skippedLayers ?? 0,
      radiusMerc: buf?.radiusMerc ?? 0,
      latitude: buf?.latitude ?? 0,
      weightProperty: buf?.weightProperty ?? null,
      colorDomain: agg?.colorDomain ?? [0, 1],
      elevationDomain: agg?.elevationDomain ?? [0, 1],
    };
  }

  /** The live aggregate, or `null` before the first `setTiles`. Read-only. */
  getAggregate(): HexbinAggregate | null {
    return this.aggregate;
  }

  // ── Picking (GPU id-buffer catalog: hexbin variant) ───────────────────────

  /**
   * Resolve a decoded CELL index to an {@link STTHexbinPickInfo}, or `null` for
   * a miss. Pure — the unit-tested seam.
   *
   * Note what the fields mean here (and see the class header): `featureIndex` /
   * `object` describe the cell's first contributing feature, a representative;
   * `featureCount` is how many features the cell actually aggregates; and
   * `coordinate` is the CELL CENTROID, because that — not the representative —
   * is the thing under the cursor.
   */
  resolvePick(index: number, screen?: [number, number]): STTIdPickInfo | null {
    const buf = this.buffers;
    if (!buf || index < 0 || index >= buf.count) return null;
    const info = resolveIdPick({
      index,
      provenance: this.provenance,
      binaryByTileKey: this.binaryByTileKey,
      kind: 'hexbin',
      layerId: this.id,
      screen,
    });
    if (!info) return null;
    const agg = this.aggregate;
    const hit: STTHexbinPickInfo = {
      ...info,
      kind: 'hexbin',
      cellIndex: index,
      cell: [buf.cellIJ[index * 2], buf.cellIJ[index * 2 + 1]],
      featureCount: agg ? agg.contributors[index] : 0,
      value: agg ? agg.values[index] : 0,
      elevationValue: agg ? agg.elevationValues[index] : 0,
      coordinate: [buf.cellLngLat[index * 2], buf.cellLngLat[index * 2 + 1]],
    };
    if (info.coordinate) hit.featureCoordinate = info.coordinate;
    return hit;
  }

  /** Lazily build the id material + the per-cell `sttIdColor` attribute. */
  private ensurePickPass(): void {
    if (!this.idBundle) {
      this.idBundle = createHexbinIdMaterial({
        timeFiltered: this.opts.timeFiltered ?? true,
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
   * GPU cell pick — auto-registered into the r3f `PickController` by
   * `isIdPickable`. Renders this layer's prisms with the flat id material into
   * `picker`'s off-screen target, reads back the CELL id at CSS pixel
   * `(cssX, cssY)` and resolves it. The id material reuses the SAME vertex
   * collapse gates (the aggregate's own `sttVisible` plus the sub-step window
   * filter), so only cells drawn THIS frame are pickable, at their animated
   * height. `resolvePick` is unit-tested; the render + readback needs a live
   * device and is browser-verify per this package's test policy.
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
    // Sync the id gates to the live play head so the pick matches the eye.
    updateHexbinUniforms(idBundle, this.uniformValues(this.currentTimeMs));

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

  // ── Teardown ──────────────────────────────────────────────────────────────

  /** Release the geometry (and the per-geometry pick attribute flag) only. */
  private disposeGeometry(): void {
    if (this.object.geometry) this.object.geometry.dispose();
    this.idColorsPresent = false;
    this.attrColor = null;
    this.attrHeight = null;
    this.attrVisible = null;
    this.attrStart = null;
    this.attrEnd = null;
  }

  dispose(): void {
    this.disposeGeometry();
    this.bundle?.material.dispose();
    this.bundle = null;
    this.idBundle?.material.dispose();
    this.idBundle = null;
  }
}

/** Copy a fresh aggregate channel into a live attribute and flag the upload. */
function fill(
  attr: InstancedBufferAttribute | null,
  values: Float32Array,
): void {
  if (!attr) return;
  (attr.array as Float32Array).set(values);
  attr.needsUpdate = true;
}
