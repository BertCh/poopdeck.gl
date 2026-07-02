// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedPolygonLayer - GPU-filtered polygon rendering with time windowing.
 *
 * ARCHITECTURE (v3 - GPU time filtering, per-tile sublayers):
 * - One SolidPolygonLayer per (tile, layer). Same pattern as
 *   AnimatedPath/Trips/Point layers.
 * - Time filtering lifted to the GPU via the shared TimeFilterExtension. The
 *   previous CPU pass (`getVisibleFeatureIndices` + `extractVisiblePolygons`)
 *   ran every render, scaled O(featureCount × renderRate), and at 100k
 *   polygons dominated the frame budget. With this extension polygons are
 *   uploaded ONCE per tile and time-window changes only update uniforms.
 * - Categorical fill colors lift to the GPU via CategoryColorExtension —
 *   same wiring as the other animated layers.
 * - PER-VERTEX EXPANSION: SolidPolygonLayer's fill model is NON-instanced, so
 *   the extension attributes (stepMode 'dynamic') resolve to 'vertex' there
 *   and the binary `data.attributes` buffers must carry ONE VALUE PER VERTEX.
 *   deck.gl does NOT expand per-feature buffers supplied by attribute name
 *   (`Attribute.setExternalBuffer` binds them verbatim; the
 *   `setBinaryValue`/startIndices expansion path is bypassed whenever the
 *   tile's startIndices are the very ref the tesselator adopted, which is
 *   always the case with `_normalize: false`). prepareTile therefore expands
 *   start/end times and category indices across each feature's vertex range
 *   once per tile — see expandPerVertex.
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
import type { Color, DefaultProps, Layer, LayerContext, Material } from '@deck.gl/core';
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
  colorMappingDigest,
  inheritedPropsDigest,
  structuralDigest,
  updateTriggersDigest,
} from '../../lib/style-digest';
import { resolveAccessorAlias } from '../../lib/accessor-alias';
import type { ColorAccessorValue, NumericAccessorValue } from '../../lib/accessor-alias';
import { DEFAULT_POLYGON_PALETTE } from '@poopdeck.gl/core';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedPolygonLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedPolygonLayerProps}). */
export interface _AnimatedPolygonLayerProps {
  /**
   * Fill the polygon.
   * @default true
   */
  filled?: boolean;

  /**
   * Fill color — constant {@link Color}, or column name for categorical coloring.
   * @default [255, 140, 0, 180]
   */
  fillColor?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link fillColor}. NOTE: unlike upstream
   * deck.gl, this accepts a constant Color OR a property-column NAME — NOT
   * a function accessor (binary tiles can't run per-feature JS; a function
   * warns once and falls back to `fillColor`). When set, it wins over
   * `fillColor`.
   */
  getFillColor?: ColorAccessorValue | null;

  /** Color palette for the categorical `fillColor` path. */
  colorPalette?: Color[];

  /**
   * Explicit category-string → color map for the categorical `fillColor` path.
   * When set together with a string `fillColor`, each tile resolves its own
   * category dictionary through this map to build a per-tile palette, so a band
   * keeps the SAME color across tiles whose dictionaries differ in order or
   * subset. The bare `colorPalette` assigns colors by first-seen category index
   * and therefore drifts tile to tile — this is the only way to get stable
   * categorical fills. Categories absent from the map use `colorMappingDefault`.
   *
   * Unlike the point layer's `colorMapping` (a CPU per-feature RGBA expansion),
   * the polygon path stays on the GPU CategoryColorExtension: the mapping only
   * changes how the per-tile palette is built, not how it's sampled.
   */
  colorMapping?: Record<string, Color> | null;

  /** Fallback color for categories absent from `colorMapping`. @default transparent */
  colorMappingDefault?: Color;

  /**
   * Elevation — constant number, or property name.
   * @default 0
   */
  elevation?: number | string;

  /**
   * Upstream-vocabulary alias of {@link elevation}. Accepts a constant
   * number OR a property-column NAME — NOT a function accessor (a function
   * warns once and falls back to `elevation`). When set, it wins over
   * `elevation`.
   */
  getElevation?: NumericAccessorValue | null;

  /**
   * Extruded (3D) polygons.
   * @default false
   */
  extruded?: boolean;

  /**
   * Multiplier applied to every elevation value on the GPU (constant AND
   * column-driven) — SolidPolygonLayer pass-through. Only takes effect when
   * `extruded` is true.
   * @default 1
   */
  elevationScale?: number;

  /**
   * Draw the edges of extruded polygons as a wireframe (sides + top outline)
   * — SolidPolygonLayer pass-through. Only takes effect when `extruded` is
   * true.
   * @default false
   */
  wireframe?: boolean;

  /**
   * Lighting material for extruded polygons — SolidPolygonLayer pass-through.
   * `true` for the default phong material, `false` to disable lighting, or a
   * material spec `{ambient, diffuse, shininess, specularColor}`.
   * @default true
   */
  material?: Material;

  /**
   * Fade-in duration (ms).
   * @default 500
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration (ms).
   * @default 500
   */
  fadeOutDuration?: number;
}

