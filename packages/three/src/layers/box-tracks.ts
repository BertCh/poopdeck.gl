// @poopdeck.gl/three
// SPDX-License-Identifier: MIT
// Copyright (c) @poopdeck.gl/three contributors

/**
 * Pure (Three-free) CPU keyframe pooling + interpolation for tracked object
 * boxes. The engine moved to the framework-free kernel `@poopdeck.gl/core`
 * (`render/track-kernel.ts`) — see docs/roadmap/renderer-architecture.md: CPU
 * logic lives in exactly one place. This module stays as a thin adapter so every
 * three importer of `./box-tracks` (and every consumer of the package-root
 * `buildTrackIndex`/`sampleTrack`/`sampleTracks`/`Track`) keeps resolving
 * unchanged.
 *
 * ── WHY THIS FILE WAS A PROBLEM ──────────────────────────────────────────────
 * It used to be a 344-line FORK of that kernel, carrying its own
 * `SINGLETON_HOLD_MS = 400` (the kernel ships 600), no `maxGapMs` integrity
 * guard and no `angleUnit` — while three's OWN icon and point-cloud layers
 * already pooled through the core kernel. One package, two track pools, drifting
 * apart. `test/box-tracks.test.ts` holds the differentials (sampling AND
 * pooling) against a hand transcription of the pre-shim fork that prove the
 * de-fork changed no behaviour.
 *
 * ── THE ONE PRESERVED DIVERGENCE ─────────────────────────────────────────────
 * `SINGLETON_HOLD_MS` stays three-local at 400 and is PASSED to the kernel as
 * `TrackSampleConfig.singletonHoldMs`, so a lone (un-interpolatable) AV box
 * still lingers for ±200 ms rather than the kernel's ±300. Aligning the two is a
 * behaviour change on a published export and gets its own commit + browser
 * check; it is not something a de-fork should smuggle in.
 */

import type {
  Sample,
  Tile,
  Track,
  TrackFieldConfig,
  TrackSampleConfig,
} from '@poopdeck.gl/core';
import {
  buildTrackIndex as buildCoreTrackIndex,
  sampleTrack as sampleCoreTrack,
} from '@poopdeck.gl/core';
import type { RGBA } from '../lib/color.js';

/** Held-box window (ms) for a track with a single (un-interpolatable) keyframe. */
export const SINGLETON_HOLD_MS = 400;

/**
 * The interpolation primitives are core's BY IDENTITY (not re-implementations):
 * `lerpAngle`'s ±π shortest-arc normalization and `lerpDim`'s NaN fallback are
 * exactly what this module used to define, and the package root re-exports these
 * bindings. Sharing the function objects is what makes a future drift impossible
 * rather than merely unlikely.
 */
export { lerp, lerpAngle, lerpDim } from '@poopdeck.gl/core';

/** One tracked object's pooled keyframes (the kernel's `Track`, unchanged). */
export type { Track } from '@poopdeck.gl/core';

/**
 * One interpolated box pose at the playhead. The kernel calls it `Sample`; the
 * name `BoxSample` is this package's published spelling. Structurally identical
 * apart from the kernel's two OPTIONAL motion-extrapolation flags, which are
 * never set on this path (no `motion` config is passed).
 */
export type { Sample as BoxSample } from '@poopdeck.gl/core';

/**
 * Which columns to pool from. Structurally a {@link TrackFieldConfig} with
 * three's own `RGBA` in the colour slots; kept as its own declaration because it
 * is a published type of `@poopdeck.gl/three` and aliasing it onto the kernel's
 * would widen `colorMapping` to `| null | undefined` for every existing caller.
 */
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
  /**
   * Hold window (ms) for a single-keyframe track.
   * @default SINGLETON_HOLD_MS (400) — three's value, NOT the kernel's 600.
   */
  singletonHoldMs?: number;
}

/**
 * A column name that cannot exist in a tile, standing in for "no such column".
 *
 * The kernel DEFAULTS an empty column name to the conventional one
 * (`cfg.trackIdProperty || 'track_id'`, and likewise for label/heading/length/
 * width/height/speed) — which contradicts its own `TrackFieldConfig` doc
 * ("'' ⇒ each snapshot is its own held instance"). The fork had no such
 * defaulting: an empty name simply found no column, so ids went synthetic and
 * numeric columns read NaN. Routing empty names to a guaranteed-absent name
 * reproduces that exactly, and keeps the de-fork behaviour-preserving over the
 * WHOLE input domain rather than only over the names `STTBoundingBoxLayer`
 * happens to emit (all non-empty). Fixing the kernel's defaulting instead would
 * change the icon and point-cloud glide paths, which pass '' today and rely on
 * whatever they currently get.
 */
const NO_SUCH_COLUMN = '\u0000<none>';

function column(name: string): string {
  return name === '' ? NO_SUCH_COLUMN : name;
}

/** {@link BoxTrackOptions} → the kernel's pooling config. */
function trackFields(opts: BoxTrackOptions): TrackFieldConfig {
  return {
    trackIdProperty: column(opts.trackIdProperty),
    // NOT passed through `column`: the kernel already treats '' as "no category"
    // by skipping the read entirely, which is what the fork did.
    colorProperty: opts.colorProperty,
    labelProperty: column(opts.labelProperty),
    headingProperty: column(opts.headingProperty),
    lengthProperty: column(opts.lengthProperty),
    widthProperty: column(opts.widthProperty),
    heightProperty: column(opts.heightProperty),
    speedProperty: column(opts.speedProperty),
    colorMapping: opts.colorMapping,
    colorMappingDefault: opts.colorMappingDefault,
  };
}

/** {@link BoxDefaults} → the kernel's per-frame sampling config. */
function sampleConfig(defaults: BoxDefaults): TrackSampleConfig {
  return {
    defaultLength: defaults.length,
    defaultWidth: defaults.width,
    defaultHeight: defaults.height,
    fadeInDuration: defaults.fadeIn,
    fadeOutDuration: defaults.fadeOut,
    singletonHoldMs: defaults.singletonHoldMs ?? SINGLETON_HOLD_MS,
    // Spelled out rather than left to the kernel's defaults: the fork had
    // NEITHER knob, so these two values are what "unchanged behaviour" means
    // here — never interpolate-hold across a data hole, heading in radians.
    maxGapMs: Infinity,
    angleUnit: 'rad',
  };
}

/** Pool every loaded tile's object snapshots into a `track_id`-keyed, sorted index. */
export function buildTrackIndex(
  tiles: Tile[],
  opts: BoxTrackOptions,
): Map<string, Track> {
  // The kernel additionally reports `hasSpeedColumn` / `trackIdMissing` /
  // `totalSnapshots` for telemetry; the box layer emits none, so only the index
  // itself crosses back (the published return type is the Map).
  return buildCoreTrackIndex(tiles, trackFields(opts)).tracks;
}

/** Interpolate one track's box pose at absolute `now`, or null when inactive. */
export function sampleTrack(
  track: Track,
  now: number,
  defaults: BoxDefaults,
): Sample | null {
  return sampleCoreTrack(track, now, sampleConfig(defaults));
}

/** All active box poses at `now` (one per active track). */
export function sampleTracks(
  index: Map<string, Track>,
  now: number,
  defaults: BoxDefaults,
): Sample[] {
  // Config built ONCE per frame, not once per track: this runs over every
  // resident track on every `setTime`.
  const cfg = sampleConfig(defaults);
  const out: Sample[] = [];
  for (const track of index.values()) {
    const s = sampleCoreTrack(track, now, cfg);
    if (s) out.push(s);
  }
  return out;
}
