// @poopdeck.gl/layers
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/layers contributors

/**
 * Track kernel — the shared CPU pool-by-track + per-frame interpolation engine
 * behind the "one smooth-moving instance per tracked object" layers
 * (AnimatedBoundingBoxLayer's oriented cuboids and AnimatedMeshLayer's 3D
 * models). It exists so that machinery lives in EXACTLY ONE place: this codebase
 * has a documented CPU-logic-drift problem where hand-copied per-frame math
 * silently diverges between renderers, and this pooling/interpolation code is a
 * prime candidate (originally lifted from AnimatedTripHeadsLayer).
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────
 * The AV `objects/` archive carries one POINT feature per tracked object PER
 * KEYFRAME (a snapshot: `track_id`, `category`, `heading`, `length`/`width`/
 * `height`, `speed`, timestamped). A GPU time-WINDOW filter would show N
 * instances per object whenever the window spans N keyframes — the "train of
 * boxes" bug. Instead:
 *   1. {@link buildTrackIndex} pools the snapshots of ALL loaded tiles, groups
 *      them by `track_id`, rebases each keyframe to ABSOLUTE epoch-ms
 *      (`startTime + tile.timeOffset`) so cross-tile keyframes sort into one
 *      timeline, and sorts+de-dups each track. Runs only when the tile SET (or
 *      a feeding style prop) changes.
 *   2. {@link sampleTrack} interpolates ONE pose per ACTIVE track at the
 *      playhead (binary-search + lerp, angle-lerp for heading, plus a CPU
 *      appear/disappear fade). Runs every frame; inactive tracks return null.
 *
 * The renderers own only their instance-buffer bake + sublayer construction;
 * the pooling and interpolation are here.
 */

import type { Color } from '@deck.gl/core';
import type { Tile, BinaryFeatures } from '@poopdeck.gl/core';

/** Radians → degrees, for the heading → getOrientation z-rotation. */
export const RAD_TO_DEG = 180 / Math.PI;

/** Meters per degree of latitude (equirectangular small-offset conversion). */
export const METERS_PER_DEG_LAT = 111_320;

/**
 * Hold window (ms) granted to a DEGENERATE track that has only ONE loaded
 * keyframe (which can't be interpolated). Real AV object archives always carry a
 * `track_id` column with multiple keyframes per track, so this only guards
 * malformed/track-less input: such an instance is shown for ±half this around
 * its lone keyframe instead of vanishing at the measure-zero instant it exists.
 */
export const SINGLETON_HOLD_MS = 600;

/** Shared fallback color when a track's category is unmapped / absent. */
export const DEFAULT_TRACK_COLOR: Color = [160, 160, 160, 255];

/**
 * One tracked object's pooled keyframes, in ABSOLUTE epoch-ms and sorted
 * ascending by time. Parallel arrays (one entry per keyframe) keep the pooling
 * allocation-light; per-track constants (color/label) are baked once.
 */
export interface Track {
  trackId: string;
  /** Absolute keyframe times (ms), strictly ascending after de-dup. */
  times: number[];
  lon: number[];
  lat: number[];
  /** Altitude (0 for 2D point archives). */
  alt: number[];
  /** Heading per keyframe (radians); NaN where the column is absent. */
  heading: number[];
  /** Box/model dims per keyframe (meters); NaN where the column is absent. */
  length: number[];
  width: number[];
  height: number[];
  /** Speed per keyframe (m/s); NaN where the column is absent. */
  speed: number[];
  /** Baked RGBA from this track's `category` via colorMapping (alpha pre-fade). */
  color: [number, number, number, number];
  /** The `labelProperty` value (stringified), for the optional TextLayer. */
  label: string;
  /** The `category` (colorProperty) value, for picking + per-category dispatch. */
  category: string;
  /** True when the track has a single loaded keyframe (held, not interpolated). */
  singleton: boolean;
}

/** One interpolated instance at the playhead (the per-frame render unit). */
export interface Sample {
  lon: number;
  lat: number;
  alt: number;
  /** Heading in radians; NaN ⇒ axis-aligned. */
  heading: number;
  length: number;
  width: number;
  height: number;
  speed: number;
  /** Appear/disappear fade factor in [0,1] (folded into the instance alpha). */
  alpha: number;
  track: Track;
}

