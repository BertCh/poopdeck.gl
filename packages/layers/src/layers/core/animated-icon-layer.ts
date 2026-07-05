// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedIconLayer - GPU-efficient directional markers with time filtering.
 *
 * ARCHITECTURE (per-tile binary sublayers, mirroring AnimatedPointLayer):
 * - One `IconLayer` per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, attributes }`
 *   interface, with positions / startTimes / endTimes referenced DIRECTLY
 *   from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension (window mode) uniform set.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation; the tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is stable
 *   across renderLayers() calls; deck.gl short-circuits GPU re-uploads when
 *   the reference matches.
 *
 * `IconLayer` is instanced at points exactly like `ScatterplotLayer`, so the
 * binary-attribute path is identical to AnimatedPointLayer's window-mode
 * branch — only the per-instance accessors differ (`getAngle` rotation,
 * `getIcon` sprite name, `getSize`).
 *
 * The headline use case is rotated markers for moving points (AIS vessels,
 * aircraft) using a per-feature heading column (e.g. 'heading' / 'cog') baked
 * into the `getAngle` instanced attribute.
 *
 * ICON ATLAS CONSTRAINT: binary tiles can't run per-row JS accessors, so all
 * features share ONE constant icon — `getIcon` is a constant `() => icon`
 * resolving against the supplied `iconMapping`. Per-category icons are a
 * future enhancement (it would key the sprite by a categorical column, the
 * way `getColor` already does for color). Per-feature ROTATION, COLOR, and
 * SIZE are fully supported through instanced attributes.
 *
 * Categorical colors lift to the GPU via CategoryColorExtension (same path as
 * AnimatedPointLayer's `fillColor`): a `color` property NAME hands the
 * per-feature category index to the fragment shader, which samples the palette
 * texture. A constant `color` rides a scalar prop instead.
 */

import { IconLayer } from '@deck.gl/layers';
import type {
  Color,
  DefaultProps,
  Layer,
  LayerContext,
} from '@deck.gl/core';
import type { Texture } from '@luma.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { TimeFilterExtension } from '../../extensions/time-filter-extension.js';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from '../../extensions/category-color-extension.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import {
  colorListDigest,
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type { ColorAccessorValue, NumericAccessorValue } from '../../lib/accessor-alias.js';
import { DEFAULT_CATEGORICAL_PALETTE } from '@poopdeck.gl/core';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@poopdeck.gl/core';

const DEBUG = false;

/**
 * Value domain of the {@link _AnimatedIconLayerProps.getPixelOffset} alias: a
 * constant `[x, y]` screen-space offset, a size-2 property-column NAME (an
 * interleaved `vectorProps` column baked at build time), or — like the other
 * accessor aliases — a function that warns once and falls back. Mirrors
 * {@link NumericAccessorValue} but two-wide (deck.gl's `getPixelOffset` is a
 * size-2 accessor).
 */
export type PixelOffsetAccessorValue =
  | [number, number]
  | number[]
  | string
  | ((d: unknown) => unknown);

/**
 * One entry of an `iconMapping` — the sub-rectangle of the atlas a named icon
 * occupies, plus anchor / mask flags. Mirrors deck.gl `IconLayer`'s mapping
 * shape; forwarded verbatim to the sublayer.
 */
export interface IconMappingEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX?: number;
  anchorY?: number;
  mask?: boolean;
}

/** Props added by {@link AnimatedIconLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedIconLayerProps}). */
export interface _AnimatedIconLayerProps {
  /**
   * Icon atlas — a URL string or a pre-created {@link Texture}. Forwarded
   * verbatim to the sublayer `IconLayer`. Required to render anything (the
   * single constant icon is looked up in this atlas via `iconMapping`).
   */
  iconAtlas?: string | Texture | null;

  /**
   * Named sub-rectangle map into {@link iconAtlas}. Forwarded verbatim to the
   * sublayer `IconLayer`. The `icon` prop names which entry every feature uses.
   */
  iconMapping?: Record<string, IconMappingEntry> | null;

  /**
   * The SINGLE icon name (a key of {@link iconMapping}) used for ALL features.
   * Binary tiles can't run a per-row `getIcon` accessor, so the sublayer's
   * `getIcon` is wired to a constant `() => icon`. Per-category icons (keying
   * the sprite by a categorical column) are a future enhancement.
   * @default 'marker'
   */
  icon?: string;

  /**
   * Rotation in degrees — constant number, or a numeric property NAME (e.g.
   * 'heading' / 'cog') baked per-feature into the `getAngle` instanced
   * attribute. deck.gl `IconLayer` measures `getAngle` in DEGREES,
   * counter-clockwise from the icon's default (up) orientation.
   * @default 0
   */
  angle?: number | string;

  /**
   * Upstream-vocabulary alias of {@link angle}. Accepts a constant number OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `angle`). When set, it wins over `angle`.
   */
  getAngle?: NumericAccessorValue | null;

  /**
   * Marker tint — constant {@link Color}, or a property name for categorical
   * coloring (GPU path via CategoryColorExtension). For a `mask: true` icon the
   * tint replaces the sprite's color; for an opaque icon it modulates it.
   * @default [255, 255, 255, 255]
   */
  color?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link color}. Accepts a constant Color OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `color`). When set, it wins over `color`.
   */
  getColor?: ColorAccessorValue | null;

  /** Color palette for categorical `color`. */
  colorPalette?: Color[];

  /**
   * Icon size — constant number, or a numeric property NAME baked per-feature
   * into the `getSize` instanced attribute. Interpreted in {@link sizeUnits}.
   * @default 12
   */
  size?: number | string;

  /**
   * Upstream-vocabulary alias of {@link size}. Accepts a constant number OR a
   * property-column NAME — NOT a function accessor (a function warns once and
   * falls back to `size`). When set, it wins over `size`.
   */
  getSize?: NumericAccessorValue | null;

  /**
   * Units for `size` — `IconLayer` pass-through.
   * @default 'pixels'
   */
  sizeUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Icon size multiplier — `IconLayer` pass-through.
   * @default 1
   */
  sizeScale?: number;

  /** Minimum on-screen icon size in pixels. Forwarded to `IconLayer`. */
  sizeMinPixels?: number;

  /** Maximum on-screen icon size in pixels. Forwarded to `IconLayer`. */
  sizeMaxPixels?: number;

  /**
   * Which dimension of a non-square icon `size` measures. `'height'` scales the
   * icon so its rendered height equals `size` (width follows the aspect ratio);
   * `'width'` scales by width instead. No effect on square icons.
   * `IconLayer` pass-through.
   * @default 'height'
   */
  sizeBasis?: 'height' | 'width';

  /**
   * Screen-space pixel offset — a constant `[x, y]` applied to every icon, or a
   * size-2 property-column NAME (an interleaved `vectorProps` column) baked
   * per-feature into the `getPixelOffset` instanced attribute. Same
   * constant-or-column domain as {@link size}/{@link angle}, but two-wide.
   * `IconLayer` pass-through / accessor.
   * @default [0, 0]
   */
  pixelOffset?: [number, number] | string;

  /**
   * Upstream-vocabulary alias of {@link pixelOffset}. Accepts a constant
   * `[x, y]` OR a size-2 property-column NAME — NOT a function accessor (a
   * function warns once and falls back to `pixelOffset`). When set, it wins over
   * `pixelOffset`.
   */
  getPixelOffset?: PixelOffsetAccessorValue | null;

  /**
   * Alpha discard threshold in `[0, 1]`. Fragments whose (icon × tint) alpha is
   * below this cutoff are dropped, which crisps the masked-icon edge and keeps
   * translucent sprite fringes from depth-writing. `IconLayer` pass-through.
   * @default 0.05
   */
  alphaCutoff?: number;

  /**
   * Render icons as billboards (always face the camera in 3D views) —
   * `IconLayer` pass-through.
   * @default true
   */
  billboard?: boolean;

  /**
   * Sampler parameters for the icon-atlas texture — filtering (`minFilter` /
   * `magFilter` / `mipmapFilter`) and wrap (`addressModeU` / `addressModeV`).
   * `null` leaves deck.gl's `IconManager` defaults in place. Forwarded verbatim
   * to the sublayer `IconLayer` (a luma.gl `SamplerProps` object).
   * @default null
   */
  textureParameters?: Record<string, unknown> | null;

  /**
   * Fade-in duration for appearing icons (ms).
   * @default 300
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration for disappearing icons (ms).
   * @default 300
   */
  fadeOutDuration?: number;
}

/** Complete props accepted by {@link AnimatedIconLayer}. */
export type AnimatedIconLayerProps = _AnimatedIconLayerProps & SpatioTemporalLayerProps;

// Default color palette for categorical data (shared shape with the point layer).
// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_CATEGORICAL_PALETTE;

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * deck.gl is stable across renders — deck.gl compares `data` by reference
 * (with our dataComparator: ===) to decide whether to re-upload GPU buffers.
 *
 * Mirrors AnimatedPointLayer's PreparedTile shape (window mode only).
 */
interface PreparedTile {
  /** Resolved (tile, layer) cache key. */
  tileKey: string;
  /** Hash of style props that affect the prepared `attributes`. */
  styleKey: string;
  /** Reference-stable data object for IconLayer's binary interface. */
  data: {
    length: number;
    attributes: Record<string, { value: any; size: number; normalized?: boolean }>;
  };
  /** Per-tile time reference; passed to TimeFilterExtension as `timeOffset`. */
  timeOffset: number;
  /**
   * When the GPU categorical-color path is active for this tile, the resolved
   * palette to pass to the extension. Null when constant color is in use.
   */
  gpuPalette: Color[] | null;
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  layerName: string;
  features: BinaryFeatures;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Hand category indices straight to the GPU as a single-component float
 * attribute. The CategoryColorExtension samples the palette texture in the
 * fragment shader. `indices` arrive as Uint16Array (4096 categories max); the
 * extension reads them as float32, so we do a narrowing copy here.
 */
function indicesToFloat32(indices: Uint16Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i];
  return out;
}

/**
 * Animated icon layer with per-tile binary sublayers.
 *
 * Each visible tile produces one `IconLayer` instance that is cached across
 * renders. Time updates flow through getTime() on the extension; tile arrivals
 * only construct one new sublayer + one GPU upload, never touching the buffers
 * of already-loaded tiles. Window-mode time filtering only — there is no
 * cumulative ("draws itself") path here (see AnimatedPointLayer for that).
 *
 * Sublayer short id for `_subLayerProps` overrides: **`icons`**.
 * `_subLayerProps: { icons: { type: MyLayer, ...props } }` swaps the sublayer
 * class / overrides sublayer props (deck's CompositeLayer contract).
 */
export class AnimatedIconLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedIconLayerProps>
> {
  static layerName = 'AnimatedIconLayer';

  static defaultProps: DefaultProps<AnimatedIconLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,

    // Icon atlas + mapping forwarded verbatim to IconLayer.
    iconAtlas: { type: 'object', value: null, optional: true, compare: true },
    iconMapping: { type: 'object', value: null, optional: true, compare: true },
    icon: 'marker',

    // Permissive descriptors ({type:'object'} validates anything): these props
    // legally hold a constant OR a column-name string, which the
    // 'number'/'color' validators would reject in deck's debug mode.
    angle: { type: 'object', value: 0, compare: true },
    color: { type: 'object', value: [255, 255, 255, 255], compare: true },
    size: { type: 'object', value: 12, compare: true },
    // Constant [x,y] OR a size-2 column name — permissive descriptor for the
    // same reason as angle/color/size.
    pixelOffset: { type: 'object', value: [0, 0], compare: true },

    // Accessor-named aliases: unset by default so the legacy props win unless
    // the caller opts into the upstream vocabulary.
    getAngle: { type: 'object', value: null, optional: true, compare: true },
    getColor: { type: 'object', value: null, optional: true, compare: true },
    getSize: { type: 'object', value: null, optional: true, compare: true },
    getPixelOffset: { type: 'object', value: null, optional: true, compare: true },

    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },

    // Sizing forwarded to IconLayer.
    sizeUnits: 'pixels',
    sizeScale: { type: 'number', value: 1, min: 0 },
    sizeMinPixels: { type: 'number', value: 0, min: 0 },
    sizeMaxPixels: { type: 'number', value: Number.MAX_SAFE_INTEGER, min: 0 },
    sizeBasis: 'height',
    billboard: true,

    // Masked-icon edge crisping — deck default 0.05.
    alphaCutoff: { type: 'number', value: 0.05, min: 0, max: 1 },

    // Atlas sampler params — null keeps IconManager's defaults (deck default).
    textureParameters: { type: 'object', value: null, optional: true, compare: true },

    // Fade ramps, forwarded to TimeFilterExtension (window mode).
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Returning the SAME IconLayer reference
   * across renderLayers() calls lets deck.gl short-circuit the prop diff
   * entirely — the same cache-storm avoidance as AnimatedPointLayer.
   */
  private sublayerCache = new Map<
    string,
    { layer: IconLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction time. */
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedPointLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Window-mode
   * filtering (whole feature on/off + fade) — the per-vertex time attribute is
   * unused.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({ mode: 'window' });

  /**
   * Singleton CategoryColorExtension. Stateless — the palette and
   * `useCategoryColor` toggle ride through layer props. Always included: when a
   * tile lacks `instanceCategoryIndex`, the shader branch is gated off via the
   * uniform.
   */
  private readonly categoryColorExtension = new CategoryColorExtension();

  /**
   * Stable getTime reference. A fresh arrow every render defeats the cache
   * (deck.gl re-runs work when accessor function references change).
   */
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
  private angleValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedIconLayer',
      'getAngle',
      this.props.getAngle,
      this.props.angle,
    );
  }

  private colorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedIconLayer',
      'getColor',
      this.props.getColor,
      this.props.color,
    );
  }

  private sizeValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedIconLayer',
      'getSize',
      this.props.getSize,
      this.props.size,
    );
  }

  private pixelOffsetValue(): [number, number] | number[] | string | undefined {
    return resolveAccessorAlias<[number, number] | number[] | string>(
      'AnimatedIconLayer',
      'getPixelOffset',
      this.props.getPixelOffset,
      this.props.pixelOffset,
    );
  }

  /**
   * Compute a digest of the layer-level props that affect every sublayer.
   * When this changes we throw away the entire sublayer cache.
   */
  private computeLayerPropsKey(): string {
    const angle = this.angleValue();
    const color = this.colorValue();
    const size = this.sizeValue();
    const pixelOffset = this.pixelOffsetValue();
    return [
      this.props.icon,
      // iconAtlas/iconMapping identity — a swap rebuilds every sublayer.
      typeof this.props.iconAtlas === 'string' ? this.props.iconAtlas : '',
      this.props.sizeUnits,
      this.props.sizeScale,
      this.props.sizeMinPixels,
      this.props.sizeMaxPixels,
      this.props.sizeBasis,
      this.props.billboard,
      this.props.alphaCutoff,
      // Atlas sampler config — a swap changes the GPU texture's filtering/wrap.
      JSON.stringify(this.props.textureParameters ?? null),
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinateSystem, modelMatrix, highlight
      // props, _subLayerProps overrides…) plus the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      this.props.timeWindow,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      this.props.timeHeightScale,
      this.props.timeHeightOrigin,
      // angle/color/size/pixelOffset constant branches only — the
      // property-driven path lives in `prepared` and is keyed via
      // preparedKey/styleKey.
      typeof angle === 'number' ? angle : 0,
      Array.isArray(color) ? color.join(',') : '',
      typeof size === 'number' ? size : 0,
      Array.isArray(pixelOffset) ? pixelOffset.join(',') : '',
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune cache only when the tile-array ref changed — when the parent hands
    // us the same `state.tiles` instance, the live and cached sets are
    // identical by construction and the walks are pure overhead.
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

    // Any layer-level prop change invalidates every cached sublayer.
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
      layer: 'AnimatedIconLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedIconLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  /**
   * styleKey digest of the props that change a tile's prepared `attributes`
   * (which angle/color/size column, palette content). Drives the per-tile
   * cache check.
   */
  private computeStyleKey(): string {
    const angle = this.angleValue();
    const color = this.colorValue();
    const size = this.sizeValue();
    const pixelOffset = this.pixelOffsetValue();
    const angleProp = typeof angle === 'string' ? angle : '';
    const colorProp = typeof color === 'string' ? color : '';
    const sizeProp = typeof size === 'string' ? size : '';
    const pixelOffsetProp = typeof pixelOffset === 'string' ? pixelOffset : '';
    // Palette identity matters only when color is a column name. Digests are
    // memoized per object reference (style-digest.ts), so this stays a WeakMap
    // lookup per tile, not a re-serialization.
    return `${angleProp}|${colorProp}|${sizeProp}|${pixelOffsetProp}|${
      colorProp ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE) : 0
    }|${updateTriggersDigest(this.props.updateTriggers)}`;
  }

  /**
   * Fetch the cached binary `data` object for a single tile, building (and
   * caching) it on a miss. Returns a reference-stable PreparedTile so deck.gl
   * can short-circuit GPU re-uploads.
   */
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    if (tileLayer.features.featureCount === 0) return null;
    const styleKey = this.computeStyleKey();
    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', { layer: 'AnimatedIconLayer', tileKey, cached: true, ms: 0 });
      return cached;
    }
    const prepared = this.buildTileData(tile, tileLayer);
    if (prepared) this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /**
   * Build the binary `data` object for a single tile from scratch (no caching).
   */
  private buildTileData(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;

    const angleValue = this.angleValue();
    const colorValue = this.colorValue();
    const sizeValue = this.sizeValue();
    const pixelOffsetValue = this.pixelOffsetValue();
    const angleProp = typeof angleValue === 'string' ? angleValue : '';
    const colorProp = typeof colorValue === 'string' ? colorValue : '';
    const sizeProp = typeof sizeValue === 'string' ? sizeValue : '';
    const pixelOffsetProp = typeof pixelOffsetValue === 'string' ? pixelOffsetValue : '';
    const styleKey = this.computeStyleKey();
    const tileKey = makeTileKey(tile, tileLayer);

    const t0 = performance.now();
    const count = binary.featureCount;
    const srcDims = binary.positionDimensions ?? 2;

    // IconLayer expects size-3 positions. When the tile is 2D, pad once into a
    // fresh Float64Array; 3D tiles ride zero-copy.
    const positions: Float64Array =
      srcDims === 3 ? binary.positions : padPositionsTo3D(binary.positions, count);

    const attributes: PreparedTile['data']['attributes'] = {
      getPosition: { value: positions, size: 3 },
      // Extension-registered attribute names — must match
      // TimeFilterExtension.initializeState exactly. Zero-copy: the tile's own
      // Float32Arrays (relative to binary.timeOffset) ride straight to the GPU.
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    let gpuPalette: Color[] | null = null;

    // Property-driven rotation — IconLayer's getAngle attribute (degrees). The
    // tile's numeric column is already a Float32Array, so it rides zero-copy.
    if (angleProp) {
      const values = binary.numericProps[angleProp];
      if (values) attributes.getAngle = { value: values, size: 1 };
    }

    // Property-driven size — zero-copy Float32Array ride-along.
    if (sizeProp) {
      const values = binary.numericProps[sizeProp];
      if (values) attributes.getSize = { value: values, size: 1 };
    }

    // Property-driven pixel offset — a size-2 interleaved `vectorProps` column
    // ([x0,y0, x1,y1, …]) bound zero-copy to the getPixelOffset instanced
    // attribute. Only a size-2 column qualifies; anything else falls through to
    // the constant offset.
    if (pixelOffsetProp) {
      const vec = binary.vectorProps?.[pixelOffsetProp];
      if (vec && vec.size === 2) {
        attributes.getPixelOffset = { value: vec.value, size: 2 };
      }
    }

    // Property-driven color — categorical only (GPU path). A numeric color
    // column has no natural categorical lookup here, so it's ignored (constant
    // color applies) rather than guessing a ramp.
    if (colorProp) {
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        attributes.instanceCategoryIndex = {
          value: indicesToFloat32(cat.indices, count),
          size: 1,
        };
        gpuPalette = this.props.colorPalette ?? DEFAULT_PALETTE;
      }
    }

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      data: { length: count, attributes },
      timeOffset: binary.timeOffset,
      gpuPalette,
      tile,
      layerName: tileLayer.name,
      features: binary,
    };
    emit('tilePrepare', {
      layer: 'AnimatedIconLayer',
      tileKey,
      cached: false,
      features: count,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): IconLayer {
    // `Required<>`-typed: the defaultProps value guarantees a value here.
    const timeWindow = this.props.timeWindow;
    const icon = this.props.icon;
    const angleValue = this.angleValue();
    const colorValue = this.colorValue();
    const sizeValue = this.sizeValue();
    const pixelOffsetValue = this.pixelOffsetValue();
    const constAngle = typeof angleValue === 'number' ? angleValue : 0;
    const constSize = typeof sizeValue === 'number' ? sizeValue : 12;
    const constColor = (Array.isArray(colorValue)
      ? colorValue
      : ([255, 255, 255, 255] as Color)) as Color;
    const constPixelOffset = (Array.isArray(pixelOffsetValue)
      ? pixelOffsetValue
      : [0, 0]) as [number, number];

    if (!this.props.iconAtlas || !this.props.iconMapping) {
      warnOnce(
        'AnimatedIconLayer:missingAtlas',
        '[AnimatedIconLayer] iconAtlas and iconMapping are required to render ' +
          'icons; nothing will be drawn until both are supplied.',
      );
    }

    // CategoryColorExtension props: when this tile uses the GPU palette path we
    // pass the resolved palette + useCategoryColor=true. Otherwise the
    // extension idles (its shader branch is gated by useCategoryColor).
    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedIconLayer:paletteOverflow',
        `[AnimatedIconLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Keep the extension list constant across sublayers (cache-storm rationale,
    // as in AnimatedPointLayer). User extensions from the top-level
    // `extensions` prop are appended via composeExtensions.
    const extensions = this.composeExtensions([
      this.timeFilterExtension,
      this.categoryColorExtension,
    ]);

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.icons` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('icons', prepared.tileKey, {
      data: prepared.data as any,
      // Identity comparator: deck.gl skips prop-diff for `data` entirely when
      // the same object reference comes back. Pairs with the preparedTileCache.
      dataComparator: (a: any, b: any) => a === b,

      // Icon atlas + mapping forwarded verbatim.
      iconAtlas: this.props.iconAtlas,
      iconMapping: this.props.iconMapping,
      // Single constant icon for ALL features — binary tiles can't run a
      // per-row getIcon accessor. Per-category icons are a future enhancement.
      getIcon: () => icon,

      sizeUnits: this.props.sizeUnits,
      sizeScale: this.props.sizeScale,
      sizeMinPixels: this.props.sizeMinPixels,
      sizeMaxPixels: this.props.sizeMaxPixels,
      sizeBasis: this.props.sizeBasis,
      billboard: this.props.billboard,
      alphaCutoff: this.props.alphaCutoff,
      // Atlas sampler params (filtering/wrap); null keeps IconManager defaults.
      textureParameters: this.props.textureParameters,

      // Constant fallbacks — used when the matching binary attribute is absent.
      getAngle: constAngle,
      getSize: constSize,
      getColor: constColor,
      getPixelOffset: constPixelOffset,

      // Time-as-height (space-time cube): whole icons lift by start time.
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,

      extensions,

      // TimeFilterExtension wiring — per-tile timeOffset and window (no trail).
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,

      // TileLayer convention: the source tile rides on the sublayer so the base
      // getPickingInfo can enrich info.tile / decode the picked feature.
      tile: prepared.tile,
      sttFeatures: prepared.features,

      // Always set `useCategoryColor` so tests / debug tooling can distinguish
      // the two paths via prop inspection. The extension only works when true.
      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: prepared.gpuPalette! } : {}),
    });
    // `_subLayerProps: { icons: { type } }` swaps the sublayer class — the
    // CompositeLayer-native renderSubLayers-style override point.
    const SubLayerClass = this.getSubLayerClass('icons', IconLayer);
    return new SubLayerClass(props as any);
  }
}

/**
 * Pad a 2D Float64Array of positions [x0,y0, x1,y1, ...] into a 3D buffer
 * [x0,y0,0, x1,y1,0, ...] for IconLayer's size-3 position attribute. The only
 * allocation per tile in the prepare step.
 */
function padPositionsTo3D(src: Float64Array, count: number): Float64Array {
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = src[i * 2];
    out[i * 3 + 1] = src[i * 2 + 1];
    // out[i * 3 + 2] = 0; (already zero-initialized)
  }
  return out;
}
