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
  updateTriggersDigest,
} from '../../lib/style-digest.js';
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

  /** Fired once per archive init with the decoded metadata. */
  onMetadataLoad?: ((meta: ArchiveMetadata) => void) | null;
}

/** Complete props accepted by {@link QuadbinSummaryLayer}. */
export type QuadbinSummaryLayerProps = _QuadbinSummaryLayerProps &
  SpatioTemporalLayerProps;

// Shared with H3SummaryLayer via @poopdeck.gl/core (audit F2) so the two
// summary-tier ramps can't drift apart.
const DEFAULT_COLOR_RANGE = DEFAULT_SUMMARY_COLOR_RANGE as Color[];

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
    const styleKey =
      `${this.props.extruded ? 1 : 0}|${this.props.elevationScale ?? 1}` +
      `|${this.props.coverage ?? 0.92}|${this.props.pickable ? 1 : 0}` +
      `|${this.props.opacity ?? 1}|${domain[0]}|${domain[1]}` +
      `|${weightProp}|${colorListDigest(this.props.colorRange ?? DEFAULT_COLOR_RANGE)}` +
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
        // updateTriggers ensures deck.gl rebuilds the fill-color and elevation
        // buffers when the props they read from change.
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
