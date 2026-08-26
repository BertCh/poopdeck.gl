// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * QuadbinSummaryLayer — render the SERVER-AGGREGATED summary tier as CARTO
 * Quadbin (Z/X/Y quad-key) cells. The Quadbin analog of {@link H3SummaryLayer}.
 *
 * The summary tier collapses 100M+ raw features into one row per cell (with
 * `count` + per-column aggregates) at the server side, then ships those rows
 * as Arrow tiles indexed by (zoom, x, y, time-bucket) just like the raw tier.
 * At low zooms this is the ONLY way to render a planet-scale point dataset in
 * real time — the raw tier would push hundreds of millions of points through
 * the GPU every frame. Where H3SummaryLayer renders the `SummaryScheme::H3`
 * variant, this class renders the `SummaryScheme::Quadbin` variant declared in
 * the same format (crates/stt-core/src/metadata.rs).
 *
 * Each summary tile carries:
 * - `id`     — Quadbin cell index, encoded as a u64 (carried by Arrow's UInt64
 *              `id` column and exposed on `BinaryFeatures.featureIds64`).
 * - `count`  — feature count for that cell.
 * - `<agg>_<col>` — one numeric column per aggregated attribute.
 *
 * The layer wraps deck.gl's `QuadkeyLayer` (from `@deck.gl/geo-layers`), which
 * renders one filled/extruded mercator quad per cell from a Bing **quadkey
 * string**. The cell u64 is converted to that string via {@link quadkeyFromTile}
 * (CARTO Quadbin u64 → `(z, x, y)` → quadkey). deck.gl 9.3.2 ships no
 * Quadbin-native layer (no `@deck.gl/carto`), so QuadkeyLayer is the canonical
 * renderer; the conversion is exact (a fixed bit re-pack), not lossy.
 *
 * COVERAGE. `QuadkeyLayer` has no `coverage` prop: `indexToBounds()` hardcodes
 * `const coverage = extruded ? 0.99 : 1`, and `GeoCellLayer.renderLayers()`
 * destructures a fixed prop list that doesn't include it — a `coverage` value
 * handed to QuadkeyLayer lands on the sublayer's props and is never read (it
 * forwards, which is exactly why it looked wired). So the default sublayer here
 * is {@link CoverageQuadkeyLayer}, a three-line QuadkeyLayer subclass whose
 * `indexToBounds()` builds the ring from {@link quadkeyPolygon} at the
 * requested coverage. `_subLayerProps.quadbins.type` still swaps it, and a
 * plain QuadkeyLayer swapped in simply loses the gap.
 *
 * Coloring: `colorRange + colorDomain` drive a built-in ramp that quantises
 * `count` (or the configured `weightProperty`) into N color buckets. There is
 * no custom color-callback prop — restyle via `colorRange`/`colorDomain`/
 * `weightProperty`.
 *
 * TIME INSIDE A TILE — sub-buckets. A summary tile is one OUTER temporal
 * bucket, so residency alone gives a map that jumps at bucket boundaries and
 * does nothing while the play head scrubs INSIDE one. `stt-build --summary-tier
 * … --summary-sub-buckets N` therefore bakes `bucket_0..bucket_<N-1>` count
 * columns per cell (`crates/stt-build/src/summary.rs`), and
 * `SummaryTier.subBuckets` declares N. When N > 1 this layer selects the column
 * the play head is inside — `floor((t − tile.id.t) / (temporalBucketMs / N))`,
 * the exact inverse of the builder's binning — drives the ramp from it, and
 * drops cells with no activity in that slice. With N == 1 (the default) there is
 * no baked intra-bucket signal, the play head changes nothing inside a tile, and
 * the layer costs exactly what it did before — `--summary-sub-buckets` is how an
 * archive opts into intra-bucket animation. Identical to {@link H3SummaryLayer}'s
 * handling, deliberately; see that file for why the per-cell `[startTimes,
 * endTimes]` extents are NOT used as a second, always-on gate.
 *
 * ARCHITECTURE: extends {@link SpatioTemporalLayer} and reuses ALL of its
 * archive/tileset plumbing (init + supersession race guards, rAF-coalesced
 * tile-load updates, throttled animation ticks, byte-budgeted cache,
 * onViewportLoad/onTileLoad/onTileError/loadOptions, viewport-bounds
 * memoization). The summary-tier specifics ride the base's two subclass
 * hooks — {@link onMetadataLoaded} (the no-tier warning) and
 * {@link getTilesetOptionOverrides} (summary tier dispatch,
 * tier zoom range, 'no-overlap' refinement) — plus a {@link getZoomLevel}
 * override that clamps to the tier's zoom band. This mirrors H3SummaryLayer
 * one-to-one; the only differences are the cell decoder, the QuadkeyLayer
 * sublayer, and the `'quadbins'` short id.
 *
 * ASSUMPTION (no Rust Quadbin builder exists yet — `stt-build` rejects
 * `--summary-tier quadbin` as "not implemented yet"): the cell u64 is taken to
 * be a CARTO Quadbin index, per the `SummaryScheme::Quadbin` doc comment
 * ("CARTO Quadbin (Z/X/Y quad-key encoded as u64)"). When the builder lands,
 * verify it writes the standard CARTO Quadbin bit layout decoded by
 * {@link quadbinToTile}; if it instead packs a raw `(z, x, y)` triple, only
 * `quadbin-cell.ts` needs adjusting — this class is encoding-agnostic.
 */

