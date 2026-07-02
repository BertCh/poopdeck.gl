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
} from '../spatiotemporal-layer';
import { emit } from '../../lib/telemetry';
import { warnOnce } from '../../lib/log';
import {
  colorMappingDigest,
  updateTriggersDigest,
} from '../../lib/style-digest';
import type { Tile, BinaryFeatures } from '@poopdeck.gl/core';

const DEBUG = false;

/**
 * Unit cube geometry shared by every box instance (one upload per device). It
 * spans [-1, +1] on each axis (2 units across), so `getScale` carries a ×0.5
 * factor to make one scale unit == one meter of box dimension.
 */
const UNIT_CUBE = new CubeGeometry();

/** Radians → degrees, for the heading → getOrientation z-rotation. */
const RAD_TO_DEG = 180 / Math.PI;

/** Meters per degree of latitude (equirectangular small-offset conversion). */
const METERS_PER_DEG_LAT = 111_320;

/**
 * Hold window (ms) granted to a DEGENERATE track that has only ONE loaded
 * keyframe (which can't be interpolated). Real AV object archives always carry a
 * `track_id` column with multiple keyframes per track, so this only guards
 * malformed/track-less input: such a box is shown for ±half this around its lone
 * keyframe instead of vanishing at the measure-zero instant it exists.
 */
const SINGLETON_HOLD_MS = 600;

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
 * One tracked object's pooled keyframes, in ABSOLUTE epoch-ms and sorted
 * ascending by time. Parallel arrays (one entry per keyframe) keep the pooling
 * allocation-light; per-track constants (color/label) are baked once.
 */
interface Track {
  trackId: string;
  /** Absolute keyframe times (ms), strictly ascending after de-dup. */
  times: number[];
  lon: number[];
  lat: number[];
  /** Altitude (0 for 2D point archives). */
  alt: number[];
  /** Heading per keyframe (radians); NaN where the column is absent. */
  heading: number[];
  /** Box dims per keyframe (meters); NaN where the column is absent. */
  length: number[];
  width: number[];
  height: number[];
  /** Speed per keyframe (m/s); NaN where the column is absent. */
  speed: number[];
  /** Baked RGBA from this track's `category` via colorMapping (alpha pre-fade). */
  color: [number, number, number, number];
  /** The `labelProperty` value (stringified), for the optional TextLayer. */
  label: string;
  /** The `category` (colorProperty) value, for picking. */
  category: string;
  /** True when the track has a single loaded keyframe (held, not interpolated). */
  singleton: boolean;
}

/** One interpolated box at the playhead (the per-frame render unit). */
interface Sample {
  lon: number;
  lat: number;
  alt: number;
  /** Heading in radians; NaN ⇒ axis-aligned. */
  heading: number;
  length: number;
  width: number;
  height: number;
  speed: number;
  /** Appear/disappear fade factor in [0,1] (folded into the box alpha). */
  alpha: number;
  track: Track;
}

/** Flat decoded props attached to `info.object` on a pick (AV inspector shape). */
interface PickRow {
  track_id: string;
  category: string;
  heading: number;
  length: number;
  width: number;
  height: number;
  speed: number;
}

/** One label row for the optional TextLayer (rebuilt per frame from samples). */
interface LabelRow {
  position: [number, number, number];
  text: string;
}

/** Linear interpolation. */
function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/**
 * Shortest-arc angular interpolation (radians). Interpolating headings as plain
 * numbers would spin the box the long way around the ±π seam (e.g. 179°→-179°);
 * normalizing the delta into (-π, π] takes the short way. NaN endpoints (absent
 * heading column) degrade gracefully to whichever side is finite.
 */
function lerpAngle(a: number, b: number, f: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return a + d * f;
}

/** Lerp a dimension that may be NaN (absent column) — fall back to a default. */
function lerpDim(a: number, b: number, f: number, fallback: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return lerp(a, b, f);
  if (af) return a;
  if (bf) return b;
  return fallback;
}

/** Resolve one feature's categorical (string) column value, or '' if absent. */
function readCategorical(binary: BinaryFeatures, prop: string, i: number): string {
  const cat = binary.categoricalProps[prop];
  if (cat) {
    const idx = cat.indices[i];
    return idx === 0xffff ? '' : (cat.categories[idx] ?? '');
  }
  const num = binary.numericProps[prop];
  if (num) {
    const v = num[i];
    return Number.isFinite(v) ? String(v) : '';
  }
  return '';
}

