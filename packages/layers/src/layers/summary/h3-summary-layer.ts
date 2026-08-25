// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * H3SummaryLayer — render the SERVER-AGGREGATED summary tier as H3 hexagons.
 *
 * The summary tier collapses 100M+ raw features into one row per H3 cell
 * (with `count` + per-column aggregates) at the server side, then ships those
 * rows as Arrow tiles indexed by (zoom, x, y, time-bucket) just like the
 * raw tier. At low zooms this is the ONLY way to render a planet-scale
 * point dataset in real time — the raw tier would push hundreds of millions
 * of points through the GPU every frame.
 *
 * Each summary tile carries:
 * - `id`     — H3 cell index, encoded as a u64 (carried by Arrow's UInt64
 *              `id` column and exposed on `BinaryFeatures.featureIds`).
 * - `count`  — feature count for that cell.
 * - `<agg>_<col>` — one numeric column per aggregated attribute.
 *
 * The layer wraps deck.gl's H3HexagonLayer (from `@deck.gl/geo-layers`),
 * giving us highPrecision-aware polygon rendering, GPU-side picking, and
 * the standard extruded/coverage style props.
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
 * archive opts into intra-bucket animation.
 *
 * NOT USED (deliberate): each cell also carries its own `[startTimes,
 * endTimes]` — the min/max feature time observed in that cell within the bucket
 * (`summary.rs` `agg.time_start`/`time_end`). Gating cells on that extent
 * overlapping the play head would animate EVERY summary archive, but it makes
 * the visible row set a function of the continuous play head rather than of a
 * baked column: the prepared-row arrays would have to be rebuilt for every
 * visible tile on every tick, with no bound like the sub-bucket crossing gives,
 * and the result would change what existing archives draw depending on how
 * `timeWindow` compares to `temporalBucketMs`. The extents still reach the app
 * through picking (`start_time` / `end_time` on `info.object`).
 *
 * ARCHITECTURE: extends {@link SpatioTemporalLayer} and reuses ALL of its
 * archive/tileset plumbing (init + supersession race guards, rAF-coalesced
 * tile-load updates, throttled animation ticks, byte-budgeted cache,
 * onViewportLoad/onTileLoad/onTileError/loadOptions, viewport-bounds
 * memoization). The summary-tier specifics ride the base's two subclass
 * hooks — {@link onMetadataLoaded} (onMetadataLoad callback + no-tier
 * warning) and {@link getTilesetOptionOverrides} (summary tier dispatch,
 * tier zoom range, 'no-overlap' refinement) — plus a {@link getZoomLevel}
 * override that clamps to the tier's zoom band and a {@link _handleTimeUpdate}
 * override that re-renders on a sub-bucket crossing. Historically this class
 * duplicated ~270 lines of that plumbing and had already drifted (missing
 * rAF coalescing and `maxCacheByteSize`).
 */

import type {
  Color,
  DefaultProps,
  GetPickingInfoParams,
  Layer,
  LayerContext,
  Material,
  Unit,
} from '@deck.gl/core';
import { H3HexagonLayer } from '@deck.gl/geo-layers';
import {
  getFeatureProperties,
  tileKey,
  DEFAULT_SUMMARY_COLOR_RANGE,
} from '@poopdeck.gl/core';
import type {
  ArchiveMetadata,
  BinaryFeatures,
  SpatioTemporalTilesetOptions,
  SummaryTier,
  Tile,
} from '@poopdeck.gl/core';
import { splitLongToH3Index } from 'h3-js';
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

/** Props added by {@link H3SummaryLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link H3SummaryLayerProps}). */
export interface _H3SummaryLayerProps {
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
   * DELIBERATE DEFAULT DRIFT: `false` here vs deck's `H3HexagonLayer` default
   * of `true`. The summary tier's job is a legible planet-scale CHOROPLETH at
   * z0–5, where extruding every cell occludes the cells behind it and the
   * height carries no information the colour doesn't. Pass `extruded: true` for
   * deck parity (and for the 3-D look at higher summary zooms).
   * @default false
   */
  extruded?: boolean;

  /** Extrusion scale (meters per weight unit). Only used when `extruded`. */
  elevationScale?: number;

  /**
   * Coverage of each hex in its cell (0..1), inset toward the cell centroid.
   * Lower values leave a gap between adjacent hexes — the heatmap-style look at
   * low zooms. Forwarded to `H3HexagonLayer.coverage`, which really does honour
   * it (`_getForwardProps` forwards it, and both the hi-fi polygon and the
   * ColumnLayer path scale by it).
   * @default 0.92
   */
  coverage?: number;

