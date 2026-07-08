// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) CPU keyframe pooling + interpolation for tracked object
 * boxes — the port of deck's `AnimatedBoundingBoxLayer` pooling/sampling. The
 * objects archive carries ONE point feature per object per keyframe (a snapshot:
 * `track_id`, `category`, `heading`, `length/width/height`, optional `speed`);
 * this groups them by `track_id` (rebased to absolute epoch-ms, sorted) and, per
 * frame, binary-searches + lerps each active track to one box pose. The layer
 * turns the pose into oriented line/mesh geometry.
 */

import type { BinaryFeatures, Tile } from '@poopdeck.gl/core';
import { resolveCategoryColor } from '@poopdeck.gl/core/style';
import type { RGBA } from '../lib/color.js';

/** Held-box window (ms) for a track with a single (un-interpolatable) keyframe. */
export const SINGLETON_HOLD_MS = 400;

export interface BoxTrackOptions {
  trackIdProperty: string;
  colorProperty: string; // '' = none
  colorMapping: Record<string, RGBA>;
  colorMappingDefault: RGBA;
  labelProperty: string;
  headingProperty: string;
  lengthProperty: string;
  widthProperty: string;
  heightProperty: string;
  speedProperty: string;
}

export interface BoxDefaults {
  length: number;
  width: number;
  height: number;
  fadeIn: number;
  fadeOut: number;
}

export interface Track {
  trackId: string;
  times: number[];
  lon: number[];
  lat: number[];
  alt: number[];
  heading: number[];
  length: number[];
  width: number[];
  height: number[];
  speed: number[];
  color: RGBA;
  label: string;
  category: string;
  singleton: boolean;
}

export interface BoxSample {
  lon: number;
  lat: number;
  alt: number;
  heading: number;
  length: number;
  width: number;
  height: number;
  speed: number;
  alpha: number;
  track: Track;
}

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Shortest-arc angular interpolation (radians); NaN endpoints degrade gracefully. */
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

function readCategorical(
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

function resolveColor(
  category: string,
  mapping: Record<string, RGBA>,
  fallback: RGBA,
): RGBA {
  const c = resolveCategoryColor(category, mapping, fallback);
  return [c[0], c[1], c[2], c[3] ?? 255];
}

/** Pool every loaded tile's object snapshots into a `track_id`-keyed, sorted index. */
export function buildTrackIndex(
  tiles: Tile[],
  opts: BoxTrackOptions,
): Map<string, Track> {
  const tracks = new Map<string, Track>();
  let synthetic = 0;

  for (const tile of tiles) {
    for (const tileLayer of tile.layers) {
      const binary = tileLayer.features;
      const count = binary.featureCount;
      if (count === 0) continue;

      const dims = binary.positionDimensions ?? 2;
      const positions = binary.positions;
      const starts = binary.startTimes;
      const offset = binary.timeOffset;
      const trackCol = binary.categoricalProps[opts.trackIdProperty];
      const heading = binary.numericProps[opts.headingProperty] ?? null;
      const length = binary.numericProps[opts.lengthProperty] ?? null;
      const width = binary.numericProps[opts.widthProperty] ?? null;
      const height = binary.numericProps[opts.heightProperty] ?? null;
      const speed = binary.numericProps[opts.speedProperty] ?? null;

      for (let i = 0; i < count; i++) {
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
          const category = opts.colorProperty
            ? readCategorical(binary, opts.colorProperty, i)
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
            color: resolveColor(
              category,
              opts.colorMapping,
              opts.colorMappingDefault,
            ),
            label: readCategorical(binary, opts.labelProperty, i),
            category,
            singleton: false,
          };
          tracks.set(key, track);
        }

        const b = i * dims;
        track.times.push(starts[i] + offset);
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

  for (const track of tracks.values()) {
    const n = track.times.length;
    if (n > 1) {
      const order = Array.from({ length: n }, (_, k) => k).sort(
        (a, b) => track.times[a] - track.times[b],
      );
      reorder(track, order);
      dedupeByTime(track);
    }
    track.singleton = track.times.length < 2;
  }

  return tracks;
}

const PARALLEL_KEYS = [
  'times',
  'lon',
  'lat',
  'alt',
  'heading',
  'length',
  'width',
  'height',
  'speed',
] as const;

function reorder(track: Track, order: number[]): void {
  for (const k of PARALLEL_KEYS) {
    const arr = track[k];
    track[k] = order.map((idx) => arr[idx]);
  }
}

function dedupeByTime(track: Track): void {
  const t = track.times;
  const keep: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (i === 0 || t[i] !== t[i - 1]) keep.push(i);
  }
  if (keep.length !== t.length) reorder(track, keep);
}

/** Interpolate one track's box pose at absolute `now`, or null when inactive. */
export function sampleTrack(
  track: Track,
  now: number,
  defaults: BoxDefaults,
): BoxSample | null {
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
    defaults.length,
  );
  const width = lerpDim(track.width[lo], track.width[hi], frac, defaults.width);
  const height = lerpDim(
    track.height[lo],
    track.height[hi],
    frac,
    defaults.height,
  );
  const speedLo = track.speed[lo];
  const speedHi = track.speed[hi];
  const speed =
    Number.isFinite(speedLo) || Number.isFinite(speedHi)
      ? lerpDim(speedLo, speedHi, frac, 0)
      : NaN;

  let alpha = 1;
  if (defaults.fadeIn > 0) {
    const age = now - first;
    if (age < defaults.fadeIn)
      alpha *= Math.max(0, Math.min(1, age / defaults.fadeIn));
  }
  if (defaults.fadeOut > 0) {
    const remaining = last - now;
    if (remaining < defaults.fadeOut)
      alpha *= Math.max(0, Math.min(1, remaining / defaults.fadeOut));
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

/** All active box poses at `now` (one per active track). */
export function sampleTracks(
  index: Map<string, Track>,
  now: number,
  defaults: BoxDefaults,
): BoxSample[] {
  const out: BoxSample[] = [];
  for (const track of index.values()) {
    const s = sampleTrack(track, now, defaults);
    if (s) out.push(s);
  }
  return out;
}
