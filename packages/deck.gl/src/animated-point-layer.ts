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
 *
 * CUMULATIVE MODE (`cumulative: true`) takes a different render path. The
 * "draws itself" datasets widen the loader window to the whole dataset span,
 * so tiles are never evicted and the per-tile-sublayer count climbs into the
 * thousands by end of playback — one draw call each, re-issued on every
 * pan/zoom frame. That is what collapses a long cumulative playback to
 * single-digit FPS. So in cumulative mode we pack points append-only into a
 * small number of consolidated "slabs" (one ScatterplotLayer per slab, capped
 * at SLAB_CAPACITY_POINTS): frozen slabs keep a stable `data` ref (zero
 * re-upload), only the single open slab grows. Per-tile times are rebased to
 * one common slab offset — Float32-safe here because cumulative reveal already
 * tolerates tens-of-seconds time quantization (see TimeFilterExtension.draw).
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

/**
 * Cumulative consolidation: target points per consolidated slab. Sized so a
 * metro-scale cumulative playback resolves to a handful of slabs (≈ a handful
 * of draw calls) instead of thousands of per-tile sublayers, while keeping the
 * open slab's per-append re-upload small (≈ 250k × 36 B ≈ 9 MB worst case).
 */
const SLAB_CAPACITY_POINTS = 250_000;

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
   * Cumulative ("draw and persist") mode — see TimeFilterExtension. When true,
   * each point appears at its `startTime` and stays visible for the rest of
   * playback (the map "draws itself"). `fadeInDuration` doubles as the appear
   * ramp. The caller must widen the tile loader's window so revealed tiles stay
   * resident (the shader does the progressive reveal, not the loader).
   * @default false
   */
  cumulative?: boolean;

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

/**
 * Optional per-feature attributes a consolidated slab carries. Derived once
 * from the first absorbed tile — every tile in a slab shares one styleKey, so
 * one schema describes them all.
 */
interface SlabSchema {
  hasFillColor: boolean;
  hasCategoryIndex: boolean;
  hasRadius: boolean;
  gpuPalette: Color[] | null;
}

/**
 * Append-only consolidated buffer for cumulative mode. Many tiles' points are
 * packed into one set of typed arrays → one ScatterplotLayer → one draw call.
 * Frozen slabs are never rewritten (stable `data` ref ⇒ zero re-upload); only
 * the single open slab grows as new tiles arrive. Arrays are allocated at
 * `capacity` up front; the trailing unused tail of the final (open) slab is
 * the only wasted space.
 */
interface ConsolidatedSlab {
  capacity: number;
  count: number;
  positions: Float64Array; // size 3 (padded from 2D tiles)
  startTimes: Float32Array; // rebased to the layer's common slab offset
  endTimes: Float32Array;
  fillColors: Uint8Array | null; // size 4, normalized
  categoryIndex: Float32Array | null;
  radii: Float32Array | null;
  frozen: boolean;
  /** Bumped on every append; the cached data + layer are rebuilt when they fall behind. */
  version: number;
  /** Reference-stable binary `data` object, keyed by `dataVersion` (== `version`). */
  dataRef: { length: number; attributes: Record<string, any> } | null;
  dataVersion: number;
  layer: ScatterplotLayer | null;
  builtVersion: number;
}

