// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * AnimatedPathLayer - GPU-efficient path/trajectory rendering with time filtering.
 *
 * Operates in WINDOW MODE: each feature is shown (with optional fade) when
 * its `[startTime, endTime]` overlaps the current time window. Whole paths
 * render at once. For a "vehicle moving along the route" effect with a
 * trailing fade, use AnimatedTripsLayer instead.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One PathLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, startIndices,
 *   attributes }` interface, with attribute typed arrays referenced
 *   directly from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension instance.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation.
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 */

import { PathLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { NoPickingPathLayer } from './no-picking-path-layer';
import { TimeFilterExtension } from './time-filter-extension';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from './category-color-extension';
import { emit } from './telemetry';
import { warnOnce } from './log';
import {
  colorListDigest,
  inheritedPropsDigest,
  updateTriggersDigest,
} from './style-digest';
import { resolveAccessorAlias } from './accessor-alias';
import type { ColorAccessorValue, NumericAccessorValue } from './accessor-alias';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@stt/core';

const DEBUG = false;

/** Props added by {@link AnimatedPathLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedPathLayerProps}). */
export interface _AnimatedPathLayerProps {
  /**
   * Width multiplier.
   * @default 1
   */
  widthScale?: number;
  /**
   * Units for path width.
   * @default 'pixels'
   */
  widthUnits?: 'pixels' | 'meters';
  /** Clamp path width to at least this many on-screen pixels. */
  widthMinPixels?: number;
  /** Clamp path width to at most this many on-screen pixels. */
  widthMaxPixels?: number;
  /**
   * Path color — constant {@link Color}, or property name for categorical coloring.
   * @default [0, 150, 255, 255]
   */
  pathColor?: Color | string;
  /**
   * Upstream-vocabulary (PathLayer) alias of {@link pathColor}. NOTE: unlike
   * upstream deck.gl, this accepts a constant Color OR a property-column
   * NAME — NOT a function accessor (binary tiles can't run per-feature JS;
   * a function warns once and falls back to `pathColor`). When set, it wins
   * over `pathColor`.
   */
  getColor?: ColorAccessorValue | null;
  /**
   * Path width — constant number, or property name for per-feature width.
   * @default 3
   */
  pathWidth?: number | string;
  /**
   * Upstream-vocabulary alias of {@link pathWidth}. Accepts a constant
   * number OR a property-column NAME — NOT a function accessor (a function
   * warns once and falls back to `pathWidth`). When set, it wins over
   * `pathWidth`.
   */
  getWidth?: NumericAccessorValue | null;
  /**
   * Color palette for categorical `pathColor`.
   */
  colorPalette?: Color[];
  /**
   * Fade-in duration for appearing paths (ms).
   * @default 300
   */
  fadeInDuration?: number;
  /**
   * Fade-out duration for disappearing paths (ms).
   * @default 300
   */
  fadeOutDuration?: number;
  /**
   * Rounded line caps. Rounded caps are the dominant fragment-shader cost
   * at small widths and are visually indistinguishable from flat below ~10 px.
   * @default false
   */
  capRounded?: boolean;
  /**
   * Rounded line joints; same fragment-cost tradeoff as `capRounded`.
   * @default false
   */
  jointRounded?: boolean;
  /**
   * Miter-joint length cap (multiples of line width) — PathLayer pass-through,
   * applies when `jointRounded` is false.
   * @default 4
   */
  miterLimit?: number;
  /**
   * Extrude lines in screen space (always face the camera) — PathLayer
   * pass-through.
   * @default false
   */
  billboard?: boolean;
}

/** Complete props accepted by {@link AnimatedPathLayer}. */
export type AnimatedPathLayerProps = _AnimatedPathLayerProps & SpatioTemporalLayerProps;

const DEFAULT_PALETTE: Color[] = [
  [0, 150, 255, 255],
  [255, 127, 14, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
  [140, 86, 75, 255],
  [227, 119, 194, 255],
  [127, 127, 127, 255],
  [188, 189, 34, 255],
  [23, 190, 207, 255],
];

/** See AnimatedTripsLayer for the rationale; same cache shape, window-mode attrs. */
interface PreparedTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    startIndices: Uint32Array;
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
 * Narrow Uint16Array → Float32Array so the GPU CategoryColorExtension can
 * read indices as a float attribute. Allocated once per (tile, prop change)
 * pair and cached on the PreparedTile.
 */
function indicesToFloat32(indices: Uint16Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i];
  return out;
}


/**
 * Animated path layer (window mode) with per-tile binary sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`paths`**.
 * `_subLayerProps: { paths: { type: MyLayer, ...props } }` swaps the
 * sublayer class / overrides sublayer props (deck's CompositeLayer
 * contract). Without a `type` override the class is `PathLayer` when
 * `pickable` and the attribute-stripped `NoPickingPathLayer` otherwise.
 */
export class AnimatedPathLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedPathLayerProps>
> {
  static layerName = 'AnimatedPathLayer';

  static defaultProps: DefaultProps<AnimatedPathLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    widthScale: { type: 'number', value: 1, min: 0 },
    widthUnits: 'pixels',
    widthMinPixels: { type: 'number', value: 0, min: 0 },
    widthMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    // Permissive descriptors ({type:'object'} validates anything): these
    // props legally hold a constant OR a column-name string, which the
    // 'color'/'number' validators would reject in deck's debug mode.
    pathColor: { type: 'object', value: [0, 150, 255, 255], compare: true },
    pathWidth: { type: 'object', value: 3, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getColor: { type: 'object', value: null, optional: true, compare: true },
    getWidth: { type: 'object', value: null, optional: true, compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
    capRounded: false,
    jointRounded: false,
    miterLimit: { type: 'number', value: 4, min: 0 },
    billboard: false,
  };

  private preparedTileCache = new Map<string, PreparedTile>();
  /**
   * Per-tile sublayer-instance cache — see the matching field on
   * AnimatedTripsLayer for the rationale. Returning the SAME PathLayer
   * reference across renderLayers() calls lets deck.gl short-circuit prop
   * diff for unchanged tiles.
   */
  private sublayerCache = new Map<
    string,
    { layer: PathLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;
  /**
   * Path layer is window-mode only (whole feature on/off + fade), so the
   * per-vertex time attribute is unused. Registering only the start/end pair
   * keeps the per-pipeline vertex-attribute count under WebGL2's 16-slot
   * minimum when stacked with PathLayer's fp64 position split + picking +
   * CategoryColorExtension.
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
   * set; a function-valued alias warns once and falls back to the legacy
   * prop. Same value domain as the legacy props (constant or column name).
   */
  private colorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPathLayer',
      'getColor',
      this.props.getColor,
      this.props.pathColor,
    );
  }

  private widthValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPathLayer',
      'getWidth',
      this.props.getWidth,
      this.props.pathWidth,
    );
  }

  private computeLayerPropsKey(): string {
    const color = this.colorValue();
    const width = this.widthValue();
    return [
      this.props.widthScale,
      this.props.widthUnits,
      this.props.widthMinPixels,
      this.props.widthMaxPixels,
      this.props.capRounded,
      this.props.jointRounded,
      this.props.miterLimit,
      this.props.billboard,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
      // plus the user's updateTriggers.
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

    // Skip O(cacheSize) prune walks when the parent re-rendered with the
    // same tile-array ref — the live and cached sets are then identical.
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
      layer: 'AnimatedPathLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedPathLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
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
      emit('tilePrepare', { layer: 'AnimatedPathLayer', tileKey, cached: true, ms: 0 });
      return cached;
    }

    const t0 = performance.now();
    const dims = binary.positionDimensions ?? 2;

    const attributes: PreparedTile['data']['attributes'] = {
      // Accessor-name key for PathLayer's own attribute.
      getPath: { value: binary.positions, size: dims },
      // Extension-registered attribute names: must match
      // TimeFilterExtension.initializeState exactly.
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    // Categorical color: GPU path via CategoryColorExtension. The previous
    // expandPaletteColors() pass allocated a 4n-byte Uint8Array per tile and
    // walked the indices on the CPU; the GPU path uploads a 4n-byte Float32
    // attribute (one-time) and samples a shared 16 KB palette texture.
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
        startIndices: binary.startIndices,
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
      layer: 'AnimatedPathLayer',
      tileKey,
      cached: false,
      features: binary.featureCount,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): PathLayer {
    const colorValue = this.colorValue();
    const widthValue = this.widthValue();
    const constColor = (Array.isArray(colorValue)
      ? colorValue
      : [0, 150, 255, 255]) as Color;
    const constWidth = typeof widthValue === 'number' ? widthValue : 2;
    // `Required<>`-typed: the defaultProps value guarantees a number here.
    const timeWindow = this.props.timeWindow;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (
      useGpuCategory &&
      prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE
    ) {
      warnOnce(
        'AnimatedPathLayer:paletteOverflow',
        `[AnimatedPathLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
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
    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.paths` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    // positionFormat is passed explicitly (sublayerProps beats inheritance):
    // the composite's default 'XYZ' would misread 2D tile buffers.
    const props = this.composeSubLayerProps('paths', prepared.tileKey, {
      data: prepared.data,
      // Identity comparator pairs with the preparedTileCache: deck.gl skips
      // the entire prop-diff for `data` when the same object reference
      // comes back.
      dataComparator: (a: any, b: any) => a === b,
      _pathType: 'open',
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',
      // `Required<>`-typed (defaults guarantee values) — no `??` refetches.
      widthUnits: this.props.widthUnits,
      widthScale: this.props.widthScale,
      widthMinPixels: this.props.widthMinPixels,
      widthMaxPixels: this.props.widthMaxPixels,
      capRounded: this.props.capRounded,
      jointRounded: this.props.jointRounded,
      miterLimit: this.props.miterLimit,
      billboard: this.props.billboard,

      getColor: constColor,
      getWidth: constWidth,

      extensions,
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      // Time-as-height (space-time cube). Window mode lifts whole features
      // by start time (the per-vertex attribute defaults to 0 here).
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,

      // TileLayer convention: the source tile rides on the sublayer so the
      // base getPickingInfo can enrich info.tile / decode the picked path.
      tile: prepared.tile,
      sttFeatures: prepared.features,

      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: prepared.gpuPalette! } : {}),
    });
    // Pickable sublayers must use the stock PathLayer: NoPickingPathLayer
    // strips `instancePickingColors`, so forwarding pickable:true into it
    // produced silently-broken picking (zeroed picking colors). The stock
    // layer's extra attribute can push the fp64 + TimeFilter + CategoryColor
    // combo past WebGL2's 16-slot minimum on GPUs that report exactly 16 —
    // accepted, with a warning. The picked instance index is the path index
    // within the tile; getPickingInfo decodes its properties from there.
    // A `_subLayerProps: { paths: { type } }` override beats both defaults.
    if (this.props.pickable) {
      warnOnce(
        'AnimatedPathLayer:pickableAttributeBudget',
        '[AnimatedPathLayer] pickable:true renders through the stock PathLayer ' +
          'so picking works, but its instancePickingColors attribute can exceed ' +
          "WebGL2's 16-vertex-attribute minimum on some GPUs (link warning).",
      );
      const SubLayerClass = this.getSubLayerClass('paths', PathLayer);
      return new SubLayerClass(props as any);
    }
    // NoPickingPathLayer drops `instancePickingColors` from both the JS
    // attribute-manager registration AND the compiled vertex shader. With
    // PathLayer's hard-coded 13 attrs + TimeFilterExtension's 3 +
    // CategoryColorExtension's 1 = 17, the layer otherwise blows past the
    // WebGL2 16-attribute minimum and the per-pipeline link fails on GPUs
    // that report exactly 16. Sublayers here are non-pickable, so there is
    // no behavioural change. See `no-picking-path-layer.ts`.
    const SubLayerClass = this.getSubLayerClass('paths', NoPickingPathLayer);
    return new SubLayerClass(props as any);
  }
}
