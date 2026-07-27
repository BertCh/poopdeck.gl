// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * SplatLayer — render a spatiotemporal point cloud as **oriented anisotropic
 * Gaussian surfels** that evolve over time: a "formal" splat for STT.
 *
 * Renderer parity: `@poopdeck.gl/three`'s `SurfelLayer` is the Three analogue of
 * this layer — same primitive, same `--surfel`-baked columns (see that class's
 * docstring for the cross-reference back here).
 *
 * Where {@link AnimatedPointLayer} `splat: true` draws each return as a soft
 * round billboard (an isotropic point splat — no orientation, no surface), this
 * layer draws each feature as a real oriented elliptical disk lying in its local
 * surface frame, with a soft radial Gaussian profile AND a soft temporal
 * Gaussian weight. Overlapping surfels read as continuous, depth-correct surface
 * — *surface splatting* (Pfister/Zwicker surfels, Zwicker "EWA Surface
 * Splatting"), the right formalism for splats derived from a surface scan.
 *
 * It consumes the columns baked by `scripts/data-generation/waymo_extract.py
 * --surfel` (k-NN covariance per LIDAR sweep):
 *   • geometry `[lng, lat]` + an elevation column (`z`, metres) → the surfel
 *     centre,
 *   • a surface-frame quaternion (`qx,qy,qz,qw`) whose matrix columns are
 *     `[tangent | bitangent | normal]` in the render ENU frame,
 *   • two in-plane half-extents (`s_major, s_minor`, metres),
 *   • per-surfel RGB (`r,g,b`, 0–255 — camera-projected colour) and a
 *     confidence (`surfel_opacity`, 0–1) folded into the disk alpha,
 *   • the per-feature sample time (start time) → the temporal Gaussian centre.
 *
 * ── ARCHITECTURE ─────────────────────────────────────────────────────────────
 * Mirrors {@link AnimatedPointLayer}'s v3 per-tile binary-sublayer design: one
 * {@link SplatPrimitiveLayer} per (tile, layer), reference-stable `data` cached
 * across renders so deck.gl short-circuits GPU re-uploads, time driven by a
 * shared `getTime` callback (no layer recreation per tick). Streaming is
 * additive (a new tile = one sublayer + one upload). Picking rides the base
 * {@link SpatioTemporalLayer.getPickingInfo} (each sublayer carries its `tile` +
 * `sttFeatures`).
 *
 * Sublayer short id for `_subLayerProps` overrides: **`splats`**.
 *
 * MapView only — the disk offset is computed in web-mercator common space;
 * GlobeView's non-linear projection is out of scope (the AV cockpit, the
 * intended consumer, is a tilted MapView).
 */

import type { Color, DefaultProps, Layer, LayerContext } from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
} from '../spatiotemporal-layer.js';
import { SplatPrimitiveLayer } from '../internal/splat-primitive-layer.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import {
  inheritedPropsDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { expectGeometry } from '../../lib/geometry-guard.js';
import { bindColorVector, bindFloatVector } from '../../lib/vector-props.js';
import { GeometryType, tileLayerKey } from '@poopdeck.gl/core';
import type { Tile, STTTileLayer as TileLayer } from '@poopdeck.gl/core';

const DEBUG = false;

/** Props added by {@link SplatLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link SplatLayerProps}). */
export interface _SplatLayerProps {
  /**
   * VECTOR column name (a `FixedSizeList<Float32,4>` baked by
   * `stt-build --vector-group`) holding each surfel's orientation quaternion
   * `[qx, qy, qz, qw]`, whose rotation-matrix COLUMNS are the surfel's
   * `[tangent | bitangent | normal]`. Bound straight to the GPU (zero re-pack on
   * the main thread). A tile missing it is skipped (warns once).
   * @default 'surfel_quat'
   */
  quaternionColumn?: string;

  /**
   * VECTOR column name (`FixedSizeList<Float32,2>`) holding the in-plane
   * half-extents `[s_major, s_minor]` in metres. A tile missing it is skipped.
   * @default 'surfel_scale'
   */
  scaleColumn?: string;

