// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * AnimatedBoundingBoxLayer — a single smooth-moving ORIENTED 3D box per tracked
 * object (streetscape.gl / avs.auto tracked-object look). The tile archive
 * carries one POINT feature per object PER KEYFRAME (a snapshot: `track_id`,
 * `category`, `heading`, `length`/`width`/`height`, `speed`, timestamped). This
 * layer collapses each track's keyframe stream into exactly ONE box at the
 * playhead, its pose CPU-INTERPOLATED between the two keyframes bracketing the
 * current time — so a car/pedestrian glides instead of leaving a "train" of one
 * box per keyframe behind it.
 *
 * ── WHY CPU-PER-FRAME (not GPU window filtering) ─────────────────────────────
 * The sibling animated layers filter features against a time WINDOW on the GPU
 * (show everything whose `[start,end]` overlaps `[t±window/2]`). For instantaneous
 * snapshots that produces N boxes per object whenever the window spans N
 * keyframes — the bug this layer was rewritten to kill. Instead we mirror
 * {@link AnimatedTripHeadsLayer}: pool the snapshots of all loaded tiles, group
 * them by `track_id`, and once per frame emit one interpolated instance per
 * ACTIVE track (a track is active while the playhead lies within its keyframe
 * span). Visibility is implicit — inactive tracks simply aren't emitted — so
 * there is no time-filter extension and no window/trail uniform at all.
 *
 * Cross-tile pooling: a track's keyframes are spread across temporal-bucket
 * tiles (a 1 s bucket at 2 Hz holds ~2 of them), so the two keyframes bracketing
 * the playhead can live in adjacent tiles. Times are rebased to ABSOLUTE epoch-ms
 * (`startTime + tile.timeOffset`) during pooling so snapshots from tiles with
 * different `timeOffset`s sort into one timeline; interpolation then runs in
 * plain f64 JS (no Float32 relative-time contract to honour). The pooled,
 * track-grouped index is rebuilt only when the visible tile SET changes (or a
 * style prop that feeds it changes); each frame just re-interpolates it.
 *
 * Cost: AV scenes carry tens of active objects and a few thousand snapshots per
 * scene, so the per-frame work is a binary-search + lerp per active track —
 * well under a millisecond. Like {@link AnimatedTripHeadsLayer} (and
 * FlowCorridorLayer) we override `_handleTimeUpdate` to force a renderLayers()
 * pass each tick, because the motion lives in a CPU-computed instance buffer the
 * base class would otherwise never recompute (its siblings animate via a shader
 * uniform). The tile-loading window (`timeWindow`) is UNTOUCHED — it still gates
 * which buckets are resident, and only needs to cover ±one keyframe gap.
 *
 * ── RENDERING: ORIENTED BOXES — FILL and/or OUTLINE (av-cockpit.md §3c) ───────
 * Two interchangeable looks, selected by `filled` / `stroked`:
 *   • FILLED (`filled`, default) — one `SimpleMeshLayer` (`@deck.gl/mesh-layers`)
 *     instanced over a unit `CubeGeometry` (`@luma.gl/engine`); the solid,
 *     phong-lit box (detailed below).
 *   • STROKED (`stroked`) — one `LineLayer` of each box's 12 true edges (see
 *     {@link AnimatedBoundingBoxLayer.buildEdges}); the streetscape.gl / nuScenes
 *     detection-box outline you can see the LIDAR through. Combine with
 *     `filled:false` for outline-only. The edge corners are computed from the
 *     same interpolated pose (yaw + dims + ground-lift), so both looks agree.
 *
 * The FILLED box's per-instance pose is rebuilt each frame from the interpolated
 * samples:
 *   • getPosition    → the interpolated point (size-3, lon/lat/alt).
 *   • getOrientation → [0, heading°, 0] — deck.gl SimpleMeshLayer orientation is
 *                      [pitch, yaw, roll], so heading (a yaw about the vertical z
 *                      axis) rides slot 1; the interpolated `heading` is radians
 *                      (0 = +x/east, CCW), ANGLE-interpolated (shortest arc) then
 *                      converted to deg. (Slot 2 is ROLL — about the length axis —
 *                      so putting heading there would tip the box on its side.)
 *   • getScale       → [length, width, height] × 0.5 × sizeScale. CubeGeometry
 *                      spans ±1, so the ×0.5 makes one scale unit == one meter.
 *   • getTranslation → [0, 0, height/2 × sizeScale] so the box base rests on the
 *                      ground (matches streetscape.gl boxes sitting on the road).
 *   • getColor       → per-instance RGBA from `category` via `colorMapping`,
 *                      multiplied by a CPU appear/disappear fade (fadeInDuration
 *                      /fadeOutDuration). Fed pre-lighting so SimpleMeshLayer's
 *                      phong shading still reads the box as a 3D volume (the GPU
 *                      CategoryColorExtension writes AFTER lighting and would
 *                      flatten it — av-cockpit.md §3c).
 *   • wireframe / material  → SimpleMeshLayer pass-through.
 *
 * ── OPTIONAL streetscape.gl SUBLAYERS (off by default) ───────────────────────
 * Two extra single-instance sublayers ride alongside the boxes, each built from
 * the SAME active-track set so they appear/vanish exactly with their object:
 *   • `showLabels`   → a `TextLayer` (sublayer id `labels`) of each active
 *     object's `labelProperty` value (default `'category'`), billboarded above
 *     the box.
 *   • `showVelocity` → a `LineLayer` (sublayer id `velocity`) of a per-object
 *     velocity arrow from the interpolated `speed` + `heading`: vx =
 *     speed·cos(heading), vy = speed·sin(heading), scaled by `velocityScale` and
 *     converted to a lon/lat delta. Objects below `velocityMinSpeed` collapse to
 *     a zero-length (invisible) segment.
 *
 * Picking: the boxes sublayer is the inspectable one. A hit's `info.index` maps
 * into the frame's active-track array; {@link getPickingInfo} sets `info.object`
 * to that track's flat decoded props (`category`/`track_id`/`heading`/dims/
 * `speed`) — what the AV cockpit's click-to-inspect handler reads.
 */

