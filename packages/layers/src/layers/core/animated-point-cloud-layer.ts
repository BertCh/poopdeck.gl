// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedPointCloudLayer — generic phong-lit 3D points over binary tiles.
 *
 * The middle ground between {@link AnimatedPointLayer} (flat, unlit
 * billboards) and {@link SplatLayer} (oriented anisotropic Gaussian surfels
 * requiring baked covariance columns): each feature is a lit 3D point with a
 * position, an optional surface normal, and a colour. deck base:
 * `PointCloudLayer`.
 *
 * ARCHITECTURE — mirrors AnimatedPointLayer's v3 per-tile binary-sublayer
 * design almost verbatim:
 * - One `PointCloudLayer` per (tile, layer). No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, attributes }`
 *   interface, with positions / startTimes / endTimes referenced DIRECTLY
 *   from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension instance (window mode). No layer-wide rebasing.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation, so the demo's tick handler only calls `setNeedsRedraw()`.
 * - Prepared per-tile data is cached so the `data` object reference is stable
 *   across renderLayers() calls; deck.gl short-circuits GPU re-uploads when
 *   the reference matches (paired with `dataComparator: (a, b) => a === b`).
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 *
 * COLOUR follows the same four-way resolution as AnimatedPointLayer:
 *   1. `colorVectorColumn` — ONE interleaved `FixedSizeList<UInt8,4>` RGBA
 *      column (baked by `stt-build --vector-group`), bound zero-copy. Wins
 *      over every other path when present.
 *   2. `rgbColorColumns` — three numeric columns `[r, g, b]` (0–255) expanded
 *      into a Uint8 RGBA buffer.
 *   3. a categorical `color`/`getColor` column → CPU palette / `colorMapping`
 *      expansion into a per-point RGBA `getColor`. This is a LIT layer, so
 *      categorical colours must ride `instanceColors` (Gouraud-lit) — NOT the
 *      GPU `CategoryColorExtension`, which replaces colour AFTER lighting in the
 *      fragment stage and would render categorical points flat/unshaded. The
 *      extension is therefore not installed at all: no `instanceCategoryIndex`
 *      attribute, no UBO, no palette texture, no fragment branch.
 *   4. a constant `color`.
 *
 * NORMAL comes from a `[nx, ny, nz]` VECTOR column (`FixedSizeList<Float32,3>`)
 * when present (bound zero-copy to `getNormal`), else deck's default `[0,0,1]`.
 *
 * There is no cumulative-slab path — point clouds are a scan/overview
 * primitive, not a "draws itself" reveal.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`pointCloud`**.
 */

import { PointCloudLayer } from '@deck.gl/layers';
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
} from '../spatiotemporal-layer.js';
import { TimeFilterExtension } from '../../extensions/time-filter-extension.js';
import { emit, isProbeEnabled } from '../../lib/telemetry.js';
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
import type { ColorAccessorValue } from '../../lib/accessor-alias.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
import { bindColorVector, bindFloatVector } from '../../lib/vector-props.js';
import {
  DEFAULT_CATEGORICAL_PALETTE,
  GeometryType,
  tileLayerKey,
} from '@poopdeck.gl/core';
import { expandCategoricalColors as coreExpandCategoricalColors } from '@poopdeck.gl/core/style';
import type { RGBA255 } from '@poopdeck.gl/core/style';
import type {
  Tile,
  STTTileLayer as TileLayer,
  BinaryFeatures,
} from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link AnimatedPointCloudLayer} (own props only — compose
 * with {@link SpatioTemporalLayerProps} via {@link AnimatedPointCloudLayerProps}). */
export interface _AnimatedPointCloudLayerProps {
  /**
   * Units for {@link pointSize} — PointCloudLayer pass-through.
   * @default 'pixels'
   */
  sizeUnits?: 'meters' | 'pixels' | 'common';

  /**
   * Global radius of all points, in {@link sizeUnits} — PointCloudLayer
   * pass-through.
   * @default 10
   */
  pointSize?: number;

  /**
   * Lighting material for the lit points — PointCloudLayer pass-through.
   * `true` for the default phong material, `false` to disable lighting, or a
   * material spec `{ambient, diffuse, shininess, specularColor}`.
   * @default true
   */
  material?: Material;

  /**
   * Point colour — constant {@link Color}, or property name for categorical
   * colouring. Unlike AnimatedPointLayer's `fillColor`, the categorical path
   * is CPU-expanded into a per-point RGBA `getColor` rather than lifted to
   * CategoryColorExtension: these points are phong-LIT, and the extension
   * replaces colour after lighting. See the class docstring.
   * @default [255, 255, 255, 255]
   */
  color?: Color | string;

  /**
   * Upstream-vocabulary alias of {@link color} (deck's `getColor`). NOTE:
   * unlike upstream deck.gl this accepts a constant Color OR a property-column
   * NAME — NOT a function accessor (binary tiles can't run per-feature JS; a
   * function warns once and falls back to `color`). When set, it wins over
   * `color`.
   */
  getColor?: ColorAccessorValue | null;

  /** Colour palette for the categorical `color` path. */
  colorPalette?: Color[];

  /**
   * Explicit category-to-colour map. When set together with a string `color`
   * property, each feature's colour is `colorMapping[categoryValue]`, using
   * `colorMappingDefault` for unknown values. Forces the CPU palette-expansion
   * path (the GPU palette texture cannot look up by category STRING).
   */
  colorMapping?: Record<string, Color> | null;

  /** Fallback colour for categories absent from `colorMapping`. */
  colorMappingDefault?: Color;

  /**
   * Per-point RGB straight from three NUMERIC columns (each 0–255) — e.g.
   * LIDAR returns coloured by projecting them into camera images at build
   * time. When set to `['r','g','b']`, each feature's colour is
   * `[r, g, b, 255]`. Takes precedence over `color`/`colorMapping`. Ignored
   * (falls back to the normal colour path) if any of the three columns is
   * absent from the tile.
   */
  rgbColorColumns?: [string, string, string] | null;

  /**
   * Per-point RGBA from ONE interleaved VECTOR column (`FixedSizeList<UInt8,4>`,
   * baked by `stt-build --vector-group name=r,g,b,a:u8`). When the tile carries
   * it, the contiguous u8 buffer is bound to `getColor` **zero-copy** — the
   * GPU-ready analogue of {@link rgbColorColumns}. Takes precedence over every
   * other colour path. Ignored if the column is absent from the tile. A column
   * baked with an f32 leaf still works, but is converted per tile (with a
   * one-time warning) — colour attributes must reach the GPU as normalized u8.
   * @default 'point_rgba'
   */
  colorVectorColumn?: string | null;

  /**
   * VECTOR column name (`FixedSizeList<Float32,3>`) holding each point's
   * surface normal `[nx, ny, nz]`. When present it's bound to `getNormal`
   * **zero-copy**; absent ⇒ deck's default `[0, 0, 1]` (points face straight
   * up, so lighting is uniform). The f32 leaf is REQUIRED — a u8 leaf is
   * ignored with a one-time warning, since `instanceNormals` is a float
   * attribute and there is no rescale convention that would make u8 valid.
   * @default 'normal'
   */
  normalColumn?: string | null;

  /**
   * Property name to source per-point elevation (z) from a numeric tile
   * column when the geometry is 2D (lon/lat). Each point is placed at
   * `z = column[i] × elevationScale`. Unset (the common case) ⇒ z comes from
   * 3D tile geometry directly, or stays 0 on a 2D tile.
   */
  elevationProperty?: string | null;

  /**
   * Multiplier applied to each {@link elevationProperty} value before it
   * becomes the point's z. No effect when `elevationProperty` is unset.
   * @default 1
   */
  elevationScale?: number;

  /**
   * Fade-in duration for appearing points (ms) — TimeFilterExtension window.
   * @default 300
   */
  fadeInDuration?: number;

  /**
   * Fade-out duration for disappearing points (ms) — TimeFilterExtension
   * window.
   * @default 300
   */
  fadeOutDuration?: number;
}

/** Complete props accepted by {@link AnimatedPointCloudLayer}. */
export type AnimatedPointCloudLayerProps = _AnimatedPointCloudLayerProps &
  SpatioTemporalLayerProps;

/**
 * Sublayer-cache effect of every own prop, exhaustive by type: a prop added to
 * {@link _AnimatedPointCloudLayerProps} without an entry here fails to compile.
 *
 * `'sublayer'` — read by {@link AnimatedPointCloudLayer.buildSublayer}, so a
 * cached `PointCloudLayer` freezes the value and a change must drop the
 * sublayer cache.
 *
 * `'prepare'` — read only by `buildTileData`, where the value is baked into the
 * tile's binary attributes. Each is a component of
 * {@link AnimatedPointCloudLayer.computeStyleKey} (`colorPalette` via
 * `colorListDigest`, `colorMapping` via `colorMappingDigest`,
 * `colorMappingDefault` via `mapDefault`, the column-name props via their own
 * terms, `elevationScale` alongside `elevationProperty`), so a change rebuilds
 * `prepared` — and the sublayer cache hit tests `prepared` by object identity,
 * which is what invalidates the sublayer. Moving one of these to `'sublayer'`
 * is safe; moving a `'sublayer'` prop here is only safe while `styleKey`
 * genuinely contains it.
 *
 * `color` is additionally keyed on its RESOLVED value (`getColor` wins) through
 * the `overrides` channel — see
 * {@link AnimatedPointCloudLayer.computeLayerPropsKey}.
 */
const POINT_CLOUD_PROP_EFFECTS: PropEffects<_AnimatedPointCloudLayerProps> = {
  sizeUnits: 'sublayer',
  pointSize: 'sublayer',
  material: 'sublayer',
  color: 'sublayer',
  getColor: 'sublayer',
  colorPalette: 'prepare',
  colorMapping: 'prepare',
  colorMappingDefault: 'prepare',
  rgbColorColumns: 'prepare',
  colorVectorColumn: 'prepare',
  normalColumn: 'prepare',
  elevationProperty: 'prepare',
  elevationScale: 'prepare',
  fadeInDuration: 'sublayer',
  fadeOutDuration: 'sublayer',
};

// Default categorical palette — the single source of truth in @poopdeck.gl/core.
const DEFAULT_PALETTE: Color[] = DEFAULT_CATEGORICAL_PALETTE;

const DEFAULT_COLOR: Color = [255, 255, 255, 255];

/**
 * Per-tile prepared data. Cached so the `data` object reference handed to
 * deck.gl is stable across renders — deck.gl compares `data` by reference
 * (with our dataComparator: ===) to decide whether to re-upload GPU buffers.
 * Mirrors AnimatedPointLayer's PreparedTile shape.
 */
interface PreparedTile {
  /** Resolved (tile, layer) cache key. */
  tileKey: string;
  /** Hash of style props that affect the prepared `attributes`. */
  styleKey: string;
  /** Reference-stable data object for PointCloudLayer's binary interface. */
  data: {
    length: number;
    attributes: Record<
      string,
      { value: any; size: number; normalized?: boolean }
    >;
  };
  /** Per-tile time reference; passed to TimeFilterExtension as `timeOffset`. */
  timeOffset: number;
  /** Source tile + decoded columns — picking enrichment context (references). */
  tile: Tile;
  layerName: string;
  features: BinaryFeatures;
}

/**
 * Pad a 2D Float64Array of positions [x0,y0, x1,y1, ...] into a 3D buffer
 * [x0,y0,z0, ...] for PointCloudLayer's size-3 getPosition attribute. When an
 * elevation column is supplied, `z = column[i] * scale`; otherwise z = 0. One
 * allocation per tile in the prepare step.
 */
function padPositionsTo3D(
  src: Float64Array,
  count: number,
  elevValues: Float32Array | undefined,
  elevScale: number,
): Float64Array {
  const out = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = src[i * 2];
    out[i * 3 + 1] = src[i * 2 + 1];
    if (elevValues) out[i * 3 + 2] = elevValues[i] * elevScale;
    // else out[i * 3 + 2] = 0; (already zero-initialized)
  }
  return out;
}

/**
 * Animated point-cloud layer with per-tile binary sublayers — generic
 * phong-lit 3D points.
 *
 * Each visible tile produces one PointCloudLayer instance that is cached
 * across renders. Time updates flow through getTime() on the extension; tile
 * arrivals only construct one new sublayer + one GPU upload.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`pointCloud`**.
 * `_subLayerProps: { pointCloud: { type: MyLayer, ...props } }` swaps the
 * sublayer class (default `PointCloudLayer`) / overrides sublayer props.
 */
export class AnimatedPointCloudLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedPointCloudLayerProps>
> {
  static layerName = 'AnimatedPointCloudLayer';

  static defaultProps: DefaultProps<AnimatedPointCloudLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    sizeUnits: 'pixels',
    pointSize: { type: 'number', value: 10, min: 0 },
    // Same permissive descriptor deck's PointCloudLayer uses: boolean or spec.
    material: { type: 'object', value: true, compare: true },
    // Permissive descriptors ({type:'object'} validates anything): these props
    // legally hold a constant OR a column-name string, which the
    // 'color'/'number' validators would reject in deck's debug mode.
    color: { type: 'object', value: DEFAULT_COLOR, compare: true },
    // Accessor-named alias (see the prop docs): unset by default so the legacy
    // prop wins unless the caller opts into the upstream vocabulary.
    getColor: { type: 'object', value: null, optional: true, compare: true },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE, compare: true },
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: false,
    },
    // Transparent fallback: features whose category is absent from
    // `colorMapping` disappear rather than render a misleading colour.
    colorMappingDefault: { type: 'color', value: [0, 0, 0, 0] },
    rgbColorColumns: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    colorVectorColumn: {
      type: 'object',
      value: 'point_rgba',
      optional: true,
      compare: true,
    },
    normalColumn: {
      type: 'object',
      value: 'normal',
      optional: true,
      compare: true,
    },
    elevationProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    // Allow negative scale (e.g. invert depth) — z values themselves may be
    // negative (below-grade returns), so the multiplier is unconstrained.
    elevationScale: { type: 'number', value: 1 },
    // Fade ramps, forwarded to TimeFilterExtension (window mode).
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };

  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  private preparedTileCache = new Map<string, PreparedTile>();

  /**
   * Per-tile sublayer-instance cache. Returning the SAME PointCloudLayer
   * reference across renderLayers() calls lets deck.gl short-circuit prop diff
   * — see AnimatedPointLayer for the frame-time rationale.
   */
  private sublayerCache = new Map<
    string,
    { layer: PointCloudLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();

  /** Digest of every prop baked into a sublayer at construction time. */
  private lastLayerPropsKey: string = '';
  /** Tile-array identity from the previous render — see AnimatedTripsLayer.lastTilesRef. */
  private lastTilesRef: Tile[] | null = null;

  /**
   * Singleton TimeFilterExtension reused by every sublayer. Point clouds
   * animate in window-mode (whole feature on/off + fade), so only the
   * per-feature start/end attributes are read — the per-vertex time attribute
   * is unused.
   */
  private readonly timeFilterExtension = new TimeFilterExtension({
    mode: 'window',
  });

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
   * Accessor-alias resolution: the upstream-named alias wins when
   * set; a function-valued alias warns once and falls back to the legacy prop.
   * Same value domain as the legacy prop (constant or column name).
   */
  private colorValue(): Color | string | undefined {
    return resolveAccessorAlias(
      'AnimatedPointCloudLayer',
      'getColor',
      this.props.getColor,
      this.props.color,
    );
  }

  /**
   * Compute a digest of the layer-level props that affect every sublayer. When
   * this changes we throw away the entire sublayer cache.
   *
   * Which props participate is decided by {@link POINT_CLOUD_PROP_EFFECTS}
   * rather than by an enumeration here, so a new prop cannot silently miss the
   * key. The remaining inputs are not props of this layer at all — the
   * inherited composite/time props ride the positional `extra` channel.
   */
  private computeLayerPropsKey(): string {
    return buildLayerPropsKey<_AnimatedPointCloudLayerProps>(
      this.props,
      POINT_CLOUD_PROP_EFFECTS,
      {
        overrides: {
          // The sublayer's constant `getColor` comes from the RESOLVED alias
          // value, so the key has to track it: keying the raw prop leaves every
          // cached sublayer stale when only `getColor` changes.
          color: this.colorValue(),
        },
        extra: [
          // Composite props that getSubLayerProps bakes into every sublayer
          // (opacity/pickable/visible, coordinateSystem, modelMatrix, highlight
          // props, _subLayerProps overrides…) plus the user's updateTriggers.
          inheritedPropsDigest(this.props),
          updateTriggersDigest(this.props.updateTriggers),
          // Inherited time props that `buildSublayer` forwards directly.
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
      // Drop the derived buffers (padded positions, expanded RGBA) AND the
      // references they hold into tiles the tileset has already evicted —
      // scrubbing to an empty range or panning away otherwise pins both
      // indefinitely. Mirrors AnimatedColumnLayer.
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

    // Any layer-level prop change invalidates every cached sublayer.
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
        layer: 'AnimatedPointCloudLayer',
        tiles: tiles.length,
        liveTiles: liveTiles.length,
        sublayers: sublayers.length,
        ms: performance.now() - t0,
      });
    }
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedPointCloudLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  /**
   * styleKey digest of the props that change a tile's prepared `attributes`
   * (which colour/normal/elevation column, palette / mapping content). Used by
   * the per-tile cache check.
   */
  private computeStyleKey(): string {
    const color = this.colorValue();
    const colorProp = typeof color === 'string' ? color : '';
    const mapping = this.props.colorMapping;
    // The fallback colour is BAKED into the prepared getColor buffer twice (the
    // unmapped-category slot and the 0xffff NULL slot), so a change to it must
    // re-prepare the tile — otherwise flipping it to make unmapped points
    // visible does nothing until the tile is evicted. Matches the sibling
    // column layer's `d${mapDefault}` term.
    const mapDefault = (this.props.colorMappingDefault ?? [0, 0, 0, 0]).join(
      ',',
    );
    const elevProp =
      typeof this.props.elevationProperty === 'string'
        ? this.props.elevationProperty
        : '';
    const elevScale = elevProp ? (this.props.elevationScale ?? 1) : 0;
    const rgb = this.props.rgbColorColumns;
    const rgbKey = rgb ? `rgb${rgb.join(',')}` : '';
    const colorVecKey =
      typeof this.props.colorVectorColumn === 'string'
        ? `cv${this.props.colorVectorColumn}`
        : '';
    const normalKey =
      typeof this.props.normalColumn === 'string'
        ? `n${this.props.normalColumn}`
        : '';
    return `${colorVecKey}|${normalKey}|${colorProp}|${
      colorProp
        ? colorListDigest(this.props.colorPalette ?? DEFAULT_PALETTE)
        : 0
    }|${mapping ? `m${colorMappingDigest(mapping)}` : 'g'}|d${mapDefault}|e${elevProp}:${elevScale}|${rgbKey}|${updateTriggersDigest(
      this.props.updateTriggers,
    )}`;
  }

  /**
   * Fetch the cached binary `data` object for a single tile, building (and
   * caching) it on a miss. Returns a reference-stable PreparedTile so deck.gl
   * can short-circuit GPU re-uploads.
   */
  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0) return null;
    // PointCloudLayer is instanced at points: `positions` is indexed by
    // FEATURE. A linestring/polygon tile would silently bunch every point onto
    // the first few paths' leading vertices — warn once and skip instead.
    if (
      !expectGeometry(
        binary.geometryType,
        [GeometryType.Point],
        'AnimatedPointCloudLayer',
        tileLayer.name,
      )
    )
      return null;
    const styleKey = this.computeStyleKey();
    const tileKey = tileLayerKey(tile.id, tileLayer.name);
    const cached = this.preparedTileCache.get(tileKey);
    const probe = isProbeEnabled();
    if (cached && cached.styleKey === styleKey) {
      if (probe) {
        emit('tilePrepare', {
          layer: 'AnimatedPointCloudLayer',
          tileKey,
          cached: true,
          ms: 0,
        });
      }
      return cached;
    }
    const prepared = this.buildTileData(tile, tileLayer, styleKey, tileKey);
    if (prepared) this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /** Build the binary `data` object for a single tile from scratch. */
  private buildTileData(
    tile: Tile,
    tileLayer: TileLayer,
    styleKey: string,
    tileKey: string,
  ): PreparedTile | null {
    const binary = tileLayer.features;
    const count = binary.featureCount;
    if (count === 0) return null;

    const probe = isProbeEnabled();

    const t0 = probe ? performance.now() : 0;
    const srcDims = binary.positionDimensions ?? 2;
    const vec = binary.vectorProps ?? {};

    const colorValue = this.colorValue();
    const colorProp = typeof colorValue === 'string' ? colorValue : '';

    // Per-point elevation (z) from a numeric column. Resolve so both the pad
    // path and the rare 3D-tile path can apply it. Unset / missing column ⇒
    // z stays 0 (byte-identical to a flat render).
    const elevProp =
      typeof this.props.elevationProperty === 'string'
        ? this.props.elevationProperty
        : '';
    const elevValues = elevProp ? binary.numericProps[elevProp] : undefined;
    const elevScale = this.props.elevationScale ?? 1;

    // PointCloudLayer expects size=3 positions. 2D tiles pad once (baking in an
    // elevation column when set). 3D tiles ride the original buffer zero-copy
    // UNLESS an elevation column overrides z, in which case we copy first so
    // the Arrow buffer is never mutated.
    let positions: Float64Array;
    if (srcDims === 3) {
      if (elevValues) {
        const src = binary.positions;
        positions = new Float64Array(count * 3);
        for (let i = 0; i < count; i++) {
          positions[i * 3] = src[i * 3];
          positions[i * 3 + 1] = src[i * 3 + 1];
          positions[i * 3 + 2] = elevValues[i] * elevScale;
        }
      } else {
        positions = binary.positions;
      }
    } else {
      positions = padPositionsTo3D(
        binary.positions,
        count,
        elevValues,
        elevScale,
      );
    }

    const attributes: PreparedTile['data']['attributes'] = {
      getPosition: { value: positions, size: 3 },
      // Extension-registered attribute names — must match
      // TimeFilterExtension.initializeState exactly. Zero-copy: the tile's own
      // Float32Arrays (relative to binary.timeOffset) ride straight to the GPU.
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    // Per-point surface normal from an interleaved [nx,ny,nz] vector column.
    // `instanceNormals` is a FLOAT attribute, so the leaf type is load-bearing:
    // a u8 leaf would bind as uint8x3 against a vec3 (a format mismatch, not a
    // rescale) — bindFloatVector rejects it with a named warning. Absent ⇒
    // deck's default getNormal [0,0,1].
    const normalN =
      typeof this.props.normalColumn === 'string'
        ? this.props.normalColumn
        : '';
    const normal = normalN
      ? bindFloatVector(vec[normalN], 3, 'AnimatedPointCloudLayer', normalN)
      : null;
    if (normal) {
      attributes.getNormal = normal;
    }

    // Per-point RGBA from ONE interleaved vector column (baked at build time):
    // bind the contiguous u8 buffer straight to the GPU, zero re-pack. Wins
    // over every other colour path; falls through when the column is absent.
    // Again the leaf type decides the buffer format — binding an f32 leaf by
    // `size` alone yields float32x4 against the shader's unorm8x4 and blows
    // every point out to white, so bindColorVector converts it once (warning)
    // instead.
    const colorVecN =
      typeof this.props.colorVectorColumn === 'string'
        ? this.props.colorVectorColumn
        : '';
    const colorVec = colorVecN
      ? bindColorVector(vec[colorVecN], 4, 'AnimatedPointCloudLayer', colorVecN)
      : null;

    // Per-point RGB from three numeric columns (build-time camera-sampled
    // colours). Wins over the categorical / palette path; falls through to it
    // if any of the three columns is absent from this tile.
    const rgbCols = this.props.rgbColorColumns;
    const rArr = rgbCols ? binary.numericProps[rgbCols[0]] : undefined;
    const gArr = rgbCols ? binary.numericProps[rgbCols[1]] : undefined;
    const bArr = rgbCols ? binary.numericProps[rgbCols[2]] : undefined;

    if (colorVec) {
      attributes.getColor = colorVec;
    } else if (rArr && gArr && bArr) {
      const out = new Uint8Array(count * 4);
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        out[o] = rArr[i];
        out[o + 1] = gArr[i];
        out[o + 2] = bArr[i];
        out[o + 3] = 255;
      }
      attributes.getColor = { value: out, size: 4, normalized: true };
    } else if (colorProp) {
      const cat = binary.categoricalProps[colorProp];
      const num = binary.numericProps[colorProp];
      const palette = this.props.colorPalette ?? DEFAULT_PALETTE;

      if (cat) {
        if (this.props.colorMapping) {
          // CPU branch: indexed by category string → no GPU string→int hash.
          const fallback =
            this.props.colorMappingDefault ?? ([0, 0, 0, 0] as Color);
          attributes.getColor = {
            value: coreExpandCategoricalColors(
              binary,
              {
                property: colorProp,
                colorMapping: this.props.colorMapping as Record<
                  string,
                  RGBA255
                >,
                colorMappingDefault: fallback as RGBA255,
              },
              'u8',
            ) as Uint8Array,
            size: 4,
            normalized: true,
          };
        } else {
          // CPU-expand the palette into a per-point RGBA getColor (instanceColors)
          // so categorical colouring is PHONG-LIT like every other colour path
          // (constant / vector / RGB / colorMapping). The GPU CategoryColor
          // extension instead REPLACES colour in the fragment stage AFTER
          // lighting (`color = vec4(palette.rgb, …)`), discarding the lit vColor
          // → flat/unshaded points, inconsistent with this lit layer's purpose.
          const fallback =
            this.props.colorMappingDefault ?? ([0, 0, 0, 0] as Color);
          const out = new Uint8Array(count * 4);
          const pl = palette.length;
          for (let i = 0; i < count; i++) {
            const cIdx = cat.indices[i];
            const c =
              cIdx === 0xffff ? fallback : (palette[cIdx % pl] ?? fallback);
            const o = i * 4;
            out[o] = c[0];
            out[o + 1] = c[1];
            out[o + 2] = c[2];
            out[o + 3] = c[3] ?? 255;
          }
          attributes.getColor = { value: out, size: 4, normalized: true };
        }
      } else if (num && this.props.colorMapping) {
        // Numeric column + mapping: stringify lookup (rare).
        const fallback =
          this.props.colorMappingDefault ?? ([0, 0, 0, 0] as Color);
        const out = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
          const c = this.props.colorMapping[String(num[i])] || fallback;
          const o = i * 4;
          out[o] = c[0];
          out[o + 1] = c[1];
          out[o + 2] = c[2];
          out[o + 3] = c[3] ?? 255;
        }
        attributes.getColor = { value: out, size: 4, normalized: true };
      }
    }

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      data: { length: count, attributes },
      timeOffset: binary.timeOffset,
      tile,
      layerName: tileLayer.name,
      features: binary,
    };
    if (probe) {
      emit('tilePrepare', {
        layer: 'AnimatedPointCloudLayer',
        tileKey,
        cached: false,
        features: count,
        ms: performance.now() - t0,
      });
    }
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): PointCloudLayer {
    // `Required<>`-typed: the defaultProps value guarantees values here.
    const timeWindow = this.props.timeWindow;
    const colorValue = this.colorValue();
    const constColor = (
      Array.isArray(colorValue) ? colorValue : DEFAULT_COLOR
    ) as Color;

    // NO CategoryColorExtension. This is a LIT layer, so every colour path —
    // constant, vector, RGB columns, colorMapping, palette — resolves on the
    // CPU into `instanceColors` (see the class docstring); the extension's
    // fragment hook would replace colour AFTER lighting. Installing it anyway
    // would cost a live `instanceCategoryIndex` attribute, a UBO, an
    // fs:DECKGL_FILTER_COLOR branch and a palette-texture acquire/release per
    // sublayer, all permanently idle. User extensions from the top-level
    // `extensions` prop are appended (composeExtensions).
    const extensions = this.composeExtensions([this.timeFilterExtension]);

    // getSubLayerProps inheritance (opacity/pickable/visible, coordinate
    // system, highlight props, …) + user `_subLayerProps.pointCloud` overrides.
    // Only runs inside this cache-gated build path — never per frame.
    const props = this.composeSubLayerProps('pointCloud', prepared.tileKey, {
      data: prepared.data as any,
      // Identity comparator: deck.gl skips prop-diff for `data` entirely when
      // the same object reference comes back. Pairs with the preparedTileCache
      // which guarantees stable identity.
      dataComparator: (a: any, b: any) => a === b,

      // PointCloudLayer styling pass-through.
      sizeUnits: this.props.sizeUnits,
      pointSize: this.props.pointSize,
      material: this.props.material,

      // Constant fallback — used when the binary getColor attribute is absent.
      getColor: constColor,

      extensions,

      // TimeFilterExtension wiring — per-tile timeOffset and window.
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
      // Time-as-height (space-time cube): whole points lift by start time.
      timeHeightScale: this.props.timeHeightScale,
      timeHeightOrigin: this.props.timeHeightOrigin,

      // TileLayer convention: the source tile rides on the sublayer so the base
      // getPickingInfo can enrich info.tile / decode the picked feature.
      tile: prepared.tile,
      sttFeatures: prepared.features,
    });
    // `_subLayerProps: { pointCloud: { type } }` swaps the sublayer class — the
    // CompositeLayer-native override point.
    const SubLayerClass = this.getSubLayerClass('pointCloud', PointCloudLayer);
    return new SubLayerClass(props as any);
  }
}