  /**
   * VECTOR column name (`FixedSizeList<UInt8,4>`) holding per-surfel RGBA, with
   * the baked confidence already folded into the alpha channel. When present
   * each surfel is painted that colour; otherwise `fallbackColor` is used.
   * @default 'surfel_rgba'
   */
  colorColumn?: string | null;

  /**
   * NUMERIC column name holding each surfel's altitude in metres (the cloud's
   * real height). Bound zero-copy as a separate elevation attribute and scaled
   * by {@link elevationScale} in the shader. Absent ⇒ z = 0 (a flat carpet).
   * @default 'z'
   */
  elevationProperty?: string | null;

  /** Multiplier applied to {@link elevationProperty} before it becomes z. @default 1 */
  elevationScale?: number;

  /** Constant RGBA used when {@link rgbColumns} is unset / absent. @default [200,205,215,255] */
  fallbackColor?: Color;

  /**
   * Soft temporal Gaussian width in milliseconds. Each surfel's opacity is
   * multiplied by `exp(-½·((t-μ_t)/σ)²)` with `μ_t` its sample time and `σ`
   * this value — so the cloud brightens at each sweep's instant and fades
   * smoothly within ±~3σ instead of hard-popping on a window edge. Tune to
   * ~1–2× the sweep interval (Waymo LIDAR ≈ 100 ms). @default 180
   */
  temporalSigma?: number;

  /**
   * Worldbuild accreted reconstruction. When true, a STATIC surfel
   * (`is_dynamic` column 0 / absent) appears at its `start_time` (the voxel's
   * first-seen time) and PERSISTS forever after — the world "builds itself" as
   * the playhead advances — while a DYNAMIC surfel (`is_dynamic` 1) keeps the
   * symmetric windowed Gaussian (using {@link temporalSigmaDynamic}) so moving
   * actors read as ghosted smears threading through the solid static world. When
   * false the layer is the plain symmetric-Gaussian splat. @default false
   */
  cumulative?: boolean;

  /**
   * Reveal alpha-ramp duration in milliseconds for a STATIC surfel once it
   * appears under {@link cumulative}: its alpha ramps `0→1` over this many ms
   * after `start_time`. `0` ⇒ it pops to full alpha instantly; before
   * `start_time` it is hidden. Ignored when `cumulative` is false. @default 0
   */
  revealFade?: number;

  /**
   * Soft temporal Gaussian width in milliseconds for DYNAMIC surfels. Moving
   * actors read as ghosted motion smears at this width even under
   * {@link cumulative}. `0`/unset ⇒ falls back to {@link temporalSigma}. @default 0
   */
  temporalSigmaDynamic?: number;

  /** Multiplier on every surfel's baked in-plane extents. @default 1 */
  sizeScale?: number;

  /** Radial Gaussian tightness (`alpha *= exp(-falloff·r²)` over the disk). @default 3 */
  gaussianFalloff?: number;

  /**
   * Discard fragments whose final alpha is below this, so faint disk rims never
   * write depth (no halo) while the confident core does. @default 0.04
   */
  alphaCutoff?: number;
}

/** Complete props accepted by {@link SplatLayer}. */
export type SplatLayerProps = _SplatLayerProps & SpatioTemporalLayerProps;

const DEFAULT_FALLBACK_COLOR: Color = [200, 205, 215, 255];

/**
 * Per-tile prepared data — a reference-stable binary `data` object for one
 * {@link SplatPrimitiveLayer}, cached so deck.gl skips GPU re-uploads on
 * unchanged tiles (identity `dataComparator`). Mirrors AnimatedPointLayer's
 * PreparedTile.
 */
interface PreparedSplatTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    attributes: Record<
      string,
      { value: any; size: number; normalized?: boolean }
    >;
  };
  /** Tile carried the per-surfel colour vector column → instanceColors bound. */
  hasColor: boolean;
  timeOffset: number;
  tile: Tile;
  layerName: string;
}

