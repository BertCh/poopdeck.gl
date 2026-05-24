/**
 * AnimatedPolygonLayer - GPU-filtered polygon rendering with time windowing.
 *
 * ARCHITECTURE (v3 - GPU time filtering, per-tile sublayers):
 * - One SolidPolygonLayer per (tile, layer). Same pattern as
 *   AnimatedPath/Trips/Point layers.
 * - Time filtering lifted to the GPU via PolygonTimeFilterExtension. The
 *   previous CPU pass (`getVisibleFeatureIndices` + `extractVisiblePolygons`)
 *   ran every render, scaled O(featureCount × renderRate), and at 100k
 *   polygons dominated the frame budget. With this extension polygons are
 *   uploaded ONCE per tile and time-window changes only update uniforms.
 * - Categorical fill colors lift to the GPU via CategoryColorExtension —
 *   same wiring as the other animated layers.
 * - Per-tile timeOffset on each sublayer (no layer-wide rebasing).
 * - dataComparator: (a, b) => a === b lets deck.gl short-circuit prop diff
 *   when the cached prepared data ref is unchanged.
 *
 * KNOWN LIMITATION (tile-seam overdraw, deferred): polygons that span a tile
 * boundary are split across tiles and drawn by separate sublayers. With
 * opacity < 1 the two halves blend twice along the seam; extruded polygons
 * can z-fight. Consolidating into a single SolidPolygonLayer would fix it
 * but needs careful startIndices handling across variable ring counts.
 * Prefer fully-opaque fills until that lands.
 */

import { SolidPolygonLayer } from '@deck.gl/layers';
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { PolygonTimeFilterExtension } from './polygon-time-filter-extension';
import {
  CategoryColorExtension,
  CATEGORY_PALETTE_SIZE,
} from './category-color-extension';
import { emit } from './telemetry';
import type { Tile, Layer as TileLayer } from '@stt/core';

const DEBUG = false;

export interface AnimatedPolygonLayerProps extends SpatioTemporalLayerProps {
  /** Draw an outline around each polygon (slower; routes through PathLayer). */
  stroked?: boolean;

  /** Fill the polygon (default true). */
  filled?: boolean;

  /** Outline width in pixels. */
  lineWidthUnits?: 'pixels' | 'meters' | 'common';

  /** Outline width (constant or property name). */
  lineWidth?: number | string;

  /** Outline color (constant or property name). */
  lineColor?: Color | string;

  /** Fill color — constant value, or column name for categorical coloring. */
  fillColor?: Color | string;

  /** Color palette for the categorical fillColor path. */
  colorPalette?: Color[];

  /** Elevation (constant or property name). */
  elevation?: number | string;

  /** Extruded (3D) polygons. */
  extruded?: boolean;

  /** Fade-in duration (ms). */
  fadeInDuration?: number;

  /** Fade-out duration (ms). */
  fadeOutDuration?: number;
}

const DEFAULT_PALETTE: Color[] = [
  [255, 140, 0, 180],
  [31, 119, 180, 180],
  [44, 160, 44, 180],
  [214, 39, 40, 180],
  [148, 103, 189, 180],
  [140, 86, 75, 180],
  [227, 119, 194, 180],
  [127, 127, 127, 180],
  [188, 189, 34, 180],
  [23, 190, 207, 180],
];

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * SolidPolygonLayer is stable across renders — pairs with dataComparator
 * to short-circuit deck.gl's prop diff.
 */
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
  /** Resolved palette for the GPU categorical-color path, or null. */
  gpuPalette: Color[] | null;
  /**
   * True when the tile carried a pre-baked `triangles` index buffer (MLT
   * mode). Lets the sublayer construction path skip deck.gl's internal
   * PolygonTesselator (earcut) by setting `_normalize: false` and feeding
   * the indices directly through `data.attributes.indices`.
   */
  hasPreBakedTriangles: boolean;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/** Narrow Uint16Array → Float32Array for the GPU CategoryColorExtension. */
function indicesToFloat32(indices: Uint16Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i];
  return out;
}

/**
 * Animated polygon layer with GPU time filtering and per-tile sublayers.
 */
