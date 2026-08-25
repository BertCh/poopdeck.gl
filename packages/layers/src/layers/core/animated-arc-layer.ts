// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedArcLayer - GPU-efficient origin→destination flow rendering with time
 * filtering.
 *
 * Operates in WINDOW MODE: each OD flow is shown (with optional fade) when its
 * `[startTime, endTime]` overlaps the current time window. Renders deck.gl's
 * `ArcLayer` — a raised arc from each feature's SOURCE endpoint to its TARGET
 * endpoint, optionally along the great-circle path (`greatCircle`).
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One ArcLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Tiles store flows as LineString features; this layer derives dense
 *   source/target endpoint buffers (first/last vertex of each feature) once per
 *   tile via {@link deriveSourceTargetPositions} and feeds them through
 *   ArcLayer's instanced binary `data: { length, attributes }` interface. The
 *   start/end time attributes ride zero-copy from the tile's BinaryFeatures.
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its own
 *   TimeFilterExtension instance.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation.
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 *
 * CATEGORICAL COLOR CONSTRAINT: ArcLayer carries TWO color channels
 * (`getSourceColor` / `getTargetColor`) but CategoryColorExtension drives a
 * SINGLE per-feature category color into the shader's unified `color` output
 * (DECKGL_FILTER_COLOR runs after the arc interpolates source→target). So when
 * `sourceColor` OR `targetColor` names a category column, the GPU categorical
 * path colors the WHOLE arc by that column (both endpoints the same color); the
 * other endpoint's constant is ignored. Constant colors on both endpoints take
 * the normal per-endpoint path.
 */