function deriveSlabSchema(built: PreparedTile): SlabSchema {
  const a = built.data.attributes;
  return {
    hasFillColor: !!a.getFillColor,
    hasCategoryIndex: !!a.instanceCategoryIndex,
    // Per-feature radius only — a constant radius rides a scalar prop, not an attribute.
    hasRadius: !!a.getRadius && a.getRadius.value instanceof Float32Array,
    gpuPalette: built.gpuPalette,
  };
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

  /* ── Cumulative consolidation state (cumulative mode only) ─────────────── */
  /** Packed slabs, in arrival order. The last entry is the open (growing) slab. */
  private slabs: ConsolidatedSlab[] = [];
  /** Tile keys already packed into a slab — skipped on subsequent renders. */
  private absorbedTileKeys = new Set<string>();
  /** Common timeOffset every slab's times are rebased to (Float32-safe in cumulative). */
  private slabBaseOffset = 0;
  /** `styleKey|zoom` of the current slabs; a change forces a full data rebuild. */
  private slabSchemaKey: string | null = null;
  /** Optional-attribute schema shared by every slab (from the first absorbed tile). */
  private slabSchema: SlabSchema | null = null;
  /** Visual layer-prop digest; a change rebuilds slab LAYERS but keeps the packed data. */
  private lastSlabLayerPropsKey = '';

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
    this.slabs = [];
    this.absorbedTileKeys.clear();
    this.slabSchema = null;
    this.slabSchemaKey = null;
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
    // Cumulative "draws itself" datasets use a consolidated, append-only path:
    // packing points into a few slabs instead of one sublayer per resident
    // tile is what keeps a long playback off the thousands-of-draw-calls cliff.
    if (this.props.cumulative) {
      return this.renderConsolidated();
    }

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
   * styleKey digest of the props that change a tile's prepared `attributes`
   * (which color/radius column, palette length, CPU-vs-GPU color path). Shared
   * by the per-tile cache check and the slab-schema invalidation.
   */
  private computeStyleKey(): string {
    const fillColorProp = typeof this.props.fillColor === 'string' ? this.props.fillColor : '';
    const radiusProp = typeof this.props.radius === 'string' ? this.props.radius : '';
    // Palette identity matters only when fillColor is a column name. Including
    // the mapping flag toggles between CPU/GPU expansion paths.
    const usingMapping = !!this.props.colorMapping;
    return `${fillColorProp}|${radiusProp}|${
      fillColorProp ? (this.props.colorPalette ?? DEFAULT_PALETTE).length : 0
    }|${usingMapping ? 'm' : 'g'}`;
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
      emit('tilePrepare', { layer: 'AnimatedPointLayer', tileKey, cached: true, ms: 0 });
      return cached;
    }
    const prepared = this.buildTileData(tile, tileLayer);
    if (prepared) this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /**
   * Build the binary `data` object for a single tile from scratch (no caching).
   * Shared by the cached per-tile path (`prepareTile`) and the cumulative
   * consolidation path, which copies the result into a slab and discards it.
   */
  private buildTileData(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;

    const fillColorProp = typeof this.props.fillColor === 'string' ? this.props.fillColor : '';
    const radiusProp = typeof this.props.radius === 'string' ? this.props.radius : '';
    const styleKey = this.computeStyleKey();
    const tileKey = makeTileKey(tile, tileLayer);

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

      ...this.commonStyleProps(),

      // Constant fallbacks — used when the binary attribute is absent.
      getRadius: constRadius,
      getFillColor: constColor,

      extensions,

      // TimeFilterExtension wiring — per-tile timeOffset and window.
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
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

  /**
   * Visual + time-filter props shared by every ScatterplotLayer this layer
   * emits, whether a per-tile sublayer or a consolidated slab. Excludes the
   * bits that differ per path: `data`/`dataComparator`, the constant
   * radius/color fallbacks, `extensions`, and the time wiring
   * (`getTime`/`timeOffset`/`timeWindow`).
   */
  private commonStyleProps(): Record<string, any> {
    return {
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
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      wakeLength: this.props.wakeLength,
      wakeTailScale: this.props.wakeTailScale,
      cumulative: this.props.cumulative,
    };
  }

  /* ── Cumulative consolidation path ──────────────────────────────────────
   * Pack resident tiles append-only into a few ScatterplotLayer "slabs"
   * instead of one sublayer per tile. See the file header for why.
   */

  private renderConsolidated(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;

    // Data switch / pre-load: collapse everything so the next archive starts clean.
    if (!tiles || tiles.length === 0) {
      if (this.slabs.length) {
        this.slabs = [];
        this.absorbedTileKeys.clear();
        this.slabSchema = null;
        this.slabSchemaKey = null;
      }
      return [];
    }

    // All resident tiles share one zoom (the viewport's). styleKey + that zoom
    // key the packed attributes; a change in either (restyle, or zoom in/out)
    // means the existing slabs no longer describe the current view → full
    // rebuild from the now-resident tiles. Cheap: zoom/style changes are rare
    // and user-driven, unlike the per-frame tile arrivals consolidation targets.
    const zoom = tiles[0].id.z;
    const schemaKey = `${this.computeStyleKey()}|${zoom}`;
    if (schemaKey !== this.slabSchemaKey) {
      this.slabSchemaKey = schemaKey;
      this.slabs = [];
      this.absorbedTileKeys.clear();
      this.slabSchema = null;
      this.slabBaseOffset = this.props.timeRange?.start ?? 0;
    }

    // Append every not-yet-packed tile into the open slab. In cumulative mode
    // tiles are only ever added (the loader keeps the whole span resident), so
    // there is no removal path — a tile spatially evicted then revisited stays
    // in `absorbedTileKeys` and is not re-packed. This append-only persistence
    // is what makes the fast path O(new points), not O(resident points).
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const key = makeTileKey(tile, tileLayer);
        if (this.absorbedTileKeys.has(key)) continue;
        this.absorbedTileKeys.add(key); // mark even if empty so we never retry it
        const built = this.buildTileData(tile, tileLayer);
        if (!built) continue;
        if (!this.slabSchema) this.slabSchema = deriveSlabSchema(built);
        this.absorbTile(built);
      }
    }

    // Visual-only prop change (opacity, radiusScale, stroke…): rebuild the slab
    // LAYERS but keep the packed data — no need to re-copy millions of points.
    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastSlabLayerPropsKey) {
      this.lastSlabLayerPropsKey = layerPropsKey;
      for (const slab of this.slabs) {
        slab.layer = null;
        slab.builtVersion = -1;
      }
    }

    const sublayers: Layer[] = this.slabs.map((slab, i) => this.buildSlabLayer(slab, i));

    emit('renderLayers', {
      layer: 'AnimatedPointLayer',
      mode: 'cumulative',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedPointLayer[cumulative]: ${tiles.length} tiles → ${sublayers.length} slabs`,
      );
    }
    return sublayers;
  }

  /** Copy one prepared tile's attributes into the open slab, rebasing times. */
  private absorbTile(built: PreparedTile): void {
    const n = built.data.length;
    if (n === 0) return;
    const slab = this.slabForAppend(n);
    const o = slab.count;
    const a = built.data.attributes;

    slab.positions.set(a.getPosition.value as Float64Array, o * 3);

    // Rebase the tile's per-tile-relative times onto the common slab offset:
    //   absolute = built.timeOffset + tileRelative  ⇒  slabRelative = tileRelative + delta
    // Computed via JS doubles, stored as Float32. Magnitudes reach the dataset
    // span (~years); the resulting tens-of-seconds quantization is below what
    // the cumulative reveal can show (see TimeFilterExtension.draw precision note).
    const delta = built.timeOffset - this.slabBaseOffset;
    const st = a.instanceStartTime.value as Float32Array;
    const et = a.instanceEndTime.value as Float32Array;
    for (let i = 0; i < n; i++) {
      slab.startTimes[o + i] = st[i] + delta;
      slab.endTimes[o + i] = et[i] + delta;
    }

    if (slab.fillColors && a.getFillColor) {
      slab.fillColors.set(a.getFillColor.value as Uint8Array, o * 4);
    }
    if (slab.categoryIndex && a.instanceCategoryIndex) {
      slab.categoryIndex.set(a.instanceCategoryIndex.value as Float32Array, o);
    }
    if (slab.radii && a.getRadius && a.getRadius.value instanceof Float32Array) {
      slab.radii.set(a.getRadius.value, o);
    }

    slab.count += n;
    slab.version++;
  }

  /**
   * The open slab if it has room for `n` more points, else seal it and open a
   * fresh one. A single tile larger than the cap gets its own oversized slab.
   */
  private slabForAppend(n: number): ConsolidatedSlab {
    const open = this.slabs[this.slabs.length - 1];
    if (open && !open.frozen && open.count + n <= open.capacity) return open;
    if (open && !open.frozen) open.frozen = true;

    const schema = this.slabSchema!;
    const capacity = Math.max(SLAB_CAPACITY_POINTS, n);
    const slab: ConsolidatedSlab = {
      capacity,
      count: 0,
      positions: new Float64Array(capacity * 3),
      startTimes: new Float32Array(capacity),
      endTimes: new Float32Array(capacity),
      fillColors: schema.hasFillColor ? new Uint8Array(capacity * 4) : null,
      categoryIndex: schema.hasCategoryIndex ? new Float32Array(capacity) : null,
      radii: schema.hasRadius ? new Float32Array(capacity) : null,
      frozen: false,
      version: 0,
      dataRef: null,
      dataVersion: -1,
      layer: null,
      builtVersion: -1,
    };
    this.slabs.push(slab);
    return slab;
  }

  /**
   * Reference-stable binary `data` object for one slab, rebuilt only when the
   * slab's content `version` advances. Subarray views share the slab's backing
   * buffer (no copy); a fresh object reference is what tells deck.gl to
   * re-upload the grown open slab — and reusing it across a style-only rebuild
   * is what lets deck.gl SKIP re-upload when only a uniform changed.
   */
  private slabData(slab: ConsolidatedSlab): { length: number; attributes: Record<string, any> } {
    if (slab.dataRef && slab.dataVersion === slab.version) return slab.dataRef;
    const count = slab.count;
    const attributes: Record<string, any> = {
      getPosition: { value: slab.positions.subarray(0, count * 3), size: 3 },
      instanceStartTime: { value: slab.startTimes.subarray(0, count), size: 1 },
      instanceEndTime: { value: slab.endTimes.subarray(0, count), size: 1 },
    };
    if (slab.fillColors) {
      attributes.getFillColor = {
        value: slab.fillColors.subarray(0, count * 4),
        size: 4,
        normalized: true,
      };
    }
    if (slab.categoryIndex) {
      attributes.instanceCategoryIndex = { value: slab.categoryIndex.subarray(0, count), size: 1 };
    }
    if (slab.radii) {
      attributes.getRadius = { value: slab.radii.subarray(0, count), size: 1 };
    }
    slab.dataRef = { length: count, attributes };
    slab.dataVersion = slab.version;
    return slab.dataRef;
  }

  /**
   * Build (or return the cached) ScatterplotLayer for one slab. Frozen slabs
   * keep a stable layer reference (their `version` never advances ⇒ no GPU
   * re-upload); the open slab rebuilds whenever it grew since last render.
   */
  private buildSlabLayer(slab: ConsolidatedSlab, index: number): ScatterplotLayer {
    if (slab.layer && slab.builtVersion === slab.version) return slab.layer;

    const constRadius = typeof this.props.radius === 'number' ? this.props.radius : 5;
    const constColor = (Array.isArray(this.props.fillColor)
      ? this.props.fillColor
      : ([255, 128, 0, 255] as Color)) as Color;
    const useGpuCategory = !!this.slabSchema?.gpuPalette;

    const props: Record<string, any> = {
      id: `${this.props.id}-slab-${index}`,
      data: this.slabData(slab),
      dataComparator: (a: any, b: any) => a === b,

      ...this.commonStyleProps(),

      getRadius: constRadius,
      getFillColor: constColor,

      // Constant extension list (cache-storm rationale, as in buildSublayer).
      extensions: [this.timeFilterExtension, this.categoryColorExtension],

      // TimeFilterExtension wiring — one shared offset for every slab.
      getTime: this.boundGetTime,
      timeOffset: this.slabBaseOffset,
      timeWindow: this.props.timeWindow || 86400000,

      useCategoryColor: useGpuCategory,
    };
    if (useGpuCategory) props.categoryPalette = this.slabSchema!.gpuPalette;

    const layer = new ScatterplotLayer(props as any);
    slab.layer = layer;
    slab.builtVersion = slab.version;
    return layer;
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
