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
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from '../spatiotemporal-layer';
import { TimeFilterExtension } from '../../extensions/time-filter-extension';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from '../../extensions/category-color-extension';
import { emit } from '../../lib/telemetry';
import { warnOnce } from '../../lib/log';
import {
  colorListDigest,
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest';
import { resolveAccessorAlias } from '../../lib/accessor-alias';
import type { ColorAccessorValue, NumericAccessorValue } from '../../lib/accessor-alias';
import { deriveSourceTargetPositions } from '../../lib/od-positions';
import { DEFAULT_LINE_PALETTE } from '@poopdeck.gl/core';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@poopdeck.gl/core';

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
   * Arc height multiplier — `0` makes the arc flat. ArcLayer pass-through
   * (`getHeight` constant).
   * @default 1
   */
  arcHeight?: number;
  /**
   * Upstream-vocabulary alias of {@link arcHeight} (ArcLayer's `getHeight`).
   * Accepts a constant number only; a function warns once and falls back to
   * `arcHeight`. When set, it wins over `arcHeight`. (No column-name arm —
   * arc height is a constant multiplier, not a per-feature binary attribute.)
   */
  getHeight?: number | ((d: unknown) => unknown) | null;
  /**
   * Tilt the arc to the side (degrees), useful for separating arcs that share
   * source and target — ArcLayer pass-through (`getTilt` constant).
   * @default 0
   */
  arcTilt?: number;
  /**
   * Upstream-vocabulary alias of {@link arcTilt} (ArcLayer's `getTilt`).
   * Constant only; a function warns once and falls back to `arcTilt`. (No
   * column-name arm — tilt is a constant, not a per-feature binary attribute.)
   */
  getTilt?: number | ((d: unknown) => unknown) | null;
  /**
   * Color palette for categorical `sourceColor` / `targetColor`.
   */
  colorPalette?: Color[];
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
export type AnimatedArcLayerProps = _AnimatedArcLayerProps & SpatioTemporalLayerProps;

const DEFAULT_SOURCE_COLOR: Color = [0, 150, 255, 255];
const DEFAULT_TARGET_COLOR: Color = [255, 127, 14, 255];

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_LINE_PALETTE;

/** See AnimatedPathLayer for the rationale; same cache shape, source/target attrs. */
interface PreparedTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    attributes: Record<string, { value: any; size: number; normalized?: boolean }>;
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
 * Narrow Uint16Array → Float32Array so the GPU CategoryColorExtension can read
 * indices as a float attribute. Allocated once per (tile, prop change) pair and
 * cached on the PreparedTile.
 */
function indicesToFloat32(indices: Uint16Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i];
  return out;
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
export class AnimatedArcLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedArcLayerProps>
> {
  static layerName = 'AnimatedArcLayer';

  static defaultProps: DefaultProps<AnimatedArcLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    greatCircle: false,
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
    getSourceColor: { type: 'object', value: null, optional: true, compare: true },
    getTargetColor: { type: 'object', value: null, optional: true, compare: true },
    getWidth: { type: 'object', value: null, optional: true, compare: true },
    arcHeight: { type: 'number', value: 1, min: 0 },
    getHeight: { type: 'object', value: null, optional: true, compare: true },
    arcTilt: { type: 'number', value: 0 },
    getTilt: { type: 'object', value: null, optional: true, compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
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
  private readonly timeFilterExtension = new TimeFilterExtension({ mode: 'window' });
  private readonly categoryColorExtension = new CategoryColorExtension();
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  /**
   * Accessor-alias resolution (audit B1): the upstream-named alias wins when
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

  private heightValue(): number | undefined {
    return resolveAccessorAlias(
      'AnimatedArcLayer',
      'getHeight',
      this.props.getHeight,
      this.props.arcHeight,
    );
  }

  private tiltValue(): number | undefined {
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

  private computeLayerPropsKey(): string {
    const sourceColor = this.sourceColorValue();
    const targetColor = this.targetColorValue();
    const width = this.widthValue();
    return [
      this.props.greatCircle,
      this.props.widthUnits,
      this.props.widthScale,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.heightValue(),
      this.tiltValue(),
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
      // sourceColor/targetColor/width: only the "constant fallback" branch is
      // baked into the layer; the categorical path lives in `prepared`.
      Array.isArray(sourceColor) ? sourceColor.join(',') : '',
      Array.isArray(targetColor) ? targetColor.join(',') : '',
      typeof width === 'number' ? width : 0,
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
        for (const tileLayer of tile.layers) live.add(makeTileKey(tile, tileLayer));
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
      layer: 'AnimatedArcLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedArcLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const colorProp = this.categoryColorProp();
    const widthValue = this.widthValue();
    const widthProp = typeof widthValue === 'string' ? widthValue : '';
    // Palette keyed by CONTENT, not length — a same-size palette swap must
    // invalidate cached tiles. The digest is memoized per array reference, so
    // this is a WeakMap lookup per tile, not a re-serialization. The user's
    // updateTriggers ride the key too so a trigger bump re-prepares the tile.
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE) : 0
    }|${updateTriggersDigest(this.props.updateTriggers)}`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', { layer: 'AnimatedArcLayer', tileKey, cached: true, ms: 0 });
      return cached;
    }

    const t0 = performance.now();
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
        attributes.instanceCategoryIndex = {
          value: indicesToFloat32(cat.indices, binary.featureCount),
          size: 1,
        };
        gpuPalette = this.props.colorPalette ?? DEFAULT_PALETTE;
      }
    }

    if (widthProp) {
      const values = binary.numericProps[widthProp];
      if (values) {
        attributes.getWidth = { value: values, size: 1 };
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
      layer: 'AnimatedArcLayer',
      tileKey,
      cached: false,
      features: binary.featureCount,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): ArcLayer {
    const sourceColorValue = this.sourceColorValue();
    const targetColorValue = this.targetColorValue();
    const widthValue = this.widthValue();
    const constSourceColor = (Array.isArray(sourceColorValue)
      ? sourceColorValue
      : DEFAULT_SOURCE_COLOR) as Color;
    const constTargetColor = (Array.isArray(targetColorValue)
      ? targetColorValue
      : DEFAULT_TARGET_COLOR) as Color;
    const constWidth = typeof widthValue === 'number' ? widthValue : 2;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;
    const arcHeight = this.heightValue() ?? 1;
    const arcTilt = this.tiltValue() ?? 0;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedArcLayer:paletteOverflow',
        `[AnimatedArcLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Keep the extension list constant across sublayers — see
    // animated-trips-layer.ts for the cache-storm rationale. User extensions
    // from the top-level `extensions` prop are appended (composeExtensions).
    const extensions = this.composeExtensions([
      this.timeFilterExtension,
      this.categoryColorExtension,
    ]);
    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate system,
    // highlight props, …) + user `_subLayerProps.arcs` overrides. Only runs
    // inside this cache-gated build path — never per frame. positionFormat is
    // passed explicitly (sublayerProps beats inheritance): the composite's
    // default 'XYZ' would misread 2D tile buffers.
    const props = this.composeSubLayerProps('arcs', prepared.tileKey, {
      data: prepared.data,
      // Identity comparator pairs with the preparedTileCache: deck.gl skips the
      // entire prop-diff for `data` when the same object reference comes back.
      dataComparator: (a: any, b: any) => a === b,
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',
      greatCircle: this.props.greatCircle,
      // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
      widthUnits: this.props.widthUnits,
      widthScale: this.props.widthScale,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,

      // Constants are harmless when the categorical GPU path is active (the
      // shader's useCategoryColor branch overrides them); they drive color on
      // tiles without the category column. getHeight/getTilt are constant
      // pass-throughs (ArcLayer accessors accept a constant).
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