import type {
  Color,
  DefaultProps,
  GetPickingInfoParams,
  Layer,
  LayerContext,
  Material,
} from '@deck.gl/core';
import { QuadkeyLayer } from '@deck.gl/geo-layers';
import {
  getFeatureProperties,
  tileKey,
  DEFAULT_SUMMARY_COLOR_RANGE,
} from '@poopdeck.gl/core';
import type {
  ArchiveMetadata,
  BinaryFeatures,
  SpatioTemporalTilesetOptions,
  Tile,
} from '@poopdeck.gl/core';
import { quadkeyFromTile, quadkeyPolygon } from '../../lib/quadbin-cell.js';
import {
  SpatioTemporalLayer,
  type SpatioTemporalLayerProps,
  type SpatioTemporalPickingInfo,
  type SttSublayerPickingProps,
} from '../spatiotemporal-layer.js';
import {
  colorListDigest,
  inheritedPropsDigest,
  structuralDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
} from '../../lib/accessor-alias.js';
import { warnOnce } from '../../lib/log.js';

/**
 * `QuadkeyLayer` with a working `coverage`.
 *
 * Upstream's `indexToBounds()` hardcodes `coverage = extruded ? 0.99 : 1` and
 * `GeoCellLayer.renderLayers()` never destructures a `coverage` prop, so the
 * only way to inset the cell is to build the ring ourselves. `boundsProps` is
 * the LAST argument to the inner `PolygonLayer` constructor, which is why
 * `_subLayerProps.cell.getPolygon` can't reach it either — the override has to
 * live in `indexToBounds`.
 *
 * Kept a subclass (rather than a bare PolygonLayer) so `getQuadkey`, the
 * `'cell'` sublayer id, the winding, and `instanceof QuadkeyLayer` all stay
 * exactly as callers and `_subLayerProps` expect.
 */
export class CoverageQuadkeyLayer<DataT = any> extends QuadkeyLayer<DataT> {
  static layerName = 'CoverageQuadkeyLayer';

  static defaultProps = {
    coverage: { type: 'number', value: 1, min: 0, max: 1 },
  } as any;

  indexToBounds(): Partial<QuadkeyLayer['props']> | null {
    const { data, extruded, getQuadkey, coverage } = this.props as any;
    // Deck's own z-fighting guard for extruded cells: never draw a full-size
    // footprint when extruding. A caller-supplied coverage below 0.99 already
    // satisfies it, so this only clamps the top of the range.
    const inset = extruded ? Math.min(coverage ?? 1, 0.99) : (coverage ?? 1);
    return {
      data,
      _normalize: false,
      positionFormat: 'XY',
      getPolygon: (x: DataT, objectInfo: any) =>
        quadkeyPolygon(getQuadkey(x, objectInfo), inset),
      updateTriggers: { getPolygon: inset },
    } as any;
  }
}

/** Props added by {@link QuadbinSummaryLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link QuadbinSummaryLayerProps}). */
export interface _QuadbinSummaryLayerProps {
  /**
   * Numeric property the color ramp + extrusion height are driven by.
   * Defaults to `'count'` (the implicit cell-count column). Any aggregated
   * column from the summary tier is also valid (`'mean_magnitude'`,
   * `'sum_value'`, ...).
   *
   * SUB-BUCKETS: on an archive built with `--summary-sub-buckets N`, the
   * default `'count'` is replaced per frame by the `bucket_<k>` column the play
   * head is inside, so the ramp tracks activity WITHIN the tile's time bucket.
   * A non-`'count'` column keeps its own (bucket-wide) aggregate value — no
   * per-sub-bucket aggregates are baked for it — but its cells are still
   * shown/hidden by the active sub-bucket's activity.
   */
  weightProperty?: string;

  /**
   * 6-stop low→high color ramp. Each entry is RGBA (0-255). Used together
   * with `colorDomain` to bucket the weight column.
   */
  colorRange?: Color[];

  /**
   * `[min, max]` for the color ramp. Setting this pins the legend stable
   * across tiles and zoom changes (recommended). When unset, every tile's
   * own min/max drives the ramp — visually unstable.
   */
  colorDomain?: [number, number] | null;

  /**
   * Extrusion enabled?
   *
   * DELIBERATE DEFAULT DRIFT: `false` here, matching {@link H3SummaryLayer}
   * (deck's own `QuadkeyLayer`/`PolygonLayer` also default to `false`, so this
   * is only a drift relative to the H3 sibling's upstream). The summary tier's
   * job is a legible planet-scale choropleth at low zoom.
   * @default false
   */
  extruded?: boolean;

  /** Extrusion scale (meters per weight unit). Only used when `extruded`. */
  elevationScale?: number;

  /**
   * Coverage of each quad in its cell (0..1), inset toward the cell CENTROID.
   * Lower values leave a gap between adjacent quads — the heatmap-style look at
   * low zooms, and the reason {@link CoverageQuadkeyLayer} exists (upstream
   * `QuadkeyLayer` has no `coverage` prop at all). `1` reproduces upstream's
   * gapless grid.
   *
   * NOTE: deck's internal quadkey inset is anchored at the cell's north-west
   * corner; this one is centred, so cells shrink in place instead of drifting
   * up-left as coverage drops. That also matches `H3HexagonLayer.coverage`, so
   * the two summary layers look alike at the same value.
   * @default 0.92
   */
  coverage?: number;

  /**
   * Fill each cell. When `false`, cells render as outline-only (pair with
   * `stroked`). Forwarded to the QuadkeyLayer → PolygonLayer `filled` prop.
   * @default true
   */
  filled?: boolean;

  /**
   * Draw each cell's outline. The underlying PolygonLayer defaults this to
   * `true`, giving every cell an un-disable-able 1px black border — set
   * `stroked:false` for a clean heatmap-style fill.
   * @default true
   */
  stroked?: boolean;

  /**
   * Cell outline color (constant {@link Color}). Only takes effect when
   * `stroked`. Forwarded to the sublayer `getLineColor`.
   * @default [0, 0, 0, 255]
   */
  lineColor?: Color;