import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { TextLayer, LineLayer } from '@deck.gl/layers';
import { CubeGeometry } from '@luma.gl/engine';
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
  METERS_PER_DEG_LAT,
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

/**
 * Unit cube geometry shared by every box instance (one upload per device). It
 * spans [-1, +1] on each axis (2 units across), so `getScale` carries a ×0.5
 * factor to make one scale unit == one meter of box dimension.
 */
const UNIT_CUBE = new CubeGeometry();

/** Props added by {@link AnimatedBoundingBoxLayer} (own props only — compose
 * with {@link SpatioTemporalLayerProps} via {@link AnimatedBoundingBoxLayerProps}). */
export interface _AnimatedBoundingBoxLayerProps {
  /**
   * Per-feature track-identity column NAME used to group an object's keyframe
   * snapshots into one interpolated box. Reads a categorical (string) column.
   * When the column is absent each snapshot becomes its own (un-interpolated)
   * box, held for {@link SINGLETON_HOLD_MS} — a degraded fallback the real AV
   * archives never hit (they always carry `track_id`).
   * @default 'track_id'
   */
  trackIdProperty?: string;

  /**
   * Categorical property column NAME that drives each box's color (e.g.
   * `'category'`). Resolved on the CPU through {@link colorMapping} into a
   * per-instance RGBA `getColor` attribute. When unset, boxes use the constant
   * {@link colorMappingDefault}.
   */
  colorProperty?: string | null;

  /**
   * Category → color map. Keyed by the raw category string value (as it appears
   * in the categorical column). Categories absent from the map fall back to
   * {@link colorMappingDefault}.
   */
  colorMapping?: Record<string, Color> | null;

  /**
   * Color for categories not present in {@link colorMapping} (and the constant
   * color when {@link colorProperty} is unset).
   * @default [160, 160, 160, 255]
   */
  colorMappingDefault?: Color;

  /**
   * Per-feature yaw column NAME (radians, world frame, 0 = +x/east, CCW
   * positive — av-cockpit.md §2c). Drives `getOrientation: [0, heading°, 0]`
   * (yaw about the vertical z-axis — slot 1 of deck's [pitch, yaw, roll]),
   * angle-interpolated between keyframes. When the column is absent, boxes are
   * axis-aligned.
   * @default 'heading'
   */
  headingProperty?: string;

  /**
   * Per-feature box-length column NAME (meters, vehicle +x / heading axis).
   * Drives the box's x-scale. When absent, {@link defaultLength} is used.
   * @default 'length'
   */
  lengthProperty?: string;

  /**
   * Per-feature box-width column NAME (meters). Drives the box's y-scale. When
   * absent, {@link defaultWidth} is used.
   * @default 'width'
   */
  widthProperty?: string;

  /**
   * Per-feature box-height column NAME (meters). Drives the box's z-scale. When
   * absent, {@link defaultHeight} is used.
   * @default 'height'
   */
  heightProperty?: string;

  /**
   * Uniform multiplier applied to every box dimension (length/width/height).
   * @default 1
   */
  sizeScale?: number;

  /**
   * Constant box length (meters) used when {@link lengthProperty} names no
   * column on the tile.
   * @default 4
   */
  defaultLength?: number;

  /**
   * Constant box width (meters) used when {@link widthProperty} names no column.
   * @default 2
   */
  defaultWidth?: number;

  /**
   * Constant box height (meters) used when {@link heightProperty} names no
   * column on the tile.
   * @default 1.6
   */
  defaultHeight?: number;

  /**
   * Render the solid (filled, phong-lit) box faces via the `boxes`
   * `SimpleMeshLayer`. Set `false` together with {@link stroked} for the AV
   * detection-box look: an outline-only box you can see the LIDAR through. When
   * BOTH `filled` and `stroked` are false the layer falls back to filled so it
   * never renders nothing.
   * @default true
   */
  filled?: boolean;