/**
 * Render caches, held in `this.state` rather than in instance fields.
 *
 * deck's layer matching constructs a NEW layer object for every render and
 * moves only `state`/`internalState` across (`Layer._transferState`); class
 * field initializers re-run on the new instance. So an unmemoized
 * `new SplatLayer({...})` inside a React render emptied both caches every
 * frame — re-preparing (and re-uploading) every resident surfel tile.
 */
interface SplatRenderCache {
  /** Per-tile prepared-data cache. Pruned to the live tile set each render. */
  prepared: Map<string, PreparedSplatTile>;
  /** Per-tile sublayer-instance cache — stable refs let deck skip prop diff. */
  sublayers: Map<
    string,
    {
      layer: SplatPrimitiveLayer;
      preparedKey: PreparedSplatTile;
      layerPropsKey: string;
    }
  >;
  layerPropsKey: string;
  tilesRef: Tile[] | null;
}

function emptySplatRenderCache(): SplatRenderCache {
  return {
    prepared: new Map(),
    sublayers: new Map(),
    layerPropsKey: '',
    tilesRef: null,
  };
}

/**
 * Spatiotemporal oriented-Gaussian-surfel layer. See the file docstring.
 */
export class SplatLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<ExtraPropsT & Required<_SplatLayerProps>> {
  static layerName = 'SplatLayer';