import { ArcLayer } from '@deck.gl/layers';
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
import { emit, isProbeEnabled } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import {
  colorListDigest,
  colorMappingDigest,
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import {
  buildLayerPropsKey,
  type PropEffects,
} from '../../lib/layer-props-key.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type {
  ColorAccessorValue,
  NumericAccessorValue,
  WeightAccessorValue,
} from '../../lib/accessor-alias.js';
import { deriveSourceTargetPositions } from '../../lib/od-positions.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
import {
  DEFAULT_LINE_PALETTE,
  GeometryType,
  tileLayerKey,
} from '@poopdeck.gl/core';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedArcLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedArcLayerProps}). */
export interface _AnimatedArcLayerProps {
  /**
   * If `true`, draw each arc along the shortest path on the earth's surface
   * (great circle) instead of a flat raised arc — ArcLayer pass-through.
   * @default false
   */
  greatCircle?: boolean;
  /**
   * Number of segments used to tessellate each arc — higher is smoother, lower
   * is cheaper. ArcLayer pass-through (constant only).
   * @default 50
   */
  numSegments?: number;
  /**
   * Source-endpoint color — constant {@link Color}, or property name for
   * categorical coloring. NOTE: when EITHER endpoint names a category column
   * the whole arc is colored by that column (see the class docstring) — the
   * extension drives a single unified color, not two.
   * @default [0, 150, 255, 255]
   */
  sourceColor?: Color | string;
  /**
   * Target-endpoint color — constant {@link Color}, or property name for
   * categorical coloring (same single-color constraint as {@link sourceColor}).
   * @default [255, 127, 14, 255]
   */
  targetColor?: Color | string;
  /**
   * Upstream-vocabulary (ArcLayer) alias of {@link sourceColor}. NOTE: unlike
   * upstream deck.gl, this accepts a constant Color OR a property-column NAME —
   * NOT a function accessor (binary tiles can't run per-feature JS; a function
   * warns once and falls back to `sourceColor`). When set, it wins over
   * `sourceColor`.
   */
  getSourceColor?: ColorAccessorValue | null;
  /**
   * Upstream-vocabulary alias of {@link targetColor}. Same value domain as
   * {@link getSourceColor}; when set it wins over `targetColor`.
   */
  getTargetColor?: ColorAccessorValue | null;
  /**
   * Arc width — constant number, or property name for per-feature width.
   * @default 2
   */
  width?: number | string;
  /**
   * Upstream-vocabulary alias of {@link width}. Accepts a constant number OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `width`). When set, it wins over `width`.
   */
  getWidth?: NumericAccessorValue | null;
  /**
   * Units for arc width.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters' | 'common';
  /**
   * Width multiplier.
   * @default 1
   */
  widthScale?: number;
  /** Clamp arc width to at least this many on-screen pixels. */
  widthMinPixels?: number;
  /** Clamp arc width to at most this many on-screen pixels. */
  widthMaxPixels?: number;
  /**
   * Arc height multiplier — `0` makes the arc flat. Constant number, OR a
   * property name for per-feature height: upstream registers `instanceHeights`
   * as an ordinary per-instance accessor, so a baked numeric column rides it
   * zero-copy exactly like {@link width}.
   * @default 1
   */
  arcHeight?: number | string;
  /**
   * Upstream-vocabulary alias of {@link arcHeight} (ArcLayer's `getHeight`).
   * Accepts a constant number OR a property-column NAME — NOT a function
   * accessor (a function warns once and falls back to `arcHeight`). When set,
   * it wins over `arcHeight`.
   */
  getHeight?: NumericAccessorValue | null;
  /**
   * Tilt the arc to the side (degrees), useful for separating arcs that share
   * source and target. Constant number, OR a property name for per-feature
   * tilt (`instanceTilts` is a per-instance accessor upstream) — which is what
   * actually separates overlapping flows on the same OD pair.
   * @default 0
   */
  arcTilt?: number | string;
  /**
   * Upstream-vocabulary alias of {@link arcTilt} (ArcLayer's `getTilt`).
   * Accepts a constant number OR a property-column NAME; a function warns once
   * and falls back to `arcTilt`. When set, it wins over `arcTilt`.
   */
  getTilt?: NumericAccessorValue | null;
  /**
   * Color palette for categorical `sourceColor` / `targetColor`.
   */
  colorPalette?: Color[];
  /**
   * Explicit category-string → color map for a categorical `sourceColor` /
   * `targetColor`. Resolved per-tile against each tile's own category
   * dictionary, so a category renders the SAME color in every tile (unlike
   * `colorPalette`, whose indices are assigned per-tile in first-seen order).
   * Takes precedence over `colorPalette` when set. Mirrors
   * `AnimatedTripsLayer.colorMapping`.
   * @default null
   */
  colorMapping?: Record<string, Color> | null;
  /** Fallback color for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;
  /**
   * GPU range filter — the NAME of a baked numeric column to filter arcs by
   * (installs {@link STTDataFilterExtension}). Arcs whose value in this column
   * falls inside {@link filterRange} render; the rest are hidden (or soft-faded
   * via {@link filterSoftRange}). Composes WITH the time filter — an arc must
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
   * Optional soft `[min, max]` inside {@link filterRange}: arcs between the soft
   * and hard bounds fade rather than hard-clip. No effect unless
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
   * Fade-in duration for appearing arcs (ms).
   * @default 300
   */
  fadeInDuration?: number;
  /**
   * Fade-out duration for disappearing arcs (ms).
   * @default 300
   */
  fadeOutDuration?: number;
}

/** Complete props accepted by {@link AnimatedArcLayer}. */
export type AnimatedArcLayerProps = _AnimatedArcLayerProps &
  SpatioTemporalLayerProps;

/**
 * Where each own prop lands, and therefore whether editing it must throw away
 * the cached per-tile ArcLayers. The annotation makes the table total over
 * {@link _AnimatedArcLayerProps}, so a prop added to that interface is a
 * compile error until it is classified here.
 */