  /* ── Outline / stroke family (H3HexagonLayer pass-throughs) ─────────────
   * The wrapped H3HexagonLayer forwards these to its internal PolygonLayer /
   * ColumnLayer. They were never surfaced, so the outline was pinned at the
   * deck defaults (a black 1px hex border you could neither recolor nor
   * disable). Same documented tile-seam overdraw caveat as the fill: outlines
   * double-draw along tile boundaries. */

  /**
   * Draw the per-hex outline stroke (the hex-grid look). Matches deck's
   * H3HexagonLayer default.
   * @default true
   */
  stroked?: boolean;

  /**
   * Fill each hex. Set `false` (with `stroked: true`) for an outline-only
   * hex grid.
   * @default true
   */
  filled?: boolean;

  /**
   * Draw the extruded-prism edges as a wireframe. Only visible when
   * `extruded: true`.
   * @default false
   */
  wireframe?: boolean;

  /**
   * Outline color — a constant {@link Color}. The wrapped sublayer's
   * `getLineColor` was stuck at deck's default black; this surfaces it.
   * @default [0, 0, 0, 255]
   */
  lineColor?: Color;

  /**
   * Upstream-vocabulary alias of {@link lineColor}. NOTE: unlike upstream
   * deck.gl this accepts a constant {@link Color} only (the summary outline is
   * one color for the whole grid — there is no per-cell stroke column); a
   * function accessor or a column-name string warns/ignores and falls back to
   * `lineColor`. When set to a constant Color, it wins over `lineColor`.
   */
  getLineColor?: ColorAccessorValue | null;

  /**
   * Outline width — a constant number, interpreted in {@link lineWidthUnits}
   * and clamped by `lineWidthMinPixels`/`lineWidthMaxPixels`. Only drawn when
   * `stroked: true`.
   * @default 1
   */
  lineWidth?: number;

  /**
   * Upstream-vocabulary alias of {@link lineWidth} (constant number only — no
   * per-cell width column; a function accessor warns once and falls back to
   * `lineWidth`). When set, it wins over `lineWidth`.
   */
  getLineWidth?: NumericAccessorValue | null;

  /**
   * Units for {@link lineWidth}. Deck parity: world-space meters.
   * @default 'meters'
   */
  lineWidthUnits?: Unit;

  /**
   * Outline width multiplier.
   * @default 1
   */
  lineWidthScale?: number;

  /**
   * Minimum on-screen outline width in pixels — the practical lever that keeps
   * hex-grid borders visible at summary zooms (meters-based widths collapse
   * below a pixel when zoomed out).
   * @default 0
   */
  lineWidthMinPixels?: number;

  /**
   * Maximum on-screen outline width in pixels.
   * @default Number.MAX_SAFE_INTEGER
   */
  lineWidthMaxPixels?: number;

  /**
   * Lighting material for extruded hexes — H3HexagonLayer pass-through.
   * Applies only when `extruded: true`. `true` uses the default lit material.
   * @default true
   */
  material?: Material | boolean;

  /**
   * High-precision hexagon rendering. `true` renders every cell as a real
   * (hi-fi) polygon; `false` uses deck's instanced-column fast path.
   *
   * `'auto'` (the default) is resolved HERE rather than forwarded, because
   * upstream's own 'auto' costs an O(cells) WASM scan per tile:
   * `H3HexagonLayer._calculateH3DataProps` breaks early only when
   * `!this.props.highPrecision`, and the string `'auto'` is truthy — so it
   * calls `getResolution()` AND `isPentagon()` for every row, breaking only on
   * a multi-resolution set or a pentagon. A summary tier has exactly one
   * resolution per zoom (`SummaryTier.cellResolutionPerZoom`) and there are 12
   * pentagons on the planet, so that scan runs to completion on nearly every
   * tile (zooming `earthquakes-summary` ≈ 100 tiles × 3k cells = ~600k
   * emscripten calls in one frame burst). This layer instead reads the tier's
   * resolution for the tile's zoom and forwards a CONCRETE boolean, which makes
   * upstream skip the scan in both directions. The rule mirrors
   * `_shouldUseHighPrecision`: hi-fi on a non-Mercator (globe) viewport or at
   * resolution ≤ 5. DIVERGENCE: the per-cell pentagon check is dropped — the 12
   * pentagon cells render as ordinary hexagons on the column path. Pass an
   * explicit `true` if you need them exact.
   * @default 'auto'
   */
  highPrecision?: boolean | 'auto';

