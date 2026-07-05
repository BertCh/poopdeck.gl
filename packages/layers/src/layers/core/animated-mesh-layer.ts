// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedMeshLayer — recognizable 3D MODELS (cars / pedestrians / ships /
 * planes) that move smoothly over time. It is the MESH analog of
 * {@link AnimatedBoundingBoxLayer}'s oriented cuboids: instead of drawing each
 * tracked object as a phong-lit box, it instances an arbitrary glTF/OBJ mesh at
 * the object's interpolated pose.
 *
 * ── DATA: the AV `objects/` point archive, VERBATIM ──────────────────────────
 * Same tile shape as the bounding-box layer — one POINT feature per tracked
 * object PER KEYFRAME (`track_id`, `category`, `heading`, `length`/`width`/
 * `height`, `speed`, timestamped). The two layers are interchangeable over the
 * exact same archive; only the render primitive differs. The mesh geometry is
 * NOT a tile column — it is a STATIC per-layer prop ({@link _AnimatedMeshLayerProps.mesh},
 * the analog of IconLayer's `iconAtlas`), optionally a per-category map
 * ({@link _AnimatedMeshLayerProps.meshMapping}) so cars, pedestrians and cyclists
 * each get their own model.
 *
 * ── MOTION: the shared track kernel (no "train" of models) ────────────────────
 * Like the bounding-box layer, this pools every loaded tile's snapshots by
 * `track_id` (rebased to absolute epoch-ms so cross-tile keyframes join one
 * timeline) and, once per frame, emits ONE interpolated instance per ACTIVE
 * track — never one model per keyframe. All of that (pooling, binary-search +
 * lerp, shortest-arc heading interpolation, appear/disappear fade, GPU-id
 * picking rows) lives in {@link ../../lib/track-kernel.js} and is SHARED with
 * AnimatedBoundingBoxLayer — this file owns only the SimpleMeshLayer instance
 * bake. Motion rides a CPU instance buffer the base class never recomputes on a
 * bare time tick, so — like its sibling — we override `_handleTimeUpdate` to
 * force a renderLayers() pass per advanced tick.
 *
 * ── RENDER: SimpleMeshLayer (@deck.gl/mesh-layers) ───────────────────────────
 * Per-instance attributes, rebuilt each frame from the interpolated samples:
 *   • getPosition    → the interpolated point (lon/lat/alt).
 *   • getOrientation → [pitch, heading°+yaw, roll] — heading (a yaw about the
 *     vertical z axis) rides slot 1 of deck's [pitch, yaw, roll], plus the
 *     constant {@link _AnimatedMeshLayerProps.orientationOffset} so a model whose
 *     native forward axis isn't +x can be corrected once.
 *   • getScale       → [length, width, height] when {@link _AnimatedMeshLayerProps.scaleToDimensions}
 *     (default) — fits a unit-sized model to the object's bbox; else [1,1,1]
 *     (native model size). SimpleMeshLayer's own `sizeScale` multiplies on top.
 *   • getColor       → per-instance RGBA from `category` via `colorMapping`
 *     (× the CPU appear/disappear fade). With a `texture` set, the mesh's
 *     texture wins and this is ignored (deck SimpleMeshLayer semantics); default
 *     white keeps textured / vertex-colored models looking natural.
 * Pass-throughs: `mesh`, `texture`, `textureParameters`, `sizeScale`,
 * `getTranslation` (constant anchor offset), `material`, `wireframe`,
 * `_instanced`. (deck 9.3's SimpleMeshLayer exposes no `_lighting`/`_useMeshColors`
 * props — `material` is the lighting control here.)
 *
 * ── PER-CATEGORY MODELS ──────────────────────────────────────────────────────
 * With {@link _AnimatedMeshLayerProps.meshMapping} set, the active samples are
 * grouped by `category` and one SimpleMeshLayer is emitted per category (mesh is
 * a per-layer prop, so distinct models need distinct sublayers), each falling
 * back to `mesh` for categories absent from the map. Otherwise a single
 * SimpleMeshLayer draws every instance.
 *
 * Picking: every mesh sublayer is pickable; a hit's `info.index` maps into that
 * sublayer's active-track rows (stride 1) and {@link getPickingInfo} sets
 * `info.object` to the flat decoded props (`track_id`/`category`/`heading`/dims/
 * `speed`) — the same AV-inspector shape the bounding-box layer emits.
 *
 * Sublayer short id for `_subLayerProps` overrides: **`mesh`**.
 */

import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type {
  Color,
  DefaultProps,
  GetPickingInfoParams,
  Layer,
  LayerContext,
  Material,
} from '@deck.gl/core';
import {
  SpatioTemporalLayer,
  SpatioTemporalLayerProps,
  SpatioTemporalPickingInfo,
} from '../spatiotemporal-layer.js';
import { emit } from '../../lib/telemetry.js';
import { warnOnce } from '../../lib/log.js';
import {
  colorMappingDigest,
  updateTriggersDigest,
} from '../../lib/style-digest.js';
import { resolveAccessorAlias } from '../../lib/accessor-alias.js';
import type { ColorAccessorValue } from '../../lib/accessor-alias.js';
import {
  buildTrackIndex as kernelBuildTrackIndex,
  sampleTrack as kernelSampleTrack,
  makePickRow,
  RAD_TO_DEG,
  SINGLETON_HOLD_MS,
} from '../../lib/track-kernel.js';
import type {
  Track,
  Sample,
  TrackPickRow,
  TrackFieldConfig,
} from '../../lib/track-kernel.js';
import type { Tile } from '@poopdeck.gl/core';

const DEBUG = false;

/** Shared fallback color when a track's category is unmapped / colorProperty is
 * unset. White so textured / vertex-colored models render with their own look
 * (deck SimpleMeshLayer: `[255,255,255]` == "use the original mesh colors"). */
const DEFAULT_COLOR: Color = [255, 255, 255, 255];

/**
 * A mesh source SimpleMeshLayer accepts (glTF/OBJ URL, a parsed geometry /
 * attributes object, or a promise thereof). Kept structurally loose — deck's
 * internal `Mesh` union is not exported and we only forward the value.
 */
export type MeshSource = string | object | Promise<unknown> | null;

/** Props added by {@link AnimatedMeshLayer} (own props only — compose with
 * {@link SpatioTemporalLayerProps} via {@link AnimatedMeshLayerProps}). */
export interface _AnimatedMeshLayerProps {
  /**
   * The STATIC 3D model instanced at every tracked object's pose — a glTF/OBJ
   * URL, a parsed mesh/geometry object, or a promise of one (SimpleMeshLayer's
   * `mesh` prop, forwarded verbatim). This is a per-LAYER prop, NOT a tile
   * column (the analog of IconLayer's `iconAtlas`). When {@link meshMapping} is
   * set it is the fallback for categories absent from the map. If both are
   * unset the layer renders nothing (and warns once).
   * @default null
   */
  mesh?: MeshSource;

  /**
   * Per-CATEGORY model map, keyed by the raw `colorProperty`/`getColor` category
   * string. When set, active objects are grouped by category and each group is
   * drawn by its own SimpleMeshLayer with `meshMapping[category]` (falling back
   * to {@link mesh}). Categories with neither a mapped model nor a `mesh`
   * fallback are skipped.
   * @default null
   */
  meshMapping?: Record<string, MeshSource> | null;

  /**
   * Texture applied to the mesh (SimpleMeshLayer `texture` pass-through — a URL,
   * a `TextureSource`, or a promise). When set, the texture wins over
   * `getColor`. @default null
   */
  texture?: unknown;

  /**
   * Texture sampler parameters (SimpleMeshLayer `textureParameters` pass-through).
   * @default null
   */
  textureParameters?: unknown;

  /**
   * Per-feature track-identity column NAME used to group an object's keyframe
   * snapshots into one interpolated model. When absent each snapshot becomes its
   * own (un-interpolated) instance, held for {@link SINGLETON_HOLD_MS}.
   * @default 'track_id'
   */
  trackIdProperty?: string;

  /**
   * Categorical property column NAME that drives each model's per-instance color
   * AND (with {@link meshMapping}) which model to draw — e.g. `'category'`.
   * Resolved on the CPU through {@link colorMapping}. When unset, models use the
   * constant {@link colorMappingDefault} and a single {@link mesh}.
   * @default null
   */
  colorProperty?: string | null;

  /**
   * Upstream-vocabulary alias reconciling deck's `getColor`. Accepts a constant
   * {@link Color} (a single color for every model, overriding
   * {@link colorProperty}) OR a property-column NAME (treated as
   * {@link colorProperty}) — NOT a function accessor (binary tiles can't run
   * per-feature JS; a function warns once and falls back). When set, it wins.
   * @default null
   */
  getColor?: ColorAccessorValue | null;

  /**
   * Category → color map, keyed by the raw category string. Categories absent
   * from the map fall back to {@link colorMappingDefault}.
   * @default null
   */
  colorMapping?: Record<string, Color> | null;

  /**
   * Color for categories not present in {@link colorMapping} (and the constant
   * color when {@link colorProperty}/`getColor` name no column). Default white so
   * textured models keep their own appearance.
   * @default [255, 255, 255, 255]
   */
  colorMappingDefault?: Color;

  /**
   * Per-feature yaw column NAME (radians, world frame, 0 = +x/east, CCW). Drives
   * the model's `getOrientation` yaw (slot 1 of deck's [pitch, yaw, roll]),
   * angle-interpolated between keyframes. Absent ⇒ models are axis-aligned.
   * @default 'heading'
   */
  headingProperty?: string;

  /**
   * Constant orientation offset `[pitch, yaw, roll]` in degrees, ADDED to the
   * interpolated heading (which rides the yaw slot). Use it to correct a model
   * whose native forward axis is not +x, or to tilt/roll it.
   * @default [0, 0, 0]
   */
  orientationOffset?: [number, number, number];

  /**
   * Per-feature model-length column NAME (meters, model +x). Drives the model's
   * x-scale when {@link scaleToDimensions}. Absent ⇒ {@link defaultLength}.
   * @default 'length'
   */
  lengthProperty?: string;

  /**
   * Per-feature model-width column NAME (meters). Drives the y-scale when
   * {@link scaleToDimensions}. Absent ⇒ {@link defaultWidth}.
   * @default 'width'
   */
  widthProperty?: string;

  /**
   * Per-feature model-height column NAME (meters). Drives the z-scale when
   * {@link scaleToDimensions}. Absent ⇒ {@link defaultHeight}.
   * @default 'height'
   */
  heightProperty?: string;

  /**
   * When true (default), `getScale` = `[length, width, height]`, fitting a
   * unit-sized model to each object's bounding box. When false, `getScale` =
   * `[1, 1, 1]` and the model renders at its native size (scaled only by
   * {@link sizeScale}) — the right choice for a pre-sized car/ped model.
   * @default true
   */
  scaleToDimensions?: boolean;

  /**
   * Uniform SimpleMeshLayer size multiplier applied to the whole model on top of
   * `getScale`.
   * @default 1
   */
  sizeScale?: number;

  /**
   * Constant translation `[x, y, z]` (meters) from the anchor point
   * (SimpleMeshLayer `getTranslation` pass-through). Lift a model whose origin is
   * at its center by half its height, or leave `[0,0,0]` for base-anchored models.
   * @default [0, 0, 0]
   */
  getTranslation?: [number, number, number];

  /**
   * Constant model length (meters) used when {@link lengthProperty} names no
   * column and {@link scaleToDimensions} is on.
   * @default 4
   */
  defaultLength?: number;

  /**
   * Constant model width (meters) used when {@link widthProperty} names no column.
   * @default 2
   */
  defaultWidth?: number;

  /**
   * Constant model height (meters) used when {@link heightProperty} names no
   * column.
   * @default 1.6
   */
  defaultHeight?: number;

  /**
   * Lighting material for the models — SimpleMeshLayer pass-through. `true` for
   * the default phong material, `false` to disable lighting, or a material spec.
   * @default true
   */
  material?: Material;

  /**
   * Draw the models in wireframe mode — SimpleMeshLayer pass-through.
   * @default false
   */
  wireframe?: boolean;

  /**
   * SimpleMeshLayer `_instanced` pass-through. `true` (default) instances one
   * shared mesh at every object; `false` treats mesh positions as lng/lat deltas
   * of a single anchor (rarely wanted here).
   * @default true
   */
  _instanced?: boolean;

  /**
   * Appear-fade duration (ms of playhead time) just after a track starts — a CPU
   * alpha ramp folded into `getColor`. `0` pops in. NOTE: when a {@link texture}
   * is set, deck's SimpleMeshLayer ignores `getColor`, so the fade has NO effect
   * (textured models pop in) and the layer warns once — use an untextured /
   * vertex-colored mesh for fades.
   * @default 200
   */
  fadeInDuration?: number;

  /**
   * Disappear-fade duration (ms of playhead time) just before a track ends — a
   * CPU alpha ramp folded into `getColor`. `0` pops out. NOTE: has no effect with
   * a {@link texture} set (see {@link fadeInDuration}).
   * @default 200
   */
  fadeOutDuration?: number;

  /**
   * Per-feature speed column NAME (m/s). Carried through to picking rows so the
   * AV inspector can read it; not otherwise rendered.
   * @default 'speed'
   */
  speedProperty?: string;

  /**
   * Categorical/numeric column NAME whose value is carried through to picking
   * rows / per-track grouping label.
   * @default 'category'
   */
  labelProperty?: string;
}

/** Complete props accepted by {@link AnimatedMeshLayer}. */
export type AnimatedMeshLayerProps = _AnimatedMeshLayerProps & SpatioTemporalLayerProps;

/** Flat decoded props attached to `info.object` on a pick (AV inspector shape). */
type PickRow = TrackPickRow;

/**
 * Animated mesh layer — ONE CPU-interpolated 3D model per tracked object. See
 * the file header for the pool-by-track + per-frame-interpolate model (shared
 * with {@link AnimatedBoundingBoxLayer} via the track kernel).
 *
 * Sublayer short id for `_subLayerProps` overrides / `getSubLayerClass`:
 * **`mesh`**.
 */
export class AnimatedMeshLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedMeshLayerProps>
> {
  static layerName = 'AnimatedMeshLayer';

  static defaultProps: DefaultProps<AnimatedMeshLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    // Permissive descriptors ({type:'object'}) hold a mesh source / map / Color /
    // column name / null — which deck's typed validators would reject.
    mesh: { type: 'object', value: null, optional: true, compare: true },
    meshMapping: { type: 'object', value: null, optional: true, compare: true },
    texture: { type: 'object', value: null, optional: true, compare: true },
    textureParameters: { type: 'object', value: null, optional: true, compare: true },
    trackIdProperty: 'track_id',
    colorProperty: { type: 'object', value: null, optional: true, compare: true },
    getColor: { type: 'object', value: null, optional: true, compare: true },
    colorMapping: { type: 'object', value: null, optional: true, compare: true },
    colorMappingDefault: { type: 'color', value: DEFAULT_COLOR },
    headingProperty: 'heading',
    orientationOffset: { type: 'object', value: [0, 0, 0], compare: true },
    lengthProperty: 'length',
    widthProperty: 'width',
    heightProperty: 'height',
    scaleToDimensions: true,
    sizeScale: { type: 'number', value: 1, min: 0 },
    getTranslation: { type: 'object', value: [0, 0, 0], compare: true },
    defaultLength: { type: 'number', value: 4, min: 0 },
    defaultWidth: { type: 'number', value: 2, min: 0 },
    defaultHeight: { type: 'number', value: 1.6, min: 0 },
    // Boolean or material spec — same permissive descriptor SimpleMeshLayer uses.
    material: { type: 'object', value: true, compare: true },
    wireframe: false,
    _instanced: true,
    fadeInDuration: { type: 'number', value: 200, min: 0 },
    fadeOutDuration: { type: 'number', value: 200, min: 0 },
    speedProperty: 'speed',
    labelProperty: 'category',
  };

  /** Pooled, track-grouped keyframe index. Rebuilt only when the tile set or a
   * feeding style prop changes; re-interpolated (not rebuilt) every frame. */
  private trackIndex: Map<string, Track> | null = null;
  private trackIndexKey = '';
  private lastTilesRef: Tile[] | null = null;
  /** Sim-time of the last mesh-pose re-interpolation; skips redundant ticks. */
  private lastMeshFrameTime = NaN;

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.trackIndex = null;
    this.lastTilesRef = null;
  }

  /**
   * Force a renderLayers() pass every advanced tick so the CPU-interpolated
   * model pose advances (mirrors AnimatedBoundingBoxLayer — the motion lives in
   * an instance buffer the base class would not otherwise recompute).
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    const { tiles } = this.state;
    if (tiles && tiles.length > 0 && time !== this.lastMeshFrameTime) {
      this.lastMeshFrameTime = time;
      this.setState({ meshFrame: ((this.state as any).meshFrame || 0) + 1 });
    }
  }

  /**
   * Resolve the color source (accessor-alias B1): a constant `getColor` Color
   * overrides `colorProperty` (single color for all); a string `getColor` is
   * treated as a column name; a function warns once and falls back. Returns the
   * effective `colorProperty` (column, '' when a constant is in force) and the
   * constant fallback color.
   */
  private resolveColorConfig(): { colorProperty: string; colorMappingDefault: Color } {
    let colorProperty =
      typeof this.props.colorProperty === 'string' ? this.props.colorProperty : '';
    let colorMappingDefault = (this.props.colorMappingDefault ?? DEFAULT_COLOR) as Color;

    const alias = resolveAccessorAlias<Color | string | null>(
      'AnimatedMeshLayer',
      'getColor',
      this.props.getColor,
      null,
    );
    if (typeof alias === 'string') {
      colorProperty = alias; // a column name
    } else if (Array.isArray(alias)) {
      // A constant color for every model — overrides per-category coloring.
      colorProperty = '';
      colorMappingDefault = alias as Color;
    }
    return { colorProperty, colorMappingDefault };
  }

  /**
   * Resolve which tile columns the shared track kernel reads, from this layer's
   * props (defaults applied here so the kernel receives a fully-resolved config).
   */
  private trackFieldConfig(): TrackFieldConfig {
    const { colorProperty, colorMappingDefault } = this.resolveColorConfig();
    return {
      trackIdProperty: this.props.trackIdProperty || 'track_id',
      colorProperty,
      labelProperty: this.props.labelProperty || 'category',
      headingProperty: this.props.headingProperty || 'heading',
      lengthProperty: this.props.lengthProperty || 'length',
      widthProperty: this.props.widthProperty || 'width',
      heightProperty: this.props.heightProperty || 'height',
      speedProperty: this.props.speedProperty || 'speed',
      colorMapping: this.props.colorMapping,
      colorMappingDefault,
    };
  }

  /**
   * Digest of the props that change the POOLED index content (which columns are
   * read, plus the baked per-track color). Geometric props / sizeScale re-apply
   * every frame, so they are NOT in this key.
   */
  private computeIndexKey(): string {
    const { colorProperty, colorMappingDefault } = this.resolveColorConfig();
    return [
      this.props.trackIdProperty,
      colorProperty,
      this.props.headingProperty,
      this.props.lengthProperty,
      this.props.widthProperty,
      this.props.heightProperty,
      this.props.speedProperty,
      this.props.labelProperty,
      Array.isArray(colorMappingDefault) ? colorMappingDefault.join(',') : '',
      colorProperty ? colorMappingDigest(this.props.colorMapping ?? {}) : 0,
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  /**
   * Pool every loaded tile's object snapshots into a `track_id`-keyed map via
   * the shared {@link kernelBuildTrackIndex}, plus this layer's telemetry +
   * missing-track-id warning.
   */
  private buildTrackIndex(tiles: Tile[]): Map<string, Track> {
    const t0 = performance.now();
    const cfg = this.trackFieldConfig();
    const result = kernelBuildTrackIndex(tiles, cfg);

    if (result.trackIdMissing) {
      warnOnce(
        'AnimatedMeshLayer:noTrackId',
        `[AnimatedMeshLayer] no \`${cfg.trackIdProperty}\` column — object ` +
          `snapshots cannot be grouped into tracks, so each is shown as a held ` +
          `model (${SINGLETON_HOLD_MS}ms) with no interpolation. Build the ` +
          `objects archive with a track-id column for smooth single-model rendering.`,
      );
    }

    emit('tilePrepare', {
      layer: 'AnimatedMeshLayer',
      tracks: result.tracks.size,
      snapshots: result.totalSnapshots,
      ms: performance.now() - t0,
    });
    return result.tracks;
  }

  /**
   * Interpolate one track's pose at absolute `now` via the shared
   * {@link kernelSampleTrack}, feeding this layer's geometric defaults + fades.
   */
  private sampleTrack(track: Track, now: number): Sample | null {
    return kernelSampleTrack(track, now, {
      defaultLength: this.props.defaultLength ?? 4,
      defaultWidth: this.props.defaultWidth ?? 2,
      defaultHeight: this.props.defaultHeight ?? 1.6,
      fadeInDuration: this.props.fadeInDuration ?? 0,
      fadeOutDuration: this.props.fadeOutDuration ?? 0,
    });
  }

  renderLayers(): Layer[] {
    const t0 = performance.now();
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) {
      this.trackIndex = null;
      this.lastTilesRef = null;
      return [];
    }

    const baseMesh = (this.props.mesh ?? null) as MeshSource;
    const meshMapping = this.props.meshMapping ?? null;
    if (!baseMesh && !meshMapping) {
      warnOnce(
        'AnimatedMeshLayer:noMesh',
        '[AnimatedMeshLayer] no `mesh` (and no `meshMapping`) — nothing to ' +
          'render. Provide a glTF/OBJ model via the `mesh` prop (a static ' +
          'per-layer prop, like IconLayer\'s iconAtlas).',
      );
      return [];
    }

    // Finding: a `texture` makes deck's SimpleMeshLayer ignore getColor entirely
    // (texture wins), so the per-instance appear/disappear fade folded into
    // getColor's alpha has NO effect — textured models pop in/out regardless of
    // fadeInDuration/fadeOutDuration. Warn once instead of silently dropping it.
    if (
      this.props.texture &&
      ((this.props.fadeInDuration ?? 0) > 0 || (this.props.fadeOutDuration ?? 0) > 0)
    ) {
      warnOnce(
        'AnimatedMeshLayer:textureFade',
        '[AnimatedMeshLayer] `texture` is set, so SimpleMeshLayer ignores ' +
          '`getColor` — the per-instance fadeInDuration/fadeOutDuration alpha has ' +
          'no effect and textured models pop in/out. Use an untextured / ' +
          'vertex-colored mesh (fade rides getColor) for appear/disappear fades.',
      );
    }

    // Rebuild the pooled index only when the visible tile SET changes or a
    // feeding style prop changes; otherwise re-interpolate the cached index.
    const indexKey = this.computeIndexKey();
    if (this.lastTilesRef !== tiles || this.trackIndexKey !== indexKey || !this.trackIndex) {
      this.trackIndex = this.buildTrackIndex(tiles);
      this.trackIndexKey = indexKey;
      this.lastTilesRef = tiles;
    }

    const now = this.getCurrentTime();
    const samples: Sample[] = [];
    for (const track of this.trackIndex.values()) {
      const s = this.sampleTrack(track, now);
      if (s) samples.push(s);
    }
    if (samples.length === 0) {
      emit('renderLayers', { layer: 'AnimatedMeshLayer', tiles: tiles.length, sublayers: 0, ms: performance.now() - t0 });
      return [];
    }

    let layers: Layer[];
    if (meshMapping) {
      // Per-category models: group active samples by category and emit one
      // SimpleMeshLayer per category (mesh is a per-layer prop, so distinct
      // models need distinct sublayers), each falling back to `mesh`.
      const groups = new Map<string, Sample[]>();
      // Seed a group for EVERY mapped category up front so its sublayer — and its
      // uploaded GPU Model — persists across frames even when that category
      // momentarily has zero active tracks. Otherwise the sublayer is unmounted
      // and remounted as the category comes and goes, re-uploading (and, for a
      // URL mesh, re-async-resolving) the Model each reappearance → pop-in.
      for (const cat of Object.keys(meshMapping)) groups.set(cat, []);
      for (const s of samples) {
        const cat = s.track.category;
        let g = groups.get(cat);
        if (!g) {
          g = [];
          groups.set(cat, g);
        }
        g.push(s);
      }
      layers = [];
      for (const [cat, group] of groups) {
        const mesh = meshMapping[cat] ?? baseMesh;
        if (!mesh) continue; // no model for this category and no fallback
        layers.push(this.buildMeshSublayer(group, mesh, `cat-${cat || '∅'}`));
      }
    } else {
      layers = [this.buildMeshSublayer(samples, baseMesh, 'all')];
    }

    emit('renderLayers', {
      layer: 'AnimatedMeshLayer',
      tiles: tiles.length,
      tracks: this.trackIndex.size,
      active: samples.length,
      sublayers: layers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedMeshLayer: ${this.trackIndex.size} tracks → ${samples.length} active models`,
      );
    }
    return layers;
  }

  /** Build one SimpleMeshLayer over `samples`, instancing `mesh` at each pose. */
  private buildMeshSublayer(samples: Sample[], mesh: MeshSource, instanceKey: string): SimpleMeshLayer {
    const n = samples.length;
    const scaleDims = this.props.scaleToDimensions ?? true;
    const offset = this.props.orientationOffset ?? [0, 0, 0];
    const pitchOff = offset[0] ?? 0;
    const yawOff = offset[1] ?? 0;
    const rollOff = offset[2] ?? 0;

    const positions = new Float64Array(n * 3);
    const orientations = new Float32Array(n * 3);
    const scales = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 4);
    const pickRows: PickRow[] = new Array(n);

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const o3 = i * 3;
      positions[o3] = s.lon;
      positions[o3 + 1] = s.lat;
      positions[o3 + 2] = s.alt;
      // deck SimpleMeshLayer orientation is [pitch, yaw, roll] (deg). Heading is
      // a yaw about the vertical z-axis → slot 1, plus the constant offset. NaN
      // heading ⇒ the offset alone (axis-aligned base pose).
      orientations[o3] = pitchOff;
      orientations[o3 + 1] = (Number.isFinite(s.heading) ? s.heading * RAD_TO_DEG : 0) + yawOff;
      orientations[o3 + 2] = rollOff;
      if (scaleDims) {
        scales[o3] = s.length;
        scales[o3 + 1] = s.width;
        scales[o3 + 2] = s.height;
      } else {
        scales[o3] = 1;
        scales[o3 + 1] = 1;
        scales[o3 + 2] = 1;
      }
      const o4 = i * 4;
      const c = s.track.color;
      colors[o4] = c[0];
      colors[o4 + 1] = c[1];
      colors[o4 + 2] = c[2];
      colors[o4 + 3] = Math.round((c[3] ?? 255) * s.alpha);
      pickRows[i] = makePickRow(s);
    }

    // getPosition + getColor bind straight from binary data.attributes (deck's
    // SimpleMeshLayer registers them as single-string accessors). getOrientation
    // and getScale CANNOT: deck folds orientation/scale/translation into ONE
    // computed `instanceModelMatrix` attribute whose accessor is an ARRAY, so a
    // per-instance binary `data.attributes.getOrientation`/`getScale` is silently
    // ignored (the matrix updater reads `props.getOrientation`/`getScale` only).
    // Supply them as function accessors that index the per-instance buffers so
    // the interpolated heading + dims actually reach the GPU (else every model
    // renders at identity orientation / unit scale).
    const data = {
      length: n,
      attributes: {
        getPosition: { value: positions, size: 3 },
        getColor: { value: colors, size: 4, normalized: true },
      },
    };
    const getOrientation = (_: unknown, info: { index: number }): [number, number, number] => {
      const o = info.index * 3;
      return [orientations[o], orientations[o + 1], orientations[o + 2]];
    };
    const getScale = (_: unknown, info: { index: number }): [number, number, number] => {
      const o = info.index * 3;
      return [scales[o], scales[o + 1], scales[o + 2]];
    };

    const extensions = this.composeExtensions([]);
    const props = this.composeSubLayerProps('mesh', instanceKey, {
      data: data as any,
      mesh,
      // Per-instance pose accessors (see the note above) — read the interpolated
      // orientation/scale buffers by instance index.
      getOrientation,
      getScale,
      // texture / textureParameters ride through only when set (SimpleMeshLayer
      // defaults are undefined; passing null is harmless but keep it explicit).
      texture: this.props.texture ?? undefined,
      textureParameters: this.props.textureParameters ?? undefined,
      sizeScale: this.props.sizeScale,
      // Constant anchor offset (same for every instance) — a plain accessor.
      getTranslation: this.props.getTranslation ?? [0, 0, 0],
      material: this.props.material,
      wireframe: this.props.wireframe,
      _instanced: this.props._instanced,
      extensions,
      pickable: true,
      // One row per instance (stride 1) for getPickingInfo.
      sttPickRows: pickRows,
      sttPickStride: 1,
    });
    const SubLayerClass = this.getSubLayerClass('mesh', SimpleMeshLayer);
    return new SubLayerClass(props as any);
  }

  /**
   * Picking enrichment: a hit's `info.index` maps into the source sublayer's
   * per-instance active-track rows (stride 1); `info.object` becomes that track's
   * flat decoded props — the AV cockpit's click-to-inspect shape.
   */
  getPickingInfo({ info, sourceLayer }: GetPickingInfoParams): SpatioTemporalPickingInfo {
    const out = info as SpatioTemporalPickingInfo;
    const sp = sourceLayer?.props as
      | { sttPickRows?: PickRow[]; sttPickStride?: number }
      | undefined;
    const rows = sp?.sttPickRows;
    if (info.index >= 0 && rows) {
      const idx = Math.floor(info.index / (sp?.sttPickStride || 1));
      if (rows[idx]) out.object = rows[idx];
    }
    return out;
  }
}