const ARC_PROP_EFFECTS: PropEffects<_AnimatedArcLayerProps> = {
  // Passed straight to the ArcLayer that {@link AnimatedArcLayer.buildSublayer}
  // constructs, so a cached instance holds a frozen copy.
  greatCircle: 'sublayer',
  numSegments: 'sublayer',
  widthUnits: 'sublayer',
  widthScale: 'sublayer',
  widthMinPixels: 'sublayer',
  widthMaxPixels: 'sublayer',
  fadeInDuration: 'sublayer',
  fadeOutDuration: 'sublayer',
  // Constant fallbacks the sublayer is built with (the binary attribute wins
  // per instance on tiles that baked the column). Keyed through the
  // alias-resolved value (see the `overrides` at the call site) so a change
  // confined to the `get*` alias invalidates too.
  sourceColor: 'sublayer',
  getSourceColor: 'sublayer',
  targetColor: 'sublayer',
  getTargetColor: 'sublayer',
  width: 'sublayer',
  getWidth: 'sublayer',
  arcHeight: 'sublayer',
  getHeight: 'sublayer',
  arcTilt: 'sublayer',
  getTilt: 'sublayer',
  // Decides whether STTDataFilterExtension is in the sublayer's extension list.
  filterProperty: 'sublayer',
  // Filter uniforms ride as sublayer props.
  filterRange: 'sublayer',
  filterSoftRange: 'sublayer',
  filterEnabled: 'sublayer',
  // Read only while building a tile's prepared attributes / gpuPalette, and
  // covered by the styleKey in prepareTile: a change re-prepares the tile, and
  // the preparedKey identity check then rebuilds the sublayer.
  colorPalette: 'prepare',
  colorMapping: 'prepare',
  colorMappingDefault: 'prepare',
};

const DEFAULT_SOURCE_COLOR: Color = [0, 150, 255, 255];
const DEFAULT_TARGET_COLOR: Color = [255, 127, 14, 255];
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

/**
 * Animated arc layer (window mode) with per-tile binary sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`arcs`**.
 * `_subLayerProps: { arcs: { type: MyLayer, ...props } }` swaps the sublayer
 * class / overrides sublayer props (deck's CompositeLayer contract). Without a
 * `type` override the class is the stock `ArcLayer` (it carries fewer
 * attributes than PathLayer, so the WebGL2 16-attribute floor that forces
 * NoPickingPathLayer on the path family is not a concern here — picking works
 * through the stock layer).
 */
export class AnimatedArcLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_AnimatedArcLayerProps>> {
  static layerName = 'AnimatedArcLayer';

  static defaultProps: DefaultProps<AnimatedArcLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    greatCircle: false,
    numSegments: { type: 'number', value: 50, min: 1 },
    widthUnits: 'pixels',
    widthScale: { type: 'number', value: 1, min: 0 },
    widthMinPixels: { type: 'number', value: 0, min: 0 },
    widthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    // Permissive descriptors ({type:'object'} validates anything): these props
    // legally hold a constant OR a column-name string, which the 'color' /
    // 'number' validators would reject in deck's debug mode.
    sourceColor: { type: 'object', value: [0, 150, 255, 255], compare: true },
    targetColor: { type: 'object', value: [255, 127, 14, 255], compare: true },
    width: { type: 'object', value: 2, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getSourceColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getTargetColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    getWidth: { type: 'object', value: null, optional: true, compare: true },
    // Permissive descriptors: like `width`, these legally hold a constant OR a
    // column-name string, which the 'number' validator would reject.
    arcHeight: { type: 'object', value: 1, compare: true },
    getHeight: { type: 'object', value: null, optional: true, compare: true },
    arcTilt: { type: 'object', value: 0, compare: true },
    getTilt: { type: 'object', value: null, optional: true, compare: true },
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
   * Returning the SAME ArcLayer reference across renderLayers() calls lets
   * deck.gl short-circuit the prop diff for unchanged tiles.
   */
  private sublayerCache = new Map<
    string,
    { layer: ArcLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedPathLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;
  /**
   * Arc layer is window-mode only (whole feature on/off + fade), so only the
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
      'AnimatedArcLayer',
      'filterProperty',
      this.props.filterProperty,
      undefined,
    );
  }

  /**
   * Accessor-alias resolution: the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy prop.
   * Same value domain as the legacy props (constant or column name).
   */
  private sourceColorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedArcLayer',
      'getSourceColor',
      this.props.getSourceColor,
      this.props.sourceColor,
    );
  }