/** Flat decoded props attached to `info.object` on a pick (AV inspector shape). */
export interface TrackPickRow {
  track_id: string;
  category: string;
  heading: number;
  length: number;
  width: number;
  height: number;
  speed: number;
}

/** Which tile columns to read when pooling snapshots into tracks. */
export interface TrackFieldConfig {
  /** Categorical column grouping snapshots into one track ('' ⇒ each snapshot is its own held instance). */
  trackIdProperty: string;
  /** Categorical column driving per-instance color ('' ⇒ constant colorMappingDefault). */
  colorProperty: string;
  /** Column (categorical or numeric) whose value becomes the optional label. */
  labelProperty: string;
  headingProperty: string;
  lengthProperty: string;
  widthProperty: string;
  heightProperty: string;
  speedProperty: string;
  colorMapping: Record<string, Color> | null | undefined;
  colorMappingDefault: Color;
}

/** Geometric fallbacks + fade ramps applied at interpolation time. */
export interface TrackSampleConfig {
  defaultLength: number;
  defaultWidth: number;
  defaultHeight: number;
  fadeInDuration: number;
  fadeOutDuration: number;
}

/** Outcome of {@link buildTrackIndex}; the caller emits its own telemetry/warns. */
export interface TrackIndexResult {
  /** track-id-keyed pool (synthetic keys for track-less snapshots). */
  tracks: Map<string, Track>;
  /** True when at least one loaded tile carried the speed column. */
  hasSpeedColumn: boolean;
  /** True when at least one loaded tile LACKED the track-id column. */
  trackIdMissing: boolean;
  /** Total snapshots pooled (for telemetry). */
  totalSnapshots: number;
}

/** Linear interpolation. */
export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/**
 * Shortest-arc angular interpolation (radians). Interpolating headings as plain
 * numbers would spin the instance the long way around the ±π seam (e.g.
 * 179°→-179°); normalizing the delta into (-π, π] takes the short way. NaN
 * endpoints (absent heading column) degrade to whichever side is finite.
 */
export function lerpAngle(a: number, b: number, f: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  const twoPi = Math.PI * 2;
  let d = (b - a) % twoPi;
  if (d > Math.PI) d -= twoPi;
  else if (d < -Math.PI) d += twoPi;
  return a + d * f;
}

/** Lerp a dimension that may be NaN (absent column) — fall back to a default. */
export function lerpDim(
  a: number,
  b: number,
  f: number,
  fallback: number,
): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return lerp(a, b, f);
  if (af) return a;
  if (bf) return b;
  return fallback;
}

