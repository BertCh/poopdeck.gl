// @stt/deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) @stt/deck.gl contributors

/**
 * AnimatedColumnLayer - time-filtered extruded columns at point features.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One deck.gl `ColumnLayer` per (tile, layer) pair. No cross-tile
 *   consolidation. ColumnLayer is instanced at points exactly like
 *   ScatterplotLayer, so this layer mirrors AnimatedPointLayer's WINDOW-mode
 *   structure: each sublayer uses the binary `data: { length, attributes }`
 *   interface, with positions / startTimes / endTimes referenced DIRECTLY from
 *   the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its own
 *   TimeFilterExtension instance. No layer-wide rebasing pass.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation, so the demo's tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is stable
 *   across renderLayers() calls; deck.gl short-circuits GPU re-uploads when the
 *   reference matches (paired with `dataComparator: (a, b) => a === b`).
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 *
 * COLUMN HEIGHT comes from a per-feature numeric property (`getElevation` /
 * `elevation` = a property-column NAME). Because ColumnLayer is instanced at
 * points, the elevation buffer is one size-1 value PER FEATURE — the same
 * per-feature/instanced contract as AnimatedPointLayer's getRadius, NOT the
 * per-vertex expansion AnimatedPolygonLayer needs for its non-instanced fill
 * model. The numeric column rides zero-copy when present.
 *
 * Categorical fill colors lift to the GPU via CategoryColorExtension when
 * `fillColor`/`getFillColor` names a categorical column — the per-feature
 * `instanceCategoryIndex` path, identical to AnimatedPointLayer. No colorMapping
 * CPU-expansion path here (columns are a styling-light primitive; pass a numeric
 * column to drive height, a categorical column to drive color).
 *
 * There is no cumulative-slab path: columns are an overview/aggregate primitive
 * (a few thousand bars at low zoom), so the per-tile-sublayer count never climbs
 * into the thousands the way a cumulative point reveal does.
 */

import { ColumnLayer } from '@deck.gl/layers';
import type {
  Color,
  DefaultProps,
  Layer,
  LayerContext,
  Material,
} from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from './spatiotemporal-layer';
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
  structuralDigest,
  updateTriggersDigest,
} from './style-digest';
import { resolveAccessorAlias } from './accessor-alias';
import type { ColorAccessorValue, NumericAccessorValue } from './accessor-alias';
import type { Tile, Layer as TileLayer, BinaryFeatures } from '@stt/core';

const DEBUG = false;

/** Props added by {@link AnimatedColumnLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedColumnLayerProps}). */
export interface _AnimatedColumnLayerProps {
  /**
   * Number of sides used to render the column's disk cross-section.
   * @default 20
   */
  diskResolution?: number;

  /**
   * Disk radius in units specified by {@link radiusUnits}.
   * @default 100
   */
  radius?: number;

  /**
   * Disk rotation, counter-clockwise in degrees — ColumnLayer pass-through.
   */
  angle?: number;

  /**
   * Custom disk geometry: replaces the default regular polygon with explicit
   * vertices — ColumnLayer pass-through.
   */
  vertices?: [number, number][] | null;

  /**
   * Disk offset from the position, relative to the radius — ColumnLayer
   * pass-through.
   */
  offset?: [number, number];

  /**
   * Radius multiplier (0..1) — ColumnLayer pass-through.
   * @default 1
   */
  coverage?: number;

  /**
   * Extrude the columns into 3D. When `false` they render as flat disks.
   * @default true
   */
  extruded?: boolean;

  /**
   * Draw a line wireframe of each extruded column — ColumnLayer pass-through.
   * Only takes effect when `extruded` is true.
   * @default false
   */
  wireframe?: boolean;

  /**
   * Fill the column body.
   * @default true
   */
  filled?: boolean;

  /**
   * Draw an outline around the disks.
   * @default false
   */
  stroked?: boolean;

  /**
   * Flat (vs. smooth) shading on the column's vertical surfaces — ColumnLayer
   * pass-through.
   * @default false
   */
  flatShading?: boolean;