  private targetColorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedArcLayer',
      'getTargetColor',
      this.props.getTargetColor,
      this.props.targetColor,
    );
  }

  private widthValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedArcLayer',
      'getWidth',
      this.props.getWidth,
      this.props.width,
    );
  }

  private heightValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedArcLayer',
      'getHeight',
      this.props.getHeight,
      this.props.arcHeight,
    );
  }

  private tiltValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedArcLayer',
      'getTilt',
      this.props.getTilt,
      this.props.arcTilt,
    );
  }

  /**
   * The category column that drives GPU coloring, or '' for constants. EITHER
   * endpoint naming a column selects that column (source wins if both do — see
   * the class docstring on the single-color constraint).
   */
  private categoryColorProp(): string {
    const src = this.sourceColorValue();
    if (typeof src === 'string') return src;
    const tgt = this.targetColorValue();
    if (typeof tgt === 'string') return tgt;
    return '';
  }

  /**
   * Digest of everything baked into a cached sublayer at construction time.
   * When it changes the whole sublayer cache is dropped.
   */
  private computeLayerPropsKey(): string {
    return buildLayerPropsKey<_AnimatedArcLayerProps>(
      this.props,
      ARC_PROP_EFFECTS,
      {
        // The sublayer is constructed from the RESOLVED value, so the key must
        // track it — keying the raw prop leaves every cached sublayer stale
        // when only the alias changes.
        overrides: {
          sourceColor: this.sourceColorValue(),
          targetColor: this.targetColorValue(),
          width: this.widthValue(),
          arcHeight: this.heightValue(),
          arcTilt: this.tiltValue(),
          filterProperty: this.filterPropertyValue(),
        },
        // Inputs that are not own props: the composite props getSubLayerProps
        // bakes into every sublayer (opacity/pickable/visible, coordinate
        // system, _subLayerProps, …), the user's updateTriggers, and the base
        // class's time props that buildSublayer forwards.
        extra: [
          inheritedPropsDigest(this.props),
          updateTriggersDigest(this.props.updateTriggers),
          this.props.timeWindow,
          this.props.timeHeightScale,
          this.props.timeHeightOrigin,
        ],
      },
    );
  }

  /**
   * Pre-`renderLayers()` prepare for one tile, so the chassis can meter
   * tile commits per frame (`tileCommitBudgetMs`); the result lands in the
   * prepared-tile cache the render loop reads.
   */
  protected warmTile(tile: Tile): void {
    for (const tileLayer of tile.layers) this.prepareTile(tile, tileLayer);
  }

  renderLayers(): Layer[] {
    const probe = isProbeEnabled();
    const t0 = probe ? performance.now() : 0;
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      // Drop the derived buffers too (endpoint Float64Arrays, expanded RGBA)
      // AND the references they hold into tiles the tileset has already
      // evicted — scrubbing to an empty range or panning away otherwise pins
      // both indefinitely. Mirrors AnimatedColumnLayer.
      this.preparedTileCache.clear();
      this.sublayerCache.clear();
      this.lastTilesRef = null;
      return [];
    }

    // Skip O(cacheSize) prune walks when the parent re-rendered with the same
    // tile-array ref — the live and cached sets are then identical.
    if (this.lastTilesRef !== tiles) {
      const live = new Set<string>();
      for (const tile of tiles) {
        for (const tileLayer of tile.layers)
          live.add(tileLayerKey(tile.id, tileLayer.name));
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
    // Draw only the tiles whose covering time range can intersect the render
    // window; the rest stay resident (caches intact) until the playhead wakes
    // them — see SpatioTemporalLayer.cullTilesByTimeRange.
    const liveTiles = this.cullTilesByTimeRange(tiles);
    for (const tile of liveTiles) {
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

    if (probe) {
      emit('renderLayers', {
        layer: 'AnimatedArcLayer',
        tiles: tiles.length,
        liveTiles: liveTiles.length,
        sublayers: sublayers.length,
        ms: performance.now() - t0,
      });
    }
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedArcLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;
    // An arc collapses each LINESTRING to its first/last vertex. A point tile
    // carries no such run — it used to yield zero sublayers with no warning at
    // all (the blank-render class this repo ships a debugging skill for), so
    // name the mismatch once and skip.
    if (
      !expectGeometry(
        binary.geometryType,
        [GeometryType.LineString],
        'AnimatedArcLayer',
        tileLayer.name,
      )
    )
      return null;
    // Structural backstop for untagged (pre-geometry-kind) archives, which
    // expectGeometry deliberately trusts: the endpoint derivation indexes
    // startIndices.
    if (!binary.startIndices) return null;

    const colorProp = this.categoryColorProp();
    const widthValue = this.widthValue();
    const widthProp = typeof widthValue === 'string' ? widthValue : '';
    const heightValue = this.heightValue();
    const heightProp = typeof heightValue === 'string' ? heightValue : '';
    const tiltValue = this.tiltValue();
    const tiltProp = typeof tiltValue === 'string' ? tiltValue : '';
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
    const styleKey = `${colorProp}|${widthProp}|h${heightProp}|t${tiltProp}|${
      colorProp
        ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${mapSig}|d${mapDefault}|f${filterProp}|${updateTriggersDigest(this.props.updateTriggers)}`;

    const tileKey = tileLayerKey(tile.id, tileLayer.name);
    const cached = this.preparedTileCache.get(tileKey);
    const probe = isProbeEnabled();
    if (cached && cached.styleKey === styleKey) {
      if (probe) {
        emit('tilePrepare', {
          layer: 'AnimatedArcLayer',
          tileKey,
          cached: true,
          ms: 0,
        });
      }
      return cached;
    }

    const t0 = probe ? performance.now() : 0;
    // Collapse each LineString feature to its source (first) / target (last)
    // endpoint — ArcLayer is an instanced source→target layer (one instance per
    // feature), so the intermediate vertices of a polyline are dropped.
    const { source, target, dims } = deriveSourceTargetPositions(binary);

    const attributes: PreparedTile['data']['attributes'] = {
      // Accessor-name keys for ArcLayer's own source/target position attributes.
      getSourcePosition: { value: source, size: dims },
      getTargetPosition: { value: target, size: dims },
      // Extension-registered attribute names: must match
      // TimeFilterExtension.initializeState exactly. ArcLayer is instanced, so
      // start/end time are one-per-feature (zero-copy from the tile).
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    // Categorical color: GPU path via CategoryColorExtension. One per-feature
    // category index drives the unified arc color (the extension can't color
    // source/target independently — see the class docstring).
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
            'AnimatedArcLayer',
          ),
          size: 1,
        };
        gpuPalette = appendNullCategorySlot(
          palette,
          this.props.colorMapping ? mappingFallback : undefined,
        );
      }
    }

    // Per-feature width / arc height / arc tilt from baked numeric columns.
    // Upstream registers instanceWidths / instanceHeights / instanceTilts as
    // ordinary per-instance accessors, so each Float32Array rides zero-copy;
    // an absent column falls back to the constant passed in buildSublayer.
    if (widthProp) {
      const values = binary.numericProps[widthProp];
      if (values) {
        attributes.getWidth = { value: values, size: 1 };
      }
    }

    if (heightProp) {
      const values = binary.numericProps[heightProp];
      if (values) {
        attributes.getHeight = { value: values, size: 1 };
      }
    }

    if (tiltProp) {
      const values = binary.numericProps[tiltProp];
      if (values) {
        attributes.getTilt = { value: values, size: 1 };
      }
    }

    // Column range filter (STTDataFilterExtension): bind the named numeric column
    // to the `filterValue` attribute zero-copy (already a Float32Array). Absent
    // column ⇒ no attribute baked → the sublayer idles the filter for this tile
    // (renders unfiltered), mirroring how a missing color/width column falls
    // back. Arc is instanced one-per-feature, so a per-feature column binds
    // directly. A categorical column can't be range-filtered in v1 — warn once.
    if (filterProp) {
      const values = binary.numericProps[filterProp];
      if (values) {
        attributes.filterValue = { value: values, size: 1 };
      } else if (binary.categoricalProps[filterProp]) {
        warnOnce(
          'AnimatedArcLayer:filterPropertyCategorical',
          `[AnimatedArcLayer] filterProperty "${filterProp}" is a categorical ` +
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
    if (probe) {
      emit('tilePrepare', {
        layer: 'AnimatedArcLayer',
        tileKey,
        cached: false,
        features: binary.featureCount,
        gpuPalette: gpuPalette !== null,
        ms: performance.now() - t0,
      });
    }
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): ArcLayer {
    const sourceColorValue = this.sourceColorValue();
    const targetColorValue = this.targetColorValue();
    const widthValue = this.widthValue();
    const constSourceColor = (
      Array.isArray(sourceColorValue) ? sourceColorValue : DEFAULT_SOURCE_COLOR
    ) as Color;
    const constTargetColor = (
      Array.isArray(targetColorValue) ? targetColorValue : DEFAULT_TARGET_COLOR
    ) as Color;
    const constWidth = typeof widthValue === 'number' ? widthValue : 2;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;
    // Constant fallbacks for the height/tilt accessors — the binary getHeight /
    // getTilt attributes win per instance on tiles that baked the column.
    const heightValue = this.heightValue();
    const tiltValue = this.tiltValue();
    const arcHeight = typeof heightValue === 'number' ? heightValue : 1;
    const arcTilt = typeof tiltValue === 'number' ? tiltValue : 0;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedArcLayer:paletteOverflow',
        `[AnimatedArcLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
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
    // highlight props, …) + user `_subLayerProps.arcs` overrides. Only runs
    // inside this cache-gated build path — never per frame. NOTE: no
    // positionFormat pass-through. `positionFormat` is consumed only by the
    // tesselator-based layers (path / polygon); ArcLayer never reads it. What
    // makes a 2D tile buffer read correctly is `size: dims` on the binary
    // getSourcePosition / getTargetPosition attributes above.
    const props = this.composeSubLayerProps('arcs', prepared.tileKey, {
      data: prepared.data,
      // Identity comparator pairs with the preparedTileCache: deck.gl skips the
      // entire prop-diff for `data` when the same object reference comes back.
      dataComparator: (a: any, b: any) => a === b,
      greatCircle: this.props.greatCircle,
      numSegments: this.props.numSegments,
      // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
      widthUnits: this.props.widthUnits,
      widthScale: this.props.widthScale,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,

      // Constants are harmless when the categorical GPU path is active (the
      // shader's useCategoryColor branch overrides them); they drive color on
      // tiles without the category column. Same for width/height/tilt: the
      // constant is the fallback for tiles that baked no such column.
      getSourceColor: constSourceColor,
      getTargetColor: constTargetColor,
      getWidth: constWidth,
      getHeight: arcHeight,
      getTilt: arcTilt,

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
    // ArcLayer carries far fewer attributes than PathLayer (no fp64 path split,
    // no per-vertex tessellation), so the WebGL2 16-attribute floor that forces
    // NoPickingPathLayer on the path family is not a concern — the stock
    // ArcLayer's instancePickingColors fits, and picking works directly. A
    // `_subLayerProps: { arcs: { type } }` override beats this default.
    const SubLayerClass = this.getSubLayerClass('arcs', ArcLayer);
    return new SubLayerClass(props as any);
  }
}
