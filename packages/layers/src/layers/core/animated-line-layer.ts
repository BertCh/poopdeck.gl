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
export type AnimatedLineLayerProps = _AnimatedLineLayerProps & SpatioTemporalLayerProps;

const DEFAULT_COLOR: Color = [0, 150, 255, 255];

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
 * Animated line layer (window mode) with per-tile binary sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`lines`**.
 * `_subLayerProps: { lines: { type: MyLayer, ...props } }` swaps the sublayer
 * class / overrides sublayer props (deck's CompositeLayer contract). Without a
 * `type` override the class is the stock `LineLayer` (it carries fewer
 * attributes than PathLayer, so picking works directly without the
 * NoPickingPathLayer attribute-budget workaround the path family needs).
 */
export class AnimatedLineLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedLineLayerProps>
> {
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
      layer: 'AnimatedLineLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedLineLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
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
      emit('tilePrepare', { layer: 'AnimatedLineLayer', tileKey, cached: true, ms: 0 });
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
    const constColor = (Array.isArray(colorValue)
      ? colorValue
      : DEFAULT_COLOR) as Color;
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

    // Keep the extension list constant across sublayers — see
    // animated-trips-layer.ts for the cache-storm rationale. User extensions
    // from the top-level `extensions` prop are appended (composeExtensions).
    const extensions = this.composeExtensions([
      this.timeFilterExtension,
      this.categoryColorExtension,
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