  /**
   * Draw each box as a crisp 12-EDGE CUBOID OUTLINE (the `edges` `LineLayer`) —
   * the streetscape.gl / nuScenes-devkit detection-box look. Unlike
   * {@link wireframe} (a SimpleMeshLayer pass-through that draws the triangle
   * mesh edges, so every face gets a diagonal), this draws ONLY the 12 true box
   * edges. Edges inherit each box's per-category color (with the same
   * appear/disappear fade as the fill). Combine with `filled:false` for an
   * outline-only box.
   * @default false
   */
  stroked?: boolean;

  /**
   * On-screen width (pixels) of the {@link stroked} box edges.
   * @default 1.5
   */
  strokeWidth?: number;

  /**
   * Minimum on-screen width (pixels) of the {@link stroked} box edges, so they
   * stay visible when the box is far away.
   * @default 1
   */
  strokeWidthMinPixels?: number;

  /**
   * Distinct constant RGBA color for the {@link stroked} 12-edge outline
   * (forwarded to the `edges` LineLayer's `getColor`). When `null` (the default)
   * each edge INHERITS its box's per-category fill color × the appear/disappear
   * fade, so the outline tracks the fill. Set a constant color (e.g. a bright
   * cyan) for the classic detection-box look — a crisp bright outline over a
   * dimmer fill. The appear/disappear fade still rides this color's alpha.
   * (deck LineLayer `getColor` default is `[0, 0, 0, 255]`; here `null`
   * preserves STT's inherited-fill behavior instead.)
   * @default null
   */
  strokeColor?: Color | null;

  /**
   * Upstream-vocabulary alias of {@link strokeColor} (constant Color only — same
   * domain as the legacy prop; a function accessor warns once and falls back to
   * `strokeColor`). When set, it wins over `strokeColor`. A property-column NAME
   * is not supported for the outline color (the outline inherits the per-category
   * fill by default); pass a constant for a distinct outline.
   */
  getLineColor?: ColorAccessorValue | null;

  /**
   * Units for the {@link stroked} box-edge width — forwarded to the `edges`
   * LineLayer's `widthUnits`. `'pixels'` (the default, matching deck's LineLayer)
   * keeps the outline a constant on-screen thickness; `'meters'`/`'common'` make
   * it scale with zoom.
   * @default 'pixels'
   */
  strokeWidthUnits?: 'pixels' | 'meters' | 'common';

  /**
   * Maximum on-screen width (pixels) of the {@link stroked} box edges — an upper
   * clamp forwarded to the `edges` LineLayer's `widthMaxPixels`, so a
   * meters/common-unit outline doesn't blow up to a thick slab when zoomed in.
   * Defaults to no clamp (deck LineLayer's `Number.MAX_SAFE_INTEGER`).
   * @default Number.MAX_SAFE_INTEGER
   */
  strokeWidthMaxPixels?: number;

  /**
   * Draw a line wireframe around each box instead of filled faces —
   * SimpleMeshLayer pass-through. NOTE: this is the mesh's *triangle* wireframe
   * (diagonals on every face); for a clean detection-box outline use
   * {@link stroked} instead.
   * @default false
   */
  wireframe?: boolean;

  /**
   * Lighting material for the boxes — SimpleMeshLayer pass-through. `true` for
   * the default phong material (gives the 3D box read), `false` to disable
   * lighting, or a material spec.
   * @default true
   */
  material?: Material;

  /**
   * Appear-fade duration (ms of playhead time) for a box just after its track
   * starts — a CPU alpha ramp folded into `getColor`. `0` pops in.
   * @default 200
   */
  fadeInDuration?: number;

  /**
   * Disappear-fade duration (ms of playhead time) for a box just before its
   * track ends — a CPU alpha ramp folded into `getColor`. `0` pops out.
   * @default 200
   */
  fadeOutDuration?: number;

  /**
   * Draw a per-object `TextLayer` label (sublayer id `labels`) above each active
   * box, billboarded. The label text is read from {@link labelProperty}.
   * @default false
   */
  showLabels?: boolean;

  /**
   * Property column NAME whose per-feature value is drawn as each object's
   * label when {@link showLabels} is on. Reads a categorical (string) column the
   * same way box color reads `category`; a numeric column is stringified.
   * @default 'category'
   */
  labelProperty?: string;

  /**
   * Draw a per-object velocity arrow `LineLayer` (sublayer id `velocity`) from
   * each box along its interpolated heading, length ∝ speed. Objects below
   * {@link velocityMinSpeed} are hidden.
   * @default false
   */
  showVelocity?: boolean;

  /**
   * Per-feature speed column NAME (meters/second) driving the velocity-arrow
   * length when {@link showVelocity} is on. Direction comes from
   * {@link headingProperty}. When the column is absent no arrows are drawn.
   * @default 'speed'
   */
  speedProperty?: string;

  /**
   * Velocity-arrow length scale: WORLD-SPACE meters of arrow per (meter/second)
   * of speed. The default (1.5) shows roughly ~1.5 s of travel, so a 10 m/s
   * object draws a ~15 m arrow.
   * @default 1.5
   */
  velocityScale?: number;

  /**
   * Objects with speed below this (meters/second) draw no velocity arrow (the
   * segment collapses to zero length). Filters parked/jittering objects.
   * @default 0.3
   */
  velocityMinSpeed?: number;