  /**
   * Hexagon whose projected shape is reused for every instanced column on the
   * `highPrecision: false` path. Defaults to the cell nearest the viewport
   * centre; pin it when the set has a stable centre of mass and you want the
   * geometry to stop being re-derived as the camera moves. Ignored on the
   * hi-fi path (real per-cell polygons). H3HexagonLayer pass-through.
   * @default null
   */
  centerHexagon?: string | null;

  /** Fired once per archive init with the decoded metadata. */
  onMetadataLoad?: ((meta: ArchiveMetadata) => void) | null;
}

/** Complete props accepted by {@link H3SummaryLayer}. */
export type H3SummaryLayerProps = _H3SummaryLayerProps &
  SpatioTemporalLayerProps;

// Shared with QuadbinSummaryLayer via @poopdeck.gl/core so the two
// summary-tier ramps can't drift apart.
const DEFAULT_COLOR_RANGE = DEFAULT_SUMMARY_COLOR_RANGE as Color[];

/**
 * Cached per-tile rows array. We keep the source `BinaryFeatures` reference
 * inside the row objects so callers can introspect — but the H3HexagonLayer
 * only needs the `hex` string + the weight number.
 */
interface PreparedHexRow {
  /** H3 cell index as a string (h3-js's canonical form). */
  hex: string;
  /** Raw weight column value. */
  weight: number;
  /**
   * Feature row in the source layer's BinaryFeatures. Rows skip cells whose
   * H3 index failed to decode, so the rows-array index is NOT the feature
   * index — picking needs this to decode the cell's aggregated columns.
   */
  sourceIndex: number;
}