  /**
   * Upstream-vocabulary alias of {@link lineColor}. NOTE: unlike upstream
   * deck.gl this accepts a CONSTANT {@link Color} — NOT a per-feature function
   * (binary summary cells can't run JS accessors; a function warns once and
   * falls back to `lineColor`). When set, it wins over `lineColor`.
   */
  getLineColor?: ColorAccessorValue | null;

  /**
   * Cell outline width — a constant number, in `lineWidthUnits`. Only takes
   * effect when `stroked`. Summary cells bake no per-cell width column, so
   * (unlike the raw-tier layers) there is no data-driven form; a column-name
   * string or function warns/ignores and falls back to the constant.
   * Forwarded to the sublayer `getLineWidth`.
   * @default 1
   */
  lineWidth?: number;

  /**
   * Upstream-vocabulary alias of {@link lineWidth} (constant number only — no
   * per-cell width column; a column-name string or function warns/ignores and
   * falls back to `lineWidth`). When set, it wins over `lineWidth`.
   */
  getLineWidth?: NumericAccessorValue | null;

  /**
   * Units for `lineWidth` — `'meters'`, `'common'`, or `'pixels'`.
   * PolygonLayer pass-through.
   * @default 'meters'
   */
  lineWidthUnits?: 'meters' | 'common' | 'pixels';

  /**
   * Multiplier applied to every outline width. PolygonLayer pass-through.
   * @default 1
   */
  lineWidthScale?: number;

  /**
   * Minimum outline width in pixels — clamps the outline so 1m borders stay
   * visible at planet-scale summary zooms. PolygonLayer pass-through.
   * @default 0
   */
  lineWidthMinPixels?: number;

  /**
   * Maximum outline width in pixels. PolygonLayer pass-through.
   * @default Number.MAX_SAFE_INTEGER
   */
  lineWidthMaxPixels?: number;

  /**
   * Round the joints between outline segments. PolygonLayer pass-through.
   * @default false
   */
  lineJointRounded?: boolean;

  /**
   * Miter limit for mitered outline joints. PolygonLayer pass-through.
   * @default 4
   */
  lineMiterLimit?: number;

  /**
   * Justify dashes to segment endpoints (only meaningful with a dash array
   * supplied via the PathStyle extension). PolygonLayer pass-through.
   * @default false
   */
  lineDashJustified?: boolean;

  /**
   * Draw the edges of extruded cells as a wireframe. Only takes effect when
   * `extruded`. PolygonLayer pass-through.
   * @default false
   */
  wireframe?: boolean;

  /**
   * Lighting material for extruded cells — PolygonLayer pass-through. `true`
   * for the default phong material, `false` to disable lighting, or a
   * material spec `{ambient, diffuse, shininess, specularColor}`. Only takes
   * effect when `extruded`.
   *
   * Typed `Material | boolean` (matching {@link H3SummaryLayer} and the
   * `{type:'object', value:true}` default): the doc has always said `false`
   * disables lighting, but the narrower `Material` type made `material: false`
   * a compile error here while it type-checked on the H3 sibling.
   * @default true
   */
  material?: Material | boolean;
}

/** Complete props accepted by {@link QuadbinSummaryLayer}. */
export type QuadbinSummaryLayerProps = _QuadbinSummaryLayerProps &
  SpatioTemporalLayerProps;

// Shared with H3SummaryLayer via @poopdeck.gl/core so the two
// summary-tier ramps can't drift apart.
const DEFAULT_COLOR_RANGE = DEFAULT_SUMMARY_COLOR_RANGE as Color[];

// deck.gl PolygonLayer's own getLineColor default — the forced-on black 1px
// border the `stroked` gap is about.
const DEFAULT_LINE_COLOR: Color = [0, 0, 0, 255];

/**
 * Cached per-tile rows array. We keep the source `BinaryFeatures` reference
 * inside the row objects so callers can introspect — but the QuadkeyLayer
 * only needs the `quadkey` string + the weight number.
 */
interface PreparedQuadRow {
  /** Bing quadkey string (QuadkeyLayer's canonical cell form). */
  quadkey: string;
  /** Raw weight column value. */
  weight: number;
  /**
   * Feature row in the source layer's BinaryFeatures. Rows skip cells whose
   * Quadbin id failed to decode, so the rows-array index is NOT the feature
   * index — picking needs this to decode the cell's aggregated columns.
   */
  sourceIndex: number;
}

interface PreparedTile {
  tileKey: string;
  rows: PreparedQuadRow[];
  /** Cached min/max of `weight` across the tile. */
  weightMin: number;
  weightMax: number;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  features: BinaryFeatures;
}

/**
 * The tile's canonical identity, from core's single producer — which folds the
 * temporal-LOD tier in, so a scrub-preview tile and the base tile sharing its
 * `z/x/y/t` occupy separate cache slots instead of overwriting each other.
 */
function makeTileKey(tile: Tile): string {
  return tileKey(tile.id);
}

/**
 * Cache key for one prepared tile. The weight column and the active sub-bucket
 * both change the rows, so both ride the key — and the prune walk in
 * {@link QuadbinSummaryLayer.renderLayers} must build the live set with this
 * same function or it evicts nothing.
 */
function prepareKey(
  tile: Tile,
  weightProp: string,
  subBucket: number | null,
): string {
  const base = `${makeTileKey(tile)}:${weightProp}`;
  return subBucket === null ? base : `${base}:b${subBucket}`;
}

