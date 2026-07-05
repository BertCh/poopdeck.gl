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
import { getFeatureProperties, DEFAULT_SUMMARY_COLOR_RANGE } from '@poopdeck.gl/core';
import type {
  ArchiveMetadata,
  BinaryFeatures,
  SpatiotemporalTilesetOptions,
  Tile,
} from '@poopdeck.gl/core';
import { quadkeyFromTile } from '../../lib/quadbin-cell.js';
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
import type { ColorAccessorValue, NumericAccessorValue } from '../../lib/accessor-alias.js';
import { warnOnce } from '../../lib/log.js';

const DEBUG = false;

/** Props added by {@link QuadbinSummaryLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link QuadbinSummaryLayerProps}). */
export interface _QuadbinSummaryLayerProps {
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

  /** Extrusion enabled? Defaults to false (flat quads). */
  extruded?: boolean;

  /** Extrusion scale (meters per weight unit). Only used when `extruded`. */
  elevationScale?: number;

  /**
   * Coverage of each quad in its cell (0..1). Lower values leave a gap
   * between adjacent quads — useful for a heatmap-style look at low zooms.
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
   * @default true
   */
  material?: Material;

  /** Fired once per archive init with the decoded metadata. */
  onMetadataLoad?: ((meta: ArchiveMetadata) => void) | null;
}

/** Complete props accepted by {@link QuadbinSummaryLayer}. */
export type QuadbinSummaryLayerProps = _QuadbinSummaryLayerProps &
  SpatioTemporalLayerProps;

// Shared with H3SummaryLayer via @poopdeck.gl/core (audit F2) so the two
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

function makeTileKey(tile: Tile): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}`;
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
  elevationScale: 1,
  coverage: { type: 'number', value: 0.92, min: 0, max: 1 },
  filled: true,
  stroked: true,
  lineColor: { type: 'color', value: DEFAULT_LINE_COLOR },
  getLineColor: { type: 'object', value: null, optional: true, compare: true },
  lineWidth: { type: 'number', value: 1, min: 0 },
  getLineWidth: { type: 'object', value: null, optional: true, compare: true },
  lineWidthUnits: 'meters',
  lineWidthScale: 1,
  lineWidthMinPixels: { type: 'number', value: 0, min: 0 },
  lineWidthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER },
  lineJointRounded: false,
  lineMiterLimit: 4,
  lineDashJustified: false,
  wireframe: false,
  // Same permissive descriptor SolidPolygonLayer uses: boolean or material spec.
  material: { type: 'object', value: true, compare: true },
  onMetadataLoad: { type: 'function', value: null, optional: true },
};

/**
 * Render the SERVER-AGGREGATED summary tier of an STT archive as Quadbin
 * (mercator quad) cells. Companion to {@link SpatioTemporalLayer} for the raw
 * tier and to {@link H3SummaryLayer} for the H3 summary variant.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`quadbins`**.
 * `_subLayerProps: { quadbins: { type: MyLayer, ...props } }` swaps the
 * sublayer class (default `QuadkeyLayer`) / overrides sublayer props (deck's
 * CompositeLayer contract).
 */
export class QuadbinSummaryLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_QuadbinSummaryLayerProps>> {
  static layerName = 'QuadbinSummaryLayer';

  static defaultProps = defaultProps;

  /** Per-tile prepared-data cache. Pruned to the live tile set every render. */
  private preparedTileCache = new Map<string, PreparedTile>();

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
  private sublayerCache = new Map<
    string,
    { layer: QuadkeyLayer<PreparedQuadRow>; preparedKey: PreparedTile; styleKey: string }
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
   * QuadkeyLayer. One entry per cell: { quadkey, weight }.
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
    // the high 32 bits on `featureIds64`. Quadbin cells use the full u64
    // (header + zoom + interleaved x/y), so the 32-bit `featureIds` mirror —
    // which carries only the low half — is deliberately NOT used here.
    const featureIds64 = binary.featureIds64;

    const weights = binary.numericProps[weightProp];
    if (!weights) {
      if (DEBUG) {
        console.warn(
          `[QuadbinSummaryLayer] tile missing weight property '${weightProp}'`,
        );
      }
      return null;
    }

    const rows: PreparedQuadRow[] = [];
    let weightMin = Infinity;
    let weightMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const quadkey = quadkeyFromTile(featureIds64, i);
      if (quadkey === null) continue;
      const w = weights[i];
      rows.push({ quadkey, weight: w, sourceIndex: i });
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
   * Accessor-alias resolution (audit B1): the upstream-named alias wins when
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
            lineColor.join(','),
            this.props.updateTriggers?.getLineColor,
          ],
          getLineWidth: [lineWidth, this.props.updateTriggers?.getLineWidth],
        },
      });
      // `_subLayerProps: { quadbins: { type } }` swaps the sublayer class.
      const SubLayerClass = this.getSubLayerClass('quadbins', QuadkeyLayer as any);
      const layer = new SubLayerClass(subProps as any) as QuadkeyLayer<PreparedQuadRow>;
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
   */
  getPickingInfo({ info, sourceLayer }: GetPickingInfoParams): SpatioTemporalPickingInfo {
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
          out.object = { ...props, quadkey: row.quadkey, weight: row.weight };
        }
      }
    }
    return out;
  }
}