interface PreparedTile {
  tileKey: string;
  rows: PreparedHexRow[];
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
 * {@link H3SummaryLayer.renderLayers} must build the live set with this same
 * function or it evicts nothing.
 */
function prepareKey(
  tile: Tile,
  weightProp: string,
  subBucket: number | null,
): string {
  const base = `${makeTileKey(tile)}:${weightProp}`;
  return subBucket === null ? base : `${base}:b${subBucket}`;
}

/**
 * TS port of `SummaryTier::resolution_for_zoom` (crates/stt-core/src/
 * metadata.rs): the table is indexed by `zoom - minZoom` and clamped to the
 * tier's band. Returns null when the archive baked no table.
 */
function tierResolutionForZoom(tier: SummaryTier, zoom: number): number | null {
  const table = tier.cellResolutionPerZoom;
  if (!table || table.length === 0) return null;
  if (zoom <= tier.minZoom) return table[0];
  if (zoom >= tier.maxZoom) return table[table.length - 1];
  return table[zoom - tier.minZoom] ?? table[table.length - 1];
}

/**
 * Convert the BigUint64 H3 cell index at row `i` into the canonical 15-char
 * hex-string form that h3-js consumes. The Rust builder packs the full
 * cell index into the Arrow `id` UInt64 column; the TS decoder copies it
 * into `binary.featureIds64` so the high 32 bits survive.
 */
function h3IndexFromTile(
  featureIds64: BigUint64Array | undefined,
  i: number,
): string | null {
  if (!featureIds64 || i >= featureIds64.length) return null;
  const v = featureIds64[i];
  const lower = Number(v & 0xffffffffn) >>> 0;
  const upper = Number((v >> 32n) & 0xffffffffn) >>> 0;
  return splitLongToH3Index(lower, upper);
}

// Upstream idiom: module-level const typed `DefaultProps<XxxLayerProps>` then
// assigned to the static — the named annotation keeps the emitted .d.ts
// portable (the inferred mapped type used to surface transitive-dep types,
// which motivated the previous `static defaultProps: any`).
const defaultProps: DefaultProps<H3SummaryLayerProps> = {
  ...SpatioTemporalLayer.defaultProps,
  // Summary tiles are few but row-heavy; the historical cap predates the
  // shared base and is kept so behaviour doesn't change under the merge.
  maxCacheSize: 500,
  weightProperty: 'count',
  colorRange: { type: 'array', value: DEFAULT_COLOR_RANGE, compare: true },
  colorDomain: { type: 'array', value: null, compare: true, optional: true },
  extruded: false,
  elevationScale: { type: 'number', value: 1, min: 0 },
  coverage: { type: 'number', value: 0.92, min: 0, max: 1 },
  // Outline / stroke family — deck's H3HexagonLayer (→ PolygonLayer) defaults,
  // matching the black hex border deck draws implicitly while making it
  // recolorable / disablable.
  stroked: true,
  filled: true,
  wireframe: false,
  lineColor: { type: 'color', value: [0, 0, 0, 255] },
  // Accessor-named aliases (see the prop docs): unset so the legacy prop wins
  // unless the caller opts into the upstream vocabulary.
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
  // Permissive descriptor (the one every other layer in the package uses): a
  // bare `true` parses as `{type: 'boolean'}`, whose comparator is
  // `Boolean(a) === Boolean(b)`, so swapping one material SPEC OBJECT for
  // another diffs as unchanged and lighting never updates on a paused map.
  material: { type: 'object', value: true, compare: true },
  highPrecision: 'auto',
  centerHexagon: { type: 'object', value: null, optional: true },
  onMetadataLoad: { type: 'function', value: null, optional: true },
};

/**
 * Render the SERVER-AGGREGATED summary tier of an STT archive as H3
 * hexagons. Companion to {@link SpatioTemporalLayer} for the raw tier.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`hexagons`**.
 * `_subLayerProps: { hexagons: { type: MyLayer, ...props } }` swaps the
 * sublayer class (default `H3HexagonLayer`) / overrides sublayer props
 * (deck's CompositeLayer contract).
 */
/** One cached per-tile H3HexagonLayer plus the keys it was built for. */
interface CachedH3Sublayer {
  layer: H3HexagonLayer<PreparedHexRow>;
  preparedKey: PreparedTile;
  styleKey: string;
}

/**
 * Everything the render path caches between frames, in ONE bag so it can live
 * on `this.state` and survive deck's `_transferState`. See
 * {@link H3SummaryLayer.h3Caches}.
 */
interface H3Caches {
  prepared: Map<string, PreparedTile>;
  /**
   * Decoded H3 index strings per tile, keyed by `makeTileKey(tile)` ALONE.
   *
   * Split out of {@link prepared} because the two have different lifetimes.
   * A prepared tile is keyed by `(tile, weightProperty, subBucket)` — the
   * sub-bucket advances with the PLAYHEAD, so during playback every crossing
   * of a sub-bucket boundary misses that cache and rebuilds the tile's rows
   * from scratch. The cell ids are not part of what changed: they are a pure
   * function of the tile's `id` column, invariant across every sub-bucket and
   * every weight property. Rebuilding them meant re-running
   * `splitLongToH3Index` — a 15-char string allocation per cell — for every
   * cell of every resident tile on every boundary crossing, which on a
   * row-heavy tier (`maxCacheSize` is 500 tiles here) is the dominant cost of
   * an animating summary layer.
   *
   * `null` entries are kept, not skipped: a cell whose id does not decode is
   * a permanent property of the tile, and re-deriving that per sub-bucket is
   * the same waste as re-deriving the ones that do.
   */
  hexIds: Map<string, (string | null)[]>;
  sublayers: Map<string, CachedH3Sublayer>;
  tilesRef: Tile[] | null;
  pruneKey: string | null;
  subBucketTick: number | null;
}

const H3_CACHE_SLOT = '_sttH3Caches';

function freshH3Caches(): H3Caches {
  return {
    prepared: new Map(),
    hexIds: new Map(),
    sublayers: new Map(),
    tilesRef: null,
    pruneKey: null,
    subBucketTick: null,
  };
}

export class H3SummaryLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_H3SummaryLayerProps>> {
  static layerName = 'H3SummaryLayer';

  static defaultProps = defaultProps;

  /**
   * Render caches, held on `this.state` rather than in class FIELDS.
   *
   * deck's `_transferState` moves only `state`/`internalState` onto the
   * instance React hands it each render; class-field initializers re-run on
   * that instance. Held as fields, every unmemoized `new H3SummaryLayer({...})`
   * in a React render discarded the whole per-tile cache — re-running the
   * O(cells) `splitLongToH3Index` decode and re-allocating one JS row object
   * per cell for every visible tile, plus constructing a fresh H3HexagonLayer
   * per tile: exactly the cost the {@link sublayerCache} note below calls the
   * dominant steady-state expense. `AnimatedTripsLayer` fixed this first.
   */
  private get h3Caches(): H3Caches {
    return this.stateSlot(H3_CACHE_SLOT, freshH3Caches);
  }

  // The accessors below keep the historical field NAMES (the shared harnesses
  // and sibling layers speak them) while the storage lives on `state`.