// Upstream idiom: module-level const typed `DefaultProps<XxxLayerProps>` then
// assigned to the static — the named annotation keeps the emitted .d.ts
// portable (the inferred mapped type used to surface transitive-dep types,
// which motivated the previous `static defaultProps: any`).
const defaultProps: DefaultProps<QuadbinSummaryLayerProps> = {
  ...SpatioTemporalLayer.defaultProps,
  // Summary tiles are few but row-heavy; the historical cap predates the
  // shared base and is kept so behaviour matches H3SummaryLayer.
  maxCacheSize: 500,
  weightProperty: 'count',
  colorRange: { type: 'array', value: DEFAULT_COLOR_RANGE, compare: true },
  colorDomain: { type: 'array', value: null, compare: true, optional: true },
  extruded: false,
  // Descriptor form, matching every sibling layer: a bare numeric literal
  // parses as `{type:'number'}` with no bounds, so deck's debug validator
  // accepted a negative elevationScale / lineWidthScale here while rejecting it
  // everywhere else in the package.
  elevationScale: { type: 'number', value: 1, min: 0 },
  coverage: { type: 'number', value: 0.92, min: 0, max: 1 },
  filled: true,
  stroked: true,
  lineColor: { type: 'color', value: DEFAULT_LINE_COLOR },
  getLineColor: { type: 'object', value: null, optional: true, compare: true },
  lineWidth: { type: 'number', value: 1, min: 0 },
  getLineWidth: { type: 'object', value: null, optional: true, compare: true },
  lineWidthUnits: 'meters',
  lineWidthScale: { type: 'number', value: 1, min: 0 },
  lineWidthMinPixels: { type: 'number', value: 0, min: 0 },
  lineWidthMaxPixels: {
    type: 'number',
    value: Number.MAX_SAFE_INTEGER,
    min: 0,
  },
  lineJointRounded: false,
  lineMiterLimit: { type: 'number', value: 4, min: 0 },
  lineDashJustified: false,
  wireframe: false,
  // Same permissive descriptor SolidPolygonLayer uses: boolean or material spec.
  material: { type: 'object', value: true, compare: true },
};

/**
 * Render the SERVER-AGGREGATED summary tier of an STT archive as Quadbin
 * (mercator quad) cells. Companion to {@link SpatioTemporalLayer} for the raw
 * tier and to {@link H3SummaryLayer} for the H3 summary variant.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`quadbins`**.
 * `_subLayerProps: { quadbins: { type: MyLayer, ...props } }` swaps the
 * sublayer class (default {@link CoverageQuadkeyLayer}, a `QuadkeyLayer` with a
 * working `coverage`) / overrides sublayer props (deck's CompositeLayer
 * contract).
 */
/** One cached per-tile QuadkeyLayer plus the keys it was built for. */
interface CachedQuadbinSublayer {
  layer: QuadkeyLayer<PreparedQuadRow>;
  preparedKey: PreparedTile;
  styleKey: string;
}

/**
 * Everything the render path caches between frames, in ONE bag so it can live
 * on `this.state` and survive deck's `_transferState`. See
 * {@link QuadbinSummaryLayer.quadbinCaches}.
 */
interface QuadbinCaches {
  prepared: Map<string, PreparedTile>;
  sublayers: Map<string, CachedQuadbinSublayer>;
  tilesRef: Tile[] | null;
  pruneKey: string | null;
  subBucketTick: number | null;
}

const QUADBIN_CACHE_SLOT = '_sttQuadbinCaches';

function freshQuadbinCaches(): QuadbinCaches {
  return {
    prepared: new Map(),
    sublayers: new Map(),
    tilesRef: null,
    pruneKey: null,
    subBucketTick: null,
  };
}