/** Category STRING → RGBA via colorMapping (fallback when absent/unmapped). */
function resolveColor(
  category: string,
  mapping: Record<string, Color> | null | undefined,
  fallback: Color,
): [number, number, number, number] {
  const c = (category && mapping && mapping[category]) || fallback;
  return [c[0], c[1], c[2], c[3] ?? 255];
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
export class AnimatedBoundingBoxLayer<ExtraPropsT extends {} = {}> extends SpatioTemporalLayer<
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
    colorProperty: { type: 'object', value: null, optional: true, compare: true },
    colorMapping: { type: 'object', value: null, optional: true, compare: true },
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
    const colorProp = typeof this.props.colorProperty === 'string' ? this.props.colorProperty : '';
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
   * Pool every loaded tile's object snapshots into a `track_id`-keyed map, each
   * track's keyframes rebased to absolute epoch-ms and sorted. O(total
   * snapshots); runs only when the tile set or a feeding prop changes.
   */
  private buildTrackIndex(tiles: Tile[]): Map<string, Track> {
    const t0 = performance.now();
    const trackIdProp = this.props.trackIdProperty || 'track_id';
    const colorProp = typeof this.props.colorProperty === 'string' ? this.props.colorProperty : '';
    const labelProp = this.props.labelProperty || 'category';
    const headingProp = this.props.headingProperty || 'heading';
    const lengthProp = this.props.lengthProperty || 'length';
    const widthProp = this.props.widthProperty || 'width';
    const heightProp = this.props.heightProperty || 'height';
    const speedProp = this.props.speedProperty || 'speed';
    const fallbackColor = (this.props.colorMappingDefault ?? DEFAULT_COLOR) as Color;

    const tracks = new Map<string, Track>();
    let hasSpeed = false;
    let trackIdMissing = false;
    let synthetic = 0;
    let total = 0;

    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const binary = tileLayer.features;
        const count = binary.featureCount;
        if (count === 0) continue;

        const dims = binary.positionDimensions ?? 2;
        const positions = binary.positions;
        const starts = binary.startTimes;
        const offset = binary.timeOffset;
        const trackCol = binary.categoricalProps[trackIdProp];
        const heading = binary.numericProps[headingProp] ?? null;
        const length = binary.numericProps[lengthProp] ?? null;
        const width = binary.numericProps[widthProp] ?? null;
        const height = binary.numericProps[heightProp] ?? null;
        const speed = binary.numericProps[speedProp] ?? null;
        if (speed) hasSpeed = true;
        if (!trackCol) trackIdMissing = true;

        for (let i = 0; i < count; i++) {
          total++;
          // Group key: the track id, or a unique synthetic key (degenerate,
          // un-interpolated) when the column is absent.
          let key: string;
          if (trackCol) {
            const idx = trackCol.indices[i];
            key = idx === 0xffff ? `∅${synthetic++}` : (trackCol.categories[idx] ?? `∅${synthetic++}`);
          } else {
            key = `∅${synthetic++}`;
          }

          let track = tracks.get(key);
          if (!track) {
            const category = colorProp ? readCategorical(binary, colorProp, i) : '';
            track = {
              trackId: trackCol ? key : '',
              times: [],
              lon: [],
              lat: [],
              alt: [],
              heading: [],
              length: [],
              width: [],
              height: [],
              speed: [],
              color: resolveColor(category, this.props.colorMapping, fallbackColor),
              label: readCategorical(binary, labelProp, i),
              category,
              singleton: false,
            };
            tracks.set(key, track);
          }

          const b = i * dims;
          track.times.push(starts[i] + offset); // → absolute epoch-ms
          track.lon.push(positions[b]);
          track.lat.push(positions[b + 1]);
          track.alt.push(dims > 2 ? positions[b + 2] : 0);
          track.heading.push(heading ? heading[i] : NaN);
          track.length.push(length ? length[i] : NaN);
          track.width.push(width ? width[i] : NaN);
          track.height.push(height ? height[i] : NaN);
          track.speed.push(speed ? speed[i] : NaN);
        }
      }
    }

    // Sort each track's keyframes by absolute time (cross-tile pooling leaves
    // them tile-ordered) and drop exact-duplicate timestamps. An index-sort
    // permutation keeps the parallel arrays aligned without per-keyframe objects.
    //
    // Perf: fold the sort + de-dup into a SINGLE permutation applied by ONE
    // reorder pass per track. The old path allocated an index array via
    // Array.from + a stable sort, reordered all 9 parallel arrays, then
    // allocated a second `keep` array and reordered again — up to 2× the array
    // churn per track. Here we sort a reused index buffer in place (stable, so
    // equal timestamps keep insertion order — same as before), compact
    // duplicates within that same buffer, and reorder exactly once. Output
    // ordering and semantics are byte-for-byte identical to sort→reorder→dedupe.
    const order: number[] = [];
    for (const track of tracks.values()) {
      const times = track.times;
      const n = times.length;
      if (n > 1) {
        order.length = n;
        for (let k = 0; k < n; k++) order[k] = k;
        // Stable sort by time (ES spec guarantees stability): equal timestamps
        // stay in their original tile/insertion order, matching the prior sort.
        order.sort((a, b) => times[a] - times[b]);
        // Compact out exact-duplicate timestamps in place, keeping the first of
        // each equal run (equivalent to the former dedupe-after-sort pass).
        let write = 0;
        for (let k = 0; k < n; k++) {
          const idx = order[k];
          if (k === 0 || times[idx] !== times[order[write - 1]]) {
            order[write++] = idx;
          }
        }
        if (write !== n) order.length = write;
        reorder(track, order);
      }
      track.singleton = track.times.length < 2;
    }

    if (trackIdMissing) {
      warnOnce(
        'AnimatedBoundingBoxLayer:noTrackId',
        `[AnimatedBoundingBoxLayer] no \`${trackIdProp}\` column — object snapshots ` +
          `cannot be grouped into tracks, so each is shown as a held box ` +
          `(${SINGLETON_HOLD_MS}ms) with no interpolation. Build the objects ` +
          `archive with a track-id column for smooth single-box rendering.`,
      );
    }

    this.hasSpeedColumn = hasSpeed;
    emit('tilePrepare', {
      layer: 'AnimatedBoundingBoxLayer',
      tracks: tracks.size,
      snapshots: total,
      ms: performance.now() - t0,
    });
    return tracks;
  }

  /**
   * Interpolate one track's box pose at absolute `now`, or null when the track
   * is inactive (the playhead is outside its keyframe span). Singletons are held
   * for ±{@link SINGLETON_HOLD_MS}/2 around their lone keyframe.
   */
  private sampleTrack(track: Track, now: number): Sample | null {
    const { times } = track;
    const n = times.length;
    if (n === 0) return null;

    const first = times[0];
    const last = times[n - 1];
    const pad = track.singleton ? SINGLETON_HOLD_MS / 2 : 0;
    if (now < first - pad || now > last + pad) return null;

    let lo: number;
    let hi: number;
    let frac: number;
    if (n === 1) {
      lo = hi = 0;
      frac = 0;
    } else {
      const c = now < first ? first : now > last ? last : now;
      // Largest lo with times[lo] <= c (times strictly ascending).
      lo = 0;
      hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= c) lo = mid;
        else hi = mid;
      }
      const denom = times[hi] - times[lo];
      frac = denom > 0 ? (c - times[lo]) / denom : 0;
    }

    const length = lerpDim(track.length[lo], track.length[hi], frac, this.props.defaultLength ?? 4);
    const width = lerpDim(track.width[lo], track.width[hi], frac, this.props.defaultWidth ?? 2);
    const height = lerpDim(track.height[lo], track.height[hi], frac, this.props.defaultHeight ?? 1.6);
    const speedLo = track.speed[lo];
    const speedHi = track.speed[hi];
    const speed = Number.isFinite(speedLo) || Number.isFinite(speedHi)
      ? lerpDim(speedLo, speedHi, frac, 0)
      : NaN;

    // CPU appear/disappear fade (playhead-time ramp), folded into the box alpha.
    let alpha = 1;
    const fadeIn = this.props.fadeInDuration ?? 0;
    const fadeOut = this.props.fadeOutDuration ?? 0;
    if (fadeIn > 0) {
      const age = now - first;
      if (age < fadeIn) alpha *= Math.max(0, Math.min(1, age / fadeIn));
    }
    if (fadeOut > 0) {
      const remaining = last - now;
      if (remaining < fadeOut) alpha *= Math.max(0, Math.min(1, remaining / fadeOut));
    }

    return {
      lon: lerp(track.lon[lo], track.lon[hi], frac),
      lat: lerp(track.lat[lo], track.lat[hi], frac),
      alt: lerp(track.alt[lo], track.alt[hi], frac),
      heading: lerpAngle(track.heading[lo], track.heading[hi], frac),
      length,
      width,
      height,
      speed,
      alpha,
      track,
    };
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
      emit('renderLayers', { layer: 'AnimatedBoundingBoxLayer', tiles: tiles.length, sublayers: 0, ms: performance.now() - t0 });
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
    if (this.props.showVelocity && this.hasSpeedColumn) layers.push(this.buildVelocity(samples));

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
      orientations[o3 + 1] = Number.isFinite(s.heading) ? s.heading * RAD_TO_DEG : 0;
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
      pickRows[i] = {
        track_id: s.track.trackId,
        category: s.track.category,
        heading: s.heading,
        length: s.length,
        width: s.width,
        height: s.height,
        speed: s.speed,
      };
    }

    const data = {
      length: n,
      attributes: {
        getPosition: { value: positions, size: 3 },
        getOrientation: { value: orientations, size: 3 },
        getScale: { value: scales, size: 3 },
        getTranslation: { value: translations, size: 3 },
        getColor: { value: colors, size: 4, normalized: true },
      },
    };

    const extensions = this.composeExtensions([]);
    const props = this.composeSubLayerProps('boxes', 'all', {
      data: data as any,
      mesh: UNIT_CUBE,
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
   * face). Every segment inherits its box's per-category color × appear/
   * disappear fade. `pickable` is set by the caller (only when there is no fill
   * underneath to take picks).
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

    // The 12 edges of a cuboid, as index pairs into the 8 corners laid out
    // below: 0-3 = ground ring (CCW), 4-7 = roof ring, then the 4 verticals.
    const EDGE_PAIRS: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0], // ground rectangle
      [4, 5], [5, 6], [6, 7], [7, 4], // roof rectangle
      [0, 4], [1, 5], [2, 6], [3, 7], // verticals
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
      const mPerLon = cosLat !== 0 ? METERS_PER_DEG_LAT * cosLat : METERS_PER_DEG_LAT;

      // Local (dx,dy,dz) metres → [lon,lat,alt]: yaw the planar offset about the
      // vertical, then convert metres to degrees about this box's anchor.
      const corner = (dx: number, dy: number, dz: number): [number, number, number] => {
        const east = dx * cos - dy * sin;
        const north = dx * sin + dy * cos;
        return [s.lon + east / mPerLon, s.lat + north / METERS_PER_DEG_LAT, s.alt + dz];
      };
      const corners: [number, number, number][] = [
        corner(-hx, -hy, 0), corner(hx, -hy, 0), corner(hx, hy, 0), corner(-hx, hy, 0),
        corner(-hx, -hy, top), corner(hx, -hy, top), corner(hx, hy, top), corner(-hx, hy, top),
      ];

      const c = s.track.color;
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
      pickRows[i] = {
        track_id: s.track.trackId,
        category: s.track.category,
        heading: s.heading,
        length: s.length,
        width: s.width,
        height: s.height,
        speed: s.speed,
      };
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
      widthUnits: 'pixels',
      getWidth: this.props.strokeWidth ?? 1.5,
      widthMinPixels: this.props.strokeWidthMinPixels ?? 1,
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
    const constColor = (this.props.velocityColor ?? DEFAULT_VELOCITY_COLOR) as Color;
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

/** In-place permute every parallel array of a track by `order` (index-sort). */
function reorder(track: Track, order: number[]): void {
  const keys: (keyof Track)[] = ['times', 'lon', 'lat', 'alt', 'heading', 'length', 'width', 'height', 'speed'];
  for (const k of keys) {
    const src = track[k] as number[];
    const out = new Array(src.length);
    for (let i = 0; i < order.length; i++) out[i] = src[order[i]];
    (track as any)[k] = out;
  }
}