/** Complete props accepted by {@link AnimatedPolygonLayer}. */
export type AnimatedPolygonLayerProps = _AnimatedPolygonLayerProps & SpatioTemporalLayerProps;

// Shared with the maplibre adapter (single source of truth in
// @poopdeck.gl/core).
const DEFAULT_PALETTE: Color[] = DEFAULT_POLYGON_PALETTE;

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
  /** Source tile + decoded columns — picking enrichment context (references, not copies). */
  tile: Tile;
  features: BinaryFeatures;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

/**
 * Expand a per-FEATURE value array to per-VERTEX for SolidPolygonLayer.
 *
 * The fill model is non-instanced, so every extension attribute (stepMode
 * 'dynamic' → 'vertex' there) consumes one value per vertex. deck.gl binds
 * binary buffers supplied by attribute name verbatim (no startIndices
 * expansion — see the module docstring), so the layer must do the expansion
 * itself: all vertices of feature i carry value[i]. Runs once per tile prep
 * and is cached in PreparedTile, so it is NOT on the draw path.
 */
function expandPerVertex(
  values: ArrayLike<number>,
  startIndices: Uint32Array,
  featureCount: number,
  vertexCount: number,
): Float32Array {
  const out = new Float32Array(vertexCount);
  for (let f = 0; f < featureCount; f++) {
    const start = startIndices[f];
    // startIndices carries a trailing sentinel (= vertexCount) by the deck.gl
    // binary convention; fall back to vertexCount if a producer omits it.
    const end = f + 1 < startIndices.length ? startIndices[f + 1] : vertexCount;
    out.fill(values[f], start, end);
  }
  return out;
}

/**
 * Animated polygon layer with GPU time filtering and per-tile sublayers.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`polygons`**.
 * `_subLayerProps: { polygons: { type: MyLayer, ...props } }` swaps the
 * sublayer class (default `SolidPolygonLayer`) / overrides sublayer props
 * (deck's CompositeLayer contract).
 */