export class QuadbinSummaryLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_QuadbinSummaryLayerProps>
> {
  static layerName = 'QuadbinSummaryLayer';

  static defaultProps = defaultProps;

  /**
   * Render caches, held on `this.state` rather than in class FIELDS.
   *
   * deck's `_transferState` moves only `state`/`internalState` onto the
   * instance React hands it each render; class-field initializers re-run on
   * that instance. Held as fields, every unmemoized
   * `new QuadbinSummaryLayer({...})` in a React render discarded the whole
   * per-tile cache — re-running the O(cells) `quadbinToTile` decode and
   * re-allocating one JS row object per cell for every visible tile, plus
   * constructing a fresh QuadkeyLayer per tile: exactly the cost the
   * {@link sublayerCache} note below calls the dominant steady-state expense.
   * `AnimatedTripsLayer` fixed this first.
   */
  private get quadbinCaches(): QuadbinCaches {
    return this.stateSlot(QUADBIN_CACHE_SLOT, freshQuadbinCaches);
  }

  // The accessors below keep the historical field NAMES (the shared harnesses
  // and sibling layers speak them) while the storage lives on `state`.

  /** Per-tile prepared-data cache. Pruned to the live tile set every render. */
  private get preparedTileCache(): Map<string, PreparedTile> {
    return this.quadbinCaches.prepared;
  }
  private set preparedTileCache(value: Map<string, PreparedTile>) {
    this.quadbinCaches.prepared = value;
  }

  /**
   * Per-tile QuadkeyLayer instance cache. Same idea as the animated layers'
   * `sublayerCache`: returning the SAME QuadkeyLayer reference for a tile
   * across renderLayers() lets deck.gl short-circuit the prop-diff pass for
   * that tile entirely. Without this we constructed and prop-diff'd a fresh
   * QuadkeyLayer per visible cell-tile per render — at ~hundreds of summary
   * tiles that dominated steady-state cost.
   *
   * Invalidated keys:
   *  - `preparedKey`: the prepared-data object (changes when the tile's rows
   *    change OR the weight property changed).
   *  - `styleKey`: layer-level style props that we bake into the QuadkeyLayer
   *    at construction time (extruded, coverage, opacity, domain, etc.).
   */
  private get sublayerCache(): Map<string, CachedQuadbinSublayer> {
    return this.quadbinCaches.sublayers;
  }
  private set sublayerCache(value: Map<string, CachedQuadbinSublayer>) {
    this.quadbinCaches.sublayers = value;
  }
  private get lastTilesRef(): Tile[] | null {
    return this.quadbinCaches.tilesRef;
  }
  private set lastTilesRef(value: Tile[] | null) {
    this.quadbinCaches.tilesRef = value;
  }

  /**
   * Weight column + active sub-bucket at the last prune. Both are baked into
   * the cache keys but neither changes `state.tiles`' identity, so gating the
   * prune on the tile reference alone leaked one cache generation per distinct
   * value — bounded only by `#tiles × #weight-columns-ever-used`, which defeats
   * the byte budget under a column-cycling UI.
   */
  private get lastPruneKey(): string | null {
    return this.quadbinCaches.pruneKey;
  }
  private set lastPruneKey(value: string | null) {
    this.quadbinCaches.pruneKey = value;
  }

  /**
   * Global sub-bucket index at the last tick that forced a re-render. Only
   * meaningful when the tier declares sub-buckets; `null` otherwise.
   */
  private get lastSubBucketTick(): number | null {
    return this.quadbinCaches.subBucketTick;
  }
  private set lastSubBucketTick(value: number | null) {
    this.quadbinCaches.subBucketTick = value;
  }

  finalizeState(context: LayerContext): void {
    // Base handles controller unsubscribe, the pending tile-load rAF, and
    // tileset/archive teardown.
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  /**
   * Sub-bucket width in ms, or null when this archive carries none (the common
   * case — `subBuckets` defaults to 1). Integer-divided and floored at 1, byte
   * for byte the builder's `(bucket_ms / sub_buckets).max(1)`.
   */
  protected subBucketMs(): number | null {
    const metadata = this.state.metadata as ArchiveMetadata | undefined;
    const tier = metadata?.summaryTier;
    const n = tier?.subBuckets ?? 1;
    if (!tier || !(n > 1)) return null;
    const bucketMs = metadata?.temporalBucketMs;
    if (!bucketMs || !(bucketMs > 0)) return null;
    return Math.max(1, Math.floor(bucketMs / n));
  }

  /**
   * Index of the `bucket_<k>` column the play head is inside for `tile`, or
   * null when the archive has no sub-buckets. `tile.id.t` IS the builder's
   * `bucket_start`, so this inverts `summary.rs`'s
   * `(timestamp - bucket_start) / sub_bucket_ms` exactly; out-of-range play
   * heads clamp to the tile's first/last slice (a tile only stays resident
   * while it overlaps the window, so the clamp is the tile's own edge).
   */
  protected activeSubBucket(tile: Tile, subMs: number | null): number | null {
    if (subMs === null) return null;
    const n =
      (this.state.metadata as ArchiveMetadata | undefined)?.summaryTier
        ?.subBuckets ?? 1;
    const time = this.getCurrentTime();
    if (!Number.isFinite(time)) return 0;
    const idx = Math.floor((time - tile.id.t) / subMs);
    return Math.max(0, Math.min(n - 1, idx));
  }

  /**
   * Base tick handler + a re-render on every sub-bucket CROSSING. The base only
   * calls `setNeedsRedraw()` for time-only ticks, which never re-runs
   * `renderLayers()` — so without this the selected `bucket_<k>` column would be
   * frozen at whatever it was when the tile set last changed. Gated on the
   * index actually changing (not on wall-clock), so a 30-sub-bucket archive
   * re-renders 30× per outer bucket and a non-sub-bucketed one never pays
   * anything at all.
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    const subMs = this.subBucketMs();
    if (subMs === null) return;
    const tick = Math.floor(time / subMs);
    if (tick === this.lastSubBucketTick) return;
    this.lastSubBucketTick = tick;
    this.setState({ frameNumber: (this.state.frameNumber || 0) + 1 });
  }

  /**
   * Subclass hook (base calls it once per archive init, after the
   * supersession race guard): warn when the archive has no summary tier — the
   * layer renders nothing then, which usually means the archive was built
   * without `--summary-tier`. The `onMetadataLoad` callback itself is fired by
   * the base for EVERY layer now, so firing it again here would double-call it.
   */
  protected onMetadataLoaded(metadata: ArchiveMetadata): void {
    if (!metadata.summaryTier) {
      warnOnce(
        `QuadbinSummaryLayer:noTier:${this.props.data}`,
        `[QuadbinSummaryLayer] archive ${this.props.data} has no summary tier; ` +
          'rebuild with `stt-build --summary-tier quadbin` to enable.',
      );
    }
  }

  /**
   * Subclass hook: summary-tier tileset wiring, spread over the base options
   * (overrides win). The tier's zoom band replaces the raw tier's, summary
   * dispatch is forced on, and 'no-overlap' refinement replaces the raw
   * tier's parent-fallback (a parent SUMMARY tile under a finer view would
   * double-draw aggregated cells).
   */
  protected getTilesetOptionOverrides(
    metadata: ArchiveMetadata,
  ): Partial<SpatioTemporalTilesetOptions> {
    const tier = metadata.summaryTier;
    return {
      tier: 'summary',
      minZoom: tier ? tier.minZoom : metadata.minZoom,
      maxZoom: tier ? tier.maxZoom : metadata.maxZoom,
      refinementStrategy: 'no-overlap',
    };
  }

  /** Clamp to the summary tier's zoom band (not the raw tier's). */
  protected getZoomLevel(viewport: any): number {
    const tier = this.state.metadata?.summaryTier;
    if (tier && this.props.zoomOverride == null) {
      const z = Math.floor(viewport.zoom);
      return Math.max(tier.minZoom, Math.min(tier.maxZoom, z));
    }
    return super.getZoomLevel(viewport);
  }

  /**
   * Build (or fetch from cache) the per-tile data array consumed by
   * QuadkeyLayer. One entry per cell: { quadkey, weight }.
   *
   * Every `return null` here means a blank map, so each one names itself once
   * on the console. The failure modes are all silent otherwise: a typo'd
   * `weightProperty`, an archive whose `id` column decoded as UInt32 (so every
   * `quadkeyFromTile` returns null), or a `summaryTier.layerName` that doesn't
   * match the tile — none of which fire the archive-level "no summary tier"
   * warning, because the tier IS present.
   */
  private prepareTile(
    tile: Tile,
    weightProp: string,
    subBucket: number | null,
  ): PreparedTile | null {
    const tileKey = prepareKey(tile, weightProp, subBucket);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached) return cached;

    // Find the summary layer in the tile. Defensive: tile-decoder.worker may
    // hand us tiles whose only layer is the raw layer (e.g. on a
    // zoom-out-then-zoom-in race). We just skip those.
    const summaryLayerName =
      this.state.metadata?.summaryTier?.layerName ?? 'summary';
    const layer = tile.layers.find((l) => l.name === summaryLayerName);
    if (!layer) {
      warnOnce(
        `QuadbinSummaryLayer:noSummaryLayer:${this.props.id}:${summaryLayerName}`,
        `[QuadbinSummaryLayer] tile ${makeTileKey(tile)} carries no layer ` +
          `named '${summaryLayerName}' (has: ${tile.layers.map((l) => l.name).join(', ') || 'none'}). ` +
          "A one-off is a zoom-race artefact; a blank map means the tier's " +
          '`layer_name` and the tile contents disagree.',
      );
      return null;
    }
    const binary = layer.features;
    const n = binary.featureCount;
    if (n === 0) return null;

    // The Arrow `id` column is UInt64 in the writer; the decoder preserves
    // the high 32 bits on `featureIds64`. Quadbin cells use the full u64
    // (header + zoom + interleaved x/y), so the 32-bit `featureIds` mirror —
    // which carries only the low half — is deliberately NOT used here.
    const featureIds64 = binary.featureIds64;
    if (!featureIds64) {
      warnOnce(
        `QuadbinSummaryLayer:noFeatureIds64:${this.props.id}`,
        `[QuadbinSummaryLayer] summary tile ${makeTileKey(tile)} has no ` +
          '`featureIds64` — the Quadbin cell index IS the 64-bit `id` column, ' +
          'so there is nothing to render. Usually means the archive wrote `id` ' +
          'as UInt32 (or omitted it); rebuild the summary tier with a current ' +
          '`stt-build`.',
      );
      return null;
    }

    const weights = binary.numericProps[weightProp];
    if (!weights) {
      warnOnce(
        `QuadbinSummaryLayer:missingWeight:${this.props.id}:${weightProp}`,
        `[QuadbinSummaryLayer] summary tiles carry no numeric column ` +
          `'${weightProp}' (weightProperty). Available: ` +
          `${Object.keys(binary.numericProps).join(', ') || 'none'}. ` +
          'Nothing will render until it names one of those.',
      );
      return null;
    }

    // Sub-bucket column for the play head's slice, when the tier bakes them.
    let subWeights: Float32Array | undefined;
    if (subBucket !== null) {
      subWeights = binary.numericProps[`bucket_${subBucket}`] as
        | Float32Array
        | undefined;
      if (!subWeights) {
        warnOnce(
          `QuadbinSummaryLayer:missingSubBucket:${this.props.id}`,
          `[QuadbinSummaryLayer] summaryTier.subBuckets declares sub-buckets ` +
            `but tile ${makeTileKey(tile)} has no 'bucket_${subBucket}' ` +
            'column. Falling back to the whole-bucket aggregate (the map will ' +
            'jump at outer-bucket boundaries instead of animating within them).',
        );
      }
    }

    const rows: PreparedQuadRow[] = [];
    let weightMin = Infinity;
    let weightMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const quadkey = quadkeyFromTile(featureIds64, i);
      if (quadkey === null) continue;
      // A cell with no activity in the active slice is not drawn at all —
      // that (not a colour change) is what makes the summary tier animate
      // INSIDE a temporal tile instead of only at bucket boundaries.
      if (subWeights && !(subWeights[i] > 0)) continue;
      // `count` is the sub-bucketed quantity; any other aggregate keeps its
      // bucket-wide value (the builder bakes no per-sub-bucket aggregates).
      const w =
        subWeights && weightProp === 'count' ? subWeights[i] : weights[i];
      rows.push({ quadkey, weight: w, sourceIndex: i });
      if (w < weightMin) weightMin = w;
      if (w > weightMax) weightMax = w;
    }
    if (rows.length === 0) {
      // Empty because the slice is empty is normal; empty because NO cell id
      // decoded is a bug worth naming.
      if (!subWeights) {
        warnOnce(
          `QuadbinSummaryLayer:noDecodableCells:${this.props.id}`,
          `[QuadbinSummaryLayer] none of tile ${makeTileKey(tile)}'s ${n} cell ` +
            'ids decoded to a valid Quadbin index. The `id` column must carry ' +
            'the CARTO Quadbin cell index verbatim — check that the archive ' +
            'was built with `--summary-tier quadbin` (an h3 tier needs ' +
            'H3SummaryLayer).',
        );
      }
      return null;
    }

    const prepared: PreparedTile = {
      tileKey,
      rows,
      weightMin: weightMin === Infinity ? 0 : weightMin,
      weightMax: weightMax === -Infinity ? 0 : weightMax,
      tile,
      features: binary,
    };
    this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /**
   * Quantise `value` into a color from `colorRange`, using the active
   * color domain. Returns the last colour for values above the domain max.
   */
  private rampColor(value: number, domain: [number, number]): Color {
    const range = this.props.colorRange ?? DEFAULT_COLOR_RANGE;
    const [lo, hi] = domain;
    if (!Number.isFinite(value) || hi <= lo) return range[0];
    const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
    const idx = Math.min(range.length - 1, Math.floor(t * range.length));
    return range[idx];
  }

  /**
   * Accessor-alias resolution: the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy
   * `lineColor` constant. Column-name strings are not meaningful for a cell
   * outline color (a single numeric cell column can't be RGBA), so a
   * non-array result falls back to the default constant.
   */
  private lineColorValue(): Color {
    const v = resolveAccessorAlias(
      'QuadbinSummaryLayer',
      'getLineColor',
      this.props.getLineColor as Color | undefined,
      this.props.lineColor,
    );
    return Array.isArray(v) ? (v as Color) : DEFAULT_LINE_COLOR;
  }

  /**
   * Accessor-alias resolution for the constant outline width. A column-name
   * string falls back to the constant `1` (summary cells bake no per-cell
   * line-width column), matching AnimatedPointLayer's getLineWidth handling.
   */
  private lineWidthValue(): number {
    const v = resolveAccessorAlias(
      'QuadbinSummaryLayer',
      'getLineWidth',
      this.props.getLineWidth,
      this.props.lineWidth,
    );
    return typeof v === 'number' ? v : 1;
  }

  renderLayers(): Layer[] {
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) return [];

    const weightProp = this.props.weightProperty ?? 'count';
    // Active sub-bucket column, per tile (each tile has its own bucket start).
    const subMs = this.subBucketMs();
    const subBucketOf = (tile: Tile) => this.activeSubBucket(tile, subMs);

    // Skip the O(cacheSize) prune walk when NOTHING that keys the caches has
    // changed. The tile-list reference alone is not enough: `weightProperty`
    // and the active sub-bucket are both baked into the cache keys but neither
    // touches `state.tiles`, so gating on the reference alone retained one full
    // cache generation per value ever used.
    //
    // The sub-bucket half of the signature is the GLOBAL slice tick, not a
    // per-tile index: every tile shares `subMs`, so it advances exactly when any
    // tile's column selection can change — and unlike a per-tile index it can't
    // sit clamped at a band edge while its neighbours move.
    const pruneKey = `${weightProp}|${
      subMs === null ? '' : Math.floor(this.getCurrentTime() / subMs)
    }`;
    if (this.lastTilesRef !== tiles || this.lastPruneKey !== pruneKey) {
      const live = new Set<string>();
      for (const tile of tiles) {
        live.add(prepareKey(tile, weightProp, subBucketOf(tile)));
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      for (const key of this.sublayerCache.keys()) {
        if (!live.has(key)) this.sublayerCache.delete(key);
      }
      this.lastTilesRef = tiles;
      this.lastPruneKey = pruneKey;
    }

    // Resolve the color domain ONCE per render. When the caller pins it via
    // props we use that; otherwise we fall back to the max across visible
    // tiles. The fallback gives a usable display out of the box but is
    // visually unstable when tiles stream in — pinning is recommended.
    let domain: [number, number];
    if (this.props.colorDomain) {
      domain = this.props.colorDomain;
    } else {
      let lo = Infinity;
      let hi = -Infinity;
      for (const tile of tiles) {
        const prepared = this.prepareTile(tile, weightProp, subBucketOf(tile));
        if (!prepared) continue;
        if (prepared.weightMin < lo) lo = prepared.weightMin;
        if (prepared.weightMax > hi) hi = prepared.weightMax;
      }
      domain = [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 1];
    }

    // Layer-level style digest — when ANY of these change every cached
    // QuadkeyLayer is stale and we rebuild. The domain is included so a
    // streaming-in tile that widens the auto-fit domain invalidates the
    // cache (otherwise the rampColor accessor would be stale). colorRange is
    // keyed by CONTENT (memoized digest), not length — a same-size ramp swap
    // must invalidate cached sublayers, same fix as the animated layers'
    // palettes. Inherited composite props (getSubLayerProps surface +
    // _subLayerProps) and the user's updateTriggers ride the key too.
    const lineColor = this.lineColorValue();
    const lineWidth = this.lineWidthValue();
    const styleKey =
      `${this.props.extruded ? 1 : 0}|${this.props.elevationScale ?? 1}` +
      `|${this.props.coverage ?? 0.92}|${this.props.pickable ? 1 : 0}` +
      `|${this.props.opacity ?? 1}|${domain[0]}|${domain[1]}` +
      `|${weightProp}|${colorListDigest(this.props.colorRange ?? DEFAULT_COLOR_RANGE)}` +
      // Stroke / fill / extrusion-lighting props — each changes GPU output, so
      // a change must invalidate every cached QuadkeyLayer.
      `|${this.props.filled ? 1 : 0}|${this.props.stroked ? 1 : 0}` +
      `|${lineColor.join(',')}|${lineWidth}` +
      `|${this.props.lineWidthUnits}|${this.props.lineWidthScale}` +
      `|${this.props.lineWidthMinPixels}|${this.props.lineWidthMaxPixels}` +
      `|${this.props.lineJointRounded ? 1 : 0}|${this.props.lineMiterLimit}` +
      `|${this.props.lineDashJustified ? 1 : 0}|${this.props.wireframe ? 1 : 0}` +
      `|${structuralDigest(this.props.material)}` +
      `|${inheritedPropsDigest(this.props)}` +
      `|${updateTriggersDigest(this.props.updateTriggers)}`;

    const out: Layer[] = [];
    for (const tile of tiles) {
      const prepared = this.prepareTile(tile, weightProp, subBucketOf(tile));
      if (!prepared) continue;
      const cached = this.sublayerCache.get(prepared.tileKey);
      if (
        cached &&
        cached.preparedKey === prepared &&
        cached.styleKey === styleKey
      ) {
        out.push(cached.layer);
        continue;
      }
      // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
      // system, highlight props, …) + user `_subLayerProps.quadbins`
      // overrides. The user's own updateTriggers are merged INTO the
      // computed trigger arrays (not replaced by them).
      const subProps = this.composeSubLayerProps('quadbins', prepared.tileKey, {
        // TileLayer convention: the source tile rides on the sublayer so
        // getPickingInfo can enrich info.tile / decode the cell's aggregated
        // columns.
        tile: prepared.tile,
        sttFeatures: prepared.features,
        data: prepared.rows,
        // Use the cached prepared rows reference so deck.gl can short-circuit
        // re-upload when only style props changed.
        dataComparator: (a: any, b: any) => a === b,
        getQuadkey: (d: PreparedQuadRow) => d.quadkey,
        getFillColor: (d: PreparedQuadRow) => this.rampColor(d.weight, domain),
        getElevation: this.props.extruded
          ? (d: PreparedQuadRow) => d.weight * (this.props.elevationScale ?? 1)
          : 0,
        extruded: !!this.props.extruded,
        // Read by CoverageQuadkeyLayer.indexToBounds(), NOT by upstream
        // QuadkeyLayer (which has no coverage prop) — see the class doc.
        coverage: this.props.coverage ?? 0.92,
        // Fill / stroke / extrusion-lighting pass-throughs → QuadkeyLayer →
        // GeoCellLayer → PolygonLayer. `stroked` (default true upstream) is
        // the un-disable-able-black-border escape hatch.
        filled: this.props.filled,
        stroked: this.props.stroked,
        getLineColor: lineColor,
        getLineWidth: lineWidth,
        lineWidthUnits: this.props.lineWidthUnits,
        lineWidthScale: this.props.lineWidthScale,
        lineWidthMinPixels: this.props.lineWidthMinPixels,
        lineWidthMaxPixels: this.props.lineWidthMaxPixels,
        lineJointRounded: this.props.lineJointRounded,
        lineMiterLimit: this.props.lineMiterLimit,
        lineDashJustified: this.props.lineDashJustified,
        wireframe: this.props.wireframe,
        material: this.props.material,
        // updateTriggers ensures deck.gl rebuilds the fill-color, elevation,
        // and outline buffers when the props they read from change.
        updateTriggers: {
          ...this.props.updateTriggers,
          getFillColor: [
            domain[0],
            domain[1],
            // CONTENT digest, not the array itself: trigger elements are
            // strict-compared, but `colorRange` is `{type:'array',
            // compare:true}` — so the ordinary React idiom of a fresh-but-equal
            // array literal flipped this trigger every render and rebuilt the
            // fill-colour attribute for every cell in every tile.
            colorListDigest(this.props.colorRange ?? DEFAULT_COLOR_RANGE),
            weightProp,
            this.props.updateTriggers?.getFillColor,
          ],
          getElevation: [
            this.props.extruded,
            this.props.elevationScale,
            this.props.updateTriggers?.getElevation,
          ],
          getLineColor: [
            lineColor.join(','),
            this.props.updateTriggers?.getLineColor,
          ],
          getLineWidth: [lineWidth, this.props.updateTriggers?.getLineWidth],
        },
      });
      // `_subLayerProps: { quadbins: { type } }` swaps the sublayer class.
      const SubLayerClass = this.getSubLayerClass(
        'quadbins',
        CoverageQuadkeyLayer as any,
      );
      const layer = new SubLayerClass(
        subProps as any,
      ) as QuadkeyLayer<PreparedQuadRow>;
      this.sublayerCache.set(prepared.tileKey, {
        layer,
        preparedKey: prepared,
        styleKey,
      });
      out.push(layer);
    }
    return out;
  }

  /**
   * TileLayer-convention picking enrichment, Quadbin flavour. Unlike the
   * binary animated layers, the QuadkeyLayer sublayers carry real JS rows, so
   * `info.object` already arrives as a {@link PreparedQuadRow}; this swaps it
   * for the cell's FULL aggregated columns (decoded via `row.sourceIndex` —
   * the rows array skips undecodable cells, so its index is not the feature
   * index), keeping `quadkey`/`weight` keys for continuity.
   *
   * `id` is DECIMAL-STRINGIFIED. `getFeatureProperties` reads it from
   * `featureIds64`, which summary tiles always carry, so `info.object.id` was
   * always a `bigint` — and the first `JSON.stringify(info.object)` in a
   * `getTooltip` or a devtools panel threw `TypeError: Do not know how to
   * serialize a BigInt`. A string keeps all 64 bits (a Number would not) and
   * the canonical `cell` / `quadkey` keys carry the readable cell address.
   */
  getPickingInfo({
    info,
    sourceLayer,
  }: GetPickingInfoParams): SpatioTemporalPickingInfo {
    const out = info as SpatioTemporalPickingInfo;
    const sprops = sourceLayer?.props as SttSublayerPickingProps | undefined;
    const tile = sprops?.tile ?? null;
    out.sourceTile = tile;
    if (info.index >= 0 && tile) {
      out.tile = tile;
      const row = info.object as PreparedQuadRow | undefined;
      if (row && typeof row.sourceIndex === 'number' && sprops?.sttFeatures) {
        const props = getFeatureProperties(sprops.sttFeatures, row.sourceIndex);
        if (props) {
          out.object = {
            ...props,
            id: typeof props.id === 'bigint' ? props.id.toString() : props.id,
            cell: row.quadkey,
            quadkey: row.quadkey,
            weight: row.weight,
          };
        }
      }
    }
    return out;
  }
}