  /** Per-tile prepared-data cache. Pruned to the live tile set every render. */
  private get preparedTileCache(): Map<string, PreparedTile> {
    return this.h3Caches.prepared;
  }
  private set preparedTileCache(value: Map<string, PreparedTile>) {
    this.h3Caches.prepared = value;
  }

  /** Per-tile decoded H3 index strings. See {@link H3Caches.hexIds}. */
  private get hexIdCache(): Map<string, (string | null)[]> {
    return this.h3Caches.hexIds;
  }

  /**
   * Per-tile H3HexagonLayer instance cache. Same idea as the animated layers'
   * `sublayerCache`: returning the SAME H3HexagonLayer reference for a tile
   * across renderLayers() lets deck.gl short-circuit the prop-diff pass for
   * that tile entirely. Without this we constructed and prop-diff'd a fresh
   * H3HexagonLayer per visible cell-tile per render — at ~hundreds of summary
   * tiles that dominated steady-state cost on the earthquake demo.
   *
   * Invalidated keys:
   *  - `preparedKey`: the prepared-data object (changes when the tile's rows
   *    change OR the weight property changed).
   *  - `styleKey`: layer-level style props that we bake into the H3HexagonLayer
   *    at construction time (extruded, coverage, opacity, domain, etc.).
   */
  private get sublayerCache(): Map<string, CachedH3Sublayer> {
    return this.h3Caches.sublayers;
  }
  private set sublayerCache(value: Map<string, CachedH3Sublayer>) {
    this.h3Caches.sublayers = value;
  }
  private get lastTilesRef(): Tile[] | null {
    return this.h3Caches.tilesRef;
  }
  private set lastTilesRef(value: Tile[] | null) {
    this.h3Caches.tilesRef = value;
  }

  /**
   * Weight column + active sub-bucket at the last prune. Both are baked into
   * the cache keys but neither changes `state.tiles`' identity, so gating the
   * prune on the tile reference alone leaked one cache generation per distinct
   * value — bounded only by `#tiles × #weight-columns-ever-used`, which defeats
   * the byte budget under a column-cycling UI.
   */
  private get lastPruneKey(): string | null {
    return this.h3Caches.pruneKey;
  }
  private set lastPruneKey(value: string | null) {
    this.h3Caches.pruneKey = value;
  }

  /**
   * Global sub-bucket index at the last tick that forced a re-render. Only
   * meaningful when the tier declares sub-buckets; `null` otherwise.
   */
  private get lastSubBucketTick(): number | null {
    return this.h3Caches.subBucketTick;
  }
  private set lastSubBucketTick(value: number | null) {
    this.h3Caches.subBucketTick = value;
  }

  finalizeState(context: LayerContext): void {
    // Base handles controller unsubscribe, the pending tile-load rAF, and
    // tileset/archive teardown.
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.hexIdCache.clear();
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
   * supersession race guard): surface the metadata to the app and warn when
   * the archive has no summary tier — the layer renders nothing then, which
   * usually means the archive was built without `--summary-tier`.
   */
  protected onMetadataLoaded(metadata: ArchiveMetadata): void {
    this.props.onMetadataLoad?.(metadata);
    if (!metadata.summaryTier) {
      warnOnce(
        `H3SummaryLayer:noTier:${this.props.data}`,
        `[H3SummaryLayer] archive ${this.props.data} has no summary tier; ` +
          'rebuild with `stt-build --summary-tier h3` to enable.',
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
   * H3HexagonLayer. One entry per cell: { hex, weight }.
   *
   * Every `return null` here means a blank map, so each one names itself once
   * on the console. The failure modes are all silent otherwise: a typo'd
   * `weightProperty`, an archive whose `id` column decoded as UInt32 (so every
   * `h3IndexFromTile` returns null), or a `summaryTier.layerName` that doesn't
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
        `H3SummaryLayer:noSummaryLayer:${this.props.id}:${summaryLayerName}`,
        `[H3SummaryLayer] tile ${makeTileKey(tile)} carries no layer named ` +
          `'${summaryLayerName}' (has: ${tile.layers.map((l) => l.name).join(', ') || 'none'}). ` +
          "A one-off is a zoom-race artefact; a blank map means the tier's " +
          '`layer_name` and the tile contents disagree.',
      );
      return null;
    }
    const binary = layer.features;
    const n = binary.featureCount;
    if (n === 0) return null;

    // The Arrow `id` column is UInt64 in the writer; the decoder preserves
    // the high 32 bits on `featureIds64`. H3 cells at resolution ≥ 7 need
    // the full u64. The 32-bit `featureIds` is still populated but only
    // carries the low half — we deliberately do NOT use it here.
    const featureIds64 = binary.featureIds64;
    if (!featureIds64) {
      warnOnce(
        `H3SummaryLayer:noFeatureIds64:${this.props.id}`,
        `[H3SummaryLayer] summary tile ${makeTileKey(tile)} has no ` +
          '`featureIds64` — the H3 cell index IS the 64-bit `id` column, so ' +
          'there is nothing to render. Usually means the archive wrote `id` as ' +
          'UInt32 (or omitted it); rebuild the summary tier with a current ' +
          '`stt-build`.',
      );
      return null;
    }

    const weights = binary.numericProps[weightProp];
    if (!weights) {
      warnOnce(
        `H3SummaryLayer:missingWeight:${this.props.id}:${weightProp}`,
        `[H3SummaryLayer] summary tiles carry no numeric column ` +
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
          `H3SummaryLayer:missingSubBucket:${this.props.id}`,
          `[H3SummaryLayer] summaryTier.subBuckets declares sub-buckets but ` +
            `tile ${makeTileKey(tile)} has no 'bucket_${subBucket}' column. ` +
            'Falling back to the whole-bucket aggregate (the map will jump at ' +
            'outer-bucket boundaries instead of animating within them).',
        );
      }
    }