export class AnimatedPolygonLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedPolygonLayerProps>
> {
  static layerName = 'AnimatedPolygonLayer';

  static defaultProps: DefaultProps<AnimatedPolygonLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    filled: true,
    // Permissive descriptor ({type:'object'} validates anything): fillColor
    // legally holds a constant OR a column-name string, which the 'color'
    // validator would reject in deck's debug mode.
    fillColor: { type: 'object', value: [255, 140, 0, 180], compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    // Object-valued mapping — compare:false (digest content via styleKey). The
    // transparent default drops categories the caller didn't map, matching the
    // point layer.
    colorMapping: { type: 'object', value: null, optional: true, compare: false },
    colorMappingDefault: { type: 'color', value: [0, 0, 0, 0] },
    elevation: { type: 'object', value: 0, compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getFillColor: { type: 'object', value: null, optional: true, compare: true },
    getElevation: { type: 'object', value: null, optional: true, compare: true },
    extruded: false,
    elevationScale: { type: 'number', value: 1, min: 0 },
    wireframe: false,
    // Same permissive descriptor SolidPolygonLayer uses: boolean or material spec.
    material: { type: 'object', value: true, compare: true },
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
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /** Singleton extensions, reused by every sublayer (stateless w.r.t. data). */
  private readonly timeFilterExtension = new TimeFilterExtension({ mode: 'window' });
  private readonly categoryColorExtension = new CategoryColorExtension();

  /** Stable getTime; preserved across renders to keep prop refs stable. */
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
  private fillColorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPolygonLayer',
      'getFillColor',
      this.props.getFillColor,
      this.props.fillColor,
    );
  }

  private elevationValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPolygonLayer',
      'getElevation',
      this.props.getElevation,
      this.props.elevation,
    );
  }

  private computeLayerPropsKey(): string {
    const fillColor = this.fillColorValue();
    const elevation = this.elevationValue();
    return [
      this.props.filled,
      this.props.extruded,
      this.props.elevationScale,
      this.props.wireframe,
      structuralDigest(this.props.material),
      typeof elevation === 'number' ? elevation : 0,
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinate system, _subLayerProps, …)
      // plus the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      this.props.timeWindow,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      // fillColor constant branch only; categorical branch lives in `prepared`.
      Array.isArray(fillColor) ? fillColor.join(',') : '',
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
      this.lastTilesRef = null;
      return [];
    }

    // Skip O(cacheSize) prune walks when the tile-array ref is unchanged.
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

    const fillColorValue = this.fillColorValue();
    const elevationValue = this.elevationValue();
    const fillColorProp = typeof fillColorValue === 'string' ? fillColorValue : '';
    const elevationProp = typeof elevationValue === 'string' ? elevationValue : '';
    // Palette keyed by CONTENT (memoized digest), not length — matches the
    // sibling layers' stale-key fix. updateTriggers ride the key so a user
    // trigger bump re-prepares the tile.
    const styleKey = `${fillColorProp}|${elevationProp}|${
      fillColorProp
        ? this.props.colorMapping
          ? `m${colorMappingDigest(this.props.colorMapping)}`
          : colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${updateTriggersDigest(this.props.updateTriggers)}`;

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
    const featureCount = binary.featureCount;
    const vertexCount = binary.positions.length / dims;
    const startIndices = binary.startIndices;

    // Positions and startIndices ride zero-copy straight from the
    // Arrow-backed tile buffers to the GPU. The per-feature scalar columns
    // (times, category index, elevation) must be expanded to PER-VERTEX
    // because SolidPolygonLayer's fill model is non-instanced — see the
    // module docstring and expandPerVertex. One expansion pass per tile
    // prep, cached in PreparedTile; still strictly cheaper than the v2 path,
    // which re-allocated `positions` + `startIndices` via
    // extractVisiblePolygons() on EVERY render.
    const attributes: PreparedTile['data']['attributes'] = {
      // SolidPolygonLayer's geometry accessor — keyed by accessor name.
      getPolygon: { value: binary.positions, size: dims },
      // TimeFilterExtension attribute names (shared with the other animated
      // layers); per-vertex-expanded for the non-instanced polygon model.
      instanceStartTime: {
        value: expandPerVertex(binary.startTimes, startIndices, featureCount, vertexCount),
        size: 1,
      },
      instanceEndTime: {
        value: expandPerVertex(binary.endTimes, startIndices, featureCount, vertexCount),
        size: 1,
      },
    };

    let gpuPalette: Color[] | null = null;
    if (fillColorProp) {
      const cat = binary.categoricalProps[fillColorProp];
      if (cat) {
        attributes.instanceCategoryIndex = {
          value: expandPerVertex(cat.indices, startIndices, featureCount, vertexCount),
          size: 1,
        };
        // With a colorMapping, resolve THIS tile's category dictionary into a
        // per-tile palette (palette[i] = mapping[categories[i]]) so the shader,
        // which samples palette[categoryIndex], yields a stable per-string color
        // regardless of the tile's dictionary order. Without one, fall back to
        // the single global palette (colors then follow first-seen index).
        const mapping = this.props.colorMapping;
        gpuPalette = mapping
          ? cat.categories.map(
              (c) =>
                mapping[c] ??
                this.props.colorMappingDefault ??
                ([0, 0, 0, 0] as Color),
            )
          : (this.props.colorPalette ?? DEFAULT_PALETTE);
      }
    }

    if (elevationProp) {
      const values = binary.numericProps[elevationProp];
      if (values) {
        // Same per-vertex contract as the time attributes: SolidPolygonLayer's
        // own `elevations` attribute is vertex-stepped on the fill model and
        // deck binds this buffer verbatim.
        attributes.getElevation = {
          value: expandPerVertex(values, startIndices, featureCount, vertexCount),
          size: 1,
        };
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
      tile,
      features: binary,
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
    // `Required<>`-typed: the defaultProps value (86400000, inherited from
    // the base) guarantees a number — the old `|| 86400000 * 30` fallback
    // was dead code once the default merged.
    const timeWindow = this.props.timeWindow;
    const fillColorValue = this.fillColorValue();
    const elevationValue = this.elevationValue();
    const constFillColor = (Array.isArray(fillColorValue)
      ? fillColorValue
      : ([255, 140, 0, 180] as Color)) as Color;

    const useGpuCategory = prepared.gpuPalette !== null;
    if (
      useGpuCategory &&
      prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE
    ) {
      warnOnce(
        'AnimatedPolygonLayer:paletteOverflow',
        `[AnimatedPolygonLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
          `entries; only the first ${CATEGORY_PALETTE_SIZE} will be used by ` +
          'CategoryColorExtension.',
      );
    }

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.polygons` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('polygons', prepared.tileKey, {
      data: prepared.data as any,
      dataComparator: (a: any, b: any) => a === b,

      // Pre-tesselated polygon data; SolidPolygonLayer normally re-normalizes
      // user-supplied polygons. Bypassing that keeps tile data zero-copy.
      _normalize: false,
      _windingOrder: 'CCW',

      filled: this.props.filled,
      extruded: this.props.extruded,
      elevationScale: this.props.elevationScale,
      wireframe: this.props.wireframe,
      material: this.props.material,

      // Constant fallback — used when binary getFillColor isn't present.
      getFillColor: constFillColor,
      ...(this.props.extruded && typeof elevationValue === 'number'
        ? { getElevation: elevationValue }
        : {}),

      // Constant extension list (cache-storm rationale — see
      // animated-trips-layer.ts); user extensions are appended.
      extensions: this.composeExtensions([
        this.timeFilterExtension,
        this.categoryColorExtension,
      ]),

      // TimeFilterExtension wiring (same prop names the old polygon fork used)
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,

      // CategoryColorExtension wiring (gated by useCategoryColor)
      categoryPalette: useGpuCategory ? prepared.gpuPalette! : [],
      useCategoryColor: useGpuCategory,

      // TileLayer convention: the source tile rides on the sublayer so the
      // base getPickingInfo can enrich info.tile / decode the picked polygon.
      tile: prepared.tile,
      sttFeatures: prepared.features,
    });
    // `_subLayerProps: { polygons: { type } }` swaps the sublayer class.
    const SubLayerClass = this.getSubLayerClass('polygons', SolidPolygonLayer);
    return new SubLayerClass(props as any);
  }
}