  static defaultProps: DefaultProps<SplatLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    // Permissive {type:'object'} descriptors — these hold column names / a
    // Color, which deck's typed validators would reject.
    quaternionColumn: { type: 'object', value: 'surfel_quat', compare: true },
    scaleColumn: { type: 'object', value: 'surfel_scale', compare: true },
    colorColumn: {
      type: 'object',
      value: 'surfel_rgba',
      optional: true,
      compare: true,
    },
    elevationProperty: {
      type: 'object',
      value: 'z',
      optional: true,
      compare: true,
    },
    elevationScale: { type: 'number', value: 1 },
    fallbackColor: { type: 'color', value: DEFAULT_FALLBACK_COLOR },
    temporalSigma: { type: 'number', value: 180, min: 1 },
    cumulative: { type: 'boolean', value: false },
    revealFade: { type: 'number', value: 0, min: 0 },
    temporalSigmaDynamic: { type: 'number', value: 0, min: 0 },
    sizeScale: { type: 'number', value: 1, min: 0 },
    gaussianFalloff: { type: 'number', value: 3, min: 0 },
    alphaCutoff: { type: 'number', value: 0.04, min: 0 },
  };

  /**
   * The render caches, lazily created inside `this.state` — see
   * {@link SplatRenderCache} for why an instance field is the wrong home.
   */
  private get cache(): SplatRenderCache {
    // `state` is assigned by deck long before renderLayers runs; the guard is
    // for the Object.create-based unit harnesses.
    if (!this.state) this.state = {} as this['state'];
    const state = this.state;
    let cache = state.sttSplatCache as SplatRenderCache | undefined;
    if (!cache) {
      cache = emptySplatRenderCache();
      state.sttSplatCache = cache;
    }
    return cache;
  }

  /* Named views onto {@link cache}. Accessors (not fields) so every existing
   * call site — and the test harnesses that seed these by name — keep working
   * while the storage itself lives in `state`. */

  private get preparedTileCache(): Map<string, PreparedSplatTile> {
    return this.cache.prepared;
  }
  private set preparedTileCache(v: Map<string, PreparedSplatTile>) {
    this.cache.prepared = v;
  }

  private get sublayerCache(): SplatRenderCache['sublayers'] {
    return this.cache.sublayers;
  }
  private set sublayerCache(v: SplatRenderCache['sublayers']) {
    this.cache.sublayers = v;
  }

  private get lastLayerPropsKey(): string {
    return this.cache.layerPropsKey;
  }
  private set lastLayerPropsKey(v: string) {
    this.cache.layerPropsKey = v;
  }

  private get lastTilesRef(): Tile[] | null {
    return this.cache.tilesRef;
  }
  private set lastTilesRef(v: Tile[] | null) {
    this.cache.tilesRef = v;
  }

  /** Stable getTime ref — a fresh arrow each render would defeat deck's cache. */
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    if (this.state) this.state.sttSplatCache = emptySplatRenderCache();
  }

  /**
   * Digest of props baked into a tile's prepared `attributes` (which columns,
   * elevation, fallback color). A change invalidates the prepared cache.
   */
  private computeStyleKey(): string {
    const q =
      typeof this.props.quaternionColumn === 'string'
        ? this.props.quaternionColumn
        : 'surfel_quat';
    const s =
      typeof this.props.scaleColumn === 'string'
        ? this.props.scaleColumn
        : 'surfel_scale';
    const c =
      typeof this.props.colorColumn === 'string'
        ? this.props.colorColumn
        : 'none';
    const elev =
      typeof this.props.elevationProperty === 'string'
        ? this.props.elevationProperty
        : '';
    // elevationScale / fallbackColor are SHADER UNIFORMS now, not baked into the
    // prepared attributes — they belong to the layer-props key, not styleKey.
    return [
      q,
      s,
      c,
      elev,
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  /** Digest of the layer-level props baked into every sublayer (visual + time). */
  private computeLayerPropsKey(): string {
    return [
      this.props.temporalSigma,
      // Worldbuild props: a mode/prop flip must bust the sublayer cache so the
      // new uniforms reach the primitive on the next render.
      this.props.cumulative ? 1 : 0,
      this.props.revealFade,
      this.props.temporalSigmaDynamic,
      this.props.sizeScale,
      this.props.gaussianFalloff,
      this.props.alphaCutoff,
      // Shader uniforms (not baked into the prepared attributes).
      this.props.elevationScale,
      Array.isArray(this.props.fallbackColor)
        ? this.props.fallbackColor.join('.')
        : '',
      this.props.timeWindow,
      inheritedPropsDigest(this.props),
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.lastTilesRef = null;
      return [];
    }

    // Prune caches only when the tile-array ref changed (same array ⇒ same set).
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

    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastLayerPropsKey) {
      this.lastLayerPropsKey = layerPropsKey;
      this.sublayerCache.clear();
    }

    // styleKey is layer-global (same for every tile this render) — compute it
    // ONCE here rather than per tile inside prepareTile/buildTileData.
    const styleKey = this.computeStyleKey();

    const sublayers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer, styleKey);
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
      layer: 'SplatLayer',
      tiles: tiles.length,
      sublayers: sublayers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `SplatLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`,
      );
    }
    return sublayers;
  }

  private prepareTile(
    tile: Tile,
    tileLayer: TileLayer,
    styleKey: string,
  ): PreparedSplatTile | null {
    if (tileLayer.features.featureCount === 0) return null;
    const tileKey = tileLayerKey(tile.id, tileLayer.name);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) return cached;
    const prepared = this.buildTileData(tile, tileLayer, styleKey);
    if (prepared) this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  /**
   * Bind one tile's GPU-ready instance attributes — **zero per-point work**.
   *
   * The surfel quaternion / scale / colour are baked at BUILD time as interleaved
   * `FixedSizeList` columns (`stt-build --vector-group`), so the decoder hands
   * each as a contiguous typed array (`binary.vectorProps`) that rides STRAIGHT
   * to the GPU. Positions stay 2D (zero-copy geometry); altitude rides its own
   * zero-copy `z` column and is scaled in the shader. For a correctly built
   * archive the only allocation here is the tiny attributes record — no
   * per-surfel loops, no large typed arrays — which is what keeps a new dense
   * ("ultra") tile arriving mid-drive from hitching the main thread. (A colour
   * column baked with an `f32` leaf instead of `u8` is converted once per tile
   * and warns; see `lib/vector-props.ts`.)
   */
  private buildTileData(
    tile: Tile,
    tileLayer: TileLayer,
    styleKey: string,
  ): PreparedSplatTile | null {
    const binary = tileLayer.features;
    const count = binary.featureCount;
    if (count === 0) return null;

    const layerId = String(this.props.id ?? 'SplatLayer');
    // Surfel centres are indexed by FEATURE, so a linestring/polygon tile would
    // read the first `featureCount` VERTICES instead — every disk in the wrong
    // place, with no error.
    if (
      !expectGeometry(
        binary.geometryType,
        [GeometryType.Point],
        layerId,
        tileLayer.name,
      )
    ) {
      return null;
    }

    // The centre attribute is bound with `size: 2` straight off the geometry
    // buffer, so a 3D surfel archive would read PAIRS across an interleaved
    // [x,y,z,…] run and put every surfel after the first at a garbage
    // coordinate. Skip + warn (same contract as the missing-column branch).
    const dims = binary.positionDimensions ?? 2;
    if (dims !== 2) {
      warnOnce(
        `SplatLayer:positionDimensions:${layerId}:${dims}`,
        `[${layerId}] tile layer ${JSON.stringify(tileLayer.name)} carries ` +
          `${dims}D positions, but surfel centres bind as 2D [lng, lat] with ` +
          `altitude in the separate \`elevationProperty\` column. Nothing ` +
          `rendered for this tile — rebuild the archive with 2D geometry + a ` +
          `z column, or point a 3D-capable layer at it.`,
      );
      return null;
    }

    const t0 = performance.now();
    const num = binary.numericProps;
    const vec = binary.vectorProps ?? {};

    const quatN =
      typeof this.props.quaternionColumn === 'string'
        ? this.props.quaternionColumn
        : 'surfel_quat';
    const scaleN =
      typeof this.props.scaleColumn === 'string'
        ? this.props.scaleColumn
        : 'surfel_scale';
    // `bindFloatVector` makes the LEAF TYPE load-bearing as well as the width:
    // a u8 leaf against these float attributes is a format mismatch, not a
    // rescale, so it is rejected (warned) rather than bound as garbage.
    const quat = bindFloatVector(vec[quatN], 4, layerId, quatN);
    const scale = bindFloatVector(vec[scaleN], 2, layerId, scaleN);

    // Surfel orientation + extent are mandatory — without them there is no
    // oriented disk to draw. They must be the interleaved vector columns baked
    // by `stt-build --vector-group`; skip (warn once) rather than mis-render.
    if (!quat || !scale) {
      warnOnce(
        'SplatLayer:missingSurfelColumns',
        `[SplatLayer] tile is missing the interleaved surfel vector columns ` +
          `('${quatN}' FixedSizeList<f32,4> + '${scaleN}' FixedSizeList<f32,2>); ` +
          `rebuild the bundle with \`stt-build --vector-group\`. Nothing rendered ` +
          `for this tile.`,
      );
      return null;
    }

    // Centre positions ride the 2D geometry buffer zero-copy; altitude is its own
    // zero-copy column (scaled in the shader by elevationScale).
    const elevProp =
      typeof this.props.elevationProperty === 'string'
        ? this.props.elevationProperty
        : '';
    const elev = elevProp ? num[elevProp] : undefined;

    // Per-surfel RGBA (baked confidence already in alpha) — the interleaved u8
    // vector column, bound normalized. Absent ⇒ the shader's fallback colour.
    // `bindColorVector` pins the leaf type: gating on `size === 4` alone let an
    // f32 leaf through as a `float32x4` (16-byte stride) buffer against the
    // `unorm8x4` attribute, blowing every surfel out to white with no
    // diagnostic (see lib/vector-props.ts).
    const colorN =
      typeof this.props.colorColumn === 'string' ? this.props.colorColumn : '';
    const color = colorN
      ? bindColorVector(vec[colorN], 4, layerId, colorN)
      : null;
    const hasColor = !!color;

    const attributes: PreparedSplatTile['data']['attributes'] = {
      // 2D geometry, zero-copy (guarded above).
      instancePositions: { value: binary.positions, size: 2 },
      instanceQuaternions: { value: quat.value, size: 4 },
      instanceScales: { value: scale.value, size: 2 },
      // Zero-copy: the tile's own start times ride straight to the GPU as μ_t.
      instanceStartTimes: { value: binary.startTimes, size: 1 },
    };
    if (elev) {
      attributes.instanceElevations = { value: elev, size: 1 };
    }
    if (color) {
      attributes.instanceColors = color;
    }
    // Worldbuild static/dynamic flag (0/1) from the `is_dynamic` column, bound
    // zero-copy (the shader thresholds at 0.5). Absent ⇒ default 0 (all static).
    const dynArr = num['is_dynamic'];
    if (dynArr) {
      attributes.instanceIsDynamic = { value: dynArr, size: 1 };
    }

    const prepared: PreparedSplatTile = {
      tileKey: tileLayerKey(tile.id, tileLayer.name),
      styleKey,
      data: { length: count, attributes },
      hasColor,
      timeOffset: binary.timeOffset,
      tile,
      layerName: tileLayer.name,
    };
    emit('tilePrepare', {
      layer: 'SplatLayer',
      tileKey: prepared.tileKey,
      cached: false,
      features: count,
      ms: performance.now() - t0,
    });
    return prepared;
  }

  private buildSublayer(prepared: PreparedSplatTile): SplatPrimitiveLayer {
    const extensions = this.composeExtensions([]);
    const props = this.composeSubLayerProps('splats', prepared.tileKey, {
      data: prepared.data as any,
      // Identity comparator: pairs with the prepared-tile cache's stable refs so
      // deck.gl skips the GPU re-upload on unchanged tiles.
      dataComparator: (a: any, b: any) => a === b,
      extensions,

      // Time wiring: shared getTime + this tile's offset (matches how the
      // attribute start times were relativised).
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      temporalSigma: this.props.temporalSigma,

      // Worldbuild accreted-reveal wiring (no-ops unless `cumulative`).
      cumulative: this.props.cumulative,
      revealFade: this.props.revealFade,
      temporalSigmaDynamic: this.props.temporalSigmaDynamic,

      // Splat shaping.
      sizeScale: this.props.sizeScale,
      falloff: this.props.gaussianFalloff,
      alphaCutoff: this.props.alphaCutoff,

      // Elevation + colour are shader uniforms now (z and rgba ride zero-copy
      // attributes; the scale/fallback apply in the shader). `useVertexColor`
      // is false when this tile carried no per-surfel colour vector column.
      elevationScale: this.props.elevationScale ?? 1,
      useVertexColor: prepared.hasColor,
      fallbackColor: this.props.fallbackColor ?? DEFAULT_FALLBACK_COLOR,

      // Picking: the base getPickingInfo decodes from these on a hit.
      tile: prepared.tile,
      sttFeatures: tileLayerFeatures(prepared),
    });
    // `getSubLayerProps` copies the COMPOSITE's `parameters` onto every
    // sublayer, and deck's default for it is `{}` — which would SHADOW
    // SplatPrimitiveLayer's own `defaultProps.parameters` and silently wipe the
    // sort-free depth-write contract that makes surface splatting work (see
    // SPLAT_DRAW_PARAMETERS there). An empty/absent inherited value carries no
    // information, so drop it and let the primitive's default stand. A caller
    // who genuinely sets `parameters` — on this layer or via
    // `_subLayerProps.splats` — still overrides it wholesale, which is deck's
    // normal prop-beats-default semantics for `parameters`.
    const inherited = props.parameters as Record<string, unknown> | undefined;
    if (!inherited || Object.keys(inherited).length === 0) {
      delete props.parameters;
    }
    const SubLayerClass = this.getSubLayerClass('splats', SplatPrimitiveLayer);
    return new SubLayerClass(props as any);
  }
}

/** Re-resolve the (tile, layer) BinaryFeatures for picking enrichment. */
function tileLayerFeatures(prepared: PreparedSplatTile) {
  const tl = prepared.tile.layers.find((l) => l.name === prepared.layerName);
  return tl?.features;
}
