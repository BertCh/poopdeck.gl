// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * AnimatedPointLayer - GPU-efficient point rendering with time filtering.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One ScatterplotLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, attributes }`
 *   interface, with positions / startTimes / endTimes referenced DIRECTLY
 *   from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension instance. No layer-wide rebasing pass.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation, so the demo's tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is
 *   stable across renderLayers() calls; deck.gl short-circuits GPU
 *   re-uploads when the reference matches.
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 *
 * The previous v2 consolidation path allocated a single ~3.6 GB chunk at
 * 100M points (one Float64Array for positions + two Float32Array for times)
 * and re-uploaded it on every tile arrival. Per-tile sublayers replace that
 * with one ~36 MB Arrow-backed view per tile and zero copies.
 *
 * Categorical colors lift to the GPU via CategoryColorExtension when the
 * caller does NOT provide a `colorMapping` (which is inherently CPU-side
 * because it indexes by category STRING). With a mapping set, we fall back
 * to the legacy CPU-expansion path on the cold tile-prepare step.
 */

import { ScatterplotLayer } from '@deck.gl/layers';
import type { Color, DefaultProps, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from './category-color-extension';
import { emit } from './telemetry';
import { warnOnce } from './log';
import type { Tile, Layer as TileLayer } from '@stt/core';

const DEBUG = false;

export interface AnimatedPointLayerProps extends SpatioTemporalLayerProps {
  /**
   * Radius scale multiplier.
   * @default 1
   */
  radiusScale?: number;

  /**
   * Radius units.
   * @default 'pixels'
   */
  radiusUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Fill color — constant {@link Color}, or property name for categorical coloring.
   * @default [255, 128, 0, 255]
   */
  fillColor?: Color | string;

  /**
   * Radius — constant number, or property name for per-feature radius.
   * @default 5
   */
  radius?: number | string;

  /** Color palette for categorical `fillColor`. */
  colorPalette?: Color[];

  /**
   * Explicit category-to-color map. When set together with a string `fillColor`
   * property, each feature's color is `colorMapping[categoryValue]`, using
   * `colorMappingDefault` (or transparent) for unknown values. This is the
   * only way to get stable colors across tiles whose categorical column
   * contains different category subsets — the first-seen palette index
   * fallback assigns the same band a different palette slot per tile.
   *
   * NOTE: setting this forces the CPU palette-expansion path (one Uint8Array
   * RGBA per tile) because the GPU palette texture has no way to look up by
   * the category STRING. With `colorMapping` unset, the GPU CategoryColorExtension
   * handles the lookup in the fragment shader against the `colorPalette`.
   */
  colorMapping?: Record<string, Color>;

  /** Fallback color for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;

  /**
   * Per-feature radius transform, applied to the numeric value of the
   * `radius` property column before the GPU receives it. Useful for
   * non-linear scalings (e.g. magnitude → area).
   */
  radiusTransform?: (value: number) => number;

  /** Minimum on-screen radius in pixels. Forwarded to ScatterplotLayer. */
  radiusMinPixels?: number;

  /** Maximum on-screen radius in pixels. Forwarded to ScatterplotLayer. */
  radiusMaxPixels?: number;

  /** Outline stroke width in pixels. Forwarded to ScatterplotLayer. */
  lineWidthMinPixels?: number;

  /**
   * Whether to render an outline stroke around each point.
   * @default false
   */
  stroked?: boolean;

  /** Stroke color (constant). */
  strokeColor?: Color;

  /**
   * Whether to fill the marker.
   * @default true
   */
  filled?: boolean;

  /**
   * Fade-in duration for appearing points (ms).
   * @default 300
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration for disappearing points (ms).
   * @default 300
   */
  fadeOutDuration?: number;

  /**
   * Wake length in milliseconds. When > 0, switches the layer into a
   * one-sided "ship wake" rendering: each point is visible only while
   * `0 <= currentTime - startTime <= wakeLength`, its alpha fades linearly
   * to 0 at the trailing edge, and its on-screen radius shrinks to
   * `wakeTailScale` × head radius. Takes precedence over the symmetric
   * window/fadeIn/fadeOut filter inherited from TimeFilterExtension.
   *
   * The caller must ensure `timeWindow >= 2 × wakeLength` so the tile
   * loader actually fetches the past half of the wake — the shader filter
   * is independent of the tile-loading window.
   */
  wakeLength?: number;

  /**
   * Trailing-edge size multiplier in wake mode (0..1). Head = 1.0, tail =
   * `wakeTailScale`. Defaults to 0.15.
   */
  wakeTailScale?: number;

  /**
   * Enable 3D positions (altitude / elevation). The v3 layer infers 3D from
   * the tile's `positionDimensions` automatically — the prop is kept for
   * API compatibility with v2 callers and forwarded as a hint. 2D tiles
   * are padded with z=0; 3D tiles ride zero-copy.
   */
  use3D?: boolean;

  /**
   * Property name to source elevation from when the tile's positions are
   * 2D. Currently a forward-declared no-op in the v3 layer (the per-tile
   * binary path uses the tile's stored z if present); the prop is kept on
   * the type to preserve v2 dataset configs.
   */
  elevationProperty?: string | null;

  /**
   * Scale factor for elevation values. Forward-declared (see `elevationProperty`).
   * @default 1
   */
  elevationScale?: number;
}

// Default color palette for categorical data
const DEFAULT_PALETTE: Color[] = [
  [31, 119, 180, 255],
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

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * deck.gl is stable across renders — deck.gl compares `data` by reference
 * (with our dataComparator: ===) to decide whether to re-upload GPU buffers.
 *
 * Mirrors AnimatedTripsLayer / AnimatedPathLayer's PreparedTile shape.
 */
interface PreparedTile {
  /** Resolved (tile, layer) cache key. */
  tileKey: string;
  /** Hash of style props that affect the prepared `attributes`. */
  styleKey: string;
  /** Reference-stable data object for ScatterplotLayer's binary interface. */
  data: {
    length: number;
    attributes: Record<string, { value: any; size: number; normalized?: boolean }>;
  };
  /** Per-tile time reference; passed to TimeFilterExtension as `timeOffset`. */
  timeOffset: number;
  /**
   * When the GPU categorical-color path is active for this tile, the resolved
   * palette to pass to the extension. Null when CPU-side colors / constant
   * color are in use.
   */
  gpuPalette: Color[] | null;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Expand category indices into a flat Uint8Array RGBA buffer using an
 * explicit colorMapping (category STRING → Color). The CPU path is
 * unavoidable here because the GPU palette texture can only be indexed by
 * a numeric category id, not by an arbitrary string key.
 */
function expandMappedColors(
  indices: Uint16Array,
  categories: readonly string[],
  count: number,
  mapping: Record<string, Color>,
  fallback: Color,
): Uint8Array {
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const idx = indices[i];
    const cat = idx === 0xffff ? undefined : categories[idx];
    const color = (cat !== undefined && mapping[cat]) || fallback;
    const o = i * 4;
    out[o] = color[0];
    out[o + 1] = color[1];
    out[o + 2] = color[2];
    out[o + 3] = color[3] ?? 255;
  }
  return out;
}

/**
 * For categorical columns with no `colorMapping`, hand the category indices
 * straight to the GPU as a single-component float attribute. The
 * CategoryColorExtension samples the palette texture in the fragment shader.
 *
 * `indices` arrive as Uint16Array (4096 categories max); the extension reads
 * them as float32. We do a narrowing copy here rather than running a shader
 * permutation per integer type.
 */
function indicesToFloat32(indices: Uint16Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i];
  return out;
}

/**
 * Animated point layer with per-tile binary sublayers.
 *
 * Each visible tile produces one ScatterplotLayer instance that is cached
 * across renders. Time updates flow through getTime() on the extension; tile
 * arrivals only construct one new sublayer + one GPU upload, never touching
 * the buffers of already-loaded tiles.
 */
export class AnimatedPointLayer extends SpatioTemporalLayer<AnimatedPointLayerProps> {
  static layerName = 'AnimatedPointLayer';

  static defaultProps: DefaultProps<AnimatedPointLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    radiusScale: { type: 'number', value: 1, min: 0 },
    radiusUnits: 'pixels',
    fillColor: { type: 'color', value: [255, 128, 0, 255] },
    radius: { type: 'number', value: 5 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },

    // Animation props (unused on the GPU side after the rewrite; kept for
    // API compatibility with v2 callers that pass them in).
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },

    // Wake-mode props. wakeLength=0 keeps the symmetric window behavior.
    wakeLength: { type: 'number', value: 0, min: 0 },
    wakeTailScale: { type: 'number', value: 0.15, min: 0 },

    // 3D forward-declared props (see prop docstrings). The v3 layer reads 3D
    // directly from the tile's positionDimensions; these are accepted on the
    // type so v2 dataset configs continue to compile.
    use3D: false,
    elevationProperty: { type: 'object', value: null, optional: true, compare: true },
    elevationScale: { type: 'number', value: 1, min: 0 },
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Returning the SAME ScatterplotLayer
   * reference across renderLayers() calls lets deck.gl short-circuit prop
   * diff entirely. Allocating a fresh layer per visible tile per frame (as
   * the v2 consolidation rewrite would in any non-trivial workflow) was the
   * single largest source of frame-time variance at 50+ tiles.
   */
  private sublayerCache = new Map<
    string,
    { layer: ScatterplotLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction time. */
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Extensions are
   * stateless w.r.t. data; per-tile timeOffset is passed as a layer prop.
   *
   * Point layer uses window-mode filtering (whole feature on/off + fade) so
   * the per-vertex time attribute is unused. Restricting registration to
   * start/end frees a vertex-attribute slot for the picking buffer.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({ mode: 'window' });

  /**
   * Singleton CategoryColorExtension. Like the time filter, it's stateless —
   * the palette and `useCategoryColor` toggle ride through layer props. We
   * always include it in the layer's extension list: when the per-tile data
   * lacks `instanceCategoryIndex`, the shader branch is gated off via the
   * uniform.
   */
  private readonly categoryColorExtension = new CategoryColorExtension();

  /**
   * Stable getTime reference. Critical: deck.gl re-runs work when accessor
   * function references change; a fresh arrow every render defeats the cache.
   */
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  /**
   * Compute a digest of the layer-level props that affect every sublayer.
   * When this changes we throw away the entire sublayer cache.
   */
  private computeLayerPropsKey(): string {
    return [
      this.props.radiusScale,
      this.props.radiusUnits,
      this.props.radiusMinPixels,
      this.props.radiusMaxPixels,
      this.props.lineWidthMinPixels,
      this.props.stroked,
      this.props.filled,
      Array.isArray(this.props.strokeColor)
        ? this.props.strokeColor.join(',')
        : '',
      this.props.opacity,
      this.props.visible,
      this.props.pickable,
      this.props.timeWindow,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      this.props.wakeLength,
      this.props.wakeTailScale,
      // fillColor/radius constant branches only — the property-driven path
      // lives in `prepared` and is keyed via preparedKey.
      Array.isArray(this.props.fillColor) ? this.props.fillColor.join(',') : '',
      typeof this.props.radius === 'number' ? this.props.radius : 0,
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune cache only when the tile-array ref changed — when the parent
    // hands us the same `state.tiles` instance, the live and cached sets are
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
      layer: 'AnimatedPointLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedPointLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  /**
   * Build (or fetch from cache) the binary `data` object for a single tile.
   */
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;

    const fillColorProp = typeof this.props.fillColor === 'string' ? this.props.fillColor : '';
    const radiusProp = typeof this.props.radius === 'string' ? this.props.radius : '';
    // Palette identity matters only when fillColor is a column name. Including
    // the mapping flag toggles between CPU/GPU expansion paths.
    const usingMapping = !!this.props.colorMapping;
    const styleKey = `${fillColorProp}|${radiusProp}|${
      fillColorProp ? (this.props.colorPalette ?? DEFAULT_PALETTE).length : 0
    }|${usingMapping ? 'm' : 'g'}`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      const t1 = performance.now();
      emit('tilePrepare', { layer: 'AnimatedPointLayer', tileKey, cached: true, ms: 0 });
      void t1;
      return cached;
    }

    const t0 = performance.now();
    const count = binary.featureCount;
    const srcDims = binary.positionDimensions ?? 2;

    // ScatterplotLayer expects size=3 positions. When the tile is 2D we keep
    // the original buffer if it already has stride 3 (rare), otherwise pad
    // once into a fresh Float64Array. The pad copy is per-tile, not per-tile-set,
    // so cost is amortized across animation frames.
    const positions: Float64Array =
      srcDims === 3
        ? binary.positions
        : padPositionsTo3D(binary.positions, count);

    const attributes: PreparedTile['data']['attributes'] = {
      getPosition: { value: positions, size: 3 },
      // Extension-registered attribute names — must match
      // TimeFilterExtension.initializeState exactly. Zero-copy: the tile's
      // own Float32Arrays (relative to binary.timeOffset) ride straight to
      // the GPU.
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    let gpuPalette: Color[] | null = null;

    // Property-driven color
    if (fillColorProp) {
      const cat = binary.categoricalProps[fillColorProp];
      const num = binary.numericProps[fillColorProp];
      const palette = this.props.colorPalette ?? DEFAULT_PALETTE;

      if (cat) {
        if (this.props.colorMapping) {
          // CPU branch: indexed by category string → no way to do this on the
          // GPU without a string→int hash on every frame.
          const fallback =
            this.props.colorMappingDefault ?? ([0, 0, 0, 0] as Color);
          attributes.getFillColor = {
            value: expandMappedColors(
              cat.indices,
              cat.categories,
              count,
              this.props.colorMapping,
              fallback,
            ),
            size: 4,
            normalized: true,
          };
        } else {
          // GPU branch: hand category indices to the CategoryColorExtension.
          attributes.instanceCategoryIndex = {
            value: indicesToFloat32(cat.indices, count),
            size: 1,
          };
          gpuPalette = palette;
        }
      } else if (num && this.props.colorMapping) {
        // Numeric column + mapping: stringify lookup (rare).
        const fallback =
          this.props.colorMappingDefault ?? ([0, 0, 0, 0] as Color);
        const out = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
          const color = this.props.colorMapping[String(num[i])] || fallback;
          const o = i * 4;
          out[o] = color[0];
          out[o + 1] = color[1];
          out[o + 2] = color[2];
          out[o + 3] = color[3] ?? 255;
        }
        attributes.getFillColor = { value: out, size: 4, normalized: true };
      }
    }

    // Property-driven radius — already Float32Array, ride zero-copy unless
    // radiusTransform is set (which forces a per-tile pass).
    if (radiusProp) {
      const values = binary.numericProps[radiusProp];
      if (values) {
        const transform = this.props.radiusTransform;
        if (transform) {
          const out = new Float32Array(count);
          for (let i = 0; i < count; i++) out[i] = transform(values[i]);
          attributes.getRadius = { value: out, size: 1 };
        } else {
          attributes.getRadius = { value: values, size: 1 };
        }
      }
    }

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      data: { length: count, attributes },
      timeOffset: binary.timeOffset,
      gpuPalette,
    };
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'AnimatedPointLayer',
      tileKey,
      cached: false,
      features: count,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): ScatterplotLayer {
    const sublayerId = `${this.props.id}-${prepared.tileKey}`;
    const timeWindow = this.props.timeWindow || 86400000;
    const constRadius =
      typeof this.props.radius === 'number' ? this.props.radius : 5;
    const constColor = (Array.isArray(this.props.fillColor)
      ? this.props.fillColor
      : ([255, 128, 0, 255] as Color)) as Color;

    // CategoryColorExtension props: when this tile uses the GPU palette path
    // we pass the resolved palette + useCategoryColor=true. Otherwise the
    // extension idles (its shader branch is gated by useCategoryColor).
    const useGpuCategory = prepared.gpuPalette !== null;
    if (
      useGpuCategory &&
      prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE
    ) {
      warnOnce(
        'AnimatedPointLayer:paletteOverflow',
        `[AnimatedPointLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // Keep the extension list constant across sublayers — see
    // animated-trips-layer.ts for the cache-storm rationale.
    const extensions: any[] = [this.timeFilterExtension, this.categoryColorExtension];
    const props: Record<string, any> = {
      id: sublayerId,
      data: prepared.data as any,
      // Identity comparator: deck.gl skips prop-diff for `data` entirely when
      // the same object reference comes back. Pairs with the preparedTileCache
      // which guarantees stable identity.
      dataComparator: (a: any, b: any) => a === b,

      radiusUnits: this.props.radiusUnits ?? 'pixels',
      radiusScale: this.props.radiusScale ?? 1,
      radiusMinPixels: this.props.radiusMinPixels ?? 0,
      radiusMaxPixels: this.props.radiusMaxPixels ?? Number.MAX_SAFE_INTEGER,
      stroked: this.props.stroked ?? false,
      filled: this.props.filled ?? true,
      getLineColor: this.props.strokeColor ?? [0, 0, 0, 255],
      lineWidthMinPixels: this.props.lineWidthMinPixels ?? 0,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,

      // Constant fallbacks — used when the binary attribute is absent.
      getRadius: constRadius,
      getFillColor: constColor,

      extensions,

      // TimeFilterExtension wiring
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      wakeLength: this.props.wakeLength,
      wakeTailScale: this.props.wakeTailScale,
    };
    // Always set `useCategoryColor` so tests / debug tooling can distinguish
    // the two paths via prop inspection. The extension itself is only
    // attached when the flag is true (saves an attribute slot).
    props.useCategoryColor = useGpuCategory;
    if (useGpuCategory) {
      props.categoryPalette = prepared.gpuPalette!;
    }
    return new ScatterplotLayer(props as any);
  }
}

/**
 * Pad a 2D Float64Array of positions [x0,y0, x1,y1, ...] into a 3D buffer
 * [x0,y0,0, x1,y1,0, ...] for ScatterplotLayer's size-3 attribute. This is
 * the only allocation per tile in the prepare step; the previous v2 path
 * allocated this AND the consolidated buffer for every tile in the visible set.
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