    // Cell ids are invariant across weight property and sub-bucket, so they
    // are decoded once per TILE and reused by every later (re)prepare — see
    // {@link H3Caches.hexIds}.
    const hexKey = makeTileKey(tile);
    let hexes = this.hexIdCache.get(hexKey);
    if (!hexes) {
      hexes = new Array<string | null>(n);
      for (let i = 0; i < n; i++) hexes[i] = h3IndexFromTile(featureIds64, i);
      this.hexIdCache.set(hexKey, hexes);
    }

    const rows: PreparedHexRow[] = [];
    let weightMin = Infinity;
    let weightMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const hex = hexes[i];
      if (!hex) continue;
      // A cell with no activity in the active slice is not drawn at all —
      // that (not a colour change) is what makes the summary tier animate
      // INSIDE a temporal tile instead of only at bucket boundaries.
      if (subWeights && !(subWeights[i] > 0)) continue;
      // `count` is the sub-bucketed quantity; any other aggregate keeps its
      // bucket-wide value (the builder bakes no per-sub-bucket aggregates).
      const w =
        subWeights && weightProp === 'count' ? subWeights[i] : weights[i];
      rows.push({ hex, weight: w, sourceIndex: i });
      if (w < weightMin) weightMin = w;
      if (w > weightMax) weightMax = w;
    }
    if (rows.length === 0) {
      // Empty because the slice is empty is normal; empty because NO cell id
      // decoded is a bug worth naming.
      if (!subWeights) {
        warnOnce(
          `H3SummaryLayer:noDecodableCells:${this.props.id}`,
          `[H3SummaryLayer] none of tile ${makeTileKey(tile)}'s ${n} cells ` +
            `yielded an H3 index (featureIds64 holds ${featureIds64.length} ` +
            'entries). The `id` column must carry the H3 cell index verbatim, ' +
            'one per feature — check that the archive was built with ' +
            '`--summary-tier h3` (a quadbin tier needs QuadbinSummaryLayer).',
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
   * Resolve `highPrecision: 'auto'` to a concrete boolean for a tile at
   * `tileZoom` — see the {@link _H3SummaryLayerProps.highPrecision} doc for why
   * forwarding `'auto'` is the expensive option. Returns `'auto'` unchanged only
   * when the archive baked no `cellResolutionPerZoom` table to decide with.
   */
  private resolveHighPrecision(tileZoom: number): boolean | 'auto' {
    const configured = this.props.highPrecision;
    if (configured !== 'auto') return configured;
    const tier = this.state.metadata?.summaryTier;
    const resolution = tier ? tierResolutionForZoom(tier, tileZoom) : null;
    if (resolution === null) return 'auto';
    // Same two clauses as H3HexagonLayer._shouldUseHighPrecision that we can
    // evaluate without touching the rows: a non-Mercator viewport (globe) sets
    // `viewport.resolution`, and coarse cells are too irregular for the shared
    // instanced column.
    if (this.isNonMercatorViewport()) return true;
    return resolution <= 5;
  }

  /** True on a globe / non-Mercator viewport (deck sets `viewport.resolution`). */
  private isNonMercatorViewport(): boolean {
    return Boolean((this.context as any)?.viewport?.resolution);
  }

  /**
   * Accessor-alias resolution: the upstream-named `getLineColor`
   * alias wins when set to a constant Color; a function-valued alias (or a
   * column-name string, which a summary outline can't source per-cell) warns
   * once / is ignored and falls back to the `lineColor` constant.
   */
  private lineColorValue(): Color {
    const resolved = resolveAccessorAlias(
      'H3SummaryLayer',
      'getLineColor',
      this.props.getLineColor as Color | undefined,
      this.props.lineColor ?? ([0, 0, 0, 255] as Color),
    );
    // The outline is a single constant color for the whole grid; a stray
    // column-name string has no per-cell source here, so coerce to the
    // constant default rather than forward an invalid accessor.
    return Array.isArray(resolved)
      ? resolved
      : (this.props.lineColor ?? ([0, 0, 0, 255] as Color));
  }

  /**
   * Accessor-alias resolution for the constant outline width: `getLineWidth`
   * wins when set to a number; a function/column value warns/ignores and falls
   * back to the `lineWidth` constant.
   */
  private lineWidthValue(): number {
    // Widen T to `number | string` so a column-name-shaped `getLineWidth`
    // type-checks (the summary outline has no per-cell width source, so a
    // string is coerced back to the constant below).
    const resolved = resolveAccessorAlias<number | string>(
      'H3SummaryLayer',
      'getLineWidth',
      this.props.getLineWidth,
      this.props.lineWidth ?? 1,
    );
    return typeof resolved === 'number'
      ? resolved
      : (this.props.lineWidth ?? 1);
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
      // The hex-id cache keys on the TILE alone, so it needs its own live set
      // — reusing `live` would evict every entry the moment the sub-bucket
      // advanced, which is exactly the churn that cache exists to stop.
      const liveTiles = new Set<string>();
      for (const tile of tiles) {
        live.add(prepareKey(tile, weightProp, subBucketOf(tile)));
        liveTiles.add(makeTileKey(tile));
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      for (const key of this.hexIdCache.keys()) {
        if (!liveTiles.has(key)) this.hexIdCache.delete(key);
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

    // Resolve the constant outline color/width ONCE per render (they're
    // layer-level, not per-cell) so both the style digest and the sublayer
    // props see the same accessor-alias-resolved value.
    const lineColor = this.lineColorValue();
    const lineWidth = this.lineWidthValue();

    // Layer-level style digest — when ANY of these change every cached
    // H3HexagonLayer is stale and we rebuild. The domain is included so a
    // streaming-in tile that widens the auto-fit domain invalidates the
    // cache (otherwise the rampColor accessor would be stale). colorRange is
    // keyed by CONTENT (memoized digest), not length — a same-size ramp swap
    // must invalidate cached sublayers, same fix as the animated layers'
    // palettes. The outline/stroke family is folded in too so a stroke restyle
    // rebuilds the cached hexagons. Inherited composite props (getSubLayerProps
    // surface + _subLayerProps) and the user's updateTriggers ride the key too.
    const styleKey =
      `${this.props.extruded ? 1 : 0}|${this.props.elevationScale ?? 1}` +
      `|${this.props.coverage ?? 0.92}|${this.props.pickable ? 1 : 0}` +
      `|${this.props.opacity ?? 1}|${domain[0]}|${domain[1]}` +
      `|${weightProp}|${colorListDigest(this.props.colorRange ?? DEFAULT_COLOR_RANGE)}` +
      `|st${this.props.stroked ? 1 : 0}|fl${this.props.filled ? 1 : 0}` +
      `|wf${this.props.wireframe ? 1 : 0}` +
      `|lc${Array.isArray(lineColor) ? lineColor.join(',') : ''}|lw${lineWidth}` +
      `|lwu${this.props.lineWidthUnits}|lws${this.props.lineWidthScale}` +
      `|lwmin${this.props.lineWidthMinPixels}|lwmax${this.props.lineWidthMaxPixels}` +
      // structuralDigest, not the hand-rolled true/false/JSON.stringify key it
      // replaces — the permissive `material` descriptor now diffs spec objects
      // properly, and this keeps the cache key honest about nested values.
      `|mat${structuralDigest(this.props.material)}` +
      // `highPrecision` resolves PER TILE (it reads the tier resolution for the
      // tile's zoom), so only the inputs to that resolution belong here: the
      // configured prop and whether the viewport is a globe.
      `|hp${this.props.highPrecision}|gl${this.isNonMercatorViewport() ? 1 : 0}` +
      `|ch${this.props.centerHexagon ?? ''}` +
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
      // system, highlight props, …) + user `_subLayerProps.hexagons`
      // overrides. The user's own updateTriggers are merged INTO the
      // computed trigger arrays (not replaced by them).
      const subProps = this.composeSubLayerProps('hexagons', prepared.tileKey, {
        // TileLayer convention: the source tile rides on the sublayer so
        // getPickingInfo can enrich info.tile / decode the cell's aggregated
        // columns.
        tile: prepared.tile,
        sttFeatures: prepared.features,
        data: prepared.rows,
        // Use the cached prepared rows reference so deck.gl can short-circuit
        // re-upload when only style props changed.
        dataComparator: (a: any, b: any) => a === b,
        getHexagon: (d: PreparedHexRow) => d.hex,
        getFillColor: (d: PreparedHexRow) => this.rampColor(d.weight, domain),
        getElevation: this.props.extruded
          ? (d: PreparedHexRow) => d.weight * (this.props.elevationScale ?? 1)
          : 0,
        extruded: !!this.props.extruded,
        coverage: this.props.coverage ?? 0.92,
        // Outline / stroke family — pass-throughs to H3HexagonLayer's internal
        // PolygonLayer / ColumnLayer. getLineColor/getLineWidth are constants
        // (the summary outline is one style for the whole grid), not per-cell
        // accessors.
        stroked: this.props.stroked,
        filled: this.props.filled,
        wireframe: this.props.wireframe,
        getLineColor: lineColor,
        getLineWidth: lineWidth,
        lineWidthUnits: this.props.lineWidthUnits,
        lineWidthScale: this.props.lineWidthScale,
        lineWidthMinPixels: this.props.lineWidthMinPixels,
        lineWidthMaxPixels: this.props.lineWidthMaxPixels,
        material: this.props.material,
        // Concrete boolean, not `'auto'` — see resolveHighPrecision().
        highPrecision: this.resolveHighPrecision(tile.id.z),
        centerHexagon: this.props.centerHexagon ?? null,
        // updateTriggers ensures deck.gl rebuilds the fill-color and elevation
        // buffers when the props they read from change. The constant outline
        // color/width ride triggers too so a restyle re-evaluates them even if
        // the (rebuilt) sublayer were somehow diffed rather than replaced.
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
            Array.isArray(lineColor) ? lineColor.join(',') : '',
            this.props.updateTriggers?.getLineColor,
          ],
          getLineWidth: [lineWidth, this.props.updateTriggers?.getLineWidth],
        },
      });
      // `_subLayerProps: { hexagons: { type } }` swaps the sublayer class.
      const SubLayerClass = this.getSubLayerClass(
        'hexagons',
        H3HexagonLayer as any,
      );
      const layer = new SubLayerClass(
        subProps as any,
      ) as H3HexagonLayer<PreparedHexRow>;
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
   * TileLayer-convention picking enrichment, H3 flavour. Unlike the binary
   * animated layers, the H3HexagonLayer sublayers carry real JS rows, so
   * `info.object` already arrives as a {@link PreparedHexRow}; this swaps it
   * for the cell's FULL aggregated columns (decoded via `row.sourceIndex` —
   * the rows array skips undecodable cells, so its index is not the feature
   * index), keeping `hex`/`weight` keys for continuity.
   *
   * `id` is DECIMAL-STRINGIFIED. `getFeatureProperties` reads it from
   * `featureIds64`, which summary tiles always carry, so `info.object.id` was
   * always a `bigint` — and the first `JSON.stringify(info.object)` in a
   * `getTooltip` or a devtools panel threw `TypeError: Do not know how to
   * serialize a BigInt`. A string keeps all 64 bits (a Number would not) and
   * the canonical `cell` / `hex` keys carry the human-readable H3 index.
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
      const row = info.object as PreparedHexRow | undefined;
      if (row && typeof row.sourceIndex === 'number' && sprops?.sttFeatures) {
        const props = getFeatureProperties(sprops.sttFeatures, row.sourceIndex);
        if (props) {
          out.object = {
            ...props,
            id: typeof props.id === 'bigint' ? props.id.toString() : props.id,
            cell: row.hex,
            hex: row.hex,
            weight: row.weight,
          };
        }
      }
    }
    return out;
  }
}