export class AnimatedPolygonLayer extends SpatioTemporalLayer<AnimatedPolygonLayerProps> {
  static layerName = 'AnimatedPolygonLayer';

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    stroked: false,
    filled: true,
    lineWidthUnits: 'pixels' as const,
    lineWidth: { type: 'number', value: 1 },
    lineColor: { type: 'color', value: [0, 0, 0, 255] as Color },
    fillColor: { type: 'color', value: [255, 140, 0, 180] as Color },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },
    elevation: { type: 'number', value: 0 },
    extruded: false,
    fadeInDuration: { type: 'number', value: 500, min: 0 },
    fadeOutDuration: { type: 'number', value: 500, min: 0 },
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Mirrors the other animated layers'
   * pattern: returning the SAME SolidPolygonLayer reference per tile across
   * renderLayers() lets deck.gl short-circuit prop diff entirely.
   */
  private sublayerCache = new Map<
    string,
    { layer: SolidPolygonLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction. */
  private lastLayerPropsKey: string = '';

  /** Singleton extensions, reused by every sublayer (stateless w.r.t. data). */
  private readonly polygonTimeFilterExtension = new PolygonTimeFilterExtension();
  private readonly categoryColorExtension = new CategoryColorExtension();

  /** Stable getTime; preserved across renders to keep prop refs stable. */
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  private computeLayerPropsKey(): string {
    return [
      this.props.stroked,
      this.props.filled,
      this.props.extruded,
      typeof this.props.elevation === 'number' ? this.props.elevation : 0,
      this.props.opacity,
      this.props.visible,
      this.props.pickable,
      this.props.timeWindow,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      // fillColor constant branch only; categorical branch lives in `prepared`.
      Array.isArray(this.props.fillColor) ? this.props.fillColor.join(',') : '',
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      // No setState here — the empty result is itself the signal to deck.gl
      // that the previous sublayers should unmount.
      this.preparedTileCache.clear();
      this.sublayerCache.clear();
      return [];
    }

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
      layer: 'AnimatedPolygonLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedPolygonLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const fillColorProp =
      typeof this.props.fillColor === 'string' ? this.props.fillColor : '';
    const elevationProp =
      typeof this.props.elevation === 'string' ? this.props.elevation : '';
    const styleKey = `${fillColorProp}|${elevationProp}|${
      fillColorProp ? (this.props.colorPalette ?? DEFAULT_PALETTE).length : 0
    }`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', {
        layer: 'AnimatedPolygonLayer',
        tileKey,
        cached: true,
        ms: 0,
      });
      return cached;
    }

    const t0 = performance.now();
    const dims = binary.positionDimensions ?? 2;

    // Zero-copy: positions, startIndices, startTimes, endTimes all ride
    // straight from the Arrow-backed tile buffers to the GPU. The previous
    // v2 path allocated fresh `positions` + `startIndices` arrays via
    // extractVisiblePolygons() on every render.
    const attributes: PreparedTile['data']['attributes'] = {
      // SolidPolygonLayer's geometry accessor — keyed by accessor name.
      getPolygon: { value: binary.positions, size: dims },
      // PolygonTimeFilterExtension non-instanced attribute names. The
      // PolygonTesselator expands these per-feature values across each
      // polygon's vertices.
      startTime: { value: binary.startTimes, size: 1 },
      endTime: { value: binary.endTimes, size: 1 },
    };

    let gpuPalette: Color[] | null = null;
    if (fillColorProp) {
      const cat = binary.categoricalProps[fillColorProp];
      if (cat) {
        attributes.instanceCategoryIndex = {
          value: indicesToFloat32(cat.indices, binary.featureCount),
          size: 1,
        };
        gpuPalette = this.props.colorPalette ?? DEFAULT_PALETTE;
      }
    }

    if (elevationProp) {
      const values = binary.numericProps[elevationProp];
      if (values) {
        attributes.getElevation = { value: values, size: 1 };
      }
    }

    // MLT-style pre-baked triangle indices. When the tile carries a
    // `triangles` sidecar (the Rust writer ran with `--pre-tessellate`),
    // we route it through deck.gl's `indices` binary attribute so the
    // PolygonTesselator skips its own earcut on tile arrival. Indices in
    // BinaryFeatures.triangles are already GLOBAL (the decoder applied
    // the per-feature `startIndices` shift), so no further translation is
    // needed here.
    const hasPreBakedTriangles =
      !!binary.triangles && binary.triangles.length > 0;
    if (hasPreBakedTriangles) {
      attributes.indices = { value: binary.triangles!, size: 1 };
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
      hasPreBakedTriangles,
    };
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'AnimatedPolygonLayer',
      tileKey,
      cached: false,
      features: binary.featureCount,
      gpuPalette: gpuPalette !== null,
      preBakedTriangles: hasPreBakedTriangles,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): SolidPolygonLayer {
    const sublayerId = `${this.props.id}-${prepared.tileKey}`;
    const timeWindow = this.props.timeWindow || 86400000 * 30;
    const constFillColor = (Array.isArray(this.props.fillColor)
      ? this.props.fillColor
      : ([255, 140, 0, 180] as Color)) as Color;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (
      useGpuCategory &&
      prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[AnimatedPolygonLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    return new SolidPolygonLayer({
      id: sublayerId,
      data: prepared.data as any,
      dataComparator: (a: any, b: any) => a === b,

      // Pre-tesselated polygon data; SolidPolygonLayer normally re-normalizes
      // user-supplied polygons. Bypassing that keeps tile data zero-copy.
      _normalize: false,
      _windingOrder: 'CCW',

      filled: this.props.filled,
      extruded: this.props.extruded,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,

      // Constant fallback — used when binary getFillColor isn't present.
      getFillColor: constFillColor,
      ...(this.props.extruded && typeof this.props.elevation === 'number'
        ? { getElevation: this.props.elevation as number }
        : {}),

      extensions: [this.polygonTimeFilterExtension, this.categoryColorExtension],

      // PolygonTimeFilterExtension wiring
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,

      // CategoryColorExtension wiring (gated by useCategoryColor)
      categoryPalette: useGpuCategory ? prepared.gpuPalette! : [],
      useCategoryColor: useGpuCategory,
    } as any);
  }
}
