// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedLineLayer - GPU-efficient origin→destination flow rendering with time
 * filtering.
 *
 * Operates in WINDOW MODE: each OD flow is shown (with optional fade) when its
 * `[startTime, endTime]` overlaps the current time window. Renders deck.gl's
 * `LineLayer` — a straight line from each feature's SOURCE endpoint to its
 * TARGET endpoint. The flat-line sibling of {@link AnimatedArcLayer}.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One LineLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Tiles store flows as LineString features; this layer derives dense
 *   source/target endpoint buffers (first/last vertex of each feature) once per
 *   tile via {@link deriveSourceTargetPositions} and feeds them through
 *   LineLayer's instanced binary `data: { length, attributes }` interface. The
 *   start/end time attributes ride zero-copy from the tile's BinaryFeatures.
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its own
 *   TimeFilterExtension instance.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation.
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 */

import { LineLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer, LayerContext } from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { TimeFilterExtension } from '../../extensions/time-filter-extension.js';
import { STTDataFilterExtension } from '../../extensions/data-filter-extension.js';
import type { DataFilterRange } from '../../extensions/data-filter-extension.js';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
  appendNullCategorySlot,
  categoryIndicesToFloat32,
} from '../../extensions/category-color-extension.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import {
  colorListDigest,
  colorMappingDigest,
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
  WeightAccessorValue,
} from '../../lib/accessor-alias.js';
import { deriveSourceTargetPositions } from '../../lib/od-positions.js';
import { DEFAULT_LINE_PALETTE } from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedLineLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedLineLayerProps}). */
export interface _AnimatedLineLayerProps {
  /**
   * Line color — constant {@link Color}, or property name for categorical
   * coloring. LineLayer interpolates one color across each line, so the
   * categorical GPU path colors the whole line by the named column.
   * @default [0, 150, 255, 255]
   */
  color?: Color | string;
  /**
   * Upstream-vocabulary (LineLayer) alias of {@link color}. NOTE: unlike
   * upstream deck.gl, this accepts a constant Color OR a property-column NAME —
   * NOT a function accessor (binary tiles can't run per-feature JS; a function
   * warns once and falls back to `color`). When set, it wins over `color`.
   */
  getColor?: ColorAccessorValue | null;
  /**
   * Line width — constant number, or property name for per-feature width.
   * @default 1
   */
  width?: number | string;
  /**
   * Upstream-vocabulary alias of {@link width}. Accepts a constant number OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `width`). When set, it wins over `width`.
   */
  getWidth?: NumericAccessorValue | null;
  /**
   * Units for line width.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters' | 'common';
  /**
   * Width multiplier.
   * @default 1
   */
  widthScale?: number;
  /** Clamp line width to at least this many on-screen pixels. */
  widthMinPixels?: number;
  /** Clamp line width to at most this many on-screen pixels. */
  widthMaxPixels?: number;
  /**
   * Color palette for categorical `color`.
   */
  colorPalette?: Color[];
  /**
   * Explicit category-string → color map for a categorical `color`. Resolved
   * per-tile against each tile's own category dictionary, so a category renders
   * the SAME color in every tile (unlike `colorPalette`, whose indices are
   * assigned per-tile in first-seen order). Takes precedence over
   * `colorPalette` when set. Mirrors `AnimatedTripsLayer.colorMapping`.
   * @default null
   */
  colorMapping?: Record<string, Color> | null;
  /** Fallback color for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;
  /**
   * GPU range filter — the NAME of a baked numeric column to filter lines by
   * (installs {@link STTDataFilterExtension}). Lines whose value in this column
   * falls inside {@link filterRange} render; the rest are hidden (or soft-faded
   * via {@link filterSoftRange}). Composes WITH the time filter — a line must
   * pass both the time window and the column range.
   *
   * Accessor-alias of deck.gl's `getFilterValue`: pass a column NAME, not a
   * function (STT tiles are binary — a function warns once and is ignored).
   * Unset (the default) ⇒ the extension is not installed at all: zero
   * attribute, zero uniform, zero shader change. A tile that lacks the named
   * column renders unfiltered (the filter idles for that tile).
   * @default null
   */
  filterProperty?: WeightAccessorValue | null;
  /**
   * Inclusive `[min, max]` bounds for {@link filterProperty}. `null` (default)
   * means "no range yet" — the column is still bound, so a range set later
   * animates purely by uniform with no tile re-preparation. No effect unless
   * `filterProperty` is set.
   * @default null
   */
  filterRange?: DataFilterRange | null;
  /**
   * Optional soft `[min, max]` inside {@link filterRange}: lines between the
   * soft and hard bounds fade rather than hard-clip. No effect unless
   * `filterProperty` + `filterRange` are set.
   * @default null
   */
  filterSoftRange?: DataFilterRange | null;
  /**
   * Enable/disable the column filter without dropping the bound attribute.
   * Effective only when `filterProperty` + a valid `filterRange` are set.
   * @default true
   */
  filterEnabled?: boolean;
  /**
   * Fade-in duration for appearing lines (ms).
   * @default 300
   */
  fadeInDuration?: number;
  /**
   * Fade-out duration for disappearing lines (ms).
   * @default 300
   */
  fadeOutDuration?: number;
}