  /**
   * Units for {@link radius} — ColumnLayer pass-through. Deck-parity default
   * (world-space meters), unlike AnimatedPointLayer whose STT default is
   * 'pixels'.
   * @default 'meters'
   */
  radiusUnits?: 'meters' | 'pixels' | 'common';

  /**
   * Column height — constant number, or property name for per-feature height
   * (baked from `numericProps[name]` into the binary getElevation attribute).
   * @default 1000
   */
  elevation?: number | string;

  /**
   * Upstream-vocabulary alias of {@link elevation}. Accepts a constant number
   * OR a property-column NAME — NOT a function accessor (binary tiles can't run
   * per-feature JS; a function warns once and falls back to `elevation`). When
   * set, it wins over `elevation`.
   */
  getElevation?: NumericAccessorValue | null;

  /**
   * Multiplier applied to every elevation value on the GPU (constant AND
   * column-driven) — ColumnLayer pass-through.
   * @default 1
   */
  elevationScale?: number;

  /**
   * Fill color — constant {@link Color}, or property name for categorical
   * coloring (GPU lookup via CategoryColorExtension, same path as the point
   * layer's fillColor).
   * @default [255, 140, 0, 255]
   */
  fillColor?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link fillColor}. NOTE: unlike upstream
   * deck.gl, this accepts a constant Color OR a property-column NAME — NOT a
   * function accessor (a function warns once and falls back to `fillColor`).
   * When set, it wins over `fillColor`.
   */
  getFillColor?: ColorAccessorValue | null;

  /** Color palette for the categorical `fillColor` path. */
  colorPalette?: Color[];

  /**
   * Outline stroke color (constant) — used when `stroked` is true.
   * @default [0, 0, 0, 255]
   */
  lineColor?: Color;

  /**
   * Upstream-vocabulary alias of {@link lineColor} (constant Color only — same
   * domain as the legacy prop; a function accessor warns once and falls back
   * to `lineColor`). When set, it wins over `lineColor`.
   */
  getLineColor?: ColorAccessorValue | null;

  /**
   * Outline stroke width (constant) in units specified by {@link lineWidthUnits}.
   * @default 1
   */
  lineWidth?: number;

  /**
   * Upstream-vocabulary alias of {@link lineWidth} (constant number only — a
   * function accessor warns once and falls back to `lineWidth`). When set, it
   * wins over `lineWidth`.
   */
  getLineWidth?: NumericAccessorValue | null;

  /**
   * Units for the outline width — ColumnLayer pass-through.
   * @default 'meters'
   */
  lineWidthUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Lighting material for extruded columns — ColumnLayer pass-through. `true`
   * for the default phong material, `false` to disable lighting, or a material
   * spec `{ambient, diffuse, shininess, specularColor}`.
   * @default true
   */
  material?: Material;

  /**
   * Fade-in duration for appearing columns (ms) — TimeFilterExtension window.
   * @default 300
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration for disappearing columns (ms) — TimeFilterExtension
   * window.
   * @default 300
   */
  fadeOutDuration?: number;
}

/** Complete props accepted by {@link AnimatedColumnLayer}. */
export type AnimatedColumnLayerProps = _AnimatedColumnLayerProps & SpatioTemporalLayerProps;