/** Resolve one feature's categorical (string) column value, or '' if absent. */
export function readCategorical(
  binary: BinaryFeatures,
  prop: string,
  i: number,
): string {
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
export function resolveColor(
  category: string,
  mapping: Record<string, Color> | null | undefined,
  fallback: Color,
): [number, number, number, number] {
  const c = (category && mapping && mapping[category]) || fallback;
  return [c[0], c[1], c[2], c[3] ?? 255];
}

/** Build the flat AV-inspector pick row for one interpolated sample. */
export function makePickRow(s: Sample): TrackPickRow {
  return {
    track_id: s.track.trackId,
    category: s.track.category,
    heading: s.heading,
    length: s.length,
    width: s.width,
    height: s.height,
    speed: s.speed,
  };
}

/**
 * Pool every loaded tile's object snapshots into a `track_id`-keyed map, each
 * track's keyframes rebased to absolute epoch-ms and sorted+de-duped. O(total
 * snapshots); the caller runs it only when the tile set or a feeding prop
 * changes. Emits no telemetry / warnings — it returns the counts + the
 * `trackIdMissing` flag so each renderer can warn with its own layer name.
 */
export function buildTrackIndex(
  tiles: Tile[],
  cfg: TrackFieldConfig,
): TrackIndexResult {
  const trackIdProp = cfg.trackIdProperty || 'track_id';
  const colorProp = cfg.colorProperty;
  const labelProp = cfg.labelProperty || 'category';
  const headingProp = cfg.headingProperty || 'heading';
  const lengthProp = cfg.lengthProperty || 'length';
  const widthProp = cfg.widthProperty || 'width';
  const heightProp = cfg.heightProperty || 'height';
  const speedProp = cfg.speedProperty || 'speed';
  const fallbackColor = cfg.colorMappingDefault ?? DEFAULT_TRACK_COLOR;

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
          key =
            idx === 0xffff
              ? `∅${synthetic++}`
              : (trackCol.categories[idx] ?? `∅${synthetic++}`);
        } else {
          key = `∅${synthetic++}`;
        }

        let track = tracks.get(key);
        if (!track) {
          const category = colorProp
            ? readCategorical(binary, colorProp, i)
            : '';
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
            color: resolveColor(category, cfg.colorMapping, fallbackColor),
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

  // Sort each track's keyframes by absolute time (cross-tile pooling leaves them
  // tile-ordered) and drop exact-duplicate timestamps, folded into a SINGLE
  // permutation applied by one reorder pass per track. Stable sort ⇒ equal
  // timestamps keep insertion order.
  const order: number[] = [];
  for (const track of tracks.values()) {
    const times = track.times;
    const n = times.length;
    if (n > 1) {
      order.length = n;
      for (let k = 0; k < n; k++) order[k] = k;
      order.sort((a, b) => times[a] - times[b]);
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

  return {
    tracks,
    hasSpeedColumn: hasSpeed,
    trackIdMissing,
    totalSnapshots: total,
  };
}

/**
 * Interpolate one track's pose at absolute `now`, or null when the track is
 * inactive (the playhead is outside its keyframe span). Singletons are held for
 * ±{@link SINGLETON_HOLD_MS}/2 around their lone keyframe.
 */
export function sampleTrack(
  track: Track,
  now: number,
  cfg: TrackSampleConfig,
): Sample | null {
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

  const length = lerpDim(
    track.length[lo],
    track.length[hi],
    frac,
    cfg.defaultLength,
  );
  const width = lerpDim(
    track.width[lo],
    track.width[hi],
    frac,
    cfg.defaultWidth,
  );
  const height = lerpDim(
    track.height[lo],
    track.height[hi],
    frac,
    cfg.defaultHeight,
  );
  const speedLo = track.speed[lo];
  const speedHi = track.speed[hi];
  const speed =
    Number.isFinite(speedLo) || Number.isFinite(speedHi)
      ? lerpDim(speedLo, speedHi, frac, 0)
      : NaN;

  // CPU appear/disappear fade (playhead-time ramp), folded into the instance alpha.
  let alpha = 1;
  const fadeIn = cfg.fadeInDuration;
  const fadeOut = cfg.fadeOutDuration;
  if (fadeIn > 0) {
    const age = now - first;
    if (age < fadeIn) alpha *= Math.max(0, Math.min(1, age / fadeIn));
  }
  if (fadeOut > 0) {
    const remaining = last - now;
    if (remaining < fadeOut)
      alpha *= Math.max(0, Math.min(1, remaining / fadeOut));
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

/**
 * Permute every parallel array of a track by `order` (index-sort). The output
 * is allocated at `order.length`, NOT `src.length`: when de-dup dropped
 * exact-duplicate timestamps `order.length < src.length`, and sizing the output
 * to `src.length` would leave trailing `undefined` HOLES — which then poison
 * {@link sampleTrack} (`times[n-1]` becomes `undefined` ⇒ the high-side cull
 * `now > NaN` never fires so the track never culls, and the final bracket lerps
 * against `undefined` ⇒ NaN poses). Sizing to `order.length` keeps every array
 * dense and its last entry the real last kept keyframe.
 */
function reorder(track: Track, order: number[]): void {
  const keys: (keyof Track)[] = [
    'times',
    'lon',
    'lat',
    'alt',
    'heading',
    'length',
    'width',
    'height',
    'speed',
  ];
  for (const k of keys) {
    const src = track[k] as number[];
    const out = new Array(order.length);
    for (let i = 0; i < order.length; i++) out[i] = src[order[i]];
    (track as any)[k] = out;
  }
}