  /**
   * Velocity-arrow color (RGBA) — a bright accent so arrows read over the boxes.
   * @default [80, 255, 220, 255]
   */
  velocityColor?: Color;

  /**
   * Minimum on-screen width of the velocity arrows, in pixels.
   * @default 2
   */
  velocityWidthMinPixels?: number;
}

/** Complete props accepted by {@link AnimatedBoundingBoxLayer}. */
export type AnimatedBoundingBoxLayerProps = _AnimatedBoundingBoxLayerProps &
  SpatioTemporalLayerProps;

const DEFAULT_COLOR: Color = [160, 160, 160, 255];

/** Bright accent for the velocity arrows (reads over the lit boxes). */
const DEFAULT_VELOCITY_COLOR: Color = [80, 255, 220, 255];

/**
 * Flat decoded props attached to `info.object` on a pick (AV inspector shape).
 * Alias of the kernel's shared row shape so this file's existing references
 * keep working.
 */
type PickRow = TrackPickRow;

/** One label row for the optional TextLayer (rebuilt per frame from samples). */
interface LabelRow {
  position: [number, number, number];
  text: string;
}

/**
 * Animated bounding-box layer — ONE CPU-interpolated oriented 3D box per tracked
 * object (the streetscape.gl tracked-object primitive). See the file header for
 * the pool-by-track + per-frame-interpolate model.
 *
 * Sublayer short ids for `_subLayerProps` overrides: **`boxes`** (filled mesh)
 * and/or **`edges`** (the 12-edge outline LineLayer when `stroked`), plus (when
 * enabled) **`labels`** (TextLayer) + **`velocity`** (LineLayer).
 */
export class AnimatedBoundingBoxLayer<
  ExtraPropsT extends {} = {},
> extends SpatioTemporalLayer<
  ExtraPropsT & Required<_AnimatedBoundingBoxLayerProps>