// Default color palette for categorical data (matches AnimatedPolygonLayer's
// opaque tableau ramp — columns are usually fully opaque so lighting reads).
const DEFAULT_PALETTE: Color[] = [
  [255, 140, 0, 255],
  [31, 119, 180, 255],
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
 * deck.gl is stable across renders — deck.gl compares `data` by reference (with
 * our dataComparator: ===) to decide whether to re-upload GPU buffers.
 *
 * Mirrors AnimatedPointLayer's PreparedTile shape.
 */
interface PreparedTile {
  /** Resolved (tile, layer) cache key. */
  tileKey: string;
  /** Hash of style props that affect the prepared `attributes`. */
  styleKey: string;
  /** Reference-stable data object for ColumnLayer's binary interface. */
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
 * Hand category indices to the GPU as a single-component float attribute. The
 * CategoryColorExtension samples the palette texture in the fragment shader.
 *
 * `indices` arrive as Uint16Array (4096 categories max); the extension reads
 * them as float32. We do a narrowing copy here rather than running a shader
 * permutation per integer type. Same as AnimatedPointLayer.indicesToFloat32.
 */
function indicesToFloat32(indices: Uint16Array, count: number): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices[i];
  return out;
}

/**
 * Pad a 2D Float64Array of positions [x0,y0, x1,y1, ...] into a 3D buffer
 * [x0,y0,0, x1,y1,0, ...] for ColumnLayer's size-3 getPosition attribute. The
 * column's height is the elevation, so the z here is the base altitude (0 for
 * a 2D tile). One allocation per tile in the prepare step.
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

/**
 * Animated column layer with per-tile binary sublayers — time-filtered
 * extruded columns at point features (the 3D-bars primitive).
 *
 * Each visible tile produces one ColumnLayer instance that is cached across
 * renders. Time updates flow through getTime() on the extension; tile arrivals
 * only construct one new sublayer + one GPU upload, never touching the buffers
 * of already-loaded tiles.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`columns`**.
 * `_subLayerProps: { columns: { type: MyLayer, ...props } }` swaps the sublayer
 * class (default `ColumnLayer`) / overrides sublayer props (deck's
 * CompositeLayer contract).
 */
export class AnimatedColumnLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedColumnLayerProps>
> {
  static layerName = 'AnimatedColumnLayer';

  static defaultProps: DefaultProps<AnimatedColumnLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    diskResolution: { type: 'number', value: 20, min: 4 },
    radius: { type: 'number', value: 100, min: 0 },
    angle: { type: 'number', value: 0 },
    vertices: { type: 'object', value: null, optional: true, compare: true },
    offset: { type: 'array', value: [0, 0] },
    coverage: { type: 'number', value: 1, min: 0, max: 1 },
    extruded: true,
    wireframe: false,
    filled: true,
    stroked: false,
    flatShading: false,
    radiusUnits: 'meters',
    // Permissive descriptors ({type:'object'} validates anything): these props
    // legally hold a constant OR a column-name string, which the
    // 'color'/'number' validators would reject in deck's debug mode.
    elevation: { type: 'object', value: 1000, compare: true },
    fillColor: { type: 'object', value: [255, 140, 0, 255], compare: true },
    // Accessor-named aliases (see the prop docs): unset by default so the
    // legacy props win unless the caller opts into the upstream vocabulary.
    getElevation: { type: 'object', value: null, optional: true, compare: true },
    getFillColor: { type: 'object', value: null, optional: true, compare: true },
    getLineColor: { type: 'object', value: null, optional: true, compare: true },
    getLineWidth: { type: 'object', value: null, optional: true, compare: true },
    elevationScale: { type: 'number', value: 1, min: 0 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    lineColor: { type: 'color', value: [0, 0, 0, 255] },
    lineWidth: { type: 'number', value: 1, min: 0 },
    lineWidthUnits: 'meters',
    // Same permissive descriptor ColumnLayer uses: boolean or material spec.
    material: { type: 'object', value: true, compare: true },
    // Fade ramps, forwarded to TimeFilterExtension (window mode).
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Returning the SAME ColumnLayer reference
   * across renderLayers() calls lets deck.gl short-circuit prop diff entirely
   * — see AnimatedPointLayer for the frame-time rationale.
   */
  private sublayerCache = new Map<
    string,
    { layer: ColumnLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction time. */
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Columns animate in
   * window-mode (whole feature on/off + fade), so only the per-feature
   * start/end attributes are needed — the per-vertex time attribute is unused.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({ mode: 'window' });

  /**
   * Singleton CategoryColorExtension. Always installed; when a tile lacks
   * `instanceCategoryIndex` the shader branch is gated off via the
   * `useCategoryColor` uniform.
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
   * Accessor-alias resolution (audit B1): the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy prop.
   * Same value domain as the legacy props (constant or column name).
   */
  private fillColorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedColumnLayer',
      'getFillColor',
      this.props.getFillColor,
      this.props.fillColor,
    );
  }

  private elevationValue(): number | string | undefined {
    return resolveAccessorAlias(
      'AnimatedColumnLayer',
      'getElevation',
      this.props.getElevation,
      this.props.elevation,
    );
  }

  private lineColorValue(): Color {
    return resolveAccessorAlias(
      'AnimatedColumnLayer',
      'getLineColor',
      this.props.getLineColor as Color | undefined,
      this.props.lineColor,
    );
  }

  private lineWidthValue(): number {
    return resolveAccessorAlias(
      'AnimatedColumnLayer',
      'getLineWidth',
      this.props.getLineWidth as number | undefined,
      this.props.lineWidth,
    );
  }

  /**
   * Compute a digest of the layer-level props that affect every sublayer. When
   * this changes we throw away the entire sublayer cache.
   */
  private computeLayerPropsKey(): string {
    const fillColor = this.fillColorValue();
    const elevation = this.elevationValue();
    const lineColor = this.lineColorValue();
    return [
      this.props.diskResolution,
      this.props.radius,
      this.props.angle,
      structuralDigest(this.props.vertices),
      structuralDigest(this.props.offset),
      this.props.coverage,
      this.props.extruded,
      this.props.wireframe,
      this.props.filled,
      this.props.stroked,
      this.props.flatShading,
      this.props.radiusUnits,
      this.props.elevationScale,
      this.props.lineWidth,
      this.props.lineWidthUnits,
      Array.isArray(lineColor) ? lineColor.join(',') : '',
      structuralDigest(this.props.material),
      // Composite props that getSubLayerProps bakes into every sublayer
      // (opacity/pickable/visible, coordinateSystem, modelMatrix, highlight
      // props, _subLayerProps overrides…) plus the user's updateTriggers.
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
      this.props.timeWindow,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      // fillColor/elevation constant branches only — the property-driven path
      // lives in `prepared` and is keyed via preparedKey.
      Array.isArray(fillColor) ? fillColor.join(',') : '',
      typeof elevation === 'number' ? elevation : 0,
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.preparedTileCache.clear();
      this.sublayerCache.clear();
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
      layer: 'AnimatedColumnLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedColumnLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  /**
   * styleKey digest of the props that change a tile's prepared `attributes`
   * (which color/elevation column, palette content). Used by the per-tile
   * cache check.
   */
  private computeStyleKey(): string {
    const fillColor = this.fillColorValue();
    const elevation = this.elevationValue();
    const fillColorProp = typeof fillColor === 'string' ? fillColor : '';
    const elevationProp = typeof elevation === 'string' ? elevation : '';
    // Palette identity matters only when fillColor is a column name. Digests
    // are memoized per object reference (style-digest.ts), so this stays a
    // WeakMap lookup per tile, not a re-serialization.
    return `${fillColorProp}|${elevationProp}|${
      fillColorProp ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE) : 0
    }|${updateTriggersDigest(this.props.updateTriggers)}`;
  }

  /**
   * Fetch the cached binary `data` object for a single tile, building (and
   * caching) it on a miss. Returns a reference-stable PreparedTile so deck.gl
   * can short-circuit GPU re-uploads.
   */
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;
    const styleKey = this.computeStyleKey();
    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) {
      emit('tilePrepare', { layer: 'AnimatedColumnLayer', tileKey, cached: true, ms: 0 });
      return cached;
    }

    const fillColorValue = this.fillColorValue();
    const elevationValue = this.elevationValue();
    const fillColorProp = typeof fillColorValue === 'string' ? fillColorValue : '';
    const elevationProp = typeof elevationValue === 'string' ? elevationValue : '';

    const t0 = performance.now();
    const count = binary.featureCount;
    const srcDims = binary.positionDimensions ?? 2;

    // ColumnLayer expects size=3 positions (the z is the column's base
    // altitude). Keep a stride-3 buffer zero-copy; pad a 2D buffer once.
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

    // Property-driven (categorical) fill color — GPU path: hand category
    // indices to the CategoryColorExtension. No colorMapping CPU branch here.
    if (fillColorProp) {
      const cat = binary.categoricalProps[fillColorProp];
      if (cat) {
        attributes.instanceCategoryIndex = {
          value: indicesToFloat32(cat.indices, count),
          size: 1,
        };
        gpuPalette = this.props.colorPalette ?? DEFAULT_PALETTE;
      }
    }

    // Property-driven column height — already Float32Array, rides zero-copy.
    // ColumnLayer is instanced at points, so this is one value PER FEATURE
    // (size 1), like the point layer's getRadius — NOT per-vertex.
    if (elevationProp) {
      const values = binary.numericProps[elevationProp];
      if (values) {
        attributes.getElevation = { value: values, size: 1 };
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
    this.preparedTileCache.set(tileKey, prepared);
    emit('tilePrepare', {
      layer: 'AnimatedColumnLayer',
      tileKey,
      cached: false,
      features: count,
      gpuPalette: gpuPalette !== null,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): ColumnLayer {
    // `Required<>`-typed: the defaultProps value guarantees values here.
    const timeWindow = this.props.timeWindow;
    const elevationValue = this.elevationValue();
    const fillColorValue = this.fillColorValue();
    const constElevation = typeof elevationValue === 'number' ? elevationValue : 1000;
    const constFillColor = (Array.isArray(fillColorValue)
      ? fillColorValue
      : ([255, 140, 0, 255] as Color)) as Color;

    // CategoryColorExtension props: when this tile uses the GPU palette path we
    // pass the resolved palette + useCategoryColor=true. Otherwise the
    // extension idles (its shader branch is gated by useCategoryColor).
    const useGpuCategory = prepared.gpuPalette !== null;
    if (useGpuCategory && prepared.gpuPalette!.length > CATEGORY_PALETTE_SIZE) {
      warnOnce(
        'AnimatedColumnLayer:paletteOverflow',
        `[AnimatedColumnLayer] colorPalette has ${prepared.gpuPalette!.length} ` +
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
    // system, highlight props, …) + user `_subLayerProps.columns` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('columns', prepared.tileKey, {
      data: prepared.data as any,
      // Identity comparator: deck.gl skips prop-diff for `data` entirely when
      // the same object reference comes back. Pairs with the preparedTileCache
      // which guarantees stable identity.
      dataComparator: (a: any, b: any) => a === b,

      // Geometry / styling pass-through.
      diskResolution: this.props.diskResolution,
      radius: this.props.radius,
      radiusUnits: this.props.radiusUnits,
      angle: this.props.angle,
      vertices: this.props.vertices,
      offset: this.props.offset,
      coverage: this.props.coverage,
      extruded: this.props.extruded,
      wireframe: this.props.wireframe,
      filled: this.props.filled,
      stroked: this.props.stroked,
      flatShading: this.props.flatShading,
      elevationScale: this.props.elevationScale,
      material: this.props.material,
      lineWidthUnits: this.props.lineWidthUnits,

      // Constant fallbacks — used when the binary attribute is absent. The
      // binary getElevation / getFillColor wins when present.
      getElevation: constElevation,
      getFillColor: constFillColor,
      getLineColor: this.lineColorValue(),
      getLineWidth: this.lineWidthValue(),

      extensions,

      // TimeFilterExtension wiring — per-tile timeOffset and window.
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
      // the two paths via prop inspection. The extension itself only does work
      // when the flag is true.
      useCategoryColor: useGpuCategory,
      ...(useGpuCategory ? { categoryPalette: prepared.gpuPalette! } : {}),
    });
    // `_subLayerProps: { columns: { type } }` swaps the sublayer class — the
    // CompositeLayer-native override point.
    const SubLayerClass = this.getSubLayerClass('columns', ColumnLayer);
    return new SubLayerClass(props as any);
  }
}
