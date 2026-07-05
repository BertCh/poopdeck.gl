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
 * ARCHITECTURE: extends {@link SpatioTemporalLayer} and reuses ALL of its
 * archive/tileset plumbing (init + supersession race guards, rAF-coalesced
 * tile-load updates, throttled animation ticks, byte-budgeted cache,
 * onViewportLoad/onTileLoad/onTileError/loadOptions, viewport-bounds
 * memoization). The summary-tier specifics ride the base's two subclass
 * hooks — {@link onMetadataLoaded} (onMetadataLoad callback + no-tier
 * warning) and {@link getTilesetOptionOverrides} (summary tier dispatch,
 * tier zoom range, 'no-overlap' refinement) — plus a {@link getZoomLevel}
 * override that clamps to the tier's zoom band. Historically this class
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
import { getFeatureProperties, DEFAULT_SUMMARY_COLOR_RANGE } from '@poopdeck.gl/core';
import type {
  ArchiveMetadata,
  BinaryFeatures,
  SpatiotemporalTilesetOptions,
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
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
} from '../../lib/accessor-alias.js';
import { warnOnce } from '../../lib/log.js';

const DEBUG = false;

/** Props added by {@link H3SummaryLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link H3SummaryLayerProps}). */
export interface _H3SummaryLayerProps {
  /**
   * Numeric property the color ramp + extrusion height are driven by.
   * Defaults to `'count'` (the implicit cell-count column). Any aggregated
   * column from the summary tier is also valid (`'mean_magnitude'`,
   * `'sum_value'`, ...).
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

  /** Extrusion enabled? Defaults to false (flat hexagons). */
  extruded?: boolean;

  /** Extrusion scale (meters per weight unit). Only used when `extruded`. */
  elevationScale?: number;

  /**
   * Coverage of each hex in its cell (0..1). Lower values leave a gap
   * between adjacent hexes — useful for a heatmap-style look at low zooms.
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
   * High-precision hexagon rendering. `'auto'` picks per-cell fidelity
   * (irregular low-res cells + pentagons render hi-fi); `true`/`false` force
   * it. H3HexagonLayer pass-through.
   * @default 'auto'
   */
  highPrecision?: boolean | 'auto';

  /** Fired once per archive init with the decoded metadata. */
  onMetadataLoad?: ((meta: ArchiveMetadata) => void) | null;
}

/** Complete props accepted by {@link H3SummaryLayer}. */
export type H3SummaryLayerProps = _H3SummaryLayerProps & SpatioTemporalLayerProps;

// Shared with QuadbinSummaryLayer via @poopdeck.gl/core (audit F2) so the two
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