> {
  static layerName = 'AnimatedBoundingBoxLayer';

  static defaultProps: DefaultProps<AnimatedBoundingBoxLayerProps> = {
    ...SpatioTemporalLayer.defaultProps,
    // Plain-string defaults (deck's DefaultProps typing has no 'string'
    // descriptor; a bare value IS the default).
    trackIdProperty: 'track_id',
    // Permissive descriptors ({type:'object'}) — these legally hold a column
    // name / a map / a Color, which deck's 'string'/'color' validators reject.
    colorProperty: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    colorMapping: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    colorMappingDefault: { type: 'color', value: DEFAULT_COLOR },
    headingProperty: 'heading',
    lengthProperty: 'length',
    widthProperty: 'width',
    heightProperty: 'height',
    sizeScale: { type: 'number', value: 1, min: 0 },
    defaultLength: { type: 'number', value: 4, min: 0 },
    defaultWidth: { type: 'number', value: 2, min: 0 },
    defaultHeight: { type: 'number', value: 1.6, min: 0 },
    filled: true,
    stroked: false,
    strokeWidth: { type: 'number', value: 1.5, min: 0 },
    strokeWidthMinPixels: { type: 'number', value: 1, min: 0 },
    // Outline color: null = inherit each box's per-category fill × fade (the
    // pre-existing behavior); a constant Color makes a distinct detection-box
    // outline. Permissive descriptor — legally holds null OR a Color (which the
    // 'color' validator would reject for null).
    strokeColor: { type: 'object', value: null, optional: true, compare: true },
    // Accessor-named alias of strokeColor — unset by default so the legacy prop
    // wins unless the caller opts into the upstream vocabulary.
    getLineColor: {
      type: 'object',
      value: null,
      optional: true,
      compare: true,
    },
    strokeWidthUnits: 'pixels',
    strokeWidthMaxPixels: {
      type: 'number',
      value: Number.MAX_SAFE_INTEGER,
      min: 0,
    },
    wireframe: false,
    // Boolean or material spec — same permissive descriptor SimpleMeshLayer uses.
    material: { type: 'object', value: true, compare: true },
    fadeInDuration: { type: 'number', value: 200, min: 0 },
    fadeOutDuration: { type: 'number', value: 200, min: 0 },
    // Optional streetscape.gl sublayers — OFF by default.
    showLabels: false,
    labelProperty: 'category',
    showVelocity: false,
    speedProperty: 'speed',
    velocityScale: { type: 'number', value: 1.5, min: 0 },
    velocityMinSpeed: { type: 'number', value: 0.3, min: 0 },
    velocityColor: { type: 'color', value: DEFAULT_VELOCITY_COLOR },
    velocityWidthMinPixels: { type: 'number', value: 2, min: 0 },
  };

  /** Pooled, track-grouped keyframe index. Rebuilt only when the tile set or a
   * feeding style prop changes; re-interpolated (not rebuilt) every frame. */
  private trackIndex: Map<string, Track> | null = null;
  private trackIndexKey = '';
  private lastTilesRef: Tile[] | null = null;
  /** True when at least one loaded tile carried the speed column (gates arrows). */
  private hasSpeedColumn = false;
  /** Sim-time of the last box-pose re-interpolation; skips redundant ticks. */
  private lastBoxFrameTime = NaN;

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.trackIndex = null;
    this.lastTilesRef = null;
  }

  /**
   * Force a renderLayers() pass every frame so the CPU-interpolated box pose
   * advances. The base class is redraw-only on time (its siblings animate via a
   * shader uniform); ours animates via instance buffers that only renderLayers()
   * recomputes — so mirror {@link AnimatedTripHeadsLayer} and bump a state
   * counter. `super()` keeps `_currentTime` live and the tileset throttle intact.
   */
  protected _handleTimeUpdate(time: number): void {
    super._handleTimeUpdate(time);
    const { tiles } = this.state;
    // Re-interpolate the box poses only when sim-time actually advanced. A
    // repeated/identical tick (paused-but-emitting clock, duplicate governor
    // tick) would otherwise force a full renderLayers + instance-buffer reupload
    // over every track for no visible change.
    if (tiles && tiles.length > 0 && time !== this.lastBoxFrameTime) {
      this.lastBoxFrameTime = time;
      this.setState({ boxFrame: ((this.state as any).boxFrame || 0) + 1 });
    }
  }

  /**
   * Digest of the props that change the POOLED index content (which columns are
   * read, plus the baked per-track color). Geometric defaults / sizeScale are
   * applied at interpolation time, so they are NOT in this key (they re-apply
   * every frame anyway).
   */
  private computeIndexKey(): string {
    const colorProp =
      typeof this.props.colorProperty === 'string'
        ? this.props.colorProperty
        : '';
    return [
      this.props.trackIdProperty,
      colorProp,
      this.props.headingProperty,
      this.props.lengthProperty,
      this.props.widthProperty,
      this.props.heightProperty,
      this.props.speedProperty,
      this.props.labelProperty,
      Array.isArray(this.props.colorMappingDefault)
        ? this.props.colorMappingDefault.join(',')
        : '',
      colorProp ? colorMappingDigest(this.props.colorMapping ?? {}) : 0,
      updateTriggersDigest(this.props.updateTriggers),
    ].join('|');
  }

  /**
   * Resolve the {@link stroked} outline color (accessor-alias B1): the
   * `getLineColor` upstream alias wins when set, else the `strokeColor` legacy
   * prop; a function-valued alias warns once and falls back. `null` (both unset)
   * means "inherit each box's per-category fill × fade" — applied in
   * {@link buildEdges}, so it is NOT part of {@link computeIndexKey} (the edges
   * are rebuilt every frame from the samples, not cached).
   */
  private strokeColorValue(): Color | string | null {
    return resolveAccessorAlias<Color | string | null>(
      'AnimatedBoundingBoxLayer',
      'getLineColor',
      this.props.getLineColor,
      this.props.strokeColor ?? null,
    );
  }

  /**
   * Resolve which tile columns the shared track kernel reads, from this layer's
   * props (defaults applied here so the kernel receives a fully-resolved config).
   */
  private trackFieldConfig(): TrackFieldConfig {
    return {
      trackIdProperty: this.props.trackIdProperty || 'track_id',
      colorProperty:
        typeof this.props.colorProperty === 'string'
          ? this.props.colorProperty
          : '',
      labelProperty: this.props.labelProperty || 'category',
      headingProperty: this.props.headingProperty || 'heading',
      lengthProperty: this.props.lengthProperty || 'length',
      widthProperty: this.props.widthProperty || 'width',
      heightProperty: this.props.heightProperty || 'height',
      speedProperty: this.props.speedProperty || 'speed',
      colorMapping: this.props.colorMapping,
      colorMappingDefault: (this.props.colorMappingDefault ??
        DEFAULT_COLOR) as Color,
    };
  }

  /**
   * Pool every loaded tile's object snapshots into a `track_id`-keyed map via
   * the shared {@link kernelBuildTrackIndex}, then layer on this layer's own
   * telemetry + missing-track-id warning. Runs only when the tile set or a
   * feeding prop changes.
   */
  private buildTrackIndex(tiles: Tile[]): Map<string, Track> {
    const t0 = performance.now();
    const cfg = this.trackFieldConfig();
    const result = kernelBuildTrackIndex(tiles, cfg);

    if (result.trackIdMissing) {
      warnOnce(
        'AnimatedBoundingBoxLayer:noTrackId',
        `[AnimatedBoundingBoxLayer] no \`${cfg.trackIdProperty}\` column — object ` +
          `snapshots cannot be grouped into tracks, so each is shown as a held box ` +
          `(${SINGLETON_HOLD_MS}ms) with no interpolation. Build the objects ` +
          `archive with a track-id column for smooth single-box rendering.`,
      );
    }

    this.hasSpeedColumn = result.hasSpeedColumn;
    emit('tilePrepare', {
      layer: 'AnimatedBoundingBoxLayer',
      tracks: result.tracks.size,
      snapshots: result.totalSnapshots,
      ms: performance.now() - t0,
    });
    return result.tracks;
  }

  /**
   * Interpolate one track's box pose at absolute `now` via the shared
   * {@link kernelSampleTrack}, feeding it this layer's geometric defaults + fade
   * durations. Returns null when the track is inactive.
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

    // Rebuild the pooled index only when the visible tile SET changes or a
    // feeding style prop changes; otherwise re-interpolate the cached index.
    const indexKey = this.computeIndexKey();
    if (
      this.lastTilesRef !== tiles ||
      this.trackIndexKey !== indexKey ||
      !this.trackIndex
    ) {
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
      emit('renderLayers', {
        layer: 'AnimatedBoundingBoxLayer',
        tiles: tiles.length,
        sublayers: 0,
        ms: performance.now() - t0,
      });
      return [];
    }

    // Fill / outline selection. `filled` draws the solid SimpleMeshLayer;
    // `stroked` adds the crisp 12-edge LineLayer outline. If neither is asked
    // for, fall back to filled so the layer never renders nothing. Exactly one
    // of the two carries picking (prefer the fill when present — a solid box is
    // far easier to click than a thin edge).
    const wantStroke = this.props.stroked ?? false;
    const drawFill = (this.props.filled ?? true) || !wantStroke;
    const layers: Layer[] = [];
    if (drawFill) layers.push(this.buildBoxes(samples, true));
    if (wantStroke) layers.push(this.buildEdges(samples, !drawFill));
    if (this.props.showLabels) layers.push(this.buildLabels(samples));
    if (this.props.showVelocity && this.hasSpeedColumn)
      layers.push(this.buildVelocity(samples));

    emit('renderLayers', {
      layer: 'AnimatedBoundingBoxLayer',
      tiles: tiles.length,
      tracks: this.trackIndex.size,
      active: samples.length,
      sublayers: layers.length,
      ms: performance.now() - t0,
    });
    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(
        `AnimatedBoundingBoxLayer: ${this.trackIndex.size} tracks → ${samples.length} active boxes`,
      );
    }
    return layers;
  }

  /** Build the single oriented-box SimpleMeshLayer over the active samples. */
  private buildBoxes(samples: Sample[], pickable: boolean): SimpleMeshLayer {
    const n = samples.length;
    const sizeScale = this.props.sizeScale ?? 1;
    const half = 0.5 * sizeScale;

    const positions = new Float64Array(n * 3);
    const orientations = new Float32Array(n * 3);
    const scales = new Float32Array(n * 3);
    const translations = new Float32Array(n * 3);
    const colors = new Uint8Array(n * 4);
    const pickRows: PickRow[] = new Array(n);

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const o3 = i * 3;
      positions[o3] = s.lon;
      positions[o3 + 1] = s.lat;
      positions[o3 + 2] = s.alt;
      // deck.gl SimpleMeshLayer orientation is [pitch, yaw, roll] (deg). Heading
      // is a YAW about the vertical (z) axis, so it goes in slot 1 — NOT slot 2
      // (roll), which rotates about the box's length/x axis and would tip the box
      // onto its side while its length stayed pinned east. Matches egoLayers.ts's
      // ego car. NaN heading ⇒ axis-aligned.
      orientations[o3 + 1] = Number.isFinite(s.heading)
        ? s.heading * RAD_TO_DEG
        : 0;
      scales[o3] = s.length * half;
      scales[o3 + 1] = s.width * half;
      scales[o3 + 2] = s.height * half;
      // Lift the box center to half its height so its base sits on the ground.
      translations[o3 + 2] = s.height * 0.5 * sizeScale;
      const o4 = i * 4;
      const c = s.track.color;
      colors[o4] = c[0];
      colors[o4 + 1] = c[1];
      colors[o4 + 2] = c[2];
      colors[o4 + 3] = Math.round((c[3] ?? 255) * s.alpha);
      pickRows[i] = makePickRow(s);
    }

    // getPosition + getColor bind straight from binary data.attributes. But
    // getOrientation/getScale/getTranslation CANNOT be fed as binary attributes:
    // deck's SimpleMeshLayer folds all three into ONE computed
    // `instanceModelMatrix` attribute whose accessor is an ARRAY, built ONLY from
    // the `props.getOrientation`/`getScale`/`getTranslation` — a per-instance
    // `data.attributes.getOrientation`/… is silently dropped (every box would
    // render at identity heading, unit scale, and no ground-lift). Supply them as
    // function accessors indexing the per-instance buffers.
    const data = {
      length: n,
      attributes: {
        getPosition: { value: positions, size: 3 },
        getColor: { value: colors, size: 4, normalized: true },
      },
    };
    const getOrientation = (
      _: unknown,
      info: { index: number },
    ): [number, number, number] => {
      const o = info.index * 3;
      return [orientations[o], orientations[o + 1], orientations[o + 2]];
    };
    const getScale = (
      _: unknown,
      info: { index: number },
    ): [number, number, number] => {
      const o = info.index * 3;
      return [scales[o], scales[o + 1], scales[o + 2]];
    };
    const getTranslation = (
      _: unknown,
      info: { index: number },
    ): [number, number, number] => {
      const o = info.index * 3;
      return [translations[o], translations[o + 1], translations[o + 2]];
    };

    const extensions = this.composeExtensions([]);
    const props = this.composeSubLayerProps('boxes', 'all', {
      data: data as any,
      mesh: UNIT_CUBE,
      // Per-instance pose accessors (see the note above).
      getOrientation,
      getScale,
      getTranslation,
      wireframe: this.props.wireframe,
      material: this.props.material,
      extensions,
      pickable,
      // Per-frame active-track props for getPickingInfo (read off the sublayer).
      // One row per instance, so the stride is 1 (vs the edges layer's 12).
      sttPickRows: pickRows,
      sttPickStride: 1,
    });
    const SubLayerClass = this.getSubLayerClass('boxes', SimpleMeshLayer);
    return new SubLayerClass(props as any);
  }

  /**
   * Build the 12-edge cuboid OUTLINE (the `edges` sublayer) over the active
   * samples — the streetscape.gl / nuScenes-devkit detection-box look. Each
   * box's 8 corners are computed in the local ground frame (east/north meters),
   * yawed by `heading`, lifted to its real height, then converted to lon/lat
   * (the same metres→degrees idiom as the velocity arrows) so the outline tracks
   * the box pose exactly. The 12 true box edges are emitted as `LineLayer`
   * segments (NOT the mesh's triangle wireframe, which would diagonal every
   * face). Each segment inherits its box's per-category color × appear/
   * disappear fade — UNLESS {@link _AnimatedBoundingBoxLayerProps.strokeColor}
   * (or its `getLineColor` alias) sets a distinct constant outline color, which
   * still rides the same fade on its alpha. Width/units/clamp come from
   * `strokeWidth`/`strokeWidthUnits`/`strokeWidthMinPixels`/`strokeWidthMaxPixels`.
   * `pickable` is set by the caller (only when there is no fill underneath to
   * take picks).
   */
  private buildEdges(samples: Sample[], pickable: boolean): LineLayer {
    const n = samples.length;
    const EDGES = 12;
    const total = n * EDGES;
    const sizeScale = this.props.sizeScale ?? 1;

    const source = new Float64Array(total * 3);
    const target = new Float64Array(total * 3);
    const colors = new Uint8Array(total * 4);
    const pickRows: PickRow[] = new Array(n);

    // Distinct constant outline color when strokeColor / getLineColor resolves to
    // a Color; else (null, or an unsupported column-name string) each edge
    // inherits its box's per-category fill. Normalize to RGBA up front so the
    // per-segment bake below stays a plain copy. The appear/disappear fade still
    // rides the alpha in BOTH branches.
    const strokeColor = this.strokeColorValue();
    const strokeArr = Array.isArray(strokeColor)
      ? (strokeColor as number[])
      : null;
    const strokeRGBA: [number, number, number, number] | null = strokeArr
      ? [strokeArr[0], strokeArr[1], strokeArr[2], strokeArr[3] ?? 255]
      : null;

    // The 12 edges of a cuboid, as index pairs into the 8 corners laid out
    // below: 0-3 = ground ring (CCW), 4-7 = roof ring, then the 4 verticals.
    const EDGE_PAIRS: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0], // ground rectangle
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4], // roof rectangle
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7], // verticals
    ];

    let seg = 0;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const hx = s.length * 0.5 * sizeScale; // half-length (box +x / heading axis)
      const hy = s.width * 0.5 * sizeScale; // half-width
      const top = s.height * sizeScale; // roof height (base rests on the ground)
      const yaw = Number.isFinite(s.heading) ? s.heading : 0;
      const cos = Math.cos(yaw);
      const sin = Math.sin(yaw);
      const cosLat = Math.cos((s.lat * Math.PI) / 180);
      const mPerLon =
        cosLat !== 0 ? METERS_PER_DEG_LAT * cosLat : METERS_PER_DEG_LAT;

      // Local (dx,dy,dz) metres → [lon,lat,alt]: yaw the planar offset about the
      // vertical, then convert metres to degrees about this box's anchor.
      const corner = (
        dx: number,
        dy: number,
        dz: number,
      ): [number, number, number] => {
        const east = dx * cos - dy * sin;
        const north = dx * sin + dy * cos;
        return [
          s.lon + east / mPerLon,
          s.lat + north / METERS_PER_DEG_LAT,
          s.alt + dz,
        ];
      };
      const corners: [number, number, number][] = [
        corner(-hx, -hy, 0),
        corner(hx, -hy, 0),
        corner(hx, hy, 0),
        corner(-hx, hy, 0),
        corner(-hx, -hy, top),
        corner(hx, -hy, top),
        corner(hx, hy, top),
        corner(-hx, hy, top),
      ];

      // Distinct constant outline overrides the inherited fill; the fade rides
      // its alpha either way.
      const c = strokeRGBA ?? s.track.color;
      const alpha = Math.round((c[3] ?? 255) * s.alpha);
      for (const [a, b] of EDGE_PAIRS) {
        const o3 = seg * 3;
        const ca = corners[a];
        const cb = corners[b];
        source[o3] = ca[0];
        source[o3 + 1] = ca[1];
        source[o3 + 2] = ca[2];
        target[o3] = cb[0];
        target[o3 + 1] = cb[1];
        target[o3 + 2] = cb[2];
        const o4 = seg * 4;
        colors[o4] = c[0];
        colors[o4 + 1] = c[1];
        colors[o4 + 2] = c[2];
        colors[o4 + 3] = alpha;
        seg++;
      }
      pickRows[i] = makePickRow(s);
    }

    const data = {
      length: total,
      attributes: {
        getSourcePosition: { value: source, size: 3 },
        getTargetPosition: { value: target, size: 3 },
        getColor: { value: colors, size: 4, normalized: true },
      },
    };
    const props = this.composeSubLayerProps('edges', 'all', {
      data: data as any,
      positionFormat: 'XYZ',
      widthUnits: this.props.strokeWidthUnits ?? 'pixels',
      getWidth: this.props.strokeWidth ?? 1.5,
      widthMinPixels: this.props.strokeWidthMinPixels ?? 1,
      widthMaxPixels:
        this.props.strokeWidthMaxPixels ?? Number.MAX_SAFE_INTEGER,
      pickable,
      // 12 segments per box, so a hit's segment index ÷ 12 is the box index.
      sttPickRows: pickRows,
      sttPickStride: EDGES,
    });
    const SubLayerClass = this.getSubLayerClass('edges', LineLayer);
    return new SubLayerClass(props as any);
  }

  /** Build the single per-object label TextLayer over the active samples. */
  private buildLabels(samples: Sample[]): TextLayer {
    const rows: LabelRow[] = samples.map((s) => ({
      position: [s.lon, s.lat, s.alt],
      text: s.track.label,
    }));
    const props = this.composeSubLayerProps('labels', 'all', {
      data: rows as any,
      getText: (d: LabelRow) => d.text,
      getPosition: (d: LabelRow) => d.position,
      billboard: true,
      getPixelOffset: [0, -16],
      getSize: 11,
      sizeUnits: 'pixels',
      // White glyphs with a dark SDF outline so labels read over any box color.
      getColor: [255, 255, 255, 255],
      fontSettings: { sdf: true },
      outlineWidth: 2,
      outlineColor: [0, 0, 0, 200],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'bottom',
      pickable: false,
      updateTriggers: { getText: rows.length, getPosition: rows },
    });
    const SubLayerClass = this.getSubLayerClass('labels', TextLayer);
    return new SubLayerClass(props as any);
  }

  /** Build the single per-object velocity-arrow LineLayer over the active samples. */
  private buildVelocity(samples: Sample[]): LineLayer {
    const n = samples.length;
    const source = new Float64Array(n * 3);
    const target = new Float64Array(n * 3);
    const minSpeed = this.props.velocityMinSpeed ?? 0.3;
    const velocityScale = this.props.velocityScale ?? 1.5;

    for (let i = 0; i < n; i++) {
      const s = samples[i];
      const o = i * 3;
      source[o] = s.lon;
      source[o + 1] = s.lat;
      source[o + 2] = s.alt;
      target[o] = s.lon;
      target[o + 1] = s.lat;
      target[o + 2] = s.alt;

      const speed = s.speed;
      if (!(speed >= minSpeed) || !Number.isFinite(s.heading)) continue; // zero-length arrow
      const dxMeters = speed * Math.cos(s.heading) * velocityScale; // east (+x)
      const dyMeters = speed * Math.sin(s.heading) * velocityScale; // north (+y)
      const dLat = dyMeters / METERS_PER_DEG_LAT;
      const cosLat = Math.cos((s.lat * Math.PI) / 180);
      const dLon = cosLat !== 0 ? dxMeters / (METERS_PER_DEG_LAT * cosLat) : 0;
      target[o] = s.lon + dLon;
      target[o + 1] = s.lat + dLat;
    }

    const data = {
      length: n,
      attributes: {
        getSourcePosition: { value: source, size: 3 },
        getTargetPosition: { value: target, size: 3 },
      },
    };
    const constColor = (this.props.velocityColor ??
      DEFAULT_VELOCITY_COLOR) as Color;
    const props = this.composeSubLayerProps('velocity', 'all', {
      data: data as any,
      positionFormat: 'XYZ',
      getColor: constColor,
      widthUnits: 'pixels',
      getWidth: 2,
      widthMinPixels: this.props.velocityWidthMinPixels,
      pickable: false,
    });
    const SubLayerClass = this.getSubLayerClass('velocity', LineLayer);
    return new SubLayerClass(props as any);
  }

  /**
   * Picking enrichment for whichever sublayer carries picks (the `boxes` fill,
   * or the `edges` outline when there is no fill). The active-track rows are
   * rebuilt with that sublayer's instance buffer each frame and tagged with a
   * `sttPickStride` — 1 for the mesh (one instance per box), 12 for the edges
   * (one segment per cuboid edge). So the box index is `info.index / stride`;
   * `info.object` is set to that track's flat decoded props (the shape the AV
   * cockpit's click-to-inspect handler reads).
   */
  getPickingInfo({
    info,
    sourceLayer,
  }: GetPickingInfoParams): SpatioTemporalPickingInfo {
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