/** Complete props accepted by {@link AnimatedLineLayer}. */
export type AnimatedLineLayerProps = _AnimatedLineLayerProps &
  SpatioTemporalLayerProps;

const DEFAULT_COLOR: Color = [0, 150, 255, 255];
const DEFAULT_MAPPING_DEFAULT: Color = [120, 120, 120, 255];

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_LINE_PALETTE;

/**
 * Build a per-tile palette by mapping the tile's own category dictionary
 * through an explicit string→color map. Because `instanceCategoryIndex`
 * indexes into the same per-tile `categories` array, the resulting palette
 * makes each category render the same color in every tile. Mirrors
 * `AnimatedTripsLayer.paletteFromMapping`.
 */
function paletteFromMapping(
  categories: string[],
  mapping: Record<string, Color>,
  fallback: Color,
): Color[] {
  return categories.map((c) => mapping[c] ?? fallback);
}

/** See AnimatedPathLayer for the rationale; same cache shape, source/target attrs. */
interface PreparedTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    attributes: Record<
      string,
      { value: any; size: number; normalized?: boolean }
    >;
  };
  timeOffset: number;
  dims: number;
  /** Resolved palette when GPU categorical-color path is active for this tile. */
  gpuPalette: Color[] | null;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  features: BinaryFeatures;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Animated line layer (window mode) with per-tile binary sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`lines`**.
 * `_subLayerProps: { lines: { type: MyLayer, ...props } }` swaps the sublayer
 * class / overrides sublayer props (deck's CompositeLayer contract). Without a
 * `type` override the class is the stock `LineLayer` (it carries fewer
 * attributes than PathLayer, so picking works directly without the
 * NoPickingPathLayer attribute-budget workaround the path family needs).
 */
export class AnimatedLineLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_AnimatedLineLayerProps>> {
  static layerName = 'AnimatedLineLayer';

  static defaultProps: DefaultProps<AnimatedLineLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    widthUnits: 'pixels',
    widthScale: { type: 'number', value: 1, min: 0 },
    widthMinPixels: { type: 'number', value: 0, min: 0 },
    widthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    // Permissive descriptors ({type:'object'} validates anything): these props
    // legally hold a constant OR a column-name string, which the 'color' /
    // 'number' validators would reject in deck's debug mode.
    color: { type: 'object', value: [0, 150, 255, 255], compare: true },
    width: { type: 'object', value: 1, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getColor: { type: 'object', value: null, optional: true, compare: true },
    getWidth: { type: 'object', value: null, optional: true, compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    // Explicit string→color map. compare:false — its content is folded into the
    // per-tile styleKey (via colorMappingDigest), so deck never diffs it.
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    colorMappingDefault: { type: 'color', value: [120, 120, 120, 255] },
    // Column range filter (STTDataFilterExtension). Unset ⇒ not installed.
    // Permissive {type:'object'} descriptors: filterProperty holds a column
    // name; the ranges hold a [min,max] tuple OR null (rejected by 'array').
    filterProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    filterRange: { type: 'object', value: null, optional: true, compare: true },
    filterSoftRange: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    filterEnabled: true,
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };

  private preparedTileCache = new Map<string, PreparedTile>();
  /**
   * Per-tile sublayer-instance cache — see AnimatedPathLayer for the rationale.
   * Returning the SAME LineLayer reference across renderLayers() calls lets
   * deck.gl short-circuit the prop diff for unchanged tiles.
   */
  private sublayerCache = new Map<
    string,
    { layer: LineLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedPathLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;
  /**
   * Line layer is window-mode only (whole feature on/off + fade), so only the
   * per-feature start/end pair is registered. The trail-mode per-vertex time
   * attribute is unused.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({
    mode: 'window',
  });
  private readonly categoryColorExtension = new CategoryColorExtension();
  /**
   * Singleton STTDataFilterExtension. Composed into a sublayer's extension list
   * ONLY when `filterProperty` is set (a per-layer constant, so the list stays
   * stable across this layer's sublayers). Constructed unconditionally — a
   * no-op object alloc; it contributes no attribute, uniform or shader unless
   * actually installed. Mirrors {@link AnimatedPointLayer}.
   */
  private readonly dataFilterExtension = new STTDataFilterExtension({
    filterSize: 1,
  });
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  /**
   * Resolve `filterProperty` to a baked-column NAME. Accessor-alias of deck's
   * `getFilterValue`: a function-valued prop warns once and is ignored (there
   * is no legacy prop, so the fallback is "no filter" — `undefined`).
   */
  private filterPropertyValue(): string | undefined {
    return resolveAccessorAlias<string | undefined>(
      'AnimatedLineLayer',
      'filterProperty',
      this.props.filterProperty,
      undefined,
    );
  }

  /**
   * Accessor-alias resolution (audit B1): the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy prop.
   * Same value domain as the legacy props (constant or column name).
   */
  private colorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedLineLayer',
      'getColor',
      this.props.getColor,
      this.props.color,
    );
  }

  private widthValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedLineLayer',
      'getWidth',
      this.props.getWidth,
      this.props.width,
    );
  }

  private computeLayerPropsKey(): string {
    const color = this.colorValue();
    const width = this.widthValue();
    return [
      this.props.widthUnits,
      this.props.widthScale,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinate system, _subLayerProps, …) plus
      // the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      this.props.timeWindow,
      this.props.timeHeightScale,
      this.props.timeHeightOrigin,
      Array.isArray(color) ? color.join(',') : '',
      typeof width === 'number' ? width : 0,
      // Column-filter uniforms (STTDataFilterExtension). A range/enabled change is
      // a uniform-only edit, so — like timeWindow — it rebuilds the cached
      // sublayers (whose props carry the values) rather than re-preparing tiles.
      Array.isArray(this.props.filterRange)
        ? this.props.filterRange.join(',')
        : '',
      Array.isArray(this.props.filterSoftRange)
        ? this.props.filterSoftRange.join(',')
        : '',
      this.props.filterEnabled,
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Skip O(cacheSize) prune walks when the parent re-rendered with the same
    // tile-array ref — the live and cached sets are then identical.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tileLayer of tile.layers)
          live.add(makeTileKey(tile, tileLayer));
      }
      for (const key of this.preparedTileCache.keys()) {
        if (!live.has(key)) this.preparedTileCache.delete(key);
      }
      for (const key of this.sublayerCache.keys()) {
        if (!live.has(key)) this.sublayerCache.delete(key);
      }
      this.lastTilesRef = tiles;
    }

    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastLayerPropsKey) {
      this.lastLayerPropsKey = layerPropsKey;
      this.sublayerCache.clear();
    }

    const sublayers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer);
        if (!prepared) continue;
        const cached = this.sublayerCache.get(prepared.tileKey);
        if (
          cached &&
          cached.preparedKey === prepared &&
          cached.layerPropsKey === layerPropsKey
        ) {
          sublayers.push(cached.layer);
          continue;
        }
        const layer = this.buildSublayer(prepared);
        this.sublayerCache.set(prepared.tileKey, {
          layer,
          preparedKey: prepared,
          layerPropsKey,
        });
        sublayers.push(layer);
      }
    }

    emit('renderLayers', {
      layer: 'AnimatedLineLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedLineLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const widthProp = typeof widthValue === 'string' ? widthValue : '';
    const filterProp = this.filterPropertyValue() ?? '';
    // Explicit colorMapping content is baked into the per-tile gpuPalette, so a
    // mapping edit must invalidate the cached tile. Digest is memoized per
    // object reference (style-digest.ts) — a WeakMap lookup, not a re-serialize.
    const mapSig = this.props.colorMapping
      ? `m${colorMappingDigest(this.props.colorMapping)}`
      : '';
    // colorMappingDefault seeds the mapping fallback + the NULL palette slot,
    // so a change in isolation must invalidate the prepared tile.
    const mapDefault = (
      this.props.colorMappingDefault ?? DEFAULT_MAPPING_DEFAULT
    ).join(',');
    // Palette keyed by CONTENT, not length — a same-size palette swap must
    // invalidate cached tiles. The digest is memoized per array reference, so
    // this is a WeakMap lookup per tile, not a re-serialization. The user's
    // updateTriggers ride the key too so a trigger bump re-prepares the tile.
    // The filter-column NAME is baked into the `filterValue` attribute, so a
    // change (incl. the unset↔set toggle that adds/removes STTDataFilterExtension)
    // must re-prepare tiles → rebuild sublayers via the new preparedKey.
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp
        ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${mapSig}|d${mapDefault}|f${filterProp}|${updateTriggersDigest(this.props.updateTriggers)}`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', {
        layer: 'AnimatedLineLayer',
        tileKey,
        cached: true,
        ms: 0,
      });
      return cached;
    }

    const t0 = performance.now();
    // Collapse each LineString feature to its source (first) / target (last)
    // endpoint — LineLayer is an instanced source→target layer (one instance
    // per feature), so the intermediate vertices of a polyline are dropped.
    const { source, target, dims } = deriveSourceTargetPositions(binary);

    const attributes: PreparedTile['data']['attributes'] = {
      // Accessor-name keys for LineLayer's own source/target position attributes.
      getSourcePosition: { value: source, size: dims },
      getTargetPosition: { value: target, size: dims },
      // Extension-registered attribute names: must match
      // TimeFilterExtension.initializeState exactly. LineLayer is instanced, so
      // start/end time are one-per-feature (zero-copy from the tile).
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    // Categorical color: GPU path via CategoryColorExtension. One per-feature
    // category index drives the line color.
    let gpuPalette: Color[] | null = null;
    if (colorProp) {
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        // Explicit colorMapping → stable per-tile palette (resolved against
        // this tile's own category dictionary); else the ordered colorPalette.
        const mappingFallback =
          this.props.colorMappingDefault ?? DEFAULT_MAPPING_DEFAULT;
        const palette = this.props.colorMapping
          ? paletteFromMapping(
              cat.categories,
              this.props.colorMapping,
              mappingFallback,
            )
          : (this.props.colorPalette ?? DEFAULT_PALETTE);
        attributes.instanceCategoryIndex = {
          value: categoryIndicesToFloat32(
            cat.indices,
            binary.featureCount,
            palette.length,
            'AnimatedLineLayer',
          ),
          size: 1,
        };
        gpuPalette = appendNullCategorySlot(
          palette,
          this.props.colorMapping ? mappingFallback : undefined,
        );
      }
    }

    if (widthProp) {
      const values = binary.numericProps[widthProp];
      if (values) {
        attributes.getWidth = { value: values, size: 1 };
      }
    }

    // Column range filter (STTDataFilterExtension): bind the named numeric column
    // to the `filterValue` attribute zero-copy (already a Float32Array). Absent
    // column ⇒ no attribute baked → the sublayer idles the filter for this tile
    // (renders unfiltered), mirroring how a missing color/width column falls
    // back. Line is instanced one-per-feature, so a per-feature column binds
    // directly. A categorical column can't be range-filtered in v1 — warn once.
    if (filterProp) {
      const values = binary.numericProps[filterProp];
      if (values) {
        attributes.filterValue = { value: values, size: 1 };
      } else if (binary.categoricalProps[filterProp]) {
        warnOnce(
          'AnimatedLineLayer:filterPropertyCategorical',
          `[AnimatedLineLayer] filterProperty "${filterProp}" is a categorical ` +
            'column; v1 range-filters NUMERIC columns only. The filter is ignored ' +
            'for tiles where the column is categorical.',
        );
      }
    }

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      data: {
        length: binary.featureCount,
        attributes,
      },
      timeOffset: binary.timeOffset,
      dims,
      gpuPalette,
      tile,
      features: binary,
    };
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'AnimatedLineLayer',
      tileKey,
      cached: false,
      features: binary.featureCount,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): LineLayer {
    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    const constColor = (
      Array.isArray(colorValue) ? colorValue : DEFAULT_COLOR
    ) as Color;
    const constWidth = typeof widthValue === 'number' ? widthValue : 1;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedLineLayer:paletteOverflow',
        `[AnimatedLineLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Column filter: install STTDataFilterExtension only when a column is named
    // (per-layer constant ⇒ stable list across this layer's sublayers). Whether
    // THIS tile actually baked the attribute gates the per-tile enable, so a
    // tile missing the column renders unfiltered (idle extension).
    const filterProp = this.filterPropertyValue();
    const hasFilter = !!prepared.data.attributes.filterValue;

    // Keep the extension list constant across sublayers — see
    // animated-trips-layer.ts for the cache-storm rationale. User extensions
    // from the top-level `extensions` prop are appended (composeExtensions).
    const extensions = this.composeExtensions([
      this.timeFilterExtension,
      this.categoryColorExtension,
      // Column range filter, when a filterProperty is set. Multiplies its own
      // in/out (or soft-fade) factor into color.a — commutes with the time and
      // categorical alphas, so it composes cleanly with both.
      ...(filterProp ? [this.dataFilterExtension] : []),
    ]);
    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate system,
    // highlight props, …) + user `_subLayerProps.lines` overrides. Only runs
    // inside this cache-gated build path — never per frame. positionFormat is
    // passed explicitly (sublayerProps beats inheritance): the composite's
    // default 'XYZ' would misread 2D tile buffers.
    const props = this.composeSubLayerProps('lines', prepared.tileKey, {
      data: prepared.data,
      // Identity comparator pairs with the preparedTileCache: deck.gl skips the
      // entire prop-diff for `data` when the same object reference comes back.
      dataComparator: (a: any, b: any) => a === b,
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',
      // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
      widthUnits: this.props.widthUnits,
      widthScale: this.props.widthScale,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,

      // Constant is harmless when the categorical GPU path is active (the
      // shader's useCategoryColor branch overrides it); it drives color on
      // tiles without the category column.
      getColor: constColor,
      getWidth: constWidth,

      extensions,
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      // Time-as-height (space-time cube). Window mode lifts whole features by
      // start time.
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,

      // TileLayer convention: the source tile rides on the sublayer so the base
      // getPickingInfo can enrich info.tile / decode the picked flow.
      tile: prepared.tile,
      sttFeatures: prepared.features,

      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: prepared.gpuPalette! } : {}),

      // STTDataFilterExtension wiring (only when a filterProperty is set). The
      // constant getFilterValue is the fallback for tiles missing the column;
      // filterEnabled is additionally gated on THIS tile having baked it.
      ...(filterProp
        ? {
            getFilterValue: 0,
            filterEnabled: hasFilter && this.props.filterEnabled !== false,
            filterRange: this.props.filterRange ?? null,
            filterSoftRange: this.props.filterSoftRange ?? null,
          }
        : {}),
    });
    // LineLayer carries far fewer attributes than PathLayer (no fp64 path split,
    // no per-vertex tessellation), so the WebGL2 16-attribute floor that forces
    // NoPickingPathLayer on the path family is not a concern — the stock
    // LineLayer's instancePickingColors fits, and picking works directly. A
    // `_subLayerProps: { lines: { type } }` override beats this default.
    const SubLayerClass = this.getSubLayerClass('lines', LineLayer);
    return new SubLayerClass(props as any);
  }
}