function makeTileKey(tile: Tile): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}`;
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
  elevationScale: 1,
  coverage: { type: 'number', value: 0.92, min: 0, max: 1 },
  // Outline / stroke family — deck's H3HexagonLayer (→ PolygonLayer) defaults,
  // preserving the previously-implicit black hex border while making it
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
  lineWidthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
  material: true,
  highPrecision: 'auto',
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
export class H3SummaryLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_H3SummaryLayerProps>
> {
  static layerName = 'H3SummaryLayer';

  static defaultProps = defaultProps;

  /** Per-tile prepared-data cache. Pruned to the live tile set every render. */
  private preparedTileCache = new Map<string, PreparedTile>();

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
  private sublayerCache = new Map<
    string,
    { layer: H3HexagonLayer<PreparedHexRow>; preparedKey: PreparedTile; styleKey: string }
  >();
  private lastTilesRef: Tile[] | null = null;

  finalizeState(context: LayerContext): void {
    // Base handles controller unsubscribe, the pending tile-load rAF, and
    // tileset/archive teardown.
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
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
  ): Partial<SpatiotemporalTilesetOptions> {
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
   */
  private prepareTile(tile: Tile, weightProp: string): PreparedTile | null {
    const tileKey = `${makeTileKey(tile)}:${weightProp}`;
    const cached = this.preparedTileCache.get(tileKey);
    if (cached) return cached;

    // Find the summary layer in the tile. Defensive: tile-decoder.worker may
    // hand us tiles whose only layer is the raw layer (e.g. on a
    // zoom-out-then-zoom-in race). We just skip those.
    const summaryLayerName =
      this.state.metadata?.summaryTier?.layerName ?? 'summary';
    const layer = tile.layers.find((l) => l.name === summaryLayerName);
    if (!layer) return null;
    const binary = layer.features;
    const n = binary.featureCount;
    if (n === 0) return null;

    // The Arrow `id` column is UInt64 in the writer; the decoder preserves
    // the high 32 bits on `featureIds64`. H3 cells at resolution ≥ 7 need
    // the full u64. The 32-bit `featureIds` is still populated but only
    // carries the low half — we deliberately do NOT use it here.
    const featureIds64 = binary.featureIds64;

    const weights = binary.numericProps[weightProp];
    if (!weights) {
      if (DEBUG) {
        console.warn(`[H3SummaryLayer] tile missing weight property '${weightProp}'`);
      }
      return null;
    }

    const rows: PreparedHexRow[] = [];
    let weightMin = Infinity;
    let weightMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const hex = h3IndexFromTile(featureIds64, i);
      if (!hex) continue;
      const w = weights[i];
      rows.push({ hex, weight: w, sourceIndex: i });
      if (w < weightMin) weightMin = w;
      if (w > weightMax) weightMax = w;
    }
    if (rows.length === 0) return null;

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
   * Accessor-alias resolution (audit B1): the upstream-named `getLineColor`
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
    return typeof resolved === 'number' ? resolved : (this.props.lineWidth ?? 1);
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

    // Skip the O(cacheSize) prune walk when the tile list reference is
    // unchanged from the last render — the live set and cached set are
    // necessarily identical.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) live.add(`${makeTileKey(tile)}:${weightProp}`);
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      for (const key of this.sublayerCache.keys()) {
        if (!live.has(key)) this.sublayerCache.delete(key);
      }
      this.lastTilesRef = tiles;
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
        const prepared = this.prepareTile(tile, weightProp);
        if (!prepared) continue;
        if (prepared.weightMin < lo) lo = prepared.weightMin;
        if (prepared.weightMax > hi) hi = prepared.weightMax;
      }
      domain = [
        Number.isFinite(lo) ? lo : 0,
        Number.isFinite(hi) ? hi : 1,
      ];
    }

    // Resolve the constant outline color/width ONCE per render (they're
    // layer-level, not per-cell) so both the style digest and the sublayer
    // props see the same accessor-alias-resolved value.
    const lineColor = this.lineColorValue();
    const lineWidth = this.lineWidthValue();
    const material = this.props.material;
    const materialKey =
      material === true ? 't' : material === false ? 'f' : JSON.stringify(material);

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
      `|mat${materialKey}|hp${this.props.highPrecision}` +
      `|${inheritedPropsDigest(this.props)}` +
      `|${updateTriggersDigest(this.props.updateTriggers)}`;

    const out: Layer[] = [];
    for (const tile of tiles) {
      const prepared = this.prepareTile(tile, weightProp);
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
        highPrecision: this.props.highPrecision,
        // updateTriggers ensures deck.gl rebuilds the fill-color and elevation
        // buffers when the props they read from change. The constant outline
        // color/width ride triggers too so a restyle re-evaluates them even if
        // the (rebuilt) sublayer were somehow diffed rather than replaced.
        updateTriggers: {
          ...this.props.updateTriggers,
          getFillColor: [
            domain[0],
            domain[1],
            this.props.colorRange,
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
      const SubLayerClass = this.getSubLayerClass('hexagons', H3HexagonLayer as any);
      const layer = new SubLayerClass(subProps as any) as H3HexagonLayer<PreparedHexRow>;
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
   */
  getPickingInfo({ info, sourceLayer }: GetPickingInfoParams): SpatioTemporalPickingInfo {
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
          out.object = { ...props, hex: row.hex, weight: row.weight };
        }
      }
    }
    return out;
  }
}
